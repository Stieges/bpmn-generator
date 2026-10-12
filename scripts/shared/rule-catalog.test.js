import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ontologyPath } from './resource-paths.js';
import { buildVocabulary, VOCABULARY } from './ontology.js';
import { partitionForModule, rulesExpectedIn, registerFindings, buildRuleCatalog, RULE_METADATA_FIELDS } from './rule-catalog.js';
import { RULE_REGISTER as BPMN_MAIN, RULES, runRules, loadRuleProfile, SOUNDNESS_RULES, STYLE_RULES, PRAGMATICS_RULES, WORKFLOW_NET_RULES, OPTIMIZATION_RULES } from '../bpmn/rules.js';
import { DMN_MODES, dmnProfileForMode } from '../dmn/rules.js';
import { clientRuleProfile } from '../http-server.js';
import { ProfileRejectedError } from './rule-profile.js';
import { checkWorkflowNetSoundness } from '../bpmn/workflow-net.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = () => JSON.parse(readFileSync(ontologyPath(), 'utf8'));
const entry = (o, id) => o['@graph'].find((e) => e['@id'] === id);
const withRule = (o, id, ruleSet, layer, runsIn = 'main') => {
  o['@graph'].push({ '@id': `bg:rule-${id}`, '@type': 'bg:Rule', name: id, kind: 'specific', notation: [`bg:notation-${ruleSet}`],
    layer: `bg:layer-${ruleSet}-${layer}`, defaultSeverity: 'bg:severity-WARNING', runsIn });
  return o;
};

describe('partitionForModule — path ⇒ rule set and run location', () => {
  test.each([
    ['scripts/bpmn/rules.js', 'BPMN', 'main'], ['scripts/bpmn/scenario-rules.js', 'BPMN', 'scenario'],
    ['scripts/dmn/rules.js', 'DMN', 'main'], ['scripts/dmn/scenario-rules.js', 'DMN', 'scenario'],
    ['scripts/cross/rules.js', 'cross-notation', 'scenario'],
  ])('%s ⇒ %s / %s', (module, ruleSet, runsIn) => {
    expect(partitionForModule(module)).toEqual({ ruleSet, runsIn });
  });
  test('any other path is refused', () => {
    expect(() => partitionForModule('scripts/scenarios/rules.js')).toThrow(/not a rule-module path/);
  });
});

describe('the BPMN main catalog', () => {
  test('the real register matches the ontology', () => {
    expect(registerFindings(BPMN_MAIN)).toEqual([]);
  });

  test('S01 takes layer and default severity from the ontology; the code entry has no literal', () => {
    const fromOntology = VOCABULARY.rules.find((r) => r.id === 'S01');
    expect(RULES.find((r) => r.id === 'S01')).toMatchObject({ layer: fromOntology.layer, defaultSeverity: fromOntology.defaultSeverity });
    const codeEntry = BPMN_MAIN.entries.find((e) => e.id === 'S01');
    for (const f of RULE_METADATA_FIELDS) expect(Object.hasOwn(codeEntry, f)).toBe(false);
    expect(typeof codeEntry.check).toBe('function');
    expect(readFileSync(join(__dirname, '..', 'bpmn', 'rules.js'), 'utf8')).not.toMatch(/defaultSeverity: '|layer: '/);
  });

  test('changing M03 to INFO in the ontology reports M03 as INFO, with no code change', () => {
    const o = raw();
    entry(o, 'bg:rule-M03').defaultSeverity = 'bg:severity-INFO';
    const catalog = buildRuleCatalog(BPMN_MAIN, buildVocabulary(o));
    const lc = { id: 'p', name: 'P', nodes: [
      { id: 's', type: 'startEvent', name: 'Start' }, { id: 't1', type: 'task', name: 'Do A' }, { id: 't2', type: 'task', name: 'Do B' },
      { id: 'merge', type: 'exclusiveGateway', name: 'Merge', has_join: true }, { id: 'e', type: 'endEvent', name: 'End' }],
    edges: [{ id: 'f1', source: 's', target: 't1' }, { id: 'f2', source: 's', target: 't2' }, { id: 'f3', source: 't1', target: 'merge' },
      { id: 'f4', source: 't2', target: 'merge' }, { id: 'f5', source: 'merge', target: 'e', label: 'Should not have label' }] };
    const r = runRules(lc, null, catalog);
    expect(r.infos.some((m) => m.includes('Converging gateway "merge"'))).toBe(true);
    expect(r.warnings.some((m) => m.includes('Converging gateway "merge"'))).toBe(false);
  });

  test('a rule only in code aborts the build and names it "only in code"', () => {
    const register = { ...BPMN_MAIN, entries: [...BPMN_MAIN.entries, { id: 'S99', check: () => ({ pass: true }) }] };
    expect(registerFindings(register)).toEqual(['S99: only in code — the ontology has no rule S99']);
    expect(() => buildRuleCatalog(register)).toThrow(/scripts\/bpmn\/rules\.js: the rule catalog does not match .*S99: only in code/);
  });

  test('a BPMN main rule only in the ontology aborts the build and names it "only in the ontology"', () => {
    const v = buildVocabulary(withRule(raw(), 'S98', 'BPMN', 'soundness'));
    expect(registerFindings(BPMN_MAIN, v)).toEqual(['S98: only in the ontology — scripts/bpmn/rules.js registers no check for it']);
    expect(() => buildRuleCatalog(BPMN_MAIN, v)).toThrow(/S98: only in the ontology/);
  });

  test('bpmn/rules.js checks only BPMN rules that run in main: SC01 is not "missing" there', () => {
    expect(rulesExpectedIn({ ruleSet: 'BPMN', runsIn: 'main' }).map((r) => r.id)).not.toContain('SC01');
    expect(rulesExpectedIn({ ruleSet: 'BPMN', runsIn: 'scenario' }).map((r) => r.id)).toEqual(['SC01', 'SC06']);
  });

  test('a code entry still carrying a metadata literal names rule and field', () => {
    const entries = BPMN_MAIN.entries.map((e) => (e.id === 'S04' ? { ...e, defaultSeverity: 'WARNING' } : e));
    expect(registerFindings({ ...BPMN_MAIN, entries })).toEqual(['S04: carries its own defaultSeverity literal — that belongs to references/ontology.jsonld']);
  });

  test('a rule in the wrong module names the rule and the module\'s rule set', () => {
    const register = { module: 'scripts/bpmn/scenario-rules.js', partition: { ruleSet: 'BPMN', runsIn: 'scenario' },
      entries: [{ id: 'SC01', check: () => [] }, { id: 'SC06', check: () => [] }, { id: 'SC04', check: () => [] }] };
    expect(registerFindings(register)).toEqual([
      'SC04: lies in scripts/bpmn/scenario-rules.js (rule set BPMN, runs in scenario), but the ontology puts it in rule set DMN, runs in scenario']);
  });

  test('a register whose declared partition contradicts its path is named', () => {
    expect(registerFindings({ ...BPMN_MAIN, partition: { ruleSet: 'DMN', runsIn: 'main' } })[0])
      .toBe('declares rule set DMN, runs in main, but its path stands for rule set BPMN, runs in main');
  });

  test('placeholder rules WF01–WF03 and O01–O04 are in the catalog with metadata; their logic stays elsewhere', () => {
    for (const id of ['WF01', 'WF02', 'WF03', 'O01', 'O02', 'O03', 'O04']) {
      const r = RULES.find((x) => x.id === id);
      expect(r).toMatchObject({ layer: expect.any(String), defaultSeverity: expect.any(String) });
      expect(r.check(null, {})).toEqual({ pass: true });
    }
  });

  test('ADVISORY is still routed only to validation.advisories (classifyResult unchanged)', () => {
    expect(RULES.filter((r) => r.defaultSeverity === 'ADVISORY').map((r) => r.id)).toEqual(['O01', 'O02', 'O03', 'O04']);
  });

  test('rules of an announced notation are never expected in code; unannounced, they would be', () => {
    const o = raw();
    o['@graph'].push({ '@id': 'bg:layer-ArchiMate-structure', '@type': 'bg:Layer', name: 'structure', label: 'Structure', kind: 'specific', notation: ['bg:notation-ArchiMate'] });
    withRule(o, 'A01', 'ArchiMate', 'structure');
    expect(rulesExpectedIn({ ruleSet: 'ArchiMate', runsIn: 'main' }, buildVocabulary(o))).toEqual([]);
    entry(o, 'bg:notation-ArchiMate').status = 'supported';
    expect(rulesExpectedIn({ ruleSet: 'ArchiMate', runsIn: 'main' }, buildVocabulary(o)).map((r) => r.id)).toEqual(['A01']);
  });

  test('finding codes are no rules and are never reported missing', () => {
    expect(rulesExpectedIn({ ruleSet: 'BPMN', runsIn: 'main' }).map((r) => r.id).filter((id) => /^(DI|NC)|WF_OR/.test(id))).toEqual([]);
  });
});

describe('WF03 improper-completion severity', () => {
  const twoEnds = { id: 'P_TwoEnds', name: 'Two ends', nodes: [
    { id: 's', type: 'startEvent', name: 'Start' }, { id: 'fork', type: 'parallelGateway' },
    { id: 'x', type: 'userTask', name: 'Check order' }, { id: 'y', type: 'userTask', name: 'Ship order' },
    { id: 'e1', type: 'endEvent', name: 'Done A' }, { id: 'e2', type: 'endEvent', name: 'Done B' }],
  edges: [{ id: 'a1', source: 's', target: 'fork' }, { id: 'a2', source: 'fork', target: 'x' }, { id: 'a3', source: 'fork', target: 'y' },
    { id: 'a4', source: 'x', target: 'e1' }, { id: 'a5', source: 'y', target: 'e2' }] };

  test('every WF03 issue the net analysis emits carries ERROR, the rule\'s own severity', () => {
    const wf03 = checkWorkflowNetSoundness(twoEnds).issues.filter((i) => i.rule === 'WF03');
    expect(wf03.length).toBeGreaterThan(0);
    expect(wf03.every((i) => i.severity === 'ERROR')).toBe(true);
  });

  test('under rules/strict-profile.json an improper completion lands in errors, as before the fix', () => {
    const strict = loadRuleProfile(join(__dirname, '..', '..', 'rules', 'strict-profile.json'));
    expect(runRules(twoEnds, strict).errors.some((m) => m.startsWith('Improper completion'))).toBe(true);
  });
});

describe('layer names used in code exist in the ontology', () => {
  const layersOf = (ruleSet) => new Set(VOCABULARY.ruleSets[ruleSet].layers);

  test('each BPMN layer slice in rules.js is exactly the ontology\'s rules of that layer', () => {
    const slices = { soundness: SOUNDNESS_RULES, style: STYLE_RULES, pragmatics: PRAGMATICS_RULES, workflow_net: WORKFLOW_NET_RULES, optimization: OPTIMIZATION_RULES };
    for (const [layer, rules] of Object.entries(slices)) {
      expect(layersOf('BPMN').has(layer)).toBe(true);
      const expected = VOCABULARY.rules.filter((r) => r.ruleSet === 'BPMN' && r.layer === layer && r.runsIn === 'main').map((r) => r.id).sort();
      expect(rules.map((r) => r.id).sort()).toEqual(expected);
      expect(rules.length).toBeGreaterThan(0);
    }
  });

  test.each(DMN_MODES)('every layer DMN mode %s switches exists in the DMN rule set', (mode) => {
    for (const layer of Object.keys(dmnProfileForMode(null, mode).layers)) expect(layersOf('DMN').has(layer)).toBe(true);
  });

  test('the HTTP soundness guard names a real BPMN layer: switching it off is refused', () => {
    expect(layersOf('BPMN').has('soundness')).toBe(true);
    expect(() => clientRuleProfile({ ruleProfile: { layers: { soundness: { enabled: false } } } })).toThrow(ProfileRejectedError);
  });
});

describe('net-analysis issues carry the ontology severity of their rule', () => {
  const unbounded = { id: 'P_Unbounded', name: 'Unbounded', nodes: [
    { id: 's', type: 'startEvent' }, { id: 'f', type: 'parallelGateway' }, { id: 'a', type: 'task', name: 'A' }, { id: 'b', type: 'task', name: 'B' },
    { id: 'm', type: 'exclusiveGateway' }, { id: 't', type: 'task', name: 'T' }, { id: 'e', type: 'endEvent' }],
  edges: [['s', 'f'], ['f', 'a'], ['f', 'b'], ['a', 'm'], ['b', 'm'], ['m', 't'], ['t', 'e']].map(([source, target], i) => ({ id: `x${i}`, source, target })) };
  const deadlock = JSON.parse(readFileSync(join(__dirname, '..', '..', 'tests', 'fixtures', 'deadlock-process.json'), 'utf8'));

  test.each([['WF01', deadlock], ['WF02', unbounded]])('%s', (rule, lc) => {
    const issues = checkWorkflowNetSoundness(lc).issues.filter((i) => i.rule === rule);
    expect(issues.length).toBeGreaterThan(0);
    const expected = VOCABULARY.rules.find((r) => r.id === rule).defaultSeverity;
    expect(issues.every((i) => i.severity === expected)).toBe(true);
  });
});

describe('import graph — no cycle', () => {
  const importsOf = (rel) => [...readFileSync(join(__dirname, '..', rel), 'utf8').matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  test('rule-catalog.js imports only ontology.js', () => {
    expect(importsOf('shared/rule-catalog.js')).toEqual(['./ontology.js']);
  });
});

import { RULE_REGISTER as DMN_MAIN, DMN_RULES } from '../dmn/rules.js';
import { readdirSync } from 'node:fs';

describe('the DMN main catalog', () => {
  test('the real register matches the ontology', () => {
    expect(registerFindings(DMN_MAIN)).toEqual([]);
    expect(DMN_RULES.find((r) => r.id === 'D06')).toMatchObject({ layer: 'semantics', defaultSeverity: 'WARNING' });
    expect(readFileSync(join(__dirname, '..', 'dmn', 'rules.js'), 'utf8')).not.toMatch(/defaultSeverity: '|layer: '/);
  });

  test('a DMN gap names D99 for dmn/rules.js and leaves the BPMN catalog untouched', () => {
    const v = buildVocabulary(withRule(raw(), 'D99', 'DMN', 'soundness'));
    expect(registerFindings(DMN_MAIN, v)).toEqual(['D99: only in the ontology — scripts/dmn/rules.js registers no check for it']);
    expect(registerFindings(BPMN_MAIN, v)).toEqual([]);
  });

  test('nothing under scripts/bpmn/ imports dmn/, cross/ or scenarios/ — except pipeline.js the decision-table text', () => {
    // The one exception is the documentation of a Business Rule Task (cross/decision-doc.js): text
    // derived from a Decision-Core, never a rule. Which rule modules it may reach is fenced below.
    const dir = join(__dirname, '..', 'bpmn');
    const offenders = readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
      .flatMap((f) => [...readFileSync(join(dir, f), 'utf8').matchAll(/from\s+'(\.\.\/(?:dmn|cross|scenarios)\/[^']+)'/g)].map((m) => `${f} -> ${m[1]}`));
    expect(offenders).toEqual(['pipeline.js -> ../cross/decision-doc.js']);
  });

  test('a DMN gap cannot reach runPipeline: no rule module outside bpmn/ is in its static import closure', () => {
    const scripts = join(__dirname, '..');
    const seen = new Set();
    const visit = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(join(scripts, file), 'utf8');
      for (const [, spec] of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'(\.{1,2}\/[^']+)'/gm)) {
        visit(join(dirname(file), spec));
      }
    };
    visit('bpmn/pipeline.js');
    const reached = [...seen].filter((f) => !f.startsWith('bpmn/') && !f.startsWith('shared/')).sort();
    expect(reached).toEqual(['cross/decision-doc.js', 'dmn/constants.js', 'dmn/schema-gate.js', 'dmn/table-text.js', 'dmn/table.js', 'scenarios/bridge.js']);
    for (const ruleModule of ['dmn/rules.js', 'dmn/scenario-rules.js', 'cross/rules.js', 'bpmn/scenario-rules.js']) {
      expect(seen.has(ruleModule)).toBe(false);
    }
  });
});
