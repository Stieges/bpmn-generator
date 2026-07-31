import { describe, test, expect } from '@jest/globals';
import { decisionCoreToElk, runDmnElkLayout } from './layout.js';
import { DRD_SHAPE } from './constants.js';

const chain = () => ({
  namespace: 'http://bpmn-generator.local/dmn/test',
  nodes: [
    { id: 'in1', type: 'inputData', name: 'In 1' },
    { id: 'dec1', type: 'decision', name: 'Dec 1' },
  ],
  requirements: [
    { type: 'information', source: 'in1', target: 'dec1' },
  ],
});

// A diamond, not a chain: two independent branches (Left/Right), each fed by two
// inputData nodes, both merging into one top-level decision. Every inputData node
// is exactly two requirement-hops from dTop via a path of the SAME length, which
// is what makes the layer assignment unambiguous (see the test below for why).
const diamond = () => ({
  namespace: 'http://bpmn-generator.local/dmn/test',
  nodes: [
    { id: 'inA', type: 'inputData', name: 'In A' },
    { id: 'inB', type: 'inputData', name: 'In B' },
    { id: 'inC', type: 'inputData', name: 'In C' },
    { id: 'inD', type: 'inputData', name: 'In D' },
    { id: 'dLeft',  type: 'decision', name: 'Left' },
    { id: 'dRight', type: 'decision', name: 'Right' },
    { id: 'dTop',   type: 'decision', name: 'Top' },
  ],
  requirements: [
    { type: 'information', source: 'inA', target: 'dLeft' },
    { type: 'information', source: 'inB', target: 'dLeft' },
    { type: 'information', source: 'inC', target: 'dRight' },
    { type: 'information', source: 'inD', target: 'dRight' },
    { type: 'information', source: 'dLeft',  target: 'dTop' },
    { type: 'information', source: 'dRight', target: 'dTop' },
  ],
});

describe('decisionCoreToElk', () => {
  test('sizes each node from DRD_SHAPE and builds one ELK edge per requirement', () => {
    const graph = decisionCoreToElk(chain());
    expect(graph.children).toEqual([
      { id: 'in1', width: DRD_SHAPE.inputData.w, height: DRD_SHAPE.inputData.h },
      { id: 'dec1', width: DRD_SHAPE.decision.w, height: DRD_SHAPE.decision.h },
    ]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ sources: ['in1'], targets: ['dec1'] });
    // chain()'s single requirement has no `id`, so the `r.id || `req_${i}`` fallback
    // (layout.js:53-57) must generate 'req_0' for it — otherwise unasserted.
    expect(graph.edges[0].id).toBe('req_0');
  });

  test('sets direction UP and POLYLINE routing — no STRAIGHT value exists in the ELK enum', () => {
    const graph = decisionCoreToElk(chain());
    expect(graph.properties['elk.direction']).toBe('UP');
    expect(graph.properties['elk.edgeRouting']).toBe('POLYLINE');
  });
});

describe('runDmnElkLayout — layer order on a branching graph', () => {
  test('input data sits at the largest y, the top-level decision at the smallest y, on a diamond DRG (not just a chain)', async () => {
    // Re-verifies elk.direction: 'UP' beyond the original 3-node chain check (which cannot
    // distinguish "layer order is correct" from "there happened to be only one node per layer").
    // Empirically confirmed against this project's installed elkjs@0.12.0 with this exact graph and
    // these exact spacing/padding options (nodeNode: 40, layerNode: 80, elk.padding: 20 on every
    // side, per DRD_SPACING.margin): inA/inB/inC/inD all land at y=349.375, dLeft/dRight both at
    // y=186.75, dTop alone at y=20 (the top padding). The assertions below check the relationships
    // (ties and strict ordering) rather than hardcoding those pixel values, since the exact numbers
    // are free to shift with spacing/version changes while the ordering must not.
    const graph = decisionCoreToElk(diamond());
    const laidOut = await runDmnElkLayout(graph);
    const y = Object.fromEntries(laidOut.children.map(c => [c.id, c.y]));

    // All four input data nodes are two requirement-hops from dTop via equal-length paths, so
    // their layer is unambiguous: they must tie for the maximum y. (A layering algorithm is free
    // to place an in-degree-0 node anywhere between layer 0 and one layer before its target when
    // path lengths differ across sources — equal path lengths remove that freedom entirely.)
    expect(y.inA).toBe(y.inB);
    expect(y.inB).toBe(y.inC);
    expect(y.inC).toBe(y.inD);

    // The two intermediate decisions are symmetric siblings — same layer as each other.
    expect(y.dLeft).toBe(y.dRight);

    // Strict descent along every requirement edge: source above target in y (larger y = lower on
    // screen = earlier in the dependency chain, confirmed empirically for elk.direction: 'UP').
    expect(y.inA).toBeGreaterThan(y.dLeft);
    expect(y.dLeft).toBeGreaterThan(y.dTop);

    // dTop is the sink of the whole graph — nothing requires it — so it holds the global minimum
    // y; every input data node holds the global maximum.
    const allY = Object.values(y);
    expect(y.dTop).toBe(Math.min(...allY));
    expect(y.inA).toBe(Math.max(...allY));
  });
});
