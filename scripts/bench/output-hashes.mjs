#!/usr/bin/env node
/**
 * output-hashes.mjs
 *
 * The "switch off => byte-identical" fence. For every top-level Logic-Core fixture in
 * tests/fixtures/ that lays out, and for each of four modes, the SHA-256 of the BPMN XML and of the
 * SVG, with every opt-in layout switch that changes geometry explicitly OFF (layout.bendRule,
 * layout.nodeLabelsAvoidFlows). The committed snapshot (tests/bench/default-output-hashes.json)
 * was generated at 9b5a597, before either switch existed, so a match proves the switches leave
 * the default output untouched — a comparison of two runs of the same code could not. The
 * example-* entries (fixtures added later) were generated the same way: at 9b5a597 with the fixture
 * files copied in, and found equal to HEAD's.
 *
 * Rewrite the snapshot: `node bench/output-hashes.mjs` from `scripts/`. Regenerate only when a
 * change to the default output is intended, after inspecting the diff like a golden.
 * Not part of the default output of any other tool; fenced by output-hashes.test.js.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../bpmn/pipeline.js';
import { isMainModule } from '../shared/entry-point.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', '..', 'tests', 'fixtures');
export const SNAPSHOT_PATH = join(__dirname, '..', '..', 'tests', 'bench', 'default-output-hashes.json');

export const FIXTURES = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort();

// The new switches are named explicitly: the fence must keep meaning "off" if a default ever flips.
const OFF = { bendRule: false, nodeLabelsAvoidFlows: false };
export const MODES = {
  default: {},
  'no-refine': { visualRefinement: false },
  refine: { visualRefinement: true },
  'refine+wrap': { visualRefinement: true, elkWrapping: 'auto' },
};

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** { "<fixture> × <mode>": { xml, svg } } for every fixture that lays out. */
export async function computeHashes() {
  const out = {};
  for (const name of FIXTURES) {
    const raw = readFileSync(join(fixturesDir, name), 'utf8');
    for (const [mode, opts] of Object.entries(MODES)) {
      const r = await runPipeline(JSON.parse(raw), { ...opts, ...OFF });
      if (!r.coordMap) continue; // blocked on purpose (deadlock-process)
      out[`${name} × ${mode}`] = { xml: sha(r.bpmnXml), svg: sha(r.svg) };
    }
  }
  return out;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const h = await computeHashes();
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(h, null, 2) + '\n');
  console.log(`${Object.keys(h).length} entries -> ${SNAPSHOT_PATH}`);
}
