#!/usr/bin/env node
/**
 * Extraction quality — text → Logic-Core through orchestrate(), measured against reference models.
 *
 * Every case in a directory (`{ id, text, reference }`, reference a fixture file name or null) goes
 * through orchestrate() with the given LLM provider; the result is compared with the reference
 * (reference-compare.js). Per case: status (ok | invalid | schema_rejected | llm_error | failed),
 * duration, LLM retries, every raw LLM answer, the comparison's metrics and findings. The report
 * is JSON (everything) and Markdown (one row per case, then the findings).
 *
 * This measures what a user of the LLM path gets — the Modeler prompt, the schema gate with its
 * repair, the reviewer loop — not the bare model.
 *
 * CLI:
 *   node robustness/extraction-eval.js --api-url URL --model MODEL [--api-key KEY]
 *     [--cases ../tests/fixtures/extraction-cases] [--timeout <s>] [--retries <n>]
 *     [--extra-body '<json>'] [--limit <n>] [--output extraction-eval]
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchestrate } from '../orchestrator.js';
import { compareToReference } from './reference-compare.js';
import { isMainModule } from '../shared/entry-point.js';

/** Cases of `dir`, sorted by file name; `reference` resolved to the Logic-Core in `fixturesDir`. */
export function loadCases(dir, fixturesDir) {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const c = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    return {
      id: c.id ?? f.replace(/\.json$/, ''),
      text: c.text,
      referenceFile: c.reference ?? null,
      reference: c.reference ? JSON.parse(readFileSync(join(fixturesDir, c.reference), 'utf8')) : null,
    };
  });
}

function statusOf(err) {
  if (/failed schema validation/.test(err.message)) return 'schema_rejected';
  let e = err;
  while (e) { if (e.name === 'LlmProviderError') return 'llm_error'; e = e.cause; }
  return 'failed';
}

/**
 * @param {object[]} cases - from loadCases
 * @param {object} opts - `llmProvider` (required), `onCase(result)` (progress), any other
 *   orchestrate option; `retriesOf()` returns the retries counted since the last call (the CLI
 *   counts them through the provider's onRetry)
 */
export async function runExtractionEval(cases, { llmProvider, onCase = null, retriesOf = () => 0, ...options }) {
  const results = [];
  for (const c of cases) {
    const raw = [];
    const recording = async (...args) => {
      const answer = await llmProvider(...args);
      raw.push(answer);
      return answer;
    };
    const t0 = Date.now();
    const result = { id: c.id, reference: c.referenceFile, status: null, durationMs: 0, retries: 0, raw, error: null,
      logicCore: null, validation: null, compliance: null, comparison: null };
    try {
      const out = await orchestrate(c.text, { ...options, llmProvider: recording });
      result.logicCore = out.logicCore;
      result.validation = out.validation;
      result.compliance = out.compliance;
      result.history = out.history;
      result.status = out.bpmnXml ? 'ok' : 'invalid';
      result.comparison = compareToReference(out.logicCore, c.reference);
    } catch (err) {
      result.status = statusOf(err);
      result.error = err.message;
    }
    result.durationMs = Date.now() - t0;
    result.retries = retriesOf();
    results.push(result);
    onCase?.(result);
  }
  return results;
}

const pct = (x) => (x === null || x === undefined ? '–' : `${Math.round(x * 100)} %`);

/** The Markdown report: one row per case, then each case's findings. */
export function formatReport(results, { model = '', date = new Date().toISOString().slice(0, 10) } = {}) {
  const lines = [
    `# Extraction quality — ${date}${model ? ` — ${model}` : ''}`, '',
    '| Case | Status | s | Retries | Recall | Precision | Type | Lane | Findings | Compliance |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    const a = r.comparison?.metrics.activities;
    lines.push(`| ${r.id} | ${r.status} | ${(r.durationMs / 1000).toFixed(0)} | ${r.retries} | ${pct(a?.recall)} | ${pct(a?.precision)} `
      + `| ${pct(a?.typeAgreement)} | ${pct(a?.laneAgreement)} | ${r.comparison?.findings.length ?? '–'} `
      + `| ${r.compliance ? (r.compliance.isCompliant ? 'yes' : `no (${r.compliance.errors.length})`) : '–'} |`);
  }
  for (const r of results) {
    lines.push('', `## ${r.id}${r.reference ? ` (reference: ${r.reference})` : ' (no reference)'}`);
    if (r.error) lines.push('', `Error: ${r.error}`);
    for (const f of r.comparison?.findings ?? []) lines.push(`- **${f.kind}** — ${f.message}`);
    if (!r.error && !r.comparison?.findings.length) lines.push('', 'No finding.');
  }
  return `${lines.join('\n')}\n`;
}

// ── CLI ──────────────────────────────────────────────────────────────
if (isMainModule(import.meta.url, process.argv[1])) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const apiUrl = flag('--api-url');
  const model = flag('--model');
  if (!apiUrl || !model) {
    console.error('Usage: node robustness/extraction-eval.js --api-url URL --model MODEL [--api-key KEY] [--cases DIR]');
    console.error('       [--timeout <seconds>] [--retries <n>] [--extra-body <json>] [--limit <n>] [--output <base>]');
    process.exit(1);
  }
  const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
  const casesDir = resolve(flag('--cases') ?? join(fixturesDir, 'extraction-cases'));
  const limit = flag('--limit') ? Number(flag('--limit')) : Infinity;
  const output = flag('--output') ?? 'extraction-eval';
  let extraBody = null;
  if (flag('--extra-body') !== null) {
    try { extraBody = JSON.parse(flag('--extra-body')); } catch { extraBody = null; }
    if (!extraBody || typeof extraBody !== 'object' || Array.isArray(extraBody)) {
      console.error('--extra-body takes a JSON object');
      process.exit(1);
    }
  }

  const { createLlmProvider } = await import('../agents/llm-provider.js');
  let retries = 0;
  const llmProvider = createLlmProvider({
    baseUrl: apiUrl, apiKey: flag('--api-key') ?? 'none', model,
    ...(flag('--timeout') && { timeout: Number(flag('--timeout')) * 1000 }),
    ...(flag('--retries') !== null && { retry: { retries: Number(flag('--retries')) } }),
    ...(extraBody && { extraBody }),
    onRetry: ({ attempt, retries: n, status, delayMs }) => {
      retries++;
      console.error(`  ↻ LLM ${status ?? 'unreachable'}, retry ${attempt}/${n} in ${(delayMs / 1000).toFixed(1)} s`);
    },
  });

  const cases = loadCases(casesDir, fixturesDir).slice(0, limit);
  console.error(`Extraction quality: ${cases.length} case(s), model ${model}`);
  const results = await runExtractionEval(cases, {
    llmProvider,
    retriesOf: () => { const n = retries; retries = 0; return n; },
    onCase: (r) => console.error(`  ${r.id}: ${r.status} in ${(r.durationMs / 1000).toFixed(0)} s`
      + (r.comparison?.metrics.activities.recall != null ? `, recall ${pct(r.comparison.metrics.activities.recall)}` : '')),
  });
  writeFileSync(`${output}.json`, JSON.stringify({ model, date: new Date().toISOString(), results }, null, 2));
  writeFileSync(`${output}.md`, formatReport(results, { model }));
  console.error(`Report: ${output}.md, ${output}.json`);
}
