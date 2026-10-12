/**
 * Fence: the JSON examples in references/prompt-template.md are valid Logic-Core. The Modeler hands
 * the Master Extraction Prompt to the LLM verbatim, and an LLM copies the shape of an example more
 * faithfully than any rule beside it — so an example the input schema rejects teaches the model to
 * produce output the schema gate then rejects. It did: the collaboration example named its message
 * flow with `label` (the MessageFlow schema allows only `name`), and the prompt never mentioned
 * `collapsedPools`, so external partners came back as pools with an empty `nodes` list.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { extractPromptSection } from './prompt-sections.js';
import { promptTemplatePath } from '../shared/resource-paths.js';
import { validateLogicCoreSchema } from '../bpmn/schema-gate.js';
import { validateLogicCore } from '../bpmn/validate.js';

const jsonBlocks = (text) => [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
const isLogicCoreRoot = (o) => !!o && typeof o === 'object' && !Array.isArray(o)
  && (Array.isArray(o.pools) || (Array.isArray(o.nodes) && Array.isArray(o.edges)));
const errorsOf = (o) => validateLogicCoreSchema(o).errors.map((e) => `${e.path}: ${e.message}`);

describe('Master Extraction Prompt examples', () => {
  const master = extractPromptSection('Master Extraction Prompt');
  const blocks = jsonBlocks(master);

  test('it carries JSON examples at all (premise)', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(2);
  });

  test.each(blocks.map((b, i) => [i, b]))('block %i parses and passes the input schema', (_, block) => {
    const parsed = JSON.parse(block);
    expect(errorsOf(parsed)).toEqual([]);
  });

  test('the collaboration example shows a black-box participant as collapsedPools', () => {
    const collab = blocks.map((b) => JSON.parse(b)).find((o) => Array.isArray(o.pools));
    expect(collab).toBeDefined();
    expect(collab.collapsedPools?.length).toBeGreaterThan(0);
    const blackBox = new Set(collab.collapsedPools.map((p) => p.id));
    expect(collab.messageFlows.some((mf) => blackBox.has(mf.source) || blackBox.has(mf.target))).toBe(true);
  });

  test('the rules name collapsedPools, and say message flows take name, not label', () => {
    expect(master).toContain('collapsedPools');
    expect(master).toMatch(/message flows?[^\n]*`name`[^\n]*not[^\n]*`label`/i);
  });
});

describe('every Logic-Core example in prompt-template.md', () => {
  const all = jsonBlocks(readFileSync(promptTemplatePath(), 'utf8'))
    .map((b, i) => { try { return [i, JSON.parse(b)]; } catch { return null; } })
    .filter((x) => x && isLogicCoreRoot(x[1]));

  test('there are some (premise)', () => {
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  test.each(all)('block %i passes the input schema', (_, parsed) => {
    expect(errorsOf(parsed)).toEqual([]);
  });
});

// The examples teach how to assign roles: a lane on every step of a laned process, no lane without a
// `lanes` array, no empty lane (rules M12, M13). An example that breaks them teaches the LLM to.
describe('Logic-Core examples assign every step to a declared lane', () => {
  const laneFinding = /has no element at the top level|belongs to no lane|does not declare|declares no lanes/;
  const examples = ['references/prompt-template.md', 'references/logic-core-schema.md'].flatMap((rel) => {
    const text = readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
    return jsonBlocks(text).map((b, i) => { try { return [`${rel} #${i}`, JSON.parse(b)]; } catch { return null; } })
      .filter((x) => x && isLogicCoreRoot(x[1]));
  });

  test.each(examples)('%s', (_, lc) => {
    expect(validateLogicCore(lc).warnings.filter((w) => laneFinding.test(w))).toEqual([]);
  });

  test('the Master prompt says so, and says where a system goes', () => {
    const master = extractPromptSection('Master Extraction Prompt');
    expect(master).toMatch(/\*\*every\*\* top-level node/);
    expect(master).toMatch(/"system": "<name>"/);
    expect(master).toMatch(/never a lane/);
  });
});
