/**
 * bpmnlint over the generator's output — the target is 0 errors and 0 warnings for anything the
 * generator decides. The linting runs in bench/bpmnlint-fixtures.mjs, in a child process: bpmnlint
 * require()s an ESM-only dependency, which Node loads and Jest's module runtime does not (see the
 * script's header for the config and the fresh-Linter-per-document rule).
 *
 * KNOWN is the whole exclusion list, compared exactly (a ratchet, like bench/layout-metrics): a
 * finding that appears fails, and so does one that disappears — remove it here in the same commit.
 * Each entry says why it is there: the fixture's model content (the generator writes what the
 * author modelled) or an open layout defect.
 */
import { describe, test, expect, beforeAll } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'bench', 'bpmnlint-fixtures.mjs');
const fixturesDir = join(here, '..', '..', 'tests', 'fixtures');
const FIXTURES = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort();

const run = (...args) => JSON.parse(execFileSync(process.execPath, [script, ...args],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));

const MODEL = 'model content';
const KNOWN = {
  'all-element-classes.json': {
    why: `${MODEL}: a pass-through gateway and a labelled flow out of a non-gateway, there to exercise every element class`,
    findings: ['warn superfluous-gateway g', 'warn superfluous-label f3'],
  },
  'boundary-event-shapes.json': {
    why: 'open layout defect #71: one sequence-flow crossing between boundary-event shapes',
    findings: ['warn @miragon/rules/flow-crossing f12', 'warn @miragon/rules/flow-crossing f4'],
  },
  'cross-lane-connection-sides.json': {
    why: `${MODEL}: the process has no name, so its participant has none`,
    findings: ['error label-required Participant_cross_lane_sides'],
  },
  'example-bestellung-versand.json': {
    why: 'open layout defect: the timer flow f111 is boxed in by the split\'s two branches — it crosses f114 and enters its target from the bottom',
    findings: ['warn @miragon/rules/flow-connection-side f111', 'warn @miragon/rules/flow-crossing f111', 'warn @miragon/rules/flow-crossing f114'],
  },
  'example-schadenmeldung.json': {
    why: `${MODEL}: a terminate end event where a plain end event would do`,
    findings: ['warn superfluous-termination sp_end'],
  },
  'subprocess-collapsed-children.json': {
    why: `${MODEL}: subprocess B has neither a start nor an end event`,
    findings: ['error end-event-required B', 'error no-implicit-end b_task2', 'error no-implicit-start b_task1', 'error start-event-required B'],
  },
  'subprocess-merge-fanout.json': {
    why: `${MODEL}: subprocess "batch" has two blank start events and splits without a gateway`,
    findings: ['error no-implicit-split batch', 'error single-blank-start-event batch'],
  },
};

describe('bpmnlint (recommended + Miragon recommended-for-modeling) over every top-level fixture', () => {
  let found;
  beforeAll(() => { found = run(); }, 300000);

  test('every KNOWN entry names a fixture that exists, and says why', () => {
    expect(Object.keys(KNOWN).filter((f) => !FIXTURES.includes(f))).toEqual([]);
    expect(Object.entries(KNOWN).filter(([, k]) => !k.why).map(([f]) => f)).toEqual([]);
  });

  for (const name of FIXTURES) {
    test(name, () => {
      if (found[name] === null) return; // blocked by the rule engine on purpose (deadlock-process)
      expect(found[name]).toEqual([...(KNOWN[name]?.findings ?? [])].sort());
    });
  }

  test('a reused Linter leaks rule state: the second lint of the same document reports duplicates', () => {
    // Pins the upstream behaviour the fresh-Linter-per-document rule works around; when bpmnlint
    // stops caching stateful rule instances across lint() calls this turns red — drop the workaround then.
    const { once, twice } = run('--reuse-check');
    expect(once).toEqual([]);
    expect(twice.length).toBeGreaterThan(0);
    expect(twice.every((f) => f.startsWith('error no-duplicate-sequence-flows '))).toBe(true);
  }, 60000);
});
