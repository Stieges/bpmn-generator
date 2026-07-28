/**
 * MCP surface — tests for the tool contract.
 *
 * These cover the gaps found when the server was driven from a real client:
 * dropped result fields, missing schema gate, no rule profile, an SVG that
 * could not be switched off, and drill-down ignoring the mode.
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { TOOLS, handleToolCall } from './mcp-bpmn-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  JSON.parse(readFileSync(resolve(__dirname, '../tests/fixtures', name), 'utf8'));

const call = (name, args) => handleToolCall({ params: { name, arguments: args } });
const parse = (r) => JSON.parse(r.content[0].text);
const tool = (name) => TOOLS.find((t) => t.name === name);

describe('validate_bpmn passes the full validation result through', () => {
  test('infos and metrics are not dropped', async () => {
    const result = parse(await call('validate_bpmn', { logicCore: fixture('realistic-collaboration.json') }));
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining(['errors', 'warnings', 'infos', 'advisories', 'metrics'])
    );
  });
});

describe('schema gate on generate_bpmn and validate_bpmn', () => {
  const malformed = { nodes: [{ id: 'x', type: 'notARealType' }], edges: [] };

  for (const name of ['generate_bpmn', 'validate_bpmn']) {
    test(`${name} rejects structurally invalid input before the pipeline`, async () => {
      const result = parse(await call(name, { logicCore: malformed }));
      expect(result.status).toBe('schema_error');
      expect(result.errors.length).toBeGreaterThan(0);
    });
  }

  test('valid input still passes', async () => {
    const result = parse(await call('validate_bpmn', { logicCore: fixture('simple-approval.json') }));
    expect(result.status).toBeUndefined();
    expect(result.errors).toEqual([]);
  });
});

describe('rule profile is reachable over MCP', () => {
  for (const name of ['generate_bpmn', 'validate_bpmn']) {
    test(`${name} declares a ruleProfile parameter`, () => {
      expect(tool(name).inputSchema.properties.ruleProfile).toBeDefined();
    });
  }
});

describe('include parameter keeps the SVG out of the result', () => {
  test('declared in the schema', () => {
    expect(tool('generate_bpmn').inputSchema.properties.include).toBeDefined();
  });

  test("include: ['xml'] returns the XML only", async () => {
    const result = parse(await call('generate_bpmn', {
      logicCore: fixture('simple-approval.json'),
      include: ['xml'],
    }));
    expect(Object.keys(result)).toEqual(['bpmnXml']);
  });

  test('default returns xml, svg, validation and diagnostics', async () => {
    const result = parse(await call('generate_bpmn', { logicCore: fixture('simple-approval.json') }));
    expect(Object.keys(result)).toEqual(['bpmnXml', 'svg', 'validation', 'diagnostics']);
    expect(result.diagnostics.ok).toBe(true);
  });
});

describe('drillDown honours mode', () => {
  const chain = {
    id: 'P',
    nodes: [
      { id: 's', type: 'startEvent' },
      { id: 'a', type: 'userTask', name: 'Check first' },
      { id: 'b', type: 'userTask', name: 'Check second' },
      { id: 'c', type: 'userTask', name: 'Check third' },
      { id: 'e', type: 'endEvent' },
    ],
    edges: [
      { id: 'f0', source: 's', target: 'a' },
      { id: 'f1', source: 'a', target: 'b' },
      { id: 'f2', source: 'b', target: 'c' },
      { id: 'f3', source: 'c', target: 'e' },
    ],
    lanes: [{ id: 'LA', name: 'One', nodeIds: ['s', 'a', 'b', 'c', 'e'] }],
  };

  test('optimize mode produces the same advisories with and without drillDown', async () => {
    const flat = parse(await call('generate_bpmn', { logicCore: chain, mode: 'optimize', include: ['validation'] }));
    const drill = parse(await call('generate_bpmn', { logicCore: chain, mode: 'optimize', drillDown: true }));
    const ids = (a) => (a || []).map((x) => x.id).sort();
    expect(ids(flat.validation.advisories)).toContain('O04');
    expect(ids(drill.parent.validation.advisories)).toEqual(ids(flat.validation.advisories));
  });

  test('document mode stays free of advisories on both paths', async () => {
    const flat = parse(await call('generate_bpmn', { logicCore: chain, include: ['validation'] }));
    const drill = parse(await call('generate_bpmn', { logicCore: chain, drillDown: true }));
    expect(flat.validation.advisories).toEqual([]);
    expect(drill.parent.validation.advisories).toEqual([]);
  });
});
