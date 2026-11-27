/**
 * H18: a label in the way, or in the wrong place — read from the geometry the DI and the SVG write.
 *
 * No DI diagnostic (di-check.js, DI01–DI11) looks at a label, so three things passed --strict
 * unseen. One hint per finding, three cases:
 *
 *   (a) crossing — a sequence or message flow runs through the label box of an event, a gateway, a
 *       data object or data store, or of another flow (its own label is not counted: a flow label
 *       sits beside its own route by design). The node a flow starts or ends at is counted: its
 *       label is drawn below the node and a flow through it is as hard to read as any other.
 *   (b) misplaced — an edge label is nearer to a shape that is neither the source nor the target of
 *       its flow than to its own route, by a clear margin, so a reader takes it for that shape's.
 *   (c) crowded — two label boxes overlap or are closer than LABEL_MIN_GAP_PX.
 *
 * The boxes are exactly the `bpmndi:BPMNLabel` bounds bpmn-xml.js writes (coordMap.nodeLabels and
 * coordMap.edgeLabels via edgeLabelBox, rounded by `rn`), the routes the waypoints it writes, after
 * every layout and refinement pass; svg.js draws the same boxes. Nothing here moves a label: the
 * check is pure, `findLabelIssues` takes plain boxes and routes and is tested on synthetic ones.
 * runPipeline appends the hints after H17, any format, generate path only; they never fail --strict.
 */
import { edgeLabelBox } from './coordinates.js';
import { isEvent, isGateway } from './types.js';
import { rn } from '../shared/utils.js';

/**
 * (a) A route has to reach this far into a label box, on both axes, to cross it. A route that only
 * grazes the outline (touching, or one pixel in) is no crossing: the text is centred in the box and
 * its first and last pixel rows are blank.
 */
export const LABEL_CROSS_DEPTH_PX = 2;

/**
 * (b) A label this close to its own route sits beside it, whatever else is near
 * (`layout.edgeLabelGap` 4 px plus the bench's LABEL_DISTANCE_TOLERANCE_PX 2 px, the definition of
 * `edgeLabelHits.farFromEdge`).
 */
export const LABEL_OWN_ROUTE_MAX_PX = 6;

/**
 * (b) The foreign shape has to be nearer than the own route by more than this. A label between its
 * flow and a neighbouring shape is normal; only one that has clearly moved over to the shape is
 * reported.
 */
export const LABEL_NEARER_MARGIN_PX = 10;

/** (c) Two label boxes closer than this (0 = touching, negative = overlapping) are crowded. */
export const LABEL_MIN_GAP_PX = 2;

// ─────────────────────────────────────────────────────────────────────
// Geometry
// ─────────────────────────────────────────────────────────────────────

/** Euclidean gap between two boxes; 0 when they touch, negative (the smaller overlap) when they overlap. */
export function boxGap(a, b) {
  const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w));
  const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h));
  if (dx < 0 && dy < 0) return Math.max(dx, dy);
  return Math.hypot(Math.max(0, dx), Math.max(0, dy));
}

/** Distance from a box to a segment; 0 when they touch or the segment enters the box. */
export function boxSegmentDistance(b, p, q) {
  if (segmentEntersBox(p, q, b, 0)) return 0;
  // Outside: the minimum is reached at a segment end or at a box corner.
  const corners = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]];
  let d = Math.min(pointBoxDistance(p, b), pointBoxDistance(q, b));
  for (const [x, y] of corners) d = Math.min(d, pointSegmentDistance({ x, y }, p, q));
  return d;
}

function pointBoxDistance(p, b) {
  const dx = Math.max(0, b.x - p.x, p.x - (b.x + b.w));
  const dy = Math.max(0, b.y - p.y, p.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}

function pointSegmentDistance(c, p, q) {
  const vx = q.x - p.x, vy = q.y - p.y;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((c.x - p.x) * vx + (c.y - p.y) * vy) / len2));
  return Math.hypot(p.x + t * vx - c.x, p.y + t * vy - c.y);
}

/**
 * Does the segment p–q pass through the box shrunk by `depth` on every side? Strictly inside: a
 * segment along the shrunk outline does not count. Liang–Barsky clipping, so diagonal segments too.
 */
export function segmentEntersBox(p, q, box, depth = LABEL_CROSS_DEPTH_PX) {
  const x0 = box.x + depth, x1 = box.x + box.w - depth;
  const y0 = box.y + depth, y1 = box.y + box.h - depth;
  if (!(x0 < x1 && y0 < y1)) return false;
  const dx = q.x - p.x, dy = q.y - p.y;
  let t0 = 0, t1 = 1;
  const clip = (den, num) => {
    // p + t·d on the inner side of one boundary: den·t ≤ num
    if (den === 0) return num > 0;
    const t = num / den;
    if (den > 0) { if (t < t1) t1 = t; } else if (t > t0) t0 = t;
    return t0 <= t1;
  };
  if (!clip(-dx, p.x - x0) || !clip(dx, x1 - p.x) || !clip(-dy, p.y - y0) || !clip(dy, y1 - p.y)) return false;
  if (t1 - t0 > 1e-9) return true;
  // A single point (a degenerate segment, or a corner touch): strictly inside only.
  const x = p.x + t0 * dx, y = p.y + t0 * dy;
  return x > x0 && x < x1 && y > y0 && y < y1;
}

function routeDistance(box, route) {
  let d = Infinity;
  for (let k = 0; k + 1 < route.length; k++) d = Math.min(d, boxSegmentDistance(box, route[k], route[k + 1]));
  return d;
}

// ─────────────────────────────────────────────────────────────────────
// The check on plain geometry
// ─────────────────────────────────────────────────────────────────────

/**
 * Findings on plain geometry, in a fixed order: every (a) by flow then label, every (b) by label,
 * every (c) by pair (each pair once, in label order).
 *
 * @param {object} g
 * @param {Array<{id, owner, ownerKind, box}>} g.labels — `owner` the element id the label belongs
 *   to (a node or a flow), `ownerKind` the words naming it (`gateway`, `sequence flow`, …).
 * @param {Array<{id, kind, source, target, route}>} g.flows — `kind` `sequence flow` or `message flow`.
 * @param {Array<{id, box}>} g.shapes — every shape a label may be taken for (no container that may
 *   wrap a label: no expanded subprocess, no group, no pool, no lane).
 * @param {object} [thresholds] — `crossDepth`, `ownRouteMax`, `nearerMargin`, `minGap`; the
 *   LABEL_* constants by default (a tuning aid; runPipeline never passes them).
 * @returns {Array<{case: 'cross'|'nearer'|'crowded', …}>}
 */
export function findLabelIssues({ labels = [], flows = [], shapes = [] }, thresholds = {}) {
  const {
    crossDepth = LABEL_CROSS_DEPTH_PX, ownRouteMax = LABEL_OWN_ROUTE_MAX_PX,
    nearerMargin = LABEL_NEARER_MARGIN_PX, minGap = LABEL_MIN_GAP_PX,
  } = thresholds;
  const out = [];
  // (a) a route through a label that is not its own
  for (const f of flows) {
    if (!f.route || f.route.length < 2) continue;
    for (const L of labels) {
      if (L.owner === f.id) continue;
      let hit = false;
      for (let k = 0; k + 1 < f.route.length && !hit; k++) hit = segmentEntersBox(f.route[k], f.route[k + 1], L.box, crossDepth);
      if (hit) out.push({ case: 'cross', flow: f, label: L });
    }
  }
  // (b) an edge label nearer to a foreign shape than to its own route
  const flowById = new Map(flows.map(f => [f.id, f]));
  for (const L of labels) {
    const f = flowById.get(L.owner);
    if (!f || !f.route || f.route.length < 2) continue;
    const own = routeDistance(L.box, f.route);
    if (own <= ownRouteMax) continue;
    let best = null;
    for (const s of shapes) {
      if (s.id === f.source || s.id === f.target) continue;
      const d = Math.max(0, boxGap(L.box, s.box));
      if (d + nearerMargin < own && (!best || d < best.distance)) best = { shape: s, distance: d };
    }
    if (best) out.push({ case: 'nearer', label: L, flow: f, shape: best.shape, own, distance: best.distance });
  }
  // (c) two labels overlapping or too close
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const gap = boxGap(labels[i].box, labels[j].box);
      if (gap < minGap) out.push({ case: 'crowded', label: labels[i], other: labels[j], gap });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// The geometry the writers write
// ─────────────────────────────────────────────────────────────────────

const roundBox = (b) => ({ x: rn(b.x), y: rn(b.y), w: rn(b.w), h: rn(b.h) });
const roundRoute = (pts) => pts.map(p => ({ x: rn(p.x), y: rn(p.y) }));

function nodeKind(type) {
  if (isGateway(type)) return 'gateway';
  if (isEvent(type)) return 'event';
  if (type === 'dataObjectReference') return 'data object';
  if (type === 'dataStoreReference') return 'data store';
  return 'element';
}

/** A sequence flow's written waypoints: its route, or the centre-to-centre line bpmn-xml.js falls back to. */
function sequenceRoute(pts, coords, source, target) {
  if (pts && pts.length >= 2) return roundRoute(pts);
  const s = coords[source], t = coords[target];
  if (s && t) return roundRoute([{ x: s.x + s.w / 2, y: s.y + s.h / 2 }, { x: t.x + t.w / 2, y: t.y + t.h / 2 }]);
  return [];
}

/**
 * Labels, flows and shapes as bpmn-xml.js writes them (buildDI / buildNodeShapeDI): the same walk
 * (every process, expanded containers recursed into), the same boxes and the same rounding.
 */
export function labelGeometry(lc, coordMap) {
  const coords = coordMap.coords || {};
  const edgeCoords = coordMap.edgeCoords || {};
  const edgeLabels = coordMap.edgeLabels || {};
  const nodeLabels = coordMap.nodeLabels || {};
  const labels = [], flows = [], shapes = [];
  const edgeLabelOf = [];

  const walk = (nodes, edgesOut) => {
    for (const node of (nodes || [])) {
      const c = coords[node.id];
      if (!c) continue;
      const container = (node.isExpanded && node.nodes) || node.type === 'group';
      if (!container) shapes.push({ id: node.id, box: roundBox(c) });
      const L = nodeLabels[node.id];
      if (L) labels.push({ id: node.id, owner: node.id, ownerKind: nodeKind(node.type), box: roundBox(L) });
      if (node.isExpanded && node.nodes) {
        walk(node.nodes, edgesOut);
        // Nested edges are written with their container's shapes (buildNodeShapeDI), before the top-level ones.
        for (const e of (node.edges || [])) edgesOut.push(e);
      }
    }
  };
  const seqEdges = [];
  for (const proc of (lc.pools || [lc])) {
    const nested = [];
    walk(proc.nodes, nested);
    seqEdges.push(...nested);
  }
  const topEdges = (lc.pools || [lc]).flatMap(p => p.edges || []);
  for (const e of [...seqEdges, ...topEdges]) {
    const route = sequenceRoute(edgeCoords[e.id], coords, e.source, e.target);
    if (route.length < 2) continue;
    flows.push({ id: e.id, kind: 'sequence flow', source: e.source, target: e.target, route });
    if (e.label && edgeLabels[e.id]) edgeLabelOf.push({ id: e.id, owner: e.id, ownerKind: 'sequence flow', box: roundBox(edgeLabelBox(edgeLabels[e.id])) });
  }
  for (const mf of (lc.messageFlows || [])) {
    const key = mf.id || `mf_${mf.source}_${mf.target}`;
    const pts = edgeCoords[key] || [];
    if (pts.length < 2) continue;
    flows.push({ id: key, kind: 'message flow', source: mf.source, target: mf.target, route: roundRoute(pts) });
    if (mf.name && edgeLabels[key]) edgeLabelOf.push({ id: key, owner: key, ownerKind: 'message flow', box: roundBox(edgeLabelBox(edgeLabels[key])) });
  }
  labels.push(...edgeLabelOf);
  return { labels, flows, shapes };
}

// ─────────────────────────────────────────────────────────────────────
// Hints
// ─────────────────────────────────────────────────────────────────────

const labelOf = (L) => `the label of the ${L.ownerKind} "${L.owner}"`;
const cap = (s) => s[0].toUpperCase() + s.slice(1);

/** The H18 hint of one finding of `findLabelIssues`. */
export function labelHint(issue) {
  if (issue.case === 'cross') {
    const { flow: f, label: L } = issue;
    return {
      code: 'H18',
      message: `The ${f.kind} "${f.id}" crosses ${labelOf(L)}: the line runs through the text. Move the label or the flow in a modeler, or shorten the name.`,
      elements: [f.id, L.owner],
    };
  }
  if (issue.case === 'nearer') {
    const { label: L, shape: s, own, distance } = issue;
    return {
      code: 'H18',
      message: `${cap(labelOf(L))} sits nearer to "${s.id}" (${rn(distance)} px) than to its own flow (${rn(own)} px), so it reads as belonging to "${s.id}". Move the label next to its flow in a modeler.`,
      elements: [L.owner, s.id],
    };
  }
  const { label: L, other: O, gap } = issue;
  const how = gap < 0 ? 'overlaps' : `is too close to (${rn(gap)} px from)`;
  return {
    code: 'H18',
    message: `${cap(labelOf(L))} ${how} ${labelOf(O)}. Move one of the labels in a modeler, or shorten a name.`,
    elements: [L.owner, O.owner],
  };
}

/** The H18 hints of one generated diagram. */
export function labelHints(lc, coordMap) {
  return findLabelIssues(labelGeometry(lc, coordMap)).map(labelHint);
}
