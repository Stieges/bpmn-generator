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
import { runPipeline, validateLogicCore, generateDiagramSet } from './pipeline.js';
import { profileForMode, loadRuleProfile } from './rules.js';
import { validateLogicCoreSchema } from './schema-gate.js';
import { bpmnToLogicCore } from './import.js';
import { orchestrate } from './orchestrator.js';

const server = new Server(
  { name: 'bpmn-generator', version: '2.0.0' },
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
        drillDown: { type: 'boolean', description: 'Generate per-subprocess diagrams (optional, default false)' },
        mode: { type: 'string', enum: ['document', 'optimize'], description: "'document' (default, faithful IST) or 'optimize' (Soll — adds redesign advisories)" },
        ruleProfile: { type: 'string', description: 'Path to a rule profile JSON, e.g. rules/strict-profile.json (optional)' },
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
        mode: { type: 'string', enum: ['document', 'optimize'], description: "'document' (default) or 'optimize' (adds redesign advisories)" },
        ruleProfile: { type: 'string', description: 'Path to a rule profile JSON, e.g. rules/strict-profile.json (optional)' }
      }
    }
  },
  {
    name: 'import_bpmn',
    description: 'Import BPMN 2.0 XML and convert to Logic-Core JSON',
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
        ruleProfile: { type: 'string', description: 'Path to rule profile JSON (optional)' },
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
function schemaGate(logicCore) {
  const check = validateLogicCoreSchema(logicCore);
  return check.valid ? null : text({ status: 'schema_error', errors: check.errors });
}

function ruleProfileOf(args) {
  return args.ruleProfile ? loadRuleProfile(args.ruleProfile) : null;
}

async function handleToolCall(request) {
  const { name, arguments: args } = request.params;

  if (name === 'generate_bpmn') {
    const rejected = schemaGate(args.logicCore);
    if (rejected) return rejected;

    const include = new Set(args.include ?? ['xml', 'svg', 'validation', 'diagnostics']);
    const opts = { mode: args.mode, ruleProfile: ruleProfileOf(args) };

    if (args.drillDown) {
      const set = await generateDiagramSet(args.logicCore, opts);
      return text({
        parent: {
          ...(include.has('xml') ? { bpmnXml: set.parent.bpmnXml } : {}),
          ...(include.has('svg') ? { svg: set.parent.svg } : {}),
          ...(include.has('validation') ? { validation: set.parent.validation } : {}),
        },
        subProcesses: Object.fromEntries(
          Object.entries(set.subProcesses).map(([id, r]) => [id, {
            ...(include.has('xml') ? { bpmnXml: r.bpmnXml } : {}),
            ...(include.has('svg') ? { svg: r.svg } : {}),
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
    const rejected = schemaGate(args.logicCore);
    if (rejected) return rejected;
    // infos and metrics used to be dropped here, which silently killed the
    // whole P layer (complexity metrics) for every MCP caller.
    const result = validateLogicCore(args.logicCore, profileForMode(ruleProfileOf(args), args.mode));
    return text(result);
  }

  if (name === 'import_bpmn') {
    const logicCore = await bpmnToLogicCore(args.bpmnXml);
    return { content: [{ type: 'text', text: JSON.stringify(logicCore, null, 2) }] };
  }

  if (name === 'orchestrate_bpmn') {
    const result = await orchestrate(args.logicCore, {
      ruleProfile: args.ruleProfile || null,
      mode: args.mode,
    });
    return { content: [{ type: 'text', text: JSON.stringify({
      bpmnXml: result.bpmnXml,
      svg: result.svg,
      validation: result.validation,
      compliance: result.compliance,
      history: result.history,
      iterations: result.iterations,
    }, null, 2) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
}

server.setRequestHandler(CallToolRequestSchema, handleToolCall);

// Same entry-point guard as http-server.js: importing this module (tests) must
// not open a stdio transport.
const isEntryPoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntryPoint) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export { server, TOOLS, handleToolCall };
