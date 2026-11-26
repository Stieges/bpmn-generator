/**
 * MCP server — a broken BPMN_NAMING word-list overlay.
 * Start-up: the real server is spawned and must refuse to start. Request time: the server is
 * loaded with a module mock (below), which is why these cases have a file of their own.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  JSON.parse(readFileSync(resolve(__dirname, '../tests/fixtures', name), 'utf8'));
const parse = (r) => JSON.parse(r.content[0].text);

describe('BPMN_NAMING: a broken word-list overlay', () => {
  test('the server does not start: exit 1, the path on stderr, never connecting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'naming-'));
    const missing = join(dir, 'nonexistent.json');
    let res;
    try {
      res = spawnSync(process.execPath, [resolve(__dirname, 'mcp-bpmn-server.js')], {
        env: { ...process.env, BPMN_NAMING: missing },
        input: '', encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(res.error).toBeUndefined(); // not killed by the timeout
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`✗ BPMN_NAMING: naming data "${missing}"`);
    expect(res.stdout).toBe('');
  }, 60_000);

  // Request time. Until the naming rules consult the word lists (the task after this one), no rule
  // on the request path calls namingFor. The failure is injected where it will then come from:
  // runRules (scripts/bpmn/rules.js) is wrapped so that it first calls the real
  // namingFor(modelLanguage(model)) — which loads the lexicon with the real, broken BPMN_NAMING
  // file and throws a genuine NamingDataError — and then runs the real rules. The next task makes
  // this path real and adds an un-mocked end-to-end assertion.
  // Loaded once: a module mock outlives jest.resetModules, so a second load would wrap the mock.
  let mocked = null;
  const loadMocked = () => (mocked ??= loadMockedOnce());
  async function loadMockedOnce() {
    jest.resetModules();
    const actualRules = await import('./bpmn/rules.js');
    const naming = await import('./bpmn/naming/index.js');
    jest.unstable_mockModule('./bpmn/rules.js', () => ({
      ...actualRules,
      runRules: (lc, ...rest) => {
        naming.namingFor(naming.modelLanguage(lc));
        return actualRules.runRules(lc, ...rest);
      },
    }));
    const { handleToolCall } = await import('./mcp-bpmn-server.js');
    return (name, args) => handleToolCall({ params: { name, arguments: args } });
  }

  async function withBrokenOverlay(fn) {
    const call = await loadMocked();
    const dir = mkdtempSync(join(tmpdir(), 'naming-'));
    const broken = join(dir, 'broken-overlay.json');
    writeFileSync(broken, '{ not json');
    const before = process.env.BPMN_NAMING;
    const realError = console.error;
    const errors = [];
    try {
      process.env.BPMN_NAMING = broken;
      console.error = (...args) => { errors.push(args.join(' ')); };
      await fn({ call, broken, errors });
    } finally {
      console.error = realError;
      if (before === undefined) delete process.env.BPMN_NAMING; else process.env.BPMN_NAMING = before;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async function expectNamingFailure(promise, { broken, errors }) {
    const err = await promise.then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('naming data unavailable');
    expect(errors.some((l) => l.includes(broken))).toBe(true);
  }

  test('generate_bpmn with language rejects with exactly "naming data unavailable"; without language it works', async () => {
    await withBrokenOverlay(async ({ call, broken, errors }) => {
      const lc = fixture('simple-approval.json');
      await expectNamingFailure(call('generate_bpmn', { logicCore: { ...lc, language: 'en' } }), { broken, errors });
      const ok = parse(await call('generate_bpmn', { logicCore: lc, include: ['validation'] }));
      expect(ok.validation.errors).toEqual([]);
    });
  }, 60_000); // a fresh module graph and two generate runs; slow under a loaded full run

  // The orchestrator wraps the reviewer's error (the NamingDataError as its cause).
  test('orchestrate_bpmn with language rejects with exactly "naming data unavailable"; without language it works', async () => {
    await withBrokenOverlay(async ({ call, broken, errors }) => {
      const lc = fixture('simple-approval.json');
      await expectNamingFailure(call('orchestrate_bpmn', { logicCore: { ...lc, language: 'en' } }), { broken, errors });
      const ok = parse(await call('orchestrate_bpmn', { logicCore: lc }));
      expect(ok.validation.errors).toEqual([]);
    });
  }, 60_000);
});
