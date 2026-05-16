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
    case 'run':
      console.log('[robustness] run — not implemented yet (Phase 2+)');
      console.log('Resolved endpoint:', resolveEndpoint(config, flags));
      break;
    case 'triage':
      console.log('[robustness] triage — not implemented yet (Phase 4)');
      break;
    case 'mad-check':
      console.log('[robustness] mad-check — not implemented yet (Phase 6)');
      break;
    case 'report':
      console.log('[robustness] report — not implemented yet (Phase 4)');
      break;
    default:
      console.error(`Usage: node scripts/robustness/cli.js <run|triage|mad-check|report> [flags]`);
      process.exit(1);
  }
}

// Only run main when invoked directly, not when imported in tests
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
