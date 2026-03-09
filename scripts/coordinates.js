/**
 * BPMN Coordinates — ELK Result → Coordinate Maps + Edge Clipping
 * Translates raw ELK layout output into absolute coordinates for rendering.
 */

import { isEvent, isGateway } from './types.js';
import { SHAPE, LANE_HEADER_W, LANE_PADDING, EXTERNAL_LABEL_H, CFG } from './utils.js';
import { identifyHappyPathNodes } from './topology.js';

function buildCoordinateMap(elkResult, lc) {
  const coords     = {};
  const laneCoords = {};
  const poolCoords = {};
  const edgeCoords = {};

  const allProcesses = lc.pools ? lc.pools : [lc];
  const allCollapsedPools = lc.collapsedPools || [];
  const allLaneIds = new Set();
  const allPoolIds = new Set();
  for (const p of allProcesses) {
    allPoolIds.add(p.id);
    for (const l of (p.lanes || [])) allLaneIds.add(l.id);
  }
  for (const cp of allCollapsedPools) allPoolIds.add(cp.id);

  const collectNodes = (node, offX = 0, offY = 0) => {
    const ax = (node.x || 0) + offX;
    const ay = (node.y || 0) + offY;

    if (node.id === 'collaboration' || node.id === 'root') {
      for (const c of node.children || []) collectNodes(c, ax, ay);
      for (const e of node.edges   || []) collectEdge(e, ax, ay);
      return;
    }

    if (allPoolIds.has(node.id)) {
      poolCoords[node.id] = { x: ax, y: ay, w: node.width, h: node.height };
      for (const c of node.children || []) collectNodes(c, ax, ay);
      for (const e of node.edges   || []) collectEdge(e, ax, ay);
      return;
    }

    if (node.id === 'pool') {
      poolCoords['_singlePool'] = { x: ax, y: ay, w: node.width, h: node.height };
      for (const c of node.children || []) collectNodes(c, ax, ay);
      for (const e of node.edges   || []) collectEdge(e, ax, ay);
      return;
    }

    if (allLaneIds.has(node.id)) {
      laneCoords[node.id] = { x: ax, y: ay, w: node.width, h: node.height };
      for (const c of node.children || []) collectNodes(c, ax, ay);
      for (const e of node.edges   || []) collectEdge(e, ax, ay);
      return;
    }

    // Regular node — use actual shape dimensions, not ELK dimensions
    const shapeH = node._shapeH || node.height;
    const lcNode = findNodeInAllProcesses(node.id, allProcesses);
    const specSz = SHAPE[lcNode?.type] || { w: node.width, h: shapeH };
    coords[node.id] = { x: ax, y: ay, w: specSz.w, h: specSz.h };

    for (const c of node.children || []) collectNodes(c, ax, ay);
    for (const e of node.edges   || []) collectEdge(e, ax, ay);
  };

  const collectEdge = (edge, offX = 0, offY = 0) => {
    const pts = [];
    for (const sec of edge.sections || []) {
      pts.push({ x: sec.startPoint.x + offX, y: sec.startPoint.y + offY });
      for (const bp of sec.bendPoints || []) pts.push({ x: bp.x + offX, y: bp.y + offY });
      pts.push({ x: sec.endPoint.x + offX, y: sec.endPoint.y + offY });
    }
    edgeCoords[edge.id] = pts;
  };

  collectNodes(elkResult);

  // §5.0  Compute lane bounds from node positions (flat layout approach)
  //       Since we use ELK partitioning, nodes are direct children of the pool.
  //       Lane bounds are computed by grouping nodes by their lane assignment
  //       and calculating the bounding box + padding for each group.
  for (const proc of allProcesses) {
    const lanes = proc.lanes || [];
    if (lanes.length === 0) continue;
    const procNodes = proc.nodes || [];

    // Group nodes by lane
    const laneNodeGroups = {};
    for (const lane of lanes) laneNodeGroups[lane.id] = [];
    for (const n of procNodes) {
      if (n.lane && laneNodeGroups[n.lane] && coords[n.id]) {
        laneNodeGroups[n.lane].push(coords[n.id]);
      }
    }

    // Find the pool bounding box for x/width reference
    const poolC = poolCoords[proc.id] || poolCoords['_singlePool'];
    const poolX = poolC ? poolC.x : 0;
    const poolW = poolC ? poolC.w : Math.max(...Object.values(coords).map(c => c.x + c.w)) + LANE_PADDING;

    // Compute lane bounds from node positions
    for (const lane of lanes) {
      const nodeCoords = laneNodeGroups[lane.id];
      if (nodeCoords.length === 0) {
        // Empty lane — give it minimum height
        laneCoords[lane.id] = { x: poolX + LANE_HEADER_W, y: 0, w: poolW - LANE_HEADER_W, h: 60 };
        continue;
      }
      const minY = Math.min(...nodeCoords.map(c => c.y)) - LANE_PADDING;
      const maxY = Math.max(...nodeCoords.map(c => c.y + c.h)) + LANE_PADDING + EXTERNAL_LABEL_H;

      laneCoords[lane.id] = {
        x: poolX + LANE_HEADER_W,
        y: minY,
        w: poolW - LANE_HEADER_W,
        h: maxY - minY,
      };
    }

    // Fix lane overlaps: if two lanes overlap vertically, insert gap
    const laneSorted = lanes.map(l => l.id).filter(id => laneCoords[id])
      .sort((a, b) => laneCoords[a].y - laneCoords[b].y);

    for (let i = 1; i < laneSorted.length; i++) {
      const prev = laneCoords[laneSorted[i - 1]];
      const curr = laneCoords[laneSorted[i]];
      const prevBottom = prev.y + prev.h;
      if (curr.y < prevBottom + 2) {
        // Shift this lane and all its nodes down
        const delta = prevBottom + 2 - curr.y;
        curr.y += delta;
        // Shift all nodes in this lane
        for (const n of procNodes) {
          if (n.lane === laneSorted[i] && coords[n.id]) {
            coords[n.id].y += delta;
          }
        }
        // Shift edge waypoints that are within this lane's Y range
        for (const e of (proc.edges || [])) {
          const pts = edgeCoords[e.id];
          if (!pts) continue;
          for (const p of pts) {
            if (p.y >= curr.y - delta && p.y < curr.y) {
              p.y += delta;
            }
          }
        }
        // Recalculate lane height after shift
        const nodeCoords = laneNodeGroups[laneSorted[i]];
        if (nodeCoords.length > 0) {
          const minY = Math.min(...nodeCoords.map(c => c.y)) - LANE_PADDING;
          const maxY = Math.max(...nodeCoords.map(c => c.y + c.h)) + LANE_PADDING + EXTERNAL_LABEL_H;
          curr.y = minY;
          curr.h = maxY - minY;
        }
      }
    }

    // Equalize all lane widths
    const allLcs = lanes.map(l => laneCoords[l.id]).filter(Boolean);
    if (allLcs.length > 0) {
      const maxW = Math.max(...allLcs.map(l => l.w));
      const minX = Math.min(...allLcs.map(l => l.x));
      for (const lc_ of allLcs) {
        lc_.x = minX;
        lc_.w = maxW;
      }

      // Recalculate pool bounds from lane bounds
      const poolKey = proc.id;
      const pc = poolCoords[poolKey] || poolCoords['_singlePool'];
      if (pc) {
        pc.x = minX - LANE_HEADER_W;
        pc.y = Math.min(...allLcs.map(l => l.y));
        pc.w = maxW + LANE_HEADER_W;
        pc.h = Math.max(...allLcs.map(l => l.y + l.h)) - pc.y;
      }
    }
  }

  // §5.0b  Equalize pool widths across entire collaboration (BPMN convention)
  const allPoolCoordValues = Object.values(poolCoords);
  if (allPoolCoordValues.length > 1) {
    const maxPoolW = Math.max(...allPoolCoordValues.map(p => p.w));
    const minPoolX = Math.min(...allPoolCoordValues.map(p => p.x));
    for (const pc of allPoolCoordValues) {
      pc.x = minPoolX;
      pc.w = maxPoolW;
    }
    // Also extend lanes to match pool width
    for (const lc_ of Object.values(laneCoords)) {
      lc_.w = maxPoolW - LANE_HEADER_W;
    }
  }

  // §5.0c  Happy-Path Y-Leveling (align happy-path nodes to median Y per lane)
  if (CFG.layout?.happyPathLeveling) {
    for (const proc of allProcesses) {
      const happyIds = identifyHappyPathNodes(proc.nodes || [], proc.edges || []);
      if (happyIds.size === 0) continue;
      const lanes = proc.lanes || [];
      if (lanes.length > 0) {
        for (const lane of lanes) {
          const laneHappyNodes = (proc.nodes || [])
            .filter(n => n.lane === lane.id && happyIds.has(n.id))
            .map(n => n.id)
            .filter(id => coords[id]);
          if (laneHappyNodes.length < 2) continue;
          const ys = laneHappyNodes.map(id => coords[id].y + coords[id].h / 2);
          ys.sort((a, b) => a - b);
          const medianY = ys[Math.floor(ys.length / 2)];
          for (const id of laneHappyNodes) {
            coords[id].y = medianY - coords[id].h / 2;
          }
        }
      } else {
        const happyNodeIds = [...happyIds].filter(id => coords[id]);
        if (happyNodeIds.length >= 2) {
          const ys = happyNodeIds.map(id => coords[id].y + coords[id].h / 2);
          ys.sort((a, b) => a - b);
          const medianY = ys[Math.floor(ys.length / 2)];
          for (const id of happyNodeIds) {
            coords[id].y = medianY - coords[id].h / 2;
          }
        }
      }
    }
  }

  // §5.1  Orthogonal edge endpoint clipping
  //
  // ELK produces orthogonal routes (90° bends). We must preserve this when
  // clipping endpoints to the actual (smaller) shape boundaries.
  // Strategy: detect whether the first/last segment is horizontal or vertical,
  // then project the endpoint onto the shape boundary along that axis only.
  //
  const allProcessNodes = allProcesses.flatMap(p => p.nodes || []);
  const allProcessEdges = allProcesses.flatMap(p => p.edges || []);
  for (const edge of allProcessEdges) {
    const eid = edge.id;
    const pts = edgeCoords[eid];
    if (!pts || pts.length < 2) continue;

    const srcCoord = coords[edge.source];
    const tgtCoord = coords[edge.target];
    const srcNode  = allProcessNodes.find(n => n.id === edge.source);
    const tgtNode  = allProcessNodes.find(n => n.id === edge.target);

    if (srcCoord && srcNode) {
      pts[0] = clipOrthogonal(srcCoord, srcNode.type, pts[0], pts[1], 'source');
    }
    if (tgtCoord && tgtNode) {
      const last = pts.length - 1;
      pts[last] = clipOrthogonal(tgtCoord, tgtNode.type, pts[last], pts[last - 1], 'target');
    }
  }

  // §5.2  Synthetic routing for edges without ELK routing data
  //        (cross-lane edges in rectpacking mode have no sections)
  for (const edge of allProcessEdges) {
    const eid = edge.id;
    const pts = edgeCoords[eid];
    if (pts && pts.length >= 2) continue;  // already routed

    const srcC = coords[edge.source];
    const tgtC = coords[edge.target];
    if (!srcC || !tgtC) continue;

    const srcCx = srcC.x + srcC.w / 2;
    const srcCy = srcC.y + srcC.h / 2;
    const tgtCx = tgtC.x + tgtC.w / 2;
    const tgtCy = tgtC.y + tgtC.h / 2;

    const dx = Math.abs(tgtCx - srcCx);
    const dy = Math.abs(tgtCy - srcCy);

    if (dy > dx) {
      // Primarily vertical (cross-lane): go down from source bottom, horizontal, up to target
      const srcExit = { x: srcCx, y: srcCy > tgtCy ? srcC.y : srcC.y + srcC.h };
      const tgtEntry = { x: tgtCx, y: srcCy > tgtCy ? tgtC.y + tgtC.h : tgtC.y };
      const midY = (srcExit.y + tgtEntry.y) / 2;
      edgeCoords[eid] = [
        srcExit,
        { x: srcCx, y: midY },
        { x: tgtCx, y: midY },
        tgtEntry,
      ];
    } else {
      // Primarily horizontal: right side → horizontal → up/down → horizontal → left side
      const srcExit = { x: srcC.x + srcC.w, y: srcCy };
      const tgtEntry = { x: tgtC.x, y: tgtCy };
      const midX = (srcExit.x + tgtEntry.x) / 2;
      edgeCoords[eid] = [
        srcExit,
        { x: midX, y: srcCy },
        { x: midX, y: tgtCy },
        tgtEntry,
      ];
    }
  }

  // §5.3  Force orthogonal: any remaining diagonal segments get converted
  //        to horizontal-then-vertical (or vice versa) dog-legs.
  for (const eid of Object.keys(edgeCoords)) {
    const pts = edgeCoords[eid];
    if (!pts || pts.length < 2) continue;
    edgeCoords[eid] = enforceOrthogonal(pts);
  }

  return { coords, laneCoords, poolCoords, edgeCoords };
}

/**
 * Force all segments in a polyline to be either horizontal or vertical.
 * Diagonal segments are converted to L-shaped dog-legs:
 *   - If the segment is more horizontal than vertical: go horizontal first, then vertical
 *   - If more vertical: go vertical first, then horizontal
 */
function enforceOrthogonal(pts) {
  if (pts.length < 2) return pts;
  const result = [pts[0]];

  for (let i = 1; i < pts.length; i++) {
    const prev = result[result.length - 1];
    const cur  = pts[i];
    const dx   = Math.abs(cur.x - prev.x);
    const dy   = Math.abs(cur.y - prev.y);

    // Already orthogonal (within tolerance)
    if (dx < 1 || dy < 1) {
      // Snap to exact axis
      if (dx < 1) {
        result.push({ x: prev.x, y: cur.y });
      } else {
        result.push({ x: cur.x, y: prev.y });
      }
      continue;
    }

    // Diagonal — insert a bend point to make it orthogonal
    // Prefer horizontal-first for left→right flow direction
    if (dx >= dy) {
      // Go horizontal to target x, then vertical to target y
      result.push({ x: cur.x, y: prev.y });
      result.push(cur);
    } else {
      // Go vertical to target y, then horizontal to target x
      result.push({ x: prev.x, y: cur.y });
      result.push(cur);
    }
  }
  return result;
}

function findNodeInAllProcesses(nodeId, processes) {
  for (const p of processes) {
    for (const n of (p.nodes || [])) {
      if (n.id === nodeId) return n;
      // Search inside expanded subprocesses (1 level)
      if (n.isExpanded && n.nodes) {
        const child = n.nodes.find(c => c.id === nodeId);
        if (child) return child;
      }
    }
  }
  return null;
}

/**
 * Orthogonal clipping: project endpoint onto shape boundary while keeping
 * the segment axis (horizontal or vertical) intact.
 *
 * @param shape   {x,y,w,h} of the actual BPMN shape
 * @param type    BPMN element type
 * @param edgePt  the endpoint to clip (start or end of the path)
 * @param nextPt  the adjacent point (determines segment direction)
 * @param role    'source' or 'target'
 */
function clipOrthogonal(shape, type, edgePt, nextPt, role) {
  const cx = shape.x + shape.w / 2;
  const cy = shape.y + shape.h / 2;

  // Determine if segment is horizontal or vertical
  const dx = Math.abs(nextPt.x - edgePt.x);
  const dy = Math.abs(nextPt.y - edgePt.y);
  const isHorizontal = dx >= dy;

  if (isEvent(type)) {
    const r = shape.w / 2;
    return clipCircleOrthogonal(cx, cy, r, nextPt, isHorizontal);
  }
  if (isGateway(type)) {
    return clipDiamondOrthogonal(shape, nextPt, isHorizontal);
  }
  // Activity / rectangle
  return clipRectOrthogonal(shape, nextPt, isHorizontal);
}

/**
 * Circle: for horizontal approach, place point at cx ± r on the y-level of nextPt.
 * For vertical approach, place at cy ± r on the x-level of nextPt.
 */
function clipCircleOrthogonal(cx, cy, r, nextPt, isHorizontal) {
  if (isHorizontal) {
    // Horizontal segment: keep y from nextPt, compute x on circle boundary
    const y = nextPt.y;
    const dyc = y - cy;
    // Clamp: if nextPt.y is outside the circle, snap to center height
    if (Math.abs(dyc) >= r) {
      return { x: nextPt.x > cx ? cx + r : cx - r, y: cy };
    }
    const xOffset = Math.sqrt(r * r - dyc * dyc);
    const x = nextPt.x > cx ? cx + xOffset : cx - xOffset;
    return { x, y };
  } else {
    // Vertical segment: keep x from nextPt, compute y on circle boundary
    const x = nextPt.x;
    const dxc = x - cx;
    if (Math.abs(dxc) >= r) {
      return { x: cx, y: nextPt.y > cy ? cy + r : cy - r };
    }
    const yOffset = Math.sqrt(r * r - dxc * dxc);
    const y = nextPt.y > cy ? cy + yOffset : cy - yOffset;
    return { x, y };
  }
}

/**
 * Diamond: for horizontal approach, find x where the diamond edge crosses the y-level.
 * For vertical, find y where the diamond edge crosses the x-level.
 * Diamond with center (cx,cy) and half-widths (hw,hh):
 *   |x-cx|/hw + |y-cy|/hh = 1
 */
function clipDiamondOrthogonal(shape, nextPt, isHorizontal) {
  const cx = shape.x + shape.w / 2;
  const cy = shape.y + shape.h / 2;
  const hw = shape.w / 2, hh = shape.h / 2;

  if (isHorizontal) {
    const y = nextPt.y;
    const dyc = Math.abs(y - cy);
    if (dyc >= hh) {
      // Outside diamond vertically, snap to tip
      return { x: cx, y: nextPt.y > cy ? cy + hh : cy - hh };
    }
    const xOffset = hw * (1 - dyc / hh);
    const x = nextPt.x > cx ? cx + xOffset : cx - xOffset;
    return { x, y };
  } else {
    const x = nextPt.x;
    const dxc = Math.abs(x - cx);
    if (dxc >= hw) {
      return { x: nextPt.x > cx ? cx + hw : cx - hw, y: cy };
    }
    const yOffset = hh * (1 - dxc / hw);
    const y = nextPt.y > cy ? cy + yOffset : cy - yOffset;
    return { x, y };
  }
}

/**
 * Rectangle: for horizontal approach, x = left or right edge, y stays.
 * For vertical, y = top or bottom edge, x stays.
 */
function clipRectOrthogonal(shape, nextPt, isHorizontal) {
  if (isHorizontal) {
    const y = nextPt.y;
    // Clamp y to be within the rect
    const clampedY = Math.max(shape.y, Math.min(shape.y + shape.h, y));
    const x = nextPt.x > shape.x + shape.w / 2 ? shape.x + shape.w : shape.x;
    return { x, y: clampedY };
  } else {
    const x = nextPt.x;
    const clampedX = Math.max(shape.x, Math.min(shape.x + shape.w, x));
    const y = nextPt.y > shape.y + shape.h / 2 ? shape.y + shape.h : shape.y;
    return { x: clampedX, y };
  }
}

export { buildCoordinateMap, enforceOrthogonal, findNodeInAllProcesses, clipOrthogonal };
