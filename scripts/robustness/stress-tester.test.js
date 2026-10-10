import { describe, test, expect } from '@jest/globals';
import { preFilter } from './stress-tester.js';
import { dotToLogicCore } from '../bpmn/dot.js';
import { validateLogicCore } from '../bpmn/validate.js';

const DOT = ['digraph G {', '  s [shape=circle label="S"];', '  b [shape=box label="B"];', '  e [shape=doublecircle label="E"];',
  '  s -> b;', '  b -> e;', '}'].join('\n');

describe('DOT-imported (id-less) edges in the robustness pre-filter (#66)', () => {
  test('preFilter assigns edge ids before validating: no `Edge ""` finding', async () => {
    const lc = dotToLogicCore(DOT);
    expect(lc.edges.every((e) => e.id === undefined)).toBe(true);
    const r = await preFilter(lc);
    expect(JSON.stringify(r)).not.toMatch(/Edge ""/);
    expect(r.schemaErrors ?? []).toEqual([]);
    expect(lc.edges.every((e) => e.id === undefined)).toBe(true); // caller untouched
  });

  test('validateLogicCore names an id-less edge as source→target, not ""', () => {
    const lc = dotToLogicCore(DOT);
    lc.edges.push({ source: 'b', target: 'ghost' });
    const { errors } = validateLogicCore(lc);
    expect(errors.join('\n')).toContain('Edge "b→ghost" unknown target');
    expect(errors.join('\n')).not.toContain('Edge ""');
  });
});
