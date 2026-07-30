#!/usr/bin/env node
/**
 * docs-gate — CI gate that checks documented claims against the running code.
 *
 * The repo enforces its INPUT contract strictly (references/input-schema.json,
 * validated by ajv on every request). Its OUTPUT contract and its numeric claims
 * (rule count, script count, DI codes) were prose only, and drifted: the
 * CHANGELOG stopped six releases before HEAD, the README said "32 rules" after
 * a 33rd shipped, and /api/v1/orchestrate silently dropped a response field
 * three commits after it was documented on /api/v1/generate. This gate closes
 * that gap the same way the input schema does: by checking a real, running
 * artifact against a written-down contract, not by re-reading the prose.
 *
 * Three PROOF checks (exact, fail the build):
 *   1. response-contract — a real response from each endpoint, built the way
 *      scripts/http-server.js builds it, validated against references/api-schema.json.
 *   2. numbers — every "<N> rules" claim (README.md, CLAUDE.md) against
 *      scripts/rules.js; the "<N> top-level scripts" claim (CLAUDE.md) against
 *      `scripts/*.js`; every DI code in references/api-reference.md against
 *      scripts/di-check.js, in both directions.
 *   3. package-integrity — every `join(__dirname, ...)` a packed .js file reads
 *      at runtime, checked against what `npm pack` actually includes. Catches
 *      the class of bug where a published package throws on first import
 *      because a file it reads at module-load time never shipped.
 *
 * One NUDGE check (heuristic, warns, never fails the build):
 *   4. changelog-nudge — in a PR's commit range, if any feat/fix/perf commit
 *      touches scripts/** and CHANGELOG.md's [Unreleased] section is untouched
 *      or empty, print a ready-to-paste draft built from the commit subjects.
 *      This is a nudge, not a proof: a junk line in the CHANGELOG satisfies it.
 *      80% of this repo's last 40 commits already follow the type(scope): subject
 *      convention this reads.
 *
 * Usage:
 *   node .github/scripts/docs-gate.mjs [--base <ref> --head <ref>] [--json] [--summary]
 *   --base/--head enable check 4 (a commit range); without them it is skipped,
 *   not failed — there is no range to nudge about outside a pull request.
 *
 * Exit codes:
 *   0  every proof check passed (nudge warnings do not affect this)
 *   1  a proof check found a violation
 *   2  tooling error (a module would not import, npm pack failed, a schema
 *      $def is missing) — never passes silently
 *
 * Dependency note: imports `ajv`/`ajv-formats` via createRequire rooted at
 * scripts/package.json. Both are already runtime dependencies of scripts/
 * (used by scripts/schema-gate.js) — this reuses them without adding a
 * package.json of its own under .github/, matching dep-audit-gate.mjs's
 * "no dependency footprint for CI-only tooling" convention. Everything else
 * here is node: builtins.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SCRIPTS_DIR = resolve(REPO_ROOT, 'scripts');
const REFERENCES_DIR = resolve(REPO_ROOT, 'references');
const API_SCHEMA_PATH = resolve(REFERENCES_DIR, 'api-schema.json');

export class ToolingError extends Error {}

// ============================================================ 1. response-contract

/**
 * Builds one real response per endpoint, exactly the way scripts/http-server.js
 * assembles its JSON payload — imports the same functions http-server.js imports
 * and mirrors its field selection. Drifts here (a field added to the pipeline
 * result but not to the handler's payload, or vice versa) are exactly the class
 * of bug this check exists for; see the /api/v1/orchestrate diagnostics gap this
 * gate was written after.
 */
async function buildRealResponses() {
  let pipelineMod, rulesMod, importMod, orchestratorMod;
  try {
    pipelineMod = await import(join(SCRIPTS_DIR, 'pipeline.js'));
    rulesMod = await import(join(SCRIPTS_DIR, 'rules.js'));
    importMod = await import(join(SCRIPTS_DIR, 'import.js'));
    orchestratorMod = await import(join(SCRIPTS_DIR, 'orchestrator.js'));
  } catch (err) {
    throw new ToolingError(`could not import a scripts/ module: ${err.message}`);
  }

  const fixturePath = join(REPO_ROOT, 'tests', 'fixtures', 'simple-approval.json');
  let lc;
  try {
    lc = JSON.parse(readFileSync(fixturePath, 'utf8'));
  } catch (err) {
    throw new ToolingError(`could not read fixture ${fixturePath}: ${err.message}`);
  }

  const gen = await pipelineMod.runPipeline(lc, {});
  const hasErrors = gen.validation.errors.length > 0;
  const diBroken = gen.diagnostics ? !gen.diagnostics.ok : false;
  const generateResponse = {
    correlationId: 'docs-gate',
    status: hasErrors ? 'validation_error' : (diBroken ? 'diagram_error' : 'success'),
    bpmnXml: gen.bpmnXml,
    svg: gen.svg,
    validation: gen.validation,
    diagnostics: gen.diagnostics,
    callbackStatus: 'not_requested',
  };

  const val = pipelineMod.validateLogicCore(lc, rulesMod.profileForMode(null, 'document'));
  const validateResponse = { correlationId: 'docs-gate', status: 'success', validation: val };

  const logicCore = await importMod.bpmnToLogicCore(gen.bpmnXml);
  const importResponse = { correlationId: 'docs-gate', status: 'success', logicCore };

  const orch = await orchestratorMod.orchestrate(lc, {});
  const orchestrateResponse = {
    correlationId: 'docs-gate',
    status: 'success',
    logicCore: orch.logicCore,
    bpmnXml: orch.bpmnXml,
    svg: orch.svg,
    validation: orch.validation,
    diagnostics: orch.diagnostics,
    compliance: orch.compliance,
    history: orch.history,
    iterations: orch.iterations,
  };

  return { GenerateResponse: generateResponse, ValidateResponse: validateResponse,
    ImportResponse: importResponse, OrchestrateResponse: orchestrateResponse };
}

function loadAjv() {
  const require = createRequire(join(SCRIPTS_DIR, 'package.json'));
  const Ajv2020 = require('ajv/dist/2020.js').default;
  const addFormats = require('ajv-formats').default;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

/** Pure: takes already-built responses and an already-parsed schema. */
export function checkResponseContract(responses, schema, ajv) {
  ajv.addSchema(schema, schema.$id);
  const findings = [];
  for (const [defName, payload] of Object.entries(responses)) {
    const validate = ajv.getSchema(`${schema.$id}#/$defs/${defName}`);
    if (!validate) {
      throw new ToolingError(`references/api-schema.json has no $defs/${defName}`);
    }
    if (!validate(payload)) {
      findings.push({
        check: 'response-contract',
        detail: `${defName}: ` + validate.errors.map((e) => `${e.instancePath || '(root)'} ${e.message}`).join('; '),
      });
    }
  }
  return findings;
}

// ==================================================================== 2. numbers

// Matches only phrasing that states the whole rule engine's shape — rule count AND
// layer count together, in one of the two forms this repo actually uses ("N rules,
// M layers" / "N rules in M layers"), plus the German form docs/bpmn-generator-pipeline.md
// uses. Deliberately NOT a bare /(\d+) rules\b/: that also matches README.md's "WF-Net
// (3 rules)", a true claim about the WF01-WF03 subset, not the engine total. Requiring
// both numbers in one match is what keeps a subset claim like that from tripping this —
// a subset mention never also states a layer count in the same breath.
const RULE_LAYER_PATTERNS = [
  /(\d+)\s+rules,?\s*(?:in\s+)?(\d+)\s+layers/gi,
  /(\d+)\s+Regeln\s+in\s+(\d+)\s+Schichten/gi,
];

// There are two rule engines now: scripts/rules.js against Logic-Core, and
// scripts/dmn/rules.js against Decision-Core. A claim is checked against the DMN
// engine when the line it sits on says so, and against the BPMN engine otherwise.
//
// Routing on the line rather than on which numbers happen to match is deliberate.
// Accepting a claim that is true of EITHER engine would let a wrong BPMN number
// through whenever it coincided with the DMN one. This way an unqualified claim is
// always measured against the BPMN engine — so a DMN sentence that forgets to say
// "DMN" fails the gate, which is exactly the ambiguity worth failing on: a reader
// cannot tell those sentences apart either.
const DMN_CLAIM_RE = /\bdmn\b/i;

/** The line `index` falls on, for deciding which engine a claim is about. */
function lineContaining(text, index) {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end);
}

/**
 * Pure: every input is text already read from disk, or a number already
 * computed by the caller. See gatherNumberInputs() for the I/O side.
 */
export function checkNumbers({ readmeText, claudeMdText, apiReferenceText,
  roadmapText, skillText, evaluationText, pipelineDocText,
  actualRuleCount, actualLayerCount, actualDmnRuleCount, actualDmnLayerCount,
  actualTopLevelScriptCount, actualDiCodes }) {
  const findings = [];

  const numberSources = [
    ['README.md', readmeText], ['CLAUDE.md', claudeMdText], ['ROADMAP.md', roadmapText],
    ['SKILL.md', skillText], ['EVALUATION.md', evaluationText],
    ['docs/bpmn-generator-pipeline.md', pipelineDocText],
  ];
  for (const [file, text] of numberSources) {
    for (const pattern of RULE_LAYER_PATTERNS) {
      for (const m of text.matchAll(pattern)) {
        const claimedRules = Number(m[1]);
        const claimedLayers = Number(m[2]);
        const isDmn = DMN_CLAIM_RE.test(lineContaining(text, m.index));
        const engine = isDmn ? 'scripts/dmn/rules.js' : 'scripts/rules.js';
        const rules = isDmn ? actualDmnRuleCount : actualRuleCount;
        const layers = isDmn ? actualDmnLayerCount : actualLayerCount;
        if (claimedRules !== rules) {
          findings.push({ check: 'rule-count', detail:
            `${file} says "${m[0]}" — ${engine} has ${rules} rules` });
        }
        if (claimedLayers !== layers) {
          findings.push({ check: 'rule-count', detail:
            `${file} says "${m[0]}" — ${engine} has ${layers} distinct layers` });
        }
      }
    }
  }

  const scriptMatch = claudeMdText.match(/(\d+) top-level scripts/);
  if (!scriptMatch) {
    // An audit that cannot locate the claim it is supposed to check must not
    // read as "nothing to check" — the wording changed and the gate needs
    // updating, same principle as dep-audit-gate's unclassifiable severity.
    findings.push({ check: 'script-count', detail:
      'CLAUDE.md has no "<N> top-level scripts" claim — wording changed, update this gate' });
  } else {
    const claimed = Number(scriptMatch[1]);
    if (claimed !== actualTopLevelScriptCount) {
      findings.push({ check: 'script-count', detail:
        `CLAUDE.md says "${claimed} top-level scripts", scripts/*.js (non-recursive, no .test.js) has ${actualTopLevelScriptCount}` });
    }
  }

  const docCodes = new Set([...apiReferenceText.matchAll(/\bDI0\d\b/g)].map((m) => m[0]));
  const codeCodes = new Set(actualDiCodes);
  const missingInDocs = [...codeCodes].filter((c) => !docCodes.has(c));
  const missingInCode = [...docCodes].filter((c) => !codeCodes.has(c));
  if (missingInDocs.length) {
    findings.push({ check: 'di-codes', detail:
      `scripts/di-check.js emits codes not documented in references/api-reference.md: ${missingInDocs.join(', ')}` });
  }
  if (missingInCode.length) {
    findings.push({ check: 'di-codes', detail:
      `references/api-reference.md documents codes scripts/di-check.js does not emit: ${missingInCode.join(', ')}` });
  }

  return findings;
}

function gatherNumberInputs() {
  const readmeText = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
  const claudeMdText = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
  const apiReferenceText = readFileSync(join(REFERENCES_DIR, 'api-reference.md'), 'utf8');
  const roadmapText = readFileSync(join(REPO_ROOT, 'ROADMAP.md'), 'utf8');
  const skillText = readFileSync(join(REPO_ROOT, 'SKILL.md'), 'utf8');
  const evaluationText = readFileSync(join(REPO_ROOT, 'EVALUATION.md'), 'utf8');
  const pipelineDocText = readFileSync(join(REPO_ROOT, 'docs', 'bpmn-generator-pipeline.md'), 'utf8');
  const rulesSrc = readFileSync(join(SCRIPTS_DIR, 'rules.js'), 'utf8');
  const diCheckSrc = readFileSync(join(SCRIPTS_DIR, 'di-check.js'), 'utf8');

  const actualRuleCount = [...rulesSrc.matchAll(/^\s*id: '/gm)].length;
  // Each rule declares a `layer:`; the distinct values are the layer count — this
  // way a new layer (like Optimization was) is picked up without touching the gate.
  const actualLayerCount = new Set([...rulesSrc.matchAll(/layer: '([a-zA-Z_]+)'/g)].map((m) => m[1])).size;
  // The DMN engine is counted the same way from its own file; which of the two a
  // documented claim is measured against is decided in checkNumbers().
  const dmnRulesSrc = readFileSync(join(SCRIPTS_DIR, 'dmn', 'rules.js'), 'utf8');
  const actualDmnRuleCount = [...dmnRulesSrc.matchAll(/^\s*id: '/gm)].length;
  const actualDmnLayerCount = new Set([...dmnRulesSrc.matchAll(/layer: '([a-zA-Z_]+)'/g)].map((m) => m[1])).size;
  const actualDiCodes = [...new Set([...diCheckSrc.matchAll(/code: '(DI0\d)'/g)].map((m) => m[1]))];

  let topLevelStdout;
  try {
    topLevelStdout = execFileSync(
      'find', ['scripts', '-maxdepth', '1', '-name', '*.js', '-not', '-name', '*.test.js'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
  } catch (err) {
    throw new ToolingError(`could not count top-level scripts: ${err.shortMessage ?? err.message}`);
  }
  const actualTopLevelScriptCount = topLevelStdout.trim().split('\n').filter(Boolean).length;

  return { readmeText, claudeMdText, apiReferenceText, roadmapText, skillText, evaluationText,
    pipelineDocText, actualRuleCount, actualLayerCount, actualDmnRuleCount, actualDmnLayerCount,
    actualTopLevelScriptCount, actualDiCodes };
}

// ========================================================= 3. package-integrity

const DIRNAME_JOIN_RE = /\b(?:join|resolve)\(\s*__dirname\s*,\s*((?:'[^']*'|"[^"]*"|\s*,\s*)+)\)/g;
const RELATIVE_IMPORT_RE = /\bimport\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;
const RELATIVE_EXPORT_FROM_RE = /\bexport\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/g;

/**
 * BFS over static, first-party relative imports (`import ... from './x.js'`,
 * `export ... from '../y.js'`) starting from package.json's `exports` targets.
 * This is the actual question "package-integrity" needs answered: not every
 * .js file that ships in the tarball is something an npm consumer can reach —
 * scripts/http-server.js and scripts/robustness/*.js are CLI tools invoked from
 * a full checkout (where the files they read exist regardless of `files` in
 * package.json); nobody `require()`s them out of node_modules. Restricting the
 * scan to this reachable set is what tells schema-gate.js (imported by the "."
 * export) apart from those.
 *
 * Doesn't follow dynamic `import()` or bare-specifier imports (node: builtins,
 * npm dependencies) — those either aren't statically resolvable file paths or
 * aren't first-party code this check is about.
 */
function findReachableFiles(entryFiles) {
  const visited = new Set();
  const queue = [...entryFiles];
  while (queue.length) {
    const absFile = queue.shift();
    if (visited.has(absFile)) continue;
    visited.add(absFile);
    let src;
    try {
      src = readFileSync(absFile, 'utf8');
    } catch {
      continue; // an entry/import target that doesn't exist is main()'s problem, not this BFS's
    }
    for (const re of [RELATIVE_IMPORT_RE, RELATIVE_EXPORT_FROM_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        let resolved = resolve(dirname(absFile), m[1]);
        if (!/\.[cm]?js$/.test(resolved)) resolved += '.js';
        queue.push(resolved);
      }
    }
  }
  return visited;
}

function getExportsEntryFiles() {
  const pkg = JSON.parse(readFileSync(join(SCRIPTS_DIR, 'package.json'), 'utf8'));
  const exportsMap = pkg.exports;
  if (!exportsMap || typeof exportsMap !== 'object') {
    throw new ToolingError('scripts/package.json has no "exports" map — package-integrity cannot determine the public surface');
  }
  return Object.values(exportsMap).map((relPath) => resolve(SCRIPTS_DIR, relPath));
}

/**
 * Pure: takes the list of files `npm pack` would actually include (relative to
 * scripts/, which is the package root) and the set of absolute paths reachable
 * from package.json's `exports` (see findReachableFiles), scans the reachable
 * ones for `join(__dirname, ...)` / `resolve(__dirname, ...)` calls with
 * all-string-literal arguments, then checks whether the resolved path is in
 * that same packed-file list.
 *
 * Candidates are grouped by (file, target filename) before judging: a file may
 * legitimately try more than one path for the same read — the
 * `existsSync(publishedPath) ? publishedPath : devCheckoutPath` idiom this repo
 * uses in scripts/schema-gate.js and scripts/agents/prompt-sections.js is
 * exactly that, and its second branch is SUPPOSED to point outside the package
 * (it only ever runs when the file was not found inside it, i.e. never once
 * published). Only report a target with NO resolving candidate at all — that
 * is the case that actually throws at runtime.
 */
export function checkPackageIntegrity(packedFiles, reachableAbsPaths) {
  const packedSet = new Set(packedFiles);
  const byTarget = new Map(); // `${relPath}::${targetName}` -> [{resolvedRel, escapes}]

  for (const relPath of packedFiles) {
    if (!relPath.endsWith('.js') || relPath.endsWith('.test.js')) continue;
    const abs = join(SCRIPTS_DIR, relPath);
    if (!reachableAbsPaths.has(abs)) continue;
    let src;
    try {
      src = readFileSync(abs, 'utf8');
    } catch {
      continue; // listed by npm pack but unreadable here is not this check's concern
    }

    DIRNAME_JOIN_RE.lastIndex = 0;
    let m;
    while ((m = DIRNAME_JOIN_RE.exec(src))) {
      const segments = [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2]);
      if (segments.length === 0) continue;
      const resolvedAbs = join(dirname(abs), ...segments);
      const resolvedRel = relative(SCRIPTS_DIR, resolvedAbs).split('\\').join('/');
      const escapes = resolvedRel.startsWith('..');
      const key = `${relPath}::${segments[segments.length - 1]}`;
      if (!byTarget.has(key)) byTarget.set(key, []);
      byTarget.get(key).push({ resolvedRel, escapes });
    }
  }

  const findings = [];
  for (const [key, candidates] of byTarget) {
    const [relPath] = key.split('::');
    const anyResolves = candidates.some((c) => !c.escapes && packedSet.has(c.resolvedRel));
    if (anyResolves) continue;
    findings.push({
      check: 'package-integrity',
      detail: `${relPath} reads ${candidates.map((c) => `"${c.resolvedRel}"`).join(' or ')} at runtime — ` +
        'none of those paths are included in the published package (see scripts/package.json "files")',
    });
  }
  return findings;
}

function getPackedFiles() {
  let stdout;
  try {
    stdout = execFileSync('npm', ['pack', '--dry-run', '--json'],
      { cwd: SCRIPTS_DIR, encoding: 'utf8', maxBuffer: 1e7 });
  } catch (err) {
    throw new ToolingError(`could not run \`npm pack --dry-run\`: ${err.shortMessage ?? err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ToolingError('`npm pack --dry-run --json` produced output that is not JSON');
  }
  const files = parsed?.[0]?.files;
  if (!Array.isArray(files)) {
    throw new ToolingError('`npm pack --dry-run --json` had an unexpected shape (files array missing)');
  }
  return files.map((f) => f.path);
}

// ========================================================== 4. changelog-nudge

const CONVENTIONAL_RE = /^(feat|fix|perf)(\([^)]*\))?(!)?:\s*(.*)$/;

function extractUnreleasedSection(changelogText) {
  const m = changelogText.match(/## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/);
  return m ? m[1] : '';
}

/**
 * A nudge, not a proof: touching CHANGELOG.md at all — even a stray blank
 * line — satisfies it. It exists to surface a ready-to-paste draft, not to
 * enforce content quality.
 */
export function evaluateChangelogNudge({ subjects, changedFiles, changelogUnreleasedText }) {
  const relevant = subjects
    .map((s) => ({ subject: s, m: s.match(CONVENTIONAL_RE) }))
    .filter((x) => x.m);
  const touchesScripts = changedFiles.some((f) => f.startsWith('scripts/'));
  const touchesChangelog = changedFiles.includes('CHANGELOG.md');
  const unreleasedHasContent = changelogUnreleasedText.trim().length > 0;

  if (relevant.length === 0 || !touchesScripts) return { nudge: false };
  if (touchesChangelog && unreleasedHasContent) return { nudge: false };

  const byType = { feat: [], fix: [], perf: [] };
  for (const { m } of relevant) byType[m[1]].push(m[4].trim());

  const section = (heading, items) => (items.length ? [`### ${heading}`, ...items.map((s) => `- ${s}`), ''] : []);
  const draft = [
    ...section('Added', byType.feat),
    ...section('Fixed', byType.fix),
    ...section('Changed', byType.perf),
  ].join('\n').trimEnd();

  return {
    nudge: true,
    commitCount: relevant.length,
    reason: touchesChangelog ? 'CHANGELOG.md touched but [Unreleased] is still empty' : 'CHANGELOG.md not touched',
    draft,
  };
}

function gitCommitSubjects(range) {
  try {
    return execFileSync('git', ['log', '--format=%s', range], { cwd: REPO_ROOT, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
  } catch (err) {
    throw new ToolingError(`\`git log ${range}\` failed: ${err.shortMessage ?? err.message}`);
  }
}

function gitChangedFiles(range) {
  try {
    return execFileSync('git', ['diff', '--name-only', range], { cwd: REPO_ROOT, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
  } catch (err) {
    throw new ToolingError(`\`git diff --name-only ${range}\` failed: ${err.shortMessage ?? err.message}`);
  }
}

// ------------------------------------------------------------------- output

function render({ violations, nudge }) {
  const lines = [];
  if (violations.length) {
    lines.push('PROOF — VIOLATIONS (block the build)');
    for (const v of violations) {
      lines.push(`  [${v.check}]`);
      lines.push(`    ${v.detail}`);
    }
    lines.push('');
  } else {
    lines.push('PROOF — all checks passed (response contract, numbers, package integrity)');
    lines.push('');
  }
  if (nudge?.nudge) {
    lines.push(`NUDGE (non-blocking) — ${nudge.commitCount} feat/fix/perf commit(s) touch scripts/**, ${nudge.reason}`);
    lines.push('Suggested CHANGELOG.md draft:');
    lines.push('');
    lines.push(nudge.draft);
    lines.push('');
  }
  lines.push(`${violations.length} violation(s)${nudge?.nudge ? ', 1 nudge' : ''}`);
  return lines.join('\n');
}

// --------------------------------------------------------------------- main

function parseArgs(argv) {
  const opts = { base: null, head: 'HEAD', json: false, summary: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') opts.base = argv[++i];
    else if (argv[i] === '--head') opts.head = argv[++i];
    else if (argv[i] === '--json') opts.json = true;
    else if (argv[i] === '--summary') opts.summary = true;
    else throw new ToolingError(`unknown argument "${argv[i]}"`);
  }
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);

  const schema = JSON.parse(readFileSync(API_SCHEMA_PATH, 'utf8'));
  const responses = await buildRealResponses();
  const ajv = loadAjv();
  const reachableAbsPaths = findReachableFiles(getExportsEntryFiles());
  const violations = [
    ...checkResponseContract(responses, schema, ajv),
    ...checkNumbers(gatherNumberInputs()),
    ...checkPackageIntegrity(getPackedFiles(), reachableAbsPaths),
  ];

  let nudge = { nudge: false };
  if (opts.base) {
    const range = `${opts.base}..${opts.head}`;
    const subjects = gitCommitSubjects(range);
    const changedFiles = gitChangedFiles(range);
    const changelogText = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
    nudge = evaluateChangelogNudge({
      subjects, changedFiles,
      changelogUnreleasedText: extractUnreleasedSection(changelogText),
    });
  }

  const result = { violations, nudge };

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(render(result) + '\n');
  }

  if (opts.summary && process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      '## Docs gate',
      '',
      `**${violations.length}** violation(s)${nudge.nudge ? ' · 1 nudge' : ''}`,
      '',
      '```',
      render(result),
      '```',
    ].join('\n');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }

  return violations.length > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`docs-gate: ${err.message}\n`);
      process.exit(2);
    },
  );
}
