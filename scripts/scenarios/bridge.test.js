/**
 * Phase C — tests for the BPMN decisionRef ↔ DMN decision table bridge.
 *
 * Six cases per the task brief's Verification section: the real recursive-nesting case
 * (subprocess-child-fidelity.json's c_rule), unresolved, ambiguous, multi-pool
 * attribution, the empty/no-decisionRef case, and confirmation of which node types
 * besides subProcess can carry nested children (transaction — see NESTING_NODE_TYPES).
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  resolveBridge, findDecisionRefs, findDecisionTables, linkKey, NESTING_NODE_TYPES,
} from './bridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../tests/fixtures', `${name}.json`), 'utf8'));

/** Minimal Decision-Core document with one decision + trivial table, for inline fixtures. */
const decisionCore = (decisionCoreId, decisionId, extra = {}) => ({
  id: decisionCoreId,
  name: decisionCoreId,
  namespace: `http://bpmn-generator.local/dmn/${decisionCoreId}`,
  nodes: [
    {
      id: decisionId,
      type: 'decision',
      name: decisionId,
      variable: 'result',
      typeRef: 'string',
      decisionTable: {
        id: `table_${decisionId}`,
        hitPolicy: 'UNIQUE',
        inputs: [{ id: 'in_1', label: 'x', expression: 'x', typeRef: 'string' }],
        outputs: [{ id: 'out_1', name: 'result', typeRef: 'string' }],
        rules: [{ id: 'r1', when: ['-'], then: ['"ok"'] }],
      },
      ...extra,
    },
  ],
});

// ═══════════════════════════════════════════════════════════════════════
// 1. The real nested case: subprocess-child-fidelity.json's c_rule
// ═══════════════════════════════════════════════════════════════════════

describe('recursive walk finds decisionRef nested inside a subprocess', () => {
  test('c_rule (nested one level inside outer) is found and resolves against an inline RatingDecision fixture', () => {
    const lc = fixture('subprocess-child-fidelity');

    // Sanity check on the fixture itself: c_rule really is nested, not top-level.
    const pool = lc.pools[0];
    expect(pool.nodes.some((n) => n.id === 'c_rule')).toBe(false);
    const outer = pool.nodes.find((n) => n.id === 'outer');
    expect(outer.nodes.some((n) => n.id === 'c_rule')).toBe(true);

    const occurrences = findDecisionRefs(lc);
    const found = occurrences.find((o) => o.nodeId === 'c_rule');
    expect(found).toBeDefined();
    expect(found.decisionRef).toBe('RatingDecision');
    expect(found.poolId).toBe('P_Fidelity');
    expect(found.ancestry).toEqual(['outer']);

    // No existing Decision-Core fixture declares "RatingDecision" — construct one inline.
    const dc = decisionCore('Definitions_rating', 'RatingDecision');
    const result = resolveBridge(lc, [dc]);

    expect(result.resolved).toHaveLength(1);
    const link = result.resolved[0];
    expect(link.occurrence.nodeId).toBe('c_rule');
    expect(link.occurrence.poolId).toBe('P_Fidelity');
    expect(link.occurrence.ancestry).toEqual(['outer']);
    expect(link.decision.decisionId).toBe('RatingDecision');
    expect(link.decision.decisionCoreId).toBe('Definitions_rating');

    // The O(1) lookup path must agree with the flat list.
    expect(result.byKey.get(linkKey(link.occurrence))).toBe(link);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Unresolved
// ═══════════════════════════════════════════════════════════════════════

describe('unresolved: decisionRef with no matching decision anywhere', () => {
  test('reported as a distinct unresolved finding, naming the node id and the missing decisionRef', () => {
    const lc = {
      nodes: [
        { id: 'start', type: 'startEvent' },
        { id: 'rule1', type: 'businessRuleTask', name: 'Score', decisionRef: 'NoSuchDecision' },
        { id: 'end', type: 'endEvent' },
      ],
      edges: [
        { id: 'f1', source: 'start', target: 'rule1' },
        { id: 'f2', source: 'rule1', target: 'end' },
      ],
    };
    const dc = decisionCore('Definitions_other', 'SomeOtherDecision');

    const result = resolveBridge(lc, [dc]);

    expect(result.resolved).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].occurrence.nodeId).toBe('rule1');
    expect(result.unresolved[0].occurrence.decisionRef).toBe('NoSuchDecision');
    expect(result.unresolved[0].occurrence.poolId).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Ambiguous
// ═══════════════════════════════════════════════════════════════════════

describe('ambiguous: the same decision id declared in two different Decision-Core documents', () => {
  test('reported as ambiguous, distinctly from unresolved, naming both candidate Decision-Core ids', () => {
    const lc = {
      nodes: [
        { id: 'rule1', type: 'businessRuleTask', name: 'Classify', decisionRef: 'SharedDecision' },
      ],
      edges: [],
    };
    const dcA = decisionCore('Definitions_a', 'SharedDecision');
    const dcB = decisionCore('Definitions_b', 'SharedDecision');

    const result = resolveBridge(lc, [dcA, dcB]);

    expect(result.resolved).toHaveLength(0);
    expect(result.unresolved).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(1);

    const finding = result.ambiguous[0];
    expect(finding.occurrence.nodeId).toBe('rule1');
    expect(finding.candidates).toHaveLength(2);
    const candidateIds = finding.candidates.map((c) => c.decisionCoreId).sort();
    expect(candidateIds).toEqual(['Definitions_a', 'Definitions_b']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3b. Same Decision-Core document passed twice — must NOT be reported ambiguous
// ═══════════════════════════════════════════════════════════════════════

describe('not ambiguous: the SAME Decision-Core document object passed twice', () => {
  test('resolveBridge(lc, [dc, dc]) resolves cleanly instead of flagging a spurious collision', () => {
    const lc = {
      nodes: [
        { id: 'rule1', type: 'businessRuleTask', name: 'Classify', decisionRef: 'SharedDecision' },
      ],
      edges: [],
    };
    const dc = decisionCore('Definitions_same', 'SharedDecision');

    // The exact same document object, twice — realistic if a later caller assembles
    // `decisionCores` from a manifest where the same DMN artifact is reachable via two
    // paths. Raw candidate count is 2, but both come from one document, so this must
    // resolve, not go ambiguous.
    const result = resolveBridge(lc, [dc, dc]);

    expect(result.ambiguous).toHaveLength(0);
    expect(result.unresolved).toHaveLength(0);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].occurrence.nodeId).toBe('rule1');
    expect(result.resolved[0].decision.decisionCoreId).toBe('Definitions_same');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Multi-pool
// ═══════════════════════════════════════════════════════════════════════

describe('multi-pool: a decisionRef in one specific pool is attributed to that pool', () => {
  test('collaboration with two pools, decisionRef only in the second', () => {
    const lc = {
      pools: [
        {
          id: 'P_Requester',
          name: 'Requester',
          nodes: [
            { id: 'r_start', type: 'startEvent' },
            { id: 'r_end', type: 'endEvent' },
          ],
          edges: [{ id: 'rf1', source: 'r_start', target: 'r_end' }],
        },
        {
          id: 'P_Approver',
          name: 'Approver',
          nodes: [
            { id: 'a_start', type: 'startEvent' },
            { id: 'a_rule', type: 'businessRuleTask', name: 'Approve rule', decisionRef: 'ApprovalDecision' },
            { id: 'a_end', type: 'endEvent' },
          ],
          edges: [
            { id: 'af1', source: 'a_start', target: 'a_rule' },
            { id: 'af2', source: 'a_rule', target: 'a_end' },
          ],
        },
      ],
      messageFlows: [],
    };
    const dc = decisionCore('Definitions_approval', 'ApprovalDecision');

    const result = resolveBridge(lc, [dc]);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].occurrence.nodeId).toBe('a_rule');
    expect(result.resolved[0].occurrence.poolId).toBe('P_Approver');

    // The requester pool contributes no occurrence at all.
    expect(result.occurrences.filter((o) => o.poolId === 'P_Requester')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. No decisionRef anywhere
// ═══════════════════════════════════════════════════════════════════════

describe('clean empty result when there is no decisionRef at all', () => {
  test('no businessRuleTask in the process — resolver returns empty lists, not an error', () => {
    const lc = {
      nodes: [
        { id: 'start', type: 'startEvent' },
        { id: 'task', type: 'userTask', name: 'Review' },
        { id: 'end', type: 'endEvent' },
      ],
      edges: [
        { id: 'f1', source: 'start', target: 'task' },
        { id: 'f2', source: 'task', target: 'end' },
      ],
    };

    const result = resolveBridge(lc, []);

    expect(result.occurrences).toHaveLength(0);
    expect(result.resolved).toHaveLength(0);
    expect(result.unresolved).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(0);
    expect(result.byKey.size).toBe(0);
  });

  test('empty Decision-Core array is valid input on its own — no crash, findDecisionTables returns empty', () => {
    expect(findDecisionTables([])).toEqual([]);
    expect(findDecisionTables(undefined)).toEqual([]);
  });

  test('resolveBridge(null, ...) does not throw and returns empty result', () => {
    const dc = decisionCore('Definitions_x', 'SomeDecision');
    const result = resolveBridge(null, [dc]);
    expect(result.occurrences).toHaveLength(0);
    expect(result.resolved).toHaveLength(0);
    expect(result.unresolved).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(0);
  });

  test('resolveBridge(lc, undefined) does not throw and reports every occurrence unresolved', () => {
    const lc = {
      nodes: [
        { id: 'rule1', type: 'businessRuleTask', name: 'Classify', decisionRef: 'SomeDecision' },
      ],
      edges: [],
    };
    const result = resolveBridge(lc, undefined);
    expect(result.occurrences).toHaveLength(1);
    expect(result.resolved).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.ambiguous).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Node types besides subProcess that can carry nested nodes
// ═══════════════════════════════════════════════════════════════════════

describe('node types that can carry nested nodes besides subProcess', () => {
  test('NESTING_NODE_TYPES documents transaction alongside subProcess', () => {
    // input-schema.json's NodeType enum lists "transaction" as a distinct type from
    // "subProcess", and Node.nodes ("Child nodes for expanded subProcess") is not
    // gated by `type` in the schema — a transaction is a specialised subprocess in the
    // BPMN spec and uses the same nesting idiom. No fixture in tests/fixtures uses
    // "transaction" with nested children, so this test constructs one directly.
    expect(NESTING_NODE_TYPES.has('subProcess')).toBe(true);
    expect(NESTING_NODE_TYPES.has('transaction')).toBe(true);
  });

  test('a decisionRef nested inside a transaction node is found by the recursive walker', () => {
    const lc = {
      nodes: [
        { id: 'start', type: 'startEvent' },
        {
          id: 'txn',
          type: 'transaction',
          name: 'Book trip',
          isExpanded: true,
          nodes: [
            { id: 't_start', type: 'startEvent' },
            { id: 't_rule', type: 'businessRuleTask', name: 'Price rule', decisionRef: 'PricingDecision' },
            { id: 't_end', type: 'endEvent' },
          ],
          edges: [
            { id: 'tf1', source: 't_start', target: 't_rule' },
            { id: 'tf2', source: 't_rule', target: 't_end' },
          ],
        },
        { id: 'end', type: 'endEvent' },
      ],
      edges: [
        { id: 'f1', source: 'start', target: 'txn' },
        { id: 'f2', source: 'txn', target: 'end' },
      ],
    };

    const occurrences = findDecisionRefs(lc);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].nodeId).toBe('t_rule');
    expect(occurrences[0].decisionRef).toBe('PricingDecision');
    expect(occurrences[0].ancestry).toEqual(['txn']);
  });
});
