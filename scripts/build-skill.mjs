#!/usr/bin/env node
import { readdirSync, statSync, unlinkSync, realpathSync } from 'fs';
import { join, relative, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outName = 'bpmn-generator-v3.skill';
const outPath = join(repoRoot, outName);

// Inclusion rules: SKILL.md + scripts/*.js (no tests, no agents/, no robustness/, no node_modules)
//                  + scripts/config.json + scripts/package.json
//                  + references/*.md + references/*.json (no omg-spec/, no review-set/)
//
// Directory exclusions compare whole path segments, split on both `/` and `\`. A substring
// test such as `full.includes('/node_modules/')` assumes POSIX separators and never matches a
// Windows path, so node_modules/, agents/ and robustness/ would all land in the zip — and the
// resulting argument list exceeds the Windows command-line limit. The segments are taken from
// the path *relative to the walked root*, so a checkout that itself sits under a directory
// called e.g. `agents` excludes nothing by accident.
export function hasSegment(path, seg) {
  return path.split(/[\\/]/).includes(seg);
}

export function includeScriptFile(rel, name) {
  if (hasSegment(rel, 'node_modules')) return false;
  if (hasSegment(rel, 'agents') || hasSegment(rel, 'robustness')) return false;
  if (name.endsWith('.test.js')) return false;
  // Note: build-skill.mjs is intentionally excluded by the `.js`-only rule (not `.mjs`).
  return name.endsWith('.js') || name === 'config.json' || name === 'package.json';
}

export function includeReferenceFile(rel, name) {
  if (hasSegment(rel, 'omg-spec') || hasSegment(rel, 'review-set')) return false;
  return name.endsWith('.md') || name.endsWith('.json') || name.endsWith('.jsonld');
}

function collectIncludes() {
  const scriptsDir = join(repoRoot, 'scripts');
  const referencesDir = join(repoRoot, 'references');
  return [
    'SKILL.md',
    ...walk(scriptsDir, (full, name) => includeScriptFile(relative(scriptsDir, full), name))
      .map(f => relative(repoRoot, f)),
    ...walk(referencesDir, (full, name) => includeReferenceFile(relative(referencesDir, full), name))
      .map(f => relative(repoRoot, f)),
  ];
}

function walk(dir, filter, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, filter, acc);
    else if (filter(full, entry)) acc.push(full);
  }
  return acc;
}

function main() {
  const includes = collectIncludes();
  const args = ['-r', outPath, ...includes];
  try { unlinkSync(outPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  execFileSync('zip', args, { cwd: repoRoot, stdio: 'inherit' });
  console.log(`\nBuilt ${outName} (${includes.length} files).`);
  console.log(`Inspect: unzip -l ${outName}`);
}

// Build only when run as a script; importing the module (tests) has no side effects.
// realpath on both sides: Node resolves symlinks for import.meta.url but not for argv[1].
const isEntry = () => { try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isEntry()) main();
