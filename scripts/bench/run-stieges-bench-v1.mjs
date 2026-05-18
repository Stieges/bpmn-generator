#!/usr/bin/env node
/**
 * Stieges-Bench v1
 * ----------------
 * Deterministic benchmark: every Logic-Core fixture in tests/fixtures/*.json is
 * run through the production pipeline. Captures parse-success, soundness/style
 * findings, node/edge counts, edge-crossings, output sizes, wall-clock time and
 * input-schema validity. No LLM, no network, fully reproducible.
 *
 * Outputs:
 *   tests/bench/stieges-bench-v1.json  — raw machine-readable results
 *   tests/bench/stieges-bench-v1.md    — human-readable summary (table)
 *
 * Exit code:
 *   0 if every fixture parses (warnings are fine)
 *   1 if any fixture failed to parse (runPipeline threw)
 *
 * Bench-only: geometry helpers below do NOT live in production code.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { execSync } from 'node:child_process';
import { runPipeline } from '../pipeline.js';
import { validateLogicCoreSchema } from '../schema-gate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const fixturesDir = join(repoRoot, 'tests', 'fixtures');
const outDir = join(repoRoot, 'tests', 'bench');
const outJson = join(outDir, 'stieges-bench-v1.json');
const outMd = join(outDir, 'stieges-bench-v1.md');

// ---------------------------------------------------------------------------
// Geometry helpers (bench-only)
// ---------------------------------------------------------------------------

// coordMap.edgeCoords shape (verified): { edgeId: [{x,y}, {x,y}, ...] }
function countEdgeCrossings(coordMap) {
  const edges = Object.values(coordMap?.edgeCoords || {});
  let crossings = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      if (segmentsCross(edges[i], edges[j])) crossings++;
    }
  }
  return crossings;
}

function segmentsCross(a, b) {
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      if (doSegmentsIntersect(a[i], a[i + 1], b[j], b[j + 1])) return true;
    }
  }
  return false;
}

function doSegmentsIntersect(p1, p2, p3, p4) {
  const ccw = (A, B, C) => (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
  return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
}

// ---------------------------------------------------------------------------
// Logic-Core counters
// ---------------------------------------------------------------------------

// A Logic-Core file is either a single process or a collaboration with `pools`.
// We count nodes / edges across all pools to give one fixture-wide number.
// Schema reality (per references/input-schema.json): each pool has `nodes` and
// `edges` directly; sequence flows are `edges`, cross-pool flows are
// `messageFlows` at the top level. Some single-process fixtures may live at
// the root without a `pools` wrapper, so we handle both shapes.
function countNodesAndEdges(lc) {
  let nodes = 0;
  let edges = 0;
  const processes = Array.isArray(lc.pools) && lc.pools.length > 0
    ? lc.pools
    : [lc];
  for (const p of processes) {
    if (Array.isArray(p.nodes)) nodes += p.nodes.length;
    if (Array.isArray(p.edges)) edges += p.edges.length;
    if (Array.isArray(p.flows)) edges += p.flows.length; // legacy/alt key
  }
  if (Array.isArray(lc.messageFlows)) edges += lc.messageFlows.length;
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Per-fixture runner
// ---------------------------------------------------------------------------

async function runFixture(filePath) {
  const name = basename(filePath, '.json');
  const raw = readFileSync(filePath, 'utf8');
  const lc = JSON.parse(raw);

  const schemaResult = validateLogicCoreSchema(lc);
  const { nodes: nodeCount, edges: edgeCount } = countNodesAndEdges(lc);

  const t0 = performance.now();
  let result, parses = true, errorMessage = null;
  try {
    result = await runPipeline(lc);
  } catch (err) {
    parses = false;
    errorMessage = err && err.message ? err.message : String(err);
  }
  const wallClockMs = +(performance.now() - t0).toFixed(2);

  if (!parses) {
    return {
      fixture: name,
      parses: false,
      serialized: false,
      error: errorMessage,
      schemaValid: schemaResult.valid,
      nodeCount,
      edgeCount,
      soundnessErrors: null,
      soundnessWarnings: null,
      layoutCrossings: null,
      bpmnXmlBytes: 0,
      svgBytes: 0,
      wallClockMs,
    };
  }

  const validation = result.validation || {};
  const soundnessErrors = Array.isArray(validation.errors) ? validation.errors.length : 0;
  const soundnessWarnings = Array.isArray(validation.warnings) ? validation.warnings.length : 0;
  const layoutCrossings = countEdgeCrossings(result.coordMap);
  const bpmnXmlBytes = Buffer.byteLength(result.bpmnXml || '', 'utf8');
  const svgBytes = Buffer.byteLength(result.svg || '', 'utf8');
  // When the rule engine reports ERROR-level findings, the pipeline aborts
  // serialization (no BPMN/SVG produced) but does NOT throw. That's a
  // semantic-validation outcome distinct from a parse failure, so we surface
  // it as `serialized` while keeping `parses` strictly = "didn't throw".
  const serialized = bpmnXmlBytes > 0 && svgBytes > 0;

  return {
    fixture: name,
    parses: true,
    serialized,
    schemaValid: schemaResult.valid,
    nodeCount,
    edgeCount,
    soundnessErrors,
    soundnessWarnings,
    layoutCrossings,
    bpmnXmlBytes,
    svgBytes,
    wallClockMs,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderMarkdown(payload) {
  const { generatedAt, gitCommit, fixtureCount, results, totals, anyParseFailure } = payload;
  const lines = [];
  lines.push('# Stieges-Bench v1');
  lines.push('');
  lines.push('Deterministic pipeline benchmark over every Logic-Core fixture in');
  lines.push('`tests/fixtures/*.json`. No LLM, no network. Reproducible via');
  lines.push('`node scripts/bench/run-stieges-bench-v1.mjs`.');
  lines.push('');
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Commit: ${gitCommit}`);
  lines.push(`- Fixtures: ${fixtureCount}`);
  lines.push(`- All parsed: ${anyParseFailure ? 'NO' : 'YES'}`);
  lines.push('');
  lines.push('## Per-fixture results');
  lines.push('');
  lines.push('| Fixture | Parses | Serialized | Schema | Nodes | Edges | Sound-Err | Sound-Warn | Crossings | BPMN (B) | SVG (B) | Time (ms) |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of results) {
    lines.push(
      `| ${r.fixture} | ${r.parses ? 'yes' : 'NO'} | ${r.serialized ? 'yes' : 'no'} | ${r.schemaValid ? 'yes' : 'no'} | ${r.nodeCount} | ${r.edgeCount} | ` +
      `${r.soundnessErrors ?? '-'} | ${r.soundnessWarnings ?? '-'} | ${r.layoutCrossings ?? '-'} | ` +
      `${r.bpmnXmlBytes} | ${r.svgBytes} | ${r.wallClockMs} |`
    );
  }
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push(`- Fixtures that parse (runPipeline didn't throw): **${totals.parsed} / ${fixtureCount}**`);
  lines.push(`- Fixtures that serialize (non-empty BPMN+SVG): **${totals.serialized} / ${fixtureCount}**`);
  lines.push(`- Schema-valid inputs: **${totals.schemaValid} / ${fixtureCount}**`);
  lines.push(`- Total nodes: **${totals.nodes}**`);
  lines.push(`- Total edges: **${totals.edges}**`);
  lines.push(`- Total soundness errors: **${totals.soundnessErrors}**`);
  lines.push(`- Total soundness warnings: **${totals.soundnessWarnings}**`);
  lines.push(`- Total edge crossings: **${totals.crossings}**`);
  lines.push(`- Cumulative wall-clock: **${totals.wallClockMs.toFixed(2)} ms**`);
  lines.push(`- Output bytes (BPMN + SVG): **${totals.bpmnXmlBytes + totals.svgBytes}**`);
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- **Parses**: `runPipeline` did not throw.');
  lines.push('- **Serialized**: pipeline produced non-empty BPMN + SVG. When');
  lines.push('  rule-engine ERROR findings exist, the pipeline aborts');
  lines.push('  serialization on purpose (no diagram for an unsound model) but');
  lines.push('  does not throw — so `parses=yes`, `serialized=no` is the');
  lines.push('  expected outcome for fixtures like `deadlock-process`.');
  lines.push('- "Sound-Err" counts rule-engine ERROR findings (Soundness layer).');
  lines.push('- "Sound-Warn" counts WARNING-level findings (Style + Pragmatics).');
  lines.push('- "Crossings" is a quadratic O(E^2) scan of edge polylines using a');
  lines.push('  CCW-orientation segment-intersection test. Endpoint touches are not');
  lines.push('  filtered, so a small non-zero count for connected edges is normal.');
  lines.push('- Wall-clock is single-run (no warmup); for tight comparisons rerun.');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function gitHead() {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim();
  } catch {
    return 'unknown';
  }
}

async function main() {
  mkdirSync(outDir, { recursive: true });

  const fixturePaths = readdirSync(fixturesDir)
    .filter(f => f.endsWith('.json'))
    .map(f => join(fixturesDir, f))
    .filter(p => statSync(p).isFile())
    .sort();

  const results = [];
  for (const fp of fixturePaths) {
    process.stderr.write(`[bench] ${basename(fp)} ... `);
    const r = await runFixture(fp);
    process.stderr.write(`${r.parses ? 'ok' : 'FAIL'} (${r.wallClockMs}ms)\n`);
    results.push(r);
  }

  const totals = results.reduce((acc, r) => {
    acc.parsed += r.parses ? 1 : 0;
    acc.serialized += r.serialized ? 1 : 0;
    acc.schemaValid += r.schemaValid ? 1 : 0;
    acc.nodes += r.nodeCount || 0;
    acc.edges += r.edgeCount || 0;
    acc.soundnessErrors += r.soundnessErrors || 0;
    acc.soundnessWarnings += r.soundnessWarnings || 0;
    acc.crossings += r.layoutCrossings || 0;
    acc.bpmnXmlBytes += r.bpmnXmlBytes || 0;
    acc.svgBytes += r.svgBytes || 0;
    acc.wallClockMs += r.wallClockMs || 0;
    return acc;
  }, {
    parsed: 0, serialized: 0, schemaValid: 0, nodes: 0, edges: 0,
    soundnessErrors: 0, soundnessWarnings: 0, crossings: 0,
    bpmnXmlBytes: 0, svgBytes: 0, wallClockMs: 0,
  });

  const anyParseFailure = results.some(r => !r.parses);

  const payload = {
    benchmark: 'stieges-bench-v1',
    version: 1,
    generatedAt: new Date().toISOString(),
    gitCommit: gitHead(),
    fixturesDir: 'tests/fixtures',
    fixtureCount: results.length,
    anyParseFailure,
    totals,
    results,
  };

  writeFileSync(outJson, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  writeFileSync(outMd, renderMarkdown(payload), 'utf8');

  process.stderr.write(`\n[bench] wrote ${outJson}\n[bench] wrote ${outMd}\n`);
  process.exit(anyParseFailure ? 1 : 0);
}

main().catch(err => {
  console.error('[bench] fatal:', err && err.stack ? err.stack : err);
  process.exit(2);
});
