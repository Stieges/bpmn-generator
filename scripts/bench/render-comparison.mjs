#!/usr/bin/env node
/**
 * render-comparison.mjs
 *
 * Side-by-side visualization of OUR pipeline output vs bpmn-auto-layout's
 * output for the same Logic-Core fixture. Outputs HTML files at
 * `tests/bench/comparison-<fixture>.html`.
 *
 * Our side: re-run the pipeline and use the SVG directly.
 * Their side: parse their BPMN-DI (BPMNShape Bounds + BPMNEdge waypoints)
 * and render a minimal SVG so we can visually compare what they DRAW
 * (not just what they preserve semantically).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const benchDir = join(repoRoot, 'tests', 'bench');

const FIXTURES = [
  'simple-approval.json',
  'multi-pool-collaboration.json',
  'sparse-lanes.json',
];

// ── Minimal DI → SVG renderer for the OTHER tool's output ────────────────
function renderTheirsAsSvg(bpmnXml) {
  // Parse BPMNShape: bpmnElement="X" -> { id, x, y, w, h }
  const shapes = [];
  const shapeRe = /<bpmndi:BPMNShape[^>]*bpmnElement="([^"]+)"[\s\S]*?<dc:Bounds\s+x="([^"]+)"\s+y="([^"]+)"\s+width="([^"]+)"\s+height="([^"]+)"/g;
  let m;
  while ((m = shapeRe.exec(bpmnXml)) !== null) {
    shapes.push({ id: m[1], x: +m[2], y: +m[3], w: +m[4], h: +m[5] });
  }

  // Parse BPMNEdge -> array of waypoints
  const edges = [];
  const edgeRe = /<bpmndi:BPMNEdge[^>]*bpmnElement="([^"]+)"[\s\S]*?<\/bpmndi:BPMNEdge>/g;
  while ((m = edgeRe.exec(bpmnXml)) !== null) {
    const block = m[0];
    const pts = [...block.matchAll(/<di:waypoint\s+x="([^"]+)"\s+y="([^"]+)"/g)]
      .map(w => ({ x: +w[1], y: +w[2] }));
    edges.push({ id: m[1], pts });
  }

  // Lookup semantic element labels (name attr)
  const nameByEl = {};
  for (const elMatch of bpmnXml.matchAll(/<bpmn:(\w+)[^>]*\bid="([^"]+)"[^>]*\bname="([^"]+)"/g)) {
    nameByEl[elMatch[2]] = elMatch[3];
  }
  // Also catch types so we can color events differently
  const typeByEl = {};
  for (const elMatch of bpmnXml.matchAll(/<bpmn:(\w+)[^>]*\bid="([^"]+)"/g)) {
    typeByEl[elMatch[2]] = elMatch[1];
  }

  // Compute viewBox
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes) {
    minX = Math.min(minX, s.x); minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x + s.w); maxY = Math.max(maxY, s.y + s.h);
  }
  for (const e of edges) for (const p of e.pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }
  const pad = 20;
  const vbX = minX - pad, vbY = minY - pad;
  const vbW = (maxX - minX) + 2 * pad, vbH = (maxY - minY) + 2 * pad;

  const shapeColor = (type) => {
    if (!type) return '#fff';
    if (/event/i.test(type)) return '#fff3c4';
    if (/gateway/i.test(type)) return '#fae0a3';
    if (/participant|pool/i.test(type)) return '#dde7ff';
    if (/lane/i.test(type)) return '#eef3ff';
    return '#e6f2e6'; // tasks
  };
  const isEvent = (type) => /event/i.test(type || '');
  const isGateway = (type) => /gateway/i.test(type || '');

  let svgBody = '';
  for (const s of shapes) {
    const type = typeByEl[s.id] || '';
    const fill = shapeColor(type);
    const name = nameByEl[s.id] || s.id;
    if (isEvent(type)) {
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      svgBody += `<circle cx="${cx}" cy="${cy}" r="${s.w/2}" fill="${fill}" stroke="#333" stroke-width="2"/>`;
      svgBody += `<text x="${cx}" y="${s.y + s.h + 12}" text-anchor="middle" font-size="10" fill="#222">${escapeXml(name)}</text>`;
    } else if (isGateway(type)) {
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      const r = s.w / 2;
      svgBody += `<polygon points="${cx},${cy-r} ${cx+r},${cy} ${cx},${cy+r} ${cx-r},${cy}" fill="${fill}" stroke="#333" stroke-width="2"/>`;
      svgBody += `<text x="${cx}" y="${s.y + s.h + 12}" text-anchor="middle" font-size="10" fill="#222">${escapeXml(name)}</text>`;
    } else {
      svgBody += `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="6" fill="${fill}" stroke="#333" stroke-width="1.5"/>`;
      svgBody += `<text x="${s.x + s.w / 2}" y="${s.y + s.h / 2 + 4}" text-anchor="middle" font-size="11" fill="#222">${escapeXml(name)}</text>`;
    }
  }
  for (const e of edges) {
    if (e.pts.length < 2) continue;
    const d = e.pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    svgBody += `<path d="${d}" fill="none" stroke="#444" stroke-width="1.5" marker-end="url(#arr)"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" style="background:#fff;max-width:100%;height:auto;">
    <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#444"/></marker></defs>
    ${svgBody}
  </svg>`;
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function main() {
  const summaries = [];
  for (const f of FIXTURES) {
    process.stderr.write(`Rendering ${f}...\n`);
    const lcPath = join(repoRoot, 'tests', 'fixtures', f);
    const lc = JSON.parse(readFileSync(lcPath, 'utf8'));
    const ours = await runPipeline(lc);
    const theirsXml = readFileSync(join(benchDir, f.replace('.json', '.theirs.bpmn')), 'utf8');
    const theirsSvg = renderTheirsAsSvg(theirsXml);

    const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Comparison: ${f}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 24px; background: #f6f7f9; color: #222; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #666; font-size: 12px; margin: 0 0 24px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .panel { background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 12px; }
  .panel h2 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
  .panel.ours h2 { color: #2a6f3d; }
  .panel.theirs h2 { color: #a8443a; }
  .panel .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; margin-left: 8px; }
  .panel.ours .badge { background: #e7f5ec; color: #2a6f3d; }
  .panel.theirs .badge { background: #fdecea; color: #a8443a; }
  .panel svg { display: block; width: 100%; height: auto; }
  .legend { margin-top: 24px; font-size: 12px; color: #444; line-height: 1.6; }
  .legend code { background: #eee; padding: 1px 4px; border-radius: 3px; font-size: 11px; }
</style>
</head><body>
<h1>BPMN Generator vs <code>bpmn-auto-layout</code> — ${f}</h1>
<p class="meta">Same Logic-Core input, two different layout engines. Generated ${new Date().toISOString()}.</p>
<div class="grid">
  <div class="panel ours">
    <h2>Our pipeline <span class="badge">native</span></h2>
    ${ours.svg}
  </div>
  <div class="panel theirs">
    <h2>bpmn-auto-layout @1.3.0 <span class="badge">DI re-layout</span></h2>
    ${theirsSvg}
  </div>
</div>
<p class="legend">
  Both pipelines received the SAME semantic BPMN (we stripped the <code>&lt;bpmndi:BPMNDiagram&gt;</code> from our output before feeding to bpmn-auto-layout, so its layout engine starts from scratch).
  Differences in what's drawn are differences in their renderer, not in the source model.
  See <code>tests/bench/auto-layout-comparison.md</code> for element counts.
</p>
</body></html>`;

    const outPath = join(benchDir, `comparison-${f.replace('.json', '.html')}`);
    writeFileSync(outPath, html);
    summaries.push({ fixture: f, path: outPath });
  }

  console.log('\nGenerated:');
  for (const s of summaries) console.log(`  ${s.path}`);
}

main().catch(err => { console.error(err); process.exit(1); });
