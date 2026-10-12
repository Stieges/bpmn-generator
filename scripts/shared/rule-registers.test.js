/**
 * Parity between the ontology and the five rule modules, read from their exported registers — never
 * from their source text (each register is the module's own statement of what it implements).
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerFindings, RULE_METADATA_FIELDS } from './rule-catalog.js';
import { VOCABULARY } from './ontology.js';
import { RULE_REGISTER as BPMN_MAIN } from '../bpmn/rules.js';
import { RULE_REGISTER as BPMN_SCENARIO } from '../bpmn/scenario-rules.js';
import { RULE_REGISTER as DMN_MAIN } from '../dmn/rules.js';
import { RULE_REGISTER as DMN_SCENARIO } from '../dmn/scenario-rules.js';
import { RULE_REGISTER as CROSS } from '../cross/rules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, '..');
const REGISTERS = [BPMN_MAIN, BPMN_SCENARIO, DMN_MAIN, DMN_SCENARIO, CROSS];

const expectedRuleIds = (vocabulary) => {
  const supported = new Set(vocabulary.notations.filter((n) => n.status === 'supported').map((n) => n.name));
  return vocabulary.rules.filter((r) => r.notations.every((n) => supported.has(n))).map((r) => r.id).sort();
};

describe('every rule has a code entry and an ontology entry, in the right module', () => {
  test.each(REGISTERS.map((r) => [r.module, r]))('%s matches the ontology', (_, register) => {
    expect(registerFindings(register)).toEqual([]);
  });

  test('together the five registers implement exactly the rules of the supported notations', () => {
    const inCode = REGISTERS.flatMap((r) => r.entries.map((e) => e.id)).sort();
    // The expected set comes from the ontology, not from the five known partitions — otherwise a
    // rule of a supported notation with no owning module would never be fenced.
    expect(inCode).toEqual(expectedRuleIds(VOCABULARY));
    expect(inCode).toHaveLength(63);
  });

  test('a supported notation whose rule has no owning module is reported as only in the ontology', () => {
    const synthetic = {
      ...VOCABULARY,
      notations: [...VOCABULARY.notations.filter((n) => n.name !== 'ArchiMate'), { name: 'ArchiMate', label: 'ArchiMate', status: 'supported' }],
      rules: [...VOCABULARY.rules, { id: 'A01', kind: 'specific', notations: ['ArchiMate'], ruleSet: 'ArchiMate', layer: 'structure', defaultSeverity: 'WARNING', runsIn: 'main' }],
    };
    const inCode = REGISTERS.flatMap((r) => r.entries.map((e) => e.id)).sort();
    const missing = expectedRuleIds(synthetic).filter((id) => !inCode.includes(id));
    expect(missing).toEqual(['A01']);
  });

  test('the SC rules live where their notation lives', () => {
    expect(BPMN_SCENARIO.entries.map((e) => e.id)).toEqual(['SC01', 'SC06']);
    expect(DMN_SCENARIO.entries.map((e) => e.id)).toEqual(['SC04', 'SC05']);
    expect(CROSS.entries.map((e) => e.id)).toEqual(['SC02', 'SC03']);
    expect(existsSync(join(SCRIPTS, 'scenarios', 'rules.js'))).toBe(false);
  });

  test('the cross-notation register repeats no notation', () => {
    expect(JSON.stringify(CROSS.partition)).not.toMatch(/BPMN|DMN/);
    for (const e of CROSS.entries) for (const f of RULE_METADATA_FIELDS) expect(Object.hasOwn(e, f)).toBe(false);
  });
});

describe('import graph — the move adds no cycle', () => {
  const sources = (dir) => readdirSync(join(SCRIPTS, dir)).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .map((f) => ({ file: `${dir}/${f}`, specifiers: [...readFileSync(join(SCRIPTS, dir, f), 'utf8').matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]) }));
  const offenders = (dir, forbidden) => sources(dir).filter((s) => s.specifiers.some((p) => forbidden.test(p))).map((s) => s.file);

  test('bpmn/ imports neither dmn/, cross/ nor scenarios/ — except pipeline.js the decision-table text', () => {
    // bpmn/pipeline.js -> cross/decision-doc.js writes a Business Rule Task's decision table into its
    // documentation (runPipeline's `decisions` option). Text, not a rule: rule-catalog.test.js fences
    // that no rule module outside bpmn/ is in runPipeline's import closure.
    expect(offenders('bpmn', /^\.\.\/(dmn|cross|scenarios)\//)).toEqual(['bpmn/pipeline.js']);
    const external = sources('bpmn').flatMap((s) => s.specifiers.filter((p) => /^\.\.\/(dmn|cross|scenarios)\//.test(p)));
    expect(external).toEqual(['../cross/decision-doc.js']);
  });
  test('bpmn/ loads outside modules dynamically only for the CLI\'s --decisions files', () => {
    const dynamic = readdirSync(join(SCRIPTS, 'bpmn')).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
      .flatMap((f) => [...readFileSync(join(SCRIPTS, 'bpmn', f), 'utf8').matchAll(/import\(\s*'(\.\.\/[^']+)'\s*\)/g)].map((m) => `${f} -> ${m[1]}`));
    expect(dynamic).toEqual(['pipeline.js -> ../dmn/load-decisions.js']);
  });
  test('dmn/ imports neither bpmn/, cross/ nor scenarios/', () => {
    expect(offenders('dmn', /^\.\.\/(bpmn|cross|scenarios)\//)).toEqual([]);
  });
  test('cross/rules.js imports only shared/; cross/decision-doc.js only the table text, the bridge and the gate', () => {
    const byFile = Object.fromEntries(sources('cross').map((s) => [s.file, s.specifiers]));
    expect(Object.keys(byFile).sort()).toEqual(['cross/decision-doc.js', 'cross/rules.js']);
    expect(byFile['cross/rules.js']).toEqual(['../shared/rule-catalog.js']);
    expect(byFile['cross/decision-doc.js'].sort()).toEqual([
      '../dmn/constants.js', '../dmn/schema-gate.js', '../dmn/table-text.js', '../dmn/table.js', '../scenarios/bridge.js',
    ]);
  });
  test('scenarios/pipeline.js is the one caller of the three scenario rule modules', () => {
    const callers = ['bpmn', 'dmn', 'cross', 'scenarios', 'shared'].flatMap(sources)
      .filter((s) => s.specifiers.some((p) => /scenario-rules\.js$|cross\/rules\.js$/.test(p))).map((s) => s.file);
    expect(callers).toEqual(['scenarios/pipeline.js']);
  });
});
