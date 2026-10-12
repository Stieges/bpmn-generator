/**
 * validateLogicCoreSchema and formatSchemaErrors: the errors of a Logic-Core that fails the input
 * schema are the errors of the root shape it was meant to have. The schema's root is a oneOf of
 * SingleProcess and Collaboration, and ajv reports both branches — so a collaboration with one bad
 * message flow used to open with "must have required property 'nodes'", the SingleProcess
 * branch's complaint, and the real cause came fifth. A caller that shows the first few errors (the
 * orchestrator showed three) showed none of the real ones.
 */
import { describe, test, expect } from '@jest/globals';
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

describe('formatSchemaErrors', () => {
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
