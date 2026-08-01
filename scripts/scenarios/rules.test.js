/**
 * Phase E — tests for the judging layer (`rules.js`).
 *
 * Eight cases per the task-6 brief's Verification section: SC01 acyclic (a genuinely dead
 * branch fires), SC01 cyclic exclusion (both directions: coverage holds AND the exclusion
 * holds even with a genuine gap), SC02/SC03 (distinct, from the bridge), SC04 (gap fires,
 * "not attempted" does not), SC05 (UNIQUE fires, FIRST with the identical shape does not),
 * SC06 (AND-fork-to-two-ends), and a clean model producing zero issues from all six rules
 * at once.
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { runScenarioRules, findAcyclicDecisionGateways, tableAnalysisKey } from './rules.js';
import { enumerateCollaboration } from './collaboration.js';
import { formatCollaborationResult } from './format.js';
import { resolveBridge } from './bridge.js';
import { analyzeDecisionTable } from './decision-table.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../tests/fixtures', `${name}.json`), 'utf8'));

/** Run the full Tasks 1/2 + 5 pipeline over `lc`, the shape `runScenarioRules` expects. */
function enumerateAndFormat(lc) {
  const enumerationResult = enumerateCollaboration(lc);
  const formatted = formatCollaborationResult(enumerationResult, lc);
  return { lc, enumerationResult, formatted };
}

/** Minimal Decision-Core document with one decision + a caller-supplied table. */
function decisionCore(decisionCoreId, decisionId, decisionTable) {
  return {
    id: decisionCoreId,
    name: decisionCoreId,
    namespace: `http://bpmn-generator.local/dmn/${decisionCoreId}`,
    nodes: [{
      id: decisionId, type: 'decision', name: decisionId, variable: 'result', typeRef: 'string',
      decisionTable,
    }],
  };
}

const discountTable = () => {
  const dc = fixture('dmn/discount-decision');
  return structuredClone(dc.nodes.find((n) => n.id === 'dec_discountLevel').decisionTable);
};

const issuesOf = (result, rule) => result.issues.filter((i) => i.rule === rule);

// ═══════════════════════════════════════════════════════════════════════
// 1. SC01 — acyclic case: a genuinely dead branch
// ═══════════════════════════════════════════════════════════════════════

describe('SC01 — unreachable branch, acyclic gateway', () => {
  test('a branch that dead-ends before any end event is reported', () => {
    const lc = {
      pools: [{
        id: 'P1',
        nodes: [
          { id: 's', type: 'startEvent' }, { id: 'gw', type: 'exclusiveGateway' },
          { id: 'a', type: 'userTask' }, { id: 'b', type: 'userTask' }, // b: no outgoing edge
          { id: 'e', type: 'endEvent' },
        ],
        edges: [
          { id: 'e1', source: 's', target: 'gw' },
          { id: 'e2', source: 'gw', target: 'a', label: 'Yes' },
          { id: 'e3', source: 'gw', target: 'b', label: 'No' },
          { id: 'e4', source: 'a', target: 'e' },
        ],
      }],
    };
    const { enumerationResult, formatted } = enumerateAndFormat(lc);

    // Sanity: gw is not on any cycle, and only the "a" branch produced a complete scenario.
    expect(enumerationResult.stats.backwardEdges).toEqual([]);
    expect(enumerationResult.scenarios).toHaveLength(1);
    expect(enumerationResult.stats.deadEndPaths).toBe(1);

    const result = runScenarioRules({ lc, enumerationResult, formatted });
    const sc01 = issuesOf(result, 'SC01');
    expect(sc01).toHaveLength(1);
    expect(sc01[0]).toMatchObject({ rule: 'SC01', severity: 'ERROR', gatewayId: 'gw', edgeId: 'e3' });
    expect(sc01[0].message).toMatch(/gw.*e3/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. SC01 — cyclic exclusion, both directions
// ═══════════════════════════════════════════════════════════════════════

describe('SC01 — cyclic gateways are excluded entirely', () => {
  test('simple-approval: gw1 is NOT on the cycle (f5: task3→task1 does not touch it) — both branches covered, no false SC01', () => {
    const lc = fixture('simple-approval');
    const { enumerationResult, formatted } = enumerateAndFormat(lc);

    // Confirm the fixture's own shape before trusting the assertion below.
    expect(enumerationResult.stats.backwardEdges.map((e) => e.id)).toEqual(['f5']);
    expect(enumerationResult.stats.backwardEdges.some((e) => e.source === 'gw1' || e.target === 'gw1'))
      .toBe(false);

    const gateways = findAcyclicDecisionGateways(lc, enumerationResult.stats.backwardEdges);
    expect(gateways.some((g) => g.gatewayId === 'gw1')).toBe(true); // not excluded

    const result = runScenarioRules({ lc, enumerationResult, formatted });
    expect(issuesOf(result, 'SC01').filter((i) => i.gatewayId === 'gw1')).toEqual([]);
  });

  test('a gateway that IS adjacent to a backward edge is excluded, even with a genuinely dead branch', () => {
    // gw has three branches: "a" (reaches the end event), "b" (dead end — genuinely never
    // reached by any scenario), and "c", which loops back to gw itself (c→gw is the
    // backward edge, so gw is its TARGET). Per SC01's stated scope, gw is excluded
    // entirely — "b" must NOT be reported, despite being exactly the shape SC01 targets.
    const lc = {
      pools: [{
        id: 'P2',
        nodes: [
          { id: 's', type: 'startEvent' }, { id: 'gw', type: 'exclusiveGateway' },
          { id: 'a', type: 'userTask' }, { id: 'b', type: 'userTask' }, { id: 'c', type: 'userTask' },
          { id: 'e', type: 'endEvent' },
        ],
        edges: [
          { id: 'se', source: 's', target: 'gw' },
          { id: 'ga', source: 'gw', target: 'a', label: 'happy' },
          { id: 'gb', source: 'gw', target: 'b', label: 'dead-end' },
          { id: 'gc', source: 'gw', target: 'c', label: 'loop' },
          { id: 'ae', source: 'a', target: 'e' },
          { id: 'ce', source: 'c', target: 'gw' }, // backward edge: c → gw
        ],
      }],
    };
    const { enumerationResult, formatted } = enumerateAndFormat(lc);

    expect(enumerationResult.stats.backwardEdges).toHaveLength(1);
    expect(enumerationResult.stats.backwardEdges[0]).toMatchObject({ source: 'c', target: 'gw' });

    const gateways = findAcyclicDecisionGateways(lc, enumerationResult.stats.backwardEdges);
    expect(gateways.some((g) => g.gatewayId === 'gw')).toBe(false); // excluded entirely

    const result = runScenarioRules({ lc, enumerationResult, formatted });
    expect(issuesOf(result, 'SC01').filter((i) => i.gatewayId === 'gw')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. SC02 / SC03 — from the bridge, distinct
// ═══════════════════════════════════════════════════════════════════════

describe('SC02 / SC03 — unresolved vs. ambiguous decisionRef', () => {
  const baseLc = (decisionRef) => ({
    pools: [{
      id: 'P3',
      nodes: [
        { id: 's', type: 'startEvent' },
        { id: 'rule', type: 'businessRuleTask', decisionRef },
        { id: 'e', type: 'endEvent' },
      ],
      edges: [{ id: 'e1', source: 's', target: 'rule' }, { id: 'e2', source: 'rule', target: 'e' }],
    }],
  });

  test('SC02 fires for an unresolved decisionRef, and only SC02', () => {
    const lc = baseLc('NoSuchDecision');
    const bridge = resolveBridge(lc, []);
    const { enumerationResult, formatted } = enumerateAndFormat(lc);

    const result = runScenarioRules({ lc, enumerationResult, formatted, bridge });
    expect(issuesOf(result, 'SC02')).toEqual([{
      rule: 'SC02', severity: 'ERROR', nodeId: 'rule', poolId: 'P3', decisionRef: 'NoSuchDecision',
      message: expect.stringContaining('NoSuchDecision'),
    }]);
    expect(issuesOf(result, 'SC03')).toEqual([]);
  });

  test('SC03 fires for a decisionRef resolving to two distinct Decision-Core documents, and only SC03', () => {
    const lc = baseLc('Ambiguous');
    const table = { id: 't', hitPolicy: 'UNIQUE', inputs: [], outputs: [], rules: [] };
    const dcA = decisionCore('Definitions_A', 'Ambiguous', table);
    const dcB = decisionCore('Definitions_B', 'Ambiguous', table);
    const bridge = resolveBridge(lc, [dcA, dcB]);
    const { enumerationResult, formatted } = enumerateAndFormat(lc);

    const result = runScenarioRules({ lc, enumerationResult, formatted, bridge });
    expect(issuesOf(result, 'SC02')).toEqual([]);
    const sc03 = issuesOf(result, 'SC03');
    expect(sc03).toHaveLength(1);
    expect(sc03[0]).toMatchObject({
      rule: 'SC03', nodeId: 'rule', poolId: 'P3', decisionRef: 'Ambiguous',
      candidateDecisionCoreIds: ['Definitions_A', 'Definitions_B'],
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. SC04 — table gap vs. "gap analysis not attempted"
// ═══════════════════════════════════════════════════════════════════════

describe('SC04 — decision table gap, never confused with "not attempted"', () => {
  function bridgedRule(lc, decisionRef, decisionCoreId, decisionId, table) {
    const dc = decisionCore(decisionCoreId, decisionId, table);
    return { bridge: resolveBridge(lc, [dc]) };
  }

  const lcFor = (decisionRef) => ({
    pools: [{
      id: 'P4',
      nodes: [
        { id: 's', type: 'startEvent' },
        { id: 'rule', type: 'businessRuleTask', decisionRef },
        { id: 'e', type: 'endEvent' },
      ],
      edges: [{ id: 'e1', source: 's', target: 'rule' }, { id: 'e2', source: 'rule', target: 'e' }],
    }],
  });

  test('a real gap fires with the exact describe text from Task 3', () => {
    const table = discountTable();
    table.rules = table.rules.filter((r) => r.id !== 'r2'); // remove the middle rule: [100..500)
    const analysis = analyzeDecisionTable(table);
    expect(analysis.gapAnalysis.attempted).toBe(true);
    expect(analysis.gaps.map((g) => g.describe)).toEqual(['[100..500)']);

    const lc = lcFor('dec_discountLevel');
    const { bridge } = bridgedRule(lc, 'dec_discountLevel', 'Definitions_discount', 'dec_discountLevel', table);
    const link = bridge.resolved[0];
    const tableAnalyses = new Map([[tableAnalysisKey(link), analysis]]);
    const { enumerationResult, formatted } = enumerateAndFormat(lc);

    const result = runScenarioRules({ lc, enumerationResult, formatted, bridge, tableAnalyses });
    const sc04 = issuesOf(result, 'SC04');
    expect(sc04).toHaveLength(1);
    expect(sc04[0]).toMatchObject({
      rule: 'SC04', nodeId: 'rule', poolId: 'P4', tableId: 'table_discountLevel', gap: '[100..500)',
    });
  });

  test('gap analysis NOT attempted (unbounded string domain) produces NO SC04 finding', () => {
    const table = {
      id: 'table_unbounded',
      hitPolicy: 'UNIQUE',
      inputs: [{ id: 'in_1', label: 'tier', expression: 'tier', typeRef: 'string' }], // no allowedValues
      outputs: [{ id: 'out_1', name: 'ok', typeRef: 'string' }],
      rules: [{ id: 'r1', when: ['"Gold"'], then: ['"yes"'] }],
    };
    const analysis = analyzeDecisionTable(table);
    expect(analysis.gaps).toBeNull();
    expect(analysis.gapAnalysis.attempted).toBe(false);
    expect(analysis.gapAnalysis.reason.code).toBe('unbounded-domain');

    const lc = lcFor('dec_unbounded');
    const { bridge } = bridgedRule(lc, 'dec_unbounded', 'Definitions_unbounded', 'dec_unbounded', table);
    const link = bridge.resolved[0];
    const tableAnalyses = new Map([[tableAnalysisKey(link), analysis]]);
    const { enumerationResult, formatted } = enumerateAndFormat(lc);

    const result = runScenarioRules({ lc, enumerationResult, formatted, bridge, tableAnalyses });
    expect(issuesOf(result, 'SC04')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. SC05 — illegal overlap, UNIQUE only
// ═══════════════════════════════════════════════════════════════════════

describe('SC05 — illegal overlap, UNIQUE only', () => {
  const overlappingTable = (hitPolicy) => ({
    id: `table_${hitPolicy}`,
    hitPolicy,
    inputs: [{ id: 'in_1', label: 'amount', expression: 'amount', typeRef: 'number' }],
    outputs: [{ id: 'out_1', name: 'ok', typeRef: 'string' }],
    rules: [
      { id: 'r1', when: ['[100..600)'], then: ['"a"'] },
      { id: 'r2', when: ['>= 500'], then: ['"b"'] }, // overlaps r1 on [500..600)
    ],
  });

  const lcFor = (decisionRef) => ({
    pools: [{
      id: 'P5',
      nodes: [
        { id: 's', type: 'startEvent' },
        { id: 'rule', type: 'businessRuleTask', decisionRef },
        { id: 'e', type: 'endEvent' },
      ],
      edges: [{ id: 'e1', source: 's', target: 'rule' }, { id: 'e2', source: 'rule', target: 'e' }],
    }],
  });

  function runFor(hitPolicy) {
    const table = overlappingTable(hitPolicy);
    const analysis = analyzeDecisionTable(table);
    const lc = lcFor(`dec_${hitPolicy}`);
    const dc = decisionCore(`Definitions_${hitPolicy}`, `dec_${hitPolicy}`, table);
    const bridge = resolveBridge(lc, [dc]);
    const link = bridge.resolved[0];
    const tableAnalyses = new Map([[tableAnalysisKey(link), analysis]]);
    const { enumerationResult, formatted } = enumerateAndFormat(lc);
    return { result: runScenarioRules({ lc, enumerationResult, formatted, bridge, tableAnalyses }), analysis };
  }

  test('UNIQUE with an overlap fires SC05', () => {
    const { result, analysis } = runFor('UNIQUE');
    expect(analysis.overlaps).toHaveLength(1);
    const sc05 = issuesOf(result, 'SC05');
    expect(sc05).toHaveLength(1);
    expect(sc05[0]).toMatchObject({ rule: 'SC05', nodeId: 'rule', tableId: 'table_UNIQUE', ruleIds: ['r1', 'r2'] });
  });

  test('FIRST with the identical overlapping shape does NOT fire SC05 — overlap is legal there', () => {
    const { result, analysis } = runFor('FIRST');
    expect(analysis.overlaps).toHaveLength(1); // Task 3 still finds the overlap...
    expect(issuesOf(result, 'SC05')).toEqual([]); // ...but SC05 declines to call it illegal
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. SC06 — improper completion
// ═══════════════════════════════════════════════════════════════════════

describe('SC06 — improper completion at the shared sink', () => {
  test('an AND fork to two end events fires SC06 naming the scenario and the pool', () => {
    // Identical fixture to collaboration.test.js's "improper completion" case.
    const lc = {
      pools: [{
        id: 'P_TwoEnds',
        nodes: [
          { id: 's', type: 'startEvent' }, { id: 'fork', type: 'parallelGateway' },
          { id: 'x', type: 'userTask' }, { id: 'y', type: 'userTask' },
          { id: 'e1', type: 'endEvent' }, { id: 'e2', type: 'endEvent' },
        ],
        edges: [
          { id: 'a1', source: 's', target: 'fork' }, { id: 'a2', source: 'fork', target: 'x' },
          { id: 'a3', source: 'fork', target: 'y' }, { id: 'a4', source: 'x', target: 'e1' },
          { id: 'a5', source: 'y', target: 'e2' },
        ],
      }],
    };
    const { enumerationResult, formatted } = enumerateAndFormat(lc);
    expect(enumerationResult.scenarios[0].sinkTokens).toEqual({ P_TwoEnds: 2 });

    const result = runScenarioRules({ lc, enumerationResult, formatted });
    const sc06 = issuesOf(result, 'SC06');
    expect(sc06).toHaveLength(1);
    expect(sc06[0]).toMatchObject({ rule: 'SC06', severity: 'ERROR', scenarioIndex: 0, pools: ['P_TwoEnds'] });
  });

  test('a normal single-end scenario does not fire SC06', () => {
    const lc = fixture('simple-approval');
    const { enumerationResult, formatted } = enumerateAndFormat(lc);
    const result = runScenarioRules({ lc, enumerationResult, formatted });
    expect(issuesOf(result, 'SC06')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. No false positives on a clean model
// ═══════════════════════════════════════════════════════════════════════

describe('no false positives on a clean model', () => {
  test('discount-decision.json bridged to a clean process with full branch coverage: zero issues', () => {
    const table = discountTable(); // gapless, UNIQUE, no overlap
    const analysis = analyzeDecisionTable(table);
    expect(analysis.gaps).toEqual([]);
    expect(analysis.overlaps).toEqual([]);

    // A clean acyclic XOR with BOTH branches covered by an enumerated scenario, feeding
    // into the business rule task.
    const lc = {
      pools: [{
        id: 'P_Clean',
        nodes: [
          { id: 's', type: 'startEvent' }, { id: 'gw', type: 'exclusiveGateway' },
          { id: 'a', type: 'userTask' }, { id: 'b', type: 'userTask' },
          { id: 'rule', type: 'businessRuleTask', decisionRef: 'dec_discountLevel' },
          { id: 'e', type: 'endEvent' },
        ],
        edges: [
          { id: 'e1', source: 's', target: 'gw' },
          { id: 'e2', source: 'gw', target: 'a', label: 'Yes' },
          { id: 'e3', source: 'gw', target: 'b', label: 'No' },
          { id: 'e4', source: 'a', target: 'rule' },
          { id: 'e5', source: 'b', target: 'rule' },
          { id: 'e6', source: 'rule', target: 'e' },
        ],
      }],
    };
    const dc = decisionCore('Definitions_discount', 'dec_discountLevel', table);
    const bridge = resolveBridge(lc, [dc]);
    const link = bridge.resolved[0];
    const tableAnalyses = new Map([[tableAnalysisKey(link), analysis]]);
    const { enumerationResult, formatted } = enumerateAndFormat(lc);

    expect(enumerationResult.scenarios).toHaveLength(2); // both branches, both complete
    expect(enumerationResult.stats.backwardEdges).toEqual([]);
    expect(bridge.unresolved).toEqual([]);
    expect(bridge.ambiguous).toEqual([]);

    const result = runScenarioRules({ lc, enumerationResult, formatted, bridge, tableAnalyses });
    expect(result.issues).toEqual([]);
  });
});
