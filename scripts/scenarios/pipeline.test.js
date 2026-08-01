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

// NOTE: simple-approval.json declares `"pools": [...]` (one pool) — this exercises the
// collaboration code path with a single participant, NOT the pool-less shape. See the
// "genuinely pool-less document" describe block below for a fixture with no `pools` key at
// all, which is the other input class `runScenarioPipeline` must handle.
describe('runScenarioPipeline — end-to-end, single pool', () => {
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

// A flat Logic-Core document with NO `pools` key at all — `nodes`/`edges` directly at the top
// level, the "legacy flat single-process" shape `input-schema.json` also accepts. Confirms
// `runScenarioPipeline` runs this class of input end-to-end through the SAME composed
// (`enumerateCollaboration`/`formatCollaborationResult`) path as a pooled document — see the
// "Why always the collaboration pair" section in pipeline.js's own doc comment for why there
// is no separate `enumerateScenarios`/`formatScenarioResult` branch to exercise here: this
// module intentionally never calls that pair.
describe('runScenarioPipeline — genuinely pool-less document (no `pools` key)', () => {
  const flatTwoEnds = () => ({
    id: 'Process_TwoEnds',
    nodes: [
      { id: 's', type: 'startEvent' }, { id: 'fork', type: 'parallelGateway' },
      { id: 'x', type: 'userTask' }, { id: 'y', type: 'userTask' },
      { id: 'e1', type: 'endEvent' }, { id: 'e2', type: 'endEvent' },
    ],
    edges: [
      { id: 'a1', source: 's', target: 'fork' }, { id: 'a2', source: 'fork', target: 'x' },
      { id: 'a3', source: 'fork', target: 'y' }, { id: 'a4', source: 'x', target: 'e1' },
      { id: 'a5', source: 'y', target: 'e2' },
    ],
  });

  test('runs end-to-end and produces a CollaborationEnumerationResult (poolIds, sinkTokens present)', () => {
    const lc = flatTwoEnds();
    const result = runScenarioPipeline(lc);
    // poolIds/sinkTokens only exist on the composed (CollaborationEnumerationResult) shape —
    // their presence IS the assertion that the pool-less path was routed through
    // enumerateCollaboration, not the plain single-process enumerateScenarios.
    expect(result.enumerationResult.poolIds).toEqual(['Process_TwoEnds']);
    expect(result.enumerationResult.scenarios[0].sinkTokens).toBeDefined();
  });

  test('SC06 fires for a pool-less document with an AND fork to two end events (mirrors ' +
    "collaboration.test.js's own sinkTokens fixture, without the `pools` wrapper) — proof " +
    'that pool-less input keeps SC06 coverage after routing through the collaboration pair', () => {
    const lc = flatTwoEnds();
    const result = runScenarioPipeline(lc);
    expect(result.enumerationResult.scenarios[0].sinkTokens).toEqual({ Process_TwoEnds: 2 });
    const sc06 = result.issues.filter((i) => i.rule === 'SC06');
    expect(sc06).toHaveLength(1);
    expect(sc06[0].pools).toEqual(['Process_TwoEnds']);
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

  // ─────────────────────────────────────────────────────────────────────────────────────────
  // The whole-branch review's seam, end to end. Six individually-correct modules combined into
  // a CLI that reported "✓ Scenarios enumerated: 0" at exit 0 for a document where EVERY path
  // deadlocks, wrote a JSON file with `"scenarios": []` and no explanation, a three-line
  // Markdown file with no scenario count at all, and two SC01 findings blaming the upstream
  // gateway for a downstream stall. Each half was invisible to its own module's tests, which is
  // why the guard belongs here, at the seam, and not in format.test.js or rules.test.js.
  //
  // deadlock-process.json is purpose-built for it: an XOR split whose two branches both feed a
  // parallelGateway JOIN, which needs both tokens at once and can never get them. Both branches
  // ARE taken; both dead-end. checkWorkflowNetSoundness already reports WF03 on this fixture on
  // master, i.e. the deadlock is real and pre-existing, not something this subsystem created.
  // ─────────────────────────────────────────────────────────────────────────────────────────
  test('deadlock-process.json: total enumeration failure is reported, not silently passed off '
    + 'as an empty scenario list', async () => {
    const r = await runCli(fixture('deadlock-process'));

    // Still exit 0 and still writes files (no --strict): the run itself did not fail, it just
    // has nothing to show and says so. Matches the WARNING-tier convention of both sibling CLIs.
    expect(r.status).toBe(0);
    expect(r.jsonExists).toBe(true);
    expect(r.mdExists).toBe(true);

    // 1. stdout/stderr names the failure instead of only "✓ Scenarios enumerated: 0".
    expect(r.stdout).toMatch(/Scenarios enumerated: 0/);
    expect(r.stderr).toMatch(/⚠ Enumeration completeness/);
    expect(r.stderr).toMatch(/No scenario reached completion/);
    expect(r.stderr).toMatch(/2 path\(s\) dead-ended/);

    // 2. the written JSON carries the enumeration's own bookkeeping, not just an empty array.
    const written = JSON.parse(readFileSync(`${r.outBase}.scenarios.json`, 'utf8'));
    expect(written.scenarios).toEqual([]);
    expect(written.truncated).toBe(false);
    expect(written.stats.deadEndPaths).toBe(2);
    expect(written.stats.cappedPaths).toBe(0);
    expect(written.stats.lengthTruncatedPaths).toBe(0);

    // 3. the Markdown says it too — a human reading only that file must not be misled either.
    const md = readFileSync(`${r.outBase}.scenarios.md`, 'utf8');
    expect(md).toMatch(/## Enumeration summary/);
    expect(md).toMatch(/Scenarios enumerated: \*\*0\*\*/);
    expect(md).toMatch(/2 path\(s\) dead-ended/);

    // 4. and SC01 does NOT blame xor1 for a stall that lives at and1 — the misattribution class.
    //    xor1's branches f2/f3 are both taken; the parallelGateway JOIN is what cannot proceed.
    expect(written.issues).toEqual([]);
    expect(r.stderr).not.toMatch(/SC01/);
  });

  test('deadlock-process.json --strict: blocks on the completeness warnings alone, with no SC0x '
    + 'finding involved, and writes nothing', async () => {
    // The choice this fix round made explicit: --strict blocks on the completeness channel too,
    // not only on SC01-SC06. Otherwise a totally failed run would still pass --strict as long as
    // no rule happened to fire — exactly the seam. The message must show 0 findings, so the
    // reason for blocking cannot be confused with the old (misattributed) SC01 pair.
    const r = await runCli(fixture('deadlock-process'), { args: ['--strict'] });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/✗ --strict: 0 finding\(s\), 2 completeness warning\(s\)/);
    expect(r.jsonExists).toBe(false);
    expect(r.mdExists).toBe(false);
  });

  test('a healthy fixture prints no completeness warning and passes --strict — the guard is not '
    + 'simply always on', async () => {
    // parallel-split-join.json: 1 scenario, no dead ends, no caps, nothing skipped. Without this
    // the two tests above would pass just as well against a CLI that warned unconditionally.
    const r = await runCli(fixture('parallel-split-join'), { args: ['--strict'] });
    expect(r.status).toBe(0);
    expect(r.jsonExists).toBe(true);
    expect(r.stderr).not.toMatch(/⚠ Enumeration completeness/);
    const written = JSON.parse(readFileSync(`${r.outBase}.scenarios.json`, 'utf8'));
    expect(written.stats.deadEndPaths).toBe(0);
    expect(written.scenarios.length).toBeGreaterThan(0);
  });

  test('the non-blocking notes channel: simple-approval\'s cycle-bound suppression is printed as '
    + 'a 💡 note on stdout and does NOT block --strict', async () => {
    // The second tier. `cappedPaths` is the cycle bound working as configured, and enumerate.js's
    // own stats doc instructs consumers to keep it apart from deadEndPaths — so it is surfaced
    // (never hidden) but never treated as an unresolved warning.
    const r = await runCli(fixture('simple-approval'), { args: ['--strict'] });
    expect(r.status).toBe(0);
    expect(r.jsonExists).toBe(true);
    expect(r.stdout).toMatch(/💡 Enumeration notes/);
    expect(r.stdout).toMatch(/cycle bound \(1\)/);
    const written = JSON.parse(readFileSync(`${r.outBase}.scenarios.json`, 'utf8'));
    expect(written.stats.cappedPaths).toBe(1);
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

  test('trailing --decisions with no value → exit ≠ 0, clean "✗ ..." naming the flag, no files written', async () => {
    const { spawnSync } = await import('node:child_process');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenarios-cli-decisionsnoval-'));
    const inPath = path.join(dir, 'in.json');
    const outBase = path.join(dir, 'out');
    fs.writeFileSync(inPath, JSON.stringify(fixture('simple-approval')), 'utf8');
    // --decisions is the LAST argument — no value follows it.
    const res = spawnSync('node', ['pipeline.js', inPath, outBase, '--decisions'], { cwd: __dirname, encoding: 'utf8' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/✗ --decisions requires a value/);
    expect(fs.existsSync(`${outBase}.scenarios.json`)).toBe(false);
    expect(fs.existsSync(`${outBase}.scenarios.md`)).toBe(false);
  });
});
