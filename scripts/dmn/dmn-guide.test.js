/**
 * The skill's DMN guide `references/dmn.md` is runnable: its ```json blocks are one Decision-Core
 * document and one Logic-Core process that calls it. Each must pass its schema gate and its
 * pipeline with no error and no warning (what `--strict` asks for), and the two together must
 * pass the scenario pipeline with no finding — the bridge resolves and the table has neither gap
 * nor overlap. Read from the file, never copied here, so an edit to the guide is what this checks.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { runDmnPipeline } from './pipeline.js';
import { validateDecisionCoreSchema } from './schema-gate.js';
import { runPipeline } from '../bpmn/pipeline.js';
import { validateLogicCoreSchema } from '../bpmn/schema-gate.js';
import { runScenarioPipeline } from '../scenarios/pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUIDE = path.join(__dirname, '..', '..', 'references', 'dmn.md');
const blocks = [...readFileSync(GUIDE, 'utf8').matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
const decisionCores = blocks.filter((b) => 'namespace' in b);
const logicCores = blocks.filter((b) => !('namespace' in b));

describe('references/dmn.md — every JSON example runs', () => {
  test('the guide has one Decision-Core and one Logic-Core example', () => {
    expect(decisionCores).toHaveLength(1);
    expect(logicCores).toHaveLength(1);
  });

  test.each(['semantic', 'best-practice'])('the Decision-Core passes the schema gate and the DMN pipeline (%s mode)', async (mode) => {
    const [dc] = decisionCores;
    expect(validateDecisionCoreSchema(dc)).toMatchObject({ valid: true });
    const result = await runDmnPipeline(dc, { mode });
    expect(result.validation.errors).toEqual([]);
    expect(result.validation.warnings).toEqual([]);
    expect(result.validation.xmlWarnings).toEqual([]);
    expect(result.diagnostics.ok).toBe(true);
    expect(result.xml).toMatch(/<dmn:definitions /);
  });

  test('the Logic-Core passes the schema gate and the BPMN pipeline without a warning', async () => {
    const [lc] = logicCores;
    expect(validateLogicCoreSchema(lc)).toMatchObject({ valid: true });
    const result = await runPipeline(lc);
    expect(result.validation.errors).toEqual([]);
    expect(result.validation.warnings).toEqual([]);
    expect(result.validation.xmlWarnings).toEqual([]);
    expect(result.diagnostics.issues).toEqual([]);
    expect(result.netDiagnostics.ok).toBe(true);
    expect(result.bpmnXml).toContain('dec_approvalLevel');
  });

  test('together they pass the scenario pipeline: the bridge resolves, the table is complete and disjoint', () => {
    const result = runScenarioPipeline(logicCores[0], decisionCores);
    expect(result.bridgeResult.resolved).toHaveLength(1);
    expect(result.issues).toEqual([]);
    expect(result.skippedTableAnalyses).toBe(0);
  });

  test('the scenario pipeline would see a gap: dropping a rule reports SC04', () => {
    const dc = structuredClone(decisionCores[0]);
    dc.nodes.find((n) => n.decisionTable).decisionTable.rules.pop();
    const result = runScenarioPipeline(logicCores[0], [dc]);
    expect(result.issues.map((i) => i.rule)).toContain('SC04');
  });
});
