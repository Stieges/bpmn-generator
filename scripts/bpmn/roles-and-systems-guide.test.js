/**
 * The guide `docs/roles-and-systems.md` is runnable: every ```json block in it is a complete
 * Logic-Core document, and each must pass the schema gate and come out of the pipeline as valid BPMN
 * with no rule error, no serialisation warning and no DI ERROR. Read from the file, never copied
 * here, so an edit to the guide is what this test checks.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { runPipeline } from './pipeline.js';
import { validateLogicCoreSchema } from './schema-gate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUIDE = path.join(__dirname, '..', '..', 'docs', 'roles-and-systems.md');
const blocks = [...readFileSync(GUIDE, 'utf8').matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);

describe('docs/roles-and-systems.md — every JSON example runs', () => {
  test('the guide has one example per representation, plus the fields example', () => {
    expect(blocks).toHaveLength(5);
  });

  test.each(blocks.map((b, i) => [i + 1, b]))('example %i', async (_i, source) => {
    const lc = JSON.parse(source);
    expect(validateLogicCoreSchema(lc)).toMatchObject({ valid: true });
    const result = await runPipeline(lc);
    expect(result.validation.errors).toEqual([]);
    expect(result.bpmnXml).toMatch(/<bpmn:definitions/);
    expect(result.validation.xmlWarnings).toEqual([]);
    expect(result.diagnostics.issues.filter((i) => i.severity === 'ERROR')).toEqual([]);
    expect(result.diagnostics.ok).toBe(true);
    expect(result.netDiagnostics.ok).toBe(true);
  });
});
