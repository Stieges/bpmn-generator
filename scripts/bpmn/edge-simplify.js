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
 * This module post-processes each edge: if either of the two possible
 * single-bend L-shapes (horizontal-first or vertical-first) clears all
 * node bounding boxes, use it instead of ELK's path.
 *
 * Pure function. Doesn't mutate ELK's coordMap if no simplification is
 * possible. Doesn't touch edges that are already straight (2 waypoints)
 * or single-bend (3 waypoints).
 */

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
 * Try to simplify a single edge's waypoints into a 3-waypoint L-shape.
 * Returns the simplified waypoints if one of the L-shapes clears all
 * non-endpoint nodes, otherwise returns the original waypoints unchanged.
 */
export function simplifyEdge(waypoints, boxes, sourceId, targetId) {
  if (!waypoints || waypoints.length <= 3) return waypoints;  // already minimal
  const start = waypoints[0];
  const end = waypoints[waypoints.length - 1];
  if (start.x === end.x || start.y === end.y) return waypoints;  // would be 2-pt straight

  // Two candidate L-shapes: bend at (end.x, start.y) or (start.x, end.y)
  const candidates = [
    [start, { x: end.x, y: start.y }, end],  // horizontal-first
    [start, { x: start.x, y: end.y }, end],  // vertical-first
  ];

  const valid = candidates.filter(c => pathClearOfBoxes(c, boxes, sourceId, targetId));
  if (valid.length === 0) return waypoints;
  // Prefer the shorter (and if tied, the one that matches the original's first-segment direction)
  valid.sort((a, b) => pathLength(a) - pathLength(b));
  return valid[0];
}

/**
 * Apply simplification across all edges in a coordMap.
 * coords: { nodeId: {x,y,w,h} }
 * edgeCoords: { edgeId: [{x,y}, ...] }
 * edges: array of { id, source, target } from logic-core
 * skipIds: edge ids to leave untouched
 * Returns a new edgeCoords (does not mutate the input).
 *
 * `skipIds` exists for routes that are already final: clearance here is checked against NODE
 * boxes only, so collapsing a message flow to an L-shape would happily lay its
 * line through a pool body or into a shape — undoing the clipping and corridor
 * routing done in coordinates.js §5.4.
 */
export function simplifyAllEdges(edgeCoords, coords, edges, skipIds = new Set()) {
  const out = {};
  const edgeBySrcTarget = {};
  for (const e of edges || []) {
    edgeBySrcTarget[e.id] = { source: e.source, target: e.target };
  }
  for (const [id, wp] of Object.entries(edgeCoords)) {
    if (skipIds.has(id)) { out[id] = wp; continue; }
    const lookup = edgeBySrcTarget[id];
    out[id] = simplifyEdge(wp, coords, lookup?.source, lookup?.target);
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
 */
export function repairCrossings(edgeCoords, coords, edges, skipIds = new Set(), opts = {}) {
  const maxPasses = opts.maxPasses ?? DEFAULT_MAX_PASSES;

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
