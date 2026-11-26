import { describe, test, expect } from '@jest/globals';
import { buildPrompt, modelerAgent } from './modeler.js';
import { extractPromptSection } from './prompt-sections.js';

const core = (extra = {}) => ({ nodes: [{ id: 'a', type: 'task', name: 'Antrag prüfen' }], edges: [], ...extra });
const issues = [{ severity: 'error', problem: 'P1' }];
const feedback = [{ issue: 'I1', suggestion: 'S1' }];
const refineState = (lc) => ({ logicCore: lc, reviewIssues: issues });
const amendState = (lc) => ({ logicCore: lc, layoutFeedback: feedback });

// The prompts as they were built before language support, from the template alone.
const baseRefine = (lc) => extractPromptSection('Refinement / Correction Prompt')
  .replace('{{ISSUES}}', '[error] P1').replace('{{CURRENT_JSON}}', JSON.stringify(lc, null, 2));
const baseAmend = (lc) => extractPromptSection('Amendment Prompt')
  .replace('{{CURRENT_JSON}}', JSON.stringify(lc, null, 2)).replace('{{CHANGE_DESCRIPTION}}', '- I1: S1');

const DE_LINE = 'The labels of this model are in German (language "de"): name tasks like "';
const lastLine = (s) => s.split('\n').pop();

describe('modeler prompts keep the declared language', () => {
  test.each([['refine', refineState, baseRefine], ['amend', amendState, baseAmend]])(
    '%s of a de model ends with the language line', (mode, state, base) => {
      const lc = core({ language: 'de' });
      const { systemPrompt } = buildPrompt(state(lc));
      expect(systemPrompt.startsWith(base(lc))).toBe(true);
      const line = lastLine(systemPrompt);
      expect(line.startsWith(DE_LINE)).toBe(true);
      expect(line.endsWith('" and keep the "language" field unchanged.')).toBe(true);
    });

  test('a tag without a strategy gets the plain line', () => {
    const { systemPrompt } = buildPrompt(refineState(core({ language: 'fr-CA' })));
    expect(lastLine(systemPrompt)).toBe('The labels of this model are in the language "fr-CA": keep them in that language and keep the "language" field unchanged.');
  });

  test.each([[undefined], [null], [''], ['de_DE'], [5], ['x']])('without a valid tag (%p) the prompts equal today\'s', (bad) => {
    const plain = core();
    const lc = bad === undefined ? plain : core({ language: bad });
    expect(buildPrompt(refineState(plain)).systemPrompt).toBe(baseRefine(plain));
    expect(buildPrompt(amendState(plain)).systemPrompt).toBe(baseAmend(plain));
    expect(buildPrompt(refineState(lc)).systemPrompt).toBe(baseRefine(lc));
    expect(buildPrompt(amendState(lc)).systemPrompt).toBe(baseAmend(lc));
  });

  test('the extract prompt never has the line', () => {
    const { systemPrompt, mode } = buildPrompt({ userText: 'x', logicCore: core({ language: 'de' }) });
    expect(mode).toBe('extract');
    expect(systemPrompt).not.toContain('keep the "language" field');
  });
});

describe('modelerAgent returns the declared language', () => {
  const run = (state, reply) => modelerAgent({ ...state, options: { llmProvider: async () => JSON.stringify(reply) } });

  test.each([['refine', refineState], ['amend', amendState]])('%s: a response without language gets "de" back', async (mode, state) => {
    const r = await run(state(core({ language: 'de' })), core());
    expect(r.logicCore.language).toBe('de');
  });

  test('a response that changed the language keeps it', async () => {
    const r = await run(refineState(core({ language: 'de' })), core({ language: 'en' }));
    expect(r.logicCore.language).toBe('en');
  });

  test('a model without a tag gets no language field', async () => {
    const r = await run(refineState(core()), core());
    expect(Object.hasOwn(r.logicCore, 'language')).toBe(false);
  });

  test('extract does not add a language', async () => {
    const r = await run({ userText: 'x' }, core());
    expect(Object.hasOwn(r.logicCore, 'language')).toBe(false);
  });
});
