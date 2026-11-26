/**
 * validateLogicCoreSchema and formatSchemaErrors: the errors of a Logic-Core that fails the input
 * schema are the errors of the root shape it was meant to have. The schema's root is a oneOf of
 * SingleProcess and Collaboration, and ajv reports both branches — so a collaboration with one bad
 * message flow used to open with "must have required property 'nodes'", the SingleProcess
 * branch's complaint, and the real cause came fifth. A caller that shows the first few errors (the
 * orchestrator showed three) showed none of the real ones.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLogicCoreSchema, formatSchemaErrors } from './schema-gate.js';

// An external partner modelled as a pool with no nodes, and a message flow named with `label`.
const badCollaboration = () => ({
  pools: [
    { id: 'Pool_Bank', name: 'Bank', nodes: [{ id: 'start', type: 'startEvent', marker: 'message' }, { id: 'end', type: 'endEvent' }],
      edges: [{ id: 'f1', source: 'start', target: 'end' }] },
    { id: 'Pool_Customer', name: 'Customer', nodes: [], edges: [] },
  ],
  messageFlows: [{ id: 'mf1', source: 'Pool_Customer', target: 'start', label: 'Application' }],
});

describe('validateLogicCoreSchema reports the errors of the intended root shape', () => {
  test('a collaboration: only its own errors, none of SingleProcess\'s, no oneOf summary', () => {
    const { valid, errors } = validateLogicCoreSchema(badCollaboration());
    expect(valid).toBe(false);
    expect(errors.map((e) => `${e.path}: ${e.message}`)).toEqual([
      '/pools/1/nodes: must NOT have fewer than 1 items',
      '/messageFlows/0: must NOT have additional properties',
    ]);
  });

  test('a single process: only its own errors', () => {
    const { valid, errors } = validateLogicCoreSchema({ nodes: [{ id: 'n', type: 'notAType' }], edges: [] });
    expect(valid).toBe(false);
    expect(errors.map((e) => e.path)).toEqual(['/nodes/0/type']);
  });

  test('a valid Logic-Core has no errors', () => {
    const lc = badCollaboration();
    lc.pools.pop();
    lc.collapsedPools = [{ id: 'Pool_Customer', name: 'Customer' }];
    lc.messageFlows[0] = { id: 'mf1', source: 'Pool_Customer', target: 'start', name: 'Application' };
    expect(validateLogicCoreSchema(lc)).toEqual({ valid: true, errors: [] });
  });

  test('not an object at all: the errors stay as ajv reports them', () => {
    const { valid, errors } = validateLogicCoreSchema([]);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('1.x gate results do not change (no code anywhere)', () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures');
  const fixtures = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

  test('every top-level fixture is still valid with no errors', () => {
    expect(fixtures.length).toBeGreaterThan(20);
    for (const f of fixtures) {
      expect([f, validateLogicCoreSchema(JSON.parse(readFileSync(join(dir, f), 'utf8')))]).toEqual([f, { valid: true, errors: [] }]);
    }
  });

  test('a failing 1.x model has entries of exactly path, message, params', () => {
    const { errors } = validateLogicCoreSchema(badCollaboration());
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect(Object.keys(e).sort()).toEqual(['message', 'params', 'path']);
  });
});

describe('formatSchemaErrors', () => {
  test('a coded entry is printed as [code] path: message, an uncoded one unchanged', () => {
    expect(formatSchemaErrors([
      { path: '/nodes', message: 'bad', params: {}, code: 'F01' },
      { path: '/x', message: 'plain', params: {} },
    ])).toBe('[F01] /nodes: bad\n/x: plain');
  });

  test('one line per error, with the offending property or limit', () => {
    const { errors } = validateLogicCoreSchema(badCollaboration());
    expect(formatSchemaErrors(errors)).toBe([
      '/pools/1/nodes: must NOT have fewer than 1 items',
      '/messageFlows/0: must NOT have additional properties (label)',
    ].join('\n'));
  });

  test('beyond max, one line counting the rest', () => {
    const errors = Array.from({ length: 5 }, (_, i) => ({ path: `/nodes/${i}`, message: 'bad', params: {} }));
    expect(formatSchemaErrors(errors, 2).split('\n')).toEqual(['/nodes/0: bad', '/nodes/1: bad', '… and 3 more']);
  });
});

describe('language: the natural language of the labels (1.x)', () => {
  const single = (extra = {}) => ({ nodes: [{ id: 'a', type: 'startEvent' }, { id: 'b', type: 'endEvent' }], edges: [{ source: 'a', target: 'b' }], ...extra });
  const collab = (extra = {}) => ({ pools: [{ id: 'Pool_A', name: 'A', nodes: [{ id: 'a', type: 'startEvent' }, { id: 'b', type: 'endEvent' }], edges: [{ source: 'a', target: 'b' }] }], ...extra });
  const shapes = { 'single process': single, collaboration: collab };

  describe.each(Object.entries(shapes))('%s', (_n, make) => {
    test.each(['de', 'en-GB', 'fr', 'zh-Hant-TW'])('%s is valid', (language) => {
      expect(validateLogicCoreSchema(make({ language }))).toEqual({ valid: true, errors: [] });
    });
    test.each(['German', 'DE', 'd', '', 5, null])('%j is rejected with one error at /language', (language) => {
      const { valid, errors } = validateLogicCoreSchema(make({ language }));
      expect(valid).toBe(false);
      expect(errors.map((e) => e.path)).toEqual(['/language']);
    });
  });

  test('language on a pool, a node or a lane is an additional property', () => {
    for (const lc of [
      (() => { const c = collab(); c.pools[0].language = 'de'; return c; })(),
      (() => { const s = single(); s.nodes[0].language = 'de'; return s; })(),
      single({ lanes: [{ id: 'l', name: 'L', language: 'de' }] }),
    ]) {
      const { valid, errors } = validateLogicCoreSchema(lc);
      expect(valid).toBe(false);
      expect(errors.map((e) => e.message).join('\n')).toContain('must NOT have additional properties');
    }
  });
});
