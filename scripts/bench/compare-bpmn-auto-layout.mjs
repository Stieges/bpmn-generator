#!/usr/bin/env node
/**
 * compare-bpmn-auto-layout.mjs
 *
 * Runs three multi-pool / lane-heavy fixtures through both:
 *   (a) our pipeline (Logic-Core → BPMN with DI), and
 *   (b) bpmn-auto-layout (our BPMN sans DI → BPMN with DI from their algorithm)
 *
 * Then compares: does bpmn-auto-layout produce coherent multi-pool layouts,
 * or does it lose lanes / merge pools / break message flows? Output: a
 * markdown report at `tests/bench/auto-layout-comparison.md`.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../pipeline.js';
import { layoutProcess } from 'bpmn-auto-layout';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

// Three fixtures with progressively harder pool/lane structure
const FIXTURES = [
  'simple-approval.json',
  'multi-pool-collaboration.json',
  'sparse-lanes.json',
];

// Extract all id="..." values for elements matching a given tag-name regex.
// Tag-name regex must NOT include the leading '<' or the trailing '\s' — we add those.
function extractIds(xml, tagPattern) {
  const re = new RegExp(`<${tagPattern}\\b[^>]*\\bid="([^"]+)"`, 'g');
  const ids = new Set();
  let m;
  while ((m = re.exec(xml)) !== null) ids.add(m[1]);
  return ids;
}

// Counts that we'll compare. We separate semantic (bpmn:*) from DI (bpmndi:*)
// because bpmn-auto-layout adds DI but should preserve semantics 1:1.
//
// For DI counts we cross-reference: a "pool shape" is a <bpmndi:BPMNShape>
// whose bpmnElement matches the id of a semantic <bpmn:participant>.
function countShapes(xml) {
  const participantIds = extractIds(xml, 'bpmn:participant');
  const laneIds = extractIds(xml, 'bpmn:lane');
  const messageFlowIds = extractIds(xml, 'bpmn:messageFlow');
  const sequenceFlowIds = extractIds(xml, 'bpmn:sequenceFlow');

  const shapeBpmnElems = [];
  const edgeBpmnElems = [];
  const shapeRe = /<bpmndi:BPMNShape\b[^>]*\bbpmnElement="([^"]+)"/g;
  const edgeRe = /<bpmndi:BPMNEdge\b[^>]*\bbpmnElement="([^"]+)"/g;
  let m;
  while ((m = shapeRe.exec(xml)) !== null) shapeBpmnElems.push(m[1]);
  while ((m = edgeRe.exec(xml)) !== null) edgeBpmnElems.push(m[1]);

  return {
    // Semantic counts (should be identical between input and output)
    participants: participantIds.size,
    lanes: laneIds.size,
    messageFlows: messageFlowIds.size,
    sequenceFlows: sequenceFlowIds.size,
    // DI counts (the layout engine's actual output)
    poolShapes: shapeBpmnElems.filter((id) => participantIds.has(id)).length,
    laneShapes: shapeBpmnElems.filter((id) => laneIds.has(id)).length,
    messageFlowEdges: edgeBpmnElems.filter((id) => messageFlowIds.has(id)).length,
    sequenceFlowEdges: edgeBpmnElems.filter((id) => sequenceFlowIds.has(id)).length,
    shapes: (xml.match(/<bpmndi:BPMNShape\b/g) || []).length,
    edges: (xml.match(/<bpmndi:BPMNEdge\b/g) || []).length,
    waypoints: (xml.match(/<di:waypoint\b/g) || []).length,
  };
}

function stripDi(xml) {
  // Remove BPMNDiagram section so bpmn-auto-layout starts from scratch
  return xml.replace(/<bpmndi:BPMNDiagram[\s\S]*?<\/bpmndi:BPMNDiagram>/g, '');
}

async function runFixture(name) {
  const lcPath = join(repoRoot, 'tests', 'fixtures', name);
  const lc = JSON.parse(readFileSync(lcPath, 'utf8'));

  const ours = await runPipeline(lc);
  if (!ours.bpmnXml) {
    return {
      name,
      ourError: `Pipeline validation failed: ${JSON.stringify(ours.validation)}`,
      ourCounts: null,
      theirCounts: null,
      theirError: 'n/a (our pipeline failed first)',
    };
  }
  const ourCounts = countShapes(ours.bpmnXml);

  const stripped = stripDi(ours.bpmnXml);

  let theirs = null;
  let theirError = null;
  let theirCounts = null;
  try {
    theirs = await layoutProcess(stripped);
    theirCounts = countShapes(theirs);
  } catch (err) {
    theirError = err.message || String(err);
  }

  return {
    name,
    ourBpmn: ours.bpmnXml,
    theirBpmn: theirs,
    ourCounts,
    theirCounts,
    theirError,
    ourLength: ours.bpmnXml.length,
    theirLength: theirs?.length ?? null,
  };
}

function fmtCell(o, t, key) {
  if (!t) return `${o[key]} / —`;
  const ov = o[key];
  const tv = t[key];
  const marker = ov === tv ? '' : ' ⚠';
  return `${ov} / ${tv}${marker}`;
}

async function main() {
  const benchDir = join(repoRoot, 'tests', 'bench');
  mkdirSync(benchDir, { recursive: true });

  const results = [];
  for (const f of FIXTURES) {
    process.stderr.write(`Running ${f}...\n`);
    const r = await runFixture(f);
    results.push(r);
  }

  const balPkg = JSON.parse(
    readFileSync(
      join(repoRoot, 'scripts/node_modules/bpmn-auto-layout/package.json'),
      'utf8',
    ),
  );

  // Build markdown report
  const lines = [];
  lines.push('# BPMN Generator vs `bpmn-auto-layout` — Pools/Lanes Comparison');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`bpmn-auto-layout version: ${balPkg.version}`);
  lines.push('');
  lines.push('## Method');
  lines.push('');
  lines.push(
    'For each fixture: generate BPMN with our pipeline, strip the `<bpmndi:BPMNDiagram>` section, feed the semantic-only XML to `bpmn-auto-layout.layoutProcess()`, and compare element counts. The hypothesis is that `bpmn-auto-layout` either errors out, silently drops semantic elements, or omits DI for pools/lanes/message-flows in multi-pool scenarios.',
  );
  lines.push('');
  lines.push('## Semantic Preservation');
  lines.push('');
  lines.push('Counts of `<bpmn:*>` elements before/after. These should be identical — a layout engine is not supposed to delete semantic elements. Mismatches are marked with ⚠.');
  lines.push('');
  lines.push('| Fixture | Participants (ours / theirs) | Lanes (ours / theirs) | MsgFlows (ours / theirs) | SeqFlows (ours / theirs) | Their error |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of results) {
    if (!r.ourCounts) {
      lines.push(`| ${r.name} | — | — | — | — | ${r.ourError} |`);
      continue;
    }
    const o = r.ourCounts;
    const t = r.theirCounts;
    lines.push(
      `| ${r.name} | ${fmtCell(o, t, 'participants')} | ${fmtCell(o, t, 'lanes')} | ${fmtCell(o, t, 'messageFlows')} | ${fmtCell(o, t, 'sequenceFlows')} | ${r.theirError ?? '—'} |`,
    );
  }
  lines.push('');
  lines.push('## DI Output');
  lines.push('');
  lines.push('Counts of `<bpmndi:*>` elements — what the layout engine actually drew. Missing pool/lane shapes or message-flow edges in "theirs" means the layout engine refused to draw them.');
  lines.push('');
  lines.push('| Fixture | Pool shapes (ours / theirs) | Lane shapes (ours / theirs) | MsgFlow edges (ours / theirs) | SeqFlow edges (ours / theirs) | Total shapes (ours / theirs) | Total edges (ours / theirs) |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of results) {
    if (!r.ourCounts) {
      lines.push(`| ${r.name} | — | — | — | — | — | — |`);
      continue;
    }
    const o = r.ourCounts;
    const t = r.theirCounts;
    lines.push(
      `| ${r.name} | ${fmtCell(o, t, 'poolShapes')} | ${fmtCell(o, t, 'laneShapes')} | ${fmtCell(o, t, 'messageFlowEdges')} | ${fmtCell(o, t, 'sequenceFlowEdges')} | ${fmtCell(o, t, 'shapes')} | ${fmtCell(o, t, 'edges')} |`,
    );
  }
  lines.push('');
  lines.push('## Interpretation');
  lines.push('');
  lines.push('- **Semantic mismatch** (⚠ in first table): the layout engine dropped semantic elements — a serious data loss.');
  lines.push('- **DI mismatch** (⚠ in second table): the layout engine refused to draw elements (typically pools beyond the first, or message flows). The BPMN file is still semantically valid but visually incomplete; rendering tools may show errors or invisible elements.');
  lines.push('- **"Their error"**: outright rejection of the input.');
  lines.push('');
  lines.push('Per the upstream README (`node_modules/bpmn-auto-layout/README.md`):');
  lines.push('');
  lines.push('> * Given a collaboration only the first participant\'s process will be laid out');
  lines.push('> * Sub-processes will be laid out as collapsed sub-processes');
  lines.push('> * The following elements are not laid out:');
  lines.push('>   * Groups');
  lines.push('>   * Text annotations');
  lines.push('>   * Associations');
  lines.push('>   * Message flows');
  lines.push('');
  lines.push('## Per-fixture artifacts');
  lines.push('');
  for (const r of results) {
    if (!r.theirBpmn) continue;
    const base = r.name.replace('.json', '');
    lines.push(`- \`${base}.ours.bpmn\` — our pipeline output`);
    lines.push(`- \`${base}.theirs.bpmn\` — bpmn-auto-layout output`);
  }
  lines.push('');

  const reportPath = join(benchDir, 'auto-layout-comparison.md');
  writeFileSync(reportPath, lines.join('\n'));
  process.stderr.write(`\nReport: ${reportPath}\n`);

  // Dump per-fixture artifacts for follow-up manual inspection
  for (const r of results) {
    if (!r.ourBpmn) continue;
    const base = r.name.replace('.json', '');
    writeFileSync(join(benchDir, `${base}.ours.bpmn`), r.ourBpmn);
    if (r.theirBpmn) {
      writeFileSync(join(benchDir, `${base}.theirs.bpmn`), r.theirBpmn);
    }
  }

  // Exit-status summary
  let semanticMismatch = false;
  let diMismatch = false;
  let errored = false;
  for (const r of results) {
    if (!r.ourCounts) continue;
    if (r.theirError) {
      errored = true;
      continue;
    }
    const o = r.ourCounts;
    const t = r.theirCounts;
    if (o.participants !== t.participants || o.lanes !== t.lanes || o.messageFlows !== t.messageFlows) {
      semanticMismatch = true;
    }
    if (o.poolShapes !== t.poolShapes || o.laneShapes !== t.laneShapes || o.messageFlowEdges !== t.messageFlowEdges) {
      diMismatch = true;
    }
  }

  process.stderr.write('\nSummary:\n');
  process.stderr.write(`  semantic mismatch: ${semanticMismatch}\n`);
  process.stderr.write(`  DI mismatch: ${diMismatch}\n`);
  process.stderr.write(`  errored: ${errored}\n`);
  if (semanticMismatch || diMismatch || errored) {
    process.stderr.write('  → differentiation claim is empirically supported.\n');
  } else {
    process.stderr.write('  → all fixtures handled equivalently; claim needs softening.\n');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
