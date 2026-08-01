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
 * Measures, per fixture:
 *   - crossings         pairwise segment intersections between non-adjacent
 *                        sequence-flow edges (edges sharing a source/target
 *                        node are considered adjacent and excluded)
 *   - bends             direction changes per edge polyline (sum + count of
 *                        edges with <=1 bend)
 *   - diagonals         segments with both dx>1 and dy>1 (should be 0 —
 *                        the pipeline promises strictly orthogonal routing)
 *   - area              bounding box over all pool/participant boxes, plus
 *                        px^2 per node
 *   - chainAlignment    simplified proxy: of all edges (u->v) where u has
 *                        out-degree 1 and v has in-degree 1 (a "plain link"),
 *                        what fraction keeps identical center-y (+-1px)?
 *                        NOT lane-aware and NOT the full Run-and-Anchor
 *                        definition — a cheap stand-in used only to gauge
 *                        whether chains visually snap into a straight row.
 *   - edgeThroughNode   segments whose bounding box overlaps a node box that
 *                        is neither the edge's source nor its target
 *
 * Also compares crossings on ELK's *raw* output (before coordinates.js
 * post-processing, i.e. before the lane-band shift deletes/rebuilds routes)
 * against crossings on the final pipeline output, to quantify how much the
 * lane-shift step (coordinates.js §5.0a) actually costs.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../bpmn/pipeline.js';
import { logicCoreToElk, runElkLayout } from '../bpmn/layout.js';

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

// ─────────────────────────────────────────────────────────────────────────
// Metrics over a coordMap-shaped {coords, edgeCoords} plus an edge list
// ─────────────────────────────────────────────────────────────────────────

function computeMetrics(coords, edgeCoords, edgeList) {
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
  const area = nodeIds.length ? (maxX - minX) * (maxY - minY) : 0;
  const areaPerNode = nodeIds.length ? area / nodeIds.length : 0;

  // chainAlignment (simplified — see module doc comment)
  const outDeg = {}, inDeg = {};
  for (const e of edgeList) {
    outDeg[e.source] = (outDeg[e.source] || 0) + 1;
    inDeg[e.target] = (inDeg[e.target] || 0) + 1;
  }
  let plainLinks = 0, alignedLinks = 0;
  for (const e of edgeList) {
    if (!coords[e.source] || !coords[e.target]) continue;
    if (outDeg[e.source] !== 1 || inDeg[e.target] !== 1) continue;
    plainLinks++;
    const cyA = coords[e.source].y + coords[e.source].h / 2;
    const cyB = coords[e.target].y + coords[e.target].h / 2;
    if (Math.abs(cyA - cyB) <= 1) alignedLinks++;
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
    nodeCount: nodeIds.length,
    plainLinks,
    alignedLinks,
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

async function measureRawElk(lc) {
  const clone = JSON.parse(JSON.stringify(lc));
  const containerIds = collectContainerIds(clone);
  const elkGraph = logicCoreToElk(clone, { elkWrapping: false, poolOrder: 'auto' });
  const elkResult = await runElkLayout(elkGraph);
  const acc = { coords: {}, edgeCoords: {}, edgeList: [] };
  flattenElk(elkResult, 0, 0, acc, containerIds);
  return computeMetrics(acc.coords, acc.edgeCoords, acc.edgeList);
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

async function measureFixture(name) {
  const raw = readFileSync(join(fixturesDir, name), 'utf8');
  const lc = JSON.parse(raw);
  const edgeList = collectAllEdges(lc);

  const defaultResult = await runPipeline(lc, { visualRefinement: false });
  const refinedResult = await runPipeline(lc, { visualRefinement: true });

  const defaultMetrics = defaultResult.coordMap
    ? computeMetrics(defaultResult.coordMap.coords, defaultResult.coordMap.edgeCoords, edgeList)
    : null;
  const refinedMetrics = refinedResult.coordMap
    ? computeMetrics(refinedResult.coordMap.coords, refinedResult.coordMap.edgeCoords, edgeList)
    : null;
  const rawElkMetrics = await measureRawElk(lc);

  return { name, defaultMetrics, refinedMetrics, rawElkMetrics };
}

function fmtRow(label, m) {
  if (!m) return `| ${label} | (pipeline errored) | | | | | | | |`;
  const alignPct = m.plainLinks ? Math.round((100 * m.alignedLinks) / m.plainLinks) : 0;
  return `| ${label} | ${m.crossings} | ${m.totalBends} | ${m.edgesWithLeq1Bend}/${m.edgeCount} | ${m.diagonals} | ${m.area} (${m.areaPerNode}/node) | ${m.alignedLinks}/${m.plainLinks} (${alignPct}%) | ${m.edgeThroughNode} |`;
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
  lines.push('Columns: crossings (pairwise segment intersections between non-adjacent sequence-flow edges),');
  lines.push('bends (total direction changes / edges with <=1 bend), diagonals (non-orthogonal segments —');
  lines.push('should be 0), area (bbox px^2, and px^2 per node), chain alignment (plain in/out-degree-1 links');
  lines.push('sharing center-y, a simplified proxy — see module doc comment), edge-through-node (segments');
  lines.push('crossing a foreign node box).');
  lines.push('');

  for (const r of results) {
    lines.push(`## ${r.name}`);
    lines.push('');
    lines.push('| Variant | Crossings | Bends (total) | Edges <=1 bend | Diagonals | Area | Chain alignment | Edge-through-node |');
    lines.push('|---|---|---|---|---|---|---|---|');
    lines.push(fmtRow('ELK raw (pre-postprocess)', r.rawElkMetrics));
    lines.push(fmtRow('default', r.defaultMetrics));
    lines.push(fmtRow('visualRefinement: true', r.refinedMetrics));
    lines.push('');
    if (r.defaultMetrics) {
      const delta = r.defaultMetrics.crossings - r.rawElkMetrics.crossings;
      lines.push(`Lane-shift crossing delta (default − ELK raw): **${delta >= 0 ? '+' : ''}${delta}**`);
      lines.push('');
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
