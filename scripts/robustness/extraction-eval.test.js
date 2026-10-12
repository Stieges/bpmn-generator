/**
 * The extraction-quality runner: every case of tests/fixtures/extraction-cases/ through
 * orchestrate() and compareToReference, with the raw LLM answers kept. Driven here by fake
 * providers; a real run needs an endpoint (see the module's CLI).
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCases, runExtractionEval, formatReport, summarizeRuns } from './extraction-eval.js';
import { LlmProviderError } from '../agents/llm-provider.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const casesDir = join(root, 'extraction-cases');

describe('extraction-eval', () => {
  test('the committed cases load, four with a reference model, one without', () => {
    const cases = loadCases(casesDir, root);
    expect(cases.map((c) => c.id)).toEqual(['adressaenderung', 'kreditantrag', 'rechnungspruefung', 'schadenmeldung', 'urlaubsantrag']);
    expect(cases.filter((c) => c.reference).length).toBe(4);
    for (const c of cases) expect(c.text.length).toBeGreaterThan(200);
  });

  test('an LLM that returns the reference: every referenced case ok with recall 1, raw answers kept', async () => {
    const cases = loadCases(casesDir, root);
    const byText = new Map(cases.map((c) => [c.text, c.reference ?? JSON.parse(readFileSync(join(root, 'simple-approval.json'), 'utf8'))]));
    const llm = async (_system, user) => JSON.stringify(byText.get(user) ?? {});
    const results = await runExtractionEval(cases, { llmProvider: llm });
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    for (const r of results.filter((x) => x.reference)) expect(r.comparison.metrics.activities.recall).toBe(1);
    expect(results[0].raw.length).toBeGreaterThanOrEqual(1);
    const md = formatReport(results, { model: 'fake' });
    expect(md).toContain('| urlaubsantrag | ok |');
    expect(md).toContain('fake');
  }, 120000);

  test('case options reach the comparison: expected lanes and steps the text does not describe', () => {
    const cases = loadCases(casesDir, root);
    expect(cases.find((c) => c.id === 'adressaenderung').expect.lanes).toHaveLength(3);
    expect(cases.find((c) => c.id === 'schadenmeldung').notInText).toEqual(['Schadenhöhe ermitteln', 'Betrugsindikatoren prüfen']);
  });

  test('a case without a reference but with expected lanes: an answer without lanes is no-lanes', async () => {
    const cases = loadCases(casesDir, root).filter((c) => c.id === 'adressaenderung');
    const plain = JSON.parse(readFileSync(join(root, 'simple-approval.json'), 'utf8'));
    for (const p of plain.pools) { delete p.lanes; for (const n of p.nodes) delete n.lane; }
    const [r] = await runExtractionEval(cases, { llmProvider: async () => JSON.stringify(plain) });
    expect(r.comparison.findings[0].kind).toBe('no-lanes');
  }, 60000);

  test('runs: every case n times, summarised as mean and range', async () => {
    const cases = loadCases(casesDir, root).filter((c) => c.id === 'urlaubsantrag');
    const ref = cases[0].reference;
    const weaker = JSON.parse(JSON.stringify(ref));
    const p = weaker.pools[0];
    const drop = new Set(['u_konto', 'u_plan']);
    const next = (id) => p.edges.find((e) => e.source === id).target;
    for (const e of p.edges) while (drop.has(e.target)) e.target = next(e.target);
    p.edges = p.edges.filter((e) => !drop.has(e.source));
    p.nodes = p.nodes.filter((n) => !drop.has(n.id));
    let call = 0;
    // Alternate per run: the first run gets the reference, the second the weaker model.
    const llm = async () => JSON.stringify(call++ % 2 === 0 ? ref : weaker);
    const results = await runExtractionEval(cases, { llmProvider: llm, runs: 2 });
    expect(results.map((r) => r.run)).toEqual([1, 2]);
    const [s] = summarizeRuns(results);
    expect(s.id).toBe('urlaubsantrag');
    expect(s.runs).toBe(2);
    expect(s.status).toEqual({ ok: 2 });
    expect(s.recall.min).toBeCloseTo(5 / 7, 6);
    expect(s.recall.max).toBe(1);
    expect(s.recall.mean).toBeCloseTo((1 + 5 / 7) / 2, 6);
    const md = formatReport(results, { model: 'fake' });
    expect(md).toMatch(/\| urlaubsantrag \| ok 2\/2 \|/);
  }, 120000);

  test('an endpoint that keeps failing: llm_error per case, the run goes on', async () => {
    const cases = loadCases(casesDir, root).slice(0, 2);
    const llm = async () => { throw new LlmProviderError('LLM endpoint returned 502 (4 attempts)', { status: 502, attempts: 4 }); };
    const results = await runExtractionEval(cases, { llmProvider: llm });
    expect(results.map((r) => r.status)).toEqual(['llm_error', 'llm_error']);
    expect(results[0].error).toContain('502');
  });

  test('an answer the schema gate rejects twice: schema_rejected', async () => {
    const cases = loadCases(casesDir, root).slice(0, 1);
    const llm = async () => JSON.stringify({ pools: [{ id: 'P', name: 'P', nodes: [], edges: [] }] });
    const [r] = await runExtractionEval(cases, { llmProvider: llm });
    expect(r.status).toBe('schema_rejected');
    expect(r.raw).toHaveLength(2);
  });
});
