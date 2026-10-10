/**
 * Byte-equality fence for the scenario pipeline (decisions F9, F27; record M22). The goldens in
 * tests/fixtures/scenarios/golden/ were captured BEFORE SC01–SC06 moved out of scripts/scenarios/rules.js
 * into the BPMN, DMN and cross-notation rule modules; the move must not change one byte of the JSON
 * (findings, their order, skippedTableAnalyses) or the Markdown. A diff here is a defect, never a
 * reason to regenerate.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenarioPipeline, scenarioJsonText } from './pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, '..', '..', 'tests', 'fixtures', 'scenarios');
const read = (p) => JSON.parse(readFileSync(join(DIR, p), 'utf8'));
const CASES = read('cases.json');
const golden = (name, ext) => readFileSync(join(DIR, 'golden', `${name}.scenarios.${ext}`), 'utf8');

describe('scenario pipeline output is byte-identical to the goldens', () => {
  for (const c of CASES) {
    test(`${c.name}: JSON and Markdown`, () => {
      const result = runScenarioPipeline(read(c.lc), c.decisions.map(read));
      expect(scenarioJsonText(result)).toBe(golden(c.name, 'json'));
      expect(result.formatted.markdown).toBe(golden(c.name, 'md'));
    });
  }

  test('the reference set fires every rule SC01–SC06 at least once', () => {
    const rules = new Set(CASES.flatMap((c) => JSON.parse(golden(c.name, 'json')).issues.map((i) => i.rule)));
    expect([...rules].sort()).toEqual(['SC01', 'SC02', 'SC03', 'SC04', 'SC05', 'SC06']);
  });

  test('the reference set holds a Logic-Core with a decisionRef and no Decision-Core', () => {
    const c = CASES.find((x) => x.decisions.length === 0 && JSON.stringify(read(x.lc)).includes('"decisionRef"'));
    expect(c).toBeDefined();
  });

  test('findings come out sorted by rule id, ties in emission order (F27)', () => {
    const issues = JSON.parse(golden('combined', 'json')).issues.map((i) => i.rule);
    expect(issues).toEqual(['SC01', 'SC02', 'SC06']);
    const tables = JSON.parse(golden('tables', 'json')).issues;
    expect(tables.map((i) => i.rule)).toEqual(['SC04', 'SC04', 'SC05']);
    expect(tables.filter((i) => i.rule === 'SC04').map((i) => i.tableId)).toEqual(['table_gap', 'table_overlap']);
  });
});
