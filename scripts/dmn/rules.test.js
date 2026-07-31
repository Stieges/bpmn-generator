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
  .map(line => line.match(/^\[([DB]\d\d)\]/)?.[1])
  .filter(Boolean);

/** Best-practice rules are off unless the mode asks for them. */
const bestPractice = (dc) => runDmnRules(dc, { mode: 'best-practice' });

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

  test('usingTask accepts an array, not only a single string (DMN13.xsd: 0..unbounded)', () => {
    const dc = good();
    dc.nodes[4].usingTask = ['task_applyDiscount', 'task_reviewDiscount'];
    expect(validateDecisionCoreSchema(dc)).toMatchObject({ valid: true, errors: [] });
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
      expect(['soundness', 'semantics', 'best_practice']).toContain(rule.layer);
      expect(rule.ref).toBeTruthy();   // every rule cites where it comes from
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

  test('D03: a pair that permits no requirement at all', () => {
    // Nothing may require input data — Table 2 has no row with Input Data as the
    // target, and §6.2.3 says so outright.
    const dc = good();
    dc.requirements.push({ id: 'bad', type: 'information', source: 'dec_discountLevel', target: 'in_orderValue' });
    const r = runDmnRules(dc);
    expect(codes(r)).toContain('D03');
    expect(r.errors.join(' ')).toMatch(/nothing may require input data/);
  });

  test('D03: a pair that is legal but mislabelled', () => {
    // §6.2.3: "the type of the requirement is uniquely determined by the types of
    // the two elements connected". knowledgeSource -> decision is an authority
    // requirement, full stop — calling it information is not a variant reading.
    const dc = good();
    dc.requirements.push({ id: 'mislabelled', type: 'information', source: 'ks_discountPolicy', target: 'dec_finalPercentage' });
    const r = runDmnRules(dc);
    expect(codes(r)).toContain('D03');
    expect(r.errors.join(' ')).toMatch(/is declared "information", but a knowledgeSource -> decision requirement is always "authority"/);
  });

  test('D03 accepts knowledgeSource -> businessKnowledgeModel — the pair an endpoint check gets wrong', () => {
    // This is the case the first version of D03 rejected: it listed the allowed
    // sources and targets separately and left businessKnowledgeModel out of the
    // authority targets, so a legal model failed. Table 2 has the row.
    const dc = good();
    dc.requirements.push({ id: 'ar_bkm', type: 'authority', source: 'ks_discountPolicy', target: 'bkm_loyaltyBonus' });
    expect(codes(runDmnRules(dc))).not.toContain('D03');
  });

  test('D03 rejects decision -> decision declared as authority — the other endpoint-check hole', () => {
    // Both ends are individually legal for an authority requirement, so an
    // endpoint check waves this through. The pair table does not.
    const dc = good();
    dc.requirements.push({ id: 'ar_dd', type: 'authority', source: 'dec_discountLevel', target: 'dec_finalPercentage' });
    const r = runDmnRules(dc);
    expect(codes(r)).toContain('D03');
    expect(r.errors.join(' ')).toMatch(/always "information"/);
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

  test('D09: a Collect operator over a compound output', () => {
    // §8.2.11: compound outputs support "Collect without operator, because the
    // collect operator is undefined over multiple outputs". Undefined, not merely
    // unusual — hence ERROR while the related D08 is only a warning.
    const dc = good();
    const table = dc.nodes.find(n => n.id === 'dec_discountLevel').decisionTable;
    table.hitPolicy = 'COLLECT';
    table.aggregation = 'SUM';
    table.outputs.push({ id: 'out_2', name: 'reason', typeRef: 'string' });
    table.rules.forEach(r => r.then.push('"x"'));     // keep D05 out of it
    const r = runDmnRules(dc);
    expect(codes(r)).toContain('D09');
    expect(codes(r)).not.toContain('D08');            // COLLECT, so D08 is satisfied
  });

  test('D10: PRIORITY without output values has nothing to rank by', () => {
    const dc = good();
    const table = dc.nodes.find(n => n.id === 'dec_discountLevel').decisionTable;
    table.hitPolicy = 'PRIORITY';
    delete table.outputs[0].allowedValues;
    const r = runDmnRules(dc);
    expect(codes(r)).toContain('D10');
    expect(r.errors.join(' ')).toMatch(/no priority order to apply/);
  });

  test('D10 is satisfied when the output values are there', () => {
    const dc = good();
    dc.nodes.find(n => n.id === 'dec_discountLevel').decisionTable.hitPolicy = 'OUTPUT ORDER';
    expect(codes(runDmnRules(dc))).not.toContain('D10');   // the fixture declares allowedValues
  });

  test('D11: a crosstab with a hit policy other than UNIQUE', () => {
    const dc = good();
    const table = dc.nodes.find(n => n.id === 'dec_discountLevel').decisionTable;
    table.preferredOrientation = 'CrossTable';
    table.hitPolicy = 'ANY';
    expect(codes(runDmnRules(dc))).toContain('D11');
  });

  test('D11 accepts a crosstab that leaves the hit policy at its default', () => {
    const dc = good();
    const table = dc.nodes.find(n => n.id === 'dec_discountLevel').decisionTable;
    table.preferredOrientation = 'CrossTable';
    delete table.hitPolicy;
    expect(codes(runDmnRules(dc))).not.toContain('D11');
  });
});

describe('DMN best-practice layer — off by default, on by mode', () => {
  test('the default mode says nothing about best practice', () => {
    // A model being documented as it is should not be nagged about how it ought
    // to look. That is the whole reason this layer is opt-in.
    const dc = good();
    dc.nodes.find(n => n.id === 'dec_discountLevel').decisionTable.hitPolicy = 'FIRST';
    expect(codes(runDmnRules(dc))).not.toContain('B01');
    expect(codes(bestPractice(dc))).toContain('B01');
  });

  test('B01: FIRST — and the spec is the one saying so', () => {
    const dc = good();
    dc.nodes.find(n => n.id === 'dec_discountLevel').decisionTable.hitPolicy = 'FIRST';
    const r = bestPractice(dc);
    expect(codes(r)).toContain('B01');
    expect(r.warnings.join(' ')).toMatch(/depends on rule order/);
  });

  test('B02: a table past the configured size', () => {
    const dc = good();
    const table = dc.nodes.find(n => n.id === 'dec_discountLevel').decisionTable;
    table.rules = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, when: ['-'], then: ['"none"'], annotations: ['x'] }));
    expect(codes(bestPractice(dc))).toContain('B02');
  });

  test('B02: the threshold comes from config, not from the code', () => {
    const dc = good();
    const table = dc.nodes.find(n => n.id === 'dec_discountLevel').decisionTable;
    table.rules = Array.from({ length: 4 }, (_, i) => ({ id: `r${i}`, when: ['-'], then: ['"none"'], annotations: ['x'] }));
    expect(codes(runDmnRules(dc, { mode: 'best-practice' }))).not.toContain('B02');
    expect(codes(runDmnRules(dc, { mode: 'best-practice', config: { maxRulesPerTable: 3 } }))).toContain('B02');
  });

  test('B03: a decision that does not say what it decides', () => {
    const dc = good();
    delete dc.nodes.find(n => n.id === 'dec_discountLevel').question;
    expect(codes(bestPractice(dc))).toContain('B03');
  });

  test('B04: untyped input data', () => {
    const dc = good();
    delete dc.nodes.find(n => n.id === 'in_orderValue').typeRef;
    expect(codes(bestPractice(dc))).toContain('B04');
  });

  test('B05: a knowledge source nobody can look up', () => {
    const dc = good();
    const ks = dc.nodes.find(n => n.id === 'ks_discountPolicy');
    delete ks.sourceType;
    delete ks.locationURI;
    expect(codes(bestPractice(dc))).toContain('B05');
  });

  test('B06: a requirement chain past the configured depth', () => {
    const dc = good();
    expect(codes(bestPractice(dc))).not.toContain('B06');
    expect(codes(runDmnRules(dc, { mode: 'best-practice', config: { maxDrgDepth: 1 } }))).toContain('B06');
  });

  test('the reference model is clean in best-practice mode too', () => {
    // The fixture is meant to be exemplary, not merely valid. If adding a rule
    // makes this fail, either the rule is wrong or the fixture stopped being a
    // good example — both worth stopping for.
    const r = bestPractice(good());
    expect({ errors: r.errors, warnings: r.warnings }).toEqual({ errors: [], warnings: [] });
  });
});

describe('DMN rules — profiles work the same way as on the BPMN side', () => {
  test('a severity override is honoured', () => {
    const dc = good();
    dc.requirements = dc.requirements.filter(r => r.source !== 'in_customerSince');   // trips D07
    const raised = runDmnRules(dc, { profile: { overrides: { D07: { severity: 'ERROR' } } } });
    expect(raised.errors.join(' ')).toMatch(/\[D07\]/);
    expect(raised.warnings.join(' ')).not.toMatch(/\[D07\]/);
  });

  test('a rule switched OFF is silent', () => {
    const dc = good();
    dc.requirements = dc.requirements.filter(r => r.source !== 'in_customerSince');
    expect(codes(runDmnRules(dc, { profile: { overrides: { D07: { severity: 'OFF' } } } }))).not.toContain('D07');
  });

  test('a disabled layer takes its whole set with it', () => {
    const dc = good();
    dc.requirements = dc.requirements.filter(r => r.source !== 'in_customerSince');
    const r = runDmnRules(dc, { profile: { layers: { semantics: { enabled: false } } } });
    expect(codes(r)).not.toContain('D07');
    expect(codes(r)).not.toContain('D06');
  });

  test('the shipped default profile leaves the reference model clean', () => {
    const profile = JSON.parse(readFileSync(resolve(__dirname, '../../rules/dmn-default-profile.json'), 'utf8'));
    const r = runDmnRules(good(), { profile });
    expect({ errors: r.errors, warnings: r.warnings }).toEqual({ errors: [], warnings: [] });
  });
});
