/**
 * HTTP API Tests — /api/v1/chat
 * Boots the real server on an ephemeral port and drives it with fetch.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { server, resolveEnvLlmConfig, _resetRateLimit, clientRuleProfile, _setDnsLookup } from './http-server.js';
import { ProfileRejectedError } from './shared/rule-profile.js';
import { getAuditPath } from './audit.js';

let baseUrl;

beforeAll(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL;
  delete process.env.BPMN_API_KEY;
});

function mockLlmResponse(content) {
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  });
}

describe('POST /api/v1/chat', () => {
  test('400 when messages is missing', async () => {
    const res = await realFetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llmConfig: { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' } }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/messages/i);
  });

  test('400 when messages is an empty array', async () => {
    const res = await realFetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [], llmConfig: { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' } }),
    });
    expect(res.status).toBe(400);
  });

  test('400 when no llmConfig is given and no OPENAI_API_KEY env fallback is set', async () => {
    const res = await realFetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/llmConfig/i);
  });

  test('400 when llmConfig is missing required fields', async () => {
    const res = await realFetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], llmConfig: { model: 'm' } }),
    });
    expect(res.status).toBe(400);
  });

  test('200: returns reply, readyToGenerate, suggestedSummary and echoes correlationId', async () => {
    mockLlmResponse(JSON.stringify({
      reply: 'Wie viele Beteiligte sind involviert?',
      readyToGenerate: false,
      suggestedSummary: null,
    }));

    const res = await realFetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Ich brauche einen Genehmigungsprozess.' }],
        correlationId: 'test-correlation-id',
        llmConfig: { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.correlationId).toBe('test-correlation-id');
    expect(data.reply).toBe('Wie viele Beteiligte sind involviert?');
    expect(data.readyToGenerate).toBe(false);
    expect(data.suggestedSummary).toBeNull();
  });

  test('200: generates a correlationId when none is provided', async () => {
    mockLlmResponse(JSON.stringify({ reply: 'ok', readyToGenerate: false, suggestedSummary: null }));

    const res = await realFetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        llmConfig: { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.correlationId).toBe('string');
    expect(data.correlationId.length).toBeGreaterThan(0);
  });

  test('falls back to OPENAI_API_KEY env var when llmConfig is omitted', async () => {
    process.env.OPENAI_API_KEY = 'env-key';
    mockLlmResponse(JSON.stringify({ reply: 'ok via env key', readyToGenerate: false, suggestedSummary: null }));

    const res = await realFetch(`${baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.reply).toBe('ok via env key');
  });
});

describe('resolveEnvLlmConfig', () => {
  test('returns null when OPENAI_API_KEY is unset', () => {
    expect(resolveEnvLlmConfig()).toBeNull();
  });

  test('returns defaults when only OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(resolveEnvLlmConfig()).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    });
  });

  test('honors OPENAI_BASE_URL and OPENAI_MODEL overrides', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_BASE_URL = 'http://localhost:1234/v1';
    process.env.OPENAI_MODEL = 'qwen2.5';
    expect(resolveEnvLlmConfig()).toEqual({
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'sk-test',
      model: 'qwen2.5',
    });
  });
});

describe('GET /api/v1/config', () => {
  test('dev mode, no env key → envKeyConfigured false, model null', async () => {
    const res = await realFetch(`${baseUrl}/api/v1/config`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ envKeyConfigured: false, model: null });
  });

  test('dev mode, OPENAI_API_KEY set, no OPENAI_MODEL → default model', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const res = await realFetch(`${baseUrl}/api/v1/config`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ envKeyConfigured: true, model: 'gpt-4o-mini' });
  });

  test('dev mode, explicit OPENAI_MODEL → echoes it', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_MODEL = 'qwen2.5';
    const res = await realFetch(`${baseUrl}/api/v1/config`);
    const data = await res.json();
    expect(data).toEqual({ envKeyConfigured: true, model: 'qwen2.5' });
  });

  test('production (BPMN_API_KEY set) → model omitted, only boolean', async () => {
    process.env.BPMN_API_KEY = 'server-secret';
    process.env.OPENAI_API_KEY = 'sk-test';
    const res = await realFetch(`${baseUrl}/api/v1/config`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ envKeyConfigured: true });
    expect(data).not.toHaveProperty('model');
  });
});

describe('POST /api/v1/validate — mode (Optimization Advisory)', () => {
  const knockoutExc = {
    id: 'P',
    nodes: [
      { id: 's', type: 'startEvent', lane: 'L' },
      { id: 'g1', type: 'exclusiveGateway', name: 'Gültig?', lane: 'L' },
      { id: 'ex1', type: 'endEvent', name: 'Fehler', marker: 'error', lane: 'L' },
      { id: 'g2', type: 'exclusiveGateway', name: 'Vollständig?', lane: 'L' },
      { id: 'ex2', type: 'endEvent', name: 'Abbruch', marker: 'terminate', lane: 'L' },
      { id: 't', type: 'userTask', name: 'Antrag prüfen', lane: 'L' },
      { id: 'e', type: 'endEvent', name: 'Fertig', lane: 'L' },
    ],
    edges: [
      { id: 'f1', source: 's', target: 'g1' },
      { id: 'f2', source: 'g1', target: 'ex1', label: 'Nein' },
      { id: 'f3', source: 'g1', target: 'g2', label: 'Ja' },
      { id: 'f4', source: 'g2', target: 'ex2', label: 'Nein' },
      { id: 'f5', source: 'g2', target: 't', label: 'Ja' },
      { id: 'f6', source: 't', target: 'e' },
    ],
    lanes: [{ id: 'L', name: 'Rolle' }],
  };
  const post = (body) => realFetch(`${baseUrl}/api/v1/validate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  test('document mode (default) → no advisories', async () => {
    const res = await post({ logicCore: knockoutExc });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.validation.advisories).toEqual([]);
  });

  test('optimize mode → advisories populated', async () => {
    const res = await post({ logicCore: knockoutExc, mode: 'optimize' });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.validation.advisories.length).toBeGreaterThan(0);
    expect(data.validation.metrics.optimization).toBeDefined();
  });
});

describe('POST /api/v1/orchestrate — diagnostics', () => {
  // orchestrator.js computes diagnostics (scripts/orchestrator.js state.diagnostics),
  // and the MCP orchestrate_bpmn tool already returned it — but the HTTP handler's
  // response object omitted the field, so a caller reading only `validation` here
  // would have shipped a geometrically broken diagram as a plain "success".
  const simple = {
    id: 'P',
    nodes: [
      { id: 's', type: 'startEvent' },
      { id: 't', type: 'task', name: 'Do' },
      { id: 'e', type: 'endEvent' },
    ],
    edges: [
      { id: 'f1', source: 's', target: 't' },
      { id: 'f2', source: 't', target: 'e' },
    ],
  };

  test('response carries diagnostics for a logicCore-only request', async () => {
    const res = await realFetch(`${baseUrl}/api/v1/orchestrate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logicCore: simple }),
    });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.diagnostics).toBeDefined();
    expect(data.diagnostics.ok).toBe(true);
  });
});

describe('rule profiles over HTTP — inline objects only, gated, bounded', () => {
  const lc = JSON.parse(readFileSync(new URL('../tests/fixtures/simple-approval.json', import.meta.url), 'utf8'));
  const styled = JSON.parse(readFileSync(new URL('../tests/fixtures/boundary-event-shapes.json', import.meta.url), 'utf8'));
  const strict = JSON.parse(readFileSync(new URL('../rules/strict-profile.json', import.meta.url), 'utf8'));
  const post = (path, body) => realFetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const ENDPOINTS = ['/api/v1/generate', '/api/v1/validate', '/api/v1/orchestrate'];
  beforeEach(() => _resetRateLimit());
  const auditLines = (correlationId) => readFileSync(getAuditPath(), 'utf8').split('\n')
    .filter((l) => l.includes(correlationId));

  for (const path of ENDPOINTS) {
    test(`${path}: an unknown severity is a 400 naming the place, not a 500`, async () => {
      const res = await post(path, { logicCore: lc, ruleProfile: { profile: 'typo', overrides: { M03: { severity: 'CRITICAL' } } } });
      const data = await res.json();
      expect(res.status).toBe(400);
      expect(data.status).toBe('profile_error');
      expect(data.error).toBe('rule profile "typo" does not match the profile schema: "/overrides/M03/severity" must be one of ERROR, WARNING, INFO, ADVISORY, OFF');
    });

    test(`${path}: a string profile is refused — no file is read, no path or content comes back`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'profile-'));
      const secret = join(dir, 'secret.json');
      writeFileSync(secret, 'SECRET_TOKEN=abc123');
      for (const ruleProfile of [secret, '/etc/passwd', 'rules/strict-profile.json', 'strict']) {
        const res = await post(path, { logicCore: lc, ruleProfile });
        const text = await res.text();
        expect(res.status).toBe(400);
        expect(JSON.parse(text).status).toBe('profile_error');
        expect(text).not.toMatch(/SECRET|abc123|root:|\/etc|secret\.json|rules\//);
      }
      rmSync(dir, { recursive: true, force: true });
    });

    test(`${path}: an array, a number or a boolean is not a profile`, async () => {
      for (const ruleProfile of [[], [{ overrides: {} }], 7, true, false, '']) {
        const res = await post(path, { logicCore: lc, ruleProfile });
        expect(res.status).toBe(400);
        expect((await res.json()).status).toBe('profile_error');
      }
    });

    test(`${path}: client-supplied internal markers are refused`, async () => {
      const res = await post(path, { logicCore: lc, ruleProfile: { $source: '/forged\n[ERROR] admin login ok', $missing: true } });
      const text = await res.text();
      expect(res.status).toBe(400);
      expect(text).not.toContain('admin login');
    });

    test(`${path}: a profile may not switch soundness off or below a failing severity`, async () => {
      for (const ruleProfile of [{ layers: { soundness: { enabled: false } } }, { overrides: { S01: { severity: 'OFF' } } }, { overrides: { S02: { severity: 'INFO' } } }, { overrides: { S01: { severity: 'WARNING' } } }]) {
        const res = await post(path, { logicCore: lc, ruleProfile });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/not accepted from a client/);
      }
    });
  }

  test('an oversized inline profile is refused quickly, with a short answer and a short audit line', async () => {
    const correlationId = `oversized-${Date.now()}`;
    const ruleProfile = { profile: 'A'.repeat(200000), overrides: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`X${i}`, { severity: 'X' }])) };
    const t0 = Date.now();
    const res = await post('/api/v1/validate', { logicCore: lc, ruleProfile, correlationId });
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(text.length).toBeLessThan(1000);
    const lines = auditLines(correlationId).filter((l) => l.includes('profile_rejected'));
    expect(lines).toHaveLength(1);
    expect(lines[0].length).toBeLessThan(800);
  });

  test.each([
    [10000, /larger than 64 KiB/],
    [1000, /does not match the profile schema: "\/overrides" must NOT have more than 256 properties/],
  ])('%i unknown overrides are one refusal, not one warning each', async (count, expected) => {
    const correlationId = `many-overrides-${count}-${Date.now()}`;
    const overrides = Object.fromEntries(Array.from({ length: count }, (_, i) => [`Q${i}`, {}]));
    const res = await post('/api/v1/validate', { logicCore: lc, ruleProfile: { overrides }, correlationId });
    const data = await res.json();
    expect(res.status).toBe(400);
    expect(data.error).toMatch(expected);
    expect(JSON.stringify(data).length).toBeLessThan(1000);
    for (const l of auditLines(correlationId)) expect(l.length).toBeLessThan(800);
  });

  test('a profile id carrying a newline or an ANSI escape comes back escaped', async () => {
    const res = await post('/api/v1/validate', { logicCore: lc, ruleProfile: { profile: 'p', overrides: { 'S9\n[ERROR] x\u001b[31m': { severity: 'ERROR' } } } });
    const data = await res.json();
    expect(res.status).toBe(400);
    expect(data.error).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  test('clientRuleProfile refuses up front what the rule runner would refuse', () => {
    const ruleProfile = { profile: 'bad', overrides: { M01: { severity: 'ADVISORY' } } };
    expect(() => clientRuleProfile({ ruleProfile })).toThrow(ProfileRejectedError);
    expect(() => clientRuleProfile({ ruleProfile })).toThrow(/ADVISORY/);
  });

  test('/api/v1/orchestrate: a profile the rule runner would refuse is a 400 before any agent runs', async () => {
    let providerCalls = 0;
    global.fetch = async (url, init) => {
      if (String(url).startsWith(baseUrl)) return realFetch(url, init);
      providerCalls++;
      throw new Error('LLM provider must not be reached');
    };
    const ruleProfile = { profile: 'bad', overrides: { M01: { severity: 'ADVISORY' } } };
    const res = await post('/api/v1/orchestrate', {
      logicCore: styled, ruleProfile, llmConfig: { baseUrl: 'http://llm.invalid/v1', apiKey: 'k', model: 'm' },
    });
    const data = await res.json();
    expect(res.status).toBe(400);
    expect(JSON.stringify(data)).toMatch(/ADVISORY/);
    expect(providerCalls).toBe(0);
  });

  test('/api/v1/orchestrate: a strict inline profile applies in the compliance phase', async () => {
    const plain = await (await post('/api/v1/orchestrate', { logicCore: styled })).json();
    expect(plain.compliance.isCompliant).toBe(true);
    const res = await post('/api/v1/orchestrate', { logicCore: styled, ruleProfile: strict });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.compliance.isCompliant).toBe(false);
    expect(data.compliance.errors.join('\n')).toMatch(/Objekt\+Verb/);
    expect(data.compliance.errors.join('\n')).not.toMatch(/Compliance check failed/);
  });
});

describe('correlationId is an identifier, never a path or a blob', () => {
  const lc = JSON.parse(readFileSync(new URL('../tests/fixtures/simple-approval.json', import.meta.url), 'utf8'));
  const post = (path, body) => realFetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  beforeEach(() => _resetRateLimit());

  const ENDPOINTS = ['/api/v1/generate', '/api/v1/validate', '/api/v1/import', '/api/v1/orchestrate', '/api/v1/chat', '/api/v1/telemetry'];
  const BAD = ['../outside/x', '/etc/x', 'a b', 'x'.repeat(65), '', 'line\nbreak', 42, { a: 1 }, ['a'], true];

  for (const path of ENDPOINTS) {
    test(`${path}: a correlationId outside [A-Za-z0-9_-]{1,64} is a 400 and is not echoed`, async () => {
      for (const correlationId of BAD) {
        const res = await post(path, { logicCore: lc, correlationId });
        const text = await res.text();
        expect(res.status).toBe(400);
        expect(JSON.parse(text).error).toMatch(/correlationId/);
        expect(text).not.toContain('outside');
      }
    });
  }

  test('a well-formed correlationId is accepted and echoed', async () => {
    const res = await post('/api/v1/validate', { logicCore: lc, correlationId: 'Abc_123-xyz' });
    expect(res.status).toBe(200);
    expect((await res.json()).correlationId).toBe('Abc_123-xyz');
  });

  test('a UUID, as the frontend sends, is accepted', async () => {
    const res = await post('/api/v1/validate', { logicCore: lc, correlationId: '0f8fad5b-d9cb-469f-a165-70867728950e' });
    expect(res.status).toBe(200);
  });
});

describe('callbackUrl is checked against every internal address form', () => {
  const lc = JSON.parse(readFileSync(new URL('../tests/fixtures/simple-approval.json', import.meta.url), 'utf8'));
  const post = (body) => realFetch(`${baseUrl}/api/v1/generate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  beforeEach(() => _resetRateLimit());
  afterEach(() => _setDnsLookup(null));

  test.each([
    'http://[::ffff:127.0.0.1]:9/a', 'http://[::ffff:7f00:1]:9/b', 'http://0.0.0.0:9/c', 'http://[::]:9/d',
    'http://100.64.0.1/', 'http://198.18.0.1/', 'http://224.0.0.1/', 'http://255.255.255.255/',
    'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/', 'http://2130706433/', 'http://app.localhost/',
  ])('%s is a 400 and nothing is delivered', async (callbackUrl) => {
    const res = await post({ logicCore: lc, callbackUrl });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/internal/);
  });

  test('a host name resolving to an internal address (stubbed DNS) is a 400', async () => {
    _setDnsLookup(async () => [{ address: '::ffff:169.254.169.254', family: 6 }]);
    const res = await post({ logicCore: lc, callbackUrl: 'https://hooks.example.test/x' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/internal/);
  });

  test('credentials in the callback URL are a 400', async () => {
    const res = await post({ logicCore: lc, callbackUrl: 'https://u:p@hooks.example.test/x' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/credentials/);
  });
});
