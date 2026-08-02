#!/usr/bin/env node
/**
 * layout-metrics.mjs
 *
 * Layout-quality measurement harness for the "does the Petrov/Flowable
 * arrangement algorithm help us" analysis (docs/layout-quality-analysis.md).
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
 *
 * Also measures ELK's *raw* output (before coordinates.js post-processing) so
 * that crossings introduced by our own route rebuilding become visible: ELK
 * routes around obstacles, our synthetic 4-point replacements do not.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../bpmn/pipeline.js';
import { logicCoreToElk, runElkLayout } from '../bpmn/layout.js';
import { resolveLaneId } from '../bpmn/topology.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const fixturesDir = join(repoRoot, 'tests', 'fixtures');
const outPath = join(repoRoot, 'tests', 'bench', 'layout-metrics-baseline.md');

const FIXTURES = [
  'simple-approval.json',
  'multi-pool-collaboration.json',
  'realistic-collaboration.json',
  'all-element-classes.json',
  'expanded-subprocess.json',
  'sparse-lanes.json',
  'wide-pipeline.json',
  'bpmn-generator-pipeline.json',
];

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

async function measureRawElk(lc, alignCtx) {
  const clone = JSON.parse(JSON.stringify(lc));
  const containerIds = collectContainerIds(clone);
  const elkGraph = logicCoreToElk(clone, { elkWrapping: false, poolOrder: 'auto' });
  const elkResult = await runElkLayout(elkGraph);
  const acc = { coords: {}, edgeCoords: {}, edgeList: [] };
  flattenElk(elkResult, 0, 0, acc, containerIds);
  return computeMetrics(acc.coords, acc.edgeCoords, acc.edgeList, alignCtx);
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

async function measureFixture(name) {
  const raw = readFileSync(join(fixturesDir, name), 'utf8');
  const lc = JSON.parse(raw);
  const edgeList = collectAllEdges(lc);
  const alignCtx = buildAlignContext(lc);

  const defaultResult = await runPipeline(lc, { visualRefinement: false });
  const refinedResult = await runPipeline(lc, { visualRefinement: true });

  const defaultMetrics = defaultResult.coordMap
    ? computeMetrics(defaultResult.coordMap.coords, defaultResult.coordMap.edgeCoords, edgeList, alignCtx)
    : null;
  const refinedMetrics = refinedResult.coordMap
    ? computeMetrics(refinedResult.coordMap.coords, refinedResult.coordMap.edgeCoords, edgeList, alignCtx)
    : null;
  const rawElkMetrics = await measureRawElk(lc, alignCtx);

  return { name, defaultMetrics, refinedMetrics, rawElkMetrics };
}

const EXCLUSION_ORDER = ['cross-lane', 'fold-back', 'branch', 'hosts-boundary', 'boundary-src'];

function fmtExcluded(excluded) {
  const parts = EXCLUSION_ORDER
    .filter((k) => excluded[k])
    .map((k) => `${excluded[k]} ${k}`);
  return parts.length ? parts.join(', ') : '—';
}

function fmtRow(label, m) {
  if (!m) return `| ${label} | (pipeline errored) | | | | | | | | |`;
  const alignPct = m.plainLinks ? Math.round((100 * m.alignedLinks) / m.plainLinks) : 0;
  const align = `${m.alignedLinks}/${m.plainLinks} (${alignPct}%)`;
  return `| ${label} | ${m.crossings} | ${m.totalBends} | ${m.edgesWithLeq1Bend}/${m.edgeCount} | ${m.diagonals} | ${m.bboxW}×${m.bboxH} (${m.areaPerNode}/node) | ${m.aspect.toFixed(2)} | ${align} | ${fmtExcluded(m.excluded)} | ${m.edgeThroughNode} |`;
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
  lines.push('Generated by `scripts/bench/layout-metrics.mjs`. Not part of `npm test` — a snapshot for');
  lines.push('`docs/layout-quality-analysis.md`, re-run on demand, not enforced as a regression gate.');
  lines.push('');
  lines.push('**Columns.** *Crossings*: pairwise segment intersections between non-adjacent sequence-flow');
  lines.push('edges. *Bends*: total direction changes, and how many edges need at most one. *Diagonals*:');
  lines.push('non-orthogonal segments — always expected to be 0. *Area*: node-bbox width×height and px² per');
  lines.push('node. *Aspect*: bbox w/h. *Chain alignment*: of the links that could structurally be straight,');
  lines.push('how many share center-y within 1 px. *Excluded*: links left out of that quota because a');
  lines.push('vertical offset is correct for them — see below. *Edge-through-node*: segments crossing a');
  lines.push('foreign node box.');
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
    lines.push('| Variant | Crossings | Bends | Edges <=1 bend | Diag | Area (w×h) | Aspect | Chain alignment | Excluded (not alignable) | Edge-through-node |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    lines.push(fmtRow('ELK raw (pre-postprocess)', r.rawElkMetrics));
    lines.push(fmtRow('default', r.defaultMetrics));
    lines.push(fmtRow('visualRefinement: true', r.refinedMetrics));
    lines.push('');
    if (r.defaultMetrics) {
      const delta = r.defaultMetrics.crossings - r.rawElkMetrics.crossings;
      if (delta > 0) {
        lines.push(`Crossings introduced by our own post-processing (default − ELK raw): **+${delta}** —`);
        lines.push('ELK routed around these; the routes we delete and rebuild do not.');
      } else {
        lines.push('Our post-processing introduces no crossings beyond ELK\'s own result.');
      }
      lines.push('');
      const worst = r.defaultMetrics.worstGap;
      if (worst > 1) {
        lines.push(`Worst remaining alignable gap: ${worst.toFixed(1)} px (\`${r.defaultMetrics.worstLink}\`).`);
        lines.push('');
      }
    }
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, lines.join('\n') + '\n');
  process.stderr.write(`\nwrote ${outPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
