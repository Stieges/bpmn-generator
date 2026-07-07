/**
 * Orchestrator + Agent Unit Tests
 * Tests agent contracts, state machine convergence, and iteration limits.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../tests/fixtures');

function loadFixture(name) {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));
}

// ═══════════════════════════════════════════════════════════════
// §1  Reviewer Agent
// ═══════════════════════════════════════════════════════════════

import { reviewerAgent } from './agents/reviewer.js';

describe('reviewerAgent', () => {
  test('valid LogicCore → isValid: true, no errors', async () => {
    const lc = loadFixture('simple-approval.json');
    const result = await reviewerAgent({ logicCore: lc });
    expect(result.isValid).toBe(true);
    expect(result.done).toBe(true);
    expect(result.reviewIssues.filter(i => i.severity === 'ERROR')).toHaveLength(0);
  });

  test('multi-pool LogicCore → isValid: true', async () => {
    const lc = loadFixture('multi-pool-collaboration.json');
    const result = await reviewerAgent({ logicCore: lc });
    expect(result.isValid).toBe(true);
  });

  test('broken LogicCore → issues with severity', async () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'Test',
        lanes: [{ id: 'L1', name: 'Lane', nodeIds: ['t1'] }],
      }],
      nodes: [{ id: 't1', type: 'task', label: 'Do stuff' }],
      edges: [],
    };
    const result = await reviewerAgent({ logicCore: lc });
    expect(result.isValid).toBe(false);
    expect(result.done).toBe(false);
    expect(result.reviewIssues.length).toBeGreaterThan(0);
    expect(result.reviewIssues[0]).toHaveProperty('severity');
    expect(result.reviewIssues[0]).toHaveProperty('problem');
  });
});

// ═══════════════════════════════════════════════════════════════
// §2  Compliance Agent
// ═══════════════════════════════════════════════════════════════

import { complianceAgent } from './agents/compliance.js';

describe('complianceAgent', () => {
  test('valid LogicCore → isCompliant: true', async () => {
    const lc = loadFixture('simple-approval.json');
    const result = await complianceAgent({ logicCore: lc, options: {} });
    expect(result.compliance).toBeDefined();
    expect(result.compliance.isCompliant).toBe(true);
    expect(result.compliance.errors).toHaveLength(0);
    expect(result.done).toBe(true);
  });

  test('compliance result has expected shape', async () => {
    const lc = loadFixture('simple-approval.json');
    const result = await complianceAgent({ logicCore: lc, options: {} });
    const c = result.compliance;
    expect(c).toHaveProperty('errors');
    expect(c).toHaveProperty('warnings');
    expect(c).toHaveProperty('violations');
    expect(c).toHaveProperty('isCompliant');
    expect(Array.isArray(c.violations)).toBe(true);
  });

  test('always returns done: true (never loops)', async () => {
    const lc = { pools: [], nodes: [], edges: [] };
    const result = await complianceAgent({ logicCore: lc, options: {} });
    expect(result.done).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// §3  Layout Agent
// ═══════════════════════════════════════════════════════════════

import { layoutAgent } from './agents/layout.js';

describe('layoutAgent', () => {
  test('generates BPMN XML + SVG from valid LogicCore', async () => {
    const lc = loadFixture('simple-approval.json');
    const result = await layoutAgent({ logicCore: lc, options: {} });
    expect(result.bpmnXml).toBeDefined();
    expect(result.bpmnXml).toMatch(/definitions/);
    expect(result.svg).toBeDefined();
    expect(result.svg).toContain('<svg');
    expect(result.done).toBe(true);
    expect(result.layoutFeedback).toEqual([]);
  });

  test('without enableLayoutReview → done: true, no feedback', async () => {
    const lc = loadFixture('multi-pool-collaboration.json');
    const result = await layoutAgent({ logicCore: lc, options: {} });
    expect(result.done).toBe(true);
    expect(result.layoutFeedback).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// §4  Modeler Agent (prompt construction only — no LLM call)
// ═══════════════════════════════════════════════════════════════

import { modelerAgent } from './agents/modeler.js';

describe('modelerAgent', () => {
  test('throws without llmProvider', async () => {
    await expect(modelerAgent({ userText: 'test', options: {} }))
      .rejects.toThrow('llmProvider');
  });

  test('extract mode: calls LLM and returns logicCore', async () => {
    const mockLc = loadFixture('simple-approval.json');
    const mockLlm = async () => JSON.stringify(mockLc);

    const result = await modelerAgent({
      userText: 'Simple approval process',
      options: { llmProvider: mockLlm },
    });
    expect(result.logicCore).toBeDefined();
    expect(result.mode).toBe('extract');
  });

  test('refine mode: triggered by reviewIssues', async () => {
    const mockLc = loadFixture('simple-approval.json');
    const mockLlm = async () => JSON.stringify(mockLc);

    const result = await modelerAgent({
      logicCore: mockLc,
      reviewIssues: [{ severity: 'ERROR', problem: 'Missing end event' }],
      options: { llmProvider: mockLlm },
    });
    expect(result.mode).toBe('refine');
  });

  test('amend mode: triggered by layoutFeedback', async () => {
    const mockLc = loadFixture('simple-approval.json');
    const mockLlm = async () => JSON.stringify(mockLc);

    const result = await modelerAgent({
      logicCore: mockLc,
      layoutFeedback: [{ issue: 'Overlap', suggestion: 'Move node', requiresLogicCoreChange: true }],
      options: { llmProvider: mockLlm },
    });
    expect(result.mode).toBe('amend');
  });

  test('extracts JSON from fenced code block', async () => {
    const mockLc = loadFixture('simple-approval.json');
    const mockLlm = async () => '```json\n' + JSON.stringify(mockLc) + '\n```';

    const result = await modelerAgent({
      userText: 'test',
      options: { llmProvider: mockLlm },
    });
    expect(result.logicCore).toEqual(mockLc);
  });

  test.each([
    ['process', (lc) => ({ process: lc })],
    ['data', (lc) => ({ data: lc })],
    ['result', (lc) => ({ result: lc })],
    ['processes array', (lc) => ({ processes: [lc] })],
  ])('unwraps LLM envelope: %s', async (_label, wrap) => {
    const mockLc = loadFixture('simple-approval.json');
    const mockLlm = async () => JSON.stringify(wrap(mockLc));

    const result = await modelerAgent({
      userText: 'test',
      options: { llmProvider: mockLlm },
    });
    expect(result.logicCore).toEqual(mockLc);
  });

  test('passes through an unwrapped root unchanged', async () => {
    const mockLc = loadFixture('simple-approval.json');
    const mockLlm = async () => JSON.stringify(mockLc);

    const result = await modelerAgent({
      userText: 'test',
      options: { llmProvider: mockLlm },
    });
    expect(result.logicCore).toEqual(mockLc);
  });
});

// ═══════════════════════════════════════════════════════════════
// §5  Orchestrator — State Machine
// ═══════════════════════════════════════════════════════════════

import { orchestrate } from './orchestrator.js';

describe('orchestrate', () => {
  test('LogicCore input without LLM → review + pipeline + compliance', async () => {
    const lc = loadFixture('simple-approval.json');
    const result = await orchestrate(lc);

    expect(result.bpmnXml).toBeDefined();
    expect(result.svg).toBeDefined();
    expect(result.compliance).toBeDefined();
    expect(result.history.length).toBeGreaterThanOrEqual(3); // reviewer + layout + compliance
    expect(result.history.some(h => h.agent === 'reviewer')).toBe(true);
    expect(result.history.some(h => h.agent === 'layout')).toBe(true);
    expect(result.history.some(h => h.agent === 'compliance')).toBe(true);
  });

  test('valid LogicCore converges in 1 review iteration', async () => {
    const lc = loadFixture('simple-approval.json');
    const result = await orchestrate(lc);

    const reviewEntries = result.history.filter(h => h.agent === 'reviewer');
    expect(reviewEntries).toHaveLength(1);
    expect(reviewEntries[0].isValid).toBe(true);
  });

  test('multi-pool LogicCore → full pipeline succeeds', async () => {
    const lc = loadFixture('multi-pool-collaboration.json');
    const result = await orchestrate(lc);

    expect(result.bpmnXml).toMatch(/definitions/);
    expect(result.svg).toContain('<svg');
    expect(result.compliance).toBeDefined();
  });

  test('throws without logicCore or text+llm', async () => {
    await expect(orchestrate(null)).rejects.toThrow('No logicCore');
  });

  test('text input without LLM → throws', async () => {
    await expect(orchestrate('Some process text')).rejects.toThrow('No logicCore');
  });

  test('text input with mock LLM → full cycle', async () => {
    const mockLc = loadFixture('simple-approval.json');
    const mockLlm = async () => JSON.stringify(mockLc);

    const result = await orchestrate('Simple approval process', { llmProvider: mockLlm });

    expect(result.bpmnXml).toBeDefined();
    expect(result.compliance).toBeDefined();

    const modelerEntries = result.history.filter(h => h.agent === 'modeler');
    expect(modelerEntries.length).toBeGreaterThanOrEqual(1);
    expect(modelerEntries[0].phase).toBe('extract');
  });

  test('history entries have timestamps', async () => {
    const lc = loadFixture('simple-approval.json');
    const result = await orchestrate(lc);

    for (const entry of result.history) {
      expect(entry.ts).toBeDefined();
      expect(new Date(entry.ts).getTime()).not.toBeNaN();
    }
  });

  test('respects maxReviewIterations option', async () => {
    // Schema-valid Logic-Core that still fails the rule engine
    // (no StartEvent, no EndEvent → S01/S02 will keep flagging issues).
    const unsoundLc = {
      nodes: [{ id: 't1', type: 'task', name: 'Do stuff' }],
      edges: [],
    };

    // Mock LLM that always returns the same unsound LC
    const mockLlm = async () => JSON.stringify(unsoundLc);

    const result = await orchestrate(unsoundLc, {
      llmProvider: mockLlm,
      maxReviewIterations: 2,
    });

    const reviewEntries = result.history.filter(h => h.agent === 'reviewer');
    expect(reviewEntries.length).toBeLessThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// §6  LLM Provider (unit)
// ═══════════════════════════════════════════════════════════════

import { createLlmProvider } from './agents/llm-provider.js';

describe('createLlmProvider', () => {
  test('returns a function', () => {
    const provider = createLlmProvider({
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'test-key',
      model: 'test-model',
    });
    expect(typeof provider).toBe('function');
  });

  test('legacy (systemPrompt, userPrompt) call shape sends a 2-message array', async () => {
    let capturedBody;
    global.fetch = jest.fn(async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      };
    });

    const provider = createLlmProvider({
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'test-key',
      model: 'test-model',
    });
    await provider('system text', 'user text');

    expect(capturedBody.messages).toEqual([
      { role: 'system', content: 'system text' },
      { role: 'user', content: 'user text' },
    ]);
  });

  test('multi-turn (messages[], options) call shape sends messages verbatim', async () => {
    let capturedBody;
    global.fetch = jest.fn(async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      };
    });

    const provider = createLlmProvider({
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'test-key',
      model: 'test-model',
    });
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'user', content: 'turn 2' },
    ];
    await provider(messages, { temperature: 0.5 });

    expect(capturedBody.messages).toEqual(messages);
    expect(capturedBody.temperature).toBe(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════
// §7  Chat Agent (Discovery conversation, pre-generation)
// ═══════════════════════════════════════════════════════════════

import { chatAgent } from './agents/chat.js';

describe('chatAgent', () => {
  test('throws without llmProvider', async () => {
    await expect(chatAgent({ messages: [{ role: 'user', content: 'hi' }] }))
      .rejects.toThrow('llmProvider');
  });

  test('throws without a non-empty messages array', async () => {
    await expect(chatAgent({ messages: [], llmProvider: async () => '{}' }))
      .rejects.toThrow('messages');
  });

  test('sends the discovery system prompt plus the conversation to the llmProvider', async () => {
    let capturedMessages;
    const mockLlm = async (messages) => {
      capturedMessages = messages;
      return JSON.stringify({ reply: 'Wie viele Beteiligte gibt es?', readyToGenerate: false, suggestedSummary: null });
    };

    await chatAgent({
      messages: [{ role: 'user', content: 'Ich will einen Genehmigungsprozess.' }],
      llmProvider: mockLlm,
    });

    expect(capturedMessages[0].role).toBe('system');
    expect(capturedMessages[0].content).toContain('readyToGenerate');
    expect(capturedMessages[1]).toEqual({ role: 'user', content: 'Ich will einen Genehmigungsprozess.' });
  });

  test('returns parsed reply, readyToGenerate and suggestedSummary', async () => {
    const mockLlm = async () => JSON.stringify({
      reply: 'Ich habe alles was ich brauche.',
      readyToGenerate: true,
      suggestedSummary: 'Kunde sendet Antrag, Sachbearbeiter prüft.',
    });

    const result = await chatAgent({
      messages: [{ role: 'user', content: 'Das reicht, generier es.' }],
      llmProvider: mockLlm,
    });

    expect(result).toEqual({
      reply: 'Ich habe alles was ich brauche.',
      readyToGenerate: true,
      suggestedSummary: 'Kunde sendet Antrag, Sachbearbeiter prüft.',
    });
  });

  test('defaults readyToGenerate to false and suggestedSummary to null when omitted', async () => {
    const mockLlm = async () => JSON.stringify({ reply: 'Wer ist beteiligt?' });

    const result = await chatAgent({
      messages: [{ role: 'user', content: 'Hallo' }],
      llmProvider: mockLlm,
    });

    expect(result.readyToGenerate).toBe(false);
    expect(result.suggestedSummary).toBeNull();
  });

  test('extracts JSON from a fenced code block', async () => {
    const mockLlm = async () => '```json\n' + JSON.stringify({ reply: 'ok', readyToGenerate: false, suggestedSummary: null }) + '\n```';

    const result = await chatAgent({
      messages: [{ role: 'user', content: 'Hallo' }],
      llmProvider: mockLlm,
    });

    expect(result.reply).toBe('ok');
  });

  test('throws a clear error when the LLM response is not valid JSON', async () => {
    const mockLlm = async () => 'Sure, here is my answer: not json at all';

    await expect(chatAgent({
      messages: [{ role: 'user', content: 'Hallo' }],
      llmProvider: mockLlm,
    })).rejects.toThrow('Chat agent');
  });
});
