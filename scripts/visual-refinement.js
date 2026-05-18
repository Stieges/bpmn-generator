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

import { wrapTextByPx, LANE_HEADER_W } from './utils.js';

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
export function compactLanes(coordMap, process, opts = {}) {
  const minH = opts.minLaneHeight ?? 80;
  const pad  = opts.padding ?? LANE_COMPACT_PADDING;

  const pools = process.pools ?? [process];
  const allNodes = pools.flatMap(p => p.nodes ?? []);

  for (const pool of pools) {
    const pc = coordMap.poolCoords[pool.id] ?? coordMap.poolCoords['_singlePool'];
    if (!pc) continue;
    const lanes = (pool.lanes ?? []).map(l => l.id).filter(id => coordMap.laneCoords[id]);
    lanes.sort((a, b) => coordMap.laneCoords[a].y - coordMap.laneCoords[b].y);

    for (const laneId of lanes) {
      const lc = coordMap.laneCoords[laneId];

      const laneNodes = allNodes.filter(n => n.lane === laneId)
                                .map(n => coordMap.coords[n.id])
                                .filter(Boolean);

      let newH;
      if (laneNodes.length === 0) {
        newH = minH;
      } else {
        const topY    = Math.min(...laneNodes.map(c => c.y));
        const botY    = Math.max(...laneNodes.map(c => c.y + c.h));
        newH = Math.max(minH, (botY - topY) + 2 * pad);
      }

      const delta = lc.h - newH;
      if (delta > 0) {
        const oldEndY = lc.y + lc.h; // before shrink
        lc.h = newH;
        const newEndY = lc.y + lc.h;

        // Shift nodes in subsequent lanes
        for (const other of lanes) {
          if (other === laneId) continue;
          if (coordMap.laneCoords[other].y <= lc.y) continue; // lanes above — already processed
          const otherLane = coordMap.laneCoords[other];
          otherLane.y -= delta;
          const nodesInOther = allNodes.filter(n => n.lane === other);
          for (const n of nodesInOther) {
            if (coordMap.coords[n.id]) coordMap.coords[n.id].y -= delta;
          }
        }

        // Shift edge waypoints
        for (const pts of Object.values(coordMap.edgeCoords)) {
          for (const p of pts) {
            if (p.y >= oldEndY) {
              p.y -= delta;
            } else if (p.y > newEndY && p.y < oldEndY) {
              // Boundary edge case: clamp to newEndY - 1 (keeps waypoint inside shrunk lane)
              p.y = newEndY - 1;
            }
          }
        }
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
