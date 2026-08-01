/**
 * Phase A — scenario enumeration tests.
 *
 * The scenario counts asserted here are hand-traced, not recorded from a run. Where one
 * of them fails, the traversal is wrong, not the expectation — see the report at
 * .superpowers/sdd/2026-08-01-scenario-enumeration/task-1-report.md for the traces.
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { enumerateScenarios, findBackwardEdges, backwardEdgePlaceId } from './enumerate.js';
import { bpmnToPN } from '../bpmn/workflow-net.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../tests/fixtures', `${name}.json`), 'utf8'));

describe('scenario enumeration — cycles', () => {
  test('simple-approval yields exactly 2 scenarios at the default cycle bound', () => {
    // start1 → task1 → gw1 ⟨Yes → task2 → end1 | No → task3 → task1 (back edge f5)⟩.
    // Bound 1: (a) straight through, (b) one revision then through. A second revision
    // would need f5 twice, so that path is discarded whole.
    const proc = fixture('simple-approval').pools[0];
    const result = enumerateScenarios(proc);

    expect(result.scenarios).toHaveLength(2);
    expect(result.stats.cycleBound).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.stats.backwardEdges.map(e => e.id)).toEqual(['f5']);
    expect(result.scenarios[0].nodes).toEqual(['start1', 'task1', 'gw1', 'task2', 'end1']);
    expect(result.scenarios[1].nodes).toEqual(
      ['start1', 'task1', 'gw1', 'task3', 'task1', 'gw1', 'task2', 'end1']);
    expect(result.scenarios[0].cycleUseCounts).toEqual({ p_task3_task1: 0 });
    expect(result.scenarios[1].cycleUseCounts).toEqual({ p_task3_task1: 1 });
  });

  test('simple-approval yields exactly 1 scenario at cycle bound 0', () => {
    // task3's only outgoing flow is the capped one, so the "No" branch never completes.
    const result = enumerateScenarios(fixture('simple-approval').pools[0], { cycleBound: 0 });

    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0].nodes).toEqual(['start1', 'task1', 'gw1', 'task2', 'end1']);
  });

  test('bpmn-generator-pipeline: Pool_User yields exactly 2 scenarios at cycle bound 1', () => {
    // Same shape as simple-approval: one XOR (gw_ok) with one back edge (fu6).
    const pool = fixture('bpmn-generator-pipeline').pools[0];
    const result = enumerateScenarios(pool, { cycleBound: 1 });

    expect(pool.id).toBe('Pool_User');
    expect(result.processId).toBe('Pool_User');
    expect(result.stats.backwardEdges.map(e => e.id)).toEqual(['fu6']);
    expect(result.scenarios).toHaveLength(2);
  });

  test('bpmn-generator-pipeline: Pool_Generator yields exactly 8 scenarios at cycle bound 1', () => {
    // gw_input (2 branches, no interaction with the cycle) × the cycle region:
    // gw_review ⟨valid → through⟩, ⟨errors → gw_maxiter ⟨max reached → through⟩,
    // ⟨refine → t_refine → back edge fo10 → gw_review again ⟨through⟩, ⟨gw_maxiter
    // ⟨through⟩, ⟨refine again → would need fo10 twice → discarded⟩⟩⟩⟩ = 4 per branch.
    const pool = fixture('bpmn-generator-pipeline').pools[1];
    const result = enumerateScenarios(pool, { cycleBound: 1 });

    expect(pool.id).toBe('Pool_Generator');
    expect(result.stats.backwardEdges.map(e => e.id)).toEqual(['fo10']);
    expect(result.scenarios).toHaveLength(8);
    // The bound is per backward edge and per path, never a global budget: every scenario
    // may use fo10 up to once, and four of the eight do.
    const withLoop = result.scenarios.filter(s => s.cycleUseCounts.p_t_refine_t_validate === 1);
    expect(withLoop).toHaveLength(4);
  });

  test('back edges map onto place ids bpmnToPN actually created', () => {
    for (const name of ['simple-approval', 'bpmn-generator-pipeline']) {
      for (const pool of fixture(name).pools) {
        const pn = bpmnToPN(pool);
        const result = enumerateScenarios(pool);
        expect(result.stats.backwardEdges.length).toBeGreaterThan(0);
        for (const e of result.stats.backwardEdges) {
          expect(e.placeId).toBe(backwardEdgePlaceId(e));
          expect(pn.places.has(e.placeId)).toBe(true);
        }
      }
    }
  });

  test('an activity loop marker is not a graph cycle', () => {
    // Regression against the mistake an early draft of the design made: reading
    // loopType/loopMaximum (BPMN standardLoopCharacteristics — ONE activity repeating
    // itself) as a bound on a backward sequence flow. subprocess-child-fidelity has
    // c_loop with loopType "standard" and not a single back edge, so the cycle bound has
    // nothing to act on and cannot change the result whatever it is set to.
    const proc = fixture('subprocess-child-fidelity').pools[0];
    const loopNode = proc.nodes.find(n => n.id === 'outer').nodes.find(n => n.id === 'c_loop');
    expect(loopNode.loopType).toBe('standard');

    expect(enumerateScenarios(proc).stats.backwardEdges).toEqual([]);
    const counts = [0, 1, 5].map(cycleBound =>
      enumerateScenarios(proc, { cycleBound }).scenarios.length);
    expect(counts).toEqual([counts[0], counts[0], counts[0]]);
    expect(counts[0]).toBeGreaterThan(0);
  });

  test('findBackwardEdges reports the edge that closes the cycle, not every revisit', () => {
    const proc = fixture('simple-approval').pools[0];
    const back = findBackwardEdges(proc.nodes, proc.edges);
    expect(back.map(e => e.id)).toEqual(['f5']);
  });
});

describe('scenario enumeration — capping is not a verdict', () => {
  test('a path dropped by the cycle bound is not reported as a dead end', () => {
    // The "No" branch at bound 0 is a path the model has and the enumerator did not
    // follow — not a deadlock, and nothing in the result may claim otherwise. A later
    // judging layer has to be able to tell the two apart.
    const result = enumerateScenarios(fixture('simple-approval').pools[0], { cycleBound: 0 });

    expect(result.stats.cappedPaths).toBe(1);
    expect(result.stats.deadEndPaths).toBe(0);
    expect(result.truncated).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/deadlock|unsound|WF0/i);
  });
});

describe('scenario enumeration — parallel interleavings', () => {
  test('a parallel block collapses to one scenario carrying its interleaving count', () => {
    const result = enumerateScenarios(fixture('parallel-split-join').pools[0]);

    expect(result.scenarios).toHaveLength(1); // not 3! = 6
    expect(result.scenarios[0].interleavingCount).toBe(6);
    expect(result.scenarios[0].nodes).toEqual(
      ['start1', 'fork', 'task_carrier', 'task_invoice', 'task_pack', 'join', 'end1']);
  });

  test('the canonical order is identical across runs', () => {
    const proc = fixture('parallel-split-join').pools[0];
    const a = enumerateScenarios(proc);
    const b = enumerateScenarios(proc);
    expect(b.scenarios.map(s => s.transitions)).toEqual(a.scenarios.map(s => s.transitions));
  });

  test('a four-branch parallel block counts 4! = 24 interleavings', () => {
    // Independent cross-check on a fixture that predates this subsystem: sparse-lanes
    // splits into a1..a4 and joins again, so the count must scale with the branch count.
    const result = enumerateScenarios(fixture('sparse-lanes').pools[0]);

    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0].interleavingCount).toBe(24);
    expect(result.scenarios[0].nodes).toEqual(
      ['s', 'split', 'a1', 'a2', 'a3', 'a4', 'join', 'b1', 'c1', 'd1', 'e']);
  });

  test('a fully sequential scenario has an interleaving count of 1', () => {
    const result = enumerateScenarios(fixture('simple-approval').pools[0]);
    expect(result.scenarios.map(s => s.interleavingCount)).toEqual([1, 1]);
  });
});

describe('scenario enumeration — limits are visible', () => {
  test('reaching maxScenarios flags the result as truncated', () => {
    const result = enumerateScenarios(fixture('simple-approval').pools[0], { maxScenarios: 1 });

    expect(result.scenarios).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  test('a run that stays under every cap is not flagged as truncated', () => {
    const result = enumerateScenarios(fixture('simple-approval').pools[0], { maxScenarios: 100 });

    expect(result.scenarios).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.stats.lengthTruncatedPaths).toBe(0);
  });
});
