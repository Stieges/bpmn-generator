/**
 * HTTP API — a broken BPMN_NAMING word-list overlay.
 * Start-up: the real server is spawned and must refuse to start. Request time: the server is
 * loaded with a module mock (below), which is why these cases have a file of their own.
 */

import { describe, test, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('./http-server.js', import.meta.url));
const simpleApproval = () => JSON.parse(readFileSync(new URL('../tests/fixtures/simple-approval.json', import.meta.url), 'utf8'));
// The pinned serialisation of simple-approval's validation (scripts/format1-responses.test.js).
const PREFIXED_WARNING = '[Main Pool] Task "Revise document" folgt nicht der Objekt+Verb-Konvention (z.B. "Antrag prüfen"). Heuristik — exakte Wortartprüfung: M05/M06.';
const FULL_VALIDATION = `{"errors":[],"warnings":${JSON.stringify([PREFIXED_WARNING])},"infos":[],"advisories":[],"metrics":{},"xmlWarnings":[],"hints":[]}`;
const SHORT_VALIDATION = `{"errors":[],"warnings":${JSON.stringify([PREFIXED_WARNING])},"infos":[],"advisories":[],"metrics":{}}`;

// The server reads BPMN_API_KEY when it is loaded, and an LLM provider from OPENAI_API_KEY per request.
const SAVED_ENV = ['BPMN_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'];
const saved = {};
beforeAll(() => {
  for (const k of SAVED_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterAll(() => {
  for (const k of SAVED_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('BPMN_NAMING: a broken word-list overlay', () => {
  test('the server does not start: exit 1, the path on stderr, never listening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'naming-'));
    const missing = join(dir, 'nonexistent.json');
    let res;
    try {
      res = spawnSync(process.execPath, [SERVER], {
        env: { ...process.env, BPMN_NAMING: missing, PORT: '0', NODE_ENV: '', BPMN_API_KEY: '' },
        encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(res.error).toBeUndefined(); // not killed by the timeout
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`✗ BPMN_NAMING: naming data "${missing}"`);
    expect(res.stdout).not.toMatch(/listening/);
  }, 60_000);

  // Request time. runRules (scripts/bpmn/rules.js) is wrapped so that it first calls the real
  // namingFor(modelLanguage(model)) — which loads the lexicon with the real, broken BPMN_NAMING
  // file and throws a genuine NamingDataError — and then runs the real rules. M01 now does that
  // itself; the un-mocked end-to-end assertion is in scripts/bpmn/naming-rules.test.js.
  // Loaded once: a module mock outlives jest.resetModules, so a second load would wrap the mock.
  let mockedServer = null;
  const loadMockedServer = () => (mockedServer ??= loadMockedServerOnce());
  async function loadMockedServerOnce() {
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
    const mod = await import('./http-server.js');
    const audit = await import('./audit.js');
    return { server: mod.server, reset: mod._resetRateLimit, auditPath: audit.getAuditPath() };
  }

  async function withBrokenOverlay(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'naming-'));
    const broken = join(dir, 'broken-overlay.json');
    writeFileSync(broken, '{ not json');
    const { server: mocked, reset, auditPath } = await loadMockedServer();
    const before = process.env.BPMN_NAMING;
    const errors = [];
    const realError = console.error;
    await new Promise((r) => mocked.listen(0, r));
    try {
      process.env.BPMN_NAMING = broken;
      console.error = (...args) => { errors.push(args.join(' ')); };
      reset();
      const base = `http://127.0.0.1:${mocked.address().port}`;
      const post = async (path, body) => {
        const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: res.status, text: await res.text() };
      };
      await fn({ post, broken, errors, auditPath });
    } finally {
      console.error = realError;
      if (before === undefined) delete process.env.BPMN_NAMING; else process.env.BPMN_NAMING = before;
      await new Promise((r) => mocked.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The fixed 500, the full message with the correlation id on the console, no path in the audit log. */
  function expectNamingFailure(failed, { correlationId, broken, errors, auditPath }) {
    expect(failed.status).toBe(500);
    expect(JSON.parse(failed.text)).toEqual({ correlationId, status: 'internal_error', error: 'naming data unavailable' });
    expect(failed.text).not.toContain(broken);
    expect(failed.text).not.toContain('broken-overlay');

    expect(errors.some((l) => l.includes(correlationId) && l.includes(broken))).toBe(true);
    const records = readFileSync(auditPath, 'utf8').split('\n').filter((l) => l.includes(`"${correlationId}"`)).map((l) => JSON.parse(l));
    const record = records.find((r) => r.event === 'naming_data_error');
    expect(record).toBeDefined();
    expect(Object.keys(record).sort()).toEqual(['correlationId', 'event', 'ts']);
    expect(records.some((r) => JSON.stringify(r).includes('broken-overlay'))).toBe(false);
  }

  // Unique per run: the audit log outlives the test run.
  const uniqueId = (name) => `naming-${name}-${Date.now()}-${process.pid}`;

  for (const [path, pinned] of [['/api/v1/generate', FULL_VALIDATION], ['/api/v1/validate', SHORT_VALIDATION]]) {
    test(`${path}: 500 "naming data unavailable" without the path; a model without language still succeeds`, async () => {
      await withBrokenOverlay(async ({ post, broken, errors, auditPath }) => {
        const correlationId = uniqueId(path.split('/').pop());
        const failed = await post(path, { logicCore: { ...simpleApproval(), language: 'en' }, correlationId });
        expectNamingFailure(failed, { correlationId, broken, errors, auditPath });

        const ok = await post(path, { logicCore: simpleApproval() });
        expect(ok.status).toBe(200);
        expect(JSON.stringify(JSON.parse(ok.text).validation)).toBe(pinned);
      });
    }, 60_000); // the first one loads a fresh module graph; slow under a loaded full run
  }

  // The orchestrator wraps the reviewer's error ("Reviewer agent failed …", the NamingDataError as
  // its cause): the server finds it through the cause chain. No LLM provider: the reviewer runs
  // the rules directly.
  test('/api/v1/orchestrate: the wrapped NamingDataError gives the same 500; without language it succeeds', async () => {
    await withBrokenOverlay(async ({ post, broken, errors, auditPath }) => {
      const correlationId = uniqueId('orchestrate');
      const failed = await post('/api/v1/orchestrate', { logicCore: { ...simpleApproval(), language: 'en' }, correlationId });
      expectNamingFailure(failed, { correlationId, broken, errors, auditPath });

      const ok = await post('/api/v1/orchestrate', { logicCore: simpleApproval() });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.text).status).toBe('success');
    });
  }, 60_000);

  test('a client rule-profile error is still 400 profile_error', async () => {
    await withBrokenOverlay(async ({ post }) => {
      const res = await post('/api/v1/generate', {
        logicCore: { ...simpleApproval(), language: 'en' },
        ruleProfile: { profile: 'typo', overrides: { M03: { severity: 'CRITICAL' } } },
      });
      expect(JSON.parse(res.text).status).toBe('profile_error');
      expect(res.status).toBe(400);
    });
  }, 60_000);
});
