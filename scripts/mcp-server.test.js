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

describe('schema gate on every tool that takes a Logic-Core', () => {
  const malformed = { nodes: [{ id: 'x', type: 'notARealType' }], edges: [] };

  for (const name of ['generate_bpmn', 'validate_bpmn', 'orchestrate_bpmn']) {
    test(`${name} rejects structurally invalid input before the pipeline`, async () => {
      const result = parse(await call(name, { logicCore: malformed }));
      expect(result.status).toBe('schema_error');
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test(`${name} rejects a logicCore that is not an object`, async () => {
      for (const logicCore of ['a process description', null, [], 7]) {
        const result = parse(await call(name, { logicCore }));
        expect(result.status).toBe('schema_error');
      }
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

describe('diagnostics reach the callers', () => {
  // The DI check existed but almost nothing consumed it: the CLI printed a green
  // checkmark and exited 0 on a broken diagram, the HTTP API never returned it,
  // and the drill-down branch dropped it although it is in the default include set.
  test('generate_bpmn returns diagnostics by default', async () => {
    const r = parse(await call('generate_bpmn', { logicCore: fixture('realistic-collaboration.json') }));
    expect(r.diagnostics).toBeDefined();
    expect(r.diagnostics.ok).toBe(true);
  });

  test('drillDown returns diagnostics for the parent and every subprocess', async () => {
    const r = parse(await call('generate_bpmn', {
      logicCore: fixture('expanded-subprocess.json'),
      drillDown: true,
    }));
    expect(r.parent.diagnostics).toBeDefined();
    for (const sub of Object.values(r.subProcesses)) {
      expect(sub.diagnostics).toBeDefined();
    }
  });

  test("include without 'diagnostics' leaves them out", async () => {
    const r = parse(await call('generate_bpmn', {
      logicCore: fixture('simple-approval.json'),
      include: ['xml'],
    }));
    expect(r.diagnostics).toBeUndefined();
  });
});

describe('rule profiles over MCP are names inside rules/, never paths', () => {
  const styled = fixture('boundary-event-shapes.json');
  const PROFILE_TOOLS = ['generate_bpmn', 'validate_bpmn', 'orchestrate_bpmn'];

  test.each(['strict', 'rules/strict-profile.json'])('validate_bpmn applies %s', async (ruleProfile) => {
    const plain = parse(await call('validate_bpmn', { logicCore: styled }));
    const strict = parse(await call('validate_bpmn', { logicCore: styled, ruleProfile }));
    expect(plain.errors).toEqual([]);
    expect(strict.errors.join('\n')).toMatch(/Objekt\+Verb/);
  });

  test('generate_bpmn and orchestrate_bpmn apply a named profile too', async () => {
    const gen = parse(await call('generate_bpmn', { logicCore: styled, ruleProfile: 'strict', include: ['validation'] }));
    expect(gen.validation.errors.length).toBeGreaterThan(0);
    const orch = parse(await call('orchestrate_bpmn', { logicCore: styled, ruleProfile: 'strict' }));
    expect(orch.compliance.isCompliant).toBe(false);
    expect(orch.compliance.errors.join('\n')).not.toMatch(/Compliance check failed/);
  });

  for (const name of PROFILE_TOOLS) {
    test.each(['../../etc/passwd', '/etc/passwd', '../rules/strict-profile.json', 'custom/../../x'])(`${name} refuses %s, naming only the name`, async (ruleProfile) => {
      let err;
      try { await call(name, { logicCore: styled, ruleProfile }); } catch (e) { err = e; }
      expect(err?.name).toBe('ProfileRejectedError');
      expect(err.message).toContain(JSON.stringify(ruleProfile));
      expect(err.message).not.toMatch(/root:|nobody|Users|scripts/);
    });

    test(`${name} refuses an unknown name and a non-string`, async () => {
      await expect(call(name, { logicCore: styled, ruleProfile: 'no-such-profile' })).rejects.toThrow(/unknown rule profile "no-such-profile"/);
      await expect(call(name, { logicCore: styled, ruleProfile: { overrides: {} } })).rejects.toThrow(/profile name/);
    });

    test(`${name} describes ruleProfile as a BPMN profile name, including the rules/ form`, () => {
      const d = tool(name).inputSchema.properties.ruleProfile.description;
      expect(d).toMatch(/name/i);
      expect(d).not.toMatch(/path/i);
      expect(d).toContain('rules/strict-profile.json');
      expect(d).not.toMatch(/dmn/i);
      expect(d).toMatch(/repository checkout/);
    });
  }
});

describe('visualRefinement over MCP', () => {
  test('generate_bpmn and orchestrate_bpmn declare it with the shared schema', async () => {
    const { VISUAL_REFINEMENT_OPTION_SCHEMA } = await import('./bpmn/visual-refinement.js');
    for (const name of ['generate_bpmn', 'orchestrate_bpmn']) {
      expect(tool(name).inputSchema.properties.visualRefinement).toMatchObject(VISUAL_REFINEMENT_OPTION_SCHEMA);
    }
  });
  test('false is byte-identical to the library call and differs from no option', async () => {
    const { runPipeline } = await import('./bpmn/pipeline.js');
    const out = parse(await call('generate_bpmn', { logicCore: fixture('sparse-lanes.json'), visualRefinement: false, include: ['xml'] }));
    const lib = await runPipeline(fixture('sparse-lanes.json'), { visualRefinement: false });
    const none = await runPipeline(fixture('sparse-lanes.json'), {});
    expect(out.bpmnXml).toBe(lib.bpmnXml);
    expect(out.bpmnXml).not.toBe(none.bpmnXml);
  });
  test('validate_bpmn ignores a bogus visualRefinement', async () => {
    const out = parse(await call('validate_bpmn', { logicCore: fixture('sparse-lanes.json'), visualRefinement: { nope: 1 } }));
    expect(out.status).not.toBe('schema_error');
    // the plain validation result, not a refinement error: the bogus option never reached a gate
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['errors', 'warnings', 'infos', 'advisories', 'metrics']));
    expect(out.errors).toEqual([]);
  });
  test.each([[{ nope: true }], [{ dynamicLaneHeader: true }], ['yes']])('%j is a schema_error on both tools', async (value) => {
    for (const name of ['generate_bpmn', 'orchestrate_bpmn']) {
      const out = parse(await call(name, { logicCore: fixture('sparse-lanes.json'), visualRefinement: value }));
      expect(out.status).toBe('schema_error');
    }
  });
});
