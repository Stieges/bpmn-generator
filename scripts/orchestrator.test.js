/**
 * Orchestrator + Agent Unit Tests
 * Tests agent contracts, state machine convergence, and iteration limits.
 */

import { describe, test, expect, jest } from '@jest/globals';

// Several tests replace global.fetch; the redirect test needs the real one.
const realFetch = global.fetch;
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

// Every Logic-Core the Modeler returns passes the schema gate — extract, refine and amend alike —
// and a rejected one gets maxSchemaRepairs (default 1) repair attempts with the gate's errors.
describe('orchestrate — schema gate on every Modeler output', () => {
  // An external partner as a pool with no nodes, and a message flow named with `label`: what an LLM
  // following the old collaboration example produced.
  const badCollab = {
    pools: [
      { id: 'Pool_Bank', name: 'Bank', nodes: [{ id: 'start', type: 'startEvent', name: 'Application received', marker: 'message' },
        { id: 'end', type: 'endEvent', name: 'Done' }], edges: [{ id: 'f1', source: 'start', target: 'end' }] },
      { id: 'Pool_Customer', name: 'Customer', nodes: [], edges: [] },
    ],
    messageFlows: [{ id: 'mf1', source: 'Pool_Customer', target: 'start', label: 'Application' }],
  };
  const goodCollab = {
    pools: [badCollab.pools[0]],
    collapsedPools: [{ id: 'Pool_Customer', name: 'Customer' }],
    messageFlows: [{ id: 'mf1', source: 'Pool_Customer', target: 'start', name: 'Application' }],
  };
  // Answers in order, then the last one again; records every system prompt it was given.
  const scripted = (...answers) => {
    const prompts = [];
    const llm = async (systemPrompt) => {
      prompts.push(systemPrompt);
      return JSON.stringify(answers[Math.min(prompts.length - 1, answers.length - 1)]);
    };
    return { llm, prompts };
  };

  test('extract rejected, the repair attempt valid: the run succeeds with the repaired model', async () => {
    const { llm, prompts } = scripted(badCollab, goodCollab);
    const result = await orchestrate('A bank receives a credit application from a customer.', { llmProvider: llm });
    expect(result.logicCore.collapsedPools).toEqual(goodCollab.collapsedPools);
    expect(result.bpmnXml).toMatch(/definitions/);
    expect(result.history.find((h) => h.agent === 'schema-gate')).toMatchObject({ phase: 'extract', attempt: 0 });
    expect(result.history.some((h) => h.agent === 'modeler' && h.phase === 'schema-repair')).toBe(true);
    // The repair prompt is the refinement prompt, carrying the invalid JSON and the real causes.
    expect(prompts[1]).toContain('/messageFlows/0: must NOT have additional properties (label)');
    expect(prompts[1]).toContain('/pools/1/nodes: must NOT have fewer than 1 items');
    expect(prompts[1]).toContain('"Pool_Customer"');
  });

  test('extract still rejected after the repair: abort, naming the real causes only', async () => {
    const { llm, prompts } = scripted(badCollab);
    const err = await orchestrate('text', { llmProvider: llm }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('Logic-Core failed schema validation');
    expect(err.message).toContain('/messageFlows/0');
    expect(err.message).toContain('/pools/1/nodes');
    expect(err.message).not.toContain("required property 'nodes'");
    expect(prompts).toHaveLength(2);
  });

  test('maxSchemaRepairs: 0 aborts on the first rejection', async () => {
    const { llm, prompts } = scripted(badCollab);
    await expect(orchestrate('text', { llmProvider: llm, maxSchemaRepairs: 0 })).rejects.toThrow('failed schema validation');
    expect(prompts).toHaveLength(1);
  });

  test('a refinement the gate rejects is not used: the last valid model goes on to layout', async () => {
    // Schema-valid but unsound (no start or end event), so the reviewer asks for a refinement; the
    // LLM answers with an invalid collaboration every time.
    const unsound = { nodes: [{ id: 't1', type: 'task', name: 'Do stuff' }], edges: [] };
    const { llm } = scripted(badCollab);
    const result = await orchestrate(JSON.parse(JSON.stringify(unsound)), { llmProvider: llm, maxReviewIterations: 2 });
    expect(result.logicCore).toEqual(unsound);
    expect(result.history.some((h) => h.agent === 'schema-gate' && h.phase === 'refine')).toBe(true);
    expect(result.history.some((h) => h.agent === 'modeler' && h.phase === 'refine' && h.error)).toBe(true);
    expect(result.history.some((h) => h.agent === 'layout')).toBe(true);
    expect(result.compliance).toBeDefined();
  });

  test('an amendment the gate rejects is not used either', async () => {
    // The layout review asks for a structural change; every amendment comes back invalid.
    const lc = loadFixture('simple-approval.json');
    const llm = async (_system, user) => (String(user).startsWith('SVG diagram')
      ? JSON.stringify({ feedback: [{ issue: 'Too long', suggestion: 'Split it', requiresLogicCoreChange: true }] })
      : JSON.stringify(badCollab));
    const result = await orchestrate(JSON.parse(JSON.stringify(lc)), { llmProvider: llm, enableLayoutReview: true });
    expect(result.logicCore).toEqual(lc);
    expect(result.history.some((h) => h.agent === 'schema-gate' && h.phase === 'amend')).toBe(true);
    expect(result.history.some((h) => h.agent === 'modeler' && h.phase === 'amend' && h.error)).toBe(true);
    expect(result.bpmnXml).toMatch(/definitions/);
  });

  test('a Logic-Core passed in directly is not repaired: the gate rejects it with the real causes', async () => {
    const err = await orchestrate(JSON.parse(JSON.stringify(badCollab))).catch((e) => e);
    expect(err.message).toContain('Logic-Core failed schema validation');
    expect(err.message).toContain('/messageFlows/0');
    expect(err.message).not.toContain("required property 'nodes'");
  });
});

// The layout loop and the profile the agents judge by. What orchestrate returns must be one model:
// the logicCore that was laid out into bpmnXml and judged by the reviewer and compliance alike.
describe('orchestrate — a lanes view on a 1.x model', () => {
  test('rejects with the bare ViewRejectedError, not a wrapped layout failure', async () => {
    const { loadNamedView } = await import('./shared/view.js');
    let err;
    try { await orchestrate(loadFixture('simple-approval.json'), { view: loadNamedView('rollen') }); } catch (e) { err = e; }
    expect(err?.name).toBe('ViewRejectedError');
    expect(err.message).toBe('view "rollen" forms lanes from assignments; this model (format 1.x) carries its own lanes — translate it with node bpmn/migrate.js');
  });
});

describe('orchestrate — layout loop and rule profile', () => {
  const structuralFeedback = JSON.stringify({ feedback: [{ issue: 'Too long', suggestion: 'Split it', requiresLogicCoreChange: true }] });
  const renamed = (lc, name) => {
    const copy = JSON.parse(JSON.stringify(lc));
    const task = copy.pools[0].nodes.find((n) => /Task$|^task$/.test(n.type));
    task.name = name;
    return copy;
  };

  test('no amendment after the last layout pass: the returned model is the laid-out one', async () => {
    const lc = loadFixture('simple-approval.json');
    let amendments = 0;
    const llm = async (_s, user) => {
      if (String(user).startsWith('SVG diagram')) return structuralFeedback;
      amendments++;
      return JSON.stringify(renamed(lc, `Antrag bearbeiten ${amendments}`));
    };
    const result = await orchestrate(JSON.parse(JSON.stringify(lc)), { llmProvider: llm, enableLayoutReview: true, maxLayoutIterations: 2 });
    expect(amendments).toBe(1);
    expect(result.history.filter((h) => h.agent === 'layout')).toHaveLength(2);
    expect(result.bpmnXml).toContain('Antrag bearbeiten 1');
    expect(JSON.stringify(result.logicCore)).toContain('Antrag bearbeiten 1');
  });

  test('an amendment the reviewer rejects is dropped, and the earlier model and layout stay', async () => {
    const lc = loadFixture('simple-approval.json');
    // Schema-valid, but without its end events: unsound.
    const broken = JSON.parse(JSON.stringify(lc));
    broken.pools[0].nodes = broken.pools[0].nodes.filter((n) => n.type !== 'endEvent');
    const endIds = new Set(lc.pools[0].nodes.filter((n) => n.type === 'endEvent').map((n) => n.id));
    broken.pools[0].edges = broken.pools[0].edges.filter((e) => !endIds.has(e.target));
    const llm = async (_s, user) => (String(user).startsWith('SVG diagram') ? structuralFeedback : JSON.stringify(broken));
    const result = await orchestrate(JSON.parse(JSON.stringify(lc)), { llmProvider: llm, enableLayoutReview: true, maxLayoutIterations: 3 });
    expect(result.logicCore).toEqual(lc);
    expect(result.bpmnXml).toMatch(/endEvent/);
    expect(result.history.some((h) => h.agent === 'reviewer' && h.phase === 'amend' && h.isValid === false)).toBe(true);
    expect(result.compliance.isCompliant).toBe(true);
  });

  test.each([
    ['an object instead of an array', JSON.stringify({ feedback: { issue: 'x', suggestion: 'y', requiresLogicCoreChange: true } })],
    ['prose', 'The layout looks fine to me.'],
  ])('a layout review answering %s does not break the run, and history says so', async (_, answer) => {
    const lc = loadFixture('simple-approval.json');
    const llm = async () => answer;
    const result = await orchestrate(JSON.parse(JSON.stringify(lc)), { llmProvider: llm, enableLayoutReview: true });
    expect(result.bpmnXml).toMatch(/definitions/);
    expect(result.history.find((h) => h.agent === 'layout').reviewError).toEqual(expect.any(String));
  });

  test('requiresLogicCoreChange "false" (a string) is not a structural change', async () => {
    const lc = loadFixture('simple-approval.json');
    let amendments = 0;
    const llm = async (_s, user) => {
      if (String(user).startsWith('SVG diagram')) {
        return JSON.stringify({ feedback: [{ issue: 'x', suggestion: 'y', requiresLogicCoreChange: 'false' }] });
      }
      amendments++;
      return JSON.stringify(lc);
    };
    await orchestrate(JSON.parse(JSON.stringify(lc)), { llmProvider: llm, enableLayoutReview: true });
    expect(amendments).toBe(0);
  });

  test('reviewer, layout and compliance judge by the same profile', async () => {
    // A decision gateway named without a question mark: M02, a WARNING by default, an ERROR in the
    // strict profile. Before, the reviewer and the layout validation used the default profile and
    // only compliance the caller's — so validation said "fine", compliance said "not compliant", and
    // the refinement loop, which listens to the reviewer, never ran.
    const lc = loadFixture('simple-approval.json');
    const gw = lc.pools[0].nodes.find((n) => n.type === 'exclusiveGateway');
    gw.name = 'Entscheidung';
    const strict = JSON.parse(readFileSync(resolve(__dirname, '../rules/strict-profile.json'), 'utf8'));
    const review = await reviewerAgent({ logicCore: lc, options: { ruleProfile: strict } });
    expect(review.isValid).toBe(false);
    const result = await orchestrate(JSON.parse(JSON.stringify(lc)), { ruleProfile: strict });
    const m02 = (list) => list.some((m) => m.includes('should be a question'));
    expect(m02(result.validation.errors)).toBe(true);
    expect(m02(result.compliance.errors)).toBe(true);
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

// Retry against an unstable endpoint (config.json → llm.retry): transport errors and the statuses
// in `statuses` are tried again with exponential backoff, honouring Retry-After up to a cap; other
// failures are not. `request`, `sleep` and `random` are injected, so nothing waits.
describe('createLlmProvider — retry', () => {
  const okResponse = (content = 'ok') => ({ ok: true, status: 200, headers: new Map(), json: async () => ({ choices: [{ message: { content } }] }) });
  const failResponse = (status, headers = {}) => ({ ok: false, status, headers: new Map(Object.entries(headers)), text: async () => 'upstream body' });
  const scriptedRequest = (...steps) => {
    const calls = [];
    const request = async (url, init) => {
      calls.push(JSON.parse(init.body));
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      if (step instanceof Error) throw step;
      return step;
    };
    return { request, calls };
  };
  const make = (request, extra = {}) => {
    const sleeps = [];
    const provider = createLlmProvider({ baseUrl: 'http://localhost:1234/v1', apiKey: 'k', model: 'm', request,
      sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5,
      retry: { retries: 3, baseDelayMs: 1000, maxDelayMs: 30000, retryAfterMaxMs: 60000, statuses: [408, 429, 500, 502, 503, 504] },
      ...extra });
    return { provider, sleeps };
  };

  test('502, 502, 200: the answer arrives after two waits that grow', async () => {
    const { request, calls } = scriptedRequest(failResponse(502), failResponse(502), okResponse('done'));
    const { provider, sleeps } = make(request);
    expect(await provider('s', 'u')).toBe('done');
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]);
  });

  test('429 with Retry-After waits as long as the endpoint asks, up to the cap', async () => {
    const short = scriptedRequest(failResponse(429, { 'retry-after': '7' }), okResponse());
    const a = make(short.request);
    await a.provider('s', 'u');
    expect(a.sleeps).toEqual([7000]);
    const long = scriptedRequest(failResponse(429, { 'retry-after': '3600' }), okResponse());
    const b = make(long.request);
    await b.provider('s', 'u');
    expect(b.sleeps).toEqual([60000]);
  });

  test('503 every time: LlmProviderError after retries + 1 attempts, the body not in the message', async () => {
    const { LlmProviderError } = await import('./agents/llm-provider.js');
    const { request, calls } = scriptedRequest(failResponse(503));
    const { provider } = make(request);
    const err = await provider('s', 'u').catch((e) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect(err.status).toBe(503);
    expect(err.attempts).toBe(4);
    expect(calls).toHaveLength(4);
    expect(err.message).toBe('LLM endpoint returned 503 (4 attempts)');
    expect(err.message).not.toContain('upstream body');
  });

  test.each([400, 401, 404])('%i is not retried', async (status) => {
    const { request, calls } = scriptedRequest(failResponse(status));
    const { provider, sleeps } = make(request);
    await expect(provider('s', 'u')).rejects.toThrow(`returned ${status}`);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  test('a transport error is retried', async () => {
    const { request, calls } = scriptedRequest(new Error('ECONNRESET'), okResponse('back'));
    const { provider } = make(request);
    expect(await provider('s', 'u')).toBe('back');
    expect(calls).toHaveLength(2);
  });

  test('retries: 0 makes one attempt', async () => {
    const { request, calls } = scriptedRequest(failResponse(502), okResponse());
    const { provider } = make(request, { retry: { retries: 0 } });
    await expect(provider('s', 'u')).rejects.toThrow('returned 502');
    expect(calls).toHaveLength(1);
  });

  test('onRetry hears every retry', async () => {
    const seen = [];
    const { request } = scriptedRequest(failResponse(502), okResponse());
    const { provider } = make(request, { onRetry: (r) => seen.push(r) });
    await provider('s', 'u');
    expect(seen).toEqual([{ attempt: 1, retries: 3, status: 502, delayMs: expect.any(Number) }]);
  });

  test('extraBody goes into the request, and cannot replace model or messages', async () => {
    const { request, calls } = scriptedRequest(okResponse());
    const { provider } = make(request, { extraBody: { chat_template_kwargs: { enable_thinking: false }, model: 'other', messages: [] } });
    await provider('s', 'u');
    expect(calls[0].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(calls[0].model).toBe('m');
    expect(calls[0].messages).toHaveLength(2);
  });

  test('an answer with only reasoning content says so', async () => {
    const { request } = scriptedRequest({ ok: true, status: 200, headers: new Map(),
      json: async () => ({ choices: [{ message: { content: null, reasoning_content: 'thinking…' } }] }) });
    const { provider } = make(request);
    await expect(provider('s', 'u')).rejects.toThrow(/only reasoning content/);
  });
});

describe('createLlmProvider — failures', () => {
  test('a non-2xx answer throws LlmProviderError carrying the status, not the body in the message', async () => {
    const { LlmProviderError } = await import('./agents/llm-provider.js');
    global.fetch = jest.fn(async () => ({ ok: false, status: 503, text: async () => 'upstream secret detail' }));
    const provider = createLlmProvider({ baseUrl: 'http://localhost:1234/v1', apiKey: 'k', model: 'm', retry: { retries: 0 } });
    const err = await provider('s', 'u').catch((e) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect(err.status).toBe(503);
    expect(err.message).not.toContain('secret');
  });

  test('the orchestrator keeps the provider error as the cause', async () => {
    const { LlmProviderError } = await import('./agents/llm-provider.js');
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, text: async () => 'x' }));
    const llmProvider = createLlmProvider({ baseUrl: 'http://localhost:1234/v1', apiKey: 'k', model: 'm', retry: { retries: 0 } });
    const err = await orchestrate('text', { llmProvider }).catch((e) => e);
    expect(err.cause).toBeInstanceOf(LlmProviderError);
  });
});

describe('createLlmProvider — redirects', () => {
  test('the default transport does not follow a redirect; a 3xx is a provider error', async () => {
    const { createServer } = await import('node:http');
    const { LlmProviderError } = await import('./agents/llm-provider.js');
    const hits = [];
    const listen = (handler) => new Promise((done) => { const s = createServer(handler); s.listen(0, '127.0.0.1', () => done(s)); });
    const target = await listen((req, res) => { hits.push(req.url); req.resume(); res.end('{}'); });
    const redirector = await listen((req, res) => {
      req.resume();
      res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/followed` });
      res.end();
    });
    global.fetch = realFetch;
    try {
      const provider = createLlmProvider({ baseUrl: `http://127.0.0.1:${redirector.address().port}/v1`, apiKey: 'k', model: 'm', timeout: 5000 });
      const err = await provider('s', 'u').catch((e) => e);
      expect(err).toBeInstanceOf(LlmProviderError);
      expect(err.status).toBe(302);
      expect(hits).toEqual([]);
    } finally {
      await Promise.all([target, redirector].map((s) => new Promise((done) => s.close(done))));
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// A lanes view on a 1.x model is refused before any agent runs
// ═══════════════════════════════════════════════════════════════

describe('orchestrate — the view is loaded once and checked before any agent', () => {
  test.each([
    ['a view object', () => JSON.parse(readFileSync(resolve(__dirname, '../views/rollen-view.json'), 'utf8'))],
    ['a view path', () => resolve(__dirname, '../views/rollen-view.json')],
  ])('%s with lanes on a 1.x model: refused, reviewer never called', async (_, makeView) => {
    jest.resetModules();
    const reviewer = jest.fn(async () => ({ isValid: true, reviewIssues: [], done: true }));
    jest.unstable_mockModule('./agents/reviewer.js', () => ({ reviewerAgent: reviewer }));
    const { orchestrate: orchestrateMocked } = await import('./orchestrator.js');
    const { ViewRejectedError } = await import('./shared/view.js');
    const err = await orchestrateMocked(loadFixture('simple-approval.json'), { view: makeView() }).catch((e) => e);
    expect(err).toBeInstanceOf(ViewRejectedError);
    expect(err.message).toBe('view "rollen" forms lanes from assignments; this model (format 1.x) carries its own lanes — translate it with node bpmn/migrate.js');
    expect(reviewer).not.toHaveBeenCalled();
  });
});

describe('orchestrate — a bad view does not change the 1.x gate errors (as at base 45451f1)', () => {
  const rollen = () => JSON.parse(readFileSync(resolve(__dirname, '../views/rollen-view.json'), 'utf8'));

  test('schema-invalid 1.x Logic-Core + lanes view: the schema message, not the view error', async () => {
    const err = await orchestrate({ nodes: 'nope' }, { view: rollen() }).catch((e) => e);
    expect(err.name).not.toBe('ViewRejectedError');
    expect(err.message).toMatch(/^Logic-Core failed schema validation:\n/);
  });

  test('no input + bad view path: the "No logicCore" message, not a view error', async () => {
    const err = await orchestrate(null, { view: '/no/such/view.json' }).catch((e) => e);
    expect(err.message).toBe('No logicCore — provide text + llmProvider, or a logicCore object');
  });

  test.each([
    ['a bad view path', () => '/no/such/view.json'],
    ['a lanes view', rollen],
  ])('empty text + llmProvider + %s: the "No logicCore" message, not a view error', async (_, makeView) => {
    const llmProvider = jest.fn(async () => '{}');
    const err = await orchestrate('', { llmProvider, view: makeView() }).catch((e) => e);
    expect(err.message).toBe('No logicCore — provide text + llmProvider, or a logicCore object');
    expect(llmProvider).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// Format 2.0: reviewer, layout and compliance judge it; the modeler (1.x) is skipped
// ═══════════════════════════════════════════════════════════════

describe('orchestrate — a format 2.0 model', () => {
  const v2Dir = resolve(__dirname, '../tests/fixtures-v2');
  const readV2 = (name) => JSON.parse(readFileSync(resolve(v2Dir, name), 'utf8'));
  const schaden = () => readV2('schaden.json');
  const catalog = () => readV2('schaden-catalog.json');
  // The C01 model: the performer of "Schaden prüfen" is not in the catalogue.
  const withUnknownActor = () => {
    const m = schaden();
    m.nodes.find((n) => n.id === 'pruefen').assignments = [{ type: 'D', actor: 'niemand' }];
    return m;
  };
  const C01 = '[C01] node "pruefen": actor "niemand" is not in the catalogue';

  test('schaden with its catalogue and view rollen: the rollen golden, compliant, the 2.0 model returned', async () => {
    const { loadNamedView } = await import('./shared/view.js');
    const input = schaden();
    const result = await orchestrate(input, { catalog: catalog(), view: loadNamedView('rollen') });
    expect(result.bpmnXml).toBe(readFileSync(resolve(v2Dir, 'schaden.rollen.expected.bpmn'), 'utf8'));
    expect(result.compliance.isCompliant).toBe(true);
    expect(result.compliance.findings).toEqual(expect.any(Array));
    expect(result.logicCore).toEqual(schaden());
    expect(result.logicCore).toBe(input);
  });

  test('without a view: the role lanes', async () => {
    const result = await orchestrate(schaden(), { catalog: catalog() });
    for (const actor of ['sb_schaden', 'regress', 'zahlung']) {
      expect(result.bpmnXml).toContain(`<bpmn:lane id="L.Process_Schaden.${actor}"`);
    }
    expect(result.compliance.isCompliant).toBe(true);
  });

  test('a C01 model: the reviewer reports [C01], compliance is not compliant, no diagram', async () => {
    const result = await orchestrate(withUnknownActor(), { catalog: catalog() });
    const review = await reviewerAgent({ logicCore: withUnknownActor(), options: { catalog: catalog() } });
    expect(review.reviewIssues).toEqual([{ severity: 'ERROR', problem: C01 }]);
    expect(review.isValid).toBe(false);
    expect(result.history.find((h) => h.agent === 'reviewer')).toMatchObject({ isValid: false, issueCount: 1 });
    expect(result.compliance.isCompliant).toBe(false);
    expect(result.compliance.errors).toEqual([C01]);
    expect(result.compliance.findings).toEqual([{ code: 'C01', severity: 'ERROR', message: C01 }]);
    expect(result.bpmnXml).toBeNull();
  });

  test('with an LLM: no modeler call for the refinement, a skipped history entry', async () => {
    const llmProvider = jest.fn(async () => { throw new Error('the modeler must not be asked'); });
    const result = await orchestrate(withUnknownActor(), { catalog: catalog(), llmProvider });
    expect(llmProvider).not.toHaveBeenCalled();
    expect(result.history.filter((h) => h.agent === 'modeler')).toEqual([
      { agent: 'modeler', phase: 'refine', iteration: 0, skipped: 'format 2.0', ts: expect.any(String) },
    ]);
    expect(result.history.filter((h) => h.agent === 'reviewer')).toHaveLength(1);
  });

  test('with an LLM and structural layout feedback: only the layout review is asked, the amendment skipped', async () => {
    const prompts = [];
    const llmProvider = jest.fn(async (system) => {
      prompts.push(system);
      return JSON.stringify({ feedback: [{ issue: 'Too long', suggestion: 'Split it', requiresLogicCoreChange: true }] });
    });
    const result = await orchestrate(schaden(), { catalog: catalog(), llmProvider, enableLayoutReview: true });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/^You are a BPMN diagram layout reviewer/);
    expect(result.history.filter((h) => h.agent === 'modeler')).toEqual([
      { agent: 'modeler', phase: 'amend', iteration: 0, skipped: 'format 2.0', ts: expect.any(String) },
    ]);
    expect(result.logicCore).toEqual(schaden());
    expect(result.compliance.isCompliant).toBe(true);
  });

  test('a schema-invalid 2.0 model: the F01 gate errors', async () => {
    const err = await orchestrate({ ...schaden(), nodes: 'nope' }, { catalog: catalog() }).catch((e) => e);
    expect(err.message).toMatch(/^Logic-Core failed schema validation:\n\[F01\] /);
  });

  test('the catalog option as runPipeline takes it: an object, for 2.0 models only', async () => {
    await expect(orchestrate(schaden(), { catalog: 'schaden-catalog.json' }))
      .rejects.toThrow(new TypeError('catalog must be a catalogue object; read a file with loadCatalog'));
    await expect(orchestrate(loadFixture('simple-approval.json'), { catalog: catalog() }))
      .rejects.toThrow(new TypeError('catalog applies to format 2.0 models only'));
  });
});

describe('orchestrate — mode optimize or soll on a format 2.0 model', () => {
  test.each(['optimize', 'soll'])('mode %s: F04 before any agent, the reviewer never called', async (mode) => {
    jest.resetModules();
    const reviewer = jest.fn(async () => ({ isValid: true, reviewIssues: [], done: true }));
    jest.unstable_mockModule('./agents/reviewer.js', () => ({ reviewerAgent: reviewer }));
    const { orchestrate: orchestrateMocked } = await import('./orchestrator.js');
    const model = JSON.parse(readFileSync(resolve(__dirname, '../tests/fixtures-v2/schaden.json'), 'utf8'));
    const catalog = JSON.parse(readFileSync(resolve(__dirname, '../tests/fixtures-v2/schaden-catalog.json'), 'utf8'));
    const err = await orchestrateMocked(model, { catalog, mode }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(`[F04] mode "${mode}" is not available for format 2.0 models yet`);
    expect(err.messageCode).toBe('F04');
    expect(reviewer).not.toHaveBeenCalled();
  });
});

describe('orchestrator CLI — the catalogue of a format 2.0 model', () => {
  const V2 = resolve(__dirname, '../tests/fixtures-v2/schaden.json');
  const V1 = resolve(fixturesDir, 'simple-approval.json');
  const run = async (args) => {
    const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { spawnSync } = await import('node:child_process');
    const dir = mkdtempSync(resolve(tmpdir(), 'orch-cli-'));
    try {
      const out = resolve(dir, 'out');
      const res = spawnSync(process.execPath, [resolve(__dirname, 'orchestrator.js'), ...args, '--output', out], { encoding: 'utf8', cwd: dir });
      const xml = existsSync(`${out}.bpmn`) ? readFileSync(`${out}.bpmn`, 'utf8') : null;
      return { ...res, xml };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const tempFile = async (name, content) => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const file = resolve(mkdtempSync(resolve(tmpdir(), 'orch-cat-')), name);
    writeFileSync(file, content);
    return file;
  };
  const ROLE_LANES = ['sb_schaden', 'regress', 'zahlung'].map((id) => `id="L.Process_Schaden.${id}"`);

  test('the model\'s "catalog" field is read relative to the model file: COMPLIANT, role lanes', async () => {
    const res = await run(['--input', V2]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('— COMPLIANT');
    expect(res.stdout).not.toContain('[C13]');
    for (const lane of ROLE_LANES) expect(res.xml).toContain(lane);
    expect(res.xml).toContain('bg:catalog="sha256:');
  }, 60_000);

  test.each([['--catalog=<path>'], ['--catalog <path>']])('%s wins over the model\'s own field', async (form) => {
    const other = await tempFile('other.json', JSON.stringify({ scheme: 'demi', actors: [
      { id: 'sb_schaden', name: 'Andere Rolle', kind: 'role' }, { id: 'regress', name: 'Regress', kind: 'role' }, { id: 'zahlung', name: 'Zahlung', kind: 'role' }] }));
    const flag = form === '--catalog=<path>' ? [`--catalog=${other}`] : ['--catalog', other];
    const res = await run(['--input', V2, ...flag]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('— COMPLIANT');
    expect(res.xml).toContain('Andere Rolle');
    expect(res.xml).not.toContain('Sachbearbeitung Schaden');
  }, 60_000);

  test('a catalogue that is not valid JSON: one [C11] line, exit 1, no stack trace', async () => {
    const bad = await tempFile('bad.json', '{ "scheme": "demi", "actors": [ ], }');
    const res = await run(['--input', V2, `--catalog=${bad}`]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/^✗ \[C11\] catalog .*not valid JSON at line 1, column \d+\n$/);
    expect(res.xml).toBeNull();
  });

  test('an empty --catalog= with a 2.0 model: [C11], exit 1', async () => {
    const res = await run(['--input', V2, '--catalog=']);
    expect(res.status).toBe(1);
    expect(res.stderr).toBe('✗ [C11] --catalog needs a path\n');
  });

  test('--catalog with a 1.x model: the pipeline CLI\'s message, exit 1', async () => {
    const res = await run(['--input', V1, '--catalog=x']);
    expect(res.status).toBe(1);
    expect(res.stderr).toBe('✗ --catalog applies to format 2.0 models only\n');
    expect(res.stdout).toBe('');
    expect(res.xml).toBeNull();
  });

  test('a 1.x model without --catalog: output unchanged', async () => {
    const res = await run(['--input', V1]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    expect(res.stdout).toMatch(/^✓ Orchestration complete \(1 iteration\) — COMPLIANT\n {2}BPMN → .*out\.bpmn\n {2}SVG {2}→ .*out\.svg\n {2}Log {2}→ .*out\.orchestration\.json\n$/);
    expect(res.xml).toBe(readFileSync(resolve(fixturesDir, 'simple-approval.expected.bpmn'), 'utf8'));
  }, 60_000);
});
