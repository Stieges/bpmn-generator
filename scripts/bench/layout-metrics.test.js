/**
 * Fence for the layout metrics. Two halves:
 *  - unit tests for each pure measure, on hand-built geometry;
 *  - an exact-value ratchet over every top-level fixture × both refinement modes.
 * A rise in the ratchet is a regression. A fall means a fix landed: lower the row in the same
 * commit and name the edges in the message — a stale budget would hide the next regression.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIXTURES, ALONG_MIN_PX, alongSide, edgeEndsAlongBorder, laneGaps,
  messageFlowThroughNodes, seqFlowThroughNodes, seqThroughOwnShape, edgeLabelHits, LABEL_DISTANCE_TOLERANCE_PX, measureLayout, summarize,
  summarizeDirection,
} from './layout-metrics.mjs';
import { flowMetrics, LANE_LINE_HUG_PX, sideRuleMetrics } from './flow-metrics.mjs';
import { CFG } from '../shared/utils.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const load = (name) => JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'));
// default / off / on run with the shipped defaults, which include layout.bendRule and
// layout.nodeLabelsAvoidFlows (both on since 4.0.0). plain / plain-on: default resp. on with both
// switches explicitly off — what default and on were before the bend rule; their rows are the
// former default and on rows, kept verbatim so the pre-switch geometry stays fenced.
const PLAIN = { bendRule: false, nodeLabelsAvoidFlows: false };
const MODES = { default: {}, off: { visualRefinement: false }, on: { visualRefinement: true, elkWrapping: 'auto' },
  plain: PLAIN, 'plain-on': { ...PLAIN, visualRefinement: true, elkWrapping: 'auto' } };

describe('sideRuleMetrics (Miragon flow-connection-side policy)', () => {
  const lc = { id: 'p', nodes: [
    { id: 'a', type: 'task' }, { id: 'b', type: 'task' }, { id: 'g', type: 'exclusiveGateway' }, { id: 'e', type: 'endEvent' },
  ], edges: [] };
  const coords = { a: { x: 0, y: 0, w: 100, h: 80 }, b: { x: 300, y: 0, w: 100, h: 80 },
    g: { x: 300, y: 200, w: 50, h: 50 }, e: { x: 600, y: 22, w: 36, h: 36 } };
  const run = (edges, edgeCoords) => sideRuleMetrics({ coords, edgeCoords }, { ...lc, edges });
  test('forward: leave right, enter left; a top entry and an odd bend count are reported', () => {
    const ok = run([{ id: 'f', source: 'a', target: 'b' }], { f: [{ x: 100, y: 40 }, { x: 300, y: 40 }] });
    expect(ok).toEqual({ wrongExit: [], wrongEntry: [], oddBends: [] });
    const bad = run([{ id: 'f', source: 'a', target: 'b' }], { f: [{ x: 100, y: 40 }, { x: 350, y: 40 }, { x: 350, y: 0 }] });
    expect(bad).toEqual({ wrongExit: [], wrongEntry: ['f'], oddBends: ['f'] });
  });
  test('return flow: re-enter the target from the right, the initiating activity leaves right', () => {
    const uTurn = [{ x: 400, y: 40 }, { x: 420, y: 40 }, { x: 420, y: 120 }, { x: 120, y: 120 }, { x: 120, y: 40 }, { x: 100, y: 40 }];
    expect(run([{ id: 'r', source: 'b', target: 'a' }], { r: uTurn })).toEqual({ wrongExit: [], wrongEntry: [], oddBends: [] });
    const leftIn = [{ x: 400, y: 40 }, { x: 420, y: 40 }, { x: 420, y: 120 }, { x: -20, y: 120 }, { x: -20, y: 40 }, { x: 0, y: 40 }];
    expect(run([{ id: 'r', source: 'b', target: 'a' }], { r: leftIn }).wrongEntry).toEqual(['r']);
  });
  test('gateways are judged by their own policy: a forward exit by the left tip is wrong', () => {
    const m = run([{ id: 'x', source: 'g', target: 'e' }], { x: [{ x: 300, y: 225 }, { x: 280, y: 225 }, { x: 280, y: 300 }, { x: 618, y: 300 }, { x: 618, y: 58 }] });
    expect(m.wrongExit).toEqual(['x']);
    expect(m.oddBends).toEqual([]);   // a gateway end is free of the parity check
  });
});

describe('alongSide', () => {
  const box = { x: 386, y: 131, w: 100, h: 80 };
  test("#52 Flow_8: the last segment runs 39 px down the target's left side", () => {
    expect(alongSide([{ x: 386, y: 132 }, { x: 386, y: 171 }], box)).toEqual({ side: 'left', length: 39 });
  });
  test('a perpendicular arrival overlaps nothing', () => {
    expect(alongSide([{ x: 356, y: 171 }, { x: 386, y: 171 }], box).length).toBe(0);
  });
  test('collinear within 1 px counts, 2 px off does not', () => {
    expect(alongSide([{ x: 387, y: 140 }, { x: 387, y: 180 }], box)).toEqual({ side: 'left', length: 40 });
    expect(alongSide([{ x: 388, y: 140 }, { x: 388, y: 180 }], box).length).toBe(0);
  });
});

describe('edgeEndsAlongBorder', () => {
  const coords = { a: { x: 0, y: 0, w: 100, h: 80 }, b: { x: 200, y: 100, w: 100, h: 80 } };
  const edges = [{ id: 'e', source: 'a', target: 'b' }];
  test('reports both ends with side and length', () => {
    const edgeCoords = { e: [{ x: 50, y: 80 }, { x: 200, y: 80 }, { x: 200, y: 140 }] };
    expect(edgeEndsAlongBorder(coords, edgeCoords, edges)).toEqual([
      { edge: 'e', end: 'source', node: 'a', side: 'bottom', length: 50 },
      { edge: 'e', end: 'target', node: 'b', side: 'left', length: 40 },
    ]);
  });
  test(`an overlap of exactly ${ALONG_MIN_PX} px hides under the arrowhead and is not reported`, () => {
    const edgeCoords = { e: [{ x: 100, y: 40 }, { x: 200, y: 40 }, { x: 200, y: 105 }] };
    expect(edgeEndsAlongBorder(coords, edgeCoords, edges)).toEqual([]);
  });
});

describe('laneGaps', () => {
  const lc = { pools: [{ id: 'P', lanes: [{ id: 'L1' }, { id: 'L2' }], nodes: [], edges: [] }] };
  test('a strip between two bands', () => {
    const cm = {
      poolCoords: { P: { x: 0, y: 0, w: 500, h: 300 } },
      laneCoords: { L1: { x: 30, y: 0, w: 470, h: 120 }, L2: { x: 30, y: 160, w: 470, h: 140 } },
    };
    expect(laneGaps(cm, lc)).toEqual([{ participant: 'P', above: 'L1', below: 'L2', gap: 40 }]);
  });
  test('a strip between the participant edge and the band stack', () => {
    const cm = {
      poolCoords: { P: { x: 0, y: 0, w: 500, h: 300 } },
      laneCoords: { L1: { x: 30, y: 10, w: 470, h: 150 }, L2: { x: 30, y: 160, w: 470, h: 140 } },
    };
    expect(laneGaps(cm, lc)).toEqual([{ participant: 'P', above: null, below: 'L1', gap: 10 }]);
  });
});

describe('messageFlowThroughNodes', () => {
  test('a shape of an uninvolved participant counts; a group and the endpoint container do not', () => {
    const cm = {
      coords: {
        s: { x: 0, y: 0, w: 100, h: 80 },
        mid: { x: 20, y: 200, w: 100, h: 80 },
        grp: { x: -20, y: 150, w: 200, h: 200 },
        sub: { x: -10, y: 380, w: 130, h: 120 },
        t: { x: 0, y: 400, w: 100, h: 80 },
      },
      edgeCoords: { mf: [{ x: 50, y: 80 }, { x: 50, y: 400 }] },
    };
    const lc = {
      pools: [
        { id: 'A', nodes: [{ id: 's', type: 'userTask' }] },
        { id: 'B', nodes: [{ id: 'mid', type: 'userTask' }, { id: 'grp', type: 'group' }] },
        { id: 'C', nodes: [{ id: 'sub', type: 'subProcess', nodes: [{ id: 't', type: 'userTask' }] }] },
      ],
      messageFlows: [{ id: 'mf', source: 's', target: 't' }],
    };
    expect(messageFlowThroughNodes(cm, lc)).toEqual([{ flow: 'mf', node: 'mid', relation: 'uninvolved' }]);
  });
});

describe('seqFlowThroughNodes', () => {
  test('a foreign node counts; the expanded subprocess containing both ends does not', () => {
    const cm = {
      coords: {
        sub: { x: 0, y: 0, w: 600, h: 300 },
        a: { x: 20, y: 20, w: 100, h: 80 },
        x: { x: 200, y: 20, w: 100, h: 80 },
        b: { x: 400, y: 20, w: 100, h: 80 },
      },
      edgeCoords: { e: [{ x: 120, y: 60 }, { x: 400, y: 60 }] },
    };
    expect(seqFlowThroughNodes(cm, [{ id: 'e', source: 'a', target: 'b' }])).toEqual([{ edge: 'e', node: 'x' }]);
  });
});

describe('seqThroughOwnShape', () => {
  const lc = { pools: [{ id: 'P', nodes: [
    { id: 't', type: 'userTask' }, { id: 'g', type: 'exclusiveGateway' }, { id: 'e', type: 'endEvent' }] }] };
  const coords = {
    t: { x: 436, y: 1932, w: 100, h: 80 },
    g: { x: 436, y: 2151.5, w: 50, h: 50 },
    e: { x: 600, y: 2158.5, w: 36, h: 36 },
  };
  test("realistic-collaboration inf3: leaving the task's right side and running back through it", () => {
    const cm = { coords, edgeCoords: { inf3: [{ x: 536, y: 1959 }, { x: 436.5, y: 1959 }, { x: 436.5, y: 2177 }] } };
    expect(seqThroughOwnShape(cm, lc, [{ id: 'inf3', source: 't', target: 'g' }]))
      .toEqual([{ edge: 'inf3', end: 'source', node: 't' }]);
  });
  test("a diamond is tested as a diamond: a segment through its bounds' corner is not inside it", () => {
    // y = 2155 lies inside g's bounding box (2151.5–2201.5) but above the rhombus there.
    const cm = { coords, edgeCoords: { y: [{ x: 476, y: 2155 }, { x: 500, y: 2155 }] } };
    expect(seqThroughOwnShape(cm, lc, [{ id: 'y', source: 'g', target: 'e' }])).toEqual([]);
  });
  test('leaving outward is not "through"', () => {
    const cm = { coords, edgeCoords: { ok: [{ x: 536, y: 1972 }, { x: 600, y: 1972 }, { x: 600, y: 2158.5 }] } };
    expect(seqThroughOwnShape(cm, lc, [{ id: 'ok', source: 't', target: 'e' }])).toEqual([]);
  });
});

describe('edgeLabelHits', () => {
  const lc = { nodes: [{ id: 'sub', type: 'subProcess', isExpanded: true, nodes: [{ id: 'a' }] }, { id: 't' }] };
  const coords = { sub: { x: 0, y: 0, w: 400, h: 200 }, a: { x: 20, y: 20, w: 100, h: 80 }, t: { x: 500, y: 0, w: 100, h: 80 } };
  const label = (x, y) => ({ text: 'x', x, y, w: 40, h: 14 });
  test('a label across its own line counts; one beside it does not', () => {
    const edgeCoords = { e: [{ x: 120, y: 150 }, { x: 300, y: 150 }], f: [{ x: 120, y: 170 }, { x: 300, y: 170 }] };
    const hits = edgeLabelHits({ coords, edgeCoords, edgeLabels: { e: label(200, 150), f: label(200, 159) } }, lc);
    expect(hits.ownEdge).toEqual(['e']);
  });
  test('label pairs and label × node count; the container the label lies inside does not', () => {
    const edgeLabels = { e: label(200, 150), f: label(210, 152), g: label(110, 60) };
    const hits = edgeLabelHits({ coords, edgeCoords: {}, edgeLabels }, lc);
    expect(hits.labelLabel).toEqual(['e/f']);
    expect(hits.labelNode).toEqual(['g>a']);
  });
});

describe('edgeLabelHits — lane separators and distance to the own route', () => {
  const lc = { id: 'P', lanes: [{ id: 'A' }, { id: 'B' }], nodes: [], edges: [] };
  const laneCoords = { A: { x: 30, y: 0, w: 500, h: 120 }, B: { x: 30, y: 120, w: 500, h: 120 } };
  const route = { e: [{ x: 120, y: 150 }, { x: 300, y: 150 }] };
  const gap = CFG.layout?.edgeLabelGap ?? 4;
  const label = (x, y) => ({ text: 'x', x, y, w: 40, h: 14 });
  test('a label box across an inner lane line counts; one clear of it does not', () => {
    const across = edgeLabelHits({ coords: {}, laneCoords, edgeCoords: route, edgeLabels: { e: label(200, 121) } }, lc);
    expect(across.laneLine).toEqual(['e']);
    const clear = edgeLabelHits({ coords: {}, laneCoords, edgeCoords: route, edgeLabels: { e: label(200, 150 - gap - 7) } }, lc);
    expect(clear.laneLine).toEqual([]);
  });
  test('the outer edge of the first band is not a separator', () => {
    const top = edgeLabelHits({ coords: {}, laneCoords, edgeCoords: route, edgeLabels: { e: label(200, 0) } }, lc);
    expect(top.laneLine).toEqual([]);
  });
  test(`a label more than the configured gap + ${LABEL_DISTANCE_TOLERANCE_PX} px from its own route counts as far`, () => {
    const beside = edgeLabelHits({ coords: {}, laneCoords, edgeCoords: route, edgeLabels: { e: label(200, 150 - gap - 7) } }, lc);
    expect(beside.farFromEdge).toEqual([]);
    const far = edgeLabelHits({ coords: {}, laneCoords, edgeCoords: route, edgeLabels: { e: label(200, 150 - gap - 7 - 15) } }, lc);
    expect(far.farFromEdge).toEqual(['e']);
  });
});

describe('flowMetrics', () => {
  const lc = { id: 'P', lanes: [{ id: 'A' }, { id: 'B' }], nodes: [
    { id: 's', type: 'userTask', lane: 'A' }, { id: 't', type: 'userTask', lane: 'B' }],
    edges: [{ id: 'e', source: 's', target: 't' }] };
  const base = {
    coords: { s: { x: 100, y: 20, w: 100, h: 80 }, t: { x: 300, y: 140, w: 100, h: 80 } },
    laneCoords: { A: { x: 30, y: 0, w: 500, h: 120 }, B: { x: 30, y: 120, w: 500, h: 120 } },
    poolCoords: { _singlePool: { x: 0, y: 0, w: 530, h: 240 } },
  };
  test(`a horizontal leg within ${LANE_LINE_HUG_PX} px of an inner lane line counts its length as hug`, () => {
    const cm = { ...base, edgeCoords: { e: [{ x: 150, y: 100 }, { x: 150, y: 119 }, { x: 350, y: 119 }, { x: 350, y: 140 }] } };
    expect(flowMetrics(cm, lc).seq.laneLineHug).toBe(200);
  });
  test('a leg 10 px off the line does not', () => {
    const cm = { ...base, edgeCoords: { e: [{ x: 150, y: 100 }, { x: 150, y: 110 }, { x: 350, y: 110 }, { x: 350, y: 140 }] } };
    expect(flowMetrics(cm, lc).seq.laneLineHug).toBe(0);
  });
  test('bends count direction changes; a straight route has none', () => {
    const z = { ...base, edgeCoords: { e: [{ x: 150, y: 100 }, { x: 150, y: 110 }, { x: 350, y: 110 }, { x: 350, y: 140 }] } };
    expect(flowMetrics(z, lc).seq.bendsMax).toBe(2);
    const straight = { ...base, edgeCoords: { e: [{ x: 150, y: 100 }, { x: 150, y: 140 }] } };
    expect(flowMetrics(straight, lc).seq.bendsMax).toBe(0);
  });
});

describe('flowMetrics — crowd, endpoint offset, message-flow crowd', () => {
  const four = { id: 'P', nodes: ['a', 'b', 'c', 'd'].map((id) => ({ id, type: 'userTask' })),
    edges: [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'c', target: 'd' }] };
  const crowdOf = (y2) => flowMetrics({ coords: {}, laneCoords: {}, poolCoords: {},
    edgeCoords: { e1: [{ x: 0, y: 100 }, { x: 200, y: 100 }], e2: [{ x: 50, y: y2 }, { x: 250, y: y2 }] } }, four).seq.crowd;
  test('crowd: two parallel legs of different edges 5 px apart overlapping 150 px are one pair', () => {
    expect(crowdOf(105)).toEqual({ pairs: 1, collinear: 0 });
  });
  test('crowd: collinear legs are counted as collinear; legs 20 px apart are not crowding', () => {
    expect(crowdOf(100)).toEqual({ pairs: 1, collinear: 1 });
    expect(crowdOf(120)).toEqual({ pairs: 0, collinear: 0 });
  });

  const one = { id: 'P', nodes: [{ id: 's', type: 'userTask' }, { id: 't', type: 'userTask' }], edges: [{ id: 'e', source: 's', target: 't' }] };
  const offOf = (x) => flowMetrics({ laneCoords: {}, poolCoords: {},
    coords: { s: { x: 100, y: 20, w: 100, h: 80 }, t: { x: 100, y: 200, w: 100, h: 80 } },
    edgeCoords: { e: [{ x, y: 100 }, { x, y: 200 }] } }, one).seq;
  test('offset: an end on a side midpoint is 0 px off; 20 px along the side is reported', () => {
    const centred = offOf(150);
    expect(centred.endOffMean).toBe(0);
    expect(centred.endOffOver5).toBe(0);
    const shifted = offOf(170);
    expect(shifted.endOffMean).toBe(20);
    expect(shifted.endOffOver5).toBe(2);
  });

  const collab = { pools: [
    { id: 'P1', nodes: [{ id: 'a1', type: 'userTask' }, { id: 'a2', type: 'userTask' }], edges: [] },
    { id: 'P2', nodes: [{ id: 'b1', type: 'userTask' }, { id: 'b2', type: 'userTask' }], edges: [] }],
    messageFlows: [{ id: 'm1', source: 'a1', target: 'b1' }, { id: 'm2', source: 'a2', target: 'b2' }] };
  const mfCrowdOf = (x2) => flowMetrics({ coords: {}, laneCoords: {}, poolCoords: {},
    edgeCoords: { m1: [{ x: 100, y: 0 }, { x: 100, y: 200 }], m2: [{ x: x2, y: 50 }, { x: x2, y: 250 }] } }, collab).mf.crowd;
  test('mfCrowd: two message flows 5 px apart are one message/message pair', () => {
    expect(mfCrowdOf(105)).toEqual({ pairs: 1, collinear: 0, mfmf: 1, mfseq: 0 });
  });
  test('mfCrowd: message flows 40 px apart do not crowd', () => {
    expect(mfCrowdOf(140)).toEqual({ pairs: 0, collinear: 0, mfmf: 0, mfseq: 0 });
  });
});

describe('flowMetrics — overlapLen (collinear overlap, px)', () => {
  // sparse-lanes f3 as the bend rule's first round left it: the flow leaving the join runs down
  // 2.5 px beside the flow entering it from below. Both touch the join — crowd skips that pair,
  // overlapLen does not.
  const lc = { id: 'P', nodes: [{ id: 'join', type: 'parallelGateway' }, { id: 'a4', type: 'task' }, { id: 'b1', type: 'task' }],
    edges: [{ id: 'f2d', source: 'a4', target: 'join' }, { id: 'f3', source: 'join', target: 'b1' }] };
  const of = (x) => flowMetrics({ coords: {}, laneCoords: {}, poolCoords: {}, edgeCoords: {
    f2d: [{ x: 471, y: 540 }, { x: 588.5, y: 540 }, { x: 588.5, y: 290 }],
    f3: [{ x: x, y: 292.5 }, { x: x, y: 700 }, { x: 696, y: 700 }] } }, lc);
  test(`legs closer than layout.bendRuleLimits.collinearPx (${CFG.layout.bendRuleLimits.collinearPx}) count with their overlap length`, () => {
    const m = of(591);
    expect(m.overlapLen).toBe(248); // 292.5–540, rounded
    expect(m.seq.crowd.pairs).toBe(0);
  });
  test('legs collinearPx apart or more do not', () => {
    expect(of(588.5 + CFG.layout.bendRuleLimits.collinearPx).overlapLen).toBe(0);
  });
  test('a message flow on top of a sequence flow counts too', () => {
    const collab = { pools: [{ id: 'A', nodes: [{ id: 'a', type: 'task' }, { id: 'b', type: 'task' }], edges: [{ id: 's', source: 'a', target: 'b' }] },
      { id: 'B', nodes: [{ id: 'c', type: 'task' }], edges: [] }], messageFlows: [{ id: 'm', source: 'a', target: 'c' }] };
    const m = flowMetrics({ coords: {}, laneCoords: {}, poolCoords: {}, edgeCoords: {
      s: [{ x: 100, y: 0 }, { x: 100, y: 200 }], m: [{ x: 101, y: 50 }, { x: 101, y: 400 }] } }, collab);
    expect(m.overlapLen).toBe(150);
  });
});

// Exact values per fixture × mode. Modes: default (no option), off (visualRefinement: false),
// on (every refinement pass + ELK wrapping — the .refined golden set). Keys: crossings
// (segment-pair crossings between non-adjacent sequence flows), along (#52 ends on their own
// outline > 5 px), laneGap (largest lane-stack strip, px), mfThrough (message flow × foreign
// shape), seqThrough (sequence flow × foreign node), ownThrough (sequence flow through its own
// source/target), hug (px of horizontal sequence-flow leg within 3 px of an inner lane line),
// bendsMax (most direction changes on one sequence flow), crowd / mfCrowd (parallel segment
// pairs of different edges closer than 10 px — sequence flows / message flows; two segments at a
// shared endpoint node do not count), offOver5 (flow ends more than 5 px from their side's
// midpoint; deliberate fanning counts too; a boundary event's start and a black-box end are
// excluded), labelOwnEdge (edge-label box reaching into its own route — must stay 0),
// labelLabel (edge-label box pairs overlapping), labelNode (edge-label box × node box),
// labelLaneLine (edge-label box across an inner lane separator — must stay 0), labelFar (edge-label
// box farther than layout.edgeLabelGap + LABEL_DISTANCE_TOLERANCE_PX from its own route — must stay 0),
// overlapLen (px two flows — sequence or message, a pair at a shared node included — run on top of
// each other: parallel legs closer than layout.bendRuleLimits.collinearPx; flow-metrics.mjs).
// null: the pipeline blocks the fixture on purpose.
const ZERO = { crossings: 0, along: 0, laneGap: 0, mfThrough: 0, seqThrough: 0, ownThrough: 0,
  hug: 0, bendsMax: 0, crowd: 0, mfCrowd: 0, offOver5: 0, labelOwnEdge: 0, labelLabel: 0, labelNode: 0,
  labelLaneLine: 0, labelFar: 0, overlapLen: 0 };
const r = (over = {}) => ({ ...ZERO, ...over });

// Re-measured 2026-11-25: feedback edges reversed for ELK, Miragon flow-connection-side's side
// policy in the bend rule and §5.2, and the serializer/align fixes (see CHANGELOG [Unreleased]).
// The rows before that, with their per-edge notes, are in git history.
const BUDGET = {
  'all-element-classes.json': {
    default: r({ bendsMax: 2, offOver5: 1 }),
    off: r({ bendsMax: 2, offOver5: 1 }),
    on: r({ bendsMax: 2, offOver5: 1 }),
    plain: r({ bendsMax: 2, offOver5: 1 }),
    'plain-on': r({ bendsMax: 2, offOver5: 1 }),
  },
  'artifacts-laneless-pool.json': {
    default: r(),
    off: r(),
    on: r(),
    plain: r(),
    'plain-on': r(),
  },
  'boundary-event-shapes.json': {
    default: r({ crossings: 1, bendsMax: 4, offOver5: 10 }),
    off: r({ crossings: 1, bendsMax: 4, offOver5: 10 }),
    on: r({ crossings: 1, bendsMax: 4, offOver5: 10 }),
    plain: r({ crossings: 1, bendsMax: 4, crowd: 1, offOver5: 7, overlapLen: 167 }),
    'plain-on': r({ crossings: 1, bendsMax: 4, crowd: 1, offOver5: 7, overlapLen: 167 }),
  },
  'bpmn-generator-pipeline.json': {
    default: r({ bendsMax: 4, mfCrowd: 2, offOver5: 8, overlapLen: 232 }),
    off: r({ bendsMax: 4, mfCrowd: 2, offOver5: 8, overlapLen: 243 }),
    on: r({ bendsMax: 4, mfCrowd: 2, offOver5: 10, overlapLen: 232 }),
    plain: r({ crossings: 1, bendsMax: 4, mfCrowd: 2, offOver5: 7, labelLabel: 1, labelFar: 1, overlapLen: 893 }),
    'plain-on': r({ crossings: 1, bendsMax: 4, crowd: 1, mfCrowd: 2, offOver5: 8, labelLabel: 1, labelFar: 1, overlapLen: 1576 }),
  },
  'cross-lane-connection-sides.json': {
    default: r({ bendsMax: 2, offOver5: 2 }),
    off: r({ bendsMax: 2, offOver5: 2 }),
    on: r({ bendsMax: 2, offOver5: 2 }),
    plain: r({ bendsMax: 2, offOver5: 2, labelFar: 1, overlapLen: 260 }),
    'plain-on': r({ bendsMax: 2, offOver5: 2, labelFar: 1, overlapLen: 260 }),
  },
  'deadlock-process.json': {
    default: null,
    off: null,
    on: null,
    plain: null,
    'plain-on': null,
  },
  'dense-edge-labels.json': {
    default: r({ crossings: 4, bendsMax: 2, labelFar: 1, overlapLen: 299 }),
    off: r({ crossings: 4, bendsMax: 2, labelLabel: 1, overlapLen: 299 }),
    on: r({ crossings: 4, bendsMax: 2, labelFar: 1, overlapLen: 299 }),
    plain: r({ crossings: 4, bendsMax: 2, crowd: 4, labelLabel: 6, labelFar: 1, overlapLen: 1424 }),
    'plain-on': r({ crossings: 4, bendsMax: 2, crowd: 4, labelLabel: 6, labelFar: 1, overlapLen: 1424 }),
  },
  'example-bestellung-versand.json': {
    default: r({ crossings: 1, bendsMax: 2, offOver5: 2, overlapLen: 123 }),
    off: r({ crossings: 1, bendsMax: 2, offOver5: 2, overlapLen: 123 }),
    on: r({ crossings: 1, bendsMax: 2, offOver5: 2, overlapLen: 123 }),
    plain: r({ crossings: 1, bendsMax: 2, offOver5: 2, overlapLen: 544 }),
    'plain-on': r({ crossings: 1, bendsMax: 2, offOver5: 2, overlapLen: 544 }),
  },
  'example-kreditantrag.json': {
    default: r({ bendsMax: 3, offOver5: 4, overlapLen: 62 }),
    off: r({ bendsMax: 3, offOver5: 4, overlapLen: 62 }),
    on: r({ bendsMax: 4, mfCrowd: 2, offOver5: 3, overlapLen: 294 }),
    plain: r({ bendsMax: 4, offOver5: 3, overlapLen: 362 }),
    'plain-on': r({ crossings: 1, bendsMax: 4, mfCrowd: 2, offOver5: 3, overlapLen: 791 }),
  },
  'example-onboarding.json': {
    default: r({ crossings: 2, bendsMax: 3, offOver5: 3, labelFar: 1, overlapLen: 412 }),
    off: r({ crossings: 2, bendsMax: 3, offOver5: 3, labelNode: 1, overlapLen: 444 }),
    on: r({ crossings: 2, bendsMax: 3, offOver5: 3, labelFar: 1, overlapLen: 412 }),
    plain: r({ crossings: 2, bendsMax: 4, offOver5: 4, overlapLen: 432 }),
    'plain-on': r({ crossings: 2, bendsMax: 4, offOver5: 4, overlapLen: 432 }),
  },
  'example-rechnungspruefung.json': {
    default: r({ crossings: 2, bendsMax: 3, offOver5: 6 }),
    off: r({ bendsMax: 4, offOver5: 6, overlapLen: 140 }),
    on: r({ crossings: 2, bendsMax: 3, offOver5: 6 }),
    plain: r({ crossings: 2, bendsMax: 4, offOver5: 5, overlapLen: 140 }),
    'plain-on': r({ crossings: 2, bendsMax: 4, offOver5: 5, overlapLen: 140 }),
  },
  'example-schadenmeldung.json': {
    default: r({ bendsMax: 3, offOver5: 2, overlapLen: 230 }),
    off: r({ bendsMax: 3, offOver5: 3, overlapLen: 242 }),
    on: r({ bendsMax: 3, offOver5: 2, overlapLen: 230 }),
    plain: r({ bendsMax: 4, offOver5: 2, overlapLen: 369 }),
    'plain-on': r({ bendsMax: 4, offOver5: 2, overlapLen: 369 }),
  },
  'example-urlaubsantrag.json': {
    default: r({ bendsMax: 3, offOver5: 2 }),
    off: r({ bendsMax: 3, offOver5: 3 }),
    on: r({ bendsMax: 3, offOver5: 2 }),
    plain: r({ bendsMax: 4, offOver5: 2 }),
    'plain-on': r({ bendsMax: 4, offOver5: 2 }),
  },
  'expanded-subprocess.json': {
    default: r(),
    off: r(),
    on: r(),
    plain: r(),
    'plain-on': r(),
  },
  'long-lane-names.json': {
    default: r({ bendsMax: 2 }),
    off: r({ bendsMax: 2 }),
    on: r({ bendsMax: 2 }),
    plain: r({ bendsMax: 2 }),
    'plain-on': r({ bendsMax: 2 }),
  },
  'loop-with-join.json': {
    default: r({ bendsMax: 3, offOver5: 1, overlapLen: 23 }),
    off: r({ bendsMax: 3, offOver5: 1, overlapLen: 23 }),
    on: r({ bendsMax: 3, offOver5: 1, overlapLen: 23 }),
    plain: r({ bendsMax: 4, overlapLen: 113 }),
    'plain-on': r({ bendsMax: 4, overlapLen: 113 }),
  },
  'message-flow-participant-ports.json': {
    default: r({ overlapLen: 62 }),
    off: r({ overlapLen: 62 }),
    on: r({ overlapLen: 62 }),
    plain: r({ overlapLen: 62 }),
    'plain-on': r({ overlapLen: 62 }),
  },
  'messageflow-to-subprocess.json': {
    default: r({ mfCrowd: 1, overlapLen: 83 }),
    off: r({ mfCrowd: 1, overlapLen: 83 }),
    on: r({ mfCrowd: 1, overlapLen: 83 }),
    plain: r({ mfCrowd: 1, overlapLen: 83 }),
    'plain-on': r({ mfCrowd: 1, overlapLen: 83 }),
  },
  'multi-pool-collaboration.json': {
    default: r({ bendsMax: 2 }),
    off: r({ bendsMax: 2 }),
    on: r({ bendsMax: 2 }),
    plain: r({ bendsMax: 2, overlapLen: 130 }),
    'plain-on': r({ bendsMax: 2, overlapLen: 130 }),
  },
  'parallel-split-join.json': {
    default: r({ bendsMax: 1, offOver5: 1 }),
    off: r({ bendsMax: 1, offOver5: 1 }),
    on: r({ bendsMax: 1, offOver5: 1 }),
    plain: r({ bendsMax: 2, overlapLen: 240 }),
    'plain-on': r({ bendsMax: 2, overlapLen: 240 }),
  },
  'realistic-collaboration.json': {
    default: r({ bendsMax: 2, overlapLen: 226 }),
    off: r({ bendsMax: 2, overlapLen: 356 }),
    on: r({ bendsMax: 4, mfCrowd: 4, offOver5: 1, overlapLen: 406 }),
    plain: r({ bendsMax: 2, overlapLen: 406 }),
    'plain-on': r({ crossings: 1, bendsMax: 4, mfCrowd: 4, overlapLen: 866 }),
  },
  'simple-approval.json': {
    default: r({ bendsMax: 3, offOver5: 2 }),
    off: r({ bendsMax: 3, offOver5: 3 }),
    on: r({ bendsMax: 3, offOver5: 2 }),
    plain: r({ bendsMax: 4, offOver5: 2, overlapLen: 70 }),
    'plain-on': r({ bendsMax: 4, offOver5: 2, overlapLen: 70 }),
  },
  'sparse-lanes.json': {
    default: r({ crossings: 1, bendsMax: 2, crowd: 1, overlapLen: 181 }),
    off: r({ crossings: 1, bendsMax: 2, crowd: 1, overlapLen: 181 }),
    on: r({ crossings: 1, bendsMax: 2, crowd: 1, overlapLen: 181 }),
    plain: r({ crossings: 1, bendsMax: 2, crowd: 3, overlapLen: 884 }),
    'plain-on': r({ crossings: 1, bendsMax: 2, crowd: 3, overlapLen: 884 }),
  },
  'subprocess-child-fidelity.json': {
    default: r({ bendsMax: 2, offOver5: 5 }),
    off: r({ bendsMax: 2, offOver5: 5 }),
    on: r({ bendsMax: 2, offOver5: 5 }),
    plain: r({ bendsMax: 2, offOver5: 5 }),
    'plain-on': r({ bendsMax: 2, offOver5: 5 }),
  },
  'subprocess-collapsed-children.json': {
    default: r(),
    off: r(),
    on: r(),
    plain: r(),
    'plain-on': r(),
  },
  'subprocess-merge-fanout.json': {
    default: r({ bendsMax: 2, offOver5: 6 }),
    off: r({ bendsMax: 2, offOver5: 6 }),
    on: r({ bendsMax: 2, offOver5: 6 }),
    plain: r({ bendsMax: 2, offOver5: 6, overlapLen: 140 }),
    'plain-on': r({ bendsMax: 2, offOver5: 6, overlapLen: 140 }),
  },
  'wide-pipeline.json': {
    default: r(),
    off: r(),
    on: r({ bendsMax: 4 }),
    plain: r(),
    'plain-on': r({ bendsMax: 4 }),
  },
  'wrapping-back-edge.json': {
    default: r({ bendsMax: 2, offOver5: 4 }),
    off: r({ bendsMax: 2, offOver5: 4 }),
    on: r({ bendsMax: 4, offOver5: 3 }),
    plain: r({ bendsMax: 4, offOver5: 3, overlapLen: 20 }),
    'plain-on': r({ bendsMax: 4, offOver5: 2, overlapLen: 20 }),
  },
};
const BUDGET_DEFAULT = BUDGET;

// avoidableBends, againstFlowEntries (bend-rule bendMetrics), then wrongExit, wrongEntry, oddBends
// (flow-metrics sideRuleMetrics — Miragon flow-connection-side's side policy).
const d = (avoidableBends, againstFlowEntries, wrongExit, wrongEntry, oddBends) =>
  ({ avoidableBends, againstFlowEntries, wrongExit, wrongEntry, oddBends });
const DIRECTION = {
  'all-element-classes.json': { default: d(0, 0, 0, 0, 0), off: d(0, 0, 0, 0, 0), on: d(0, 0, 0, 0, 0), plain: d(0, 0, 0, 0, 0), 'plain-on': d(0, 0, 0, 0, 0) },
  'artifacts-laneless-pool.json': { default: d(0, 0, 0, 0, 0), off: d(0, 0, 0, 0, 0), on: d(0, 0, 0, 0, 0), plain: d(0, 0, 0, 0, 0), 'plain-on': d(0, 0, 0, 0, 0) },
  'boundary-event-shapes.json': { default: d(1, 0, 0, 0, 0), off: d(1, 0, 0, 0, 0), on: d(1, 0, 0, 0, 0), plain: d(1, 1, 0, 1, 0), 'plain-on': d(1, 1, 0, 1, 0) },
  'bpmn-generator-pipeline.json': { default: d(3, 0, 0, 0, 0), off: d(3, 0, 0, 0, 0), on: d(5, 0, 2, 1, 0), plain: d(5, 2, 1, 2, 0), 'plain-on': d(7, 2, 3, 5, 0) },
  'cross-lane-connection-sides.json': { default: d(0, 0, 0, 0, 0), off: d(0, 0, 0, 0, 0), on: d(0, 0, 0, 0, 0), plain: d(0, 0, 1, 0, 0), 'plain-on': d(0, 0, 1, 0, 0) },
  'deadlock-process.json': { default: null, off: null, on: null, plain: null, 'plain-on': null },
  'dense-edge-labels.json': { default: d(0, 0, 0, 0, 0), off: d(0, 0, 0, 0, 0), on: d(0, 0, 0, 0, 0), plain: d(4, 0, 0, 0, 0), 'plain-on': d(4, 0, 0, 0, 0) },
  'example-bestellung-versand.json': { default: d(1, 0, 0, 1, 0), off: d(1, 0, 0, 1, 0), on: d(1, 0, 0, 1, 0), plain: d(6, 1, 2, 2, 0), 'plain-on': d(6, 1, 2, 2, 0) },
  'example-kreditantrag.json': { default: d(1, 0, 0, 0, 0), off: d(1, 0, 0, 0, 0), on: d(6, 0, 0, 0, 0), plain: d(8, 1, 0, 1, 0), 'plain-on': d(15, 3, 0, 4, 0) },
  'example-onboarding.json': { default: d(2, 0, 0, 0, 0), off: d(2, 0, 0, 0, 0), on: d(2, 0, 0, 0, 0), plain: d(7, 3, 2, 3, 0), 'plain-on': d(7, 3, 2, 3, 0) },
  'example-rechnungspruefung.json': { default: d(3, 0, 0, 0, 0), off: d(4, 0, 0, 0, 0), on: d(3, 0, 0, 0, 0), plain: d(7, 2, 2, 2, 0), 'plain-on': d(7, 2, 2, 2, 0) },
  'example-schadenmeldung.json': { default: d(2, 0, 0, 0, 0), off: d(1, 0, 0, 0, 0), on: d(2, 0, 0, 0, 0), plain: d(6, 1, 0, 2, 0), 'plain-on': d(6, 1, 0, 2, 0) },
  'example-urlaubsantrag.json': { default: d(2, 0, 0, 0, 0), off: d(3, 0, 0, 0, 0), on: d(2, 0, 0, 0, 0), plain: d(6, 3, 2, 5, 0), 'plain-on': d(6, 3, 2, 5, 0) },
  'expanded-subprocess.json': { default: d(0, 0, 0, 0, 0), off: d(0, 0, 0, 0, 0), on: d(0, 0, 0, 0, 0), plain: d(0, 0, 0, 0, 0), 'plain-on': d(0, 0, 0, 0, 0) },
  'long-lane-names.json': { default: d(2, 0, 0, 0, 0), off: d(2, 0, 0, 0, 0), on: d(2, 0, 0, 0, 0), plain: d(2, 0, 0, 0, 0), 'plain-on': d(2, 0, 0, 0, 0) },
  'loop-with-join.json': { default: d(1, 0, 0, 0, 0), off: d(1, 0, 0, 0, 0), on: d(1, 0, 0, 0, 0), plain: d(2, 0, 0, 0, 0), 'plain-on': d(2, 0, 0, 0, 0) },
  'message-flow-participant-ports.json': { default: d(0, 0, 0, 0, 0), off: d(0, 0, 0, 0, 0), on: d(0, 0, 0, 0, 0), plain: d(0, 0, 0, 0, 0), 'plain-on': d(0, 0, 0, 0, 0) },
  'messageflow-to-subprocess.json': { default: d(0, 0, 0, 0, 0), off: d(0, 0, 0, 0, 0), on: d(0, 0, 0, 0, 0), plain: d(0, 0, 0, 0, 0), 'plain-on': d(0, 0, 0, 0, 0) },
  'multi-pool-collaboration.json': { default: d(2, 0, 0, 0, 0), off: d(2, 0, 0, 0, 0), on: d(2, 0, 0, 0, 0), plain: d(5, 0, 0, 0, 0), 'plain-on': d(5, 0, 0, 0, 0) },
  'parallel-split-join.json': { default: d(0, 0, 0, 0, 0), off: d(0, 0, 0, 0, 0), on: d(0, 0, 0, 0, 0), plain: d(2, 0, 0, 0, 0), 'plain-on': d(2, 0, 0, 0, 0) },
  'realistic-collaboration.json': { default: d(4, 0, 0, 0, 0), off: d(4, 0, 0, 0, 0), on: d(10, 0, 0, 1, 0), plain: d(5, 2, 2, 2, 0), 'plain-on': d(6, 3, 3, 5, 0) },
  'simple-approval.json': { default: d(0, 0, 0, 0, 0), off: d(1, 0, 0, 0, 0), on: d(0, 0, 0, 0, 0), plain: d(1, 0, 0, 0, 0), 'plain-on': d(1, 0, 0, 0, 0) },
  'sparse-lanes.json': { default: d(2, 0, 0, 0, 0), off: d(2, 0, 0, 0, 0), on: d(2, 0, 0, 0, 0), plain: d(6, 1, 0, 1, 0), 'plain-on': d(6, 1, 0, 1, 0) },
  'subprocess-child-fidelity.json': { default: d(0, 0, 0, 0, 0), off: d(0, 0, 0, 0, 0), on: d(0, 0, 0, 0, 0), plain: d(1, 0, 0, 0, 0), 'plain-on': d(1, 0, 0, 0, 0) },
  'subprocess-collapsed-children.json': { default: d(0, 0, 0, 0, 0), off: d(0, 0, 0, 0, 0), on: d(0, 0, 0, 0, 0), plain: d(0, 0, 0, 0, 0), 'plain-on': d(0, 0, 0, 0, 0) },
  'subprocess-merge-fanout.json': { default: d(1, 0, 0, 0, 0), off: d(1, 0, 0, 0, 0), on: d(1, 0, 0, 0, 0), plain: d(6, 0, 0, 0, 0), 'plain-on': d(6, 0, 0, 0, 0) },
  'wide-pipeline.json': { default: d(0, 0, 0, 0, 0), off: d(0, 0, 0, 0, 0), on: d(16, 0, 0, 0, 0), plain: d(0, 0, 0, 0, 0), 'plain-on': d(16, 0, 0, 0, 0) },
  'wrapping-back-edge.json': { default: d(0, 0, 0, 0, 0), off: d(0, 0, 0, 0, 0), on: d(16, 0, 0, 0, 0), plain: d(2, 0, 0, 0, 0), 'plain-on': d(18, 0, 0, 0, 0) },
};

describe('layout budget — every top-level fixture × five modes (default, off, on, plain, plain-on)', () => {
  test('every fixture has a budget row (a new fixture must be measured, not skipped)', () => {
    expect(Object.keys(BUDGET).sort()).toEqual(FIXTURES);
    expect(Object.keys(BUDGET_DEFAULT).sort()).toEqual(FIXTURES);
    expect(Object.keys(DIRECTION).sort()).toEqual(FIXTURES);
  });
  for (const name of FIXTURES) {
    for (const mode of Object.keys(MODES)) {
      test(`${name} ${mode}`, async () => {
        const m = await measureLayout(load(name), MODES[mode]);
        // Compared as a string so a failure names the fixture and the full row, and lists the
        // offending edges, without a debugger.
        const got = summarize(m);
        // `in`, not `??`: a deliberate `null` row (blocked fixture) must not read as "missing".
        const rows = BUDGET[name];
        const want = rows && mode in rows ? rows[mode] : 'missing';
        const detail = m && JSON.stringify({ along: m.alongBorder, gaps: m.laneGaps,
          mf: m.mfThroughNodes, seq: m.seqThroughNodes, labels: m.labels });
        const differs = JSON.stringify(got) !== JSON.stringify(want);
        expect(`${name} ${mode} ${JSON.stringify(got)}`)
          .toBe(`${name} ${mode} ${JSON.stringify(want)}${differs && detail ? ' | ' + detail : ''}`);
        const wantDir = DIRECTION[name] && mode in DIRECTION[name] ? DIRECTION[name][mode] : 'missing';
        expect(`${name} ${mode} direction ${JSON.stringify(summarizeDirection(m))}`)
          .toBe(`${name} ${mode} direction ${JSON.stringify(wantDir)}`);
      }, 30000);
    }
  }
});

describe('wrapped layout row folds (wide-pipeline, refined)', () => {
  test('every fold edge arrives across the outline and runs through no node', async () => {
    const m = await measureLayout(load('wide-pipeline.json'), MODES.on);
    expect(m.alongBorder).toEqual([]);
    expect(m.seqThroughNodes).toEqual([]);
    expect(m.ownThrough).toEqual([]);      // master: f5, f11, f17, f23 ran back through their source
    expect(m.diCodes.DI07 ?? 0).toBe(0);
  }, 30000);
});

describe('message flows and uninvolved participants (realistic-collaboration)', () => {
  for (const mode of ['off', 'on']) {
    test(`no flow runs through a shape of a participant it does not involve (${mode})`, async () => {
      const m = await measureLayout(load('realistic-collaboration.json'), MODES[mode]);
      expect(m.mfThroughNodes.filter((x) => x.relation === 'uninvolved')).toEqual([]);
    }, 30000);
  }
});
