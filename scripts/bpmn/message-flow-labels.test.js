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
import { repairMessageFlowLabels, placeEdgeLabel, edgeLabelBox, labelHitsRoute, participantHeaders } from './coordinates.js';
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
    test(`${name}: a fixed point of the pass; no node label on a message-flow label`, async () => {
      const lc = load(name);
      const r = await runPipeline(lc, {});
      if (!r.coordMap) return;      // blocked on purpose (deadlock-process)
      expect(repairMessageFlowLabels(r.coordMap, lc)).toBe(r.coordMap.edgeLabels);
      for (const mf of lc.messageFlows || []) {
        const L = r.coordMap.edgeLabels[mf.id];
        if (!L) continue;
        const hits = Object.entries(r.coordMap.nodeLabels).filter(([, b]) => overlap(edgeLabelBox(L), b)).map(([id]) => id);
        expect(`${mf.id}: ${hits.join(',')}`).toBe(`${mf.id}: `);
      }
    }, 30000);
  }
});
