/**
 * Fence for repairMessageFlowLabels (coordinates.js, `layout.messageFlowLabelRepair`, #88): a
 * message-flow label that overlaps another label, a route, a shape, a node label, a participant
 * header or a lane separator moves beside one of its own segments, after routeMessageFlows. Two parts:
 *  - the pass on hand-built geometry: what moves, where to, and what never moves;
 *  - the pass in the pipeline: realistic-collaboration's mf2/mf5 ("Assessment request" /
 *    "Assessment report") no longer overlap, and every fixture is a fixed point of the pass.
 * The renderers' agreement with a moved box is fenced in pipeline.test.js ("geometry contract — the
 * two renderers agree": every edge label in the DI is coordMap's, the SVG draws its lines there).
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repairMessageFlowLabels, growParticipantGapsForLabels, unclearMessageFlowLabels, routeMessageFlows, placeEdgeLabel, edgeLabelBox, labelHitsRoute, participantHeaders, participantOutlines } from './coordinates.js';
import { runPipeline } from './pipeline.js';
import { CFG } from '../shared/utils.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const FIXTURES = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort();
const load = (name) => JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'));
const P = (x, y) => ({ x, y });
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const gap = CFG.layout.edgeLabelGap;

// Two participants, 100 px apart, and two message flows fanned 14 px apart in the corridor between
// them — the realistic-collaboration mf2/mf5 shape. Both labels sit above their corridor leg at its
// midpoint: two lines high, the lower one reaches over the upper flow's line and into its label.
const fanned = () => {
  const lc = {
    pools: [
      { id: 'A', name: 'A', nodes: [{ id: 'a1', type: 'task', name: 'Send' }, { id: 'a2', type: 'task', name: 'Receive' }], edges: [] },
      { id: 'B', name: 'B', nodes: [{ id: 'b1', type: 'task', name: 'Receive' }, { id: 'b2', type: 'task', name: 'Send' }], edges: [] },
    ],
    messageFlows: [
      { id: 'req', source: 'a1', target: 'b1', name: 'Assessment request' },
      { id: 'rep', source: 'b2', target: 'a2', name: 'Assessment report' },
    ],
  };
  const edgeCoords = {
    req: [P(600, 80), P(600, 143), P(100, 143), P(100, 220)],
    rep: [P(630, 220), P(630, 157), P(130, 157), P(130, 80)],
  };
  const label = (k, text) => placeEdgeLabel(text, edgeCoords[k], { preferred: [edgeCoords[k][1], edgeCoords[k][2]] });
  const cm = {
    coords: { a1: { x: 550, y: 0, w: 100, h: 80 }, a2: { x: 80, y: 0, w: 100, h: 80 },
      b1: { x: 50, y: 220, w: 100, h: 80 }, b2: { x: 580, y: 220, w: 100, h: 80 } },
    poolCoords: { A: { x: 0, y: -20, w: 800, h: 120, laneHeaderWidth: 30 }, B: { x: 0, y: 200, w: 800, h: 120, laneHeaderWidth: 30 } },
    laneCoords: {},
    edgeCoords,
    edgeLabels: { req: label('req', 'Assessment request'), rep: label('rep', 'Assessment report') },
    nodeLabels: {},
  };
  return { lc, cm };
};

describe('repairMessageFlowLabels on hand-built geometry', () => {
  test('the premise: two fanned message-flow labels overlap, and the lower one lies on the upper flow', () => {
    const { cm } = fanned();
    const req = edgeLabelBox(cm.edgeLabels.req), rep = edgeLabelBox(cm.edgeLabels.rep);
    expect(overlap(req, rep)).toBe(true);
    expect(labelHitsRoute(rep, cm.edgeCoords.req)).toBe(true);
  });

  test('the label on the other flow moves below its own leg, the gap clear; the other one stays', () => {
    const { lc, cm } = fanned();
    const out = repairMessageFlowLabels(cm, lc);
    expect(out).not.toBe(cm.edgeLabels);
    expect(out.req).toBe(cm.edgeLabels.req);
    const rep = edgeLabelBox(out.rep);
    expect(out.rep.side).toBe('below');
    expect(rep.y).toBe(157 + gap);                       // beside its own corridor leg, layout.edgeLabelGap below
    expect(out.rep.x).toBe(cm.edgeLabels.rep.x);         // at the same point along it
    expect(overlap(rep, edgeLabelBox(out.req))).toBe(false);
    for (const pts of Object.values(cm.edgeCoords)) expect(labelHitsRoute(rep, pts)).toBe(false);
    expect({ text: out.rep.text, lines: out.rep.lines, w: out.rep.w, h: out.rep.h })
      .toEqual({ text: cm.edgeLabels.rep.text, lines: cm.edgeLabels.rep.lines, w: cm.edgeLabels.rep.w, h: cm.edgeLabels.rep.h });
  });

  test('idempotent: a second run moves nothing and hands back the same object', () => {
    const { lc, cm } = fanned();
    const once = repairMessageFlowLabels(cm, lc);
    expect(repairMessageFlowLabels({ ...cm, edgeLabels: once }, lc)).toBe(once);
  });

  test('deterministic: the same input gives the same boxes', () => {
    const a = fanned(), b = fanned();
    expect(repairMessageFlowLabels(a.cm, a.lc)).toEqual(repairMessageFlowLabels(b.cm, b.lc));
  });

  test('pure: the coordMap it reads is not changed', () => {
    const { lc, cm } = fanned();
    const before = JSON.stringify(cm);
    repairMessageFlowLabels(cm, lc);
    expect(JSON.stringify(cm)).toBe(before);
  });

  test('a node label and a sequence-flow label are obstacles, never moved', () => {
    const { lc, cm } = fanned();
    // A sequence-flow label and a node label where "below" would put the repaired label.
    lc.pools[1].edges = [{ id: 'sf', source: 'b1', target: 'b2', label: 'x' }];
    cm.edgeLabels.sf = { text: 'x', x: 380, y: 175, w: 40, h: 14, side: 'above' };
    cm.nodeLabels = { e1: { x: 330, y: 162, w: 30, h: 14, lines: ['e'] } };
    const out = repairMessageFlowLabels(cm, lc);
    expect(out.sf).toBe(cm.edgeLabels.sf);
    const rep = edgeLabelBox(out.rep);
    expect(overlap(rep, edgeLabelBox(cm.edgeLabels.sf))).toBe(false);
    expect(overlap(rep, cm.nodeLabels.e1)).toBe(false);
    expect(overlap(rep, edgeLabelBox(out.req))).toBe(false);
    for (const pts of Object.values(cm.edgeCoords)) expect(labelHitsRoute(rep, pts)).toBe(false);
  });

  test('participant headers are obstacles: a pool header strip, a lane header, a black box whole', () => {
    const lc = { pools: [{ id: 'A', lanes: [{ id: 'L1' }, { id: 'L2' }], nodes: [] }], collapsedPools: [{ id: 'X' }] };
    const cm = { poolCoords: { A: { x: 0, y: 0, w: 500, h: 200, laneHeaderWidth: 30 }, X: { x: 0, y: 300, w: 600, h: 60 } },
      laneCoords: { L1: { x: 30, y: 0, w: 470, h: 100 }, L2: { x: 30, y: 100, w: 470, h: 100 } } };
    expect(participantHeaders(cm, lc)).toEqual([
      { x: 0, y: 0, w: 30, h: 200 }, { x: 30, y: 0, w: 30, h: 100 }, { x: 30, y: 100, w: 30, h: 100 },
      { x: 0, y: 300, w: 600, h: 60 },
    ]);
  });

  test('a label with no clear candidate stays where it is', () => {
    const { lc, cm } = fanned();
    // Shapes over every spot beside both of rep's legs: nothing is clear, so nothing moves.
    cm.coords.wall = { x: -100, y: 60, w: 900, h: 200 };
    const out = repairMessageFlowLabels(cm, lc);
    expect(out.rep).toBe(cm.edgeLabels.rep);
    expect(out.req).toBe(cm.edgeLabels.req);
  });

  test('without message flows, or without labels, it hands back edgeLabels itself', () => {
    const { lc, cm } = fanned();
    expect(repairMessageFlowLabels(cm, { ...lc, messageFlows: [] })).toBe(cm.edgeLabels);
    const unnamed = { ...lc, messageFlows: lc.messageFlows.map(({ name, ...mf }) => mf) };
    expect(repairMessageFlowLabels({ ...cm, edgeLabels: {} }, unnamed)).toEqual({});
  });
});

describe('participant outlines and the move bound', () => {
  test('participantOutlines: top and bottom edge of every drawn participant box', () => {
    const lc = { pools: [{ id: 'A', lanes: [{ id: 'L1' }], nodes: [] }, { id: 'B', nodes: [] }], collapsedPools: [{ id: 'X' }] };
    const cm = { poolCoords: { A: { x: 0, y: 0, w: 500, h: 100, laneHeaderWidth: 30 }, B: { x: 0, y: 160, w: 500, h: 80 }, X: { x: 0, y: 300, w: 600, h: 60 } },
      laneCoords: { L1: { x: 30, y: 0, w: 470, h: 100 } } };
    expect(participantOutlines(cm, lc)).toEqual([
      { y: 0, x0: 0, x1: 500 }, { y: 100, x0: 0, x1: 500 },
      { y: 160, x0: 0, x1: 500 }, { y: 240, x0: 0, x1: 500 },
      { y: 300, x0: 0, x1: 600 }, { y: 360, x0: 0, x1: 600 }]);
  });

  test('a label across a participant outline moves off it, beside its own leg', () => {
    const lc = { pools: [{ id: 'A', nodes: [{ id: 'a', type: 'task' }] }, { id: 'B', nodes: [{ id: 'b', type: 'task' }] }],
      messageFlows: [{ id: 'm', source: 'a', target: 'b', name: 'Assessment request' }] };
    const route = [P(300, 100), P(300, 150), P(100, 150), P(100, 200)];
    const cm = {
      coords: { a: { x: 250, y: 20, w: 100, h: 80 }, b: { x: 50, y: 200, w: 100, h: 80 } },
      // A's bottom edge at 130 runs through the label above the corridor leg at 150.
      poolCoords: { A: { x: 0, y: 0, w: 500, h: 130 }, B: { x: 0, y: 190, w: 500, h: 110 } },
      laneCoords: {}, nodeLabels: {}, edgeCoords: { m: route },
      edgeLabels: { m: placeEdgeLabel('Assessment request', route, { preferred: [route[1], route[2]] }) },
    };
    expect(unclearMessageFlowLabels(cm, lc)).toEqual(['m']);
    const out = repairMessageFlowLabels(cm, lc);
    const m = edgeLabelBox(out.m);
    expect(out.m.side).toBe('below');
    expect(m.y).toBe(150 + gap);
    for (const L of participantOutlines(cm, lc)) expect(m.y < L.y && L.y < m.y + m.h && m.x < L.x1 && L.x0 < m.x + m.w).toBe(false);
  });

  describe(`clearance: lines and shapes keep layout.messageFlowLabelClearancePx (${CFG.layout.messageFlowLabelClearancePx} px) off a label`, () => {
    const clr = CFG.layout.messageFlowLabelClearancePx;
    // One message flow between two participants 100 px apart; its label above the corridor leg at 150.
    const setup = (otherY) => {
      const lc = { pools: [{ id: 'A', nodes: [{ id: 'a', type: 'task' }] }, { id: 'B', nodes: [{ id: 'b', type: 'task' }] }],
        messageFlows: [{ id: 'm', source: 'a', target: 'b', name: 'Assessment request' }] };
      const route = [P(300, 100), P(300, 150), P(100, 150), P(100, 200)];
      const L = placeEdgeLabel('Assessment request', route, { preferred: [route[1], route[2]] });
      const top = edgeLabelBox(L).y;
      const cm = {
        coords: { a: { x: 250, y: 20, w: 100, h: 80 }, b: { x: 50, y: 200, w: 100, h: 80 } },
        poolCoords: { A: { x: 0, y: 0, w: 500, h: 100 }, B: { x: 0, y: 200, w: 500, h: 100 } },
        laneCoords: {}, nodeLabels: {},
        // A foreign line `otherY` px above the label's top edge, across it.
        edgeCoords: { m: route, other: [P(150, top - otherY), P(260, top - otherY)] },
        edgeLabels: { m: L },
      };
      return { lc, cm };
    };
    test('a foreign line closer than the clearance (but not touching) makes the label move', () => {
      const { lc, cm } = setup(clr / 2);
      expect(unclearMessageFlowLabels(cm, lc)).toEqual(['m']);
      const out = repairMessageFlowLabels(cm, lc);
      expect(out.m).not.toBe(cm.edgeLabels.m);
      expect(unclearMessageFlowLabels({ ...cm, edgeLabels: out }, lc)).toEqual([]);
    });
    test('a foreign line exactly the clearance away is fine; the own leg at layout.edgeLabelGap is too', () => {
      const { lc, cm } = setup(clr);
      expect(unclearMessageFlowLabels(cm, lc)).toEqual([]);
      expect(repairMessageFlowLabels(cm, lc)).toBe(cm.edgeLabels);
    });
    test('a shape closer than the clearance counts as in the way', () => {
      const { lc, cm } = setup(50);
      const b = edgeLabelBox(cm.edgeLabels.m);
      cm.coords.near = { x: b.x + b.w + clr / 2, y: b.y, w: 40, h: b.h };
      expect(unclearMessageFlowLabels(cm, lc)).toEqual(['m']);
      cm.coords.near = { ...cm.coords.near, x: b.x + b.w + clr };
      expect(unclearMessageFlowLabels(cm, lc)).toEqual([]);
    });
  });

  test(`no candidate farther than layout.messageFlowLabelMaxMovePx (${CFG.layout.messageFlowLabelMaxMovePx} px): the label stays`, () => {
    const { lc, cm } = fanned();
    // A wall over everything within reach of rep's label; the far end of its legs is free but out of range.
    const reach = CFG.layout.messageFlowLabelMaxMovePx;
    cm.coords.wall = { x: cm.edgeLabels.rep.x - reach - 60, y: 60, w: 2 * reach + 120, h: 200 };
    const out = repairMessageFlowLabels(cm, lc);
    expect(out.rep).toBe(cm.edgeLabels.rep);
  });
});

// Two participants only 30 px apart and two fanned message flows with two-line labels: neither
// side of either corridor leg has room, and every vertical leg is inside a participant.
const narrow = () => {
  const lc = {
    pools: [
      { id: 'A', name: 'A', nodes: [{ id: 'a1', type: 'task', name: 'Send' }, { id: 'a2', type: 'task', name: 'Receive' }], edges: [] },
      { id: 'B', name: 'B', nodes: [{ id: 'b1', type: 'task', name: 'Receive' }, { id: 'b2', type: 'task', name: 'Send' },
        { id: 'b3', type: 'task', name: 'Next' }], edges: [{ id: 'bf', source: 'b1', target: 'b3' }] },
    ],
    messageFlows: [
      { id: 'req', source: 'a1', target: 'b1', name: 'Assessment request' },
      { id: 'rep', source: 'b2', target: 'a2', name: 'Assessment report' },
    ],
  };
  const cm = {
    coords: { a1: { x: 550, y: 20, w: 100, h: 60 }, a2: { x: 80, y: 20, w: 100, h: 60 },
      b1: { x: 50, y: 150, w: 100, h: 60 }, b2: { x: 580, y: 150, w: 100, h: 60 }, b3: { x: 300, y: 150, w: 100, h: 60 } },
    poolCoords: { A: { x: 0, y: 0, w: 800, h: 100, laneHeaderWidth: 30 }, B: { x: 0, y: 130, w: 800, h: 100, laneHeaderWidth: 30 } },
    laneCoords: {},
    edgeCoords: { bf: [P(150, 180), P(300, 180)] },
    edgeLabels: {},
    nodeLabels: {},
  };
  routeMessageFlows(cm, lc);
  cm.edgeLabels = repairMessageFlowLabels(cm, lc);
  return { lc, cm };
};

describe('growParticipantGapsForLabels', () => {
  test('the premise: in a 30 px gap the repaired labels are still not clear', () => {
    const { lc, cm } = narrow();
    expect(unclearMessageFlowLabels(cm, lc).length).toBeGreaterThan(0);
  });

  test('grows the gap, moves the participant below rigidly, routes and repairs again: every label clear', () => {
    const { lc, cm } = narrow();
    const before = JSON.parse(JSON.stringify(cm));
    const grown = growParticipantGapsForLabels(cm, lc);
    expect(grown.length).toBeGreaterThan(0);
    expect(unclearMessageFlowLabels(cm, lc)).toEqual([]);
    const d = cm.poolCoords.B.y - before.poolCoords.B.y;
    expect(d).toBe(grown.reduce((t, g) => t + g.px, 0));
    expect(d).toBeLessThanOrEqual(CFG.layout.messageFlowLabelMaxGapGrowthPx);
    expect(cm.poolCoords.A).toEqual(before.poolCoords.A);
    for (const id of ['b1', 'b2', 'b3']) expect(cm.coords[id]).toEqual({ ...before.coords[id], y: before.coords[id].y + d });
    for (const id of ['a1', 'a2']) expect(cm.coords[id]).toEqual(before.coords[id]);
    expect(cm.edgeCoords.bf).toEqual(before.edgeCoords.bf.map(p => ({ ...p, y: p.y + d })));
    // Message flows were routed again: they end on the moved participant.
    expect(cm.edgeCoords.req.at(-1).y).toBe(cm.coords.b1.y);
  });

  test('idempotent: on its own result it grows nothing and moves nothing', () => {
    const { lc, cm } = narrow();
    growParticipantGapsForLabels(cm, lc);
    const once = JSON.stringify(cm);
    expect(growParticipantGapsForLabels(cm, lc)).toEqual([]);
    expect(JSON.stringify(cm)).toBe(once);
    expect(repairMessageFlowLabels(cm, lc)).toBe(cm.edgeLabels);
  });

  test('a single process has no gap: nothing happens', () => {
    const lc = { id: 'P', nodes: [], edges: [], messageFlows: [] };
    const cm = { coords: {}, poolCoords: {}, laneCoords: {}, edgeCoords: {}, edgeLabels: {}, nodeLabels: {} };
    expect(growParticipantGapsForLabels(cm, lc)).toEqual([]);
  });
});

describe('repairMessageFlowLabels in the pipeline', () => {
  const MODES = { default: {}, off: { visualRefinement: false }, on: { visualRefinement: true, elkWrapping: 'auto' } };
  for (const [mode, opts] of Object.entries(MODES)) {
    test(`realistic-collaboration ${mode}: mf2 "Assessment request" and mf5 "Assessment report" no longer overlap`, async () => {
      const r = await runPipeline(load('realistic-collaboration.json'), opts);
      const { mf2, mf5 } = r.coordMap.edgeLabels;
      expect(overlap(edgeLabelBox(mf2), edgeLabelBox(mf5))).toBe(false);
      expect(labelHitsRoute(edgeLabelBox(mf5), r.coordMap.edgeCoords.mf2)).toBe(false);
      expect(labelHitsRoute(edgeLabelBox(mf2), r.coordMap.edgeCoords.mf5)).toBe(false);
      // Switched off, the overlap #88 reported is back: the pass is what removes it.
      const without = await runPipeline(load('realistic-collaboration.json'), { ...opts, messageFlowLabelRepair: false });
      expect(overlap(edgeLabelBox(without.coordMap.edgeLabels.mf2), edgeLabelBox(without.coordMap.edgeLabels.mf5))).toBe(true);
    }, 30000);
  }

  test('switched off, only message-flow labels differ from the default output', async () => {
    const lc = load('realistic-collaboration.json');
    const on = await runPipeline(lc, {});
    const off = await runPipeline(lc, { messageFlowLabelRepair: false });
    const mf = new Set(lc.messageFlows.map(m => m.id));
    for (const [id, L] of Object.entries(on.coordMap.edgeLabels)) if (!mf.has(id)) expect(off.coordMap.edgeLabels[id]).toEqual(L);
    expect(off.coordMap.edgeCoords).toEqual(on.coordMap.edgeCoords);
    expect(off.coordMap.coords).toEqual(on.coordMap.coords);
  }, 30000);

  // Every top-level fixture is a fixed point: the pipeline's labels are what a second run returns.
  // And no node label sits on a message-flow label afterwards — node-label avoidance runs after the
  // repair and treats every edge label as an obstacle, so it cannot undo it.
  for (const name of FIXTURES) {
    test(`${name}: a fixed point of the pass, every message-flow label clear, no node label on one`, async () => {
      const lc = load(name);
      const r = await runPipeline(lc, {});
      if (!r.coordMap) return;      // blocked on purpose (deadlock-process)
      expect(repairMessageFlowLabels(r.coordMap, lc)).toBe(r.coordMap.edgeLabels);
      // Measured over every fixture: no message-flow label is left unclear (#88).
      expect(unclearMessageFlowLabels(r.coordMap, lc)).toEqual([]);
      for (const mf of lc.messageFlows || []) {
        const L = r.coordMap.edgeLabels[mf.id];
        if (!L) continue;
        const hits = Object.entries(r.coordMap.nodeLabels).filter(([, b]) => overlap(edgeLabelBox(L), b)).map(([id]) => id);
        expect(`${mf.id}: ${hits.join(',')}`).toBe(`${mf.id}: `);
      }
    }, 30000);
  }
});
