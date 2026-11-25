#!/usr/bin/env node
/**
 * v2-output-hashes.mjs
 *
 * The two format 2.0 golden diagrams (design 9, slice 1): tests/fixtures-v2/schaden.json with its
 * catalogue, once in view `rollen` and once in view `einheiten`, generated with default options.
 * The fixtures live outside tests/fixtures/ so no folder-driven 1.x test reads them; their hashes
 * live in tests/bench/v2-output-hashes.json, apart from default-output-hashes.json. No more pairs
 * than these two.
 *
 * Rewrite the hash file and the four golden files: `node bench/v2-output-hashes.mjs` from `scripts/`.
 * Regenerate only when a change to the 2.0 output is intended, after inspecting the diff like a golden.
 * Fenced by v2-output-hashes.test.js.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../bpmn/pipeline.js';
import { loadCatalog } from '../shared/catalog.js';
import { loadNamedView } from '../shared/view.js';
import { isMainModule } from '../shared/entry-point.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_V2_DIR = join(__dirname, '..', '..', 'tests', 'fixtures-v2');
export const V2_SNAPSHOT_PATH = join(__dirname, '..', '..', 'tests', 'bench', 'v2-output-hashes.json');

export const V2_PAIRS = [['schaden.json', 'rollen'], ['schaden.json', 'einheiten']];

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Golden file basename (no extension) of a pair: `schaden.rollen`. */
export const goldenBase = (name, viewName) => `${name.replace(/\.json$/, '')}.${viewName}`;

/** One pair, generated with default options: `{ bpmnXml, svg, validation }`. */
export async function generateV2(name, viewName) {
  const model = JSON.parse(readFileSync(join(FIXTURES_V2_DIR, name), 'utf8'));
  const catalog = loadCatalog(join(FIXTURES_V2_DIR, model.catalog));
  const { bpmnXml, svg, validation } = await runPipeline(model, { catalog, view: loadNamedView(viewName) });
  return { bpmnXml, svg, validation };
}

/** { "<model> × <view>": { xml, svg } } for the two pairs. */
export async function computeV2Hashes() {
  const out = {};
  for (const [name, viewName] of V2_PAIRS) {
    const r = await generateV2(name, viewName);
    out[`${name} × ${viewName}`] = { xml: sha(r.bpmnXml), svg: sha(r.svg) };
  }
  return out;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  for (const [name, viewName] of V2_PAIRS) {
    const r = await generateV2(name, viewName);
    const base = join(FIXTURES_V2_DIR, goldenBase(name, viewName));
    writeFileSync(`${base}.expected.bpmn`, r.bpmnXml);
    writeFileSync(`${base}.expected.svg`, r.svg);
  }
  const h = await computeV2Hashes();
  writeFileSync(V2_SNAPSHOT_PATH, JSON.stringify(h, null, 2) + '\n');
  console.log(`${Object.keys(h).length} entries -> ${V2_SNAPSHOT_PATH}`);
}
