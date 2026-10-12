#!/usr/bin/env node
import { readdirSync, statSync, unlinkSync, realpathSync, readFileSync, existsSync } from 'fs';
import { join, relative, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outName = 'bpmn-generator.skill';
const outPath = join(repoRoot, outName);

// What goes into the bundle
// -------------------------
// The skill runs exactly the CLIs its instructions name as `node <dir>/<file>.js` — in SKILL.md and
// in the reference files SKILL.md points to, which ship in the bundle and which progressive
// disclosure means the skill reads instead of SKILL.md for anything beyond the core commands (today
// bpmn/pipeline.js, bpmn/import.js, bpmn/redesign-cli.js, dmn/pipeline.js, dmn/import.js and
// scenarios/pipeline.js). Those are the bundle's entry points, minus `NOT_SKILL_CLIS`, and the
// scripts/ part of the bundle is their static import closure (`import … from './x.js'`,
// `export … from`, and `import('./x.js')` with a literal), plus config.json and package.json,
// which shared/utils.js and shared/version.js read at runtime. references/*.md|json|jsonld (no
// omg-spec/, no review-set/) ship as before: resource-paths.js resolves the schemas, the prompt
// template and the ontology from there.
//
// Why a closure rather than "every .js except agents/ and robustness/": that rule bundled
// orchestrator.js, http-server.js and mcp-bpmn-server.js, all three of which import agents/, so
// three of the bundle's own scripts failed at import. The skill never runs them (SKILL.md names
// none; the HTTP API and the MCP server are run from a checkout or the npm package), so they stay
// out rather than pulling the LLM agents into a skill whose extraction the host model does itself.
// A module the closure reaches but `includeScriptFile` refuses (agents/, robustness/, a test)
// aborts the build: a bundle that cannot import its own entry point is never written.
//
// Directory exclusions compare whole path segments, split on both `/` and `\`. A substring
// test such as `full.includes('/node_modules/')` assumes POSIX separators and never matches a
// Windows path. The segments are taken from the path *relative to the walked root*, so a
// checkout that itself sits under a directory called e.g. `agents` excludes nothing by accident.
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

const NODE_CLI_RE = /\bnode\s+((?:[\w-]+\/)*[\w-]+\.js)\b/g;

// CLIs the reference files document but the skill never runs: both import agents/ and are started
// from a repository checkout or the npm package (references/api-reference.md, references/cli.md).
// Named here rather than skipped silently, so a new command in a reference file either reaches the
// bundle or fails the build.
export const NOT_SKILL_CLIS = new Set(['http-server.js', 'mcp-bpmn-server.js']);

/**
 * The CLIs the given instruction texts (SKILL.md, then the bundled reference files) tell the skill
 * to run, as paths relative to scripts/, first-seen order. A `scripts/` prefix (a command written
 * for the repository root) is dropped; `NOT_SKILL_CLIS` are left out.
 */
export function skillEntryPoints(...texts) {
  const found = texts.flatMap(t => [...t.matchAll(NODE_CLI_RE)].map(m => m[1].replace(/^scripts\//, '')));
  return [...new Set(found)].filter(e => !NOT_SKILL_CLIS.has(e));
}

const IMPORT_RES = [
  /\bimport\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/g,
  /\bexport\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/g,
  /\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g,
];

/** First-party relative specifiers a source imports: static, re-export, literal dynamic import. */
export function relativeImports(src) {
  const out = [];
  for (const re of IMPORT_RES) for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

const toPosix = p => p.split(/[\\/]/).join('/');

/**
 * Breadth-first import closure from `entries` (paths relative to `scriptsDir`). Returns every
 * reachable module as a POSIX path relative to `scriptsDir`, sorted. Throws on an import that
 * resolves to no file or leaves `scriptsDir`.
 */
export function reachableModules(scriptsDir, entries) {
  const seen = new Set();
  const queue = entries.map(e => resolve(scriptsDir, e));
  while (queue.length) {
    const abs = queue.shift();
    if (seen.has(abs)) continue;
    const rel = relative(scriptsDir, abs);
    if (rel.startsWith('..')) throw new Error(`build-skill: an import leaves scripts/: ${toPosix(rel)}`);
    if (!existsSync(abs)) throw new Error(`build-skill: ${toPosix(rel)} is imported but does not exist`);
    seen.add(abs);
    for (const spec of relativeImports(readFileSync(abs, 'utf8'))) queue.push(resolve(dirname(abs), spec));
  }
  return [...seen].map(a => toPosix(relative(scriptsDir, a))).sort();
}

/** The bundle's file list, relative to the repo root, POSIX separators. */
export function collectIncludes(root = repoRoot) {
  const scriptsDir = join(root, 'scripts');
  const referencesDir = join(root, 'references');
  const references = walk(referencesDir, (full, name) => includeReferenceFile(relative(referencesDir, full), name));
  const instructionTexts = [join(root, 'SKILL.md'), ...references.filter(f => f.endsWith('.md'))]
    .map(f => readFileSync(f, 'utf8'));
  const entries = skillEntryPoints(...instructionTexts);
  if (entries.length === 0) throw new Error('build-skill: SKILL.md names no `node <file>.js` entry point');
  const modules = reachableModules(scriptsDir, entries);
  const refused = modules.filter(rel => !includeScriptFile(rel, rel.split('/').pop()));
  if (refused.length) {
    throw new Error(`build-skill: the skill's entry points (${entries.join(', ')}) reach modules ` +
      `the bundle excludes: ${refused.join(', ')}`);
  }
  return [
    'SKILL.md',
    ...[...modules, 'config.json', 'package.json'].map(rel => `scripts/${rel}`),
    ...references.map(f => toPosix(relative(root, f))),
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
