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
        drillDown: { type: 'boolean', description: 'Generate per-subprocess diagrams (optional, default false)' }
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
        logicCore: { type: 'object', description: 'Logic-Core JSON to validate' }
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
        ruleProfile: { type: 'string', description: 'Path to rule profile JSON (optional)' }
      }
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'generate_bpmn') {
    if (args.drillDown) {
      const set = await generateDiagramSet(args.logicCore);
      return { content: [{ type: 'text', text: JSON.stringify({
        parent: { bpmnXml: set.parent.bpmnXml, svg: set.parent.svg, validation: set.parent.validation },
        subProcesses: Object.fromEntries(
          Object.entries(set.subProcesses).map(([id, r]) => [id, { bpmnXml: r.bpmnXml, svg: r.svg }])
        ),
        navigation: set.navigation,
      }, null, 2) }] };
    }
    const result = await runPipeline(args.logicCore);
    return { content: [{ type: 'text', text: JSON.stringify({
      bpmnXml: result.bpmnXml,
      svg: result.svg,
      validation: result.validation
    }, null, 2) }] };
  }

  if (name === 'validate_bpmn') {
    const { errors, warnings } = validateLogicCore(args.logicCore);
    return { content: [{ type: 'text', text: JSON.stringify({ errors, warnings }, null, 2) }] };
  }

  if (name === 'import_bpmn') {
    const logicCore = await bpmnToLogicCore(args.bpmnXml);
    return { content: [{ type: 'text', text: JSON.stringify(logicCore, null, 2) }] };
  }

  if (name === 'orchestrate_bpmn') {
    const result = await orchestrate(args.logicCore, {
      ruleProfile: args.ruleProfile || null,
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
});

const transport = new StdioServerTransport();
await server.connect(transport);
