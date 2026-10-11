/**
 * HTTP API Tests — /api/v1/chat
 * Boots the real server on an ephemeral port and drives it with fetch.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { server, resolveEnvLlmConfig, _resetRateLimit, clientRuleProfile, _setDnsLookup, resolveClientLlmConfig,
  apiKeyMatches, rateLimitKey, rateLimitAllows, _rateBucketCount } from './http-server.js';
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
        llmConfig: { apiKey: 'k', model: 'm' },
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
        llmConfig: { apiKey: 'k', model: 'm' },
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

describe('llmConfig.baseUrl from a client', () => {
  const post = (path, body) => realFetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const chat = { messages: [{ role: 'user', content: 'hi' }] };
  const orch = { userText: 'An approval process' };
  let providerCalls;
  beforeEach(() => {
    _resetRateLimit();
    providerCalls = [];
    global.fetch = async (url, init) => {
      if (String(url).startsWith(baseUrl)) return realFetch(url, init);
      providerCalls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ reply: 'ok', readyToGenerate: false, suggestedSummary: null }) } }] }) };
    };
  });
  afterEach(() => {
    delete process.env.LLM_BASE_URL_ALLOWLIST;
    _setDnsLookup(null);
  });

  for (const [path, body] of [['/api/v1/chat', chat], ['/api/v1/orchestrate', orch]]) {
    test(`${path}: refused by default — no outbound request is made`, async () => {
      const res = await post(path, { ...body, llmConfig: { baseUrl: 'http://127.0.0.1:9/admin?', apiKey: 'k', model: 'm' } });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/baseUrl/);
      expect(providerCalls).toEqual([]);
    });

    test(`${path}: an origin outside LLM_BASE_URL_ALLOWLIST is refused`, async () => {
      process.env.LLM_BASE_URL_ALLOWLIST = 'https://llm.example.test';
      const res = await post(path, { ...body, llmConfig: { baseUrl: 'https://other.example.test/v1', apiKey: 'k', model: 'm' } });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/baseUrl/);
      expect(providerCalls).toEqual([]);
    });

    test(`${path}: an allowlisted origin that resolves to an internal address is still refused`, async () => {
      process.env.LLM_BASE_URL_ALLOWLIST = 'https://llm.example.test';
      _setDnsLookup(async () => [{ address: '10.0.0.5', family: 4 }]);
      const res = await post(path, { ...body, llmConfig: { baseUrl: 'https://llm.example.test/v1', apiKey: 'k', model: 'm' } });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/internal/);
      expect(providerCalls).toEqual([]);
    });
  }

  test('without baseUrl the client key goes to the server-configured endpoint', async () => {
    const res = await post('/api/v1/chat', { ...chat, llmConfig: { apiKey: 'k', model: 'm' } });
    expect(res.status).toBe(200);
    expect(providerCalls).toEqual(['https://api.openai.com/v1/chat/completions']);
  });

  test('resolveClientLlmConfig accepts an allowlisted origin that resolves to a public address', async () => {
    _setDnsLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
    const env = { LLM_BASE_URL_ALLOWLIST: 'https://llm.example.test, http://other.example.test:8080' };
    const ok = await resolveClientLlmConfig({ baseUrl: 'https://llm.example.test/v1', apiKey: 'k', model: 'm' }, env);
    expect(ok.error).toBeUndefined();
    expect(ok.config.baseUrl).toBe('https://llm.example.test/v1');
    expect(typeof ok.config.request).toBe('function');
    const wrongPort = await resolveClientLlmConfig({ baseUrl: 'http://other.example.test:8081/v1', apiKey: 'k', model: 'm' }, env);
    expect(wrongPort.error).toMatch(/baseUrl/);
  });
});

describe('LLM provider failures are not reflected to the client', () => {
  const post = (path, body) => realFetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  beforeEach(() => {
    _resetRateLimit();
    process.env.OPENAI_API_KEY = 'env-key';
    global.fetch = async (url, init) => {
      if (String(url).startsWith(baseUrl)) return realFetch(url, init);
      return { ok: false, status: 500, text: async () => 'INTERNAL-SECRET-RESPONSE: db_password=hunter2' };
    };
  });

  for (const [path, body] of [
    ['/api/v1/chat', { messages: [{ role: 'user', content: 'hi' }] }],
    ['/api/v1/orchestrate', { userText: 'An approval process' }],
  ]) {
    test(`${path}: 502 llm_error with a correlation id and no upstream body`, async () => {
      const res = await post(path, { ...body, correlationId: 'llm-fail-1' });
      const text = await res.text();
      expect(res.status).toBe(502);
      const data = JSON.parse(text);
      expect(data.status).toBe('llm_error');
      expect(data.correlationId).toBe('llm-fail-1');
      expect(text).not.toMatch(/SECRET|hunter2|500/);
    });
  }
});

describe('a JSON body that is not an object', () => {
  beforeEach(() => _resetRateLimit());
  test.each(['null', '[]', '[1,2]', '7', '"text"', 'true'])('%s is a 400 at once, never a hanging connection', async (raw) => {
    const res = await realFetch(`${baseUrl}/api/v1/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: raw, signal: AbortSignal.timeout(2000),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/JSON object/);
  });
});

describe('client strings reaching the audit log and responses are bounded and escaped', () => {
  const lc = JSON.parse(readFileSync(new URL('../tests/fixtures/simple-approval.json', import.meta.url), 'utf8'));
  const post = (path, body) => realFetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const auditEntries = (correlationId) => readFileSync(getAuditPath(), 'utf8').split('\n')
    .filter((l) => l.includes(correlationId));
  const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
  beforeEach(() => _resetRateLimit());

  test('a huge clientId is cut to a short audit field', async () => {
    const correlationId = `big-client-${Date.now()}`;
    const res = await post('/api/v1/validate', { logicCore: lc, correlationId, clientId: 'C'.repeat(1_000_000) });
    expect(res.status).toBe(200);
    const lines = auditEntries(correlationId);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.length).toBeLessThan(1000);
  });

  test('a clientId of another type is not logged as a structure', async () => {
    const correlationId = `obj-client-${Date.now()}`;
    await post('/api/v1/validate', { logicCore: lc, correlationId, clientId: { nested: 'x'.repeat(100000) } });
    const request = auditEntries(correlationId).map((l) => JSON.parse(l)).find((e) => e.event === 'request');
    expect(typeof request.clientId).toBe('string');
    expect(request.clientId.length).toBeLessThanOrEqual(129);
  });

  test('control and format characters in clientId are escaped in the audit log', async () => {
    const correlationId = `ctl-client-${Date.now()}`;
    await post('/api/v1/validate', { logicCore: lc, correlationId, clientId: 'app\u001b[31m\u202eevil\u2028x\u0085' });
    const request = auditEntries(correlationId).map((l) => JSON.parse(l)).find((e) => e.event === 'request');
    expect(request.clientId).not.toMatch(UNSAFE);
    expect(request.clientId).toContain('\\u001b');
  });

  test('telemetry: event, diagramId and details are bounded; oversized details are a 400', async () => {
    const correlationId = `tel-${Date.now()}`;
    const ok = await post('/api/v1/telemetry', {
      event: 'e'.repeat(10000) + '\u202e', diagramId: 'd'.repeat(10000), correlationId,
      details: { note: 'line\u2028two\u202e', ['k'.repeat(1000)]: 1 },
    });
    expect(ok.status).toBe(200);
    const [line] = auditEntries(correlationId);
    expect(line.length).toBeLessThan(2000);
    const entry = JSON.parse(line);
    expect(entry.frontendEvent.length).toBeLessThanOrEqual(129);
    expect(entry.diagramId.length).toBeLessThanOrEqual(129);
    expect(JSON.stringify(entry)).not.toMatch(UNSAFE);
    expect(entry.details.note).toContain('\\u2028');

    const big = await post('/api/v1/telemetry', { event: 'x', correlationId: `tel-big-${Date.now()}`, details: { blob: 'b'.repeat(9000) } });
    expect(big.status).toBe(400);
    expect((await big.json()).error).toMatch(/details/);
  });

  test('an internal error message is bounded in the response and in the audit line', async () => {
    const correlationId = `err-${Date.now()}`;
    const res = await post('/api/v1/import', { bpmnXml: { not: 'a string' }, correlationId });
    const data = await res.json();
    expect(res.status).toBe(500);
    expect(data.error.length).toBeLessThanOrEqual(501);
    for (const l of auditEntries(correlationId)) expect(l.length).toBeLessThan(1000);
  });
});

describe('API key comparison', () => {
  test('matches only the exact key, whatever the length of the attempt', () => {
    expect(apiKeyMatches('s3cret-key', 's3cret-key')).toBe(true);
    expect(apiKeyMatches('s3cret-kez', 's3cret-key')).toBe(false);
    expect(apiKeyMatches('s3cret', 's3cret-key')).toBe(false);
    expect(apiKeyMatches('s3cret-key-and-more', 's3cret-key')).toBe(false);
    expect(apiKeyMatches('', 's3cret-key')).toBe(false);
    expect(apiKeyMatches(undefined, 's3cret-key')).toBe(false);
    expect(apiKeyMatches(['s3cret-key'], 's3cret-key')).toBe(false);
  });
});

describe('rate limiting', () => {
  const req = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });
  beforeEach(() => _resetRateLimit());

  test('the key is the socket address unless the operator trusts a proxy', () => {
    expect(rateLimitKey(req('10.0.0.9', '1.2.3.4'), {})).toBe('10.0.0.9');
    expect(rateLimitKey(req('10.0.0.9', '1.2.3.4'), { TRUST_PROXY_HOPS: '0' })).toBe('10.0.0.9');
  });

  test('behind trusted proxies the key is the address the nearest trusted proxy saw', () => {
    // A client can prepend anything; only the entries appended by trusted proxies count.
    expect(rateLimitKey(req('10.0.0.9', 'forged, 203.0.113.7'), { TRUST_PROXY_HOPS: '1' })).toBe('203.0.113.7');
    expect(rateLimitKey(req('10.0.0.9', 'forged, 203.0.113.7, 10.0.0.2'), { TRUST_PROXY_HOPS: '2' })).toBe('203.0.113.7');
    expect(rateLimitKey(req('10.0.0.9'), { TRUST_PROXY_HOPS: '1' })).toBe('10.0.0.9');
  });

  test('a chain shorter than the trusted hops did not pass all proxies: the socket address is the key', () => {
    expect(rateLimitKey(req('10.0.0.9', '198.51.100.1'), { TRUST_PROXY_HOPS: '2' })).toBe('10.0.0.9');
    expect(rateLimitKey(req('10.0.0.9', 'a, b'), { TRUST_PROXY_HOPS: '3' })).toBe('10.0.0.9');
    expect(rateLimitKey(req('10.0.0.9', 'a, b, c, d'), { TRUST_PROXY_HOPS: '3' })).toBe('b');
  });

  test('allows the configured number of requests per window, then refuses', () => {
    const now = 1_000_000;
    for (let i = 0; i < 30; i++) expect(rateLimitAllows('a', now)).toBe(true);
    expect(rateLimitAllows('a', now)).toBe(false);
    expect(rateLimitAllows('a', now + 60_001)).toBe(true);
  });

  test('expired buckets are evicted, so rotating sources cannot grow the table without bound', () => {
    const now = 2_000_000;
    for (let i = 0; i < 1000; i++) rateLimitAllows(`src-${i}`, now);
    expect(_rateBucketCount()).toBe(1000);
    rateLimitAllows('late', now + 120_001);
    expect(_rateBucketCount()).toBe(1);
  });
});

describe('schema-gate errors in responses are capped and bounded', () => {
  const post = (path, body) => realFetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  beforeEach(() => _resetRateLimit());

  for (const path of ['/api/v1/generate', '/api/v1/validate', '/api/v1/orchestrate']) {
    test(`${path}: thousands of schema errors come back as at most 20 plus a count`, async () => {
      const nodes = Array.from({ length: 5000 }, (_, i) => ({ id: `9bad id ${i}`, type: 'task' }));
      const res = await post(path, { logicCore: { nodes, edges: [] } });
      const text = await res.text();
      const data = JSON.parse(text);
      expect(res.status).toBe(400);
      expect(data.status).toBe('schema_error');
      expect(data.errors.length).toBe(21);
      expect(data.errors[20].message).toMatch(/^… and \d+ more$/);
      expect(text.length).toBeLessThan(20_000);
    });

    test(`${path}: a huge unknown key is not echoed at full length`, async () => {
      const logicCore = { nodes: [], edges: [], ['k'.repeat(100_000)]: 1 };
      const res = await post(path, { logicCore });
      const text = await res.text();
      expect(res.status).toBe(400);
      expect(text.length).toBeLessThan(5_000);
    });
  }
});

describe('visualRefinement over HTTP', () => {
  const lc = JSON.parse(readFileSync(new URL('../tests/fixtures/sparse-lanes.json', import.meta.url), 'utf8'));
  const post = (path, body) => realFetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  beforeEach(() => _resetRateLimit());

  test('false on /generate is byte-identical to runPipeline(lc, { visualRefinement: false })', async () => {
    const { runPipeline } = await import('./bpmn/pipeline.js');
    const res = await post('/api/v1/generate', { logicCore: lc, visualRefinement: false });
    expect(res.status).toBe(200);
    const lib = await runPipeline(JSON.parse(JSON.stringify(lc)), { visualRefinement: false });
    expect((await res.json()).bpmnXml).toBe(lib.bpmnXml);
  });
  test('a per-pass object is accepted', async () => {
    const res = await post('/api/v1/generate', { logicCore: lc, visualRefinement: { laneCompaction: false } });
    expect(res.status).toBe(200);
  });
  test.each([['a string', 'yes'], ['an unknown pass', { laneCompactoin: true }], ['a non-boolean pass', { laneCompaction: 1 }], ['the removed dynamicLaneHeader pass', { dynamicLaneHeader: true }]])(
    '%s is a 400 schema_error on /generate and /orchestrate', async (_, value) => {
      for (const path of ['/api/v1/generate', '/api/v1/orchestrate']) {
        const res = await post(path, { logicCore: lc, visualRefinement: value });
        expect(res.status).toBe(400);
        expect((await res.json()).status).toBe('schema_error');
      }
    });
  test('/orchestrate passes it to the layout agent', async () => {
    const { runPipeline } = await import('./bpmn/pipeline.js');
    const res = await post('/api/v1/orchestrate', { logicCore: lc, visualRefinement: false });
    expect(res.status).toBe(200);
    const lib = await runPipeline(JSON.parse(JSON.stringify(lc)), { visualRefinement: false });
    expect((await res.json()).bpmnXml).toBe(lib.bpmnXml);
  });
});
