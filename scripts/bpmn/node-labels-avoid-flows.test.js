/**
 * Fence for placeNodeLabelsAvoidingFlows (coordinates.js, `layout.nodeLabelsAvoidFlows`): an event's
 * or a gateway's label leaves the bottom when a flow leaves or enters the node there. Two parts:
 *  - the pass on hand-built geometry: when it moves a label, where to, and when it must not;
 *  - the pass in the pipeline: off changes nothing, on (alone and with the bend rule) moves labels
 *    only onto free candidates.
 * The renderers' agreement with a moved box is fenced in pipeline.test.js ("the two renderers agree
 * on node labels"), with the switch both off and on.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { placeNodeLabels, placeNodeLabelsAvoidingFlows, nodeLabelCandidates, edgeLabelBox, labelHitsRoute } from './coordinates.js';
import { runPipeline } from './pipeline.js';
import { CFG } from '../shared/utils.js';
import { generateSvg } from './svg.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const FIXTURES = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort();
const load = (name) => JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'));
const P = (x, y) => ({ x, y });

/** A coordMap with default label boxes, like the pipeline hands it over. */
const withLabels = (cm, lc) => ({ edgeLabels: {}, laneCoords: {}, poolCoords: {}, ...cm, nodeLabels: placeNodeLabels(cm.coords, lc) });
const sideOf = (lc, cm, id, box) => {
  const node = (lc.pools || [lc]).flatMap(p => p.nodes).flatMap(n => [n, ...(n.nodes || [])]).find(n => n.id === id);
  return nodeLabelCandidates(node, cm.coords[id]).find(k => JSON.stringify(k.box) === JSON.stringify(box))?.side;
};

// The sf3 shape (multi-pool-collaboration): a gateway whose "Yes" flow leaves straight down and
// whose "No" flow leaves to the right. The default label sits right where "Yes" runs.
const sf3 = () => {
  const lc = { id: 'P', nodes: [{ id: 'g', type: 'exclusiveGateway', name: 'Valid?' },
    { id: 't', type: 'task', name: 'Ship' }, { id: 'u', type: 'task', name: 'Reject' }],
  edges: [{ id: 'yes', source: 'g', target: 't' }, { id: 'no', source: 'g', target: 'u' }] };
  const cm = withLabels({
    coords: { g: { x: 0, y: 100, w: 50, h: 50 }, t: { x: 100, y: 250, w: 100, h: 80 }, u: { x: 200, y: 85, w: 100, h: 80 } },
    edgeCoords: { yes: [P(25, 150), P(25, 290), P(100, 290)], no: [P(50, 125), P(200, 125)] },
  }, lc);
  return { lc, cm };
};

describe('nodeLabelCandidates', () => {
  test('below (the default box), above, right-below, left-below — same size and lines', () => {
    const node = { id: 'g', type: 'exclusiveGateway', name: 'Valid?' };
    const c = { x: 0, y: 100, w: 50, h: 50 };
    const [below, above, right, left] = nodeLabelCandidates(node, c);
    expect(below).toEqual({ side: 'below', box: placeNodeLabels({ g: c }, { nodes: [node] }).g });
    const d = CFG.layout.labelDistance;
    const { w, h } = below.box;
    expect(above.box.y + h).toBe(c.y - d);
    expect(above.box.x).toBe(below.box.x);
    expect(right.box).toMatchObject({ x: 25 + d, y: below.box.y, w, h });
    expect(left.box).toMatchObject({ x: 25 - d - w, y: below.box.y, w, h });
    expect(new Set([below, above, right, left].map(k => k.box.lines))).toEqual(new Set([below.box.lines]));
  });
  test('a task, a nameless gateway and a data object have none', () => {
    const c = { x: 0, y: 0, w: 50, h: 50 };
    expect(nodeLabelCandidates({ type: 'task', name: 'A' }, c)).toEqual([]);
    expect(nodeLabelCandidates({ type: 'exclusiveGateway' }, c)).toEqual([]);
    expect(nodeLabelCandidates({ type: 'dataObjectReference', name: 'D' }, c)).toEqual([]);
  });
});

describe('placeNodeLabelsAvoidingFlows — on hand-built geometry', () => {
  test('sf3: "Yes" leaves straight down through "Valid?" — the label goes above', () => {
    const { lc, cm } = sf3();
    expect(labelHitsRoute(cm.nodeLabels.g, cm.edgeCoords.yes)).toBe(true);   // the defect
    const out = placeNodeLabelsAvoidingFlows(cm, lc);
    expect(sideOf(lc, cm, 'g', out.g)).toBe('above');
    expect(Object.values(cm.edgeCoords).some(pts => labelHitsRoute(out.g, pts))).toBe(false);
    expect(cm.nodeLabels.g.y).toBeGreaterThan(cm.coords.g.y);                   // input untouched
  });

  test('a flow leaving through the lower-right facet and turning down through the label counts too', () => {
    // How ELK docks a gateway's second outgoing flow: on the diamond's lower-right edge, not at its
    // bottom vertex — then straight down through the default label.
    const { lc, cm } = sf3();
    cm.edgeCoords.yes = [P(37.5, 137.5), P(37.5, 290), P(100, 290)];
    expect(labelHitsRoute(cm.nodeLabels.g, cm.edgeCoords.yes)).toBe(true);
    expect(sideOf(lc, cm, 'g', placeNodeLabelsAvoidingFlows(cm, lc).g)).toBe('above');
  });

  test('above taken by a flow entering from the top — right-below', () => {
    const { lc, cm } = sf3();
    lc.nodes.push({ id: 'v', type: 'task' });
    lc.edges.push({ id: 'in', source: 'v', target: 'g' });
    cm.coords.v = { x: -25, y: -100, w: 100, h: 80 };
    cm.edgeCoords.in = [P(25, -20), P(25, 100)];
    expect(sideOf(lc, cm, 'g', placeNodeLabelsAvoidingFlows(cm, lc).g)).toBe('right-below');
  });

  test('right-below taken by an edge label — left-below; another node label counts the same', () => {
    const { lc, cm } = sf3();
    lc.nodes.push({ id: 'v', type: 'task' });
    lc.edges.push({ id: 'in', source: 'v', target: 'g' });
    cm.coords.v = { x: -25, y: -100, w: 100, h: 80 };
    cm.edgeCoords.in = [P(25, -20), P(25, 100)];
    cm.edgeLabels = { no: { x: 60, y: 167, w: 30, h: 14, text: 'No', lines: ['No'] } };
    expect(sideOf(lc, cm, 'g', placeNodeLabelsAvoidingFlows(cm, lc).g)).toBe('left-below');

    cm.edgeLabels = {};
    cm.nodeLabels = { ...cm.nodeLabels, other: { x: 50, y: 160, w: 30, h: 14, lines: ['x'] } };
    expect(sideOf(lc, cm, 'g', placeNodeLabelsAvoidingFlows(cm, lc).g)).toBe('left-below');
  });

  test('no free candidate: the default box stays and the same object comes back', () => {
    const { lc, cm } = sf3();
    lc.nodes.push({ id: 'v', type: 'task' }, { id: 'z', type: 'task' });
    lc.edges.push({ id: 'in', source: 'v', target: 'g' });
    cm.coords.v = { x: -25, y: -100, w: 100, h: 80 };
    cm.coords.z = { x: -60, y: 155, w: 50, h: 30 };                             // left-below
    cm.edgeCoords.in = [P(25, -20), P(25, 100)];                                // above
    cm.edgeLabels = { no: { x: 60, y: 167, w: 30, h: 14, text: 'No', lines: ['No'] } }; // right-below
    expect(placeNodeLabelsAvoidingFlows(cm, lc)).toBe(cm.nodeLabels);
  });

  test('no flow at the bottom: a label stays even where a foreign route crosses it', () => {
    const { lc, cm } = sf3();
    cm.edgeCoords.yes = [P(50, 125), P(75, 125), P(75, 290), P(100, 290)];
    cm.edgeCoords.other = [P(-50, 167), P(80, 167)];
    expect(placeNodeLabelsAvoidingFlows(cm, lc)).toBe(cm.nodeLabels);
  });

  test('a message flow at the bottom of an event moves its label; without it nothing moves', () => {
    const lc = { pools: [
      { id: 'A', name: 'A', nodes: [{ id: 'e', type: 'intermediateThrowEvent', name: 'Order sent' }], edges: [] },
      { id: 'B', name: 'B', nodes: [{ id: 'r', type: 'task', name: 'Receive' }], edges: [] },
    ], messageFlows: [{ id: 'm', source: 'e', target: 'r' }] };
    const cm = withLabels({
      coords: { e: { x: 100, y: 80, w: 36, h: 36 }, r: { x: 68, y: 300, w: 100, h: 80 } },
      poolCoords: { A: { x: 0, y: 0, w: 600, h: 200, laneHeaderWidth: 30 }, B: { x: 0, y: 260, w: 600, h: 200, laneHeaderWidth: 30 } },
      edgeCoords: { m: [P(118, 116), P(118, 300)] },
    }, lc);
    expect(sideOf(lc, cm, 'e', placeNodeLabelsAvoidingFlows(cm, lc).e)).toBe('above');
    expect(placeNodeLabelsAvoidingFlows(cm, { ...lc, messageFlows: [] })).toBe(cm.nodeLabels);
  });

  test('a candidate outside the participant\'s content area or across a lane separator is not free', () => {
    const lc = { pools: [{ id: 'A', name: 'A', lanes: [{ id: 'L1', nodeIds: ['e'] }, { id: 'L2', nodeIds: ['t'] }],
      nodes: [{ id: 'e', type: 'startEvent', name: 'Go', lane: 'L1' }, { id: 't', type: 'task', lane: 'L2' }],
      edges: [{ id: 'f', source: 'e', target: 't' }] }] };
    const cm = withLabels({
      coords: { e: { x: 100, y: 8, w: 36, h: 36 }, t: { x: 68, y: 130, w: 100, h: 80 } },
      poolCoords: { A: { x: 0, y: 0, w: 600, h: 240, laneHeaderWidth: 30 } },
      laneCoords: { L1: { x: 30, y: 0, w: 570, h: 120 }, L2: { x: 30, y: 120, w: 570, h: 120 } },
      edgeCoords: { f: [P(118, 44), P(118, 130)] },
    }, lc);
    // above leaves the pool (y < 0): right-below it is.
    expect(sideOf(lc, cm, 'e', placeNodeLabelsAvoidingFlows(cm, lc).e)).toBe('right-below');
    // Push the event down until its below-candidates straddle the lane separator at y = 120 and
    // above is inside the pool: above it is.
    cm.coords.e = { x: 100, y: 70, w: 36, h: 36 };
    cm.edgeCoords.f = [P(118, 106), P(118, 130)];
    cm.nodeLabels = placeNodeLabels(cm.coords, lc);
    expect(sideOf(lc, cm, 'e', placeNodeLabelsAvoidingFlows(cm, lc).e)).toBe('above');
    // ... and with above blocked too, nothing is free: the default stays.
    cm.coords.x = { x: 90, y: 40, w: 60, h: 30 };
    expect(placeNodeLabelsAvoidingFlows(cm, lc)).toBe(cm.nodeLabels);
  });

  test("a boundary event's host is in the way (above would sit inside it): right-below", () => {
    const lc = { id: 'P', nodes: [{ id: 'h', type: 'task', name: 'Work' }, { id: 'b', type: 'boundaryEvent', attachedTo: 'h', name: 'Late' },
      { id: 't', type: 'task' }], edges: [{ id: 'e', source: 'b', target: 't' }] };
    const cm = withLabels({
      coords: { h: { x: 0, y: 0, w: 100, h: 80 }, b: { x: 32, y: 62, w: 36, h: 36 }, t: { x: 200, y: 110, w: 100, h: 80 } },
      edgeCoords: { e: [P(50, 98), P(50, 150), P(200, 150)] },
    }, lc);
    expect(sideOf(lc, cm, 'b', placeNodeLabelsAvoidingFlows(cm, lc).b)).toBe('right-below');
  });

  test('an expanded subprocess wrapping the node and the candidate is no obstacle', () => {
    const { lc: inner, cm } = sf3();
    const lc = { id: 'P', nodes: [{ id: 'sp', type: 'subProcess', isExpanded: true, nodes: inner.nodes, edges: inner.edges }], edges: [] };
    cm.coords.sp = { x: -100, y: 0, w: 500, h: 400 };
    cm.nodeLabels = placeNodeLabels(cm.coords, lc);
    expect(sideOf(lc, cm, 'g', placeNodeLabelsAvoidingFlows(cm, lc).g)).toBe('above');
  });

  test("a child near the top of an expanded subprocess: above would cover the title band, so it is rejected", () => {
    const { lc: inner, cm } = sf3();
    const lc = { id: 'P', nodes: [{ id: 'sp', type: 'subProcess', isExpanded: true, nodes: inner.nodes, edges: inner.edges }], edges: [] };
    cm.coords.sp = { x: -100, y: 0, w: 500, h: 400 };
    cm.coords.g.y = 60;
    cm.edgeCoords.yes[0] = P(25, 110); cm.edgeCoords.no[0] = P(50, 85);
    cm.nodeLabels = placeNodeLabels(cm.coords, lc);
    const moved = placeNodeLabelsAvoidingFlows(cm, lc).g;
    expect(sideOf(lc, cm, 'g', moved)).not.toBe('above');
    expect(moved.y).toBeGreaterThanOrEqual(cm.coords.sp.y + CFG.layout.subProcessTitleBand);
    // The same node lower down still takes "above".
    cm.coords.g.y = 100; cm.edgeCoords.yes[0] = P(25, 150); cm.edgeCoords.no[0] = P(50, 125);
    cm.nodeLabels = placeNodeLabels(cm.coords, lc);
    expect(sideOf(lc, cm, 'g', placeNodeLabelsAvoidingFlows(cm, lc).g)).toBe('above');
  });

  test('a left-below label of a leftmost event in a lane-less process lies inside the SVG canvas', () => {
    const lc = { id: 'P', nodes: [{ id: 's', type: 'startEvent', name: 'Order received by the warehouse' }, { id: 't', type: 'task', name: 'Ship' }],
      edges: [{ id: 'e', source: 's', target: 't' }] };
    const coords = { s: { x: 100, y: 100, w: 36, h: 36 }, t: { x: 200, y: 78, w: 100, h: 80 } };
    const box = { x: 100 + 18 - 10 - 90, y: 146, w: 90, h: 42, lines: ['Order received by', 'the warehouse'] };
    const svg = generateSvg(lc, { coords, laneCoords: {}, poolCoords: {}, edgeCoords: { e: [P(136, 118), P(200, 118)] }, edgeLabels: {}, nodeLabels: { s: box } });
    const [, , vw] = svg.match(/viewBox="([\d.\s-]+)"/)[1].split(/\s+/).map(Number);
    // Shapes alone span x 100..300; the label starts 72 px left of the leftmost shape, beyond the
    // 50 px padding — the canvas has to grow to hold it, to the box's left edge plus padding.
    expect(vw).toBeGreaterThanOrEqual(300 - box.x + 50);
  });

  test('a data object\'s label never moves', () => {
    const lc = { id: 'P', nodes: [{ id: 'd', type: 'dataObjectReference', name: 'Order' }, { id: 't', type: 'task' }],
      edges: [], associations: [{ id: 'a', source: 'd', target: 't' }] };
    const cm = withLabels({ coords: { d: { x: 0, y: 0, w: 36, h: 50 }, t: { x: -32, y: 150, w: 100, h: 80 } },
      edgeCoords: { a: [P(18, 50), P(18, 150)] } }, lc);
    expect(placeNodeLabelsAvoidingFlows(cm, lc)).toBe(cm.nodeLabels);
  });

  test('idempotent: a second run over the first run\'s labels changes nothing', () => {
    const { lc, cm } = sf3();
    const once = placeNodeLabelsAvoidingFlows(cm, lc);
    expect(once).not.toBe(cm.nodeLabels);
    // The second run starts from the moved box: the trigger still fires, the first free candidate
    // is still the one already taken.
    expect(placeNodeLabelsAvoidingFlows({ ...cm, nodeLabels: once }, lc)).toEqual(once);
  });
});

describe('placeNodeLabelsAvoidingFlows — in the pipeline', () => {
  test('the switch defaults to on in config.json', () => {
    expect(CFG.layout.nodeLabelsAvoidFlows).toBe(true);
  });

  test('off: every label is the default box below its node', async () => {
    const lc = load('multi-pool-collaboration.json');
    const r = await runPipeline(lc, { nodeLabelsAvoidFlows: false });
    expect(r.coordMap.nodeLabels).toEqual(placeNodeLabels(r.coordMap.coords, lc));
  });

  test('multi-pool-collaboration: a gateway label a flow ran through moves off it', async () => {
    const lc = load('multi-pool-collaboration.json');
    const off = await runPipeline(load('multi-pool-collaboration.json'), { nodeLabelsAvoidFlows: false });
    const on = await runPipeline(lc, { nodeLabelsAvoidFlows: true });
    const hit = (cm, id) => Object.values(cm.edgeCoords).some(pts => labelHitsRoute(cm.nodeLabels[id], pts));
    const movedIds = Object.keys(on.coordMap.nodeLabels)
      .filter(id => JSON.stringify(on.coordMap.nodeLabels[id]) !== JSON.stringify(off.coordMap.nodeLabels[id]));
    expect(movedIds.some(id => hit(off.coordMap, id) && !hit(on.coordMap, id))).toBe(true);
  });

  // Every top-level fixture, switch on alone (bend rule explicitly off — it is on by default) and
  // with the bend rule: a moved label is one of its candidates and free — no route through it, no
  // shape, no other label under it. A label left at its default is no worse than without the pass,
  // by construction.
  for (const extra of [{ bendRule: false }, { bendRule: true }]) {
    test(`every fixture (nodeLabelsAvoidFlows${extra.bendRule ? ' + bendRule' : ' alone'}): moved labels land on free candidates`, async () => {
      for (const f of FIXTURES) {
        const lc = load(f);
        const r = await runPipeline(lc, { nodeLabelsAvoidFlows: true, ...extra });
        if (!r.coordMap) continue;
        const cm = r.coordMap;
        const defaults = placeNodeLabels(cm.coords, lc);
        const nodes = (lc.pools || [lc]).flatMap(p => p.nodes || []).flatMap(function all(n) { return [n, ...(n.nodes || []).flatMap(all)]; });
        for (const [id, L] of Object.entries(cm.nodeLabels)) {
          if (JSON.stringify(L) === JSON.stringify(defaults[id])) continue;
          const node = nodes.find(n => n.id === id);
          const side = nodeLabelCandidates(node, cm.coords[id]).find(k => JSON.stringify(k.box) === JSON.stringify(L))?.side;
          expect(`${f} ${id}: ${side}`).toMatch(/: (above|right-below|left-below)$/);
          expect(`${f} ${id}: ${Object.entries(cm.edgeCoords).filter(([, pts]) => labelHitsRoute(L, pts)).map(([k]) => k)}`).toBe(`${f} ${id}: `);
          const over = (b) => L.x < b.x + b.w && b.x < L.x + L.w && L.y < b.y + b.h && b.y < L.y + L.h;
          const labels = [...Object.entries(cm.nodeLabels).filter(([k]) => k !== id).map(([k, b]) => [k, b]),
            ...Object.entries(cm.edgeLabels).map(([k, b]) => [k, edgeLabelBox(b)])];
          expect(`${f} ${id}: ${labels.filter(([, b]) => over(b)).map(([k]) => k)}`).toBe(`${f} ${id}: `);
        }
      }
    }, 120000);
  }
});
