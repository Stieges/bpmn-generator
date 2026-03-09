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
    expect(result.bpmnXml).toContain('<definitions');
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

    expect(result.bpmnXml).toContain('<definitions');
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
    // Use broken logicCore that will always fail review
    const brokenLc = {
      pools: [{
        id: 'P1', name: 'Test',
        lanes: [{ id: 'L1', name: 'Lane', nodeIds: ['t1'] }],
      }],
      nodes: [{ id: 't1', type: 'task', label: 'Do stuff' }],
      edges: [],
    };

    // Mock LLM that always returns the same broken LC
    const mockLlm = async () => JSON.stringify(brokenLc);

    const result = await orchestrate(brokenLc, {
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
});
