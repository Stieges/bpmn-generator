/**
 * Phase F — tests for the scenario-enumeration orchestrator + CLI.
 *
 * Verification items 1-5 from the task brief map onto the `describe` blocks below in order.
 * Shape for the CLI (spawned) and the missing-file/malformed-JSON tests is copied from
 * `scripts/dmn/pipeline.test.js`'s equivalent tests.
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runScenarioPipeline } from './pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../tests/fixtures', `${name}.json`), 'utf8'));

/** Minimal Decision-Core document with one decision + a trivial, gap-free, overlap-free
 * table — same shape as bridge.test.js's inline `decisionCore` helper. */
const ratingDecisionCore = () => ({
  id: 'Definitions_rating',
  name: 'Definitions_rating',
  namespace: 'http://bpmn-generator.local/dmn/Definitions_rating',
  nodes: [
    {
      id: 'RatingDecision',
      type: 'decision',
      name: 'RatingDecision',
      variable: 'result',
      typeRef: 'string',
      decisionTable: {
        id: 'table_RatingDecision',
        hitPolicy: 'UNIQUE',
        inputs: [{ id: 'in_1', label: 'x', expression: 'x', typeRef: 'string' }],
        outputs: [{ id: 'out_1', name: 'result', typeRef: 'string' }],
        rules: [{ id: 'r1', when: ['-'], then: ['"ok"'] }],
      },
    },
  ],
});

describe('runScenarioPipeline — end-to-end, single process', () => {
  test('simple-approval.json: 2 scenarios, no findings (gateway fully covered, no decisionRef)', async () => {
    const lc = fixture('simple-approval');
    const result = runScenarioPipeline(lc);
    expect(result.formatted.json.scenarios).toHaveLength(2);
    expect(result.enumerationResult.scenarios).toHaveLength(2);
    expect(result.issues).toEqual([]);
    expect(result.skippedTableAnalyses).toBe(0);
    expect(result.bridgeResult.occurrences).toEqual([]);
    expect(result.tableAnalyses.size).toBe(0);
  });
});

describe('runScenarioPipeline — resolvable decisionRef', () => {
  test('subprocess-child-fidelity.json + a matching RatingDecision table: bridge resolves, ' +
    'table gets analyzed, no SC04/SC05 findings (the table has neither gap nor overlap)', async () => {
    const lc = fixture('subprocess-child-fidelity');
    const dc = ratingDecisionCore();
    const result = runScenarioPipeline(lc, [dc]);

    expect(result.bridgeResult.resolved).toHaveLength(1);
    expect(result.bridgeResult.resolved[0].occurrence.nodeId).toBe('c_rule');
    expect(result.bridgeResult.resolved[0].decision.decisionId).toBe('RatingDecision');
    expect(result.bridgeResult.unresolved).toEqual([]);
    expect(result.tableAnalyses.size).toBe(1);

    const sc04 = result.issues.filter((i) => i.rule === 'SC04');
    const sc05 = result.issues.filter((i) => i.rule === 'SC05');
    expect(sc04).toEqual([]);
    expect(sc05).toEqual([]);
    expect(result.skippedTableAnalyses).toBe(0);
  });
});

describe('runScenarioPipeline — decisions omitted, decisionRef present', () => {
  test('the pipeline still runs successfully; the decisionRef shows up as SC02, not a crash', async () => {
    const lc = fixture('subprocess-child-fidelity');
    const result = runScenarioPipeline(lc); // no decisionCores at all

    expect(result.bridgeResult.unresolved).toHaveLength(1);
    expect(result.bridgeResult.unresolved[0].occurrence.decisionRef).toBe('RatingDecision');
    const sc02 = result.issues.filter((i) => i.rule === 'SC02');
    expect(sc02).toHaveLength(1);
    expect(sc02[0].decisionRef).toBe('RatingDecision');
  });
});

describe('CLI (spawned) — main() wiring', () => {
  const runCli = async (lc, { args = [], stdin = false, decisionCoreFiles = null } = {}) => {
    const { spawnSync } = await import('node:child_process');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenarios-cli-'));
    const outBase = path.join(dir, 'out');
    const json = JSON.stringify(lc);
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
    if (decisionCoreFiles) {
      const paths = decisionCoreFiles.map((dc, i) => {
        const p = path.join(dir, `dc${i}.json`);
        fs.writeFileSync(p, JSON.stringify(dc), 'utf8');
        return p;
      });
      cliArgs.push('--decisions', paths.join(','));
    }
    const res = spawnSync('node', cliArgs, { cwd: __dirname, encoding: 'utf8', input });
    return {
      status: res.status,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      dir,
      outBase,
      jsonExists: fs.existsSync(`${outBase}.scenarios.json`),
      mdExists: fs.existsSync(`${outBase}.scenarios.md`),
    };
  };

  test('no positional argument → usage message on stderr, exit ≠ 0', async () => {
    const { spawnSync } = await import('node:child_process');
    const res = spawnSync('node', ['pipeline.js'], { cwd: __dirname, encoding: 'utf8' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/Usage: node pipeline\.js/);
  });

  test('happy path: simple-approval.json → exit 0, both output files written, 2 scenarios reported', async () => {
    const r = await runCli(fixture('simple-approval'));
    expect(r.status).toBe(0);
    expect(r.jsonExists).toBe(true);
    expect(r.mdExists).toBe(true);
    expect(r.stdout).toMatch(/Scenarios enumerated: 2/);
    const written = JSON.parse(readFileSync(`${r.outBase}.scenarios.json`, 'utf8'));
    expect(written.scenarios).toHaveLength(2);
    expect(written.issues).toEqual([]);
  });

  test("'-' reads Logic-Core from stdin → exit 0, both output files written", async () => {
    const r = await runCli(fixture('simple-approval'), { stdin: true });
    expect(r.status).toBe(0);
    expect(r.jsonExists).toBe(true);
    expect(r.mdExists).toBe(true);
  });

  test('--decisions resolves a matching table, no SC04/SC05 in the printed findings', async () => {
    const r = await runCli(fixture('subprocess-child-fidelity'), {
      decisionCoreFiles: [ratingDecisionCore()],
    });
    expect(r.status).toBe(0);
    expect(r.jsonExists).toBe(true);
    expect(r.stderr).not.toMatch(/SC04|SC05/);
    const written = JSON.parse(readFileSync(`${r.outBase}.scenarios.json`, 'utf8'));
    expect(written.issues.filter((i) => i.rule === 'SC04' || i.rule === 'SC05')).toEqual([]);
  });

  test('--decisions omitted, decisionRef present → exit 0 (not an error), SC02 printed as a warning, files written', async () => {
    const r = await runCli(fixture('subprocess-child-fidelity'));
    expect(r.status).toBe(0);
    expect(r.jsonExists).toBe(true);
    expect(r.mdExists).toBe(true);
    expect(r.stderr).toMatch(/⚠ Findings/);
    expect(r.stderr).toMatch(/\[SC02\]/);
  });

  test('--strict aborts on a finding (unresolved decisionRef) → exit ≠ 0, finding printed, NO files written', async () => {
    const r = await runCli(fixture('subprocess-child-fidelity'), { args: ['--strict'] });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--strict/);
    expect(r.stderr).toMatch(/\[SC02\]/);
    expect(r.jsonExists).toBe(false);
    expect(r.mdExists).toBe(false);
  });

  test('the SAME case WITHOUT --strict DOES write files, with the finding printed as a warning only', async () => {
    const r = await runCli(fixture('subprocess-child-fidelity'));
    expect(r.status).toBe(0);
    expect(r.jsonExists).toBe(true);
    expect(r.mdExists).toBe(true);
    expect(r.stderr).toMatch(/⚠ Findings/);
  });

  // Shape mirrors scripts/dmn/pipeline.test.js's missing-file/malformed-JSON test pair.
  test('missing input file → exit ≠ 0, clean "✗ ..." on stderr, no stack trace frame from this file', async () => {
    const { spawnSync } = await import('node:child_process');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenarios-cli-missing-'));
    const missingPath = path.join(dir, 'does-not-exist.json');
    const outBase = path.join(dir, 'out');
    const res = spawnSync('node', ['pipeline.js', missingPath, outBase], { cwd: __dirname, encoding: 'utf8' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/✗ /);
    expect(res.stderr).not.toMatch(/at .*pipeline\.js:/);
    expect(fs.existsSync(`${outBase}.scenarios.json`)).toBe(false);
    expect(fs.existsSync(`${outBase}.scenarios.md`)).toBe(false);
  });

  test('malformed JSON input file → exit ≠ 0, clean "✗ ..." on stderr, no stack trace frame from this file', async () => {
    const { spawnSync } = await import('node:child_process');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenarios-cli-badjson-'));
    const inPath = path.join(dir, 'in.json');
    const outBase = path.join(dir, 'out');
    fs.writeFileSync(inPath, '{ this is not JSON', 'utf8');
    const res = spawnSync('node', ['pipeline.js', inPath, outBase], { cwd: __dirname, encoding: 'utf8' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/✗ /);
    expect(res.stderr).not.toMatch(/at .*pipeline\.js:/);
    expect(fs.existsSync(`${outBase}.scenarios.json`)).toBe(false);
    expect(fs.existsSync(`${outBase}.scenarios.md`)).toBe(false);
  });

  test('malformed --decisions file path (nonexistent) → exit ≠ 0, clean "✗ ..." on stderr, no stack trace, no files written', async () => {
    const { spawnSync } = await import('node:child_process');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenarios-cli-baddecisions-'));
    const inPath = path.join(dir, 'in.json');
    const outBase = path.join(dir, 'out');
    fs.writeFileSync(inPath, JSON.stringify(fixture('simple-approval')), 'utf8');
    const missingDecisions = path.join(dir, 'does-not-exist-decisions.json');
    const res = spawnSync('node', ['pipeline.js', inPath, outBase, '--decisions', missingDecisions], { cwd: __dirname, encoding: 'utf8' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/✗ /);
    expect(res.stderr).not.toMatch(/at .*pipeline\.js:/);
    expect(fs.existsSync(`${outBase}.scenarios.json`)).toBe(false);
    expect(fs.existsSync(`${outBase}.scenarios.md`)).toBe(false);
  });
});
