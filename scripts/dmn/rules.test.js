import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DMN_RULES, runDmnRules } from './rules.js';
import { validateDecisionCoreSchema } from './schema-gate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../../tests/fixtures/dmn');
const loadFixture = (name) => JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));

/** The reference model, deep-cloned so a test can break it without affecting the next. */
const good = () => loadFixture('discount-decision.json');

const codes = (result) => [...result.errors, ...result.warnings, ...result.infos]
  .map(line => line.match(/^\[(D\d\d)\]/)?.[1])
  .filter(Boolean);

describe('DMN schema gate', () => {
  test('the reference fixture passes the schema', () => {
    expect(validateDecisionCoreSchema(good())).toMatchObject({ valid: true, errors: [] });
  });

  test('namespace is mandatory — tDefinitions/@namespace is use="required"', () => {
    const dc = good();
    delete dc.namespace;
    expect(validateDecisionCoreSchema(dc).valid).toBe(false);
  });

  test('a DRG element without a name is rejected — tNamedElement requires it', () => {
    const dc = good();
    delete dc.nodes[0].name;
    expect(validateDecisionCoreSchema(dc).valid).toBe(false);
  });

  test('the gate is strict: an unknown property is a rejection, not a shrug', () => {
    const dc = good();
    dc.nodes[0].colour = 'red';
    expect(validateDecisionCoreSchema(dc).valid).toBe(false);
  });

  test('a decision table without outputs is rejected by the schema as well as D04', () => {
    // Two nets on purpose: the schema rejects the shape, D04 explains it in the
    // engine's own vocabulary for input that never went through the gate.
    const dc = good();
    dc.nodes[4].decisionTable.outputs = [];
    expect(validateDecisionCoreSchema(dc).valid).toBe(false);
  });
});

describe('DMN rule engine — the reference model is clean', () => {
  test('no errors and no warnings on the reference fixture', () => {
    const r = runDmnRules(good());
    expect({ errors: r.errors, warnings: r.warnings }).toEqual({ errors: [], warnings: [] });
  });

  test('every rule id is unique and every rule declares the required fields', () => {
    const ids = DMN_RULES.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of DMN_RULES) {
      expect(typeof rule.description).toBe('string');
      expect(['soundness', 'style']).toContain(rule.layer);
      expect(['ERROR', 'WARNING', 'INFO']).toContain(rule.defaultSeverity);
      expect(typeof rule.check).toBe('function');
    }
  });
});

describe('DMN rules — one failing case each', () => {
  test('D01: a requirement pointing at a node that does not exist', () => {
    const dc = good();
    dc.requirements.push({ id: 'ir_x', type: 'information', source: 'nope', target: 'dec_discountLevel' });
    const r = runDmnRules(dc);
    expect(codes(r)).toContain('D01');
    expect(r.errors.join(' ')).toMatch(/source "nope"/);
  });

  test('D02: a cycle in the requirement graph', () => {
    // A decision that (transitively) requires itself cannot be evaluated. The
    // message names the path, because "there is a cycle" is not actionable.
    const dc = good();
    dc.requirements.push({ id: 'ir_cycle', type: 'information', source: 'dec_finalPercentage', target: 'dec_discountLevel' });
    const r = runDmnRules(dc);
    expect(codes(r)).toContain('D02');
    expect(r.errors.join(' ')).toMatch(/dec_discountLevel|dec_finalPercentage/);
  });

  test('D02 stays quiet on a diamond — shared inputs are not cycles', () => {
    // Two decisions both requiring the same input is the normal shape of a DRG.
    // A naive visited-set check reports that as a cycle; this one must not.
    const dc = good();
    dc.requirements.push({ id: 'ir_diamond', type: 'information', source: 'in_orderValue', target: 'dec_finalPercentage' });
    expect(codes(runDmnRules(dc))).not.toContain('D02');
  });

  test('D03: an information requirement starting at a knowledge source', () => {
    const dc = good();
    dc.requirements.push({ id: 'ir_bad', type: 'information', source: 'ks_discountPolicy', target: 'dec_discountLevel' });
    const r = runDmnRules(dc);
    expect(codes(r)).toContain('D03');
    expect(r.errors.join(' ')).toMatch(/starts at a knowledgeSource/);
  });

  test('D03: a knowledge requirement ending somewhere that cannot invoke one', () => {
    const dc = good();
    dc.requirements.push({ id: 'kr_bad', type: 'knowledge', source: 'bkm_loyaltyBonus', target: 'ks_discountPolicy' });
    expect(codes(runDmnRules(dc))).toContain('D03');
  });

  test('D04: a decision table with no output clause', () => {
    // Reached through the engine rather than the gate: rules must hold for input
    // that arrived some other way.
    const dc = good();
    dc.nodes.find(n => n.id === 'dec_discountLevel').decisionTable.outputs = [];
    expect(codes(runDmnRules(dc))).toContain('D04');
  });

  test('D05: a rule row shorter than the table is wide', () => {
    // Entries are positional. A missing input entry does not leave a blank — it
    // shifts every later column, which is why this is an error and not a warning.
    const dc = good();
    const table = dc.nodes.find(n => n.id === 'dec_discountLevel').decisionTable;
    table.inputs.push({ id: 'in_2', label: 'Region', expression: 'region', typeRef: 'string' });
    const r = runDmnRules(dc);
    expect(codes(r)).toContain('D05');
    expect(r.errors.join(' ')).toMatch(/1 input entry for 2 input columns/);
  });

  test('D05: annotation entries are checked too, but only when present', () => {
    const dc = good();
    const table = dc.nodes.find(n => n.id === 'dec_discountLevel').decisionTable;
    table.rules.forEach(rule => delete rule.annotations);
    expect(codes(runDmnRules(dc))).not.toContain('D05');   // absent is fine

    table.rules[0].annotations = ['a', 'b'];               // present but wrong width is not
    expect(codes(runDmnRules(dc))).toContain('D05');
  });

  test('D06: a decision carrying no logic warns, and does not error', () => {
    const dc = good();
    const dec = dc.nodes.find(n => n.id === 'dec_finalPercentage');
    delete dec.expression;
    const r = runDmnRules(dc);
    expect(codes(r)).toContain('D06');
    expect(r.errors).toEqual([]);          // legal DMN — a DRD may document intent only
    expect(r.warnings.join(' ')).toMatch(/Final percentage/);
  });

  test('D07: input data that nothing requires', () => {
    const dc = good();
    dc.requirements = dc.requirements.filter(r => r.source !== 'in_customerSince');
    const r = runDmnRules(dc);
    expect(codes(r)).toContain('D07');
    expect(r.warnings.join(' ')).toMatch(/Customer since/);
  });

  test('D08: aggregation without COLLECT', () => {
    const dc = good();
    dc.nodes.find(n => n.id === 'dec_discountLevel').decisionTable.aggregation = 'SUM';
    const r = runDmnRules(dc);
    expect(codes(r)).toContain('D08');
    expect(r.warnings.join(' ')).toMatch(/will be ignored/);
  });

  test('D08 stays quiet when the hit policy is COLLECT', () => {
    const dc = good();
    const table = dc.nodes.find(n => n.id === 'dec_discountLevel').decisionTable;
    table.hitPolicy = 'COLLECT';
    table.aggregation = 'SUM';
    expect(codes(runDmnRules(dc))).not.toContain('D08');
  });
});

describe('DMN rules — profiles work the same way as on the BPMN side', () => {
  test('a severity override is honoured', () => {
    const dc = good();
    dc.requirements = dc.requirements.filter(r => r.source !== 'in_customerSince');   // trips D07
    const raised = runDmnRules(dc, { overrides: { D07: { severity: 'ERROR' } } });
    expect(raised.errors.join(' ')).toMatch(/\[D07\]/);
    expect(raised.warnings.join(' ')).not.toMatch(/\[D07\]/);
  });

  test('a rule switched OFF is silent', () => {
    const dc = good();
    dc.requirements = dc.requirements.filter(r => r.source !== 'in_customerSince');
    expect(codes(runDmnRules(dc, { overrides: { D07: { severity: 'OFF' } } }))).not.toContain('D07');
  });

  test('a disabled layer takes its whole set with it', () => {
    const dc = good();
    dc.requirements = dc.requirements.filter(r => r.source !== 'in_customerSince');
    const r = runDmnRules(dc, { layers: { style: { enabled: false } } });
    expect(codes(r)).not.toContain('D07');
    expect(codes(r)).not.toContain('D06');
  });

  test('the shipped default profile leaves the reference model clean', () => {
    const profile = JSON.parse(readFileSync(resolve(__dirname, '../../rules/dmn-default-profile.json'), 'utf8'));
    const r = runDmnRules(good(), profile);
    expect({ errors: r.errors, warnings: r.warnings }).toEqual({ errors: [], warnings: [] });
  });
});
