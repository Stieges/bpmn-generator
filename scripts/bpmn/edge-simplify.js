/**
 * edge-simplify.js — Post-process ELK edge waypoints: reduce zigzag, and
 * repair crossings our own re-routing introduced.
 *
 * ELK's layered algorithm produces orthogonal edges with intermediate
 * "jog" bends at layer-column boundaries, even when those bends aren't
 * necessary to avoid nodes. For cross-lane edges spanning many layers
 * this produces visible zigzags (5+ waypoints for a path that could be
 * a 3-waypoint L-shape).
 *
 * This module post-processes each edge: if a single-bend L-shape clears all
 * node boxes and crosses both endpoint outlines, use it; if every clear L would
 * lie on an endpoint's outline (#52), try the simplest two/three-bend or stubbed
 * route that does not — see simplifyEdge; guardAgainstLegacy then reverts any
 * single edge whose new route costs a crossing, and reclipStuckEnds re-routes an
 * edge that still ends along or runs through its own shape.
 *
 * Pure function. Doesn't mutate ELK's coordMap if no simplification is
 * possible. Doesn't touch edges that are already straight (2 waypoints)
 * or single-bend (3 waypoints).
 */

import { routeAroundObstacles } from './orthogonal-router.js';
import { CFG } from '../shared/utils.js';

const NODE_PADDING = 4;  // px buffer around each node bbox for clearance

function segmentClearOfBox(p1, p2, box) {
  // box: { x, y, w, h }
  const bx1 = box.x - NODE_PADDING;
  const by1 = box.y - NODE_PADDING;
  const bx2 = box.x + box.w + NODE_PADDING;
  const by2 = box.y + box.h + NODE_PADDING;

  // Horizontal segment: y constant
  if (p1.y === p2.y) {
    const y = p1.y;
    if (y < by1 || y > by2) return true;  // segment's y outside box's y range
    const xMin = Math.min(p1.x, p2.x);
    const xMax = Math.max(p1.x, p2.x);
    // Segment's x range must not overlap box's x range
    return xMax <= bx1 || xMin >= bx2;
  }
  // Vertical segment: x constant
  if (p1.x === p2.x) {
    const x = p1.x;
    if (x < bx1 || x > bx2) return true;
    const yMin = Math.min(p1.y, p2.y);
    const yMax = Math.max(p1.y, p2.y);
    return yMax <= by1 || yMin >= by2;
  }
  // Diagonal segments: not used in orthogonal routing, but accept conservatively
  return false;
}

function pathClearOfBoxes(waypoints, boxes, sourceId, targetId) {
  for (let i = 0; i < waypoints.length - 1; i++) {
    for (const [id, box] of Object.entries(boxes)) {
      // Endpoints are allowed to touch their own source/target boxes
      if (id === sourceId || id === targetId) continue;
      if (!segmentClearOfBox(waypoints[i], waypoints[i + 1], box)) return false;
    }
  }
  return true;
}

function pathLength(waypoints) {
  let total = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    total += Math.abs(waypoints[i + 1].x - waypoints[i].x);
    total += Math.abs(waypoints[i + 1].y - waypoints[i].y);
  }
  return total;
}

/**
 * Try to replace an ELK route with a simpler one, keeping both endpoints exactly where §5.1
 * clipped them.
 *
 * Order of preference, each candidate clear of every node box except its own endpoints:
 *  1. a single-bend L that crosses both endpoint outlines (see crossesEndpointOutlines);
 *  2. if every clear L lies ON an endpoint's outline (#52: the last leg running down the target's
 *     border, arrowhead on the border), the simplest two/three-bend route that does cross both
 *     outlines — candidateRoutes' mid-corridor shapes plus stubRoutes' 15 px perpendicular stubs
 *     (a corridor at the midpoint ±40/±80 px misses an 80 px gap right in front of the target);
 *  3. otherwise ELK's own route when it is clear — and when it is not (coordinates.js §5.0a/§5.2
 *     rebuilt it without an obstacle test), the old L after all: a line on an outline is the
 *     lesser defect than a line through a shape.
 * `legacy: true` returns the first clear L, as before #52 — the route guardAgainstLegacy reverts to.
 * Returns the original array reference when nothing changes.
 *
 * Not idempotent: run on its own output, a 4+-point #52 route is simplified again and may come out
 * on another corridor. The pipeline calls it exactly once per edge, on ELK's route, and no later
 * pass (repairCrossings, guardAgainstLegacy, reclipStuckEnds) feeds a route back through it.
 */
export function simplifyEdge(waypoints, boxes, sourceId, targetId, { legacy = false } = {}) {
  if (!waypoints || waypoints.length <= 3) return waypoints;  // already minimal
  const start = waypoints[0];
  const end = waypoints[waypoints.length - 1];
  if (start.x === end.x || start.y === end.y) return waypoints;  // would be 2-pt straight

  // Both L-shapes have the same Manhattan length, so the first clear one in this order is the
  // one this pass has always taken.
  const ls = [
    [start, { x: end.x, y: start.y }, end],  // horizontal-first
    [start, { x: start.x, y: end.y }, end],  // vertical-first
  ];
  const clear = ls.filter(c => pathClearOfBoxes(c, boxes, sourceId, targetId));
  if (clear.length === 0) return waypoints;
  const legacyL = clear[0];
  if (legacy) return legacyL;

  const srcBox = boxes[sourceId];
  const tgtBox = boxes[targetId];
  const good = clear.find(c => crossesEndpointOutlines(c, srcBox, tgtBox));
  if (good) return good;

  const alternatives = [...candidateRoutes(waypoints), ...stubRoutes(waypoints, srcBox, tgtBox)]
    .filter(c => c.length >= 4
      && pathClearOfBoxes(c, boxes, sourceId, targetId)
      && crossesEndpointOutlines(c, srcBox, tgtBox))
    .sort((a, b) => (bendCount(a) - bendCount(b)) || (pathLength(a) - pathLength(b)));
  if (alternatives.length) return alternatives[0];

  return pathClearOfBoxes(waypoints, boxes, sourceId, targetId) ? waypoints : legacyL;
}

/**
 * Apply simplification across all edges in a coordMap.
 * coords: { nodeId: {x,y,w,h} }
 * edgeCoords: { edgeId: [{x,y}, ...] }
 * edges: array of { id, source, target } from logic-core
 * skipIds: edge ids to leave untouched
 * legacy: the pre-#52 behaviour for every edge (first clear L) — guardAgainstLegacy's reference.
 * Returns a new edgeCoords (does not mutate the input).
 *
 * `skipIds` exists for routes that are already final: clearance here is checked against NODE
 * boxes only, so collapsing a message flow to an L-shape would happily lay its
 * line through a pool body or into a shape — undoing the clipping and corridor
 * routing done in coordinates.js §5.4.
 */
export function simplifyAllEdges(edgeCoords, coords, edges, skipIds = new Set(), { legacy = false } = {}) {
  const out = {};
  const edgeBySrcTarget = {};
  for (const e of edges || []) {
    edgeBySrcTarget[e.id] = { source: e.source, target: e.target };
  }
  for (const [id, wp] of Object.entries(edgeCoords)) {
    if (skipIds.has(id)) { out[id] = wp; continue; }
    const lookup = edgeBySrcTarget[id];
    out[id] = simplifyEdge(wp, coords, lookup?.source, lookup?.target, { legacy });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// Crossing repair
//
// ELK routes around obstacles; the routes we delete and rebuild do not.
// coordinates.js drops a route whenever the lane-band shift moves its two
// endpoints by different deltas (§5.0a) or its source is a boundary event
// (§5.0-), and §5.2/§5.0e/§5.5 rebuild it as a fixed 4-point Z whose axis is
// chosen purely by |dy| > |dx| — no obstacle test, no crossing test. The
// result is crossings in the final drawing that ELK's own output did not have.
//
// This pass looks for those and tries alternative orthogonal routes for the
// edges involved. It is deliberately conservative: it does nothing at all
// unless a crossing actually exists, and it never moves an endpoint.
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_MAX_PASSES = 2;
const CORRIDOR_STEPS = [40, 80];  // px offsets tried for a shifted Z corridor

function segmentsOf(points) {
  const segs = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) continue;  // zero-length
    segs.push([a, b]);
  }
  return segs;
}

function orientation(a, b, c) {
  const val = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(val) < 1e-9) return 0;
  return val > 0 ? 1 : 2;
}

function pointOnSegment(a, b, c) {
  return (
    Math.min(a.x, b.x) - 1e-6 <= c.x && c.x <= Math.max(a.x, b.x) + 1e-6 &&
    Math.min(a.y, b.y) - 1e-6 <= c.y && c.y <= Math.max(a.y, b.y) + 1e-6
  );
}

function segmentsIntersect(p1, p2, p3, p4) {
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && pointOnSegment(p1, p2, p3)) return true;
  if (o2 === 0 && pointOnSegment(p1, p2, p4)) return true;
  if (o3 === 0 && pointOnSegment(p3, p4, p1)) return true;
  if (o4 === 0 && pointOnSegment(p3, p4, p2)) return true;
  return false;
}

/** Two edges sharing a node touch by construction; that is not a crossing. */
function adjacent(a, b) {
  return a.source === b.source || a.source === b.target
      || a.target === b.source || a.target === b.target;
}

/**
 * Segment-pair intersections between one route and every other route.
 * Counted the same way as scripts/bench/layout-metrics.mjs, so the metric and
 * this pass are talking about the same quantity.
 */
function crossingsAgainstOthers(entry, points, others) {
  let n = 0;
  const segsA = segmentsOf(points);
  for (const other of others) {
    if (other.id === entry.id) continue;
    if (adjacent(entry, other)) continue;
    for (const [p1, p2] of segsA) {
      for (const [p3, p4] of segmentsOf(other.points)) {
        if (segmentsIntersect(p1, p2, p3, p4)) n++;
      }
    }
  }
  return n;
}

function totalCrossings(entries) {
  let n = 0;
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (adjacent(entries[i], entries[j])) continue;
      for (const [p1, p2] of segmentsOf(entries[i].points)) {
        for (const [p3, p4] of segmentsOf(entries[j].points)) {
          if (segmentsIntersect(p1, p2, p3, p4)) n++;
        }
      }
    }
  }
  return n;
}

function isOrthogonal(points) {
  for (const [a, b] of segmentsOf(points)) {
    if (Math.abs(a.x - b.x) > 1e-6 && Math.abs(a.y - b.y) > 1e-6) return false;
  }
  return true;
}

function bendCount(points) {
  const segs = segmentsOf(points);
  let bends = 0;
  for (let i = 1; i < segs.length; i++) {
    const p = segs[i - 1], c = segs[i];
    const pd = [Math.sign(p[1].x - p[0].x), Math.sign(p[1].y - p[0].y)];
    const cd = [Math.sign(c[1].x - c[0].x), Math.sign(c[1].y - c[0].y)];
    if (pd[0] !== cd[0] || pd[1] !== cd[1]) bends++;
  }
  return bends;
}

function betterScore(a, b) {
  if (a.after !== b.after) return a.after < b.after;
  if (a.bends !== b.bends) return a.bends < b.bends;
  return a.length < b.length;
}

const SIDE_EPS = 0.5;

/**
 * Which side of its node box an endpoint sits on, or null if it sits on none
 * (a boundary event straddling its host's outline, for instance).
 */
function sideOf(point, box) {
  if (!box) return null;
  if (Math.abs(point.x - box.x) <= SIDE_EPS) return 'left';
  if (Math.abs(point.x - (box.x + box.w)) <= SIDE_EPS) return 'right';
  if (Math.abs(point.y - box.y) <= SIDE_EPS) return 'top';
  if (Math.abs(point.y - (box.y + box.h)) <= SIDE_EPS) return 'bottom';
  return null;
}

// Leaving the source: away from the shape. Entering the target: into it.
const OUTWARD = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
const INWARD  = { left: [1, 0], right: [-1, 0], top: [0, 1], bottom: [0, -1] };

/**
 * Does the end segment move out of its shape, seen from the endpoint? `away` is the direction
 * from the endpoint along that segment, pointing away from the shape.
 *
 * Endpoint on a side of the bounds (sideOf): `away` must be that side's outward normal — a
 * segment parallel to the side lies on the outline (#52).
 * Endpoint on no side (clipped onto a circle's or diamond's slanted outline for the OTHER approach
 * axis): no side to honour, but the segment must still move away from the centre along its own
 * axis, or it cuts back through the shape.
 */
function leavesOutward(point, away, box) {
  if (!box) return true;
  const side = sideOf(point, box);
  if (side) return sameDir(away, OUTWARD[side]);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  if (away[0] !== 0) return Math.abs(point.x - cx) < 1e-6 || Math.sign(point.x - cx) === away[0];
  return Math.abs(point.y - cy) < 1e-6 || Math.sign(point.y - cy) === away[1];
}

/** A route that leaves its source and reaches its target across the outline, never along it. */
function crossesEndpointOutlines(cand, srcBox, tgtBox) {
  const first = firstDirection(cand);
  const last = lastDirection(cand);
  if (!first || !last) return false;
  return leavesOutward(cand[0], first, srcBox)
      && leavesOutward(cand[cand.length - 1], [-last[0], -last[1]], tgtBox);
}

/** Length of the perpendicular stub stubRoutes (and Task 2b's re-clip) put at an edge end. */
const END_STUB_PX = CFG.layout?.endStubPx ?? 15;

/** Drops the middle one of three collinear points. */
function withoutCollinear(pts) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    const vertical = Math.abs(a.x - b.x) < 1e-6 && Math.abs(b.x - c.x) < 1e-6;
    const horizontal = Math.abs(a.y - b.y) < 1e-6 && Math.abs(b.y - c.y) < 1e-6;
    if (vertical || horizontal) continue;
    out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Routes with a short perpendicular stub at one or both ends, joined by an L: out of the source
 * END_STUB_PX along its side's normal, into the target the same way. They reach a corridor right
 * in front of a shape that candidateRoutes' mid-line offsets jump over (study: the 80 px gap
 * between "Send reminder" and its host in realistic-collaboration). Endpoints stay fixed.
 * On an endpoint with no identifiable side the stub follows the ELK route's own first/last
 * direction; crossesEndpointOutlines filters out anything that would cut back into the shape.
 */
function stubRoutes(points, srcBox, tgtBox) {
  const start = points[0];
  const end = points[points.length - 1];
  const ss = sideOf(start, srcBox);
  const ts = sideOf(end, tgtBox);
  const out1 = ss ? OUTWARD[ss] : firstDirection(points);
  const in1 = ts ? INWARD[ts] : lastDirection(points);
  if (!out1 || !in1) return [];
  const s1 = { x: start.x + out1[0] * END_STUB_PX, y: start.y + out1[1] * END_STUB_PX };
  const e1 = { x: end.x - in1[0] * END_STUB_PX, y: end.y - in1[1] * END_STUB_PX };
  return [
    [start, s1, { x: s1.x, y: e1.y }, e1, end],          // both stubs
    [start, s1, { x: e1.x, y: s1.y }, e1, end],
    [start, { x: e1.x, y: start.y }, e1, end],            // target stub only
    [start, { x: start.x, y: e1.y }, e1, end],
    [start, s1, { x: s1.x, y: end.y }, end],              // source stub only
    [start, s1, { x: end.x, y: s1.y }, end],
  ].map(withoutCollinear).filter(isOrthogonal);
}

// Same two directions, named the way orthogonal-router.js's routeAroundObstacles
// wants them ('up'|'down'|'left'|'right' instead of a unit vector).
const OUT_DIR_NAME = { left: 'left', right: 'right', top: 'up', bottom: 'down' };
const IN_DIR_NAME  = { left: 'right', right: 'left', top: 'down', bottom: 'up' };

function firstDirection(points) {
  const segs = segmentsOf(points);
  if (!segs.length) return null;
  const [a, b] = segs[0];
  return [Math.sign(b.x - a.x), Math.sign(b.y - a.y)];
}

function lastDirection(points) {
  const segs = segmentsOf(points);
  if (!segs.length) return null;
  const [a, b] = segs[segs.length - 1];
  return [Math.sign(b.x - a.x), Math.sign(b.y - a.y)];
}

function sameDir(a, b) {
  return a && b && a[0] === b[0] && a[1] === b[1];
}

/**
 * A candidate is admissible when it leaves the source outward from the side
 * its endpoint sits on, and enters the target inward into that endpoint's side.
 *
 * This is what replaces "keep the original segment directions": the endpoints
 * were clipped onto a specific side of the outline by coordinates.js §5.1, and
 * that side is the part that must be honoured. The direction of the original
 * final segment is not — an endpoint on a left edge approached from above runs
 * along the shape's border rather than into it, which is precisely one of the
 * shapes we want the freedom to replace.
 *
 * Where an endpoint sits on no identifiable side, the original direction is
 * kept instead, so those routes are never made worse.
 */
function admissible(cand, original, srcBox, tgtBox) {
  const start = cand[0];
  const end = cand[cand.length - 1];
  const srcSide = sideOf(start, srcBox);
  const tgtSide = sideOf(end, tgtBox);
  const wantFirst = srcSide ? OUTWARD[srcSide] : firstDirection(original);
  const wantLast = tgtSide ? INWARD[tgtSide] : lastDirection(original);
  return sameDir(firstDirection(cand), wantFirst) && sameDir(lastDirection(cand), wantLast);
}

/**
 * Candidate routes, all keeping the existing endpoints exactly where they are.
 *
 * The endpoints are never moved because coordinates.js §5.1 clipped them onto
 * the shape outline; re-deriving them here would mean duplicating that
 * clipping, and the geometry contract exists precisely to stop two places from
 * computing the same coordinate.
 */
function candidateRoutes(points) {
  const start = points[0];
  const end = points[points.length - 1];
  const out = [];

  const push = (pts) => {
    if (!isOrthogonal(pts)) return;
    if (segmentsOf(pts).length === 0) return;
    out.push(pts);
  };

  // Single-bend L-shapes
  push([start, { x: end.x, y: start.y }, end]);
  push([start, { x: start.x, y: end.y }, end]);

  // Two-bend Z-shapes through a vertical or horizontal corridor, at the
  // midpoint and at a few offsets either side of it.
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const offsets = [0, ...CORRIDOR_STEPS.flatMap((s) => [s, -s])];
  for (const off of offsets) {
    push([start, { x: midX + off, y: start.y }, { x: midX + off, y: end.y }, end]);
    push([start, { x: start.x, y: midY + off }, { x: end.x, y: midY + off }, end]);
  }

  // Three-bend staircases: leave along the source's axis, cross over, come
  // back. These are the shapes that get an edge out of a column another edge
  // already occupies, which the L- and Z-forms above cannot do.
  for (const off of CORRIDOR_STEPS.flatMap((s) => [s, -s])) {
    push([start, { x: start.x, y: start.y + off }, { x: end.x, y: start.y + off }, end]);
    push([start, { x: start.x + off, y: start.y }, { x: start.x + off, y: end.y }, end]);
  }
  return out;
}

/**
 * Re-route edges that cross another edge, where an alternative orthogonal
 * route removes the crossing without running through a node.
 *
 * Returns a new edgeCoords map. Routes it did not change keep their original
 * array reference, so a caller can detect what moved with `old[id] !== new[id]`
 * — pipeline.js uses exactly that to refresh only the affected edge labels.
 * When there is no crossing at all the input map is returned untouched, which
 * is what keeps every crossing-free fixture (all seven golden fixtures among
 * them) byte-identical.
 *
 * Greedy and bounded, in the same spirit as visual-refinement.js's label
 * repair: it takes the first strict improvement it finds and gives up quietly
 * rather than searching for an optimum. Crossing minimization is NP-hard; this
 * is a repair pass, not a solver.
 *
 * `candidateRoutes` tries only a fixed, small set of shapes around the direct
 * source-target line; in a congested local cluster every one of them can be
 * blocked while a path around the cluster still exists. When that happens —
 * `candidateRoutes` found nothing admissible and clear — `orthogonal-router.js`
 * is tried as a fallback, same strict-improvement rule, same fixed endpoints.
 * Opt-out via `opts.orthogonalRouter: false` (default on).
 */
export function repairCrossings(edgeCoords, coords, edges, skipIds = new Set(), opts = {}) {
  const maxPasses = opts.maxPasses ?? DEFAULT_MAX_PASSES;
  const orthogonalRouterEnabled = opts.orthogonalRouter ?? true;
  const routerMaxGridPoints = opts.orthogonalRouterMaxGridPoints;

  const entries = [];
  for (const e of edges || []) {
    if (skipIds.has(e.id)) continue;
    const points = edgeCoords[e.id];
    if (!points || points.length < 2) continue;
    entries.push({ id: e.id, source: e.source, target: e.target, points });
  }
  if (entries.length < 2) return edgeCoords;
  if (totalCrossings(entries) === 0) return edgeCoords;

  const changed = new Map();
  for (let pass = 0; pass < maxPasses; pass++) {
    const ranked = entries
      .map((entry) => ({ entry, n: crossingsAgainstOthers(entry, entry.points, entries) }))
      .filter((r) => r.n > 0)
      .sort((a, b) => b.n - a.n);
    if (!ranked.length) break;

    let improvedAny = false;
    for (const { entry } of ranked) {
      // Recomputed rather than taken from `ranked`: earlier entries in this
      // same pass have already been re-routed, so the ranking figure is stale
      // by the time we get here, and a stale baseline both blocks real
      // improvements and lets through candidates that are not one.
      const before = crossingsAgainstOthers(entry, entry.points, entries);
      if (before === 0) continue;
      const srcBox = coords[entry.source];
      const tgtBox = coords[entry.target];
      let best = null;
      for (const cand of candidateRoutes(entry.points)) {
        if (!admissible(cand, entry.points, srcBox, tgtBox)) continue;
        if (!pathClearOfBoxes(cand, coords, entry.source, entry.target)) continue;
        const after = crossingsAgainstOthers(entry, cand, entries);
        if (after >= before) continue;
        // Fewest crossings first, then fewest bends, then shortest path.
        const score = { after, bends: bendCount(cand), length: pathLength(cand) };
        if (!best || betterScore(score, best.score)) best = { points: cand, score };
      }
      if (!best && orthogonalRouterEnabled) {
        const start = entry.points[0];
        const end = entry.points[entry.points.length - 1];
        const srcSide = sideOf(start, srcBox);
        const tgtSide = sideOf(end, tgtBox);
        // No identifiable side (a boundary event straddling its host's
        // outline) means no fixed exit/entry direction to route from —
        // same case candidateRoutes already falls back on via admissible().
        if (srcSide && tgtSide) {
          const obstacles = Object.entries(coords)
            .filter(([id]) => id !== entry.source && id !== entry.target)
            .map(([, box]) => box);
          const softObstacles = entries
            .filter((other) => other.id !== entry.id && !adjacent(entry, other))
            .map((other) => other.points);
          const routed = routeAroundObstacles(
            start, OUT_DIR_NAME[srcSide],
            end, IN_DIR_NAME[tgtSide],
            obstacles,
            { softObstacles, maxGridPoints: routerMaxGridPoints },
          );
          if (routed) {
            const after = crossingsAgainstOthers(entry, routed, entries);
            if (after < before) {
              best = { points: routed, score: { after, bends: bendCount(routed), length: pathLength(routed) } };
            }
          }
        }
      }
      if (best) {
        entry.points = best.points;
        changed.set(entry.id, best.points);
        improvedAny = true;
      }
    }
    if (!improvedAny) break;
  }

  if (!changed.size) return edgeCoords;
  const out = { ...edgeCoords };
  for (const [id, points] of changed) out[id] = points;
  return out;
}

/**
 * Per-edge crossing guard (owner decision 2026-10-11, ELK study variant T3g).
 *
 * The #52 routes are chosen one edge at a time; repairCrossings then works around them. A new
 * route can block the only crossing-free path another edge had (measured: realistic-collaboration
 * --refine, inf3's new route left inf2 × inf8 that repairCrossings could not remove). So: count the
 * crossings repairCrossings leaves for `routes` and for `legacyRoutes` (simplifyAllEdges with
 * legacy: true). Only if the new routes leave more, revert single edges to their legacy route, in
 * `edges` order, keeping a revert only when it lowers the count, until the count is back at the
 * legacy level. The search is first-improving in `edges` order: the first single revert that lowers
 * the count is kept, and the next edge is tried against the result — not the best revert overall,
 * and not every subset. Returns the routes to hand to repairCrossings, and the reverted edge ids.
 * No blanket exception for any class of edge: whatever is reverted was measured to cost a crossing.
 *
 * Cost: two extra repairCrossings runs on every call (one for `routes`, one for `legacyRoutes`),
 * plus one per trial revert — the trials only happen when the new routes left more crossings.
 */
export function guardAgainstLegacy(routes, legacyRoutes, coords, edges, skipIds = new Set(), repairOpts = {}) {
  const crossingsAfterRepair = (map) => {
    const repaired = repairCrossings(map, coords, edges, skipIds, repairOpts);
    const entries = (edges || [])
      .filter(e => !skipIds.has(e.id) && repaired[e.id]?.length >= 2)
      .map(e => ({ id: e.id, source: e.source, target: e.target, points: repaired[e.id] }));
    return totalCrossings(entries);
  };
  const target = crossingsAfterRepair(legacyRoutes);
  let current = routes;
  let n = crossingsAfterRepair(current);
  const reverted = [];
  for (const e of edges || []) {
    if (n <= target) break;
    if (skipIds.has(e.id) || !legacyRoutes[e.id]) continue;
    if (JSON.stringify(current[e.id]) === JSON.stringify(legacyRoutes[e.id])) continue;
    const trial = { ...current, [e.id]: legacyRoutes[e.id] };
    const m = crossingsAfterRepair(trial);
    if (m < n) { current = trial; n = m; reverted.push(e.id); }
  }
  return { routes: current, reverted };
}

// ═══════════════════════════════════════════════════════════════════════
// Stuck ends (owner decision 4, 2026-10-11)
//
// The one exception to "endpoints are clipped once, in coordinates.js §5.1": an edge that, after
// simplification and crossing repair, still ends along an outline or runs through its own source
// or target may have an endpoint moved to the midpoint of another side of its node's bounds. That
// point lies on the outline for a rectangle, a circle and a rhombus alike, so nothing is clipped a
// second time. Only taken when no route keeping the endpoint does as well (see the score).
//
// This pass never calls simplifyEdge or stubRoutes. simplifyEdge is not idempotent on its own
// output (a second run over a #52 route may pick another corridor), which is why nothing here
// feeds a route back through it: the candidates are built from scratch by orthogonal-router.js,
// and an edge without an end defect is never touched at all.
// ═══════════════════════════════════════════════════════════════════════

const SIDES = ['left', 'right', 'top', 'bottom'];

function sideMidpoint(box, side) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  if (side === 'left') return { x: box.x, y: cy };
  if (side === 'right') return { x: box.x + box.w, y: cy };
  if (side === 'top') return { x: cx, y: box.y };
  return { x: cx, y: box.y + box.h };
}

/** Does an axis-parallel segment enter the drawn shape's interior (rect, circle or rhombus)? Same
 *  maths as scripts/bench/layout-metrics.mjs's segmentEntersShape. */
function segmentEntersShape([a, z], box, shape) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const nx = Math.max(Math.min(a.x, z.x), Math.min(Math.max(a.x, z.x), cx));
  const ny = Math.max(Math.min(a.y, z.y), Math.min(Math.max(a.y, z.y), cy));
  if (shape === 'circle') return Math.hypot(nx - cx, ny - cy) < box.w / 2 - 1;
  if (shape === 'diamond') return Math.abs(nx - cx) / (box.w / 2) + Math.abs(ny - cy) / (box.h / 2) < 1 - 2 / Math.min(box.w, box.h);
  return Math.max(a.x, z.x) > box.x + 1 && Math.min(a.x, z.x) < box.x + box.w - 1
      && Math.max(a.y, z.y) > box.y + 1 && Math.min(a.y, z.y) < box.y + box.h - 1;
}

/** Longest collinear (±1 px) overlap of a segment with a side of `box`. */
function alongOutline([a, b], box) {
  const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(Math.max(a0, a1), b1) - Math.max(Math.min(a0, a1), b0));
  let best = 0;
  if (Math.abs(a.x - b.x) <= 1) {
    for (const x of [box.x, box.x + box.w]) if (Math.abs(a.x - x) <= 1) best = Math.max(best, ov(a.y, b.y, box.y, box.y + box.h));
  }
  if (Math.abs(a.y - b.y) <= 1) {
    for (const y of [box.y, box.y + box.h]) if (Math.abs(a.y - y) <= 1) best = Math.max(best, ov(a.x, b.x, box.x, box.x + box.w));
  }
  return best;
}

/** Number of end defects: an end segment along its outline (> 5 px, bpmn-js's arrowhead length),
 *  or any segment inside the edge's own source or target shape. */
function endDefects(points, srcBox, tgtBox, srcShape, tgtShape) {
  const segs = segmentsOf(points);
  if (!segs.length) return 0;
  let n = 0;
  if (alongOutline(segs[0], srcBox) > 5) n++;
  if (alongOutline(segs[segs.length - 1], tgtBox) > 5) n++;
  if (segs.some(s => segmentEntersShape(s, srcBox, srcShape))) n++;
  if (segs.some(s => segmentEntersShape(s, tgtBox, tgtShape))) n++;
  return n;
}

/** Lexicographic "a beats b" over equal-length score arrays. */
function lexLess(a, b) {
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] < b[k];
  return false;
}

/**
 * Re-route every edge that still has an end defect (see endDefects), trying each combination of
 * source and target port: the current endpoint (when sideOf identifies its side, and always the
 * only port of an endpoint in `fixedEndpoints`) and the four side midpoints. Between the ports the
 * route runs from a END_STUB_PX stub to a END_STUB_PX stub through orthogonal-router.js, with every
 * node box as an obstacle except boxes that contain an endpoint (its expanded subprocess) — the
 * edge's own two shapes INCLUDED, which is what keeps the route out of them.
 * A candidate is admissible when it has no end defect, clears every foreign node and crosses the
 * other (non-adjacent) routes at most as often as the current route. Best by: crossings, number of
 * moved endpoints, bends, length — so an endpoint moves only when no fixed-endpoint route does as
 * well. Greedy, one edge at a time in `edges` order; later edges see earlier re-routes.
 *
 * An edge inside an expanded subprocess is never re-clipped: pathClearOfBoxes skips only the
 * edge's own source and target, so the container around both still counts as an obstacle and
 * rejects every candidate. Deliberate — a nested stuck end has not been measured in any fixture,
 * and the container's own geometry is not this pass's to judge.
 */
export function reclipStuckEnds(edgeCoords, coords, edges, skipIds = new Set(), { shapeOf = () => 'rect', fixedEndpoints = new Set() } = {}) {
  const entries = [];
  for (const e of edges || []) {
    if (skipIds.has(e.id)) continue;
    const points = edgeCoords[e.id];
    if (!points || points.length < 2) continue;
    entries.push({ id: e.id, source: e.source, target: e.target, points });
  }
  const contains = (o, i) => o.x <= i.x && o.y <= i.y && o.x + o.w >= i.x + i.w && o.y + o.h >= i.y + i.h;
  const changed = new Map();

  for (const entry of entries) {
    const srcBox = coords[entry.source];
    const tgtBox = coords[entry.target];
    if (!srcBox || !tgtBox) continue;
    const srcShape = shapeOf(entry.source);
    const tgtShape = shapeOf(entry.target);
    if (!endDefects(entry.points, srcBox, tgtBox, srcShape, tgtShape)) continue;

    const crossingsNow = crossingsAgainstOthers(entry, entry.points, entries);
    const start = entry.points[0];
    const end = entry.points[entry.points.length - 1];
    const ports = (box, point, fixed) => {
      const side = sideOf(point, box);
      const current = side ? [{ p: point, side, moved: false }] : [];
      if (fixed) return current;
      const mids = SIDES.map(s => ({ p: sideMidpoint(box, s), side: s, moved: true }))
        .filter(m => !current.some(c => c.p.x === m.p.x && c.p.y === m.p.y));
      return [...current, ...mids];
    };
    const obstacles = Object.values(coords).filter(b =>
      b === srcBox || b === tgtBox || (!contains(b, srcBox) && !contains(b, tgtBox)));
    const softObstacles = entries.filter(o => o.id !== entry.id && !adjacent(entry, o)).map(o => o.points);

    let best = null;
    for (const s of ports(srcBox, start, fixedEndpoints.has(entry.source))) {
      for (const t of ports(tgtBox, end, fixedEndpoints.has(entry.target))) {
        const out = OUTWARD[s.side];
        const inn = INWARD[t.side];
        const s1 = { x: s.p.x + out[0] * END_STUB_PX, y: s.p.y + out[1] * END_STUB_PX };
        const e1 = { x: t.p.x - inn[0] * END_STUB_PX, y: t.p.y - inn[1] * END_STUB_PX };
        const middle = routeAroundObstacles(s1, OUT_DIR_NAME[s.side], e1, IN_DIR_NAME[t.side], obstacles, { softObstacles });
        if (!middle) continue;
        const cand = withoutCollinear([s.p, ...middle, t.p]);
        if (!isOrthogonal(cand)) continue;
        if (endDefects(cand, srcBox, tgtBox, srcShape, tgtShape)) continue;
        if (!pathClearOfBoxes(cand, coords, entry.source, entry.target)) continue;
        const crossings = crossingsAgainstOthers(entry, cand, entries);
        if (crossings > crossingsNow) continue;
        const score = [crossings, (s.moved ? 1 : 0) + (t.moved ? 1 : 0), bendCount(cand), pathLength(cand)];
        if (!best || lexLess(score, best.score)) best = { cand, score };
      }
    }
    if (best) {
      entry.points = best.cand;
      changed.set(entry.id, best.cand);
    }
  }

  if (!changed.size) return edgeCoords;
  const out = { ...edgeCoords };
  for (const [id, points] of changed) out[id] = points;
  return out;
}
