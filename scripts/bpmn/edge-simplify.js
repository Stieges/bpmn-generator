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

import { routeAroundObstacles, ROUTER_PAD } from './orthogonal-router.js';
import { CFG } from '../shared/utils.js';
import { isEvent, isGateway, isArtifact } from './types.js';

// px buffer around each node bbox for clearance; config.json → layout.shapeClearance, shared with
// coordinates.js's message-flow routing.
const NODE_PADDING = CFG.layout?.shapeClearance ?? 4;

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

/**
 * Length of the perpendicular stub stubRoutes (and the stuck-end re-clip) put at an edge end.
 * Must stay above orthogonal-router's PAD (the clearance kept around every obstacle, the edge's
 * own shape included): a stub point inside that padded obstacle is unreachable, so reclipStuckEnds
 * would silently find no route. assertStubClearsPad enforces it at load.
 */
export function assertStubClearsPad(stubPx, pad) {
  if (!(stubPx > pad)) {
    throw new Error(`config layout.endStubPx (${stubPx}) must be greater than the orthogonal router's obstacle padding (${pad})`);
  }
}
const END_STUB_PX = CFG.layout?.endStubPx ?? 15;
assertStubClearsPad(END_STUB_PX, ROUTER_PAD);

/** Minimum length of an end segment lying along its own outline that counts as a defect (px;
 *  bpmn-js's arrowhead length). One source for edge-simplify, di-check (DI08) and the bench. */
const ALONG_OUTLINE_MIN_PX = CFG.layout?.alongOutlineMinPx ?? 5;

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
 * in front of a shape that candidateRoutes' mid-line offsets jump over (for example the 80 px gap
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
 * Per-edge crossing guard.
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
 * Runs only when `layout.crossingRepair` is enabled: it sits inside that block in pipeline.js, so
 * with crossingRepair off the #52 routes go unguarded.
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
// After lane compaction
//
// compactLanes shrinks each lane band around its content and moves every
// waypoint below the band up with it; a waypoint inside the strip it cut away
// is clamped to the band's new bottom - 1. A cross-lane Z whose horizontal leg
// ELK had centred in the gap therefore ends up lying on the lane separator.
// The edges that were not shifted rigidly go through the same chain as the
// first time — simplify, legacy guard, crossing repair — on the compacted
// geometry, and an inner horizontal leg is then kept off the separators.
// ═══════════════════════════════════════════════════════════════════════

/** True when `after` is `before` with at least one point moved by a different delta than the rest. */
export function movedNonRigidly(before, after) {
  if (!before || !after || before.length !== after.length || before.length === 0) return false;
  const dx = after[0].x - before[0].x;
  const dy = after[0].y - before[0].y;
  return before.some((p, i) => Math.abs(after[i].x - p.x - dx) > 0.01 || Math.abs(after[i].y - p.y - dy) > 0.01);
}

/** Ids of foreign boxes (not the edge's own source/target) the polyline runs through. */
function foreignHits(points, boxes, sourceId, targetId) {
  const hits = [];
  for (const [id, box] of Object.entries(boxes)) {
    if (id === sourceId || id === targetId) continue;
    if (!pathClearOfBoxes(points, { [id]: box }, sourceId, targetId)) hits.push(id);
  }
  return hits;
}

/**
 * Move every inner horizontal leg (never the first or last segment — those are pinned to the
 * endpoints) that lies closer than `clearance` to an inner lane line to `line ± clearance`,
 * the nearer side first, as long as the new y stays strictly between the leg's two vertical
 * neighbours' far ends and is not closer than `clearance` to another line. A candidate is refused
 * when the three segments it changes run through a foreign box they did not already run through —
 * judging the whole route instead would refuse every move on a route that already crosses something
 * (a host's flow leaving through its own boundary event), and leave the leg on the line.
 * Returns the input array when nothing moved.
 */
export function keepOffLaneLines(points, laneLines, clearance, boxes, sourceId, targetId) {
  if (!points || points.length < 4 || !laneLines.length || clearance <= 0) return points;
  let out = points;
  for (let i = 1; i + 2 < out.length; i++) {
    const a = out[i], b = out[i + 1];
    if (Math.abs(a.y - b.y) > 0.01) continue;
    const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
    const spans = (L) => hi > L.x0 && lo < L.x1;
    const near = laneLines.find((L) => spans(L) && Math.abs(L.y - a.y) < clearance);
    if (!near) continue;
    const yMin = Math.min(out[i - 1].y, out[i + 2].y), yMax = Math.max(out[i - 1].y, out[i + 2].y);
    const candidates = [near.y - clearance, near.y + clearance]
      .filter((y) => y > yMin && y < yMax)
      .filter((y) => !laneLines.some((L) => spans(L) && Math.abs(L.y - y) < clearance - 0.01))
      .sort((p, q) => Math.abs(p - a.y) - Math.abs(q - a.y));
    const before = new Set(foreignHits(out.slice(i - 1, i + 3), boxes, sourceId, targetId));
    for (const y of candidates) {
      const cand = out.map((p, k) => (k === i || k === i + 1 ? { x: p.x, y } : p));
      if (foreignHits(cand.slice(i - 1, i + 3), boxes, sourceId, targetId).every((id) => before.has(id))) { out = cand; break; }
    }
  }
  return out;
}

/**
 * Re-route the sequence flows compactLanes did not shift rigidly (see the section comment).
 * `preEdgeCoords` is edgeCoords as it was just before compactLanes. Message flows are not in
 * `edges` (routeMessageFlows runs after this); associations are in `skipIds`. A re-routed leg may
 * not add a crossing: a lane-line move that would is dropped for that edge.
 * Returns a new map; edges left alone keep their array reference.
 */
export function rerouteAfterCompaction(edgeCoords, preEdgeCoords, coords, edges, skipIds = new Set(), opts = {}) {
  const { laneLines = [], laneLineClearance = 10, guard = true, repair = true, repairOpts = {} } = opts;
  const affected = (edges || []).filter((e) => !skipIds.has(e.id) && movedNonRigidly(preEdgeCoords[e.id], edgeCoords[e.id]));
  if (!affected.length) return edgeCoords;
  let routes = { ...edgeCoords };
  const legacy = { ...edgeCoords };
  for (const e of affected) {
    const pts = withoutCollinear(edgeCoords[e.id]);
    routes[e.id] = simplifyEdge(pts, coords, e.source, e.target);
    legacy[e.id] = simplifyEdge(pts, coords, e.source, e.target, { legacy: true });
  }
  if (guard) routes = guardAgainstLegacy(routes, legacy, coords, edges, skipIds, repairOpts).routes;
  if (repair) routes = repairCrossings(routes, coords, edges, skipIds, repairOpts);
  const entries = (edges || []).filter((e) => !skipIds.has(e.id) && routes[e.id]?.length >= 2)
    .map((e) => ({ id: e.id, source: e.source, target: e.target, points: routes[e.id] }));
  for (const e of affected) {
    const kept = keepOffLaneLines(routes[e.id], laneLines, laneLineClearance, coords, e.source, e.target);
    if (kept === routes[e.id]) continue;
    const entry = entries.find((x) => x.id === e.id);
    if (entry && crossingsAgainstOthers(entry, kept, entries) > crossingsAgainstOthers(entry, routes[e.id], entries)) continue;
    routes[e.id] = kept;
    if (entry) entry.points = kept;
  }
  return routes;
}

// ═══════════════════════════════════════════════════════════════════════
// Stuck ends
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

/** Number of end defects: an end segment along its outline (longer than ALONG_OUTLINE_MIN_PX),
 *  or any segment inside the edge's own source or target shape. */
function endDefects(points, srcBox, tgtBox, srcShape, tgtShape) {
  const segs = segmentsOf(points);
  if (!segs.length) return 0;
  let n = 0;
  if (alongOutline(segs[0], srcBox) > ALONG_OUTLINE_MIN_PX) n++;
  if (alongOutline(segs[segs.length - 1], tgtBox) > ALONG_OUTLINE_MIN_PX) n++;
  if (segs.some(s => segmentEntersShape(s, srcBox, srcShape))) n++;
  if (segs.some(s => segmentEntersShape(s, tgtBox, tgtShape))) n++;
  return n;
}

/** Lexicographic "a beats b" over equal-length score arrays. */
function lexLess(a, b) {
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] < b[k];
  return false;
}

/** Is `p` within half a pixel of `q`? */
function samePoint(p, q) {
  return Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) < 0.5;
}

/**
 * pathClearOfBoxes with a segment exactly on the padded outline counting as clear — the boundary
 * rule of orthogonal-router.js's segClearOfBox. The router puts grid lines at a box ± its own
 * padding, and a route it builds there must not be refused here for lying NODE_PADDING px off a
 * box: pathClearOfBoxes calls that line blocked, the router calls it free.
 */
function pathClearOfBoxesInclusive(points, boxes, sourceId, targetId) {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    for (const [id, box] of Object.entries(boxes)) {
      if (id === sourceId || id === targetId) continue;
      const x1 = box.x - NODE_PADDING, y1 = box.y - NODE_PADDING;
      const x2 = box.x + box.w + NODE_PADDING, y2 = box.y + box.h + NODE_PADDING;
      if (Math.max(a.x, b.x) <= x1 || Math.min(a.x, b.x) >= x2) continue;
      if (Math.max(a.y, b.y) <= y1 || Math.min(a.y, b.y) >= y2) continue;
      return false;
    }
  }
  return true;
}

/**
 * Ids of the foreign flow-node shapes an axis-parallel segment of `points` runs through — the
 * DI11 measure (di-check.js): the drawn shape (shapeOf), 1 px inset; not the edge's own source or
 * target, not an artifact (isFlowNode false), not a box containing an endpoint (its expanded
 * subprocess).
 */
function foreignShapeHits(points, coords, entry, shapeOf, isFlowNode) {
  const srcBox = coords[entry.source], tgtBox = coords[entry.target];
  const contains = (o, i) => o.x <= i.x && o.y <= i.y && o.x + o.w >= i.x + i.w && o.y + o.h >= i.y + i.h;
  const segs = segmentsOf(points).filter(([a, z]) => Math.abs(a.x - z.x) < 1e-6 || Math.abs(a.y - z.y) < 1e-6);
  const hits = [];
  for (const [id, box] of Object.entries(coords)) {
    if (id === entry.source || id === entry.target || !isFlowNode(id) || !Number.isFinite(box.x)) continue;
    if ((srcBox && contains(box, srcBox)) || (tgtBox && contains(box, tgtBox))) continue;
    if (segs.some(sg => segmentEntersShape(sg, box, shapeOf(id)))) hits.push(id);
  }
  return hits;
}

/** Number of the edge's own two shapes it runs through (the DI09 measure, 0–2). */
function ownShapeHits(points, srcBox, tgtBox, srcShape, tgtShape) {
  const segs = segmentsOf(points);
  return (segs.some(sg => segmentEntersShape(sg, srcBox, srcShape)) ? 1 : 0)
       + (segs.some(sg => segmentEntersShape(sg, tgtBox, tgtShape)) ? 1 : 0);
}

/**
 * Total length (px) along which `points` lies on another route: parallel segments closer than
 * COLLINEAR_PX, adjacent routes included — two flows of one node drawn on one line read as one.
 */
const COLLINEAR_PX = 3;
function collinearOverlap(points, entry, entries) {
  let total = 0;
  const mine = segmentsOf(points);
  for (const other of entries) {
    if (other.id === entry.id) continue;
    for (const [a, b] of mine) {
      for (const [c, d] of segmentsOf(other.points)) {
        const ov = (p0, p1, q0, q1) => Math.max(0, Math.min(Math.max(p0, p1), Math.max(q0, q1)) - Math.max(Math.min(p0, p1), Math.min(q0, q1)));
        const horizontal = Math.abs(a.y - b.y) < 1e-6 && Math.abs(c.y - d.y) < 1e-6;
        const vertical = Math.abs(a.x - b.x) < 1e-6 && Math.abs(c.x - d.x) < 1e-6;
        if (horizontal && Math.abs(a.y - c.y) < COLLINEAR_PX) total += ov(a.x, b.x, c.x, d.x);
        else if (vertical && Math.abs(a.x - c.x) < COLLINEAR_PX) total += ov(a.y, b.y, c.y, d.y);
      }
    }
  }
  return total;
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
 * `foreignShapes` (pipeline: layout.foreignShapeRepair, #91) widens the pass to routes through a
 * shape — the routes coordinates.js §5.0a/§5.2 rebuild without an obstacle test, which no other
 * pass is triggered by:
 *  - an edge running through a foreign flow node (the DI11 measure) is re-routed too;
 *  - every shape the current route runs through, foreign or its own (DI09), may be traded for one
 *    crossing: a candidate may cross the others that many times more than the current route;
 *  - a candidate may not lie on another route (collinearOverlap, adjacent routes included) for
 *    longer than the current route does;
 *  - ranked by crossings, then ports shared in/out with another flow of the same node (one flow
 *    leaving where another enters reads as one line through the node), then moved endpoints,
 *    bends, ports shared in one direction, length;
 *  - the router gets grid lines END_STUB_PX either side of both stubs (`endLines`), so a route can
 *    turn into a stub from just beyond it instead of hooking round the next obstacle line;
 *  - router candidates are judged with the router's own boundary rule (pathClearOfBoxesInclusive);
 *  - when the first sweep moved anything, a second one runs: an edge earlier in `edges` order may
 *    have been stuck only against a later edge's route through a shape.
 * Off, the pass is exactly the stuck-end pass above.
 *
 * An edge inside an expanded subprocess is never re-clipped: pathClearOfBoxes skips only the
 * edge's own source and target, so the container around both still counts as an obstacle and
 * rejects every candidate. Deliberate — a nested stuck end has not been measured in any fixture,
 * and the container's own geometry is not this pass's to judge.
 */
export function reclipStuckEnds(edgeCoords, coords, edges, skipIds = new Set(), {
  shapeOf = () => 'rect', fixedEndpoints = new Set(), foreignShapes = false, isFlowNode = () => true,
} = {}) {
  const entries = [];
  for (const e of edges || []) {
    if (skipIds.has(e.id)) continue;
    const points = edgeCoords[e.id];
    if (!points || points.length < 2) continue;
    entries.push({ id: e.id, source: e.source, target: e.target, points });
  }
  const contains = (o, i) => o.x <= i.x && o.y <= i.y && o.x + o.w >= i.x + i.w && o.y + o.h >= i.y + i.h;
  const changed = new Map();

  const sweeps = foreignShapes ? 2 : 1;
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let movedThisSweep = false;
    for (const entry of entries) {
      const srcBox = coords[entry.source];
      const tgtBox = coords[entry.target];
      if (!srcBox || !tgtBox) continue;
      const srcShape = shapeOf(entry.source);
      const tgtShape = shapeOf(entry.target);
      const stuck = endDefects(entry.points, srcBox, tgtBox, srcShape, tgtShape) > 0;
      const foreignNow = foreignShapes ? foreignShapeHits(entry.points, coords, entry, shapeOf, isFlowNode).length : 0;
      if (!stuck && !foreignNow) continue;

      const crossingsNow = crossingsAgainstOthers(entry, entry.points, entries);
      const allowance = foreignShapes ? foreignNow + ownShapeHits(entry.points, srcBox, tgtBox, srcShape, tgtShape) : 0;
      const overlapNow = foreignShapes ? collinearOverlap(entry.points, entry, entries) : 0;
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
      const clear = foreignShapes ? pathClearOfBoxesInclusive : pathClearOfBoxes;
      // Ports this candidate shares with another flow of the same node: [in/out, same direction].
      const sharedPorts = (s, t) => {
        let inOut = 0, sameDir = 0;
        for (const o of entries) {
          if (o.id === entry.id) continue;
          const os = o.points[0], oe = o.points[o.points.length - 1];
          if (o.source === entry.source && samePoint(os, s.p)) sameDir++;
          if (o.target === entry.source && samePoint(oe, s.p)) inOut++;
          if (o.target === entry.target && samePoint(oe, t.p)) sameDir++;
          if (o.source === entry.target && samePoint(os, t.p)) inOut++;
        }
        return [inOut, sameDir];
      };

      let best = null;
      for (const s of ports(srcBox, start, fixedEndpoints.has(entry.source))) {
        for (const t of ports(tgtBox, end, fixedEndpoints.has(entry.target))) {
          const out = OUTWARD[s.side];
          const inn = INWARD[t.side];
          const s1 = { x: s.p.x + out[0] * END_STUB_PX, y: s.p.y + out[1] * END_STUB_PX };
          const e1 = { x: t.p.x - inn[0] * END_STUB_PX, y: t.p.y - inn[1] * END_STUB_PX };
          const middle = routeAroundObstacles(s1, OUT_DIR_NAME[s.side], e1, IN_DIR_NAME[t.side], obstacles,
            { softObstacles, endLines: foreignShapes ? END_STUB_PX : 0 });
          if (!middle) continue;
          const cand = withoutCollinear([s.p, ...middle, t.p]);
          if (!isOrthogonal(cand)) continue;
          if (endDefects(cand, srcBox, tgtBox, srcShape, tgtShape)) continue;
          if (!clear(cand, coords, entry.source, entry.target)) continue;
          const crossings = crossingsAgainstOthers(entry, cand, entries);
          if (crossings > crossingsNow + allowance) continue;
          const moved = (s.moved ? 1 : 0) + (t.moved ? 1 : 0);
          let score;
          if (foreignShapes) {
            if (collinearOverlap(cand, entry, entries) > overlapNow + 0.5) continue;
            const [inOut, sameDir] = sharedPorts(s, t);
            score = [crossings, inOut, moved, bendCount(cand), sameDir, pathLength(cand)];
          } else {
            score = [crossings, moved, bendCount(cand), pathLength(cand)];
          }
          if (!best || lexLess(score, best.score)) best = { cand, score };
        }
      }
      if (best) {
        entry.points = best.cand;
        changed.set(entry.id, best.cand);
        movedThisSweep = true;
      }
    }
    if (!movedThisSweep) break;
  }

  if (!changed.size) return edgeCoords;
  const out = { ...edgeCoords };
  for (const [id, points] of changed) out[id] = points;
  return out;
}

/**
 * The options the pipeline hands reclipStuckEnds, from a flat node list (subprocess children
 * included): each node's drawn shape, and the endpoints that may never move. A boundary event's
 * endpoint is fixed — its place on the host is placeBoundaryEvents' contract (coordinates.js §5.0-).
 */
export function reclipOptionsFor(nodes) {
  const typeOf = {};
  const fixedEndpoints = new Set();
  for (const n of nodes || []) {
    typeOf[n.id] = n.type;
    if (n.attachedTo) fixedEndpoints.add(n.id);
  }
  const shapeOf = (id) => (isEvent(typeOf[id]) ? 'circle' : isGateway(typeOf[id]) ? 'diamond' : 'rect');
  // A flow node, for foreignShapes: what DI11 counts — artifacts (data references, annotations,
  // groups) are not obstacles a sequence flow may not cross.
  const isFlowNode = (id) => id in typeOf && !isArtifact(typeOf[id]);
  return { shapeOf, fixedEndpoints, isFlowNode };
}

// ── Gateway tips ─────────────────────────────────────────────────────────

/** An end counts as on its tip within this distance (px) — floating-point slack, not a tolerance. */
const TIP_EPS = 0.01;
/** Most keeper combinations snapGatewayTips tries for one gateway. */
const MAX_TIP_PLANS = 24;
/** Bends a route may gain for each of its gateway ends snapGatewayTips moves, counted against the
 *  route as it came into the pass. A vertex is worth one turn of the route, not a detour: a Z for a
 *  12.5 px offset trades a small dock defect for two corners the reader has to follow. */
const TIP_EXTRA_BENDS_PER_END = 1;
/**
 * A jog: two bends close together, i.e. a segment between two bends shorter than this (px). The
 * step a route needs to reach a vertex is at most half the gateway (25 px for the 50 px diamond;
 * ELK docks two flows of one side 12.5 px off the vertex), so twice END_STUB_PX, 30 px, catches
 * every step taken only for the vertex. In the example set the steps snapping added were 13 px and
 * 24.5 px, while a leg between two bends of a route this pass leaves alone is 42 px or longer
 * outside one 10 px leg ELK drew itself — jogCount compares against the route as it came in, so
 * that one is no reason to refuse anything.
 */
const JOG_MAX_PX = 2 * END_STUB_PX;
/**
 * A long back edge: a flow whose source lies at least this far (px, centre to centre) right of its
 * target, against the left-to-right flow direction (elk.direction RIGHT), i.e. a loop-back routed
 * past at least one other element. A back edge to the element right before it spans 155 px
 * (gateway half 25 + layer gap 80 + task half 50) up to 235 px in the example set; one element in
 * between adds at least a 50 px gateway and another 80 px gap, 310 px and more. On such a route a
 * jog taken only to reach the vertex puts a kink into a long line the reader follows across the
 * diagram; the facet dock is the smaller defect, so the end keeps it.
 */
const LONG_BACK_EDGE_PX = 300;

/**
 * Proper crossings of a route with the routes that share a node with it — crossingsAgainstOthers
 * leaves those out, since they touch by construction. Here only an intersection inside both
 * segments counts (no shared end, no T-touch), which two flows of one gateway can only get by being
 * routed across each other: when snapGatewayTips hands one of them to a perpendicular vertex.
 */
function crossingsWithNeighbours(entry, points, others) {
  let n = 0;
  const proper = (p1, p2, p3, p4) => {
    const o = [orientation(p1, p2, p3), orientation(p1, p2, p4), orientation(p3, p4, p1), orientation(p3, p4, p2)];
    return !o.includes(0) && o[0] !== o[1] && o[2] !== o[3];
  };
  for (const other of others) {
    if (other.id === entry.id || !adjacent(entry, other)) continue;
    for (const [p1, p2] of segmentsOf(points)) {
      for (const [p3, p4] of segmentsOf(other.points)) if (proper(p1, p2, p3, p4)) n++;
    }
  }
  return n;
}

/** Segments between two bends shorter than JOG_MAX_PX — the jogs of an orthogonal route. */
function jogCount(points) {
  const segs = segmentsOf(withoutCollinear(points));
  let n = 0;
  for (let i = 1; i + 1 < segs.length; i++) {
    const [a, b] = segs[i];
    if (Math.hypot(b.x - a.x, b.y - a.y) < JOG_MAX_PX) n++;
  }
  return n;
}

/** Side a route leaves its first point through, read from the first segment's direction; null
 *  when there is no segment or it is diagonal. */
function leavingSide(path) {
  const s = segmentsOf(path)[0];
  if (!s) return null;
  const dx = s[1].x - s[0].x, dy = s[1].y - s[0].y;
  if (Math.abs(dx) > 1e-6 && Math.abs(dy) > 1e-6) return null;
  if (Math.abs(dx) > 1e-6) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'bottom' : 'top';
}

/** Is `p` the vertex of the diamond in `box` on `side`? */
export function isOnGatewayTip(p, box, side) {
  const t = sideMidpoint(box, side);
  return Math.abs(p.x - t.x) < TIP_EPS && Math.abs(p.y - t.y) < TIP_EPS;
}

/** The far end of a straight route moved to `value` on the route's axis (y for a horizontal route,
 *  x for a vertical one), still on its shape's outline on the same side; null when that point is
 *  not on the outline (outside the side, or a diamond — whose vertex is its own gateway's business). */
function slideFarEnd(box, shape, p, horizontal, value) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  if (shape === 'diamond') return null;
  if (shape === 'circle') {
    const r = box.w / 2, d = value - (horizontal ? cy : cx);
    if (Math.abs(d) > r - 1) return null;
    const off = Math.sqrt(r * r - d * d);
    return horizontal ? { x: p.x < cx ? cx - off : cx + off, y: value } : { x: value, y: p.y < cy ? cy - off : cy + off };
  }
  if (horizontal) return value < box.y + 1 || value > box.y + box.h - 1 ? null : { x: p.x, y: value };
  return value < box.x + 1 || value > box.x + box.w - 1 ? null : { x: value, y: p.y };
}

/**
 * Candidate routes from the tip of `box` on `side` to the far end of `path` — a route oriented away
 * from the gateway (an incoming flow reversed). Each keeps the far end and as much of the current
 * route as it can; the caller judges them.
 *  - slide: the end moves along its own side to the tip and the waypoint after it follows on the
 *    perpendicular leg (a straight route moves its far end instead, when that stays on its outline);
 *  - join: a leg out of the tip, at least END_STUB_PX long, meets the current route at a waypoint
 *    or runs into a perpendicular leg of it and follows it from there;
 *  - jog: a straight route whose far end cannot follow gets a Z in the middle of its leg;
 *  - router: orthogonal-router.js from a stub at the tip to the far end's current end segment.
 */
function tipCandidates(path, box, side, far, routerArgs) {
  const T = sideMidpoint(box, side);
  const [ox, oy] = OUTWARD[side];
  const horizontal = ox !== 0;
  const p = path.map(q => ({ x: q.x, y: q.y }));
  const n = p.length;
  const F = p[n - 1];
  const out = [];
  const lead = (q) => (horizontal ? (q.x - T.x) * ox : (q.y - T.y) * oy);

  if (leavingSide(p) === side) {
    if (n > 2) {
      const q = p.map(v => ({ ...v }));
      q[0] = T;
      q[1] = horizontal ? { x: q[1].x, y: T.y } : { x: T.x, y: q[1].y };
      out.push(q);
    } else {
      const moved = slideFarEnd(far.box, far.shape, F, horizontal, horizontal ? T.y : T.x);
      if (moved) out.push([T, moved]);
      if (lead(F) >= 2 * END_STUB_PX) {
        const m = horizontal ? (T.x + F.x) / 2 : (T.y + F.y) / 2;
        out.push(horizontal
          ? [T, { x: m, y: T.y }, { x: m, y: F.y }, F]
          : [T, { x: T.x, y: m }, { x: F.x, y: m }, F]);
      }
    }
  }
  for (let k = 1; k < n - 1; k++) {
    const corner = horizontal ? { x: p[k].x, y: T.y } : { x: T.x, y: p[k].y };
    if (lead(corner) >= END_STUB_PX) out.push([T, corner, ...p.slice(k)]);
  }
  for (let k = 0; k < n - 1; k++) {
    const a = p[k], b = p[k + 1];
    // a leg perpendicular to the tip's axis that spans the tip's level: run into it, follow it on
    const perp = horizontal ? Math.abs(a.x - b.x) < 1e-6 : Math.abs(a.y - b.y) < 1e-6;
    if (!perp) continue;
    const level = horizontal ? T.y : T.x;
    const lo = horizontal ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
    const hi = horizontal ? Math.max(a.y, b.y) : Math.max(a.x, b.x);
    if (level <= lo || level >= hi) continue;
    const corner = horizontal ? { x: a.x, y: T.y } : { x: T.x, y: a.y };
    if (lead(corner) >= END_STUB_PX) out.push([T, corner, ...p.slice(k + 1)]);
  }
  if (routerArgs) {
    const endSide = leavingSide([...p].reverse());          // the side the route enters the far end through
    if (endSide) {
      const s1 = { x: T.x + ox * END_STUB_PX, y: T.y + oy * END_STUB_PX };
      const inn = OUTWARD[endSide];
      const e1 = { x: F.x + inn[0] * END_STUB_PX, y: F.y + inn[1] * END_STUB_PX };
      const middle = routeAroundObstacles(s1, OUT_DIR_NAME[side], e1, IN_DIR_NAME[endSide],
        routerArgs.obstacles, { softObstacles: routerArgs.softObstacles });
      if (middle) out.push([T, ...middle, F]);
    }
  }
  return out.map(withoutCollinear);
}

/** Count of the boxes in `coords` a route runs through (shapeClearance padding), not counting the
 *  edge's own two shapes nor a box containing one of them (its expanded subprocess). */
function foreignBoxHits(points, coords, entry) {
  const srcBox = coords[entry.source], tgtBox = coords[entry.target];
  const contains = (o, i) => o.x <= i.x && o.y <= i.y && o.x + o.w >= i.x + i.w && o.y + o.h >= i.y + i.h;
  let n = 0;
  for (const [id, box] of Object.entries(coords)) {
    if (id === entry.source || id === entry.target || !Number.isFinite(box?.x)) continue;
    if ((srcBox && contains(box, srcBox)) || (tgtBox && contains(box, tgtBox))) continue;
    for (let i = 0; i + 1 < points.length; i++) {
      if (!segmentClearOfBox(points[i], points[i + 1], box)) { n++; break; }
    }
  }
  return n;
}

/**
 * Gateway tips: every sequence flow docks on a vertex of its gateway's diamond, one flow per vertex.
 *
 * ELK knows a gateway only as a box (layout.js: elk.portConstraints FREE), so it spreads two flows
 * that share a side over that side, and clipOrthogonal (coordinates.js §5.1) then clips each one
 * along its segment's axis onto the slanted facet — 12.5 px off the vertex for two flows, and half
 * a pixel off for one flow where the routes come out of ELK half a pixel off the gateway's centre.
 *
 * Per gateway, the ends are grouped by the side their end segment runs through (leaving for an
 * outgoing flow, entering for an incoming one). On every side one end — the keeper — keeps the side
 * and moves onto its vertex. Every other end on that side moves to the free perpendicular vertex
 * towards its other end (top or bottom for a flow on the left or right, left or right for one on
 * the top or bottom), in model order; a vertex already used by another end, in either direction, is
 * not free. Then: a keeper that could not reach its vertex tries the free one towards its other end;
 * an end still without a vertex may take its side when the keeper can move on to a free vertex
 * towards ITS other end. An end that is left over keeps its dock on the facet (more flows than
 * vertices towards their other ends): two flows on one vertex would draw as one line, and a vertex
 * facing away from the other end would need a loop around the gateway.
 *
 * Keepers are ranked: flow direction first (the outgoing flow on the right, the incoming one on the
 * left), then the other end best aligned with the gateway's centre on that axis, then the other end
 * not a gateway, then the end nearest the vertex, then fewer bends, then model order — on the right
 * of a split that is the main branch (the ranking follows the right-out preference of the
 * multi-out tip proposal in #152). Every combination of keepers is tried (MAX_TIP_PLANS at most)
 * and the one with the fewest ends off a vertex or sharing one wins, then the fewest bends over the
 * gateway's flows, then rank.
 *
 * The moved end gets an orthogonal end segment (see tipCandidates). A candidate is taken only when
 * it is orthogonal, leaves the vertex on its side, has no more end defects (endDefects), runs
 * through no more foreign shapes, crosses no more flows — those sharing a node with it included,
 * so a flow handed to another vertex does not cut across its sibling — and lies on no more of
 * another flow's line than the current route, has at most one bend more per moved gateway end than the route as it came
 * into the pass (TIP_EXTRA_BENDS_PER_END) and, on a long back edge (LONG_BACK_EDGE_PX), no more
 * jogs (JOG_MAX_PX) than that route; best by bends, crossings, collinear overlap, length. No
 * candidate: the end stays where it is — on its facet, which is the lesser defect than a detour.
 *
 * Ends already exactly on their vertex are not touched. A boundary event is never a gateway, so its
 * fixed endpoint is never moved. Pure: returns a new edgeCoords object when a route changed,
 * `edgeCoords` itself otherwise.
 */
export function snapGatewayTips(edgeCoords, coords, edges, skipIds = new Set(), { shapeOf = () => 'rect' } = {}) {
  const entries = [];
  for (const e of edges || []) {
    if (skipIds.has(e.id)) continue;
    const points = edgeCoords[e.id];
    if (!points || points.length < 2) continue;
    entries.push({ id: e.id, source: e.source, target: e.target, points, original: points, order: entries.length });
  }
  const contains = (o, i) => o.x <= i.x && o.y <= i.y && o.x + o.w >= i.x + i.w && o.y + o.h >= i.y + i.h;
  const centreX = (id) => { const b = coords[id]; return b ? b.x + b.w / 2 : NaN; };
  // Gateway ends of `pts` that are not where the route had them when it came into the pass: each
  // may cost the route TIP_EXTRA_BENDS_PER_END bends (the bend budget is per end, not per attempt, so
  // an end moved twice in one plan — keeper, then handed on — still gets one bend).
  const movedGatewayEnds = (entry, pts) => {
    const o = entry.original;
    const moved = (p, q) => Math.abs(p.x - q.x) >= TIP_EPS || Math.abs(p.y - q.y) >= TIP_EPS;
    return (shapeOf(entry.source) === 'diamond' && moved(pts[0], o[0]) ? 1 : 0)
      + (shapeOf(entry.target) === 'diamond' && moved(pts[pts.length - 1], o[o.length - 1]) ? 1 : 0);
  };
  const isLongBackEdge = (entry) => centreX(entry.source) - centreX(entry.target) >= LONG_BACK_EDGE_PX;
  const byGateway = new Map();
  for (const entry of entries) {
    if (entry.source === entry.target) continue;
    for (const role of ['out', 'in']) {
      const node = role === 'out' ? entry.source : entry.target;
      if (shapeOf(node) !== 'diamond' || !coords[node]) continue;
      if (!byGateway.has(node)) byGateway.set(node, []);
      byGateway.get(node).push({ entry, role, node, far: role === 'out' ? entry.target : entry.source });
    }
  }
  const changed = new Map();
  const pathOf = (end) => (end.role === 'out' ? end.entry.points : [...end.entry.points].reverse());
  const save = (list) => list.map(en => ({ en, points: en.points, had: changed.has(en.id), was: changed.get(en.id) }));
  const restore = (saved) => {
    for (const { en, points, had, was } of saved) {
      en.points = points;
      if (had) changed.set(en.id, was); else changed.delete(en.id);
    }
  };

  // tryEnd is a function of the end, the vertex and the routes of the gateway's own flows (every other
  // route stays put while one gateway is worked on), and the plans below try the same moves from the
  // same routes again and again: per gateway, its answer is kept under exactly those inputs and
  // replayed — the same route array, so the plans see what a fresh call would build.
  let tipMemo = null, tipInvolved = [];
  const routeIds = new WeakMap();
  let nextRouteId = 0;
  const routeId = (pts) => { if (!routeIds.has(pts)) routeIds.set(pts, ++nextRouteId); return routeIds.get(pts); };
  const tryEnd = (end, side, box) => {
    if (!tipMemo) return tryEndNow(end, side, box);
    const key = `${end.entry.id}|${end.role}|${side}|${tipInvolved.map(en => routeId(en.points)).join(',')}`;
    const hit = tipMemo.get(key);
    if (hit) {
      if (hit.pts) { end.entry.points = hit.pts; changed.set(end.entry.id, hit.pts); }
      return hit.ok;
    }
    const before = end.entry.points;
    const ok = tryEndNow(end, side, box);
    tipMemo.set(key, { ok, pts: end.entry.points !== before ? end.entry.points : null });
    return ok;
  };
  const tryEndNow = (end, side, box) => {
    const { entry } = end;
    const path = pathOf(end);
    if (isOnGatewayTip(path[0], box, side) && leavingSide(path) === side) return true;
    const farBox = coords[end.far];
    if (!farBox) return false;
    const srcBox = coords[entry.source], tgtBox = coords[entry.target];
    const srcShape = shapeOf(entry.source), tgtShape = shapeOf(entry.target);
    const obstacles = Object.values(coords).filter(b => Number.isFinite(b?.x) &&
      (b === srcBox || b === tgtBox || (!contains(b, srcBox) && !contains(b, tgtBox))));
    const softObstacles = entries.filter(o => o.id !== entry.id && !adjacent(entry, o)).map(o => o.points);
    const now = {
      defects: endDefects(entry.points, srcBox, tgtBox, srcShape, tgtShape),
      hits: foreignBoxHits(entry.points, coords, entry),
      crossings: crossingsAgainstOthers(entry, entry.points, entries),
      neighbourCrossings: crossingsWithNeighbours(entry, entry.points, entries),
      overlap: collinearOverlap(entry.points, entry, entries),
      bends: bendCount(entry.points),
    };
    const bendBudget = (pts) => bendCount(entry.original) + TIP_EXTRA_BENDS_PER_END * movedGatewayEnds(entry, pts);
    const noJogs = isLongBackEdge(entry) ? jogCount(entry.original) : Infinity;
    let best = null;
    for (const cand of tipCandidates(path, box, side, { box: farBox, shape: shapeOf(end.far) }, { obstacles, softObstacles })) {
      if (!isOrthogonal(cand) || leavingSide(cand) !== side || !isOnGatewayTip(cand[0], box, side)) continue;
      const pts = end.role === 'out' ? cand : [...cand].reverse();
      if (endDefects(pts, srcBox, tgtBox, srcShape, tgtShape) > now.defects) continue;
      if (foreignBoxHits(pts, coords, entry) > now.hits) continue;
      const bends = bendCount(pts);
      if (bends > bendBudget(pts)) continue;
      if (jogCount(pts) > noJogs) continue;
      const crossings = crossingsAgainstOthers(entry, pts, entries);
      if (crossings > now.crossings) continue;
      if (crossingsWithNeighbours(entry, pts, entries) > now.neighbourCrossings) continue;
      const overlap = collinearOverlap(pts, entry, entries);
      if (overlap > now.overlap + 0.5) continue;
      const score = [bends, crossings, overlap, pathLength(pts)];
      if (!best || lexLess(score, best.score)) best = { pts, score };
    }
    if (!best) return false;
    entry.points = best.pts;
    changed.set(entry.id, best.pts);
    return true;
  };

  for (const [gw, ends] of byGateway) {
    tipMemo = new Map();
    tipInvolved = [...new Set(ends.map(e => e.entry))];
    const box = coords[gw];
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const centre = (id) => { const b = coords[id]; return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : { x: cx, y: cy }; };
    // The perpendicular vertex towards an end's other end, seen from the side it docks on now.
    // Other end level with the gateway: the side of the centre the end docks on now decides.
    const towardOf = (end, side) => {
      const c = centre(end.far), p = pathOf(end)[0];
      const pick = (d, lo, hi) => (d < -0.5 ? lo : d > 0.5 ? hi : null);
      return side === 'left' || side === 'right'
        ? pick(c.y - cy, 'top', 'bottom') ?? pick(p.y - cy, 'top', 'bottom')
        : pick(c.x - cx, 'left', 'right') ?? pick(p.x - cx, 'left', 'right');
    };
    const groups = {};
    for (const end of ends) {
      const side = leavingSide(pathOf(end));
      if (side) (groups[side] ??= []).push(end);
    }
    for (const side of SIDES) {
      const g = groups[side];
      if (!g) continue;
      const horizontal = side === 'left' || side === 'right';
      const offset = (end) => { const c = centre(end.far); return horizontal ? Math.abs(c.y - cy) : Math.abs(c.x - cx); };
      const farIsGateway = (end) => (shapeOf(end.far) === 'diamond' ? 1 : 0);
      // Flow direction first: on the right the outgoing flow keeps the vertex, on the left the incoming one.
      const against = (end) => ((side === 'right' && end.role === 'in') || (side === 'left' && end.role === 'out') ? 1 : 0);
      const tip = sideMidpoint(box, side);
      const away = (end) => { const p = pathOf(end)[0]; return Math.hypot(p.x - tip.x, p.y - tip.y); };
      g.sort((a, b) => against(a) - against(b) || Math.round(offset(a)) - Math.round(offset(b))
        || farIsGateway(a) - farIsGateway(b) || away(a) - away(b)
        || bendCount(a.entry.points) - bendCount(b.entry.points) || a.entry.order - b.entry.order);
    }

    // One plan: `keeper` names the end that keeps each side; see the function comment for the rest.
    const runPlan = (keeper) => {
      const owner = { ...keeper };
      const displaced = [];
      for (const side of SIDES) if (groups[side]) displaced.push(...groups[side].filter(e => e !== keeper[side]));
      const failed = SIDES.filter(side => owner[side] && !tryEnd(owner[side], side, box));
      displaced.sort((a, b) => a.entry.order - b.entry.order || (a.role === 'out' ? -1 : 1));
      const unplaced = [];
      for (const end of displaced) {
        const toward = towardOf(end, leavingSide(pathOf(end)));
        if (toward && !owner[toward] && tryEnd(end, toward, box)) owner[toward] = end;
        else unplaced.push(end);
      }
      // A vertex the first try could not reach may have been blocked by a sibling that has moved on
      // since (a flow still docked on that vertex, then moved to its own): one more try each. A
      // keeper that still cannot reach its own vertex — a flow that leaves a side only to turn at
      // once, its other end level with that vertex — tries the free one towards its other end and
      // hands its side on.
      for (const side of failed) {
        const end = owner[side];
        if (tryEnd(end, side, box)) continue;
        const toward = towardOf(end, side);
        if (toward && !owner[toward] && tryEnd(end, toward, box)) { owner[toward] = end; owner[side] = null; }
      }
      // An end with no free vertex towards its other end: its side's keeper may make way, when the
      // keeper has a free vertex towards ITS other end — then the end takes the side. Undone when
      // the end cannot reach the vertex after all.
      for (const end of unplaced) {
        const side = leavingSide(pathOf(end));
        const holder = side && owner[side];
        if (!holder || holder === end) continue;
        const toward = towardOf(holder, side);
        if (!toward || owner[toward]) continue;
        const keep = save([holder.entry]);
        if (!tryEnd(holder, toward, box)) continue;
        if (tryEnd(end, side, box)) { owner[toward] = holder; owner[side] = end; continue; }
        restore(keep);
      }
    };

    // Which end keeps a side is not decided by rank alone: every combination of keepers is tried
    // (at most MAX_TIP_PLANS, the rest of the sides then keep their first-ranked end), and the one
    // with the fewest ends off a vertex or sharing one wins, then the fewest bends over this
    // gateway's flows, then rank — so a default flow already on the bottom vertex with one bend is
    // not pushed round to the right with three for a sibling that would gain nothing.
    const sides = SIDES.filter(side => groups[side]);
    let plans = [{}];
    for (const side of sides) {
      const next = plans.flatMap(p => groups[side].map(e => ({ ...p, [side]: e })));
      plans = next.length <= MAX_TIP_PLANS ? next : plans.map(p => ({ ...p, [side]: groups[side][0] }));
    }
    const involved = [...new Set(ends.map(e => e.entry))];
    const start = save(involved);
    const judge = () => {
      const used = new Map();
      let bad = 0;
      for (const end of ends) {
        const p = pathOf(end)[0];
        const side = SIDES.find(sd => isOnGatewayTip(p, box, sd));
        if (!side) { bad++; continue; }
        used.set(side, (used.get(side) || 0) + 1);
      }
      for (const n of used.values()) if (n > 1) bad += n - 1;
      return [bad, involved.reduce((n, en) => n + bendCount(en.points), 0)];
    };
    let best = null;
    if (plans.length > 1) {
      plans.forEach((plan, rank) => {
        restore(start);
        runPlan(plan);
        const score = [...judge(), rank];
        if (!best || lexLess(score, best.score)) best = { plan, score };
      });
      restore(start);
    }
    runPlan(best ? best.plan : plans[0]);
  }

  if (!changed.size) return edgeCoords;
  const out = { ...edgeCoords };
  for (const [id, points] of changed) out[id] = points;
  return out;
}
