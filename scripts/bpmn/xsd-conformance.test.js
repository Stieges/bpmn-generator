import { describe, test, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bpmnXsdStatus, xsdDir } from '../../.github/scripts/fetch-bpmn-xsd.mjs';
import { runPipeline } from './pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const FIXTURES = join(ROOT, 'tests/fixtures');
const FIXTURES_V2 = join(ROOT, 'tests/fixtures-v2');
const VIEW = join(ROOT, 'views/explicit-joins-view.json');
const FIX_HINT = 'node .github/scripts/fetch-bpmn-xsd.mjs';
const BATCH = 50;
// Floors for the corpus, so it cannot shrink silently (a fixture that stopped generating is
// skipped, not failed). Currently 54 generated (plain and explicit-joins) + 14 committed in
// tests/fixtures (.expected.bpmn, .refined.bpmn) + 2 committed in
// tests/fixtures-v2 = 70. To update after adding fixtures: raise a floor
// to the new count of that folder (temporarily set a floor too high: the failure message shows the real count).
// Never lower a floor to make a run pass.
const MIN_GENERATED = 54;
const MIN_COMMITTED_FIXTURES = 14;
const MIN_COMMITTED_FIXTURES_V2 = 2;

const status = bpmnXsdStatus();

/** Files of `dir` (absolute) whose name ends in one of `suffixes`; a missing dir yields none. */
function committed(dir, suffixes) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => suffixes.some((s) => f.endsWith(s)))
    .sort()
    .map((f) => join(dir, f));
}

/** Every file to validate, written into `out`: generated XML (no view / explicit-joins) and committed XML. */
async function buildCorpus(out) {
  const files = [];
  for (const path of committed(FIXTURES, ['.json'])) {
    const name = path.slice(FIXTURES.length + 1, -'.json'.length);
    const model = JSON.parse(readFileSync(path, 'utf8'));
    for (const [label, opts] of [['plain', {}], ['joins', { view: VIEW }]]) {
      let bpmnXml;
      try {
        ({ bpmnXml } = await runPipeline(JSON.parse(JSON.stringify(model)), opts));
      } catch {
        continue; // models that do not generate (invalid on purpose) are not part of the corpus
      }
      if (!bpmnXml) continue;
      const file = join(out, `${name}.${label}.bpmn`);
      writeFileSync(file, bpmnXml);
      files.push(file);
    }
  }
  files.push(...committed(FIXTURES, ['.expected.bpmn', '.refined.bpmn']));
  files.push(...committed(FIXTURES_V2, ['.expected.bpmn']));
  return files;
}

function validateBatch(files) {
  try {
    execFileSync('xmllint', ['--noout', '--schema', join(xsdDir(), 'BPMN20.xsd'), ...files], { encoding: 'utf8', stdio: 'pipe' });
    return [];
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    const lines = out.split('\n').filter((l) => l.trim());
    const failed = lines.filter((l) => l.includes('fails to validate')).map((l) => l.replace(/ fails to validate.*$/, ''));
    // Besides the failing files: every other error line (parser errors, files xmllint could not load). Per-file detail
    // of a listed file and the "validates" lines are left out.
    const other = lines.filter((l) => !l.includes('fails to validate') && !l.includes('Schemas validity error') && !/ validates$/.test(l));
    const found = [...failed, ...other.map((l) => `xmllint: ${l}`)];
    return found.length ? found : [`xmllint error: ${out.slice(0, 500) || e.message}`];
  }
}

if (status.mismatch) {
  describe('BPMN XSD conformance', () => {
    test('BPMN XSD files carry the pinned SHA-256', () => {
      throw new Error(`BPMN XSD file has the wrong SHA-256 — run ${FIX_HINT} to replace it (${status.reason})`);
    });
  });
} else if (!status.available && process.env.CI) {
  describe('BPMN XSD conformance', () => {
    test('BPMN XSD files and xmllint are present in CI', () => {
      throw new Error(`BPMN XSD files or xmllint missing in CI — run ${FIX_HINT} (${status.reason})`);
    });
  });
} else if (!status.available) {
  const text = `skipped: xmllint or BPMN XSD missing (${FIX_HINT})`;
  console.warn(`BPMN XSD conformance ${text}: ${status.reason}`);
  describe.skip(`BPMN XSD conformance — ${text}`, () => {
    test('generated and committed BPMN XML validates against BPMN20.xsd', () => {});
  });
} else {
  describe('BPMN XSD conformance', () => {
    test('validateBatch reports files that fail and any other xmllint error line', () => {
      const dir = mkdtempSync(join(tmpdir(), 'bpmn-xsd-batch-'));
      try {
        const broken = join(dir, 'broken.bpmn');
        const invalid = join(dir, 'invalid.bpmn');
        writeFileSync(broken, '<a');
        writeFileSync(invalid, '<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><x/></definitions>');
        const result = validateBatch([broken, invalid]);
        expect(result).toContain(invalid);
        expect(result.some((l) => l.includes(`${broken}:`) && l.includes('parser error'))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('generated and committed BPMN XML validates against BPMN20.xsd', async () => {
      const out = mkdtempSync(join(tmpdir(), 'bpmn-xsd-'));
      try {
        const files = await buildCorpus(out);
        const generated = files.filter((f) => f.startsWith(out)).length;
        const inDir = (dir) => files.filter((f) => f.startsWith(`${dir}/`)).length;
        const counts = { generated, fixtures: inDir(FIXTURES), fixturesV2: inDir(FIXTURES_V2) };
        expect(counts.generated).toBeGreaterThanOrEqual(MIN_GENERATED);
        expect(counts.fixtures).toBeGreaterThanOrEqual(MIN_COMMITTED_FIXTURES);
        expect(counts.fixturesV2).toBeGreaterThanOrEqual(MIN_COMMITTED_FIXTURES_V2);
        const failed = [];
        for (let i = 0; i < files.length; i += BATCH) failed.push(...validateBatch(files.slice(i, i + BATCH)));
        expect({ checked: files.length, failed }).toEqual({ checked: files.length, failed: [] });
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    }, 180000);
  });
}
