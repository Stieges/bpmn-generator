import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDmnPipeline } from './pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../../tests/fixtures/dmn');
const loadFixture = (name) => JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));
const good = () => loadFixture('discount-decision.json');

describe('runDmnPipeline — schema gate', () => {
  test('a Decision-Core document missing the required namespace is blocked before rules run', async () => {
    const dc = good();
    delete dc.namespace;
    const result = await runDmnPipeline(dc);
    expect(result.xml).toBeNull();
    expect(result.diagrams).toBeNull();
    expect(result.diagnostics).toBeNull();
    expect(result.validation.errors.length).toBeGreaterThan(0);
    expect(result.validation.errors.join(' ')).toMatch(/namespace/);
  });

  test('a Decision-Core document with an empty namespace is blocked before rules run', async () => {
    const dc = good();
    dc.namespace = '';
    const result = await runDmnPipeline(dc);
    expect(result.xml).toBeNull();
    expect(result.diagrams).toBeNull();
    expect(result.diagnostics).toBeNull();
    expect(result.validation.errors.length).toBeGreaterThan(0);
    expect(result.validation.errors.join(' ')).toMatch(/namespace/);
  });
});

describe('runDmnPipeline — rule engine gate', () => {
  test('a cyclic requirement graph is blocked after the schema gate, before layout', async () => {
    const dc = good();
    dc.requirements.push({ id: 'ir_cycle', type: 'information', source: 'dec_finalPercentage', target: 'dec_discountLevel' });
    const result = await runDmnPipeline(dc);
    expect(result.xml).toBeNull();
    expect(result.diagrams).toBeNull();
    expect(result.validation.errors.join(' ')).toMatch(/cycle/);
  });
});

describe('runDmnPipeline — success path', () => {
  test('the reference fixture produces xml, a diagram list and a clean diagnostics pass', async () => {
    const result = await runDmnPipeline(good());
    expect(typeof result.xml).toBe('string');
    expect(result.xml).toContain('<?xml');
    expect(Array.isArray(result.diagrams)).toBe(true);
    expect(result.diagrams.length).toBeGreaterThan(0);
    expect(result.validation.errors).toEqual([]);
    expect(result.validation.xmlWarnings).toEqual([]);
    expect(result.diagnostics.ok).toBe(true);
    expect(result.diagnostics.issues).toEqual([]);
  });

  test('best-practice mode surfaces B-layer warnings the default semantic mode does not', async () => {
    const dc = good();
    delete dc.nodes.find((n) => n.id === 'dec_discountLevel').question;
    const semantic = await runDmnPipeline(dc, { mode: 'semantic' });
    const bestPractice = await runDmnPipeline(dc, { mode: 'best-practice' });
    expect(semantic.validation.warnings.some((w) => w.startsWith('[B03]'))).toBe(false);
    expect(bestPractice.validation.warnings.some((w) => w.startsWith('[B03]'))).toBe(true);
  });
});

describe('runDmnPipeline — degenerate inputs', () => {
  test('a single isolated inputData node (no requirements) still produces valid xml', async () => {
    const dc = { namespace: 'http://x/isolated', nodes: [{ id: 'lonely', type: 'inputData', name: 'Lonely', typeRef: 'string' }] };
    const result = await runDmnPipeline(dc);
    expect(typeof result.xml).toBe('string');
    expect(result.diagnostics.ok).toBe(true);
  });

  test('zero nodes is rejected by the schema gate (nodes has minItems: 1), never reaches layout', async () => {
    const dc = { namespace: 'http://x/empty', nodes: [] };
    const result = await runDmnPipeline(dc);
    expect(result.xml).toBeNull();
    expect(result.diagrams).toBeNull();
  });
});

describe('runDmnPipeline — serialisation error surfaces as a structured result', () => {
  test('an illegal information-requirement source that only reaches the writer because D03 is OFF ' +
    'surfaces as xml: null with diagrams/diagnostics still populated, not an unhandled rejection', async () => {
    const dc = good();
    // ks_discountPolicy is a knowledgeSource; DMN 1.3 §6.2.3 Table 2 forbids a knowledgeSource as
    // the source of an 'information' requirement (only 'authority' requirements may point at one).
    // D03 would normally catch this before layout — disable it via ruleProfile to reach dmn-xml.js.
    dc.requirements.push({ id: 'ir_illegal', type: 'information', source: 'ks_discountPolicy', target: 'dec_discountLevel' });
    const result = await runDmnPipeline(dc, { ruleProfile: { overrides: { D03: { severity: 'OFF' } } } });
    expect(result.xml).toBeNull();
    // Unlike the schema-gate and rule-engine early returns above, layout/coordinates/di-check DID
    // run and produced real values — those must survive, not collapse into null alongside xml.
    expect(Array.isArray(result.diagrams)).toBe(true);
    expect(result.diagrams.length).toBeGreaterThan(0);
    expect(result.diagnostics).not.toBeNull();
    expect(result.diagnostics.ok).toBe(true);
    expect(result.validation.errors.length).toBeGreaterThan(0);
    expect(result.validation.errors.join(' ')).toMatch(/\[serialisation\]/);
    expect(result.validation.errors.join(' ')).toMatch(/knowledgeSource/);
  });
});

describe('DMN Golden-File Regression', () => {
  test('discount-decision.json: xml matches golden file byte-for-byte', async () => {
    const result = await runDmnPipeline(good());
    let expected;
    try {
      expected = readFileSync(resolve(fixturesDir, 'discount-decision.expected.dmn'), 'utf8');
    } catch {
      throw new Error('Golden file missing: tests/fixtures/dmn/discount-decision.expected.dmn — run the golden generation step in Task 6, Step 9 first');
    }
    expect(result.xml).toBe(expected);
  });
});

describe('CLI (spawned) — main() wiring', () => {
  // Spawns the real CLI to verify main(): flag parsing, exit codes, the '-' stdin path and
  // writeFileSync — none of this was exercised before. Shape copied from
  // scripts/bpmn/pipeline.test.js:2562-2582 (fs.mkdtempSync, spawnSync with cwd: __dirname,
  // assertions on status/stderr/existsSync, no cleanup).
  const runCli = async (dc, { args = [], stdin = false } = {}) => {
    const { spawnSync } = await import('node:child_process');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmn-cli-'));
    const outBase = path.join(dir, 'out');
    const json = JSON.stringify(dc);
    let cliArgs;
    let input;
    if (stdin) {
      cliArgs = ['pipeline.js', '-', outBase, ...args];
      input = json;
    } else {
      const inPath = path.join(dir, 'in.json');
      fs.writeFileSync(inPath, json, 'utf8');
      cliArgs = ['pipeline.js', inPath, outBase, ...args];
    }
    const res = spawnSync('node', cliArgs, { cwd: __dirname, encoding: 'utf8', input });
    return {
      status: res.status,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      dmnExists: fs.existsSync(`${outBase}.dmn`),
    };
  };

  const missingQuestion = () => {
    const dc = good();
    delete dc.nodes.find((n) => n.id === 'dec_discountLevel').question; // B03 trigger, per pipeline.test.js:61-68
    return dc;
  };

  test('no positional argument → usage message on stderr, exit ≠ 0', async () => {
    const { spawnSync } = await import('node:child_process');
    const res = spawnSync('node', ['pipeline.js'], { cwd: __dirname, encoding: 'utf8' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/Usage: node pipeline\.js/);
  });

  test('happy path: valid Decision-Core file → exit 0, .dmn written', async () => {
    const r = await runCli(good());
    expect(r.status).toBe(0);
    expect(r.dmnExists).toBe(true);
    expect(r.stdout).toMatch(/DMN 1\.3 XML/);
  });

  test("'-' reads Decision-Core from stdin → exit 0, .dmn written", async () => {
    const r = await runCli(good(), { stdin: true });
    expect(r.status).toBe(0);
    expect(r.dmnExists).toBe(true);
  });

  test('schema-gate blocks a Decision-Core missing the required namespace → exit ≠ 0, no file, stderr names it', async () => {
    const dc = good();
    delete dc.namespace;
    const r = await runCli(dc);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/\[schema\]/);
    expect(r.dmnExists).toBe(false);
  });

  test('--strict aborts on a B03 (best_practice) warning — channel 1 (validation.warnings) only', async () => {
    // Channel 2 (diagnostics.issues) is structurally unreachable today: di-check.js classifies
    // every DD finding as 'ERROR', there is no WARNING-severity DD code yet (pipeline.js:115-129).
    // Channel 3 (validation.xmlWarnings) has no known trigger in this codebase; this test does not
    // attempt to force either — only channel 1 is asserted.
    const r = await runCli(missingQuestion(), { args: ['--strict', '--best-practice'] });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--strict/);
    expect(r.stderr).toMatch(/\[B03\]/);
    expect(r.dmnExists).toBe(false);
  });

  test("'--best-practice' spelling enables the best_practice layer (B03 warning surfaces, non-fatal without --strict)", async () => {
    const r = await runCli(missingQuestion(), { args: ['--best-practice'] });
    expect(r.status).toBe(0);
    expect(r.dmnExists).toBe(true);
    expect(r.stderr).toMatch(/\[B03\]/);
  });

  test("'--mode=best-practice' spelling also enables the best_practice layer (same effect, different flag)", async () => {
    const r = await runCli(missingQuestion(), { args: ['--mode=best-practice'] });
    expect(r.status).toBe(0);
    expect(r.dmnExists).toBe(true);
    expect(r.stderr).toMatch(/\[B03\]/);
  });

  // Shape mirrors scripts/bpmn/redesign.test.js:1864-1896 — missing/malformed input used to
  // throw a raw Node stack trace out of the unguarded readFileSync/JSON.parse; now both are
  // wrapped in a try/catch that reports a clean one-line '✗ ...' message and exits non-zero.
  test('missing input file → exit ≠ 0, clean "✗ ..." on stderr, no stack trace frame from this file', async () => {
    const { spawnSync } = await import('node:child_process');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmn-cli-missing-'));
    const missingPath = path.join(dir, 'does-not-exist.json');
    const outBase = path.join(dir, 'out');
    const res = spawnSync('node', ['pipeline.js', missingPath, outBase], { cwd: __dirname, encoding: 'utf8' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/✗ /);
    expect(res.stderr).not.toMatch(/at .*pipeline\.js:/);
    expect(fs.existsSync(`${outBase}.dmn`)).toBe(false);
  });

  test('malformed JSON input file → exit ≠ 0, clean "✗ ..." on stderr, no stack trace frame from this file', async () => {
    const { spawnSync } = await import('node:child_process');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmn-cli-badjson-'));
    const inPath = path.join(dir, 'in.json');
    const outBase = path.join(dir, 'out');
    fs.writeFileSync(inPath, '{ this is not JSON', 'utf8');
    const res = spawnSync('node', ['pipeline.js', inPath, outBase], { cwd: __dirname, encoding: 'utf8' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/✗ /);
    expect(res.stderr).not.toMatch(/at .*pipeline\.js:/);
    expect(fs.existsSync(`${outBase}.dmn`)).toBe(false);
  });
});

describe('runDmnPipeline — opts.ruleProfile', () => {
  test('an object profile changes the rule outcome vs. the mode default: layers.best_practice.enabled ' +
    'wins over the default semantic mode (rules.js dmnProfileForMode — an explicit profile is more ' +
    'specific than a mode)', async () => {
    const dc = good();
    delete dc.nodes.find((n) => n.id === 'dec_discountLevel').question;
    const withoutProfile = await runDmnPipeline(dc); // default mode 'semantic' → best_practice off
    const withProfile = await runDmnPipeline(dc, { ruleProfile: { layers: { best_practice: { enabled: true } } } });
    expect(withoutProfile.validation.warnings.some((w) => w.startsWith('[B03]'))).toBe(false);
    expect(withProfile.validation.warnings.some((w) => w.startsWith('[B03]'))).toBe(true);
  });

  test('a ruleProfile string path that does not resolve falls back to defaults without throwing — ' +
    'this documents the existing swallow in shared/rule-profile.js\'s loadRuleProfile (try/catch → ' +
    'null on any read/parse failure), not new behavior added by this commit', async () => {
    const result = await runDmnPipeline(good(), { ruleProfile: '/nonexistent/does-not-resolve/profile.json' });
    expect(result.xml).not.toBeNull();
    expect(result.validation.errors).toEqual([]);
  });
});
