/**
 * flow-metrics.mjs — flow-quality measures per edge class: sequence flow ('seq', every flow in
 * every process incl. subprocess children) and message flow ('mf'). Associations are excluded.
 * All measures read coordMap only (the geometry contract) — never the SVG or the DI.
 * Used by layout-metrics.mjs (measureLayout) and its ratchet fence.
 */
import { isEvent, isGateway } from '../bpmn/types.js';
import { resolveLaneId } from '../bpmn/topology.js';
import { bendMetrics } from '../bpmn/bend-rule.js';

/** Horizontal run within this many px of an inner lane boundary counts as lying on the line. */
export const LANE_LINE_HUG_PX = 3;
const EPS = 1;
const segs = (pts) => {
  const out = [];
  for (let i = 0; i < (pts?.length || 0) - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) continue;
    out.push([a, b]);
  }
  return out;
};
const isH = ([a, b]) => Math.abs(a.y - b.y) <= EPS;
const isV = ([a, b]) => Math.abs(a.x - b.x) <= EPS;
const len = (pts) => segs(pts).reduce((s, [a, b]) => s + Math.abs(a.x - b.x) + Math.abs(a.y - b.y), 0);
const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(Math.max(a0, a1), Math.max(b0, b1)) - Math.max(Math.min(a0, a1), Math.min(b0, b1)));
export function bends(pts) {
  const s = segs(pts); let n = 0;
  for (let i = 1; i < s.length; i++) {
    const d = (g) => [Math.sign(Math.round(g[1].x - g[0].x)), Math.sign(Math.round(g[1].y - g[0].y))];
    const p = d(s[i - 1]), c = d(s[i]);
    if (p[0] !== c[0] || p[1] !== c[1]) n++;
  }
  return n;
}
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const pct = (a, q) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

/** Context: node types, owning participant, lane (inherited by subprocess children and boundary events). */
export function buildFlowContext(lc) {
  const typeOf = {}, partOf = {}, laneOf = {}, procOf = {};
  const procs = lc.pools ? lc.pools : [lc];
  for (const p of procs) {
    const pid = p.id ?? '_singlePool';
    const all = [];
    const walk = (nodes, inheritedLane) => {
      for (const n of nodes || []) {
        all.push(n);
        typeOf[n.id] = n.type; partOf[n.id] = pid; procOf[n.id] = p;
        const own = inheritedLane ?? resolveLaneId(p, n);
        laneOf[n.id] = own;
        walk(n.nodes, own);
      }
    };
    walk(p.nodes, undefined);
    for (const n of all) if (n.attachedTo && !laneOf[n.id]) laneOf[n.id] = laneOf[n.attachedTo];
  }
  for (const cp of lc.collapsedPools || []) partOf[cp.id] = cp.id;
  const seqEdges = [];
  const walkE = (nodes) => { for (const n of nodes || []) { if (n.edges) seqEdges.push(...n.edges); walkE(n.nodes); } };
  for (const p of procs) { seqEdges.push(...(p.edges || [])); walkE(p.nodes); }
  const mfEdges = (lc.messageFlows || []).map((m) => ({ ...m, id: m.id || `mf_${m.source}_${m.target}` }));
  return { typeOf, partOf, laneOf, procOf, procs, seqEdges, mfEdges };
}

const shapeOf = (t) => (isEvent(t) ? 'circle' : isGateway(t) ? 'diamond' : 'rect');

/** Distance of an endpoint from the nearest side midpoint (= cardinal point for circle/rhombus). */
function endOffset(p, box) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const mids = [[box.x, cy], [box.x + box.w, cy], [cx, box.y], [cx, box.y + box.h]];
  return Math.min(...mids.map(([x, y]) => Math.hypot(p.x - x, p.y - y)));
}

/**
 * Parallel-segment crowding: pairs of segments of two DIFFERENT edges, both horizontal (or both
 * vertical), whose perpendicular distance is < 10 px and whose projections overlap by > 1 px.
 * Excluded: two segments that both touch the same shared endpoint node (a fan-in/fan-out stub
 * at a common node is a shared port, not crowding).
 */
function crowding(listA, listB, same) {
  let pairs = 0, collinear = 0;
  for (let i = 0; i < listA.length; i++) {
    for (let j = same ? i + 1 : 0; j < listB.length; j++) {
      const A = listA[i], B = listB[j];
      if (A.edge === B.edge) continue;
      let d, o;
      if (isH(A.s) && isH(B.s)) { d = Math.abs(A.s[0].y - B.s[0].y); o = ov(A.s[0].x, A.s[1].x, B.s[0].x, B.s[1].x); }
      else if (isV(A.s) && isV(B.s)) { d = Math.abs(A.s[0].x - B.s[0].x); o = ov(A.s[0].y, A.s[1].y, B.s[0].y, B.s[1].y); }
      else continue;
      if (d >= 10 || o <= 1) continue;
      const sharedTouch = [...A.touch].some((n) => B.touch.has(n));
      if (sharedTouch) continue;
      pairs++; if (d < 1) collinear++;
    }
  }
  return { pairs, collinear };
}

export function flowMetrics(coordMap, lc, ctx = buildFlowContext(lc)) {
  const { coords, edgeCoords, laneCoords = {}, poolCoords = {} } = coordMap;
  const out = {};

  // lane bands per participant, sorted by y
  const bandsOf = {};
  for (const p of ctx.procs) {
    const pid = p.id ?? '_singlePool';
    bandsOf[pid] = (p.lanes || []).map((l) => ({ id: l.id, ...(laneCoords[l.id] || {}) }))
      .filter((b) => Number.isFinite(b.y)).sort((a, b) => a.y - b.y);
  }
  const segList = { seq: [], mf: [] };

  for (const cls of ['seq', 'mf']) {
    const edges = cls === 'seq' ? ctx.seqEdges : ctx.mfEdges;
    const bendL = [], detL = [], offL = [], perEdge = {};
    let total = 0, excess = 0, shortStubs = 0, foreignV = 0, outOfSpan = 0, laneLineHug = 0, uninvolvedV = 0, n = 0;
    for (const e of edges) {
      const pts = edgeCoords?.[e.id];
      if (!pts || pts.length < 2) continue;
      n++;
      const b = bends(pts); bendL.push(b);
      const L = len(pts); total += L;
      const a = pts[0], z = pts[pts.length - 1];
      const man = Math.abs(a.x - z.x) + Math.abs(a.y - z.y);
      let det = null;
      if (man >= 1 && e.source !== e.target) { det = L / man; detL.push(det); excess += L - man; }
      // endpoint offsets
      const ends = [[a, e.source, 'source'], [z, e.target, 'target']];
      const offs = [];
      for (const [p, id, end] of ends) {
        const box = coords[id];
        if (!box) continue; // black-box participant (mf only): no side midpoint to speak of
        if (end === 'source' && ctx.typeOf[id] === 'boundaryEvent') continue; // pinned by placeBoundaryEvents
        const o = endOffset(p, box); offL.push(o); offs.push(o);
      }
      const S = segs(pts);
      if (S.length >= 2) {
        const l0 = Math.abs(S[0][0].x - S[0][1].x) + Math.abs(S[0][0].y - S[0][1].y);
        const l1 = Math.abs(S.at(-1)[0].x - S.at(-1)[1].x) + Math.abs(S.at(-1)[0].y - S.at(-1)[1].y);
        if (l0 < 8) shortStubs++;
        if (l1 < 8) shortStubs++;
      }
      let eForeign = 0, eOut = 0, eHug = 0, eUninv = 0;
      if (cls === 'seq') {
        const pid = ctx.partOf[e.source];
        const bands = bandsOf[pid] || [];
        if (bands.length) {
          const idx = (lane) => bands.findIndex((bd) => bd.id === lane);
          const si = idx(ctx.laneOf[e.source]), ti = idx(ctx.laneOf[e.target]);
          const lo = Math.min(si, ti), hi = Math.max(si, ti);
          for (const s of S) {
            for (let k = 0; k < bands.length; k++) {
              const bd = bands[k];
              if (k === si || k === ti) continue;
              if (isV(s)) {
                if (s[0].x < bd.x || s[0].x > bd.x + bd.w) continue;
                const o = ov(s[0].y, s[1].y, bd.y, bd.y + bd.h);
                eForeign += o;
                if (si >= 0 && ti >= 0 && (k < lo || k > hi)) eOut += o;
              } else if (isH(s) && si >= 0 && ti >= 0 && (k < lo || k > hi)) {
                if (s[0].y > bd.y + 1 && s[0].y < bd.y + bd.h - 1) eOut += ov(s[0].x, s[1].x, bd.x, bd.x + bd.w);
              }
            }
          }
          // horizontal run within LANE_LINE_HUG_PX of an inner lane boundary — the signature of compactLanes' clamp
          const lines = bands.slice(1).map((bd) => bd.y);
          for (const s of S) if (isH(s)) for (const y of lines) if (Math.abs(s[0].y - y) <= LANE_LINE_HUG_PX) eHug += Math.abs(s[0].x - s[1].x);
        }
      } else {
        const sp = ctx.partOf[e.source] ?? e.source, tp = ctx.partOf[e.target] ?? e.target;
        for (const [pid, box] of Object.entries(poolCoords)) {
          if (pid === sp || pid === tp || pid === '_singlePool') continue;
          for (const s of S) if (isV(s) && s[0].x > box.x && s[0].x < box.x + box.w) eUninv += ov(s[0].y, s[1].y, box.y, box.y + box.h);
        }
      }
      foreignV += eForeign; outOfSpan += eOut; laneLineHug += eHug; uninvolvedV += eUninv;
      perEdge[e.id] = { bends: b, len: r1(L), det: det && r2(det), off: offs.map(r1), foreignV: r1(eForeign), outOfSpan: r1(eOut), hug: r1(eHug), uninvolvedV: r1(eUninv) };
      const touch = (i) => new Set([i === 0 ? e.source : null, i === S.length - 1 ? e.target : null].filter(Boolean));
      S.forEach((s, i) => segList[cls].push({ edge: e.id, s, touch: touch(i) }));
    }
    out[cls] = {
      n,
      bendsMean: r2(mean(bendL)), bendsMax: Math.max(0, ...bendL),
      detourMean: r2(mean(detL)), detourP90: r2(pct(detL, 0.9)), excessPx: Math.round(excess),
      endOffMean: r1(mean(offL)), endOffOver5: offL.filter((o) => o > 5).length,
      shortStubs,
      lengthTotal: Math.round(total),
      ...(cls === 'seq'
        ? { foreignLaneV: Math.round(foreignV), outOfSpanRun: Math.round(outOfSpan), laneLineHug: Math.round(laneLineHug) }
        : { uninvolvedV: Math.round(uninvolvedV) }),
      perEdge,
    };
  }
  out.seq.crowd = crowding(segList.seq, segList.seq, true);
  out.mf.crowd = (() => {
    const a = crowding(segList.mf, segList.mf, true), b = crowding(segList.mf, segList.seq, false);
    return { pairs: a.pairs + b.pairs, collinear: a.collinear + b.collinear, mfmf: a.pairs, mfseq: b.pairs };
  })();
  return out;
}

/**
 * Flow direction per fixture, from the bend rule's own search (bend-rule.js bendMetrics) — the
 * measure and the rule share one definition of an admissible route, so the two cannot disagree:
 *  - avoidableBends: over every sequence flow, current bends − the fewest bends of an admissible route;
 *  - againstFlowEntries: activity/event targets not entered from the left although an admissible
 *    left entry with no more bends exists.
 * Both are lower bounds: the search samples corridors, it proves no minimum. Read on the final
 * coordMap, so the message flows routed after the rule are in edgeCoords but not in the search.
 */
export function flowDirectionMetrics(coordMap, lc) {
  const { avoidableBends, againstFlowEntries } = bendMetrics(coordMap, lc);
  return { avoidableBends, againstFlowEntries };
}
