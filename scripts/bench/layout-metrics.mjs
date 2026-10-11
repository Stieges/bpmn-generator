#!/usr/bin/env node
/**
 * layout-metrics.mjs
 *
 * Layout-quality measurement harness for the "does the Petrov/Flowable
 * arrangement algorithm help us" analysis.
 *
 * Not wired into `npm test` — same idiom as the other scripts/bench/*.mjs
 * comparison tools. Run: `node bench/layout-metrics.mjs` from `scripts/`.
 *
 * Measures, per fixture. Each entry also states what the metric does NOT
 * capture — the first version of this harness drew a wrong conclusion from a
 * structurally blind alignment metric, so the blind spots are documented as
 * carefully as the definitions.
 *
 *   - crossings         pairwise segment intersections between non-adjacent
 *                        sequence-flow edges (edges sharing a source/target
 *                        node are considered adjacent and excluded).
 *                        Does NOT cover message flows or associations.
 *   - bends             direction changes per edge polyline (sum + count of
 *                        edges with <=1 bend). A bend is not automatically a
 *                        defect: a fold-back in a wrapped layout needs one.
 *   - diagonals         segments with both dx>1 and dy>1 (should be 0 —
 *                        the pipeline promises strictly orthogonal routing)
 *   - area / aspect     bounding box over node boxes, px^2 per node, and w/h.
 *                        Area is NOT comparable between raw ELK and the final
 *                        pipeline: raw ELK has not placed lane bands yet, so
 *                        the difference measures the existence of swimlanes,
 *                        not bloat. For a wrapping layout, aspect ratio is the
 *                        meaningful figure — trading width for height grows
 *                        total area on purpose.
 *   - chainAlignment    of all STRUCTURALLY ALIGNABLE chain links, how many
 *                        share center-y (+-1px)? See `isAlignableLink` for the
 *                        exclusions and why each one is not a defect. Counting
 *                        the excluded links as misalignment is exactly the
 *                        error the first version of this harness made.
 *   - edgeThroughNode   segments whose bounding box overlaps a node box that
 *                        is neither the edge's source nor its target.
 *                        Does NOT test edge-vs-edge or lane/pool-band overlap.
 *   - edge labels       (measureLayout only) the label box both renderers draw
 *                        (coordMap.edgeLabels via edgeLabelBox) reaching into
 *                        its own route, overlapping another label box, or
 *                        overlapping a node box. A container the label lies
 *                        wholly inside (an expanded subprocess, a group) is
 *                        where the label belongs, not an overlap. Does NOT
 *                        test a label against a foreign flow's line. Also:
 *                        a label box across an inner lane separator, and a
 *                        label farther from its own route than
 *                        layout.edgeLabelGap + LABEL_DISTANCE_TOLERANCE_PX
 *                        (a label that no longer sits beside its flow).
 *   - overlapLen        (measureLayout only, flow-metrics.mjs) px two flows —
 *                        sequence or message — run on top of each other:
 *                        parallel legs closer than bendRuleLimits.collinearPx,
 *                        a pair at a shared node included (crowd skips those).
 *                        Does NOT see associations, nor a message flow's
 *                        MESSAGE_FLOW_FAN offset before it is routed.
 *
 * Also measures ELK's *raw* output (before coordinates.js post-processing) so
 * that crossings introduced by our own route rebuilding become visible: ELK
 * routes around obstacles, our synthetic 4-point replacements do not.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../bpmn/pipeline.js';
import { logicCoreToElk, runElkLayout } from '../bpmn/layout.js';
import { resolveLaneId } from '../bpmn/topology.js';
import { isMainModule } from '../shared/entry-point.js';
import { isEvent, isGateway } from '../bpmn/types.js';
import { CFG } from '../shared/utils.js';
import { flowMetrics, flowDirectionMetrics } from './flow-metrics.mjs';
import { edgeLabelBox, labelHitsRoute, boxWithin, flattenProcessNodes } from '../bpmn/coordinates.js';
import { innerLaneLines } from '../bpmn/visual-refinement.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const fixturesDir = join(repoRoot, 'tests', 'fixtures');
const outPath = join(repoRoot, 'tests', 'bench', 'layout-metrics-baseline.md');

// Every Logic-Core document at the top level of tests/fixtures/ — a new fixture is measured (and,
// through layout-metrics.test.js, fenced) the day it lands. A fixed list is how
// boundary-event-shapes' crossing stayed unseen until 2026-10-11.
export const FIXTURES = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort();

// ─────────────────────────────────────────────────────────────────────────
// Geometry primitives
// ─────────────────────────────────────────────────────────────────────────

function orientation(a, b, c) {
  const val = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(val) < 1e-9) return 0;
  return val > 0 ? 1 : 2;
}

function onSegment(a, b, c) {
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
  if (o1 === 0 && onSegment(p1, p2, p3)) return true;
  if (o2 === 0 && onSegment(p1, p2, p4)) return true;
  if (o3 === 0 && onSegment(p3, p4, p1)) return true;
  if (o4 === 0 && onSegment(p3, p4, p2)) return true;
  return false;
}

function segments(points) {
  const segs = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) continue; // zero-length
    segs.push([a, b]);
  }
  return segs;
}

function segmentRectOverlap(a, b, rect) {
  const segMinX = Math.min(a.x, b.x), segMaxX = Math.max(a.x, b.x);
  const segMinY = Math.min(a.y, b.y), segMaxY = Math.max(a.y, b.y);
  if (segMaxX < rect.x || segMinX > rect.x + rect.w) return false;
  if (segMaxY < rect.y || segMinY > rect.y + rect.h) return false;
  // Endpoint-inside test
  const inside = (p) => p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
  if (inside(a) || inside(b)) return true;
  // Edge-crossing test against the 4 rectangle sides
  const corners = [
    { x: rect.x, y: rect.y }, { x: rect.x + rect.w, y: rect.y },
    { x: rect.x + rect.w, y: rect.y + rect.h }, { x: rect.x, y: rect.y + rect.h },
  ];
  for (let i = 0; i < 4; i++) {
    if (segmentsIntersect(a, b, corners[i], corners[(i + 1) % 4])) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Readability measures added 2026-10-11 (#52, lane strips, message flows).
// Each states what it deliberately does NOT count, for this reason: a measure that counts a structurally
// impossible case manufactures work.
// ─────────────────────────────────────────────────────────────────────────

/** bpmn-js draws the sequence-flow arrowhead 5 px long (marker 'M 1 5 L 11 10 L 1 15 Z' at scale
 *  0.5): up to 5 px of a segment lying on the outline hides under it. */
export const ALONG_MIN_PX = CFG.layout?.alongOutlineMinPx ?? 5;
const COLLINEAR_TOL = 1;

function overlap1d(a0, a1, b0, b1) {
  return Math.max(0, Math.min(Math.max(a0, a1), b1) - Math.max(Math.min(a0, a1), b0));
}

/** How far a segment runs collinear (±1 px) with one side of `box`, and which side. For a circle or
 *  a diamond the "side" is a tangent of its bounds — the line still visibly misses the shape. */
export function alongSide([a, b], box) {
  let best = { side: null, length: 0 };
  const consider = (side, length) => { if (length > best.length) best = { side, length }; };
  if (Math.abs(a.x - b.x) <= COLLINEAR_TOL) {
    if (Math.abs(a.x - box.x) <= COLLINEAR_TOL) consider('left', overlap1d(a.y, b.y, box.y, box.y + box.h));
    if (Math.abs(a.x - (box.x + box.w)) <= COLLINEAR_TOL) consider('right', overlap1d(a.y, b.y, box.y, box.y + box.h));
  }
  if (Math.abs(a.y - b.y) <= COLLINEAR_TOL) {
    if (Math.abs(a.y - box.y) <= COLLINEAR_TOL) consider('top', overlap1d(a.x, b.x, box.x, box.x + box.w));
    if (Math.abs(a.y - (box.y + box.h)) <= COLLINEAR_TOL) consider('bottom', overlap1d(a.x, b.x, box.x, box.x + box.w));
  }
  return best;
}

/**
 * Sequence-flow ends whose end segment lies on its own endpoint's outline for more than
 * ALONG_MIN_PX (#52). Both ends: the first segment against the source, the last against the target.
 * Does NOT count a segment along a foreign shape (edgeThroughNode's job) or message flows.
 */
export function edgeEndsAlongBorder(coords, edgeCoords, edgeList) {
  const out = [];
  for (const e of edgeList) {
    const segs = segments(edgeCoords[e.id] || []);
    if (!segs.length) continue;
    const ends = [['source', segs[0], e.source], ['target', segs[segs.length - 1], e.target]];
    for (const [end, seg, node] of ends) {
      const box = coords[node];
      if (!box) continue;
      const { side, length } = alongSide(seg, box);
      if (length > ALONG_MIN_PX) out.push({ edge: e.id, end, node, side, length: Math.round(length * 10) / 10 });
    }
  }
  return out;
}

/**
 * Empty strips in a participant's lane stack: between consecutive bands, and between the stack and
 * the participant's top/bottom edge. bpmn.io draws each as an extra band with a double line.
 * Does NOT measure horizontal gaps (the header strip is the pool header's business).
 */
export function laneGaps(coordMap, lc) {
  const out = [];
  for (const proc of lc.pools || [lc]) {
    const bands = (proc.lanes || [])
      .map((l) => ({ id: l.id, ...(coordMap.laneCoords?.[l.id] || {}) }))
      .filter((b) => Number.isFinite(b.y))
      .sort((a, b) => a.y - b.y);
    if (!bands.length) continue;
    const participant = proc.id ?? '_singlePool';
    const pc = coordMap.poolCoords?.[proc.id] ?? coordMap.poolCoords?._singlePool;
    const push = (above, below, gap) => {
      if (gap > 0.5) out.push({ participant, above, below, gap: Math.round(gap * 10) / 10 });
    };
    if (pc) push(null, bands[0].id, bands[0].y - pc.y);
    for (let i = 1; i < bands.length; i++) {
      push(bands[i - 1].id, bands[i].id, bands[i].y - (bands[i - 1].y + bands[i - 1].h));
    }
    const last = bands[bands.length - 1];
    if (pc) push(last.id, null, pc.y + pc.h - (last.y + last.h));
  }
  return out;
}

const boxContains = (o, i) => !!i && o.x <= i.x && o.y <= i.y && o.x + o.w >= i.x + i.w && o.y + o.h >= i.y + i.h;
// Interior hit, 1 px inset: touching an outline is not running through a shape.
const segmentHitsInterior = ([a, z], b) =>
  Math.max(a.x, z.x) > b.x + 1 && Math.min(a.x, z.x) < b.x + b.w - 1 &&
  Math.max(a.y, z.y) > b.y + 1 && Math.min(a.y, z.y) < b.y + b.h - 1;

/**
 * (message flow, foreign shape) pairs: a segment through the interior of a node box that is neither
 * endpoint. Does NOT count a group (drawn to be overlapped) or a box containing an endpoint (the
 * expanded subprocess a flow starts or ends in — it cannot be avoided). `relation` says whose shape
 * it is: own source/target participant, or a participant the flow does not involve.
 */
export function messageFlowThroughNodes(coordMap, lc) {
  const typeOf = {};
  const participantOf = {};
  const walk = (nodes, pid) => {
    for (const n of nodes || []) { typeOf[n.id] = n.type; participantOf[n.id] = pid; walk(n.nodes, pid); }
  };
  for (const p of lc.pools || []) walk(p.nodes, p.id);
  walk(lc.nodes, undefined);
  const out = [];
  for (const mf of lc.messageFlows || []) {
    const pts = coordMap.edgeCoords?.[mf.id || `mf_${mf.source}_${mf.target}`];
    if (!pts || pts.length < 2) continue;
    const src = coordMap.coords[mf.source];
    const tgt = coordMap.coords[mf.target];
    const srcP = participantOf[mf.source] ?? mf.source;
    const tgtP = participantOf[mf.target] ?? mf.target;
    for (const [id, b] of Object.entries(coordMap.coords)) {
      if (id === mf.source || id === mf.target) continue;
      if (typeOf[id] === 'group') continue;
      if (boxContains(b, src) || boxContains(b, tgt)) continue;
      if (!segments(pts).some((s) => segmentHitsInterior(s, b))) continue;
      const p = participantOf[id];
      out.push({ flow: mf.id, node: id,
        relation: p === srcP ? 'source-participant' : p === tgtP ? 'target-participant' : 'uninvolved' });
    }
  }
  return out;
}

/**
 * (sequence flow, foreign node) pairs, interior hits only. Does NOT count a box containing an
 * endpoint: an edge inside an expanded subprocess lies inside its container by construction.
 */
export function seqFlowThroughNodes(coordMap, edgeList) {
  const out = [];
  for (const e of edgeList) {
    const pts = coordMap.edgeCoords?.[e.id];
    if (!pts || pts.length < 2) continue;
    const src = coordMap.coords[e.source];
    const tgt = coordMap.coords[e.target];
    for (const [id, b] of Object.entries(coordMap.coords)) {
      if (id === e.source || id === e.target) continue;
      if (boxContains(b, src) || boxContains(b, tgt)) continue;
      if (segments(pts).some((s) => segmentHitsInterior(s, b))) out.push({ edge: e.id, node: id });
    }
  }
  return out;
}

/**
 * Does an axis-parallel segment enter the INTERIOR of the drawn shape? Rectangles use their box
 * (1 px inset); events their circle, gateways their rhombus (1 px inset) — a segment through a
 * gateway's bounding-box corner is outside the gateway and must not count.
 */
export function segmentEntersShape([a, z], box, shape) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const nx = Math.max(Math.min(a.x, z.x), Math.min(Math.max(a.x, z.x), cx));
  const ny = Math.max(Math.min(a.y, z.y), Math.min(Math.max(a.y, z.y), cy));
  if (shape === 'circle') return Math.hypot(nx - cx, ny - cy) < box.w / 2 - 1;
  if (shape === 'diamond') return Math.abs(nx - cx) / (box.w / 2) + Math.abs(ny - cy) / (box.h / 2) < 1 - 2 / Math.min(box.w, box.h);
  return segmentHitsInterior([a, z], box);
}

/**
 * (sequence flow, own endpoint) pairs: a segment that enters the interior of the edge's OWN source
 * or target shape (every other measure and DI check exempts the
 * endpoints, which is how realistic-collaboration's inf3 ran through "Check completeness" unseen).
 * Does NOT count a boundary event's flow against its host (the host is not an endpoint).
 */
export function seqThroughOwnShape(coordMap, lc, edgeList) {
  const typeOf = {};
  const walk = (nodes) => { for (const n of nodes || []) { typeOf[n.id] = n.type; walk(n.nodes); } };
  for (const p of lc.pools || [lc]) walk(p.nodes);
  const shapeOf = (id) => (isEvent(typeOf[id]) ? 'circle' : isGateway(typeOf[id]) ? 'diamond' : 'rect');
  const out = [];
  for (const e of edgeList) {
    const segs = segments(coordMap.edgeCoords?.[e.id] || []);
    for (const [end, node] of [['source', e.source], ['target', e.target]]) {
      const box = coordMap.coords[node];
      if (box && segs.some((s) => segmentEntersShape(s, box, shapeOf(node)))) out.push({ edge: e.id, end, node });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Logic-Core traversal (gather every sequence-flow edge, incl. nested
// subprocess children, the way pipeline.js does for simplifyAllEdges)
// ─────────────────────────────────────────────────────────────────────────

function collectAllEdges(lc) {
  const edges = [];
  const walkNodes = (nodes) => {
    for (const n of nodes || []) {
      if (n.edges) edges.push(...n.edges);
      if (n.nodes) walkNodes(n.nodes);
    }
  };
  edges.push(...(lc.edges || []));
  walkNodes(lc.nodes || []);
  for (const p of lc.pools || []) {
    edges.push(...(p.edges || []));
    walkNodes(p.nodes || []);
  }
  return edges;
}

/**
 * Build the context the alignment metric needs: lane membership, node type,
 * which nodes host a boundary event, and in/out degrees.
 *
 * Lane membership goes through `resolveLaneId` and nothing else — reading
 * `node.lane` directly would silently miss the `lane.nodeIds` input format.
 */
function buildAlignContext(lc) {
  const procs = lc.pools ? lc.pools : [lc];
  const laneOf = {};
  const typeOf = {};
  const hostsBoundary = new Set();
  const walk = (nodes, proc) => {
    for (const n of nodes || []) {
      typeOf[n.id] = n.type;
      laneOf[n.id] = resolveLaneId(proc, n);
      if (n.attachedTo) hostsBoundary.add(n.attachedTo);
      if (n.nodes) walk(n.nodes, proc);
    }
  };
  for (const p of procs) walk(p.nodes, p);

  const edges = collectAllEdges(lc);
  const outDeg = {};
  const inDeg = {};
  for (const e of edges) {
    outDeg[e.source] = (outDeg[e.source] || 0) + 1;
    inDeg[e.target] = (inDeg[e.target] || 0) + 1;
  }
  return { laneOf, typeOf, hostsBoundary, outDeg, inDeg, edges };
}

/**
 * Is this link one whose endpoints *could* legitimately share a center-y?
 *
 * Returns `null` when alignable, otherwise the reason it is not. Every
 * exclusion below is a case where a vertical offset is correct behaviour, so
 * counting it as misalignment would manufacture a defect that isn't there:
 *
 *   'not-a-chain'  the link is not a plain 1:1 chain hop to begin with.
 *   'branch'       the target is a split (out-degree > 1) or the source is a
 *                  join (in-degree > 1). ELK places such a node on the
 *                  barycenter of its branches, which is what makes the
 *                  branches straight; pulling it onto its single partner would
 *                  just move the crookedness onto the other side.
 *   'hosts-boundary' the source carries a boundary event. `buildElkEdges`
 *                  re-anchors the boundary event's outgoing flow onto the
 *                  host, so ELK sees a split even though Logic-Core shows
 *                  out-degree 1 — same barycenter effect as 'branch'.
 *   'boundary-src' the source IS a boundary event. It is pinned to its host's
 *                  bottom edge by `placeBoundaryEvents`, so its y is dictated
 *                  by the host, not by its successor.
 *   'cross-lane'   source and target sit in different lanes. Lanes are
 *                  horizontal bands by definition — a cross-lane link can
 *                  never be straight, and demanding it would defeat lanes.
 *   'fold-back'    the target lies to the left of the source: a loop or, in a
 *                  wrapped layout, a row fold. Neither can be a straight line.
 */
function alignabilityOf(edge, coords, ctx) {
  const { laneOf, typeOf, hostsBoundary, outDeg, inDeg } = ctx;
  const s = coords[edge.source];
  const t = coords[edge.target];
  if (!s || !t) return 'no-coords';
  if (outDeg[edge.source] !== 1 || inDeg[edge.target] !== 1) return 'not-a-chain';
  if (typeOf[edge.source] === 'boundaryEvent') return 'boundary-src';
  if (hostsBoundary.has(edge.source)) return 'hosts-boundary';
  if ((outDeg[edge.target] || 0) > 1 || (inDeg[edge.source] || 0) > 1) return 'branch';
  if (laneOf[edge.source] !== laneOf[edge.target]) return 'cross-lane';
  if ((t.x + t.w / 2) <= (s.x + s.w / 2)) return 'fold-back';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Metrics over a coordMap-shaped {coords, edgeCoords} plus an edge list
// ─────────────────────────────────────────────────────────────────────────

function computeMetrics(coords, edgeCoords, edgeList, alignCtx) {
  const edges = edgeList
    .filter((e) => edgeCoords[e.id] && edgeCoords[e.id].length >= 2)
    .map((e) => ({ id: e.id, source: e.source, target: e.target, points: edgeCoords[e.id] }));

  // crossings
  let crossings = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i], b = edges[j];
      const adjacent = a.source === b.source || a.source === b.target || a.target === b.source || a.target === b.target;
      if (adjacent) continue;
      const segsA = segments(a.points), segsB = segments(b.points);
      for (const [p1, p2] of segsA) {
        for (const [p3, p4] of segsB) {
          if (segmentsIntersect(p1, p2, p3, p4)) crossings++;
        }
      }
    }
  }

  // bends + diagonals
  let totalBends = 0;
  let edgesWithLeq1Bend = 0;
  let diagonals = 0;
  for (const e of edges) {
    const segs = segments(e.points);
    let bends = 0;
    for (const [a, b] of segs) {
      const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
      if (dx > 1 && dy > 1) diagonals++;
    }
    for (let i = 1; i < segs.length; i++) {
      const prev = segs[i - 1], cur = segs[i];
      const prevDir = [Math.sign(prev[1].x - prev[0].x), Math.sign(prev[1].y - prev[0].y)];
      const curDir = [Math.sign(cur[1].x - cur[0].x), Math.sign(cur[1].y - cur[0].y)];
      if (prevDir[0] !== curDir[0] || prevDir[1] !== curDir[1]) bends++;
    }
    totalBends += bends;
    if (bends <= 1) edgesWithLeq1Bend++;
  }

  // area (over node coords — good enough proxy without pool/lane coords)
  const nodeIds = Object.keys(coords);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of nodeIds) {
    const c = coords[id];
    minX = Math.min(minX, c.x); minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + c.w); maxY = Math.max(maxY, c.y + c.h);
  }
  const bboxW = nodeIds.length ? maxX - minX : 0;
  const bboxH = nodeIds.length ? maxY - minY : 0;
  const area = bboxW * bboxH;
  const areaPerNode = nodeIds.length ? area / nodeIds.length : 0;
  const aspect = bboxH > 0 ? bboxW / bboxH : 0;

  // chainAlignment over structurally alignable links only — see alignabilityOf
  // for why each excluded class is correct behaviour rather than a defect.
  // Always driven by the Logic-Core edge list (alignCtx.edges), never by the
  // route list, so raw-ELK and final numbers stay directly comparable.
  let plainLinks = 0, alignedLinks = 0, worstGap = 0, worstLink = '';
  const excluded = {};
  for (const e of alignCtx.edges) {
    const reason = alignabilityOf(e, coords, alignCtx);
    if (reason) {
      if (reason !== 'not-a-chain' && reason !== 'no-coords') {
        excluded[reason] = (excluded[reason] || 0) + 1;
      }
      continue;
    }
    plainLinks++;
    const cyA = coords[e.source].y + coords[e.source].h / 2;
    const cyB = coords[e.target].y + coords[e.target].h / 2;
    const gap = Math.abs(cyA - cyB);
    if (gap <= 1) alignedLinks++;
    else if (gap > worstGap) { worstGap = gap; worstLink = `${e.id} ${e.source}->${e.target}`; }
  }

  // edgeThroughNode
  let edgeThroughNode = 0;
  for (const e of edges) {
    const segs = segments(e.points);
    for (const id of nodeIds) {
      if (id === e.source || id === e.target) continue;
      // An expanded subprocess contains its own children's edges by construction — not a defect.
      if (boxContains(coords[id], coords[e.source]) || boxContains(coords[id], coords[e.target])) continue;
      const rect = coords[id];
      for (const [a, b] of segs) {
        if (segmentRectOverlap(a, b, rect)) { edgeThroughNode++; break; }
      }
    }
  }

  return {
    crossings,
    totalBends,
    edgesWithLeq1Bend,
    edgeCount: edges.length,
    diagonals,
    area: Math.round(area),
    areaPerNode: Math.round(areaPerNode),
    bboxW: Math.round(bboxW),
    bboxH: Math.round(bboxH),
    aspect,
    nodeCount: nodeIds.length,
    plainLinks,
    alignedLinks,
    worstGap,
    worstLink,
    excluded,
    edgeThroughNode,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Raw-ELK flattening (mirrors coordinates.js collectNodes/collectEdge, but
// only what's needed for a crossing count — no lane/pool special-casing,
// no SHAPE re-sizing, since coordinates.js hasn't run yet at this point)
// ─────────────────────────────────────────────────────────────────────────

// Container ids to exclude from the node-box set (pools/lanes), so raw-ELK
// area/edge-through-node numbers are comparable to the final metrics, which
// only ever see actual BPMN element boxes (pools/lanes live in separate
// poolCoords/laneCoords maps there, never in `coords`).
function collectContainerIds(lc) {
  const ids = new Set(['collaboration', 'root', 'pool']);
  const procs = lc.pools ? lc.pools : [lc];
  for (const p of procs) {
    if (p.id) ids.add(p.id);
    for (const l of p.lanes || []) ids.add(l.id);
  }
  for (const cp of lc.collapsedPools || []) ids.add(cp.id);
  return ids;
}

function flattenElk(node, offX, offY, acc, containerIds) {
  const ax = (node.x || 0) + offX;
  const ay = (node.y || 0) + offY;
  const isContainer = containerIds.has(node.id);
  if (!isContainer && node.width != null && node.height != null) {
    acc.coords[node.id] = { x: ax, y: ay, w: node.width, h: node.height };
  }
  for (const c of node.children || []) flattenElk(c, ax, ay, acc, containerIds);
  for (const e of node.edges || []) {
    const pts = [];
    for (const sec of e.sections || []) {
      pts.push({ x: sec.startPoint.x + ax, y: sec.startPoint.y + ay });
      for (const bp of sec.bendPoints || []) pts.push({ x: bp.x + ax, y: bp.y + ay });
      pts.push({ x: sec.endPoint.x + ax, y: sec.endPoint.y + ay });
    }
    acc.edgeCoords[e.id] = pts;
    acc.edgeList.push({ id: e.id, source: e.sources?.[0], target: e.targets?.[0] });
  }
}

const EVERYTHING_ON = { visualRefinement: true, elkWrapping: 'auto' };

async function measureRawElk(lc, alignCtx) {
  const clone = JSON.parse(JSON.stringify(lc));
  const containerIds = collectContainerIds(clone);
  const elkGraph = logicCoreToElk(clone, { elkWrapping: false, poolOrder: 'auto' });
  const elkResult = await runElkLayout(elkGraph);
  const acc = { coords: {}, edgeCoords: {}, edgeList: [] };
  flattenElk(elkResult, 0, 0, acc, containerIds);
  const byId = new Map(collectAllEdges(lc).map((e) => [e.id, e]));
  acc.edgeList = acc.edgeList.map((e) => byId.get(e.id) ?? e);
  return computeMetrics(acc.coords, acc.edgeCoords, acc.edgeList, alignCtx);
}

/** Strict box overlap; touching does not count. */
function boxesOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Slack on top of `layout.edgeLabelGap` before a label counts as detached from its own route. */
export const LABEL_DISTANCE_TOLERANCE_PX = 2;

/** Distance between a box and an axis-parallel (or any) segment's bounding box; 0 when they touch. */
function boxSegmentDistance(b, p, q) {
  const dx = Math.max(0, Math.min(p.x, q.x) - (b.x + b.w), b.x - Math.max(p.x, q.x));
  const dy = Math.max(0, Math.min(p.y, q.y) - (b.y + b.h), b.y - Math.max(p.y, q.y));
  return Math.hypot(dx, dy);
}

/**
 * Edge-label boxes against their own route, each other, node shapes and lane separators — see the
 * header. `ownEdge`, `laneLine`, `farFromEdge`: label ids; `labelLabel`: `a/b` pairs;
 * `labelNode`: `label>node`.
 */
export function edgeLabelHits(coordMap, lc) {
  const containers = new Set((lc.pools || [lc]).flatMap((p) => flattenProcessNodes(p.nodes || []))
    .filter((n) => (n.isExpanded && n.nodes?.length) || n.type === 'group').map((n) => n.id));
  const labels = Object.entries(coordMap.edgeLabels || {}).map(([id, L]) => [id, edgeLabelBox(L)]);
  const out = { ownEdge: [], labelLabel: [], labelNode: [], laneLine: [], farFromEdge: [] };
  const lines = innerLaneLines(coordMap, lc);
  const maxDistance = (CFG.layout?.edgeLabelGap ?? 4) + LABEL_DISTANCE_TOLERANCE_PX;
  labels.forEach(([id, box], i) => {
    const route = coordMap.edgeCoords?.[id];
    if (labelHitsRoute(box, route)) out.ownEdge.push(id);
    if (lines.some((L) => box.y < L.y && L.y < box.y + box.h && box.x < L.x1 && L.x0 < box.x + box.w)) out.laneLine.push(id);
    if (route?.length >= 2) {
      let d = Infinity;
      for (let k = 0; k + 1 < route.length; k++) d = Math.min(d, boxSegmentDistance(box, route[k], route[k + 1]));
      if (d > maxDistance) out.farFromEdge.push(id);
    }
    for (const [other, ob] of labels.slice(i + 1)) if (boxesOverlap(box, ob)) out.labelLabel.push(`${id}/${other}`);
    for (const [node, c] of Object.entries(coordMap.coords || {})) {
      if (containers.has(node) && boxWithin(c, box)) continue;
      if (boxesOverlap(box, c)) out.labelNode.push(`${id}>${node}`);
    }
  });
  return out;
}

/** One fixture × mode, every readability measure. `null` when the pipeline blocks the model. */
export async function measureLayout(lc, opts = {}) {
  const r = await runPipeline(lc, opts);
  if (!r.coordMap) return null;
  const edgeList = collectAllEdges(lc);
  const cm = r.coordMap;
  const f = flowMetrics(cm, lc);
  const diCodes = {};
  for (const i of r.diagnostics?.issues || []) diCodes[i.code] = (diCodes[i.code] || 0) + 1;
  return {
    crossings: computeMetrics(cm.coords, cm.edgeCoords, edgeList, buildAlignContext(lc)).crossings,
    alongBorder: edgeEndsAlongBorder(cm.coords, cm.edgeCoords, edgeList),
    laneGaps: laneGaps(cm, lc),
    mfThroughNodes: messageFlowThroughNodes(cm, lc),
    seqThroughNodes: seqFlowThroughNodes(cm, edgeList),
    ownThrough: seqThroughOwnShape(cm, lc, edgeList),
    labels: edgeLabelHits(cm, lc),
    flow: { hug: f.seq.laneLineHug, bendsMax: f.seq.bendsMax, crowd: f.seq.crowd.pairs, mfCrowd: f.mf.crowd.pairs,
      offOver5: f.seq.endOffOver5 + f.mf.endOffOver5, overlapLen: f.overlapLen },
    direction: flowDirectionMetrics(cm, lc),
    diCodes,
  };
}

/** The counts the fence compares. */
export function summarize(m) {
  if (!m) return null;
  return {
    crossings: m.crossings,
    along: m.alongBorder.length,
    laneGap: Math.round(Math.max(0, ...m.laneGaps.map((g) => g.gap))),
    mfThrough: m.mfThroughNodes.length,
    seqThrough: m.seqThroughNodes.length,
    ownThrough: m.ownThrough.length,
    hug: m.flow.hug,
    bendsMax: m.flow.bendsMax,
    crowd: m.flow.crowd,
    mfCrowd: m.flow.mfCrowd,
    offOver5: m.flow.offOver5,
    labelOwnEdge: m.labels.ownEdge.length,
    labelLabel: m.labels.labelLabel.length,
    labelNode: m.labels.labelNode.length,
    labelLaneLine: m.labels.laneLine.length,
    labelFar: m.labels.farFromEdge.length,
    overlapLen: m.flow.overlapLen,
  };
}

/** The flow-direction counts the fence compares — kept apart from summarize(), whose rows predate them. */
export function summarizeDirection(m) {
  if (!m) return null;
  return { avoidableBends: m.direction.avoidableBends, againstFlowEntries: m.direction.againstFlowEntries };
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

async function measureFixture(name) {
  try {
    const raw = readFileSync(join(fixturesDir, name), 'utf8');
    const lc = JSON.parse(raw);
    const edgeList = collectAllEdges(lc);
    const alignCtx = buildAlignContext(lc);
  
    const unrefinedResult = await runPipeline(lc, { visualRefinement: false });
    const refinedResult = await runPipeline(lc, EVERYTHING_ON);
  
    const unrefinedMetrics = unrefinedResult.coordMap
      ? computeMetrics(unrefinedResult.coordMap.coords, unrefinedResult.coordMap.edgeCoords, edgeList, alignCtx)
      : null;
    const refinedMetrics = refinedResult.coordMap
      ? computeMetrics(refinedResult.coordMap.coords, refinedResult.coordMap.edgeCoords, edgeList, alignCtx)
      : null;
    const rawElkMetrics = await measureRawElk(lc, alignCtx);
  
    const extras = async (opts) =>
      summarize(await measureLayout(JSON.parse(raw), opts));
    return { name, unrefinedMetrics, refinedMetrics, rawElkMetrics,
      unrefinedExtras: await extras({ visualRefinement: false }), refinedExtras: await extras(EVERYTHING_ON) };
  } catch (err) {
    return { name, error: String(err.message || err) };
  }
}

const EXCLUSION_ORDER = ['cross-lane', 'fold-back', 'branch', 'hosts-boundary', 'boundary-src'];

function fmtExcluded(excluded) {
  const parts = EXCLUSION_ORDER
    .filter((k) => excluded[k])
    .map((k) => `${excluded[k]} ${k}`);
  return parts.length ? parts.join(', ') : '—';
}

function fmtRow(label, m, x) {
  if (!m) return `| ${label} | (pipeline errored) | | | | | | | | | | | | |`;
  const alignPct = m.plainLinks ? Math.round((100 * m.alignedLinks) / m.plainLinks) : 0;
  const align = `${m.alignedLinks}/${m.plainLinks} (${alignPct}%)`;
  return `| ${label} | ${m.crossings} | ${m.totalBends} | ${m.edgesWithLeq1Bend}/${m.edgeCount} | ${m.diagonals} | ${m.bboxW}×${m.bboxH} (${m.areaPerNode}/node) | ${m.aspect.toFixed(2)} | ${align} | ${fmtExcluded(m.excluded)} | ${m.edgeThroughNode} | ${x ? x.along : '—'} | ${x ? x.laneGap : '—'} | ${x ? x.mfThrough : '—'} | ${x ? `${x.labelOwnEdge}/${x.labelLabel}/${x.labelNode}` : '—'} |`;
}

async function main() {
  const results = [];
  for (const fixture of FIXTURES) {
    process.stderr.write(`measuring ${fixture}...\n`);
    results.push(await measureFixture(fixture));
  }

  const lines = [];
  lines.push('# Layout Quality Metrics — Baseline');
  lines.push('');
  lines.push('Generated by `scripts/bench/layout-metrics.mjs`. Not part of `npm test` — a snapshot,');
  lines.push('re-run on demand, not enforced as a regression gate.');
  lines.push('');
  lines.push('**Columns.** *Crossings*: pairwise segment intersections between non-adjacent sequence-flow');
  lines.push('edges. *Bends*: total direction changes, and how many edges need at most one. *Diagonals*:');
  lines.push('non-orthogonal segments — always expected to be 0. *Area*: node-bbox width×height and px² per');
  lines.push('node. *Aspect*: bbox w/h. *Chain alignment*: of the links that could structurally be straight,');
  lines.push('how many share center-y within 1 px. *Excluded*: links left out of that quota because a');
  lines.push('vertical offset is correct for them — see below. *Edge-through-node*: segments crossing a');
  lines.push('foreign node box. *Along outline*: sequence-flow ends lying on their own endpoint\'s outline for more than 5 px (#52).');
  lines.push('*Lane gap max*: largest empty strip in a participant\'s lane stack, px. *MF through node*: message-flow segments');
  lines.push('through a foreign shape (groups and endpoint containers excluded). *Labels*: edge-label boxes reaching into');
  lines.push('their own route / overlapping another label / overlapping a node box (a container holding the label excluded).');
  lines.push('');
  lines.push('**Reading the numbers.** Two comparisons are invalid and the table deliberately does not');
  lines.push('invite them. Area must not be compared between "ELK raw" and the pipeline rows: raw ELK has');
  lines.push('not placed lane bands yet, so the growth measures the existence of swimlanes, not bloat. And');
  lines.push('area must not be read as a quality score for a wrapped layout: wrapping trades width for');
  lines.push('height on purpose, which grows total area while improving aspect ratio, which is why aspect');
  lines.push('has its own column.');
  lines.push('');
  lines.push('**Alignment exclusions.** A link is only counted when its two endpoints could legitimately');
  lines.push('share a center-y. Excluded are: `cross-lane` (lanes are horizontal bands — such a link can');
  lines.push('never be straight), `fold-back` (target left of source: a loop, or a row fold in a wrapped');
  lines.push('layout), `branch` (target is a split or source is a join — ELK puts it on its branches\'');
  lines.push('barycenter, which is what makes those branches straight), `hosts-boundary` (the source carries');
  lines.push('a boundary event, whose flow ELK re-anchors onto the host, producing the same barycenter');
  lines.push('effect), and `boundary-src` (the source is a boundary event, pinned to its host\'s edge).');
  lines.push('Counting these as misalignment is exactly the error the first version of this harness made.');
  lines.push('');

  for (const r of results) {
    lines.push(`## ${r.name}`);
    lines.push('');
    if (r.error) {
      lines.push(`Pipeline error: ${r.error}`);
      lines.push('');
      continue;
    }
    lines.push('| Variant | Crossings | Bends | Edges <=1 bend | Diag | Area (w×h) | Aspect | Chain alignment | Excluded (not alignable) | Edge-through-node | Along outline | Lane gap max | MF through node | Labels own/L-L/L-N |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    lines.push(fmtRow('ELK raw (pre-postprocess)', r.rawElkMetrics, null));
    lines.push(fmtRow('unrefined', r.unrefinedMetrics, r.unrefinedExtras));
    lines.push(fmtRow('everything on (refine + wrap)', r.refinedMetrics, r.refinedExtras));
    lines.push('');
    if (r.unrefinedMetrics) {
      const delta = r.unrefinedMetrics.crossings - r.rawElkMetrics.crossings;
      if (delta > 0) {
        lines.push(`Crossings introduced by our own post-processing (default − ELK raw): **+${delta}** —`);
        lines.push('ELK routed around these; the routes we delete and rebuild do not.');
      } else {
        lines.push('Our post-processing introduces no crossings beyond ELK\'s own result.');
      }
      lines.push('');
      const worst = r.unrefinedMetrics.worstGap;
      if (worst > 1) {
        lines.push(`Worst remaining alignable gap: ${worst.toFixed(1)} px (\`${r.unrefinedMetrics.worstLink}\`).`);
        lines.push('');
      }
    }
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, lines.join('\n') + '\n');
  process.stderr.write(`\nwrote ${outPath}\n`);
}

// Importable: the fence test (layout-metrics.test.js) and the local review tools import the
// measures; only a direct run measures every fixture and rewrites the baseline file.
if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
