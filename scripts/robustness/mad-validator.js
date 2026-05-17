/**
 * MaD external sanity-check validator.
 * See spec Section 4.9.
 */

import { readdirSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dotToLogicCore } from '../dot.js';
import { runPipelineChecks } from './stress-tester.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SUBSET = resolve(__dirname, '../../tests/fixtures/mad-subset');

export async function runMadCheck({ subsetDir = DEFAULT_SUBSET, limit = Infinity } = {}) {
  const files = readdirSync(subsetDir).filter(f => f.endsWith('.dot')).slice(0, limit);
  let passed = 0, failed = 0;
  const byCategory = {};

  for (const f of files) {
    const dot = readFileSync(join(subsetDir, f), 'utf8');
    let lc;
    try { lc = dotToLogicCore(dot); }
    catch (e) {
      failed++;
      byCategory['dot-parse-fail'] = (byCategory['dot-parse-fail'] || 0) + 1;
      continue;
    }
    const pipelineResult = await runPipelineChecks(lc, { timeoutMs: 15_000 });
    if (pipelineResult.failedStep === null) passed++;
    else {
      failed++;
      byCategory[pipelineResult.failedStep] = (byCategory[pipelineResult.failedStep] || 0) + 1;
    }
  }

  return { total: files.length, passed, failed, byCategory };
}
