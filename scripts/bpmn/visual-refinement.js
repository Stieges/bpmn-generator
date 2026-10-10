/**
 * BPMN Visual Refinement — Post-Layout Coordinate Transforms
 *
 * Pure functions that run between buildCoordinateMap and serialization.
 * All transforms are opt-in via config.visualRefinement.enabled.
 *
 * - estimateTextWidth:          char-count-based text width heuristic
 * - computeDynamicLaneHeaders:  per-pool dynamic lane header strip width
 * - repairEdgeLabels:           bbox-collision-based label nudging
 * - compactLanes:               reduce lane height to content bbox + LANE_COMPACT_PADDING; cascade-shift nodes + edge waypoints
 */

import { LANE_HEADER_W } from './constants.js';
import { wrapTextByPx } from '../shared/utils.js';
import { flattenProcessNodes, flattenProcessEdges } from './coordinates.js';

// Average character-width factors for Arial at fontSize 1 (in px).
// Calibrated against bpmn.io renderings; accurate to ~±15% which is
// enough for layout decisions.
const CHAR_WIDTH_FACTOR = 0.6;

/**
 * Estimate rendered width of a string in pixels.
 * @param {string} text
 * @param {number} fontSize - in px
 * @returns {number} estimated width in px
 */
export function estimateTextWidth(text, fontSize = 11) {
  if (!text) return 0;
  return text.length * fontSize * CHAR_WIDTH_FACTOR;
}

const FONT_SIZE = 11;
const LINE_GAP  = 3;     // additional spacing between wrapped lines
const STRIP_PADDING = 8; // 4px each side inside header strip

/**
 * Dynamically size per-pool lane-header strip width to fit rotated labels.
 * Wraps long labels into multiple vertical lines; widens strip so stacked
 * lines still fit within lane height.
 *
 * **Mutation contract:** this function MUTATES `coordMap.poolCoords[...]`
 * entries and their nested `x`, `w`, and `laneHeaderWidth` fields in place.
 * It also stashes `_renderedLines` on the input `process` lane objects.
 * The same coordMap reference is returned for chaining with other passes.
 * Callers who need the original pre-refinement state must deep-clone before
 * invoking this function.
 *
 * @param {Object} coordMap   — { poolCoords, laneCoords, coords, edgeCoords }; MUTATED
 * @param {Object} process    — Logic-Core process (pools with lanes[]); lane objects gain _renderedLines
 * @param {Object} opts       — { minWidth = 30, maxWidth = 120 }
 * @returns {Object}          — same coordMap (mutated, for chaining)
 */
export function computeDynamicLaneHeaders(coordMap, process, opts = {}) {
  const minWidth = opts.minWidth ?? 30;
  const maxWidth = opts.maxWidth ?? 120;
  const lineHeight = FONT_SIZE + LINE_GAP;

  const pools = process.pools ?? [process];

  for (const pool of pools) {
    const pc = coordMap.poolCoords[pool.id] ?? coordMap.poolCoords['_singlePool'];
    if (!pc) continue;
    const lanes = pool.lanes ?? [];
    if (lanes.length === 0) continue;

    let maxStripWidth = minWidth;
    for (const lane of lanes) {
      const lc = coordMap.laneCoords[lane.id];
      if (!lc) continue;
      // Floor=1px is safe: wrapTextByPx enforces its own min-char floor, so
      // even a degenerate short lane won't cause infinite loops here.
      const available = Math.max(1, lc.h - 2 * STRIP_PADDING);
      const lines = wrapTextByPx(lane.name ?? '', available, FONT_SIZE);
      lane._renderedLines = lines; // stashed for renderer (may be used later)
      const needed = lines.length * lineHeight + STRIP_PADDING * 2;
      if (needed > maxStripWidth) maxStripWidth = needed;
    }

    const clamped = Math.max(minWidth, Math.min(maxWidth, maxStripWidth));
    const currentWidth = pc.laneHeaderWidth ?? LANE_HEADER_W;
    const delta = clamped - currentWidth;

    if (delta !== 0) {
      pc.laneHeaderWidth = clamped;
      pc.x -= delta;
      pc.w += delta;
    }
  }

  return coordMap;
}

const TEXT_BBOX_PADDING = 2;

/**
 * Rectangular bbox for a short edge-label rendered centered at (x,y).
 * Width is derived from estimateTextWidth; height is fontSize plus small padding.
 * Returns `{ x, y, w, h }` where (x, y) is the top-left corner.
 */
export function estimateTextBBox(text, x, y, fontSize = 11) {
  const w = estimateTextWidth(text, fontSize) + 2 * TEXT_BBOX_PADDING;
  const h = fontSize + 2 * TEXT_BBOX_PADDING;
  return { x: x - w / 2, y: y - h / 2, w, h };
}

/**
 * Axis-aligned bbox overlap test.
 * Adjacent (touching-only) bboxes return false.
 * Fully-contained bboxes return true.
 */
export function bboxOverlaps(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x ||
           a.y + a.h <= b.y || b.y + b.h <= a.y);
}

/**
 * Nudge edge labels that overlap with nodes or other labels.
 * Tries distances [15, 25, maxShift] × directions [up, down, left, right].
 * If no collision-free slot is found within maxShift, the label stays at
 * its original position (graceful degradation — we never throw).
 *
 * **Mutation contract:** mutates `coordMap.edgeLabels[...]` in place and
 * returns the same coordMap reference for chaining.
 *
 * @param {Object} coordMap   — { coords, edgeLabels, ... }; MUTATED
 * @param {Object} opts       — { maxShift = 25 }
 * @returns {Object}          — same coordMap (mutated)
 */
export function repairEdgeLabels(coordMap, opts = {}) {
  const maxShift = opts.maxShift ?? 25;
  const labels = coordMap.edgeLabels ?? {};
  const labelIds = Object.keys(labels);
  if (labelIds.length === 0) return coordMap;

  // Static obstacle bboxes (just nodes for now — lane/pool headers could be added in a later pass)
  const nodeBboxes = Object.values(coordMap.coords ?? {}).map(c => ({
    x: c.x, y: c.y, w: c.w, h: c.h
  }));

  const labelBboxOf = (id) => {
    const L = labels[id];
    return estimateTextBBox(L.text ?? '', L.x, L.y, 11);
  };

  const distances = [15, 25, maxShift].filter((d, i, arr) => arr.indexOf(d) === i && d > 0);
  const directions = [
    { dx:  0, dy: -1 },  // up
    { dx:  0, dy:  1 },  // down
    { dx: -1, dy:  0 },  // left
    { dx:  1, dy:  0 },  // right
  ];

  for (const id of labelIds) {
    const origBB = labelBboxOf(id);
    const otherBboxes = labelIds.filter(o => o !== id).map(labelBboxOf);
    const obstacles = [...nodeBboxes, ...otherBboxes];

    const collides = (bb) => obstacles.some(o => bboxOverlaps(bb, o));
    if (!collides(origBB)) continue;

    let fixed = false;
    outer: for (const d of distances) {
      for (const dir of directions) {
        const tryBB = {
          ...origBB,
          x: origBB.x + dir.dx * d,
          y: origBB.y + dir.dy * d
        };
        if (!collides(tryBB)) {
          labels[id].x += dir.dx * d;
          labels[id].y += dir.dy * d;
          fixed = true;
          break outer;
        }
      }
    }
    // If !fixed: silently leave at original position (graceful degradation)
  }
  return coordMap;
}

const LANE_COMPACT_PADDING = 20;

/**
 * Reduce each non-empty lane's height to `content_bbox + 2 * LANE_COMPACT_PADDING`,
 * with a `minLaneHeight` floor for empty lanes. Cascade-shifts subsequent lanes,
 * the nodes they contain, and edge waypoints up by the cumulative delta.
 *
 * Effect in practice: approximately uniform ~45px savings per non-empty lane on
 * typical layouts. The pre-refinement padding from `coordinates.js` sums to ~85px
 * (LANE_PADDING + EXTERNAL_LABEL_H + LANE_PADDING) and the compact padding here
 * sums to 40px — the `content_h` terms cancel out, leaving a near-constant delta
 * independent of lane density. Lanes whose ELK output already fits within
 * `minLaneHeight + 2 * padding` are not shrunk.
 *
 * Idempotent: running twice produces the same result as running once.
 */
/**
 * Lane a node belongs to. A boundary event has no lane of its own — it lives on
 * the border of its host and must be compacted together with it.
 */
function laneIdOf(node, allNodes) {
  if (node.lane) return node.lane;
  if (node.attachedTo) return allNodes.find(n => n.id === node.attachedTo)?.lane;
  return undefined;
}

export function compactLanes(coordMap, process, opts = {}) {
  const minH = opts.minLaneHeight ?? 80;
  const pad  = opts.padding ?? LANE_COMPACT_PADDING;

  const pools = process.pools ?? [process];
  const poolById = new Map(pools.map(p => [p.id, p]));
  // A single-pool model has no ownership ambiguity — every edgeCoords entry
  // is that one pool's, including ones the synthetic coordMaps in
  // visual-refinement.test.js never list under proc.edges. Only multi-pool
  // models need explicit per-edge ownership.
  const singlePool = pools.length === 1;

  // Which pool owns an edge (and therefore its label): the shift below is
  // scoped to a pool's own edges, never the whole collaboration's — that
  // global scope was the bug. Sequence flows are claimed via proc.edges
  // (including subprocess-nested ones); an association is claimed by
  // whichever pool contains the node it anchors to, since Logic-Core
  // associations live in one shared top-level array rather than per-pool.
  const edgeOwner = new Map();
  if (!singlePool) {
    const nodePool = new Map();
    for (const pool of pools) {
      for (const n of flattenProcessNodes(pool.nodes)) nodePool.set(n.id, pool.id);
    }
    for (const pool of pools) {
      for (const e of flattenProcessEdges(pool)) edgeOwner.set(e.id, pool.id);
    }
    for (const assoc of (process.associations || [])) {
      const ownerId = nodePool.get(assoc.source) ?? nodePool.get(assoc.target);
      if (ownerId) edgeOwner.set(assoc.id, ownerId);
    }
  }
  const edgesOf = (poolId) => singlePool
    ? Object.keys(coordMap.edgeCoords ?? {})
    : [...edgeOwner.entries()].filter(([, owner]) => owner === poolId).map(([id]) => id);

  // Rigidly shift a participant positioned entirely below the point that just
  // moved: its box, its lanes, every one of its nodes (including subprocess
  // children), and every one of its own edges' waypoints and label — all by
  // the same delta, nothing re-derived. Mirrors coordinates.js's
  // shiftParticipant (§5.0b2): the participant's internal layout doesn't
  // change, only its position does.
  function shiftParticipantsBelow(currentPoolId, thresholdY, delta) {
    for (const [id, opc] of Object.entries(coordMap.poolCoords)) {
      if (id === currentPoolId || id === '_singlePool') continue;
      if (opc.y < thresholdY) continue;
      opc.y -= delta;
      const otherPool = poolById.get(id);
      if (!otherPool) continue; // collapsed / black-box participant: box only
      for (const lane of (otherPool.lanes || [])) {
        if (coordMap.laneCoords[lane.id]) coordMap.laneCoords[lane.id].y -= delta;
      }
      for (const n of flattenProcessNodes(otherPool.nodes)) {
        if (coordMap.coords[n.id]) coordMap.coords[n.id].y -= delta;
      }
      for (const eid of edgesOf(id)) {
        for (const p of (coordMap.edgeCoords[eid] || [])) p.y -= delta;
        const label = coordMap.edgeLabels?.[eid];
        if (label) label.y -= delta;
      }
    }
  }

  for (const pool of pools) {
    const pc = coordMap.poolCoords[pool.id] ?? coordMap.poolCoords['_singlePool'];
    if (!pc) continue;
    const lanes = (pool.lanes ?? []).map(l => l.id).filter(id => coordMap.laneCoords[id]);
    lanes.sort((a, b) => coordMap.laneCoords[a].y - coordMap.laneCoords[b].y);

    // This pool's own top-level nodes only — a boundary event's host is
    // always in the same pool as the event itself, so scoping laneIdOf's
    // search to poolNodes (rather than every pool's nodes, as before) also
    // removes the cross-pool lane-id-collision exposure that had.
    const poolNodes = pool.nodes ?? [];
    const poolEdgeIds = edgesOf(pool.id);

    for (const laneId of lanes) {
      const lc = coordMap.laneCoords[laneId];

      const laneNodes = poolNodes.filter(n => laneIdOf(n, poolNodes) === laneId)
                                .map(n => coordMap.coords[n.id])
                                .filter(Boolean);

      // The band shrinks around its content, so its TOP has to follow the
      // content too. Keeping the old y while cutting the height lets the
      // lowest nodes fall out of the band (and out of the pool) whenever the
      // content did not start flush at the old top edge.
      let newH, newY;
      if (laneNodes.length === 0) {
        newH = minH;
        newY = lc.y;
      } else {
        const topY    = Math.min(...laneNodes.map(c => c.y));
        const botY    = Math.max(...laneNodes.map(c => c.y + c.h));
        newH = Math.max(minH, (botY - topY) + 2 * pad);
        // When the floor applies, the content is centred in the band instead.
        newY = topY - (newH - (botY - topY)) / 2;
      }

      const oldY = lc.y;
      const oldEndY = lc.y + lc.h;             // before shrink
      const delta = oldEndY - (newY + newH);   // how far the BOTTOM edge moves up
      if (delta > 0) {
        lc.y = newY;
        lc.h = newH;
        const newEndY = lc.y + lc.h;

        // Shift nodes in subsequent lanes of THIS pool, carrying subprocess
        // children along — previously only the top-level node moved, leaving
        // an expanded subprocess's children behind their own parent.
        for (const other of lanes) {
          if (other === laneId) continue;
          if (coordMap.laneCoords[other].y <= oldY) continue; // lanes above — already processed
          coordMap.laneCoords[other].y -= delta;
          const nodesInOther = poolNodes.filter(n => laneIdOf(n, poolNodes) === other);
          for (const n of nodesInOther) {
            for (const inner of flattenProcessNodes([n])) {
              if (coordMap.coords[inner.id]) coordMap.coords[inner.id].y -= delta;
            }
          }
        }

        // Shift this pool's own edge waypoints and labels only — scoped,
        // where the bug shifted every edge in the whole collaboration
        // regardless of which pool it actually belonged to.
        for (const eid of poolEdgeIds) {
          const pts = coordMap.edgeCoords[eid];
          if (pts) {
            for (const p of pts) {
              if (p.y >= oldEndY) {
                p.y -= delta;
              } else if (p.y > newEndY && p.y < oldEndY) {
                // Boundary edge case: clamp to newEndY - 1 (keeps waypoint inside shrunk lane)
                p.y = newEndY - 1;
              }
            }
          }
          const label = coordMap.edgeLabels?.[eid];
          if (label) {
            if (label.y >= oldEndY) label.y -= delta;
            else if (label.y > newEndY && label.y < oldEndY) label.y = newEndY - 1;
          }
        }

        // Every participant positioned below this pool needs to move by the
        // same amount, or its content stays glued to a position this pool no
        // longer occupies — see shiftParticipantsBelow's doc comment.
        shiftParticipantsBelow(pool.id, oldEndY, delta);
      }
    }

    // Recompute pool bounds
    const lanesList = lanes.map(id => coordMap.laneCoords[id]);
    if (lanesList.length > 0) {
      pc.y = Math.min(...lanesList.map(l => l.y));
      pc.h = Math.max(...lanesList.map(l => l.y + l.h)) - pc.y;
    }
  }

  return coordMap;
}
