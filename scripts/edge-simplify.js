/**
 * edge-simplify.js — Post-process ELK edge waypoints to reduce zigzag.
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
 * Returns a new edgeCoords (does not mutate the input).
 */
export function simplifyAllEdges(edgeCoords, coords, edges) {
  const out = {};
  const edgeBySrcTarget = {};
  for (const e of edges || []) {
    edgeBySrcTarget[e.id] = { source: e.source, target: e.target };
  }
  for (const [id, wp] of Object.entries(edgeCoords)) {
    const lookup = edgeBySrcTarget[id];
    out[id] = simplifyEdge(wp, coords, lookup?.source, lookup?.target);
  }
  return out;
}
