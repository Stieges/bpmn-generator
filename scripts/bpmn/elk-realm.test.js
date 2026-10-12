/**
 * Known test-environment defect, recorded rather than fixed: under Jest's VM modules
 * (`node --experimental-vm-modules`, how `npm test` runs), the bundled elkjs does not lay out a graph
 * whose objects were built by `structuredClone`. `structuredClone` creates its objects in Node's
 * outer realm, not in the Jest sandbox (`Object.getPrototypeOf(structuredClone({})) !==
 * Object.prototype` there), and elkjs's compiled GWT code misreads such objects: a fully cloned
 * graph comes back with no coordinates at all, and a graph built from cloned Logic-Core parts is
 * laid out differently (measured on a seven-node process: every node moved).
 *
 * Plain `node` is not affected — there is only one realm — so this is not a production defect.
 * It surfaced in cross/decision-doc.js, whose first draft cloned with structuredClone and changed
 * the BPMN layout under Jest only; Logic-Core is JSON, so the pipeline clones with
 * `JSON.parse(JSON.stringify(…))` (as topology.js normalizeEdgeIds does). Do not use
 * structuredClone on anything that reaches ELK.
 *
 * Skipped because it fails by design under Jest; un-skip to check whether a Jest or elkjs release
 * has fixed it. Run outside Jest, the same assertion passes.
 */
import { test, expect } from '@jest/globals';
import ELK from 'elkjs/lib/elk.bundled.js';

const graph = () => ({
  id: 'root',
  layoutOptions: { 'elk.algorithm': 'layered' },
  children: [{ id: 'a', width: 50, height: 50 }, { id: 'b', width: 50, height: 50 }],
  edges: [{ id: 'e', sources: ['a'], targets: ['b'] }],
});

test.skip('elkjs lays out a structuredClone-built graph under Jest (it does not: x/y come back undefined)', async () => {
  const laidOut = await new ELK().layout(structuredClone(graph()));
  expect(laidOut.children.map((c) => Number.isFinite(c.x))).toEqual([true, true]);
});

test('the same graph built as plain objects is laid out (the control)', async () => {
  const laidOut = await new ELK().layout(graph());
  expect(laidOut.children.map((c) => Number.isFinite(c.x))).toEqual([true, true]);
});
