/**
 * HTTP API Tests — /api/v1/chat
 * Boots the real server on an ephemeral port and drives it with fetch.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { server, resolveEnvLlmConfig } from './http-server.js';

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
