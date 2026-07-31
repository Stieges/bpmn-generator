/**
 * DMN Coordinates — laid-out ELK graph -> diagram list.
 *
 * DMNDI's DMNDiagram is maxOccurs="unbounded" (DMN 1.3 §6.2.4 builds partial
 * views on a DRD), so the return shape is always a LIST even though today it
 * holds exactly one entry: the whole Decision-Core laid out as a single
 * diagram. There is no `views` input yet — when one exists, this function
 * grows a loop, not a rewrite.
 *
 * Requirement edges are straight two-point segments (DMN 1.3 §6.2.2 and every
 * DRD tool draw them straight, never orthogonal — dmn-external-ground-truth.md
 * §B.9), clipped at both ends against the source and target shape's outline
 * via `clipStraight` from `../shared/geometry.js`.
 *
 * Rectangle clipping is exact (`clipToRect`, used for `decision` nodes and,
 * as a deliberate approximation, for the other three node types too):
 * `inputData` (dmn-js: rounded rect, rx=22 on a 125x45 box), `knowledgeSource`
 * (wavy bottom) and `businessKnowledgeModel` (two clipped corners) are all
 * approximated by their bounding rectangle. This matches what dmn-js's own
 * connection cropping effectively does — it crops against a generic rendered
 * SVG path (the `path-intersection` package), not a per-shape closed-form
 * formula, and pulling that dependency in for one clip refinement is not
 * worth it. See the design spec / plan for the two exact formulas (stadium,
 * clipped-corner hexagon) this deliberately does not use.
 *
 * buildDmnDiagrams also anchors the diagram canvas at (0,0): every shape is
 * shifted by a constant (dx, dy) so the bounding box of all shapes, expanded
 * by DRD_SPACING.margin on every side, starts at the origin. `size` (a
 * dc:Dimension: width/height only, no x/y) only means something if the
 * shapes are known to live inside [0,size.w] x [0,size.h] — without this
 * shift the canvas origin would be wherever ELK happened to start, and
 * di-check.js's DD02 would fire on every well-formed diagram.
 */

import { clipStraight } from '../shared/geometry.js';
import { DRD_SPACING } from './constants.js';

/**
 * The one place a requirement's identity is derived. `id` is optional on a Requirement
 * (references/decision-core-schema.json), so a deterministic fallback is needed — and it must be
 * derived in exactly ONE place, because two consumers depend on it agreeing:
 *
 *   - this module keys `edgeCoords` with it,
 *   - `dmn-xml.js` keys its requirement element map with it AND uses it as the element's `id`
 *     when the requirement carries none.
 *
 * A divergence between the two does not throw. The DMNDI writer's lookup returns undefined, the
 * edge is skipped as "no waypoints", and the diagram silently loses a connection. Mirrors
 * `messageFlowKey` in `bpmn/coordinates.js` (`mf.id || 'mf_' + ...`), prefix and all.
 *
 * @param {{id?: string, source: string, target: string}} req
 * @returns {string}
 */
export function requirementKey(req) {
  return req.id || `req_${req.source}_${req.target}`;
}

/**
 * @param {object} dc - Decision-Core JSON (only `name` and `requirements` are read)
 * @param {object} laidOutGraph - result of runDmnElkLayout: { children: [{ id, x, y, width, height }, ...] }
 * @returns {[{ id: string, name: string, size: {w:number,h:number}, coordMap: { coords: object, edgeCoords: object } }]}
 */
export function buildDmnDiagrams(dc, laidOutGraph) {
  const margin = DRD_SPACING.margin;

  const rawCoords = {};
  for (const child of (laidOutGraph?.children || [])) {
    rawCoords[child.id] = { x: child.x || 0, y: child.y || 0, w: child.width, h: child.height };
  }

  const ids = Object.keys(rawCoords);
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  if (ids.length > 0) {
    minX = Math.min(...ids.map(id => rawCoords[id].x));
    minY = Math.min(...ids.map(id => rawCoords[id].y));
    maxX = Math.max(...ids.map(id => rawCoords[id].x + rawCoords[id].w));
    maxY = Math.max(...ids.map(id => rawCoords[id].y + rawCoords[id].h));
  }

  const dx = margin - minX;
  const dy = margin - minY;

  const coords = {};
  for (const id of ids) {
    const c = rawCoords[id];
    coords[id] = { x: c.x + dx, y: c.y + dy, w: c.w, h: c.h };
  }

  const edgeCoords = {};
  for (const req of (dc.requirements || [])) {
    const a = coords[req.source];
    const b = coords[req.target];
    if (!a || !b) continue; // dangling reference — D01 reports this upstream; stay defensive here
    edgeCoords[requirementKey(req)] = clipStraight(a, b);
  }

  const size = { w: (maxX - minX) + 2 * margin, h: (maxY - minY) + 2 * margin };

  return [{
    id: 'DMNDiagram_1',
    name: dc.name || '',
    size,
    coordMap: { coords, edgeCoords },
  }];
}
