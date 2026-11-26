/**
 * Orchestrator — a broken BPMN_NAMING overlay never reaches a result.
 * The library, the HTTP /orchestrate route and the MCP orchestrate_bpmn tool. None of these loads
 * the overlay at start (the start check belongs to the server entry points), so a model without
 * `language` runs, an LLM-amended one with `language: "en"` meets the real, broken file: no module
 * mock is needed.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, jest } from '@jest/globals';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { orchestrate } from './orchestrator.js';
import { NamingDataError } from './bpmn/naming/lexicon.js';
import { publicNamingMessage, namingDataErrorOf } from './bpmn/naming/index.js';
import { server, _resetRateLimit } from './http-server.js';
import { handleToolCall } from './mcp-bpmn-server.js';

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`../tests/fixtures/${name}`, import.meta.url)), 'utf8'));
const PUBLIC = 'naming data unavailable';
const structural = JSON.stringify({ feedback: [{ issue: 'Too long', suggestion: 'Split it', requiresLogicCoreChange: true }] });

let dir;
let broken;
let before;
let errors;
let realError;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'naming-orch-'));
  broken = join(dir, 'broken-overlay.json');
  writeFileSync(broken, '{ not json');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  before = process.env.BPMN_NAMING;
  process.env.BPMN_NAMING = broken;
  errors = [];
  realError = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
});
afterEach(() => {
  console.error = realError;
  if (before === undefined) delete process.env.BPMN_NAMING; else process.env.BPMN_NAMING = before;
});

describe('publicNamingMessage', () => {
  test('is the public text of a NamingDataError, also through cause; null for any other error', () => {
    const err = new NamingDataError('naming data "/x/y.json": nope');
    expect(err.publicMessage).toBe(PUBLIC);
    expect(publicNamingMessage(err)).toBe(PUBLIC);
    expect(publicNamingMessage(new Error('wrapped', { cause: err }))).toBe(PUBLIC);
    expect(publicNamingMessage(new Error('other'))).toBeNull();
    expect(publicNamingMessage(null)).toBeNull();
    expect(namingDataErrorOf(new Error('wrapped', { cause: err }))).toBe(err);
  });
});

describe('orchestrate (library): an LLM-amended model with language meets the broken overlay', () => {
  const run = () => {
    const lc = fixture('simple-approval.json');
    const amended = { ...JSON.parse(JSON.stringify(lc)), language: 'en' };
    const llm = async (_s, user) => (String(user).startsWith('SVG diagram') ? structural : JSON.stringify(amended));
    return orchestrate(JSON.parse(JSON.stringify(lc)), { llmProvider: llm, enableLayoutReview: true, maxLayoutIterations: 3 });
  };

  test('the amend error in history is the public text; no path anywhere in the result; the detail goes to stderr', async () => {
    const result = await run();
    const entry = result.history.find((h) => h.agent === 'modeler' && h.phase === 'amend' && h.error);
    expect(entry.error).toBe(PUBLIC);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(broken);
    expect(serialised).not.toContain('broken-overlay');
    expect(errors.some((l) => l.includes(broken))).toBe(true);
    expect(result.bpmnXml).toMatch(/definitions/); // the run keeps the model and layout it had
  }, 60_000);
});

describe('orchestrate (library): the compliance catch', () => {
  test('a NamingDataError there gives the public text in compliance and history, not the path', async () => {
    jest.resetModules();
    // After the reset the orchestrator has its own naming module: the error must be of its class.
    const { NamingDataError: FreshError } = await import('./bpmn/naming/lexicon.js');
    const detail = new FreshError(`naming data "${broken}": not valid JSON`);
    jest.unstable_mockModule('./agents/compliance.js', () => ({
      complianceAgent: async () => { throw new Error('compliance wrapper', { cause: detail }); },
    }));
    const { orchestrate: mockedOrchestrate } = await import('./orchestrator.js');
    const result = await mockedOrchestrate(fixture('simple-approval.json'));
    expect(result.compliance).toEqual({ isCompliant: false, errors: [`Compliance check failed: ${PUBLIC}`], warnings: [] });
    expect(JSON.stringify(result)).not.toContain(broken);
    expect(errors.some((l) => l.includes(broken))).toBe(true);
  }, 60_000);
});

describe('HTTP /api/v1/orchestrate', () => {
  let base;
  beforeAll(async () => {
    await new Promise((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  test('text input through an LLM: the language-bearing model meets the overlay in the reviewer; 500 with the public text only', async () => {
    _resetRateLimit();
    const realFetch = global.fetch;
    const model = { ...fixture('simple-approval.json'), language: 'en' };
    // The operator's own LLM config (env) is not checked against private addresses.
    process.env.OPENAI_API_KEY = 'env-key';
    global.fetch = async (url, init) => (String(url).startsWith(base)
      ? realFetch(url, init)
      : { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(model) } }] }) });
    try {
      const res = await realFetch(`${base}/api/v1/orchestrate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userText: 'An approval process', correlationId: 'orch-naming-1' }),
      });
      const text = await res.text();
      // (a 400 would mean the route refused the LLM config before orchestrate ran)
      expect(res.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ correlationId: 'orch-naming-1', status: 'internal_error', error: PUBLIC });
      expect(text).not.toContain(broken);
      expect(errors.some((l) => l.includes(broken))).toBe(true);
    } finally {
      global.fetch = realFetch;
      delete process.env.OPENAI_API_KEY;
    }
  }, 60_000);
});

describe('MCP orchestrate_bpmn', () => {
  test('a model with language: the tool error is the public text; a model without language works', async () => {
    const call = (lc) => handleToolCall({ params: { name: 'orchestrate_bpmn', arguments: { logicCore: lc } } });
    const err = await call({ ...fixture('simple-approval.json'), language: 'en' }).then(() => null, (e) => e);
    expect(err.message).toBe(PUBLIC);
    expect(JSON.stringify({ message: err.message, stack: undefined })).not.toContain(broken);
    expect(errors.some((l) => l.includes(broken))).toBe(true);
    const ok = JSON.parse((await call(fixture('simple-approval.json'))).content[0].text);
    expect(JSON.stringify(ok)).not.toContain(broken);
    expect(ok.validation.errors).toEqual([]);
  }, 60_000);
});
