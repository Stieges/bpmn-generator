#!/usr/bin/env node
/**
 * One-time MaD curation. Run once when MaD dataset is acquired; not part of regular CLI.
 *
 * Usage: node scripts/robustness/curate-mad.js --src /path/to/mad-raw.jsonl --n 200
 *
 * Assumes input is JSONL where each line is {domain, description, dot} — adjust the
 * parsing below if MaD ships in a different format.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dotToLogicCore } from '../dot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../../tests/fixtures/mad-subset');

function parseArgs() {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  return { src: flag('--src'), n: parseInt(flag('--n') || '200', 10) };
}

const { src, n } = parseArgs();
if (!src) {
  console.error('Usage: node scripts/robustness/curate-mad.js --src PATH --n 200');
  console.error('');
  console.error('  --src: path to MaD raw JSONL (one {domain, description, dot} per line)');
  console.error('  --n:   target subset size (default 200)');
  process.exit(1);
}

if (!existsSync(src)) {
  console.error(`Source file not found: ${src}`);
  process.exit(2);
}

const entries = readFileSync(src, 'utf8').trim().split('\n').map(line => {
  try { return JSON.parse(line); } catch { return null; }
}).filter(Boolean);

if (entries.length === 0) {
  console.error('No valid JSONL entries in source file.');
  process.exit(3);
}

const byDomain = {};
for (const e of entries) {
  const d = e.domain || 'unknown';
  (byDomain[d] = byDomain[d] || []).push(e);
}
const domainNames = Object.keys(byDomain);
const perDomain = Math.ceil(n / domainNames.length);

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const index = [];
let kept = 0;
for (const domain of domainNames) {
  const candidates = byDomain[domain].sort(() => Math.random() - 0.5).slice(0, perDomain * 3);
  for (const c of candidates) {
    if (kept >= n) break;
    if (!c.dot) continue;
    try { dotToLogicCore(c.dot); } catch { continue; }  // skip parser failures
    const fname = `${domain}-${String(kept).padStart(3, '0')}.dot`;
    writeFileSync(join(OUT_DIR, fname), c.dot, 'utf8');
    index.push({
      file: fname,
      domain,
      sourceDescription: (c.description || '').slice(0, 100)
    });
    kept++;
  }
}
writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
console.log(`[curate-mad] Curated ${kept} samples (target ${n}) into ${OUT_DIR}`);
console.log(`[curate-mad] Index written to ${OUT_DIR}/index.json`);
console.log(`[curate-mad] Next: spot-check 20 random samples, then commit.`);
