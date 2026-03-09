/**
 * L1 — BPMN-SLM Evaluation Script
 *
 * Runs a fine-tuned (or any OpenAI-compatible) model against test.jsonl,
 * validates outputs through the BPMN pipeline, and reports metrics.
 *
 * Metrics:
 *   - Parse Rate:     JSON.parse() succeeds
 *   - Schema Valid:   Has required top-level keys (pools/nodes/edges)
 *   - Soundness:      validateLogicCore() returns 0 errors
 *   - Compliance:     runRules() returns 0 errors
 *   - Structure:      Node count within ±20% of reference
 *
 * Usage:
 *   node evaluate-slm.js --test training/test.jsonl \
 *     --api-url http://localhost:8080/v1 --model bpmn-slm-14b \
 *     [--api-key KEY] [--output eval-results.json] [--limit 20]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { validateLogicCore } from './validate.js';
import { runRules } from './rules.js';
import { createLlmProvider } from './agents/llm-provider.js';

// ── Args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  return {
    testFile: flag('--test') || 'training/test.jsonl',
    apiUrl: flag('--api-url'),
    apiKey: flag('--api-key') || 'none',
    model: flag('--model'),
    outputFile: flag('--output') || 'eval-results.json',
    limit: flag('--limit') ? parseInt(flag('--limit'), 10) : Infinity,
    timeout: flag('--timeout') ? parseInt(flag('--timeout'), 10) : 120_000,
  };
}

const config = parseArgs();

if (!config.apiUrl || !config.model) {
  console.error('Usage: node evaluate-slm.js --test <file.jsonl> --api-url <url> --model <model> [--limit N]');
  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function countNodes(lc) {
  const processes = lc.pools ? lc.pools : [lc];
  return processes.reduce((sum, p) => sum + (p.nodes || []).length, 0);
}

function extractJson(text) {
  // Try direct parse first
  try { return JSON.parse(text); } catch {}
  // Try fenced code block
  const match = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (match) {
    try { return JSON.parse(match[1]); } catch {}
  }
  // Try first { to last }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

function hasRequiredKeys(obj) {
  if (!obj || typeof obj !== 'object') return false;
  // Must have pools array OR (nodes + edges)
  if (Array.isArray(obj.pools)) return true;
  if (Array.isArray(obj.nodes) && Array.isArray(obj.edges)) return true;
  return false;
}

// ── Main ────────────────────────────────────────────────────────────────

const lines = readFileSync(config.testFile, 'utf8').trim().split('\n');
const samples = lines.map(l => JSON.parse(l)).slice(0, config.limit);

const llm = createLlmProvider({
  baseUrl: config.apiUrl,
  apiKey: config.apiKey,
  model: config.model,
  timeout: config.timeout,
});

const results = [];
const metrics = {
  total: samples.length,
  parseOk: 0,
  schemaValid: 0,
  soundnessOk: 0,
  complianceOk: 0,
  structureOk: 0,
  errors: [],
};

console.log(`\nEvaluating ${samples.length} samples with ${config.model}...\n`);

for (let i = 0; i < samples.length; i++) {
  const sample = samples[i];
  const refOutput = JSON.parse(sample.output);
  const refNodeCount = countNodes(refOutput);

  process.stdout.write(`  [${i + 1}/${samples.length}] `);

  let result = { index: i, lang: sample.metadata?.lang, exerciseId: sample.metadata?.exerciseId };

  try {
    const response = await llm(sample.instruction, sample.input);

    // 1. Parse
    const parsed = extractJson(response);
    result.parseOk = parsed !== null;
    if (!parsed) {
      result.error = 'JSON parse failed';
      process.stdout.write('✗ parse\n');
      results.push(result);
      metrics.errors.push({ index: i, error: result.error });
      continue;
    }
    metrics.parseOk++;

    // 2. Schema
    result.schemaValid = hasRequiredKeys(parsed);
    if (!result.schemaValid) {
      result.error = 'Missing required keys';
      process.stdout.write('✗ schema\n');
      results.push(result);
      continue;
    }
    metrics.schemaValid++;

    // 3. Soundness (validation)
    const { errors: valErrors, warnings: valWarnings } = validateLogicCore(parsed);
    result.validationErrors = valErrors.length;
    result.validationWarnings = valWarnings.length;
    result.soundnessOk = valErrors.length === 0;
    if (result.soundnessOk) metrics.soundnessOk++;

    // 4. Compliance (rules)
    const ruleResult = runRules(parsed);
    result.complianceErrors = ruleResult.errors.length;
    result.complianceWarnings = ruleResult.warnings.length;
    result.complianceOk = ruleResult.errors.length === 0;
    if (result.complianceOk) metrics.complianceOk++;

    // 5. Structure (node count within ±20%)
    const genNodeCount = countNodes(parsed);
    result.refNodeCount = refNodeCount;
    result.genNodeCount = genNodeCount;
    const ratio = refNodeCount > 0 ? genNodeCount / refNodeCount : 0;
    result.structureOk = ratio >= 0.8 && ratio <= 1.2;
    if (result.structureOk) metrics.structureOk++;

    const status = [
      result.soundnessOk ? '✓' : '✗',
      result.complianceOk ? '✓' : '✗',
      result.structureOk ? '✓' : '✗',
    ].join('');
    process.stdout.write(`${status} (${genNodeCount}/${refNodeCount} nodes)\n`);

  } catch (err) {
    result.error = err.message;
    result.parseOk = false;
    metrics.errors.push({ index: i, error: err.message.slice(0, 100) });
    process.stdout.write(`✗ ${err.message.slice(0, 60)}\n`);
  }

  results.push(result);
}

// ── Report ──────────────────────────────────────────────────────────────

const pct = (n) => metrics.total > 0 ? `${((n / metrics.total) * 100).toFixed(1)}%` : 'N/A';

const report = {
  model: config.model,
  testFile: config.testFile,
  timestamp: new Date().toISOString(),
  metrics: {
    total: metrics.total,
    parseRate: { count: metrics.parseOk, rate: pct(metrics.parseOk) },
    schemaValid: { count: metrics.schemaValid, rate: pct(metrics.schemaValid) },
    soundness: { count: metrics.soundnessOk, rate: pct(metrics.soundnessOk) },
    compliance: { count: metrics.complianceOk, rate: pct(metrics.complianceOk) },
    structure: { count: metrics.structureOk, rate: pct(metrics.structureOk) },
  },
  thresholds: {
    parseRate: '≥ 95%',
    schemaValid: '≥ 90%',
    soundness: '≥ 85%',
    compliance: '≥ 80%',
    structure: '≥ 70%',
  },
  results,
};

writeFileSync(config.outputFile, JSON.stringify(report, null, 2), 'utf8');

console.log(`\n${'═'.repeat(50)}`);
console.log(`  BPMN-SLM Evaluation Report`);
console.log(`${'═'.repeat(50)}`);
console.log(`  Model:       ${config.model}`);
console.log(`  Test file:   ${config.testFile}`);
console.log(`  Samples:     ${metrics.total}`);
console.log(`${'─'.repeat(50)}`);
console.log(`  Parse Rate:    ${metrics.parseOk}/${metrics.total} (${pct(metrics.parseOk)})  threshold: ≥ 95%`);
console.log(`  Schema Valid:  ${metrics.schemaValid}/${metrics.total} (${pct(metrics.schemaValid)})  threshold: ≥ 90%`);
console.log(`  Soundness:     ${metrics.soundnessOk}/${metrics.total} (${pct(metrics.soundnessOk)})  threshold: ≥ 85%`);
console.log(`  Compliance:    ${metrics.complianceOk}/${metrics.total} (${pct(metrics.complianceOk)})  threshold: ≥ 80%`);
console.log(`  Structure:     ${metrics.structureOk}/${metrics.total} (${pct(metrics.structureOk)})  threshold: ≥ 70%`);
console.log(`${'─'.repeat(50)}`);

const pass = (rate, threshold) => parseFloat(rate) >= threshold;
const allPass =
  pass(pct(metrics.parseOk), 95) &&
  pass(pct(metrics.schemaValid), 90) &&
  pass(pct(metrics.soundnessOk), 85) &&
  pass(pct(metrics.complianceOk), 80) &&
  pass(pct(metrics.structureOk), 70);

console.log(`  Overall:       ${allPass ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`${'═'.repeat(50)}`);
console.log(`  Report: ${config.outputFile}`);

if (!allPass) process.exit(1);
