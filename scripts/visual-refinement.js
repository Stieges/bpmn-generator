/**
 * BPMN Visual Refinement — Post-Layout Coordinate Transforms
 *
 * Pure functions that run between buildCoordinateMap and serialization.
 * All transforms are opt-in via config.visualRefinement.enabled.
 *
 * - estimateTextWidth:          char-count-based text width heuristic
 * - computeDynamicLaneHeaders:  per-pool dynamic lane header strip width
 * - repairEdgeLabels:           bbox-collision-based label nudging
 * - compactLanes:               shrink lanes to content, shift nodes + waypoints
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
