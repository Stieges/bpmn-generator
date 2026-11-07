/**
 * bend-rule.js — "fewest bends, then enter in flow direction": a late routing pass over the
 * sequence flows, plus the measure that shares its search.
 *
 * The rule. Among the admissible routes between an edge's two shapes, prefer (1) the fewest bends,
 * then (2) entering an activity or event from the left and leaving one to the right. A gateway may
 * be entered and left at any vertex. An endpoint is either kept where it is, moved to the middle
 * of one of its shape's sides (on a circle or a diamond that midpoint lies on the outline, so no
 * second clip is needed — the same mechanism reclipStuckEnds uses), or — on a rectangle only
 * (task, subprocess, call activity) — moved to a projection port: the point of a side level with
 * the counterpart's centre or current endpoint, at least bendRuleLimits.portCornerMarginPx from
 * either corner. A rectangle's side is straight, so that point lies on the outline too; it is what
 * lets a flow from a tall expanded subprocess run straight into a task beside it. An event or a
 * gateway keeps its midpoints/vertices. A boundary event's endpoint never moves: its place on the
 * host is placeBoundaryEvents' contract.
 *
 * Admissible route — every condition is relative to the edge's CURRENT route, so the pass can only
 * trade a bend for nothing worse:
 *  1. orthogonal; the first segment leaves the source outward, the last enters the target inward;
 *  2. no end defect: no end segment along its own outline for more than layout.alongOutlineMinPx,
 *     no segment through its own source or target (the DI08/DI09 measures); the endpoint is a side
 *     midpoint, a projection port or the current endpoint, so DI07 stays clean;
 *  3. both end segments at least layout.endStubPx long once the route bends;
 *  4. clear of every foreign node box by bendRuleLimits.shapeClearance (a box containing an
 *     endpoint — its expanded subprocess — and groups excepted);
 *  5. inside its region — the innermost expanded container holding both endpoints, else the
 *     participant's lane stack, else the pool body right of its header — by regionInset;
 *  6. per edge not worse than the current route in: crossings with non-adjacent flows, horizontal
 *     run on an inner lane line (laneLineHugPx), length of collinear overlap with any flow — two
 *     parallel legs closer than collinearPx count as one line, whichever nodes they touch, because
 *     the crowding measure below skips legs at a shared node and a 2.5 px offset still reads as
 *     one stroke (sparse-lanes f3) — parallel crowding
 *     (crowdingPx, as scripts/bench/flow-metrics.mjs counts it), hits on external node labels
 *     (coordMap.nodeLabels), side conflicts (in and out on the same side of a node), shared ports
 *     (two flows out of — or into — one gateway/event side, or one rectangle point), and overlap
 *     with the line a message flow will take at a message-flow node's centre;
 *  7. length at most lengthFactor × the current length + lengthSlackPx;
 *  8. at a node carrying a message flow, no NEW port on top or bottom — routeMessageFlows runs after
 *     this pass and docks there; this holds for projection ports as well.
 *
 * Candidates: for every port pair the 0-, 1- and 2-bend shapes (straight, L, and Z/U with the
 * corridor on a corridorStepPx grid within corridorReachPx of the ends); only when none of them is
 * admissible at or below the current bend count, orthogonal-router.js between two end stubs.
 *
 * Choice: greedy in edge order, every edge seeing the routes already changed. A route is replaced
 * only by one with fewer bends, or as many bends and a lower side penalty (an activity/event target
 * not entered from the left +1, an activity/event source not left to the right +1; a back-edge into
 * a gateway entered from the left +1). When the current route has a side penalty, Pass B/C may spend
 * up to bendRuleLimits.sideBendBudget (+ backEdgeBendBudget on back-edges) extra bends to clear it
 * (Miragon flow-connection-side prefers left-in / right-out on activities). Ties: crossings, moved
 * endpoints, length, corridor nearest the middle. The pass repeats until a full sweep changes
 * nothing; a repeated route fingerprint or maxSweeps cap stops Pass B/C from oscillating with Pass A
 * (e.g. top-entry L ↔ left-entry Z around a gateway node label). Idempotent once stable.
 *
 * Where it runs (pipeline.js): after every pass that moves a shape or a route — lane compaction, its
 * re-route and the stuck-end pass — so it judges final geometry; before edge-label repair and
 * routeMessageFlows. Switched by layout.bendRule (default on).
 *
 * The measure (bendMetrics) runs the same search on any coordMap: avoidable bends = current bends −
 * the fewest bends of an admissible route; an entry against the flow = an activity/event target not
 * entered from the left although an admissible left entry with no more bends exists. Both are lower
 * bounds — the search samples corridors, it does not prove a minimum.
 */
import { routeAroundObstacles } from './orthogonal-router.js';
import { CFG } from '../shared/utils.js';
// The global Math, bound once to a module constant. Under Jest (--experimental-vm-modules) code runs
// in a vm context, where every global lookup goes through the context's interceptor; this module's
// hot geometry loops call Math.min/max/abs millions of times, which made every pipeline run about
// ten times slower under test than under node. Same object, so no behaviour change.
const Math = globalThis.Math;
import { isEvent, isGateway } from './types.js';

const DEFAULT_LIMITS = Object.freeze({
  shapeClearance: 8,
  regionInset: 10,
  lengthFactor: 1.1,
  lengthSlackPx: 20,
  laneLineHugPx: 3,
  crowdingPx: 10,
  corridorReachPx: 120,
  corridorStepPx: 5,
  messageFlowLinePx: 3,
  collinearPx: 4,
  portCornerMarginPx: 20,
  /** Extra bends allowed only to reduce sidePenalty (left-in / right-out). */
  sideBendBudget: 4,
  /** Extra bends on top of sideBendBudget for back-edges (source right of target). */
  backEdgeBendBudget: 6,
});

/**
 * Every guard defaults on. Switching one off exists for the tests that show what each one
 * prevents — a pipeline never passes `guards`.
 */
const DEFAULT_GUARDS = Object.freeze({
  nodeLabels: true, messageFlowPorts: true, sideConflicts: true, crowding: true, region: true, length: true,
  sharedPorts: true,
});

/** The limits in effect: config.json → layout.bendRuleLimits over the defaults, `over` last. */
export function bendRuleLimits(over = {}) {
  return { ...DEFAULT_LIMITS, ...(CFG.layout?.bendRuleLimits ?? {}), ...over };
}

const EPS = 1e-6;
const SIDES = ['left', 'right', 'top', 'bottom'];
const OUTWARD = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
const INWARD = { left: [1, 0], right: [-1, 0], top: [0, 1], bottom: [0, -1] };

// ── geometry ────────────────────────────────────────────────────────────

function segsOf(pts) {
  const s = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS) continue;
    s.push([a, b]);
  }
  return s;
}
const dirOf = ([a, b]) => [Math.sign(Math.round((b.x - a.x) * 1e3)), Math.sign(Math.round((b.y - a.y) * 1e3))];
const sameDir = (p, q) => p[0] === q[0] && p[1] === q[1];

/** Direction changes along a polyline (repeated points ignored). */
export function bendCount(pts) {
  const s = segsOf(pts);
  let n = 0;
  for (let i = 1; i < s.length; i++) if (!sameDir(dirOf(s[i - 1]), dirOf(s[i]))) n++;
  return n;
}
const isOrthogonal = (pts) => segsOf(pts).every(([a, b]) => Math.abs(a.x - b.x) < EPS || Math.abs(a.y - b.y) < EPS);
const segLen = ([a, b]) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const pathLen = (pts) => segsOf(pts).reduce((t, s) => t + segLen(s), 0);
const overlap1d = (a0, a1, b0, b1) =>
  Math.max(0, Math.min(Math.max(a0, a1), Math.max(b0, b1)) - Math.max(Math.min(a0, a1), Math.min(b0, b1)));

/** Drop repeated points and the middle one of three collinear points. */
function withoutCollinear(pts) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = out[out.length - 1];
    if (Math.abs(p.x - pts[i].x) > EPS || Math.abs(p.y - pts[i].y) > EPS) out.push(pts[i]);
  }
  const r = [out[0]];
  for (let i = 1; i < out.length - 1; i++) {
    const a = r[r.length - 1], b = out[i], c = out[i + 1];
    const vertical = Math.abs(a.x - b.x) < EPS && Math.abs(b.x - c.x) < EPS;
    const horizontal = Math.abs(a.y - b.y) < EPS && Math.abs(b.y - c.y) < EPS;
    if (vertical || horizontal) continue;
    r.push(b);
  }
  if (out.length > 1) r.push(out[out.length - 1]);
  return r;
}

/**
 * Left↔right / up↔down "folds": adjacent reverse on one axis, or an HVH/VHV whose
 * outer legs run opposite ways.
 * Used only for scoring — Miragon right-out on a back-edge still needs one reverse.
 */
function axisFolds(pts) {
  const s = segsOf(pts);
  let n = 0;
  for (let i = 0; i < s.length - 1; i++) {
    const [a, b] = s[i], [c, d] = s[i + 1];
    const dx1 = b.x - a.x, dy1 = b.y - a.y, dx2 = d.x - c.x, dy2 = d.y - c.y;
    if (Math.abs(dy1) < EPS && Math.abs(dy2) < EPS && dx1 * dx2 < 0) n++;
    if (Math.abs(dx1) < EPS && Math.abs(dx2) < EPS && dy1 * dy2 < 0) n++;
  }
  for (let i = 0; i < s.length - 2; i++) {
    const [a, b] = s[i], [c, d] = s[i + 1], [e, f] = s[i + 2];
    const hvh = Math.abs(a.y - b.y) < EPS && Math.abs(c.x - d.x) < EPS && Math.abs(e.y - f.y) < EPS
      && (b.x - a.x) * (f.x - e.x) < 0;
    const vhv = Math.abs(a.x - b.x) < EPS && Math.abs(c.y - d.y) < EPS && Math.abs(e.x - f.x) < EPS
      && (b.y - a.y) * (f.y - e.y) < 0;
    if (hvh || vhv) n++;
  }
  return n;
}

/**
 * Count HVH/VHV opposite folds whose shorter outer leg is only a Miragon-sized stub
 * (≤ 1.5× endStubPx). Those read as accidental kinks; prefer a deliberate far U-turn
 * (or fewer folds) over a 20px right stub that immediately runs left.
 */
function slightFoldPenalty(pts, stubPx = 20) {
  const s = segsOf(pts);
  const limit = stubPx * 1.5 + EPS;
  let n = 0;
  for (let i = 0; i < s.length - 2; i++) {
    const [a, b] = s[i], [c, d] = s[i + 1], [e, f] = s[i + 2];
    if (Math.abs(a.y - b.y) < EPS && Math.abs(c.x - d.x) < EPS && Math.abs(e.y - f.y) < EPS
      && (b.x - a.x) * (f.x - e.x) < 0) {
      if (Math.min(Math.abs(b.x - a.x), Math.abs(f.x - e.x)) <= limit) n++;
    }
    if (Math.abs(a.x - b.x) < EPS && Math.abs(c.y - d.y) < EPS && Math.abs(e.x - f.x) < EPS
      && (b.y - a.y) * (f.y - e.y) < 0) {
      if (Math.min(Math.abs(b.y - a.y), Math.abs(f.y - e.y)) <= limit) n++;
    }
  }
  // Adjacent same-axis reverse with a short first leg (collinear-collapsed LRL / UDU).
  for (let i = 0; i < s.length - 1; i++) {
    const [a, b] = s[i], [c, d] = s[i + 1];
    const dx1 = b.x - a.x, dy1 = b.y - a.y, dx2 = d.x - c.x, dy2 = d.y - c.y;
    if (Math.abs(dy1) < EPS && Math.abs(dy2) < EPS && dx1 * dx2 < 0
      && Math.min(Math.abs(dx1), Math.abs(dx2)) <= limit) n++;
    if (Math.abs(dx1) < EPS && Math.abs(dx2) < EPS && dy1 * dy2 < 0
      && Math.min(Math.abs(dy1), Math.abs(dy2)) <= limit) n++;
  }
  return n;
}

export { axisFolds, slightFoldPenalty };

function orientation(a, b, c) {
  const v = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  return Math.abs(v) < 1e-9 ? 0 : v > 0 ? 1 : 2;
}
const onSegment = (a, b, c) =>
  Math.min(a.x, b.x) - EPS <= c.x && c.x <= Math.max(a.x, b.x) + EPS &&
  Math.min(a.y, b.y) - EPS <= c.y && c.y <= Math.max(a.y, b.y) + EPS;
function segmentsIntersect(p1, p2, p3, p4) {
  const o1 = orientation(p1, p2, p3), o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1), o4 = orientation(p3, p4, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSegment(p1, p2, p3)) || (o2 === 0 && onSegment(p1, p2, p4)) ||
    (o3 === 0 && onSegment(p3, p4, p1)) || (o4 === 0 && onSegment(p3, p4, p2));
}

/** Side of `box` a point lies on (within 0.5 px), or null — a diamond's or circle's clip point off its bounding box. */
function sideOf(p, box) {
  if (Math.abs(p.x - box.x) <= 0.5) return 'left';
  if (Math.abs(p.x - (box.x + box.w)) <= 0.5) return 'right';
  if (Math.abs(p.y - box.y) <= 0.5) return 'top';
  if (Math.abs(p.y - (box.y + box.h)) <= 0.5) return 'bottom';
  return null;
}
function sideMidpoint(box, side) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  if (side === 'left') return { x: box.x, y: cy };
  if (side === 'right') return { x: box.x + box.w, y: cy };
  if (side === 'top') return { x: cx, y: box.y };
  return { x: cx, y: box.y + box.h };
}
const contains = (o, i) => o !== i && o.x <= i.x + EPS && o.y <= i.y + EPS &&
  o.x + o.w >= i.x + i.w - EPS && o.y + o.h >= i.y + i.h - EPS;

/** Does a segment reach into the shape's interior (a circle and a diamond tested as such)? */
function entersShape([a, z], box, shape) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const nx = Math.max(Math.min(a.x, z.x), Math.min(Math.max(a.x, z.x), cx));
  const ny = Math.max(Math.min(a.y, z.y), Math.min(Math.max(a.y, z.y), cy));
  if (shape === 'circle') return Math.hypot(nx - cx, ny - cy) < box.w / 2 - 1;
  if (shape === 'diamond') return Math.abs(nx - cx) / (box.w / 2) + Math.abs(ny - cy) / (box.h / 2) < 1 - 2 / Math.min(box.w, box.h);
  return Math.max(a.x, z.x) > box.x + 1 && Math.min(a.x, z.x) < box.x + box.w - 1 &&
    Math.max(a.y, z.y) > box.y + 1 && Math.min(a.y, z.y) < box.y + box.h - 1;
}
/** Length a segment runs along one side of `box` (collinear within 1 px). */
function alongOutline([a, b], box) {
  let best = 0;
  if (Math.abs(a.x - b.x) <= 1) for (const x of [box.x, box.x + box.w]) if (Math.abs(a.x - x) <= 1) best = Math.max(best, overlap1d(a.y, b.y, box.y, box.y + box.h));
  if (Math.abs(a.y - b.y) <= 1) for (const y of [box.y, box.y + box.h]) if (Math.abs(a.y - y) <= 1) best = Math.max(best, overlap1d(a.x, b.x, box.x, box.x + box.w));
  return best;
}
function hasEndDefect(pts, sb, tb, ss, ts, alongMin) {
  const s = segsOf(pts);
  if (!s.length) return true;
  if (alongOutline(s[0], sb) > alongMin || alongOutline(s[s.length - 1], tb) > alongMin) return true;
  return s.some((g) => entersShape(g, sb, ss) || entersShape(g, tb, ts));
}
function segmentClearOfBox([a, b], box, pad) {
  const x1 = box.x - pad, y1 = box.y - pad, x2 = box.x + box.w + pad, y2 = box.y + box.h + pad;
  if (Math.abs(a.y - b.y) < EPS) return a.y < y1 || a.y > y2 || Math.max(a.x, b.x) <= x1 || Math.min(a.x, b.x) >= x2;
  if (Math.abs(a.x - b.x) < EPS) return a.x < x1 || a.x > x2 || Math.max(a.y, b.y) <= y1 || Math.min(a.y, b.y) >= y2;
  return false;
}
const segmentHitsBox = ([a, z], b) =>
  Math.max(a.x, z.x) > b.x && Math.min(a.x, z.x) < b.x + b.w && Math.max(a.y, z.y) > b.y && Math.min(a.y, z.y) < b.y + b.h;

/** Side of the target the route enters through / of the source it leaves through, read from the end segment's direction. */
export function entrySide(pts) {
  const s = segsOf(pts);
  if (!s.length) return null;
  const [dx, dy] = dirOf(s[s.length - 1]);
  return dx > 0 ? 'left' : dx < 0 ? 'right' : dy > 0 ? 'top' : 'bottom';
}
export function exitSide(pts) {
  const s = segsOf(pts);
  if (!s.length) return null;
  const [dx, dy] = dirOf(s[0]);
  return dx > 0 ? 'right' : dx < 0 ? 'left' : dy > 0 ? 'bottom' : 'top';
}
const entrySideOfDir = (d) => (d[0] > 0 ? 'left' : d[0] < 0 ? 'right' : d[1] > 0 ? 'top' : 'bottom');
const dirName = (d) => (d[0] > 0 ? 'right' : d[0] < 0 ? 'left' : d[1] > 0 ? 'down' : 'up');

// ── per-route measures (condition 6) ────────────────────────────────────

const adjacent = (a, b) => a.source === b.source || a.source === b.target || a.target === b.source || a.target === b.target;

function crossings(entry, pts, entries) {
  let n = 0;
  const A = segsOf(pts);
  for (const o of entries) {
    if (o.id === entry.id || adjacent(entry, o)) continue;
    for (const [p1, p2] of A) for (const [p3, p4] of segsOf(o.points)) if (segmentsIntersect(p1, p2, p3, p4)) n++;
  }
  return n;
}
/**
 * Length two segments run on top of each other: both horizontal (or both vertical), closer than
 * `tolerance` px — at that distance two strokes read as one line — and overlapping by more than
 * 1 px. 0 otherwise. Shared with scripts/bench/flow-metrics.mjs (overlapLen), so the guard and
 * the ratchet measure the same thing.
 */
export function collinearRun(s, q, tolerance) {
  const sh = Math.abs(s[0].y - s[1].y) < EPS, qh = Math.abs(q[0].y - q[1].y) < EPS;
  const sv = Math.abs(s[0].x - s[1].x) < EPS, qv = Math.abs(q[0].x - q[1].x) < EPS;
  let v = 0;
  if (sh && qh && Math.abs(s[0].y - q[0].y) < tolerance) v = overlap1d(s[0].x, s[1].x, q[0].x, q[1].x);
  else if (sv && qv && Math.abs(s[0].x - q[0].x) < tolerance) v = overlap1d(s[0].y, s[1].y, q[0].y, q[1].y);
  return v > 1 ? v : 0;
}
/** Length this route runs on top of every other flow (collinearRun), adjacent ones included. */
function collinearOverlap(entry, pts, entries, tolerance) {
  let t = 0;
  const A = segsOf(pts);
  for (const o of entries) {
    if (o.id === entry.id) continue;
    for (const s of A) for (const q of segsOf(o.points)) t += collinearRun(s, q, tolerance);
  }
  return t;
}
/**
 * Parallel segment pairs with another flow closer than `crowdingPx` and overlapping by more than
 * 1 px; two segments touching a shared endpoint node are a shared port, not crowding.
 */
function crowdPairs(entry, pts, entries, crowdingPx) {
  let n = 0;
  const A = segsOf(pts);
  const touchA = (i) => [i === 0 ? entry.source : null, i === A.length - 1 ? entry.target : null].filter(Boolean);
  for (const o of entries) {
    if (o.id === entry.id) continue;
    const B = segsOf(o.points);
    A.forEach((s, i) => B.forEach((q, j) => {
      const sh = Math.abs(s[0].y - s[1].y) <= 1, qh = Math.abs(q[0].y - q[1].y) <= 1;
      const sv = Math.abs(s[0].x - s[1].x) <= 1, qv = Math.abs(q[0].x - q[1].x) <= 1;
      let d, v;
      if (sh && qh) { d = Math.abs(s[0].y - q[0].y); v = overlap1d(s[0].x, s[1].x, q[0].x, q[1].x); }
      else if (sv && qv) { d = Math.abs(s[0].x - q[0].x); v = overlap1d(s[0].y, s[1].y, q[0].y, q[1].y); }
      else return;
      if (d >= crowdingPx || v <= 1) return;
      const touchB = [j === 0 ? o.source : null, j === B.length - 1 ? o.target : null].filter(Boolean);
      if (touchA(i).some((x) => touchB.includes(x))) return;
      n++;
    }));
  }
  return n;
}
/** Sides this route shares with a flow going the other way: ends where another flow leaves the target, or starts where one enters the source. */
function sideConflicts(entry, pts, entries) {
  const es = entrySide(pts), xs = exitSide(pts);
  let n = 0;
  for (const o of entries) {
    if (o.id === entry.id) continue;
    if (o.source === entry.target && exitSide(o.points) === es) n++;
    if (o.target === entry.source && entrySide(o.points) === xs) n++;
  }
  return n;
}
/**
 * Ports this route shares with another flow in the same direction: it leaves its source where
 * another flow leaves that node, or enters its target where another flow enters it. On a gateway or
 * an event a port is the side the end segment runs through — a vertex and the facet beside it,
 * 12.5 px apart, read as one bundle (rechnungspruefung, "Betrag über 10.000 EUR?") and put one
 * branch's label on the other's line; on a rectangle it is the endpoint itself (within collinearPx),
 * since two ports on one side of a task are fine. Flows in opposite directions on one side are
 * sideConflicts' business.
 */
function sharedPorts(entry, pts, entries, ctx, tolerance) {
  const same = (node, p, side, q, qSide) => (ctx.shapeOf(node) === 'rect'
    ? Math.abs(p.x - q.x) < tolerance && Math.abs(p.y - q.y) < tolerance
    : side === qSide);
  const xs = exitSide(pts), es = entrySide(pts), a = pts[0], z = pts[pts.length - 1];
  let n = 0;
  for (const o of entries) {
    if (o.id === entry.id || o.source === o.target) continue;
    if (o.source === entry.source && same(entry.source, a, xs, o.points[0], exitSide(o.points))) n++;
    if (o.target === entry.target && same(entry.target, z, es, o.points[o.points.length - 1], entrySide(o.points))) n++;
  }
  return n;
}
/**
 * Overlap with the vertical line a message flow takes at a message-flow node's centre, above or
 * below it — routeMessageFlows runs after this pass, so that line is not in edgeCoords yet.
 */
function messageFlowLineOverlap(pts, ctx, tolerance) {
  let t = 0;
  for (const id of ctx.mfNodes) {
    const b = ctx.coords[id];
    if (!b) continue;
    const cx = b.x + b.w / 2;
    for (const [a, z] of segsOf(pts)) {
      if (Math.abs(a.x - z.x) > EPS || Math.abs(a.x - cx) >= tolerance) continue;
      t += overlap1d(a.y, z.y, -Infinity, b.y) + overlap1d(a.y, z.y, b.y + b.h, Infinity);
    }
  }
  return t;
}
function laneLineHug(pts, lines, hugPx) {
  let t = 0;
  for (const [a, b] of segsOf(pts)) {
    if (Math.abs(a.y - b.y) >= EPS) continue;
    for (const y of lines) if (Math.abs(a.y - y) <= hugPx) t += Math.abs(a.x - b.x);
  }
  return t;
}
/** External node labels (coordMap.nodeLabels) a route runs through. */
function nodeLabelHits(pts, labelBoxes) {
  const S = segsOf(pts);
  let n = 0;
  for (const b of labelBoxes) if (S.some((s) => segmentHitsBox(s, b))) n++;
  return n;
}

// ── context ─────────────────────────────────────────────────────────────

/** Every sequence flow of `lc`, subprocess children included. */
export function sequenceFlowsOf(lc) {
  const out = [];
  const walk = (nodes) => { for (const n of nodes || []) { if (n.edges) out.push(...n.edges); walk(n.nodes); } };
  for (const p of (lc.pools ? lc.pools : [lc])) { out.push(...(p.edges || [])); walk(p.nodes); }
  return out;
}

function buildContext(coordMap, lc, opts = {}) {
  const procs = lc.pools ? lc.pools : [lc];
  const typeOf = {}, partOf = {}, laneOf = {}, attached = new Set(), expanded = new Set(), groups = new Set();
  for (const p of procs) {
    const pid = p.id ?? '_singlePool';
    // Prefer explicit node.lane; fall back to lane.nodeIds (auto-join diamonds).
    for (const lane of (p.lanes || [])) {
      for (const nid of (lane.nodeIds || [])) laneOf[nid] = lane.id;
    }
    const walk = (nodes) => {
      for (const n of nodes || []) {
        typeOf[n.id] = n.type; partOf[n.id] = pid;
        if (n.lane) laneOf[n.id] = n.lane;
        if (n.attachedTo) attached.add(n.id);
        if (n.type === 'group') groups.add(n.id);
        if (n.isExpanded && n.nodes?.length) expanded.add(n.id);
        walk(n.nodes);
      }
    };
    walk(p.nodes);
  }
  // Auto-join synthesises gw_join_* (and similar) after the caller's Logic-Core snapshot —
  // pipeline passes typeOf from the laid-out process tree so Miragon side rules see gateways.
  if (opts.typeOf) {
    for (const [id, t] of Object.entries(opts.typeOf)) {
      if (typeOf[id] == null && t) typeOf[id] = t;
    }
  }
  for (const id of Object.keys(coordMap.coords || {})) {
    if (typeOf[id] != null) continue;
    // Layout-only joins keep the gw_join_ / gw_split_ prefix when the LC snapshot lacks them.
    if (/^gw_(join|split)_/i.test(id) || /^Gateway_/i.test(id)) typeOf[id] = 'exclusiveGateway';
  }
  for (const g of lc.groups || []) groups.add(g.id);
  const shapeOf = (id) => (isEvent(typeOf[id]) ? 'circle' : isGateway(typeOf[id]) ? 'diamond' : 'rect');
  // Region of each participant (its lane stack, else the pool body right of its header) and its inner lane lines.
  const regionOf = {}, linesOf = {}, laneBand = { ...(coordMap.laneCoords || {}) };
  for (const p of procs) {
    const pid = p.id ?? '_singlePool';
    const bands = (p.lanes || []).map((l) => coordMap.laneCoords?.[l.id]).filter(Boolean).sort((a, b) => a.y - b.y);
    const pc = coordMap.poolCoords?.[pid] ?? coordMap.poolCoords?._singlePool;
    if (bands.length) {
      const x = Math.min(...bands.map((b) => b.x)), y = bands[0].y;
      const last = bands[bands.length - 1];
      regionOf[pid] = { x, y, w: Math.max(...bands.map((b) => b.x + b.w)) - x, h: last.y + last.h - y };
      linesOf[pid] = bands.slice(1).map((b) => b.y);
    } else if (pc) {
      const hw = pc.laneHeaderWidth ?? 0;
      regionOf[pid] = { x: pc.x + hw, y: pc.y, w: pc.w - hw, h: pc.h };
      linesOf[pid] = [];
    }
  }
  const mfNodes = new Set((lc.messageFlows || []).flatMap((m) => [m.source, m.target]));
  const labelBoxes = Object.values(coordMap.nodeLabels ?? {});
  return {
    coords: coordMap.coords, labelBoxes, mfNodes, typeOf, partOf, laneOf, laneBand,
    attached, expanded, groups, shapeOf, regionOf, linesOf,
  };
}

function regionFor(entry, ctx) {
  const sb = ctx.coords[entry.source], tb = ctx.coords[entry.target];
  let best = null;
  for (const id of ctx.expanded) {
    const b = ctx.coords[id];
    if (!b || id === entry.source || id === entry.target) continue;
    if (contains(b, sb) && contains(b, tb) && (!best || b.w * b.h < best.w * best.h)) best = b;
  }
  return best ?? ctx.regionOf[ctx.partOf[entry.source]] ?? null;
}
const insideRegion = (pts, r, inset) => !r || pts.every((p) =>
  p.x >= r.x + inset && p.x <= r.x + r.w - inset && p.y >= r.y + inset && p.y <= r.y + r.h - inset);
/**
 * Vertical envelope a sequence flow may occupy: union of its endpoints' lane bands
 * (cross-lane handoffs may cross separators), else the participant region. Intra-lane
 * loops must not climb above their own lane into the pool header / chart margin
 */
function envelopeFor(entry, ctx) {
  const lids = [ctx.laneOf[entry.source], ctx.laneOf[entry.target]].filter(Boolean);
  const bands = lids.map((id) => ctx.laneBand[id]).filter(Boolean);
  if (bands.length) {
    const y = Math.min(...bands.map((b) => b.y));
    const yMax = Math.max(...bands.map((b) => b.y + b.h));
    const x = Math.min(...bands.map((b) => b.x));
    const xMax = Math.max(...bands.map((b) => b.x + b.w));
    return { x, y, w: xMax - x, h: yMax - y };
  }
  return ctx.regionOf[ctx.partOf[entry.source]] ?? null;
}
const insideEnvelope = (pts, env, inset) => insideRegion(pts, env, inset);
const escapesEnvelope = (pts, env, inset) => !!env && !insideEnvelope(pts, env, inset);
/** Clamp a corridor Y into the envelope (keep a little air from the band edges). */
function clampCorridorY(y, env, inset) {
  if (!env) return y;
  const lo = env.y + inset, hi = env.y + env.h - inset;
  if (hi <= lo) return (env.y + env.y + env.h) / 2;
  return Math.max(lo, Math.min(hi, y));
}

/** Activities and events have a flow direction; gateways may be entered and left at any vertex. */
const hasFlowDirection = (ctx, id) => !isGateway(ctx.typeOf[id]);
/** Auto-join diamonds read as flow-through — prefer the same left-in habit as activities. */
const isAutoJoin = (id) => /^gw_join_/i.test(id || '');
/**
 * Sibling-aware gateway ports: with several ins (or outs), one left-in (right-out) is enough —
 * the others may use top/bottom. `pts` is the candidate for `selfId` when scoring a rewrite.
 */
function gatewayHasLeftIn(targetId, entries, selfId, pts) {
  for (const o of entries) {
    if (o.target !== targetId) continue;
    const side = o.id === selfId && pts ? entrySide(pts) : entrySide(o.points);
    if (side === 'left') return true;
  }
  return false;
}
function gatewayHasRightOut(sourceId, entries, selfId, pts) {
  for (const o of entries) {
    if (o.source !== sourceId) continue;
    const side = o.id === selfId && pts ? exitSide(pts) : exitSide(o.points);
    if (side === 'right') return true;
  }
  return false;
}
/**
 * Among edges that currently use the cardinal, pick the one that should keep it:
 * closest vertical alignment with the gateway (happy-path horizontal), then fewer bends.
 * Others must move to top/bottom — edge-list order alone put the wrong branch on the right
.
 */
function preferredLeftInId(targetId, entries, coords) {
  const ins = entries.filter((e) => e.target === targetId && entrySide(e.points) === 'left');
  if (ins.length <= 1) return ins[0]?.id ?? null;
  const tb = coords[targetId];
  const cy = tb.y + tb.h / 2;
  return [...ins].sort((a, b) => {
    const sa = coords[a.source], sb = coords[b.source];
    const da = Math.abs((sa.y + sa.h / 2) - cy);
    const db = Math.abs((sb.y + sb.h / 2) - cy);
    return da - db || bendCount(a.points) - bendCount(b.points);
  })[0].id;
}
function preferredRightOutId(sourceId, entries, coords) {
  const outs = entries.filter((e) => e.source === sourceId && exitSide(e.points) === 'right');
  if (outs.length <= 1) return outs[0]?.id ?? null;
  const sb = coords[sourceId];
  const cy = sb.y + sb.h / 2;
  return [...outs].sort((a, b) => {
    const ta = coords[a.target], tb = coords[b.target];
    const da = Math.abs((ta.y + ta.h / 2) - cy);
    const db = Math.abs((tb.y + tb.h / 2) - cy);
    return da - db || bendCount(a.points) - bendCount(b.points);
  })[0].id;
}
/** True when another edge is the preferred owner of the cardinal (this one should yield). */
function siblingOwnsLeft(targetId, entries, selfId, coords) {
  const pref = preferredLeftInId(targetId, entries, coords);
  return !!pref && pref !== selfId;
}
function siblingOwnsRight(sourceId, entries, selfId, coords) {
  const pref = preferredRightOutId(sourceId, entries, coords);
  return !!pref && pref !== selfId;
}
function incomingCount(targetId, entries) {
  let n = 0;
  for (const o of entries) if (o.target === targetId) n++;
  return n;
}
function outgoingCount(sourceId, entries) {
  let n = 0;
  for (const o of entries) if (o.source === sourceId) n++;
  return n;
}
/** In and out docked on the same gateway side (reads as a collision at one vertex). */
function gatewaySameSideInOut(nodeId, entries, selfId, pts, ctx) {
  if (!isGateway(ctx.typeOf[nodeId])) return false;
  const sidesIn = new Set(), sidesOut = new Set();
  for (const o of entries) {
    if (o.target === nodeId) {
      sidesIn.add(o.id === selfId && pts ? entrySide(pts) : entrySide(o.points));
    }
    if (o.source === nodeId) {
      sidesOut.add(o.id === selfId && pts ? exitSide(pts) : exitSide(o.points));
    }
  }
  for (const s of sidesIn) if (s && sidesOut.has(s)) return true;
  return false;
}
/**
 * Rule (2): one per end that faces against the flow direction.
 * Gateways with multiple ins/outs: only the missing cardinal (no left-in / no right-out) is
 * penalised — top/bottom siblings are fine once that cardinal exists. In+out on the same
 * gateway side always costs.
 */
function sidePenalty(pts, entry, ctx, entries = []) {
  let p = 0;
  if (hasFlowDirection(ctx, entry.target) && entrySide(pts) !== 'left') p++;
  if (!ctx.attached.has(entry.source) && hasFlowDirection(ctx, entry.source) && exitSide(pts) !== 'right') p++;
  // Miragon: a back-edge into a gateway should not enter from the left (mirrors incoming).
  // Counted here so Pass A/B/C share one potential and Pass C cannot oscillate on gateway-only flips.
  const sb = ctx.coords[entry.source], tb = ctx.coords[entry.target];
  if (sb && tb && isGateway(ctx.typeOf[entry.target])) {
    const backEdge = (sb.x + sb.w / 2) > (tb.x + tb.w / 2) + 10;
    if (backEdge && entrySide(pts) === 'left') p++;
    // Multi-in: need ≥1 left-in; further top/bottom ins are OK — but a *second*
    // left-in (earlier sibling already owns left) is not (shared vertex).
    else if (!backEdge && incomingCount(entry.target, entries) > 1) {
      if (entrySide(pts) !== 'left' && !gatewayHasLeftIn(entry.target, entries, entry.id, pts)) p++;
      else if (entrySide(pts) === 'left' && siblingOwnsLeft(entry.target, entries, entry.id, ctx.coords)) p++;
    }
  }
  // Multi-out gateway: need ≥1 right-out; a second right-out shares the vertex.
  if (sb && isGateway(ctx.typeOf[entry.source]) && outgoingCount(entry.source, entries) > 1) {
    if (exitSide(pts) !== 'right' && !gatewayHasRightOut(entry.source, entries, entry.id, pts)) p++;
    else if (exitSide(pts) === 'right' && siblingOwnsRight(entry.source, entries, entry.id, ctx.coords)) p++;
  }
  if (gatewaySameSideInOut(entry.target, entries, entry.id, pts, ctx)) p++;
  if (gatewaySameSideInOut(entry.source, entries, entry.id, pts, ctx)) p++;
  return p;
}

// ── candidates ──────────────────────────────────────────────────────────

/**
 * Where the counterpart's centre (or its current endpoint) projects onto `side` of a rectangle, if
 * that point lies on the side at least `margin` from both corners. The point is on the outline by
 * construction — a rectangle's side is straight — so no second clip is needed.
 */
function projectionOnSide(box, side, q, margin) {
  if (side === 'left' || side === 'right') {
    if (q.y < box.y + margin - EPS || q.y > box.y + box.h - margin + EPS) return null;
    return { x: side === 'left' ? box.x : box.x + box.w, y: q.y };
  }
  if (q.x < box.x + margin - EPS || q.x > box.x + box.w - margin + EPS) return null;
  return { x: q.x, y: side === 'top' ? box.y : box.y + box.h };
}

/**
 * Candidate ports of one end: the current endpoint, every side midpoint and — on a rectangle only —
 * the projections of `towards` (the counterpart's centre and current endpoint) onto each side. An
 * event or a gateway keeps its midpoints/vertices: a projection would be off the circle/diamond.
 */
function portsOf(box, point, fixed, noNewTopBottom, { rect = false, towards = [], margin = 0 } = {}) {
  const current = [{ p: point, side: sideOf(point, box), moved: false }];
  if (fixed) return current;
  const sides = SIDES.filter((s) => !(noNewTopBottom && (s === 'top' || s === 'bottom')));
  const out = [...current];
  const seen = new Set([`${point.x},${point.y}`]);
  const add = (p, side) => {
    const k = `${p.x},${p.y}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ p, side, moved: true });
  };
  for (const s of sides) add(sideMidpoint(box, s), s);
  if (rect) for (const s of sides) for (const q of towards) { const p = projectionOnSide(box, s, q, margin); if (p) add(p, s); }
  return out;
}

/** The 0/1/2-bend shapes for one port pair; `out`/`inn` are travel directions. */
function analyticShapes(s, out, t, inn, limits) {
  const res = [];
  const horizontal = (d) => d[0] !== 0;
  const { corridorReachPx: reach, corridorStepPx: step } = limits;
  if (horizontal(out) === horizontal(inn)) {
    if (sameDir(out, inn) && (horizontal(out) ? Math.abs(s.y - t.y) < EPS : Math.abs(s.x - t.x) < EPS)) res.push([s, t]);
    const [a, b] = horizontal(out) ? [s.x, t.x] : [s.y, t.y];
    const lo = Math.min(a, b) - reach, hi = Math.max(a, b) + reach;
    const corridors = new Set([(a + b) / 2]);
    for (let c = Math.ceil(lo / step) * step; c <= hi; c += step) corridors.add(c);
    for (const c of corridors) {
      res.push(horizontal(out) ? [s, { x: c, y: s.y }, { x: c, y: t.y }, t] : [s, { x: s.x, y: c }, { x: t.x, y: c }, t]);
    }
  } else {
    res.push([s, horizontal(out) ? { x: t.x, y: s.y } : { x: s.x, y: t.y }, t]);
  }
  return res;
}

function makeChecker(entry, entries, ctx, cfg) {
  const { limits, guards } = cfg;
  const curPts = entry.points;
  const sb = ctx.coords[entry.source], tb = ctx.coords[entry.target];
  const ss = ctx.shapeOf(entry.source), ts = ctx.shapeOf(entry.target);
  const region = regionFor(entry, ctx);
  const lines = ctx.linesOf[ctx.partOf[entry.source]] || [];
  const obstacles = Object.entries(ctx.coords)
    .filter(([id, b]) => id !== entry.source && id !== entry.target && !ctx.groups.has(id) && !contains(b, sb) && !contains(b, tb))
    .map(([, b]) => b);
  const cur = {
    len: pathLen(curPts),
    hug: laneLineHug(curPts, lines, limits.laneLineHugPx),
    cross: crossings(entry, curPts, entries),
    over: collinearOverlap(entry, curPts, entries, limits.collinearPx),
    crowd: guards.crowding ? crowdPairs(entry, curPts, entries, limits.crowdingPx) : 0,
    side: guards.sideConflicts ? sideConflicts(entry, curPts, entries) : 0,
    ports: guards.sharedPorts ? sharedPorts(entry, curPts, entries, ctx, limits.collinearPx) : 0,
    mf: guards.messageFlowPorts ? messageFlowLineOverlap(curPts, ctx, limits.messageFlowLinePx) : 0,
    lab: guards.nodeLabels ? nodeLabelHits(curPts, ctx.labelBoxes) : 0,
  };
  // Cheap geometric tests first, the ones comparing against every other route last.
  const check = (pts, outDir, inDir) => {
    if (!isOrthogonal(pts)) return false;
    const S = segsOf(pts);
    if (!S.length) return false;
    if (!sameDir(dirOf(S[0]), outDir) || !sameDir(dirOf(S[S.length - 1]), inDir)) return false;
    if (bendCount(pts) >= 1 && (segLen(S[0]) < cfg.stubPx || segLen(S[S.length - 1]) < cfg.stubPx)) return false;
    if (guards.length && pathLen(pts) > cur.len * limits.lengthFactor + limits.lengthSlackPx) return false;
    if (hasEndDefect(pts, sb, tb, ss, ts, cfg.alongMinPx)) return false;
    if (guards.region && !insideRegion(pts, region, limits.regionInset)) return false;
    for (const s of S) for (const o of obstacles) if (!segmentClearOfBox(s, o, limits.shapeClearance)) return false;
    if (laneLineHug(pts, lines, limits.laneLineHugPx) > cur.hug + EPS) return false;
    if (crossings(entry, pts, entries) > cur.cross) return false;
    if (collinearOverlap(entry, pts, entries, limits.collinearPx) > cur.over + EPS) return false;
    if (guards.crowding && crowdPairs(entry, pts, entries, limits.crowdingPx) > cur.crowd) return false;
    if (guards.sideConflicts && sideConflicts(entry, pts, entries) > cur.side) return false;
    if (guards.sharedPorts && sharedPorts(entry, pts, entries, ctx, limits.collinearPx) > cur.ports) return false;
    if (guards.messageFlowPorts && messageFlowLineOverlap(pts, ctx, limits.messageFlowLinePx) > cur.mf + EPS) return false;
    if (guards.nodeLabels && nodeLabelHits(pts, ctx.labelBoxes) > cur.lab) return false;
    return true;
  };
  return { check, obstacles, sb, tb };
}

/**
 * Admissible routes for one edge at the lowest bend count found, at most `maxBends`: the analytic
 * 0/1/2-bend shapes first, the orthogonal router only when none of them qualifies. `targetSide`
 * restricts the target port to one entry side. Returns { minBends, cands: [{ pts, moved }] } or null.
 */
function search(entry, entries, ctx, cfg, { maxBends = Infinity, targetSide = null } = {}) {
  const cur = entry.points;
  const curSegs = segsOf(cur);
  if (!curSegs.length) return null;
  const { check, obstacles, sb, tb } = makeChecker(entry, entries, ctx, cfg);
  const mfGuard = cfg.guards.messageFlowPorts;
  const centre = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const margin = cfg.limits.portCornerMarginPx;
  const sPorts = portsOf(sb, cur[0], ctx.attached.has(entry.source), mfGuard && ctx.mfNodes.has(entry.source),
    { rect: ctx.shapeOf(entry.source) === 'rect', towards: [centre(tb), cur[cur.length - 1]], margin })
    .map((q) => ({ ...q, dir: q.side ? OUTWARD[q.side] : dirOf(curSegs[0]) }));
  let tPorts = portsOf(tb, cur[cur.length - 1], false, mfGuard && ctx.mfNodes.has(entry.target),
    { rect: ctx.shapeOf(entry.target) === 'rect', towards: [centre(sb), cur[0]], margin })
    .map((q) => ({ ...q, dir: q.side ? INWARD[q.side] : dirOf(curSegs[curSegs.length - 1]) }));
  if (targetSide) tPorts = tPorts.filter((q) => entrySideOfDir(q.dir) === targetSide);

  const byLevel = new Map();
  for (const s of sPorts) for (const t of tPorts) {
    for (const raw of analyticShapes(s.p, s.dir, t.p, t.dir, cfg.limits)) {
      const pts = withoutCollinear(raw);
      const b = bendCount(pts);
      if (b > maxBends || !check(pts, s.dir, t.dir)) continue;
      if (!byLevel.has(b)) byLevel.set(b, []);
      byLevel.get(b).push({ pts, moved: (s.moved ? 1 : 0) + (t.moved ? 1 : 0) });
    }
  }
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  if (levels.length) {
    return { minBends: levels[0], cands: byLevel.get(levels[0]), byLevel };
  }
  if (maxBends <= 2 || !cfg.router) return null;

  const routed = [];
  for (const s of sPorts) for (const t of tPorts) {
    const s1 = { x: s.p.x + s.dir[0] * cfg.stubPx, y: s.p.y + s.dir[1] * cfg.stubPx };
    const e1 = { x: t.p.x - t.dir[0] * cfg.stubPx, y: t.p.y - t.dir[1] * cfg.stubPx };
    const mid = routeAroundObstacles(s1, dirName(s.dir), e1, dirName(t.dir), [...obstacles, sb, tb],
      { maxGridPoints: cfg.routerMaxGridPoints });
    if (!mid) continue;
    const pts = withoutCollinear([s.p, ...mid, t.p]);
    const b = bendCount(pts);
    if (b > maxBends || !check(pts, s.dir, t.dir)) continue;
    routed.push({ pts, b, moved: (s.moved ? 1 : 0) + (t.moved ? 1 : 0) });
  }
  if (!routed.length) return null;
  const m = Math.min(...routed.map((r) => r.b));
  const routedByLevel = new Map();
  for (const r of routed) {
    if (!routedByLevel.has(r.b)) routedByLevel.set(r.b, []);
    routedByLevel.get(r.b).push({ pts: r.pts, moved: r.moved });
  }
  return { minBends: m, cands: routed.filter((r) => r.b === m).map(({ pts, moved }) => ({ pts, moved })), byLevel: routedByLevel };
}

function resolveConfig(opts) {
  return {
    limits: bendRuleLimits(opts.limits),
    guards: { ...DEFAULT_GUARDS, ...(opts.guards ?? {}) },
    stubPx: CFG.layout?.endStubPx ?? 15,
    alongMinPx: CFG.layout?.alongOutlineMinPx ?? 5,
    router: CFG.layout?.orthogonalRouterEnabled !== false,
    routerMaxGridPoints: CFG.layout?.orthogonalRouterMaxGridPoints,
  };
}

/** The routes the pass and the measure work on: every edge with a route, `skipIds` left out. */
function entriesOf(coordMap, edges, skipIds) {
  return edges
    .filter((e) => !skipIds.has(e.id) && coordMap.edgeCoords?.[e.id]?.length >= 2)
    .map((e) => ({ id: e.id, source: e.source, target: e.target, points: coordMap.edgeCoords[e.id] }));
}
/** A self-loop and an edge missing an endpoint's box are left alone. */
const inScope = (e, coords) => e.source !== e.target && !!coords[e.source] && !!coords[e.target];

function lexCompare(x, y) {
  for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return x[k] - y[k];
  return 0;
}
const ptsEqual = (a, b) => a.length === b.length
  && a.every((p, i) => Math.abs(p.x - b[i].x) < EPS && Math.abs(p.y - b[i].y) < EPS);

/**
 * The pass. Returns the new edgeCoords — the same object when nothing changed; a changed edge gets a
 * new array, every other edge keeps its own (the reference test refreshMovedLabels relies on).
 *
 * @param {object} coordMap { coords, laneCoords, poolCoords, edgeCoords, nodeLabels }
 * @param {object} lc Logic-Core (node types, lanes, message flows, boundary events)
 * @param {object} [opts]
 * @param {object[]} [opts.edges] the sequence flows to consider, in order (default: every one of `lc`)
 * @param {Set<string>} [opts.skipIds] edge ids never touched and never counted (associations)
 * @param {object} [opts.limits] overrides of bendRuleLimits()
 * @param {object} [opts.guards] guards to switch off — tests only
 */
export function applyBendRule(coordMap, lc, opts = {}) {
  const cfg = resolveConfig(opts);
  const ctx = buildContext(coordMap, lc, opts);
  const entries = entriesOf(coordMap, opts.edges ?? sequenceFlowsOf(lc), opts.skipIds ?? new Set());
  const changed = new Map();
  let progress = true;
  // Pass B/C may raise bends to cut sidePenalty; without a budget/potential guard that can
  // undo Pass A's fewer-bend pick and oscillate (node-label fixture: L ↔ Z). Cap sweeps and
  // break on a repeated full route fingerprint so the pass always terminates.
  const seen = new Set();
  let sweeps = 0;
  const maxSweeps = Math.max(32, entries.length * 4);
  while (progress) {
    progress = false;
    if (++sweeps > maxSweeps) break;
    const fp = entries.map((e) => `${e.id}:${e.points.map((p) => `${p.x},${p.y}`).join('/')}`).join('|');
    if (seen.has(fp)) break;
    seen.add(fp);
    for (const en of entries) {
      if (!inScope(en, ctx.coords)) continue;
      const curBends = bendCount(en.points), curPenalty = sidePenalty(en.points, en, ctx, entries);
      const scoreCand = (c) => {
        const S = segsOf(c.pts), a = c.pts[0], z = c.pts[c.pts.length - 1];
        let offCentre = 0;
        if (S.length === 3) {
          const m = S[1];
          offCentre = Math.abs(m[0].x - m[1].x) < EPS ? Math.abs(m[0].x - (a.x + z.x) / 2) : Math.abs(m[0].y - (a.y + z.y) / 2);
        }
        return {
          pts: c.pts,
          bends: bendCount(c.pts),
          score: [sidePenalty(c.pts, en, ctx, entries), crossings(en, c.pts, entries), c.moved, Math.round(pathLen(c.pts)), offCentre],
        };
      };
      // Pass A — fewest bends first (unchanged contract): only routes at ≤ current bends.
      const rA = search(en, entries, ctx, cfg, { maxBends: curBends });
      if (rA) {
        const scoredA = rA.cands.map(scoreCand);
        scoredA.sort((x, y) => lexCompare(x.score, y.score));
        const bestA = scoredA[0];
        // Fewest bends always wins when no side budget (legacy). With a side budget,
        // fewer bends may not *raise* side — and must not trade one Miragon defect for
        // another at equal penalty. Strict side improvement, or keep a clean (0) side.
        const budgetOn = (cfg.limits.sideBendBudget ?? 0) > 0;
        const fewer = rA.minBends < curBends
          && (!budgetOn || bestA.score[0] < curPenalty || bestA.score[0] === 0);
        const betterSide = rA.minBends === curBends && bestA.score[0] < curPenalty;
        if ((fewer || betterSide) && !ptsEqual(bestA.pts, en.points)) {
          en.points = bestA.pts;
          changed.set(en.id, bestA.pts);
          progress = true;
          continue;
        }
      }
      // Pass B — Miragon left-in / right-out: spend sideBendBudget extra bends only when the
      // current route still has a side penalty after pass A. Back-edges (source right of
      // target) get backEdgeBendBudget on top — reject/rework loops need the detour.
      const penaltyNow = sidePenalty(en.points, en, ctx, entries);
      const sb = ctx.coords[en.source], tb = ctx.coords[en.target];
      const backEdge = sb && tb && (sb.x + sb.w / 2) > (tb.x + tb.w / 2) + 10;
      const env = envelopeFor(en, ctx);
      const inset = cfg.limits.regionInset;
      if (penaltyNow > 0) {
        const budget = (cfg.limits.sideBendBudget ?? 0)
          + (backEdge ? (cfg.limits.backEdgeBendBudget ?? 0) : 0);
        if (budget > 0) {
          const rB = search(en, entries, ctx, cfg, { maxBends: curBends + budget });
          if (rB?.byLevel) {
            const poolB = [];
            for (const [b, cs] of rB.byLevel) {
              if (b <= curBends || b > curBends + budget) continue;
              for (const c of cs) poolB.push(c);
            }
            if (poolB.length) {
              const scoredB = poolB.map(scoreCand);
              scoredB.sort((x, y) => lexCompare(
                [x.score[0], x.bends, x.score[1], x.score[2], x.score[3], x.score[4]],
                [y.score[0], y.bends, y.score[1], y.score[2], y.score[3], y.score[4]],
              ));
              const bestB = scoredB[0];
              if (bestB.score[0] < penaltyNow && !ptsEqual(bestB.pts, en.points)) {
                en.points = bestB.pts;
                changed.set(en.id, bestB.pts);
                progress = true;
                continue;
              }
            }
          }
        }
      }
      // Pass C — Miragon connection-side U-turns. Activities/events: right-out / left-in.
      // Multi-in/out gateways: only the missing cardinal (no left-in / no right-out) needs a
      // rewrite — siblings may stay top/bottom. A second edge must not share that cardinal
      // (or the same side as an opposite-direction flow). Envelope escapes also rewrite.
      const penaltyAfter = sidePenalty(en.points, en, ctx, entries);
      const srcIsGw = isGateway(ctx.typeOf[en.source]);
      const tgtIsGw = isGateway(ctx.typeOf[en.target]);
      const multiIn = tgtIsGw && incomingCount(en.target, entries) > 1;
      const multiOut = srcIsGw && outgoingCount(en.source, entries) > 1;
      const sibOwnsLeft = multiIn && entrySide(en.points) === 'left'
        && siblingOwnsLeft(en.target, entries, en.id, ctx.coords);
      const sibOwnsRight = multiOut && exitSide(en.points) === 'right'
        && siblingOwnsRight(en.source, entries, en.id, ctx.coords);
      const srcNeedsRight = (hasFlowDirection(ctx, en.source)
        || (multiOut && !gatewayHasRightOut(en.source, entries, en.id, en.points)))
        && exitSide(en.points) !== 'right';
      const tgtNeedsLeft = (hasFlowDirection(ctx, en.target)
        || (!backEdge && multiIn && !gatewayHasLeftIn(en.target, entries, en.id, en.points)))
        && entrySide(en.points) !== 'left';
      // Back-edge into a gateway: prefer right-in, but not when the join already exits
      // right (in+out on the same vertex) — then top/bottom in.
      const joinRightTakenByOut = tgtIsGw && entries.some((o) =>
        o.id !== en.id && o.source === en.target && exitSide(o.points) === 'right');
      const enterFromRight = backEdge && tgtIsGw && !joinRightTakenByOut;
      // Second multi-in on a left already taken → dock top/bottom (not another left).
      // Same when yielding a shared right-out into a join that already has a left-in:
      // the free docks are top/bottom.
      const joinLeftTaken = multiIn && gatewayHasLeftIn(en.target, entries, en.id, en.points)
        && entrySide(en.points) !== 'left';
      const enterFromTopBottom = (!enterFromRight && (sibOwnsLeft || (sibOwnsRight && joinLeftTaken)))
        || (backEdge && tgtIsGw && joinRightTakenByOut);
      const gwNeedsNonLeft = enterFromRight && entrySide(en.points) === 'left';
      const sameSideIO = gatewaySameSideInOut(en.source, entries, en.id, en.points, ctx)
        || gatewaySameSideInOut(en.target, entries, en.id, en.points, ctx);
      const escapes = escapesEnvelope(en.points, env, inset);
      if (penaltyAfter <= 0 && !srcNeedsRight && !tgtNeedsLeft && !gwNeedsNonLeft
        && !sibOwnsLeft && !sibOwnsRight && !sameSideIO && !escapes) continue;
      if (!sb || !tb) continue;
      const cardinalRepair = sibOwnsLeft || sibOwnsRight || (srcNeedsRight && enterFromTopBottom);
      const cfgLoose = {
        ...cfg,
        guards: {
          ...cfg.guards,
          // Length / region / sideConflicts yield to Miragon left-in / right-out; keep
          // nodeLabels, crowding, and sharedPorts so Pass C cannot undo those guards
          // (label + crowding fixtures: Z → L through a gateway label at equal bends).
          length: false,
          region: false,
          sideConflicts: false,
          // Shared-cardinal / activity right-out + top-in repairs need a little more room
          // through busy charts.
          ...(cardinalRepair ? {
            crowding: false,
            nodeLabels: false,
            sharedPorts: false,
          } : {}),
        },
        limits: cardinalRepair
          ? { ...cfg.limits, shapeClearance: Math.min(cfg.limits.shapeClearance ?? 8, 2) }
          : cfg.limits,
      };
      const { check } = makeChecker(en, entries, ctx, cfgLoose);
      const stub = cfg.stubPx;
      const curExit = en.points[0];
      // Activity: prefer current right tip, else mid-right. Gateway: keep the current tip when it
      // already sits on a side, else try every side midpoint (never force right onto a busy port).
      const sPorts = [];
      if (!srcIsGw) {
        const onRight = exitSide(en.points) === 'right' && !sibOwnsRight;
        sPorts.push({
          p: onRight ? { x: sb.x + sb.w, y: curExit.y } : { x: sb.x + sb.w, y: sb.y + sb.h / 2 },
          out: OUTWARD.right,
        });
        // Back-edge / top-bottom repair: also try right-face ports near the corridor so the
        // mandatory right stub sits next to the above/below run (short hook, not a mid-height fold).
        if (enterFromTopBottom || (backEdge && srcNeedsRight)) {
          const margin = cfg.limits.portCornerMarginPx ?? 20;
          const yLo = sb.y + margin, yHi = sb.y + sb.h - margin;
          for (const yAim of [
            Math.min(sb.y, tb.y) - Math.max(40, stub * 2),
            Math.max(sb.y + sb.h, tb.y + tb.h) + Math.max(40, stub * 2),
          ]) {
            const y = Math.max(yLo, Math.min(yHi, yAim));
            const p = { x: sb.x + sb.w, y };
            if (sPorts.every((q) => Math.abs(q.p.y - p.y) > 1)) {
              sPorts.push({ p, out: OUTWARD.right });
            }
          }
        }
      } else if (sibOwnsRight) {
        // Second multi-out: leave top/bottom — keep the sibling's right free.
        for (const s of ['top', 'bottom']) {
          sPorts.push({ p: sideMidpoint(sb, s), out: OUTWARD[s] });
        }
      } else {
        const curSide = sideOf(curExit, sb) || exitSide(en.points);
        if (curSide) sPorts.push({ p: sideMidpoint(sb, curSide), out: OUTWARD[curSide] });
        for (const s of SIDES) {
          if (s === curSide) continue;
          sPorts.push({ p: sideMidpoint(sb, s), out: OUTWARD[s] });
        }
      }
      const tIns = enterFromRight
        ? [{ p: { x: tb.x + tb.w, y: tb.y + tb.h / 2 }, in: INWARD.right }]
        : enterFromTopBottom
          ? [
            { p: { x: tb.x + tb.w / 2, y: tb.y }, in: INWARD.top },
            { p: { x: tb.x + tb.w / 2, y: tb.y + tb.h }, in: INWARD.bottom },
          ]
          : [{ p: { x: tb.x, y: tb.y + tb.h / 2 }, in: INWARD.left }];
      // Corridor Ys stay inside the lane/participant envelope — Pass C used to set
      // region:false for Miragon U-turns and climbed into the chart margin.
      const belowY = clampCorridorY(
        Math.max(sb.y + sb.h, tb.y + tb.h) + Math.max(40, stub * 2), env, inset);
      const aboveY = clampCorridorY(
        Math.min(sb.y, tb.y) - Math.max(40, stub * 2), env, inset);
      // Deep below/above / far right/left of every laid-out shape so a far corridor clears
      // foreign verticals and does not thread a neighbour's bbox.
      let deepBelow = belowY, deepAbove = aboveY;
      let rightX = Math.max(sb.x + sb.w, tb.x + tb.w) + Math.max(40, stub * 2);
      let leftX = Math.min(sb.x, tb.x) - Math.max(40, stub * 2);
      for (const [oid, box] of Object.entries(ctx.coords)) {
        if (oid === en.source || oid === en.target) continue;
        deepBelow = Math.max(deepBelow, box.y + box.h + Math.max(40, stub * 2));
        deepAbove = Math.min(deepAbove, box.y - Math.max(40, stub * 2));
        rightX = Math.max(rightX, box.x + box.w + Math.max(40, stub * 2));
        leftX = Math.min(leftX, box.x - Math.max(40, stub * 2));
      }
      deepBelow = clampCorridorY(deepBelow, env, inset);
      deepAbove = clampCorridorY(deepAbove, env, inset);
      const candidates = [];
      const addCand = (out, inDir, raw) => { candidates.push({ out, inDir, raw }); };
      for (const { p: sDock, out } of sPorts) {
        for (const { p: tIn, in: inDir } of tIns) {
          const midX = (sDock.x + tIn.x) / 2;
          const levelY = tIn.y;
          if (enterFromRight) {
            addCand(out, inDir, [sDock, { x: sDock.x + stub, y: sDock.y }, { x: sDock.x + stub, y: belowY },
              { x: tIn.x + stub, y: belowY }, { x: tIn.x + stub, y: tIn.y }, tIn]);
            addCand(out, inDir, [sDock, { x: sDock.x + stub, y: sDock.y }, { x: sDock.x + stub, y: aboveY },
              { x: tIn.x + stub, y: aboveY }, { x: tIn.x + stub, y: tIn.y }, tIn]);
            addCand(out, inDir, [sDock, { x: rightX, y: sDock.y }, { x: rightX, y: tIn.y }, tIn]);
            addCand(out, inDir, [sDock, { x: sDock.x + stub, y: sDock.y }, { x: sDock.x + stub, y: aboveY },
              { x: midX, y: aboveY }, { x: midX, y: tIn.y }, tIn]);
          } else if (enterFromTopBottom) {
            // First leg must travel in `out` (activity right-out, or gateway top/bottom when
            // yielding a shared cardinal); then a corridor to the free top/bottom in-dock.
            // Long back-edges need above/below corridors — a mid-height run hits every node
            // between Rework and the join.
            const stubOut = {
              x: sDock.x + out[0] * stub,
              y: sDock.y + out[1] * stub,
            };
            const stubIn = {
              x: tIn.x - inDir[0] * stub,
              y: tIn.y - inDir[1] * stub,
            };
            addCand(out, inDir, [sDock, stubOut, { x: stubIn.x, y: stubOut.y }, stubIn, tIn]);
            addCand(out, inDir, [sDock, stubOut, { x: midX, y: stubOut.y }, { x: midX, y: stubIn.y },
              stubIn, tIn]);
            addCand(out, inDir, [sDock, stubOut, { x: rightX, y: stubOut.y }, { x: rightX, y: stubIn.y },
              stubIn, tIn]);
            addCand(out, inDir, [sDock, stubOut, { x: stubOut.x, y: aboveY }, { x: stubIn.x, y: aboveY },
              stubIn, tIn]);
            addCand(out, inDir, [sDock, stubOut, { x: stubOut.x, y: belowY }, { x: stubIn.x, y: belowY },
              stubIn, tIn]);
            addCand(out, inDir, [sDock, stubOut, { x: stubOut.x, y: deepAbove }, { x: stubIn.x, y: deepAbove },
              stubIn, tIn]);
            addCand(out, inDir, [sDock, stubOut, { x: stubOut.x, y: deepBelow }, { x: stubIn.x, y: deepBelow },
              stubIn, tIn]);
            // Local far-right then corridor: first leg past the source/target only (not the
            // chart-wide rightX). Enough length that the
            // reverse is a deliberate U-turn, not a 20px right stub folded left.
            if (out[0] > 0) {
              const localRightX = Math.max(sb.x + sb.w, tb.x + tb.w) + Math.max(80, stub * 4);
              for (const cy of [aboveY, belowY, deepAbove, deepBelow, stubIn.y]) {
                addCand(out, inDir, [sDock, { x: localRightX, y: sDock.y }, { x: localRightX, y: cy },
                  { x: stubIn.x, y: cy }, stubIn, tIn]);
              }
            }
          } else {
            const corridor = Math.max(sDock.x + stub, tIn.x - stub);
            const stubOut = {
              x: sDock.x + (out[0] !== 0 ? stub * out[0] : 0),
              y: sDock.y + (out[1] !== 0 ? stub * out[1] : 0),
            };
            // Direct-ish: out → vertical → left in.
            addCand(out, inDir, [sDock, { x: corridor, y: sDock.y }, { x: corridor, y: levelY },
              { x: tIn.x - stub, y: levelY }, tIn]);
            addCand(out, inDir, [sDock, stubOut, { x: stubOut.x, y: levelY },
              { x: tIn.x - stub, y: levelY }, tIn]);
            addCand(out, inDir, [sDock, { x: sDock.x + stub, y: sDock.y }, { x: sDock.x + stub, y: belowY },
              { x: tIn.x - stub, y: belowY }, { x: tIn.x - stub, y: tIn.y }, tIn]);
            addCand(out, inDir, [sDock, { x: sDock.x + stub, y: sDock.y }, { x: sDock.x + stub, y: aboveY },
              { x: tIn.x - stub, y: aboveY }, { x: tIn.x - stub, y: tIn.y }, tIn]);
            // Far-right then back at levelY (short) or deepBelow/deepAbove (clears foreign verticals).
            addCand(out, inDir, [sDock, { x: rightX, y: sDock.y }, { x: rightX, y: levelY },
              { x: tIn.x - stub, y: levelY }, tIn]);
            addCand(out, inDir, [sDock, { x: rightX, y: sDock.y }, { x: rightX, y: deepBelow },
              { x: tIn.x - stub, y: deepBelow }, { x: tIn.x - stub, y: tIn.y }, tIn]);
            addCand(out, inDir, [sDock, { x: rightX, y: sDock.y }, { x: rightX, y: deepAbove },
              { x: tIn.x - stub, y: deepAbove }, { x: tIn.x - stub, y: tIn.y }, tIn]);
            // Far-left corridor when the source is a gateway already exiting top/left.
            addCand(out, inDir, [sDock, { x: leftX, y: sDock.y }, { x: leftX, y: levelY },
              { x: tIn.x - stub, y: levelY }, tIn]);
            // Axis-aligned from a gateway top/bottom tip straight to the target's left mid y.
            addCand(out, inDir, [sDock, { x: sDock.x, y: levelY }, { x: tIn.x - stub, y: levelY }, tIn]);
          }
        }
      }
      let bestC = null;
      const curBendsC = bendCount(en.points);
      const budgetC = (cfg.limits.sideBendBudget ?? 0)
        + (backEdge ? (cfg.limits.backEdgeBendBudget ?? 0) : 0);
      for (const { out: outDir, inDir, raw } of candidates) {
        const pts = withoutCollinear(raw);
        // Full check only (cfgLoose already drops length/region/crowding/labels/sideConflicts).
        // A soft orthogonal fallback used to skip sharedPorts / crossings and re-broke those guards.
        const ok = check(pts, outDir, inDir);
        if (!ok) continue;
        // Lane/participant envelope is always on — even when region:false for Miragon U-turns.
        if (escapesEnvelope(pts, env, inset)) continue;
        const pen = sidePenalty(pts, en, ctx, entries);
        if (gatewaySameSideInOut(en.source, entries, en.id, pts, ctx)
          || gatewaySameSideInOut(en.target, entries, en.id, pts, ctx)) continue;
        // Do not recreate a shared cardinal when an earlier sibling already owns it.
        if (multiIn && entrySide(pts) === 'left' && siblingOwnsLeft(en.target, entries, en.id, ctx.coords)) continue;
        if (multiOut && exitSide(pts) === 'right' && siblingOwnsRight(en.source, entries, en.id, ctx.coords)) continue;
        const b = bendCount(pts);
        // Strict side improvement, or equal side when repairing envelope / same-side IO / shared cardinal.
        if (pen > penaltyAfter) continue;
        if (pen === penaltyAfter && !escapes && !sameSideIO && !sibOwnsLeft && !sibOwnsRight) continue;
        if (b - curBendsC > budgetC) continue;
        // Prefer no slight left↔right / up↔down kinks; then fewer folds; then shorter overall.
        const score = [
          pen,
          escapesEnvelope(pts, env, inset) ? 1 : 0,
          slightFoldPenalty(pts, stub),
          axisFolds(pts),
          b,
          Math.round(pathLen(pts)),
        ];
        if (!bestC || lexCompare(score, bestC.score) < 0) bestC = { pts, score };
      }
      if (bestC && !ptsEqual(bestC.pts, en.points)) {
        en.points = bestC.pts;
        changed.set(en.id, bestC.pts);
        progress = true;
      }
    }
  }
  if (!changed.size) return coordMap.edgeCoords;
  const out = { ...coordMap.edgeCoords };
  for (const [id, p] of changed) out[id] = p;
  return out;
}

/**
 * The measure, on any coordMap (the final one included): per sequence flow the current bends, the
 * fewest bends of an admissible route, and whether it enters an activity/event against the flow
 * although an admissible left entry with no more bends exists.
 *
 * @returns {{ scope: number, avoidableBends: number, avoidableEdges: number, againstFlowEntries: number,
 *   perEdge: Object<string, { bends: number, minBends: number, entry: string|null, againstFlow: boolean }> }}
 */
export function bendMetrics(coordMap, lc, opts = {}) {
  const cfg = resolveConfig(opts);
  const ctx = buildContext(coordMap, lc, opts);
  const entries = entriesOf(coordMap, opts.edges ?? sequenceFlowsOf(lc), opts.skipIds ?? new Set());
  const perEdge = {};
  let scope = 0, avoidableBends = 0, avoidableEdges = 0, againstFlowEntries = 0;
  for (const en of entries) {
    if (!inScope(en, ctx.coords)) continue;
    scope++;
    const bends = bendCount(en.points);
    const r = search(en, entries, ctx, cfg, { maxBends: bends });
    const minBends = r ? Math.min(r.minBends, bends) : bends;
    let againstFlow = false;
    if (hasFlowDirection(ctx, en.target) && entrySide(en.points) !== 'left') {
      const budget = cfg.limits.sideBendBudget ?? 0;
      againstFlow = !!search(en, entries, ctx, cfg, { maxBends: bends + budget, targetSide: 'left' });
    }
    avoidableBends += bends - minBends;
    if (bends > minBends) avoidableEdges++;
    if (againstFlow) againstFlowEntries++;
    perEdge[en.id] = { bends, minBends, entry: entrySide(en.points), againstFlow };
  }
  return { scope, avoidableBends, avoidableEdges, againstFlowEntries, perEdge };
}

/**
 * Post-layout check: every flow-node box sits in its lane band, and every sequence-flow
 * waypoint stays inside the vertical union of its endpoints' lanes (or the participant
 * region when lanes are absent). Cross-lane edges may cross separators; they must not
 * leave the union band into the pool header / chart margin.
 *
 * @returns {{ shapeViolations: string[], edgeViolations: string[], ok: boolean }}
 */
export function laneContainmentMetrics(coordMap, lc, opts = {}) {
  const cfg = resolveConfig(opts);
  const inset = cfg.limits.regionInset ?? 10;
  const ctx = buildContext(coordMap, lc, opts);
  const shapeViolations = [];
  for (const [id, box] of Object.entries(coordMap.coords || {})) {
    const lid = ctx.laneOf[id];
    if (!lid) continue;
    const band = ctx.laneBand[lid];
    if (!band) continue;
    if (box.y < band.y - 0.5 || box.y + box.h > band.y + band.h + 0.5
      || box.x + box.w < band.x - 0.5 || box.x > band.x + band.w + 0.5) {
      shapeViolations.push(id);
    }
  }
  const edgeViolations = [];
  const entries = entriesOf(coordMap, opts.edges ?? sequenceFlowsOf(lc), opts.skipIds ?? new Set());
  for (const en of entries) {
    if (!inScope(en, ctx.coords)) continue;
    const env = envelopeFor(en, ctx);
    if (escapesEnvelope(en.points, env, inset)) edgeViolations.push(en.id);
  }
  return { shapeViolations, edgeViolations, ok: shapeViolations.length === 0 && edgeViolations.length === 0 };
}
