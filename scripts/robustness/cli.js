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

      if (!['lc-json', 'dot', 'both'].includes(target)) {
        console.error(`Invalid target: ${target}. Use lc-json | dot | both`);
        process.exit(2);
      }

      let allSamples = [];
      if (target === 'both') {
        const halfN = Math.ceil(n / 2);
        const a = await generateSamples({ catalog, n: halfN, llm, target: 'lc-json', model, seed });
        const b = await generateSamples({ catalog, n: n - halfN, llm, target: 'dot', model, seed: seed + 1 });
        allSamples = [...a, ...b];
      } else {
        allSamples = await generateSamples({ catalog, n, llm, target, model, seed });
      }
      console.log(`[robustness] Generated ${allSamples.length} samples (out of ${n} attempts, target=${target})`);

      const results = await runStressTest(allSamples, { timeoutMs: config.timeout_seconds * 1000 });
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
    case 'triage': {
  const { readdirSync, existsSync, readFileSync, renameSync, appendFileSync, unlinkSync } = await import('fs');
  const { resolve, join } = await import('path');
  const readline = await import('readline');

  const triageDir = resolve(__dirname, '../../', config.fixture_dir, 'triage');
  const autoDir = resolve(__dirname, '../../', config.fixture_dir, 'auto');
  const dismissedLog = resolve(__dirname, '../../', config.fixture_dir, 'dismissed.log');

  if (!existsSync(triageDir)) {
    console.log('[triage] No triage directory yet.');
    break;
  }

  const items = readdirSync(triageDir)
    .filter(f => f.endsWith('.meta.json'))
    .map(f => ({ name: f, meta: JSON.parse(readFileSync(join(triageDir, f), 'utf8')) }));

  if (items.length === 0) {
    console.log('[triage] No pending triage items.');
    break;
  }

  console.log(`Pending triage items: ${items.length}\n`);
  items.forEach((item, i) => {
    console.log(`[${i + 1}] ${item.meta.category}-${item.meta.fingerprint}   (seen ${item.meta.seen}x)`);
    console.log(`    description: ${(item.meta.description || '').slice(0, 80)}...`);
    console.log(`    evidence:    ${JSON.stringify(item.meta.evidence).slice(0, 100)}`);
  });

  console.log('\nCommands: promote N | dismiss N | defer N | quit');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt('> ');
  rl.prompt();
  rl.on('line', (line) => {
    const [cmd, nStr] = line.trim().split(/\s+/);
    const n = parseInt(nStr, 10);
    if (cmd === 'quit') { rl.close(); return; }
    if (isNaN(n) || n < 1 || n > items.length) { rl.prompt(); return; }
    const item = items[n - 1];
    const base = item.name.replace('.meta.json', '');
    if (cmd === 'promote') {
      renameSync(join(triageDir, `${base}.json`), join(autoDir, `${base}.json`));
      renameSync(join(triageDir, `${base}.meta.json`), join(autoDir, `${base}.meta.json`));
      console.log(`Promoted ${base} to auto/`);
    } else if (cmd === 'dismiss') {
      unlinkSync(join(triageDir, `${base}.json`));
      unlinkSync(join(triageDir, `${base}.meta.json`));
      appendFileSync(dismissedLog, JSON.stringify({ at: new Date().toISOString(), base, meta: item.meta }) + '\n');
      console.log(`Dismissed ${base}`);
    } else if (cmd === 'defer') {
      console.log(`Deferred ${base}`);
    }
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
  return;  // important: return instead of break, since rl is async
}
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
