#!/usr/bin/env node
/**
 * Pipeline Robustness CLI.
 * See docs/superpowers/specs/2026-05-16-pipeline-robustness-via-synthetic-data-design.md
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, 'config.json');

export function parseArgs(argv = process.argv.slice(2)) {
  const command = argv[0];
  const flags = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = argv[++i] || 'true';
      }
    }
  }
  return { command, flags };
}

export function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

export function resolveEndpoint(config, flags, env = process.env) {
  const baseUrl = flags['api-url'] || env[config.endpoint.url_env] || config.endpoint.url;
  const apiKey  = flags['api-key'] || env[config.endpoint.key_env] || config.endpoint.key || 'none';
  const model   = flags['model']   || config.model;
  return { baseUrl, apiKey, model };
}

async function main() {
  const { command, flags } = parseArgs();
  const config = loadConfig();

  switch (command) {
    case 'run': {
      const { createLlmProvider } = await import('../agents/llm-provider.js');
      const { generateSamples } = await import('./synthetic-generator.js');
      const { runStressTest } = await import('./stress-tester.js');
      const { classify } = await import('./failure-classifier.js');
      const { persistFailure } = await import('./fixture-persister.js');
      const { generateReport } = await import('./report-generator.js');
      const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import('fs');
      const { resolve, join } = await import('path');

      const { baseUrl, apiKey, model } = resolveEndpoint(config, flags);
      if (!baseUrl) {
        console.error('Missing baseUrl. Set AIHUB_URL or pass --api-url=...');
        process.exit(2);
      }
      const llm = createLlmProvider({ baseUrl, apiKey, model, timeout: 120_000 });

      const catalog = JSON.parse(readFileSync(resolve(__dirname, 'seed-catalog.json'), 'utf8'));
      const n = parseInt(flags.n || config.default_n, 10);
      const target = flags.target || config.default_target;
      const persistLlmSignal = flags['persist-llm-signal'] === 'true' || config.persist_llm_signal;
      const seed = parseInt(flags.seed || Date.now(), 10);
      const startedAt = new Date().toISOString();

      console.log(`[robustness] Run started — model: ${model}, n: ${n}, target: ${target}, seed: ${seed}`);

      const samples = await generateSamples({ catalog, n, llm, target, model, seed });
      console.log(`[robustness] Generated ${samples.length} samples (out of ${n} attempts)`);

      const results = await runStressTest(samples, { timeoutMs: config.timeout_seconds * 1000 });
      const classified = results.map(r => ({ ...r, ...classify(r) }));

      for (const c of classified) {
        if (c.bucket) {
          const persistResult = await persistFailure(
            { category: c.category, bucket: c.bucket, fingerprint: c.fingerprint, evidence: c.evidence },
            c.sample,
            { persistLlmSignal }
          );
          c.wrote = persistResult.wrote;
        }
      }

      const runMeta = { model, target, started_at: startedAt, duration_ms: Date.now() - new Date(startedAt).getTime() };
      const { markdown, json } = generateReport(runMeta, classified);

      const reportDir = resolve(__dirname, '../../', config.report_dir);
      if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
      const stamp = startedAt.slice(0, 10);
      const baseName = `${stamp}-${model}-n${n}`;
      writeFileSync(join(reportDir, `${baseName}.md`), markdown, 'utf8');
      writeFileSync(join(reportDir, `${baseName}.json`), JSON.stringify(json, null, 2), 'utf8');

      console.log(markdown);
      console.log(`\n[robustness] Report written to ${reportDir}/${baseName}.{md,json}`);
      break;
    }
    case 'triage':
      console.log('[robustness] triage — not implemented yet (Phase 4)');
      break;
    case 'mad-check':
      console.log('[robustness] mad-check — not implemented yet (Phase 6)');
      break;
    case 'report':
      console.log('[robustness] report — not implemented yet (Phase 4)');
      break;
    case 'smoke-test': {
      const { createLlmProvider } = await import('../agents/llm-provider.js');
      const { baseUrl, apiKey, model } = resolveEndpoint(config, flags);
      if (!baseUrl) {
        console.error('Missing baseUrl. Set AIHUB_URL or pass --api-url=...');
        process.exit(2);
      }
      const llm = createLlmProvider({ baseUrl, apiKey, model, timeout: 30_000 });
      const reply = await llm('You are a test.', 'Reply with the single word: pong');
      console.log('[smoke-test] reply:', reply);
      break;
    }
    default:
      console.error(`Usage: node scripts/robustness/cli.js <run|smoke-test|triage|mad-check|report> [flags]`);
      process.exit(1);
  }
}

// Only run main when invoked directly, not when imported in tests
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
