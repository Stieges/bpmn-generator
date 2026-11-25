/**
 * Fence for splitMixedGateways — bpmnlint no-gateway-join-fork + conditional-flows.
 */
import { describe, test, expect } from '@jest/globals';
import { splitMixedGateways, resolveFlowSemantics, preprocessLogicCore } from './topology.js';

describe('splitMixedGateways', () => {
  test('splits Mixed XOR into join → diverge and restores conditions', () => {
    const proc = {
      id: 'P',
      nodes: [
        { id: 'S', type: 'startEvent', name: 'Start', lane: 'L1' },
        { id: 'A', type: 'userTask', name: 'Path A', lane: 'L1' },
        { id: 'B', type: 'userTask', name: 'Path B', lane: 'L1' },
        { id: 'GW', type: 'exclusiveGateway', name: 'Tool needed?', lane: 'L1' },
        { id: 'Y', type: 'userTask', name: 'Request Tool', lane: 'L1' },
        { id: 'N', type: 'userTask', name: 'Skip Tool', lane: 'L1' },
        { id: 'E', type: 'endEvent', name: 'End', lane: 'L1' },
      ],
      edges: [
        { id: 'e1', source: 'S', target: 'A' },
        { id: 'e2', source: 'S', target: 'B' },
        { id: 'e3', source: 'A', target: 'GW' },
        { id: 'e4', source: 'B', target: 'GW' },
        { id: 'e5', source: 'GW', target: 'Y', label: 'Yes' },
        { id: 'e6', source: 'GW', target: 'N', label: 'No', isDefault: true },
        { id: 'e7', source: 'Y', target: 'E' },
        { id: 'e8', source: 'N', target: 'E' },
      ],
      lanes: [{ id: 'L1', name: 'Ops', nodeIds: ['S', 'A', 'B', 'GW', 'Y', 'N', 'E'] }],
    };
    const used = new Set(proc.nodes.map((n) => n.id).concat(proc.edges.map((e) => e.id), ['P', 'L1']));
    expect(splitMixedGateways(proc, used)).toBe(1);
    const join = proc.nodes.find((n) => n.id.startsWith('gw_join_GW'));
    expect(join).toBeTruthy();
    expect(join.has_join).toBe(true);
    expect(proc.edges.filter((e) => e.target === 'GW')).toHaveLength(1);
    expect(proc.edges.filter((e) => e.target === join.id).map((e) => e.source).sort()).toEqual(['A', 'B']);
    const { conditionById, defaultBySource } = resolveFlowSemantics(proc.nodes, proc.edges);
    expect(defaultBySource.get('GW')).toBe('e6');
    expect(conditionById.get('e5')).toBe('Yes');
    expect(conditionById.has('e6')).toBe(false);
  });

  test('is idempotent', () => {
    const proc = {
      nodes: [
        { id: 'A', type: 'task' },
        { id: 'B', type: 'task' },
        { id: 'GW', type: 'exclusiveGateway', name: 'Q?' },
        { id: 'Y', type: 'task' },
        { id: 'N', type: 'task' },
      ],
      edges: [
        { id: 'a', source: 'A', target: 'GW' },
        { id: 'b', source: 'B', target: 'GW' },
        { id: 'y', source: 'GW', target: 'Y', label: 'Yes' },
        { id: 'n', source: 'GW', target: 'N', label: 'No', isDefault: true },
      ],
    };
    const used = new Set(['A', 'B', 'GW', 'Y', 'N', 'a', 'b', 'y', 'n']);
    expect(splitMixedGateways(proc, used)).toBe(1);
    expect(splitMixedGateways(proc, used)).toBe(0);
  });

  test('preprocessLogicCore splits Mixed when enabled (default)', () => {
    const lc = {
      id: 'P',
      nodes: [
        { id: 'A', type: 'userTask', name: 'A', lane: 'L' },
        { id: 'B', type: 'userTask', name: 'B', lane: 'L' },
        { id: 'GW', type: 'exclusiveGateway', name: 'Q?', lane: 'L' },
        { id: 'Y', type: 'userTask', name: 'Yes path', lane: 'L' },
        { id: 'N', type: 'userTask', name: 'No path', lane: 'L' },
      ],
      edges: [
        { id: 'a', source: 'A', target: 'GW' },
        { id: 'b', source: 'B', target: 'GW' },
        { id: 'y', source: 'GW', target: 'Y', label: 'Yes' },
        { id: 'n', source: 'GW', target: 'N', label: 'No', isDefault: true },
      ],
      lanes: [{ id: 'L', name: 'L', nodeIds: ['A', 'B', 'GW', 'Y', 'N'] }],
    };
    preprocessLogicCore(lc, { autoJoinGateways: false, splitMixedGateways: true });
    expect(lc.nodes.some((n) => n.type === 'exclusiveGateway' && n.has_join)).toBe(true);
  });
});
