import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDmnPipeline } from './pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../../tests/fixtures/dmn');
const loadFixture = (name) => JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));
const good = () => loadFixture('discount-decision.json');

describe('runDmnPipeline — schema gate', () => {
  test('a Decision-Core document missing the required namespace is blocked before rules run', async () => {
    const dc = good();
    delete dc.namespace;
    const result = await runDmnPipeline(dc);
    expect(result.xml).toBeNull();
    expect(result.diagrams).toBeNull();
    expect(result.diagnostics).toBeNull();
    expect(result.validation.errors.length).toBeGreaterThan(0);
    expect(result.validation.errors.join(' ')).toMatch(/namespace/);
  });

  test('a Decision-Core document with an empty namespace is blocked before rules run', async () => {
    const dc = good();
    dc.namespace = '';
    const result = await runDmnPipeline(dc);
    expect(result.xml).toBeNull();
    expect(result.diagrams).toBeNull();
    expect(result.diagnostics).toBeNull();
    expect(result.validation.errors.length).toBeGreaterThan(0);
    expect(result.validation.errors.join(' ')).toMatch(/namespace/);
  });
});

describe('runDmnPipeline — rule engine gate', () => {
  test('a cyclic requirement graph is blocked after the schema gate, before layout', async () => {
    const dc = good();
    dc.requirements.push({ id: 'ir_cycle', type: 'information', source: 'dec_finalPercentage', target: 'dec_discountLevel' });
    const result = await runDmnPipeline(dc);
    expect(result.xml).toBeNull();
    expect(result.diagrams).toBeNull();
    expect(result.validation.errors.join(' ')).toMatch(/cycle/);
  });
});

describe('runDmnPipeline — success path', () => {
  test('the reference fixture produces xml, a diagram list and a clean diagnostics pass', async () => {
    const result = await runDmnPipeline(good());
    expect(typeof result.xml).toBe('string');
    expect(result.xml).toContain('<?xml');
    expect(Array.isArray(result.diagrams)).toBe(true);
    expect(result.diagrams.length).toBeGreaterThan(0);
    expect(result.validation.errors).toEqual([]);
    expect(result.validation.xmlWarnings).toEqual([]);
    expect(result.diagnostics.ok).toBe(true);
    expect(result.diagnostics.issues).toEqual([]);
  });

  test('best-practice mode surfaces B-layer warnings the default semantic mode does not', async () => {
    const dc = good();
    delete dc.nodes.find((n) => n.id === 'dec_discountLevel').question;
    const semantic = await runDmnPipeline(dc, { mode: 'semantic' });
    const bestPractice = await runDmnPipeline(dc, { mode: 'best-practice' });
    expect(semantic.validation.warnings.some((w) => w.startsWith('[B03]'))).toBe(false);
    expect(bestPractice.validation.warnings.some((w) => w.startsWith('[B03]'))).toBe(true);
  });
});

describe('runDmnPipeline — degenerate inputs', () => {
  test('a single isolated inputData node (no requirements) still produces valid xml', async () => {
    const dc = { namespace: 'http://x/isolated', nodes: [{ id: 'lonely', type: 'inputData', name: 'Lonely', typeRef: 'string' }] };
    const result = await runDmnPipeline(dc);
    expect(typeof result.xml).toBe('string');
    expect(result.diagnostics.ok).toBe(true);
  });

  test('zero nodes is rejected by the schema gate (nodes has minItems: 1), never reaches layout', async () => {
    const dc = { namespace: 'http://x/empty', nodes: [] };
    const result = await runDmnPipeline(dc);
    expect(result.xml).toBeNull();
    expect(result.diagrams).toBeNull();
  });
});

describe('runDmnPipeline — serialisation error surfaces as a structured result', () => {
  test('an illegal information-requirement source that only reaches the writer because D03 is OFF ' +
    'surfaces as xml: null with diagrams/diagnostics still populated, not an unhandled rejection', async () => {
    const dc = good();
    // ks_discountPolicy is a knowledgeSource; DMN 1.3 §6.2.3 Table 2 forbids a knowledgeSource as
    // the source of an 'information' requirement (only 'authority' requirements may point at one).
    // D03 would normally catch this before layout — disable it via ruleProfile to reach dmn-xml.js.
    dc.requirements.push({ id: 'ir_illegal', type: 'information', source: 'ks_discountPolicy', target: 'dec_discountLevel' });
    const result = await runDmnPipeline(dc, { ruleProfile: { overrides: { D03: { severity: 'OFF' } } } });
    expect(result.xml).toBeNull();
    // Unlike the schema-gate and rule-engine early returns above, layout/coordinates/di-check DID
    // run and produced real values — those must survive, not collapse into null alongside xml.
    expect(Array.isArray(result.diagrams)).toBe(true);
    expect(result.diagrams.length).toBeGreaterThan(0);
    expect(result.diagnostics).not.toBeNull();
    expect(result.diagnostics.ok).toBe(true);
    expect(result.validation.errors.length).toBeGreaterThan(0);
    expect(result.validation.errors.join(' ')).toMatch(/\[serialisation\]/);
    expect(result.validation.errors.join(' ')).toMatch(/knowledgeSource/);
  });
});

describe('DMN Golden-File Regression', () => {
  test('discount-decision.json: xml matches golden file byte-for-byte', async () => {
    const result = await runDmnPipeline(good());
    let expected;
    try {
      expected = readFileSync(resolve(fixturesDir, 'discount-decision.expected.dmn'), 'utf8');
    } catch {
      throw new Error('Golden file missing: tests/fixtures/dmn/discount-decision.expected.dmn — run the golden generation step in Task 6, Step 9 first');
    }
    expect(result.xml).toBe(expected);
  });
});
