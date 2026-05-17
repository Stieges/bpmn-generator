/**
 * Fixture persister — writes failure records to bucket directories with dedup.
 * See spec Section 4.6.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, '../../tests/fixtures/robustness');

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function writeFixtureFiles(dir, fingerprint, category, lcJson, meta) {
  ensureDir(dir);
  const fixturePath = join(dir, `${category}-${fingerprint}.json`);
  const metaPath = join(dir, `${category}-${fingerprint}.meta.json`);
  writeFileSync(fixturePath, JSON.stringify(lcJson, null, 2), 'utf8');
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

function readMetaIfExists(metaPath) {
  if (!existsSync(metaPath)) return null;
  try { return JSON.parse(readFileSync(metaPath, 'utf8')); } catch { return null; }
}

export async function persistFailure(record, sample, opts = {}) {
  const root = opts.fixtureRoot || DEFAULT_ROOT;
  const persistLlmSignal = opts.persistLlmSignal === true;

  if (record.bucket === 'llm-signal' && !persistLlmSignal) {
    return { wrote: 'skipped-gated', bucket: 'llm-signal', fingerprint: record.fingerprint };
  }

  if (!record.bucket) {
    return { wrote: 'skipped-no-bucket', bucket: null, fingerprint: null };
  }

  const dir = join(root, record.bucket);
  const metaPath = join(dir, `${record.category}-${record.fingerprint}.meta.json`);
  const existing = readMetaIfExists(metaPath);
  const now = new Date().toISOString();

  if (existing) {
    existing.seen = (existing.seen || 0) + 1;
    existing.last_seen = now;
    writeFileSync(metaPath, JSON.stringify(existing, null, 2), 'utf8');
    return { wrote: 'dedup', bucket: record.bucket, fingerprint: record.fingerprint };
  }

  const meta = {
    fingerprint: record.fingerprint,
    category: record.category,
    first_seen: now,
    last_seen: now,
    seen: 1,
    description: sample.description,
    model: sample.meta?.model,
    target: sample.meta?.target,
    evidence: record.evidence,
  };
  writeFixtureFiles(dir, record.fingerprint, record.category, sample.lcJson, meta);
  return { wrote: 'new', bucket: record.bucket, fingerprint: record.fingerprint };
}
