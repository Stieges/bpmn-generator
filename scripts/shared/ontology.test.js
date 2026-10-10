import { describe, test, expect } from '@jest/globals';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ontologyPath } from './resource-paths.js';
import {
  loadOntology, validateOntology, checkReferences, buildVocabulary, VOCABULARY, CROSS_NOTATION,
} from './ontology.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = () => JSON.parse(readFileSync(ontologyPath(), 'utf8'));
const entry = (o, id) => o['@graph'].find((e) => e['@id'] === id);
const rule = (id) => VOCABULARY.rules.find((r) => r.id === id);
const problems = (o) => [...validateOntology(o), ...checkReferences(o)];

describe('rules in the ontology — Block 1', () => {
  test.each([
    ['S01', 'specific', ['BPMN']], ['D01', 'specific', ['DMN']],
    ['SC01', 'specific', ['BPMN']], ['SC06', 'specific', ['BPMN']],
    ['SC04', 'specific', ['DMN']], ['SC05', 'specific', ['DMN']],
    ['SC02', 'crossNotation', ['BPMN', 'DMN']], ['SC03', 'crossNotation', ['BPMN', 'DMN']],
  ])('%s is %s with notation(s) %j', (id, kind, notations) => {
    expect(rule(id)).toMatchObject({ kind, notations });
  });

  test.each([
    ['S01', 'BPMN', 'soundness', 'main'], ['WF02', 'BPMN', 'workflow_net', 'main'], ['D01', 'DMN', 'soundness', 'main'],
    ['SC01', 'BPMN', 'workflow_net', 'scenario'], ['SC06', 'BPMN', 'workflow_net', 'scenario'],
    ['SC04', 'DMN', 'semantics', 'scenario'], ['SC05', 'DMN', 'semantics', 'scenario'],
    ['SC02', CROSS_NOTATION, 'consistency', 'scenario'], ['SC03', CROSS_NOTATION, 'consistency', 'scenario'],
  ])('%s: rule set %s, layer %s, runs in %s, has a default severity', (id, ruleSet, layer, runsIn) => {
    expect(rule(id)).toMatchObject({ ruleSet, layer, runsIn });
    expect(VOCABULARY.severities.map((s) => s.name)).toContain(rule(id).defaultSeverity);
  });

  test('same-named layers of two notations are two entries, and a rule points at exactly one', () => {
    const o = raw();
    const soundness = o['@graph'].filter((e) => e['@type'] === 'bg:Layer' && e.name === 'soundness').map((e) => e['@id']);
    expect(soundness.sort()).toEqual(['bg:layer-BPMN-soundness', 'bg:layer-DMN-soundness']);
    expect(entry(o, 'bg:rule-S01').layer).toBe('bg:layer-BPMN-soundness');
    expect(entry(o, 'bg:rule-D01').layer).toBe('bg:layer-DMN-soundness');
  });

  test('layers are named by purpose — none says where a rule runs (F1′)', () => {
    expect(VOCABULARY.ruleSets.BPMN.layers).toEqual(['soundness', 'style', 'pragmatics', 'workflow_net', 'optimization']);
    expect(VOCABULARY.ruleSets.DMN.layers).toEqual(['soundness', 'semantics', 'best_practice']);
    expect(VOCABULARY.ruleSets[CROSS_NOTATION].layers).toEqual(['consistency']);
    expect(VOCABULARY.layers.find((l) => l.name === 'consistency').label).toBe('Consistency between notations');
    expect(VOCABULARY.layers.map((l) => l.name)).not.toEqual(expect.arrayContaining(['scenario']));
    expect(VOCABULARY.layers.map((l) => l.name)).not.toEqual(expect.arrayContaining(['bridge']));
  });

  test('the run location is a property of every rule, never a layer', () => {
    for (const r of VOCABULARY.rules) expect(['main', 'scenario']).toContain(r.runsIn);
    expect(VOCABULARY.layers.filter((l) => ['main', 'scenario'].includes(l.name))).toEqual([]);
  });

  test.each(['ERROR', 'WARNING', 'INFO', 'ADVISORY', 'OFF'])('severity %s is a vocabulary entry rules can point at', (name) => {
    expect(VOCABULARY.severities.map((s) => s.name)).toContain(name);
    expect(raw()['@graph'].some((e) => e['@type'] === 'bg:Rule' && e.defaultSeverity === `bg:severity-${name}`)).toBe(true);
  });

  test('ERROR, WARNING, INFO point at SHACL as a hint only; ADVISORY and OFF do not', () => {
    const see = Object.fromEntries(VOCABULARY.severities.map((s) => [s.name, s.seeAlso]));
    expect(see).toEqual({ ERROR: ['sh:Violation'], WARNING: ['sh:Warning'], INFO: ['sh:Info'], ADVISORY: [], OFF: [] });
    expect(readFileSync(ontologyPath(), 'utf8')).not.toMatch(/equivalentClass|exactMatch|sameAs/);
  });

  test('M05/M06 are OFF and O01–O04 ADVISORY', () => {
    expect(['M05', 'M06'].map((id) => rule(id).defaultSeverity)).toEqual(['OFF', 'OFF']);
    expect(['O01', 'O02', 'O03', 'O04'].map((id) => rule(id).defaultSeverity)).toEqual(Array(4).fill('ADVISORY'));
  });

  test('notation is an open class: a new notation entry needs no schema change', () => {
    const o = raw();
    o['@graph'].push({ '@id': 'bg:notation-UML', '@type': 'bg:Notation', name: 'UML', label: 'UML activity diagram', status: 'announced' });
    expect(problems(o)).toEqual([]);
  });

  test('a rule has no field for checked element types (E4 parked) — adding one is invalid', () => {
    const o = raw();
    entry(o, 'bg:rule-S01').checks = ['bg:startEvent'];
    expect(validateOntology(o).join(' ')).toMatch(/additional properties.*\[bg:rule-S01\]/);
  });

  test('rule counts per rule set: BPMN 40/5, DMN 19/3, cross-notation 2/1; scenario = SC01–SC06', () => {
    const count = (rs) => [VOCABULARY.ruleSets[rs].rules.length, VOCABULARY.ruleSets[rs].layers.length];
    expect(count('BPMN')).toEqual([40, 5]);
    expect(count('DMN')).toEqual([19, 3]);
    expect(count(CROSS_NOTATION)).toEqual([2, 1]);
    const scenario = VOCABULARY.rules.filter((r) => r.runsIn === 'scenario');
    expect(scenario.map((r) => r.id).sort()).toEqual(['SC01', 'SC02', 'SC03', 'SC04', 'SC05', 'SC06']);
    expect(scenario.map((r) => r.ruleSet).sort()).toEqual(['BPMN', 'BPMN', 'DMN', 'DMN', CROSS_NOTATION, CROSS_NOTATION].sort());
  });

  test('finding codes are not rules (cut 2)', () => {
    expect(VOCABULARY.rules.filter((r) => /^(DI|NC|DD|IM)\d/.test(r.id) || r.id === 'WF_OR')).toEqual([]);
  });

  test('WF03 defaults to ERROR (F4)', () => {
    expect(rule('WF03').defaultSeverity).toBe('ERROR');
  });
});

describe('rules in the ontology — the negation axis', () => {
  test('a cross-notation rule naming one notation aborts the load and names the rule (F2)', () => {
    const o = raw();
    entry(o, 'bg:rule-SC02').notation = ['bg:notation-BPMN'];
    expect(checkReferences(o).join(' ')).toMatch(/rule SC02 .* is cross-notation but names only bg:notation-BPMN/);
  });

  test('a specific rule naming two notations aborts the load and names the rule (F2)', () => {
    const o = raw();
    entry(o, 'bg:rule-S01').notation = ['bg:notation-BPMN', 'bg:notation-DMN'];
    expect(checkReferences(o).join(' ')).toMatch(/rule S01 .* is specific but names 2 notations/);
  });

  test('an unknown notation is caught by the reference step, naming rule and notation', () => {
    const o = raw();
    entry(o, 'bg:rule-S01').notation = ['bg:notation-BPMX'];
    expect(validateOntology(o)).toEqual([]);
    expect(checkReferences(o).join(' ')).toMatch(/rule S01 \(bg:rule-S01\) names unknown notation bg:notation-BPMX/);
  });

  test('an unknown severity is caught by the reference step, naming rule and severity', () => {
    const o = raw();
    entry(o, 'bg:rule-S01').defaultSeverity = 'bg:severity-CRITICAL';
    expect(validateOntology(o)).toEqual([]);
    expect(checkReferences(o).join(' ')).toMatch(/rule S01 \(bg:rule-S01\) names unknown severity bg:severity-CRITICAL/);
  });

  test('a rule in a layer of another notation names rule, layer and both notations', () => {
    const o = raw();
    entry(o, 'bg:rule-S01').layer = 'bg:layer-DMN-semantics';
    expect(validateOntology(o)).toEqual([]);
    expect(checkReferences(o).join(' ')).toMatch(/rule S01 .* has notation bg:notation-BPMN, but layer bg:layer-DMN-semantics belongs to bg:notation-DMN/);
  });

  test('a cross-notation rule in a single-notation layer names rule and layer (F3)', () => {
    const o = raw();
    entry(o, 'bg:rule-SC02').layer = 'bg:layer-BPMN-workflow_net';
    expect(checkReferences(o).join(' ')).toMatch(/rule SC02 .* is cross-notation, but layer bg:layer-BPMN-workflow_net belongs to bg:notation-BPMN only/);
  });

  test('a cross-notation layer naming only one notation names the layer (F2)', () => {
    const o = raw();
    entry(o, 'bg:layer-cross-consistency').notation = ['bg:notation-BPMN'];
    expect(checkReferences(o).join(' ')).toMatch(/layer consistency .* is cross-notation but names only/);
  });

  test('a specific layer naming two notations names the layer (F2)', () => {
    const o = raw();
    entry(o, 'bg:layer-BPMN-soundness').notation = ['bg:notation-BPMN', 'bg:notation-DMN'];
    expect(checkReferences(o).join(' ')).toMatch(/layer soundness .* is specific but names 2 notations/);
  });

  test('a specific rule in a cross-notation layer names rule and layer', () => {
    const o = raw();
    entry(o, 'bg:rule-S01').layer = 'bg:layer-cross-consistency';
    expect(checkReferences(o).join(' ')).toMatch(/rule S01 .* has notation bg:notation-BPMN, but layer bg:layer-cross-consistency belongs to/);
  });

  test('an unknown kind is reported on an unvalidated ontology', () => {
    const o = raw();
    entry(o, 'bg:rule-S01').kind = 'weird';
    expect(checkReferences(o).join(' ')).toMatch(/rule S01 .* has unknown kind "weird"/);
    expect(() => buildVocabulary(o)).toThrow(/unknown kind "weird"/);
  });

  test('an ontology without an owl:Ontology head is reported by name, not as a TypeError', () => {
    const o = raw();
    o['@graph'] = o['@graph'].filter((e) => e['@type'] !== 'owl:Ontology');
    expect(checkReferences(o).join(' ')).toMatch(/missing owl:Ontology head/);
    expect(() => buildVocabulary(o)).toThrow(/missing owl:Ontology head/);
  });

  test('an unknown run location names rule and value', () => {
    const o = raw();
    entry(o, 'bg:rule-S01').runsIn = 'batch';
    expect(validateOntology(o).join(' ')).toMatch(/runsIn must be equal to one of the allowed values \(got "batch"\) \[bg:rule-S01\]/);
  });

  test('two rule entries with the same id abort, naming the id and both entries', () => {
    const o = raw();
    o['@graph'].push({ ...entry(o, 'bg:rule-S01'), '@id': 'bg:rule-S01-copy' });
    expect(checkReferences(o).join(' ')).toMatch(/rule id S01 is declared twice: bg:rule-S01 \(@graph\/\d+\) and bg:rule-S01-copy \(@graph\/\d+\)/);
  });

  test('a rule without a default severity fails the import, naming file path and schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onto-rule-'));
    const p = join(dir, 'ontology.jsonld');
    const o = raw(); delete entry(o, 'bg:rule-S01').defaultSeverity;
    writeFileSync(p, JSON.stringify(o));
    expect(() => loadOntology(p)).toThrow(new RegExp(`ontology\\.jsonld is invalid \\(${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\): .*defaultSeverity.*\\(schema #/`));
  });

  test('broken references fail the import too, never a partially loaded catalog', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onto-ref-'));
    const p = join(dir, 'ontology.jsonld');
    const o = raw(); entry(o, 'bg:rule-S01').layer = 'bg:layer-DMN-semantics';
    writeFileSync(p, JSON.stringify(o));
    expect(() => loadOntology(p)).toThrow(/ontology\.jsonld has broken references .*rule S01/);
  });

  test('an entry of an unknown type is rejected, not skipped', () => {
    const o = raw();
    o['@graph'].push({ '@id': 'bg:rule-X01', '@type': 'bg:Rulez', name: 'X01' });
    expect(validateOntology(o).join(' ')).toMatch(/@type must be equal to one of the allowed values \(got "bg:Rulez"\)/);
  });

  test('buildVocabulary on an unvalidated ontology with a broken reference names it instead of a TypeError', () => {
    const o = raw();
    entry(o, 'bg:rule-S01').layer = 'bg:layer-nowhere';
    expect(() => buildVocabulary(o)).toThrow(/broken references — .*rule S01 .* names unknown layer bg:layer-nowhere/);
  });
});

describe('the loader knows no rule module', () => {
  test('shared/ontology.js imports only node:fs, ajv and resource-paths.js', () => {
    const src = readFileSync(join(__dirname, 'ontology.js'), 'utf8');
    const specifiers = [...src.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(specifiers.sort()).toEqual(['./resource-paths.js', 'ajv', 'node:fs']);
  });
});

import { enumDrift } from '../bpmn/ontology-audit.js';
import { DMN_ELEMENT_COVERAGE } from '../dmn/import-scope.js';
import { decisionCoreSchemaPath } from './resource-paths.js';
import { DMN_TERM_TYPES } from './ontology.js';

describe('DMN vocabulary — Block 4', () => {
  const dcSchema = JSON.parse(readFileSync(decisionCoreSchemaPath(), 'utf8'));
  const live = ['supported', 'lossy'];
  const SCHEMA_ENUMS = {
    nodeKinds: dcSchema.$defs.Node.properties.type.enum,
    requirementKinds: dcSchema.$defs.Requirement.properties.type.enum,
    hitPolicies: dcSchema.$defs.DecisionTable.properties.hitPolicy.enum,
    aggregations: dcSchema.$defs.DecisionTable.properties.aggregation.enum,
    orientations: dcSchema.$defs.DecisionTable.properties.preferredOrientation.enum,
  };

  test('the four node kinds, three requirement kinds, seven hit policies, four aggregations, three orientations', () => {
    expect(VOCABULARY.dmn.nodeKinds()).toEqual(['decision', 'inputData', 'knowledgeSource', 'businessKnowledgeModel']);
    expect(VOCABULARY.dmn.requirementKinds()).toEqual(['information', 'knowledge', 'authority']);
    expect(VOCABULARY.dmn.hitPolicies()).toEqual(['UNIQUE', 'FIRST', 'PRIORITY', 'ANY', 'COLLECT', 'RULE ORDER', 'OUTPUT ORDER']);
    expect(VOCABULARY.dmn.aggregations()).toEqual(['SUM', 'COUNT', 'MIN', 'MAX']);
    expect(VOCABULARY.dmn.orientations()).toEqual(['Rule-as-Row', 'Rule-as-Column', 'CrossTable']);
  });

  test.each(Object.keys(SCHEMA_ENUMS))('decision-core-schema.json %s equals the ontology (F14)', (kind) => {
    expect(enumDrift(SCHEMA_ENUMS[kind], VOCABULARY.dmn[kind](live))).toEqual([]);
  });

  test('every DMN term carries a status from the BPMN scale; schema terms are supported, importer-only ones announced (F13)', () => {
    for (const t of VOCABULARY.dmnTerms) expect(['supported', 'lossy', 'announced']).toContain(t.status);
    for (const [kind, values] of Object.entries(SCHEMA_ENUMS)) {
      for (const v of values) expect(VOCABULARY.dmnTerms.find((t) => t.kind === kind && t.name === v).status).toBe('supported');
    }
    expect(VOCABULARY.dmnTerms.find((t) => t.name === 'context').status).toBe('announced');
  });

  test('supported expression kinds are the two logic carriers of a Decision-Core node', () => {
    const CARRIER = { decisionTable: 'decisionTable', literalExpression: 'expression' };
    expect(VOCABULARY.dmn.expressionKinds(live)).toEqual(Object.keys(CARRIER));
    for (const prop of Object.values(CARRIER)) expect(dcSchema.$defs.Node.properties).toHaveProperty(prop);
  });

  test('announced expression kinds are exactly what the importer reports and Decision-Core cannot hold', () => {
    const reported = new Set(DMN_ELEMENT_COVERAGE.filter((r) => r.disposition === 'reported').map((r) => r.xsdElement));
    for (const name of VOCABULARY.dmn.expressionKinds(['announced'])) expect(reported.has(name)).toBe(true);
  });

  test('a value only in the schema is named (COLLECT_ALL)', () => {
    expect(enumDrift([...SCHEMA_ENUMS.hitPolicies, 'COLLECT_ALL'], VOCABULARY.dmn.hitPolicies(live))).toEqual(['COLLECT_ALL only in the schema']);
  });

  test('a supported value only in the ontology is named (AVG); announced it is no finding (F16)', () => {
    const o = raw();
    const avg = { '@id': 'bg:dmn-aggregation-AVG', '@type': 'bg:Aggregation', name: 'AVG', label: 'Average',
      status: 'supported', notation: ['bg:notation-DMN'], seeAlso: ['dmn:tBuiltinAggregator'] };
    o['@graph'].push(avg);
    expect(enumDrift(SCHEMA_ENUMS.aggregations, buildVocabulary(o).dmn.aggregations(live))).toEqual(['AVG only in the ontology']);
    avg.status = 'announced';
    expect(enumDrift(SCHEMA_ENUMS.aggregations, buildVocabulary(o).dmn.aggregations(live))).toEqual([]);
  });

  test('DMN terms link the DMN 1.3 XSD namespace only, as hints', () => {
    const o = raw();
    expect(o['@context'].dmn).toBe('https://www.omg.org/spec/DMN/20191111/MODEL/');
    const terms = o['@graph'].filter((e) => DMN_TERM_TYPES[e['@type']]);
    expect(terms).toHaveLength(27);
    for (const t of terms) expect(t.seeAlso.every((s) => s.startsWith('dmn:'))).toBe(true);
  });

  test('the loader validates every DMN class with its own block: an unknown field is rejected', () => {
    for (const type of Object.keys(DMN_TERM_TYPES)) {
      const o = raw();
      o['@graph'].find((e) => e['@type'] === type).xmlTag = 'x';
      expect(validateOntology(o).join(' ')).toMatch(/must NOT have additional properties/);
    }
  });

  test('a DMN term pointing at the BPMN notation, or a BPMN node type pointing at DMN, is rejected', () => {
    const a = raw();
    a['@graph'].find((e) => e['@type'] === 'bg:HitPolicy').notation = ['bg:notation-BPMN'];
    expect(validateOntology(a).join(' ')).toMatch(/must be equal to constant \(got "bg:notation-BPMN"\)/);
    const b = raw();
    entry(b, 'bg:userTask').notation = ['bg:notation-DMN'];
    expect(validateOntology(b).join(' ')).toMatch(/must be equal to constant \(got "bg:notation-DMN"\) \[bg:userTask\]/);
  });

  test('the BPMN views are unchanged by the DMN vocabulary', () => {
    expect(VOCABULARY.nodeTypeNames()).toHaveLength(26);
    expect(VOCABULARY.markerNames()).toHaveLength(12);
    expect(VOCABULARY.definitionKinds).toHaveLength(4);
    const dmnNames = new Set(VOCABULARY.dmnTerms.map((t) => t.name));
    expect(VOCABULARY.nodeTypeNames().filter((n) => dmnNames.has(n))).toEqual([]);
  });

  test('an rdf:Property on a Decision-Core element validates; an unknown element is still rejected (R10)', () => {
    for (const element of ['DecisionCore', 'DecisionNode', 'Requirement', 'DecisionTable']) {
      const o = raw();
      o['@graph'].push({ '@id': 'bg:probe-field', '@type': 'rdf:Property', name: 'probe', element });
      expect(validateOntology(o)).toEqual([]);
    }
    const bad = raw();
    bad['@graph'].push({ '@id': 'bg:probe-field', '@type': 'rdf:Property', name: 'probe', element: 'Nonsense' });
    expect(validateOntology(bad).join(' ')).toMatch(/must be equal to one of the allowed values/);
  });
});
