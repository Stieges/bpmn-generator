/**
 * BPMN Generator MCP Server
 * Exposes generate_bpmn, validate_bpmn, import_bpmn as MCP tools.
 *
 * Usage:
 *   node mcp-bpmn-server.js
 *
 * Configure in claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "bpmn-generator": {
 *         "command": "node",
 *         "args": ["/path/to/scripts/mcp-bpmn-server.js"]
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { runPipeline, generateDiagramSet } from './bpmn/pipeline.js';
import { validateModel } from './bpmn/validate.js';
import { profileForMode } from './bpmn/rules.js';
import { loadNamedRuleProfile, ProfileRejectedError } from './shared/rule-profile.js';
import { loadNamedView, ViewRejectedError, resolveViewOptions } from './shared/view.js';
import { rulesDirPath } from './shared/resource-paths.js';
import { isMainModule } from './shared/entry-point.js';
import { PACKAGE_VERSION } from './shared/version.js';
import { validateModelSchema, v2RequestErrors, catalogOptionFor, validateLayoutOptions, boundSchemaErrors, layoutOptionsOf, LAYOUT_SWITCH_OPTION_SCHEMA, assertViewFitsModel } from './bpmn/schema-gate.js';
import { VISUAL_REFINEMENT_OPTION_SCHEMA } from './bpmn/visual-refinement.js';
import { bpmnToLogicCore, readModelMarker, MODEL_V2_IMPORT_NOTICE, MODEL_V2_IMPORT_NOTICE_CODE } from './bpmn/import.js';
import { orchestrate } from './orchestrator.js';
import { checkNamingOverlay, NamingDataError, namingDataErrorOf } from './bpmn/naming/index.js';

const PROFILE_PARAM = {
  type: 'string',
  description: 'Name of a BPMN rule profile in the repository\'s rules/ directory (optional): "strict" ' +
    '(also "strict-profile", "strict-profile.json" or "rules/strict-profile.json"), or "custom/<name>" for a ' +
    'project profile in rules/custom/. Names only — no other directory, no "..". Needs a repository checkout; ' +
    'an installed npm package has no rules/ directory and refuses every name.',
};

const VISUAL_REFINEMENT_PARAM = {
  ...VISUAL_REFINEMENT_OPTION_SCHEMA,
  description: "Refinement passes: true/false switches all; an object { laneCompaction, edgeLabelCollisionRepair } switches single passes. Omitted: the server's config defaults (as shipped: edge-label repair and lane compaction on)",
};

const BEND_RULE_PARAM = {
  ...LAYOUT_SWITCH_OPTION_SCHEMA,
  description: "Bend rule: fewest bends, flows enter activities and events in flow direction. Omitted: the server's config default (as shipped: on)",
};

const NODE_LABELS_AVOID_FLOWS_PARAM = {
  ...LAYOUT_SWITCH_OPTION_SCHEMA,
  description: "Event and gateway labels move off the flows at their node. Omitted: the server's config default (as shipped: on)",
};

const VIEW_PARAM = {
  type: 'string',
  description: "A view NAME from the repository's views/ directory, e.g. \"explicit-joins\" (a name only, no file and no inline object). The view decides the rule profile, layout switches and derivations for this call; an option given explicitly wins over the view. Derived elements come back as hints (validation.hints). Needs a repository checkout",
};

const FOREIGN_SHAPE_REPAIR_PARAM = {
  ...LAYOUT_SWITCH_OPTION_SCHEMA,
  description: "Re-route a sequence flow that runs through a task, event or gateway that is not its own source or target. Omitted: the server's config default (as shipped: on)",
};

const server = new Server(
  { name: 'bpmn-generator', version: PACKAGE_VERSION },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: 'generate_bpmn',
    description: 'Generate BPMN 2.0 XML + SVG from Logic-Core JSON',
    inputSchema: {
      type: 'object',
      required: ['logicCore'],
      properties: {
        logicCore: { type: 'object', description: 'Logic-Core JSON (nodes, edges, pools etc.)' },
        catalog: { type: 'object', description: 'Actor catalogue { actors, scheme? } of a format 2.0 model; embedded, paths are never read' },
        drillDown: { type: 'boolean', description: 'Generate per-subprocess diagrams (optional, default false)' },
        mode: { type: 'string', enum: ['document', 'optimize'], description: "'document' (default, faithful IST) or 'optimize' (Soll — adds redesign advisories)" },
        ruleProfile: PROFILE_PARAM,
        view: VIEW_PARAM,
        visualRefinement: VISUAL_REFINEMENT_PARAM,
        bendRule: BEND_RULE_PARAM,
        nodeLabelsAvoidFlows: NODE_LABELS_AVOID_FLOWS_PARAM,
        foreignShapeRepair: FOREIGN_SHAPE_REPAIR_PARAM,
        poolOrder: { type: 'string', enum: ['auto', 'declared'], description: "'auto' (default) stacks participants so that the ones exchanging messages sit next to each other; 'declared' keeps the input order" },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['xml', 'svg', 'validation', 'diagnostics'] },
          description: "Which parts to return. Default ['xml','svg','validation','diagnostics']. Pass ['xml'] to keep a 50–150 KB SVG out of the context."
        }
      }
    }
  },
  {
    name: 'validate_bpmn',
    description: 'Validate Logic-Core JSON without generating output',
    inputSchema: {
      type: 'object',
      required: ['logicCore'],
      properties: {
        logicCore: { type: 'object', description: 'Logic-Core JSON to validate' },
        catalog: { type: 'object', description: 'Actor catalogue { actors, scheme? } of a format 2.0 model; embedded, paths are never read' },
        mode: { type: 'string', enum: ['document', 'optimize'], description: "'document' (default) or 'optimize' (adds redesign advisories)" },
        ruleProfile: PROFILE_PARAM,
        view: VIEW_PARAM
      }
    }
  },
  {
    name: 'import_bpmn',
    description: 'Import BPMN 2.0 XML and convert to Logic-Core JSON; a diagram generated from a format 2.0 model adds a second text block with `notices`',
    inputSchema: {
      type: 'object',
      required: ['bpmnXml'],
      properties: {
        bpmnXml: { type: 'string', description: 'BPMN 2.0 XML string' }
      }
    }
  },
  {
    name: 'orchestrate_bpmn',
    description: 'Run multi-agent orchestration: review + generate + compliance check for Logic-Core JSON',
    inputSchema: {
      type: 'object',
      required: ['logicCore'],
      properties: {
        logicCore: { type: 'object', description: 'Logic-Core JSON to orchestrate' },
        catalog: { type: 'object', description: 'Actor catalogue { actors, scheme? } of a format 2.0 model; embedded, paths are never read' },
        ruleProfile: PROFILE_PARAM,
        view: VIEW_PARAM,
        visualRefinement: VISUAL_REFINEMENT_PARAM,
        bendRule: BEND_RULE_PARAM,
        nodeLabelsAvoidFlows: NODE_LABELS_AVOID_FLOWS_PARAM,
        foreignShapeRepair: FOREIGN_SHAPE_REPAIR_PARAM,
        mode: { type: 'string', enum: ['document', 'optimize'], description: "'document' (default) or 'optimize' (Soll — adds redesign advisories)" }
      }
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

const text = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });

/**
 * Reject structurally invalid input before it reaches the pipeline.
 * Without this, a wrong `type` or an unknown field surfaces much later as an
 * opaque ELK error instead of a pointed schema message.
 */
function schemaGate(logicCore, layoutOptions, { catalog, mode } = {}) {
  const check = validateModelSchema(logicCore, { accept: ['1', '2'] });
  if (!check.valid) return text({ status: 'schema_error', errors: check.errors });
  // A 2.0 model: the embedded catalogue and the mode are checked here; a 1.x model gets [] (unchanged)
  const v2Errors = v2RequestErrors(logicCore, { catalog, mode });
  if (v2Errors.length) return text({ status: 'schema_error', errors: boundSchemaErrors(v2Errors) });
  // visualRefinement, bendRule, nodeLabelsAvoidFlows, foreignShapeRepair — only on the tools that lay out
  const layoutCheck = validateLayoutOptions(layoutOptions);
  return layoutCheck.valid ? null : text({ status: 'schema_error', errors: layoutCheck.errors });
}

/** The profile a tool call names, read from rules/ only; null when none is named. */
function ruleProfileOf(args) {
  const name = args.ruleProfile;
  if (name === undefined || name === null) return null;
  if (typeof name !== 'string') {
    throw new ProfileRejectedError('ruleProfile must be a profile name such as "strict"');
  }
  // rules/ is found from the module's location (resource-paths.js), never from the working
  // directory — which made the documented "rules/strict-profile.json" miss and silently run every
  // rule at its default severity — and never outside the repository (null in an npm install).
  return loadNamedRuleProfile(name, rulesDirPath());
}

/** The view a tool call names (a name inside views/ only); null when none, including `view: null`. */
function viewOf(args) {
  const name = args.view;
  if (name === undefined || name === null) return null;
  if (typeof name !== 'string') {
    throw new ViewRejectedError('view must be a view name such as "explicit-joins"');
  }
  return loadNamedView(name);
}

/**
 * The view and the rule profile of a tool call, the view checked against the model (a lanes view
 * on a 1.x model is a view error, before any work). With a view the profile the caller did not give
 * stays `undefined` (not null), so the view's own profile can apply; it is resolved here, once, so
 * the reviewer and compliance agents judge the model by the same profile the layout runs with.
 */
function viewAndProfileOf(args) {
  const view = viewOf(args);
  assertViewFitsModel(args.logicCore, view);
  const ruleProfile = ruleProfileOf(args);
  if (!view) return { view: undefined, ruleProfile };
  return { view, ruleProfile: resolveViewOptions(view, { ruleProfile: ruleProfile ?? undefined }).ruleProfile };
}

/**
 * A naming data failure (an unusable `BPMN_NAMING` file) is the operator's to fix: its message,
 * which names the file, goes to stderr; the client gets only the class.
 */
async function handleToolCall(request) {
  try {
    return await dispatchToolCall(request);
  } catch (err) {
    const namingFailure = namingDataErrorOf(err); // through `cause`: the orchestrator wraps agent errors
    if (namingFailure) {
      console.error(`Naming data failure: ${namingFailure.message}`);
      throw new Error('naming data unavailable');
    }
    throw err;
  }
}

async function dispatchToolCall(request) {
  const { name, arguments: args } = request.params;

  if (name === 'generate_bpmn') {
    const rejected = schemaGate(args.logicCore, args, args);
    if (rejected) return rejected;

    const include = new Set(args.include ?? ['xml', 'svg', 'validation', 'diagnostics']);
    const { view, ruleProfile } = viewAndProfileOf(args);
    const opts = { mode: args.mode, ruleProfile, view, poolOrder: args.poolOrder, ...layoutOptionsOf(args), ...catalogOptionFor(args.logicCore, args.catalog) };

    if (args.drillDown) {
      const set = await generateDiagramSet(args.logicCore, opts);
      return text({
        parent: {
          ...(include.has('xml') ? { bpmnXml: set.parent.bpmnXml } : {}),
          ...(include.has('svg') ? { svg: set.parent.svg } : {}),
          ...(include.has('validation') ? { validation: set.parent.validation } : {}),
          // Was dropped here although it is in the default include set: the
          // drill-down caller got no geometry diagnostics at all.
          ...(include.has('diagnostics') ? { diagnostics: set.parent.diagnostics } : {}),
        },
        subProcesses: Object.fromEntries(
          Object.entries(set.subProcesses).map(([id, r]) => [id, {
            ...(include.has('xml') ? { bpmnXml: r.bpmnXml } : {}),
            ...(include.has('svg') ? { svg: r.svg } : {}),
            ...(include.has('diagnostics') ? { diagnostics: r.diagnostics } : {}),
          }])
        ),
        navigation: set.navigation,
      });
    }

    const result = await runPipeline(args.logicCore, opts);
    return text({
      ...(include.has('xml') ? { bpmnXml: result.bpmnXml } : {}),
      ...(include.has('svg') ? { svg: result.svg } : {}),
      ...(include.has('validation') ? { validation: result.validation } : {}),
      ...(include.has('diagnostics') ? { diagnostics: result.diagnostics } : {}),
    });
  }

  if (name === 'validate_bpmn') {
    const rejected = schemaGate(args.logicCore, undefined, args);
    if (rejected) return rejected;
    // infos and metrics used to be dropped here, which silently killed the
    // whole P layer (complexity metrics) for every MCP caller.
    const result = validateModel(args.logicCore, profileForMode(viewAndProfileOf(args).ruleProfile ?? null, args.mode), catalogOptionFor(args.logicCore, args.catalog));
    return text(result);
  }

  if (name === 'import_bpmn') {
    const logicCore = await bpmnToLogicCore(args.bpmnXml);
    const content = [{ type: 'text', text: JSON.stringify(logicCore, null, 2) }];
    if (readModelMarker(args.bpmnXml)) {
      content.push({ type: 'text', text: JSON.stringify({ notices: [{ code: MODEL_V2_IMPORT_NOTICE_CODE, message: MODEL_V2_IMPORT_NOTICE }] }) });
    }
    return { content };
  }

  if (name === 'orchestrate_bpmn') {
    // Same gate as the other tools: a string here would otherwise be taken for a process
    // description, and a malformed model would surface as a thrown error, not a schema_error.
    const rejected = schemaGate(args.logicCore, args, args);
    if (rejected) return rejected;
    const { view, ruleProfile } = viewAndProfileOf(args);
    const result = await orchestrate(args.logicCore, {
      ruleProfile,
      view,
      mode: args.mode,
      ...layoutOptionsOf(args),
      ...catalogOptionFor(args.logicCore, args.catalog),
    });
    return text({
      bpmnXml: result.bpmnXml,
      svg: result.svg,
      validation: result.validation,
      diagnostics: result.diagnostics,
      compliance: result.compliance,
      history: result.history,
      iterations: result.iterations,
    });
  }

  throw new Error(`Unknown tool: ${name}`);
}

server.setRequestHandler(CallToolRequestSchema, handleToolCall);

// Same entry-point guard as http-server.js: importing this module (tests) must
// not open a stdio transport.
const isEntryPoint = isMainModule(import.meta.url, process.argv[1]);
if (isEntryPoint) {
  try {
    checkNamingOverlay(process.env);
  } catch (err) {
    if (!(err instanceof NamingDataError)) throw err;
    process.stderr.write(`✗ BPMN_NAMING: ${err.message}\n`);
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { server, TOOLS, handleToolCall };
