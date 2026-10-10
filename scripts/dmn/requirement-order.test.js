import { describe, test, expect } from '@jest/globals';
import { requirementKey, orderedRequirements } from './requirement-order.js';

const nodes = [
  { id: 'in1', type: 'inputData' },
  { id: 'in2', type: 'inputData' },
  { id: 'decA', type: 'decision' },
  { id: 'decB', type: 'decision' },
];
const ids = (list) => list.map((r) => r.id);

describe('requirementKey', () => {
  test('an explicit id wins; a missing or empty one falls back to the derived key', () => {
    expect(requirementKey({ id: 'r1', source: 'a', target: 'b' })).toBe('r1');
    expect(requirementKey({ source: 'a', target: 'b' })).toBe('req_a_b');
    expect(requirementKey({ id: '', source: 'a', target: 'b' })).toBe('req_a_b');
  });
});

describe('orderedRequirements', () => {
  test('groups by target in dc.nodes order, whatever order the array is in', () => {
    const requirements = [
      { id: 'toB', type: 'information', source: 'in1', target: 'decB' },
      { id: 'toA', type: 'information', source: 'in1', target: 'decA' },
    ];
    expect(ids(orderedRequirements({ nodes, requirements }))).toEqual(['toA', 'toB']);
  });

  test('within a target, orders by the XSD kind sequence: information, knowledge, authority', () => {
    const requirements = [
      { id: 'au', type: 'authority', source: 'in1', target: 'decA' },
      { id: 'kn', type: 'knowledge', source: 'in1', target: 'decA' },
      { id: 'in', type: 'information', source: 'in1', target: 'decA' },
    ];
    expect(ids(orderedRequirements({ nodes, requirements }))).toEqual(['in', 'kn', 'au']);
  });

  test('siblings sharing target AND kind keep the author order', () => {
    const a = [
      { id: 'x', type: 'information', source: 'in1', target: 'decA' },
      { id: 'y', type: 'information', source: 'in2', target: 'decA' },
    ];
    expect(ids(orderedRequirements({ nodes, requirements: a }))).toEqual(['x', 'y']);
    expect(ids(orderedRequirements({ nodes, requirements: [...a].reverse() }))).toEqual(['y', 'x']);
  });

  test('requirements it cannot place are appended in array order, not dropped', () => {
    const requirements = [
      { id: 'ghost', type: 'information', source: 'in1', target: 'nowhere' },
      { id: 'odd', type: 'bogus', source: 'in1', target: 'decA' },
      { id: 'ok', type: 'information', source: 'in1', target: 'decB' },
    ];
    expect(ids(orderedRequirements({ nodes, requirements }))).toEqual(['ok', 'ghost', 'odd']);
  });

  test('tolerates absent requirements and nodes', () => {
    expect(orderedRequirements({})).toEqual([]);
    const one = [{ id: 'only', type: 'information', source: 'in1', target: 'decA' }];
    expect(orderedRequirements({ requirements: one })).toEqual(one);
  });

  test('does not mutate dc.requirements', () => {
    const requirements = [
      { id: 'toB', type: 'information', source: 'in1', target: 'decB' },
      { id: 'toA', type: 'information', source: 'in1', target: 'decA' },
    ];
    orderedRequirements({ nodes, requirements });
    expect(ids(requirements)).toEqual(['toB', 'toA']);
  });
});
