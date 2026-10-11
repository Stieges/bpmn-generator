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
 * not entered from the left +1, an activity/event source not left to the right +1). Ties: crossings,
 * moved endpoints, length, corridor nearest the middle. The pass repeats until nothing changes —
 * each replacement lowers 3 × bends + side penalty of one edge and touches no other edge's, so it
 * ends — which makes it idempotent: a second run finds nothing to do.
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
  portCornerMarginPx: 15,
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

function buildContext(coordMap, lc) {
  const procs = lc.pools ? lc.pools : [lc];
  const typeOf = {}, partOf = {}, attached = new Set(), expanded = new Set(), groups = new Set();
  for (const p of procs) {
    const pid = p.id ?? '_singlePool';
    const walk = (nodes) => {
      for (const n of nodes || []) {
        typeOf[n.id] = n.type; partOf[n.id] = pid;
        if (n.attachedTo) attached.add(n.id);
        if (n.type === 'group') groups.add(n.id);
        if (n.isExpanded && n.nodes?.length) expanded.add(n.id);
        walk(n.nodes);
      }
    };
    walk(p.nodes);
  }
  for (const g of lc.groups || []) groups.add(g.id);
  const shapeOf = (id) => (isEvent(typeOf[id]) ? 'circle' : isGateway(typeOf[id]) ? 'diamond' : 'rect');
  // Region of each participant (its lane stack, else its pool body right of the header) and its inner lane lines.
  const regionOf = {}, linesOf = {};
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
  return { coords: coordMap.coords, labelBoxes, mfNodes, typeOf, partOf, attached, expanded, groups, shapeOf, regionOf, linesOf };
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

/** Activities and events have a flow direction; gateways may be entered and left at any vertex. */
const hasFlowDirection = (ctx, id) => !isGateway(ctx.typeOf[id]);
/** Rule (2): one per end that faces against the flow direction. */
function sidePenalty(pts, entry, ctx) {
  let p = 0;
  if (hasFlowDirection(ctx, entry.target) && entrySide(pts) !== 'left') p++;
  if (!ctx.attached.has(entry.source) && hasFlowDirection(ctx, entry.source) && exitSide(pts) !== 'right') p++;
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
  if (levels.length) return { minBends: levels[0], cands: byLevel.get(levels[0]) };
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
  return { minBends: m, cands: routed.filter((r) => r.b === m) };
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
  const ctx = buildContext(coordMap, lc);
  const entries = entriesOf(coordMap, opts.edges ?? sequenceFlowsOf(lc), opts.skipIds ?? new Set());
  const changed = new Map();
  let progress = true;
  while (progress) {
    progress = false;
    for (const en of entries) {
      if (!inScope(en, ctx.coords)) continue;
      const curBends = bendCount(en.points), curPenalty = sidePenalty(en.points, en, ctx);
      const r = search(en, entries, ctx, cfg, { maxBends: curBends });
      if (!r) continue;
      const scored = r.cands.map((c) => {
        const S = segsOf(c.pts), a = c.pts[0], z = c.pts[c.pts.length - 1];
        let offCentre = 0;
        if (S.length === 3) {
          const m = S[1];
          offCentre = Math.abs(m[0].x - m[1].x) < EPS ? Math.abs(m[0].x - (a.x + z.x) / 2) : Math.abs(m[0].y - (a.y + z.y) / 2);
        }
        return { pts: c.pts, score: [sidePenalty(c.pts, en, ctx), crossings(en, c.pts, entries), c.moved, Math.round(pathLen(c.pts)), offCentre] };
      });
      scored.sort((x, y) => lexCompare(x.score, y.score));
      const best = scored[0];
      if (r.minBends < curBends || (r.minBends === curBends && best.score[0] < curPenalty)) {
        en.points = best.pts;
        changed.set(en.id, best.pts);
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
  const ctx = buildContext(coordMap, lc);
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
      againstFlow = !!search(en, entries, ctx, cfg, { maxBends: bends, targetSide: 'left' });
    }
    avoidableBends += bends - minBends;
    if (bends > minBends) avoidableEdges++;
    if (againstFlow) againstFlowEntries++;
    perEdge[en.id] = { bends, minBends, entry: entrySide(en.points), againstFlow };
  }
  return { scope, avoidableBends, avoidableEdges, againstFlowEntries, perEdge };
}
