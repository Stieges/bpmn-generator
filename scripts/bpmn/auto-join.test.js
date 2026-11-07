/**
 * Fence for insertAutoJoinGateways — bpmnlint fake-join remediation.
 */
import { describe, test, expect } from '@jest/globals';
import { insertAutoJoinGateways, preprocessLogicCore } from './topology.js';

describe('insertAutoJoinGateways', () => {
  test('rewires multi-in activity through an exclusive converging gateway', () => {
    const proc = {
      id: 'P',
      nodes: [
        { id: 'S', type: 'startEvent', name: 'Start', lane: 'L1' },
        { id: 'A', type: 'userTask', name: 'Do Work', lane: 'L1' },
        { id: 'B', type: 'userTask', name: 'Rework', lane: 'L1' },
        { id: 'E', type: 'endEvent', name: 'End', lane: 'L1' },
      ],
      edges: [
        { id: 'e1', source: 'S', target: 'A' },
        { id: 'e2', source: 'A', target: 'B' },
        { id: 'e3', source: 'B', target: 'A' }, // rework → fake-join on A
        { id: 'e4', source: 'A', target: 'E' },
      ],
      lanes: [{ id: 'L1', name: 'Ops', nodeIds: ['S', 'A', 'B', 'E'] }],
    };
    const used = new Set(['P', 'S', 'A', 'B', 'E', 'e1', 'e2', 'e3', 'e4', 'L1']);
    const n = insertAutoJoinGateways(proc, used);
    expect(n).toBe(1);
    const join = proc.nodes.find((x) => x.type === 'exclusiveGateway' && x.has_join);
    expect(join).toBeTruthy();
    expect(join.lane).toBe('L1');
    expect(proc.lanes[0].nodeIds).toContain(join.id);
    // All former A-incomings now target the join
    const intoJoin = proc.edges.filter((e) => e.target === join.id);
    expect(intoJoin.map((e) => e.source).sort()).toEqual(['B', 'S']);
    // Single edge join → A
    const intoA = proc.edges.filter((e) => e.target === 'A');
    expect(intoA).toHaveLength(1);
    expect(intoA[0].source).toBe(join.id);
  });

  test('is idempotent — a second pass inserts nothing', () => {
    const proc = {
      nodes: [
        { id: 'S', type: 'startEvent' },
        { id: 'T', type: 'task' },
        { id: 'R', type: 'task' },
      ],
      edges: [
        { id: 'a', source: 'S', target: 'T' },
        { id: 'b', source: 'R', target: 'T' },
      ],
    };
    const used = new Set(['S', 'T', 'R', 'a', 'b']);
    expect(insertAutoJoinGateways(proc, used)).toBe(1);
    expect(insertAutoJoinGateways(proc, used)).toBe(0);
  });

  test('leaves gateways with multi-in alone', () => {
    const proc = {
      nodes: [
        { id: 'G', type: 'exclusiveGateway', has_join: true },
        { id: 'A', type: 'task' },
        { id: 'B', type: 'task' },
      ],
      edges: [
        { id: 'a', source: 'A', target: 'G' },
        { id: 'b', source: 'B', target: 'G' },
      ],
    };
    expect(insertAutoJoinGateways(proc, new Set(['G', 'A', 'B', 'a', 'b']))).toBe(0);
  });

  test('preprocessLogicCore skips auto-join by default (upstream-stable)', () => {
    const lc = {
      id: 'P',
      nodes: [
        { id: 'S', type: 'startEvent' },
        { id: 'T', type: 'task' },
        { id: 'R', type: 'task' },
      ],
      edges: [
        { id: 'e1', source: 'S', target: 'T' },
        { id: 'e2', source: 'R', target: 'T' },
      ],
    };
    preprocessLogicCore(lc);
    expect(lc.nodes.some((n) => n.type === 'exclusiveGateway')).toBe(false);
  });

  test('preprocessLogicCore runs auto-join when enabled', () => {
    const lc = {
      id: 'P',
      nodes: [
        { id: 'S', type: 'startEvent', lane: 'L' },
        { id: 'T', type: 'userTask', name: 'Do', lane: 'L' },
        { id: 'R', type: 'userTask', name: 'Retry', lane: 'L' },
      ],
      edges: [
        { id: 'e1', source: 'S', target: 'T' },
        { id: 'e2', source: 'T', target: 'R' },
        { id: 'e3', source: 'R', target: 'T' },
      ],
      lanes: [{ id: 'L', name: 'L', nodeIds: ['S', 'T', 'R'] }],
    };
    preprocessLogicCore(lc, { autoJoinGateways: true });
    expect(lc.nodes.some((n) => n.type === 'exclusiveGateway' && n.has_join)).toBe(true);
  });
});
