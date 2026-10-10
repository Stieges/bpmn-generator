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
 * Four PROOF checks (exact, fail the build):
 *   1. response-contract — a real response from each endpoint, built the way
 *      scripts/http-server.js builds it, validated against references/api-schema.json.
 *   2. numbers — every "<N> rules" claim (README.md, CLAUDE.md) against
 *      scripts/bpmn/rules.js; the "<N> top-level scripts" claim (CLAUDE.md) against
 *      `scripts/*.js`; every diagnostic code in references/api-reference.md against
 *      the module that emits it, in both directions — driven by a small
 *      (module, prefix, doc) table (CODE_FAMILIES) covering DI (scripts/bpmn/di-check.js)
 *      and NC (scripts/bpmn/net-check.js) today.
 *   3. doc-paths — every `scripts/...`-, `references/...`-, `rules/...`-,
 *      `tests/...`-, `docs/...`-, `frontend/...`- or `.github/...`-shaped path
 *      string mentioned in prose (README.md, CLAUDE.md, ROADMAP.md, SKILL.md,
 *      EVALUATION.md, docs/bpmn-generator-pipeline.md, references/api-reference.md,
 *      references/fachliches-regelwerk.md, CONTRIBUTING.md, COMPATIBILITY.md,
 *      SECURITY.md, THIRD-PARTY-NOTICES.md, docs/ROBUSTNESS-STACK.md,
 *      rules/custom/README.md, scripts/robustness/README.md), and every
 *      `node <file>.js` CLI example in them, resolves to a real file or
 *      directory. Guards against exactly what a restructure commit did to this
 *      repo: move dozens of files and touch every doc reference to them — a
 *      moved file with a stale doc reference used to be silent, and still can
 *      be for any doc file not in this list.
 *   4. package-integrity — every `join(__dirname, ...)` a packed .js file reads
 *      at runtime, checked against what `npm pack` actually includes. Catches
 *      the class of bug where a published package throws on first import
 *      because a file it reads at module-load time never shipped.
 *
 * One NUDGE check (heuristic, warns, never fails the build):
 *   5. changelog-nudge — in a PR's commit range, if any feat/fix/perf commit
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
 * (used by scripts/bpmn/schema-gate.js and scripts/dmn/schema-gate.js) — this reuses them without adding a
 * package.json of its own under .github/, matching dep-audit-gate.mjs's
 * "no dependency footprint for CI-only tooling" convention. Everything else
 * here is node: builtins.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
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
    pipelineMod = await import(join(SCRIPTS_DIR, 'bpmn', 'pipeline.js'));
    rulesMod = await import(join(SCRIPTS_DIR, 'bpmn', 'rules.js'));
    importMod = await import(join(SCRIPTS_DIR, 'bpmn', 'import.js'));
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

// Rule-count claims must name their rule set right at the number (decisions F20, F28): "40 BPMN
// rules, 5 layers", "19 DMN rules in 3 layers", "40 BPMN rules across 5 layers", "2 cross-notation
// rules, 1 layer", German "40 BPMN-Regeln in 5 Schichten" / "2 übergreifende Regeln in 1 Schicht".
// The actual counts come from the ontology (references/ontology.jsonld, via scripts/shared/ontology.js),
// one per rule set — never from the rule modules' source, whose rule objects carry no `layer:`
// literal any more, so a source scan would count 0. An unqualified claim ("38 rules, 5 layers",
// "DMN rule engine (19 rules, 3 layers)") fails outright: neither a reader nor the gate can tell
// which rule set it is about. Requiring a layer count in the same match keeps subset claims such as
// README's "WF-Net (3 rules)" out of scope.
const GERMAN_RULE_SET_WORDS = { 'übergreifende': 'cross-notation' };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Pure: the claim patterns for a given list of rule-set names (from the ontology). */
export function ruleClaimPatterns(ruleSetNames) {
  const en = ruleSetNames.map(escapeRe).join('|');
  const de = [...ruleSetNames, ...Object.keys(GERMAN_RULE_SET_WORDS)].map(escapeRe).join('|');
  return {
    qualified: [
      new RegExp(`(\\d+)\\s+(${en})\\s+rules,?\\s*(?:in\\s+|across\\s+)?(\\d+)\\s+layers?\\b`, 'gi'),
      new RegExp(`(\\d+)\\s+(${de})[-\\s]Regeln\\s+in\\s+(\\d+)\\s+Schicht(?:en)?\\b`, 'gi'),
    ],
    unqualified: [
      /(\d+)\s+rules,?\s*(?:in\s+|across\s+)?(\d+)\s+layers?\b/gi,
      /(\d+)\s+Regeln\s+in\s+(\d+)\s+Schicht(?:en)?\b/gi,
    ],
  };
}

// Diagnostic-code families, each pinned against the doc section that documents it. Table-driven
// (module, prefix, doc) so a new family — NC today, whatever comes after it — is one entry, not a
// second copy of the whole check. Two properties both entries must keep:
//  - fails in both drift directions: a code the module emits but the doc never mentions, AND a
//    code the doc mentions that the module no longer emits;
//  - the `prefix` regex is anchored with `\b` on both ends, so a code appearing inside running
//    prose (not as a standalone token) never accidentally satisfies the check.
// NC02b/NC03a/NC03b are not the same shape as DI01…DI06 — `prefix` has to match the optional
// trailing letter, or NC02b would be misread as a mention of NC02. That is the only way NC's
// shape differs from DI's: `\bNC\d{2}[ab]?\b` stays as open-ended in the digit as DI\d{2} is, on
// purpose — a family that is hard-coded to the codes that exist today (`NC0[1-6]`) would go
// blind to NC07 the day it ships, which is exactly the drift this check exists to catch, one
// level up. Two later stages of this plan touch net-check.js and are expected to add codes.
// Both patterns match exactly two digits, not `0\d` (one hard-coded leading zero + one digit):
// a tenth code in either family (DI10, NC10) has no leading zero, and `0\d` would leave it
// invisible on both the `prefix` side (never counted as "documented") and the `sourcePattern`
// side (never counted as "emitted") at once — the exact symmetric blind spot this comment
// used to warn about while still being one instance of it.
// `sourcePattern` extracts the codes a module actually emits from its own source text (the
// `code: '...'` object-literal idiom both di-check.js and net-check.js use), one capture group
// per code. It is deliberately as open in the digit as `prefix` — a family whose sourcePattern is
// narrower than its prefix (or vice versa) can go blind on one side of the drift check without
// either side's test noticing, which is exactly the bug this table shape exists to make
// impossible: see extractActualCodes()'s own regression test in docs-gate.test.js.
export const CODE_FAMILIES = [
  {
    check: 'di-codes',
    module: 'scripts/bpmn/di-check.js',
    doc: 'references/api-reference.md',
    prefix: /\bDI\d{2}\b/g,
    sourcePattern: /code: '(DI\d{2})'/g,
    actualCodesKey: 'actualDiCodes',
  },
  {
    check: 'nc-codes',
    module: 'scripts/bpmn/net-check.js',
    doc: 'references/api-reference.md',
    prefix: /\bNC\d{2}[ab]?\b/g,
    sourcePattern: /code: '(NC\d{2}[ab]?)'/g,
    actualCodesKey: 'actualNcCodes',
  },
];

/**
 * Pure: the codes a module's own source actually declares, via `family.sourcePattern`. Exported
 * so a test can feed it a synthetic source snippet (e.g. one containing `code: 'NC07'`) without
 * needing a real file on disk — the regression pin for "a code outside the range that existed
 * when the pattern was written must still be caught" lives on this function.
 */
export function extractActualCodes(moduleSrc, sourcePattern) {
  return [...new Set([...moduleSrc.matchAll(sourcePattern)].map((m) => m[1]))];
}

/**
 * One family's drift check, both directions. Pure: takes the doc text it is pinned against and
 * the actual codes the caller already extracted from the module's source.
 */
function checkCodeFamily(family, docText, actualCodes) {
  const findings = [];
  const docCodes = new Set([...docText.matchAll(family.prefix)].map((m) => m[0]));
  const codeCodes = new Set(actualCodes);
  const missingInDocs = [...codeCodes].filter((c) => !docCodes.has(c));
  const missingInCode = [...docCodes].filter((c) => !codeCodes.has(c));
  if (missingInDocs.length) {
    findings.push({ check: family.check, detail:
      `${family.module} emits codes not documented in ${family.doc}: ${missingInDocs.join(', ')}` });
  }
  if (missingInCode.length) {
    findings.push({ check: family.check, detail:
      `${family.doc} documents codes ${family.module} does not emit: ${missingInCode.join(', ')}` });
  }
  return findings;
}

/**
 * Pure: every input is text already read from disk, or a number already
 * computed by the caller. See gatherNumberInputs() for the I/O side.
 * `ruleSets` is `{ [ruleSetName]: { rules: number, layers: number } }` (see ruleSetCounts()).
 */
export function checkNumbers({ readmeText, claudeMdText, apiReferenceText,
  roadmapText, skillText, evaluationText, pipelineDocText,
  ruleSets, actualTopLevelScriptCount, actualDiCodes, actualNcCodes }) {
  const findings = [];
  const actualCodesByKey = { actualDiCodes, actualNcCodes };
  const { qualified, unqualified } = ruleClaimPatterns(Object.keys(ruleSets));

  const numberSources = [
    ['README.md', readmeText], ['CLAUDE.md', claudeMdText], ['ROADMAP.md', roadmapText],
    ['SKILL.md', skillText], ['EVALUATION.md', evaluationText],
    ['docs/bpmn-generator-pipeline.md', pipelineDocText],
  ];
  for (const [file, text] of numberSources) {
    for (const pattern of qualified) {
      for (const m of text.matchAll(pattern)) {
        const word = m[2].toLowerCase();
        const ruleSet = GERMAN_RULE_SET_WORDS[word] ??
          Object.keys(ruleSets).find((k) => k.toLowerCase() === word);
        const actual = ruleSets[ruleSet];
        if (Number(m[1]) !== actual.rules) {
          findings.push({ check: 'rule-count', detail:
            `${file} says "${m[0]}" — the ontology has ${actual.rules} ${ruleSet} rules` });
        }
        if (Number(m[3]) !== actual.layers) {
          findings.push({ check: 'rule-count', detail:
            `${file} says "${m[0]}" — the ontology has ${actual.layers} ${ruleSet} layers` });
        }
      }
    }
    for (const pattern of unqualified) {
      for (const m of text.matchAll(pattern)) {
        findings.push({ check: 'rule-count', detail:
          `${file} says "${m[0]}" without naming its rule set at the number — write ` +
          `"${m[1]} BPMN rules", "${m[1]} DMN rules" or "${m[1]} cross-notation rules"` });
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

  // Both families document today in the same file (references/api-reference.md); the table
  // still carries `doc` per-entry so a family that moves to its own doc file is a one-line change.
  const docTextByFile = { 'references/api-reference.md': apiReferenceText };
  for (const family of CODE_FAMILIES) {
    findings.push(...checkCodeFamily(family, docTextByFile[family.doc], actualCodesByKey[family.actualCodesKey]));
  }

  return findings;
}

/**
 * Pure: rule and layer counts per rule set, from a vocabulary built by scripts/shared/ontology.js.
 * Refuses to report 0 rules for a supported notation — that is a broken ontology, not a fact.
 */
export function ruleSetCounts(vocabulary) {
  const out = {};
  for (const [name, set] of Object.entries(vocabulary.ruleSets)) {
    out[name] = { rules: set.rules.length, layers: set.layers.length };
  }
  for (const n of vocabulary.notations) {
    if (n.status === 'supported' && !(out[n.name]?.rules > 0)) {
      throw new ToolingError(`the ontology lists no ${n.name} rules — refusing to count 0 (references/ontology.jsonld)`);
    }
  }
  return out;
}

/**
 * Loads the ontology dynamically, so a broken or missing file is a ToolingError (exit 2), never a
 * static-import crash before main() (exit 1, which would read as "a proof check failed").
 */
export async function loadRuleSetCounts(importOntology = () => import(join(SCRIPTS_DIR, 'shared', 'ontology.js'))) {
  let mod;
  try {
    mod = await importOntology();
  } catch (err) {
    throw new ToolingError(`could not load the ontology (references/ontology.jsonld): ${err.message}`);
  }
  return ruleSetCounts(mod.VOCABULARY);
}

async function gatherNumberInputs() {
  const readmeText = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
  const claudeMdText = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
  const apiReferenceText = readFileSync(join(REFERENCES_DIR, 'api-reference.md'), 'utf8');
  const roadmapText = readFileSync(join(REPO_ROOT, 'ROADMAP.md'), 'utf8');
  const skillText = readFileSync(join(REPO_ROOT, 'SKILL.md'), 'utf8');
  const evaluationText = readFileSync(join(REPO_ROOT, 'EVALUATION.md'), 'utf8');
  const pipelineDocText = readFileSync(join(REPO_ROOT, 'docs', 'bpmn-generator-pipeline.md'), 'utf8');
  const ruleSets = await loadRuleSetCounts();

  // Driven by the same CODE_FAMILIES table checkNumbers() checks against, so a family's actual
  // codes are always extracted with the exact `sourcePattern` that table declares for it — no
  // second, hand-written extraction line per family to drift out of step with the table.
  const actualCodesByKey = {};
  for (const family of CODE_FAMILIES) {
    const moduleSrc = readFileSync(join(REPO_ROOT, family.module), 'utf8');
    actualCodesByKey[family.actualCodesKey] = extractActualCodes(moduleSrc, family.sourcePattern);
  }
  const { actualDiCodes, actualNcCodes } = actualCodesByKey;

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
    pipelineDocText, ruleSets, actualTopLevelScriptCount, actualDiCodes, actualNcCodes };
}

// ==================================================================== 3. doc-paths

// Pattern 1: explicit repo paths anywhere in prose — "scripts/pipeline.js",
// "references/input-schema.json", "rules/default-profile.json", etc. The
// character class also admits `*` and `<` — not because either belongs in a
// real path, but because excluding them would silently truncate a genuine
// glob or placeholder (e.g. "scripts/redesign*.js" in a grep example,
// "tests/bench/comparison-*.html") into a shorter token that looks like a
// real, non-existent path instead of the glob it actually is. Capturing them
// intact is what lets isAllowlistedDocPath's `*`/`<` check (below) recognize
// and skip them, per this task's allowlist spec.
const REPO_PATH_RE = /(?:scripts|references|rules|tests|docs|frontend|\.github)\/[A-Za-z0-9_.\/*<-]+/g;

// Pattern 2: `node <file>.js` CLI examples — "node pipeline.js input.json out",
// "node scripts/robustness/cli.js run". Only the file argument itself is
// captured; a CLI token is judged against scripts/, scripts/robustness/ and the
// repo root (see checkDocPaths) because most examples in this repo are written
// as if `cd scripts` already happened.
const CLI_NODE_RE = /\bnode\s+((?:[\w.-]+\/)*[\w.-]+\.m?js)\b/g;

// Documented-but-transient or generated paths: real at some point in the build
// or CI lifecycle, but not something `git ls-files` (or a plain directory
// listing of a fresh checkout) will ever show. Each entry needs a reason —
// an unexplained allowlist entry is indistinguishable from silencing a real
// finding.
const DOC_PATH_ALLOWLIST = [
  'scripts/references/',       // prepack build artifact (scripts/prepack-copy-references.mjs), removed by postpack
  'references/omg-spec/',      // gitignored, downloaded locally by the OMG-compliance tooling
  'tests/robustness-reports/', // gitignored, written by scripts/robustness/cli.js runs
  'docs/specs/',                // documented future location, not yet created
  'frontend/',                  // documented future location, not yet created
  'audit/',                     // gitignored, written by scripts/audit.js at runtime (AUDIT_LOG_PATH default)
  'dead-letter/',                // gitignored, written by scripts/delivery.js at runtime (DEAD_LETTER_PATH default)
  'scripts/coverage/',          // gitignored, written by `npm test -- --coverage`
  'tests/fixtures/mad-subset/', // one-time curation output (scripts/robustness/README.md); not committed until that step runs
  'tests/fixtures/mad-subset',  // same path without trailing slash — appears as a default param value in docs/ROBUSTNESS-STACK.md
  'rules/custom/acme.json',     // illustrative example filename in rules/custom/README.md, never meant to exist
  'rules/custom/acme-dmn.json', // illustrative example filename in rules/custom/README.md, never meant to exist
];

/** Strips trailing punctuation, a `:<line>`/`:L<line>` suffix and a `#fragment` a doc token picked up from prose. */
function cleanDocPathToken(raw) {
  let token = raw;
  token = token.replace(/#[^\s)]*$/, '');           // #fragment
  token = token.replace(/:L?\d+$/, '');              // :412 or :L412
  token = token.replace(/[)\,.`:]+$/, '');           // trailing punctuation
  return token;
}

function isAllowlistedDocPath(token) {
  if (token.includes('*') || token.includes('<')) return true; // glob or placeholder, not a path
  return DOC_PATH_ALLOWLIST.some((prefix) => token === prefix || token.startsWith(prefix));
}

/**
 * Pure: takes already-read doc texts and an `exists(relPath)` probe (a thin
 * wrapper the caller supplies over fs — kept out of this function so tests can
 * pass a synthetic filesystem instead of touching disk). Returns findings for
 * every documented path that resolves to nothing real, is not a directory
 * claim that exists, and is not covered by the allowlist.
 */
export function checkDocPaths(docSources, exists) {
  const findings = [];
  const seen = new Set(); // dedupe (file, token) pairs — a path can appear many times in one doc

  for (const [file, text] of docSources) {
    for (const m of text.matchAll(REPO_PATH_RE)) {
      const token = cleanDocPathToken(m[0]);
      if (!token) continue;
      const key = `${file}::${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (isAllowlistedDocPath(token)) continue;
      if (exists(token)) continue;
      findings.push({
        check: 'doc-paths',
        detail: `${file} mentions "${token}" — no such path in the repository`,
      });
    }

    for (const m of text.matchAll(CLI_NODE_RE)) {
      const token = cleanDocPathToken(m[1]);
      if (!token) continue;
      const key = `${file}::node ${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const candidates = [token, `scripts/${token}`, `scripts/robustness/${token}`];
      if (candidates.some((c) => exists(c))) continue;
      findings.push({
        check: 'doc-paths',
        detail: `${file} mentions "node ${token}" — no such path in the repository`,
      });
    }
  }

  return findings;
}

function gatherDocPathInputs() {
  const readmeText = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
  const claudeMdText = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
  const roadmapText = readFileSync(join(REPO_ROOT, 'ROADMAP.md'), 'utf8');
  const skillText = readFileSync(join(REPO_ROOT, 'SKILL.md'), 'utf8');
  const evaluationText = readFileSync(join(REPO_ROOT, 'EVALUATION.md'), 'utf8');
  const pipelineDocText = readFileSync(join(REPO_ROOT, 'docs', 'bpmn-generator-pipeline.md'), 'utf8');
  const apiReferenceText = readFileSync(join(REFERENCES_DIR, 'api-reference.md'), 'utf8');
  const fachlichesRegelwerkText = readFileSync(join(REFERENCES_DIR, 'fachliches-regelwerk.md'), 'utf8');
  const contributingText = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');
  const compatibilityText = readFileSync(join(REPO_ROOT, 'COMPATIBILITY.md'), 'utf8');
  const securityText = readFileSync(join(REPO_ROOT, 'SECURITY.md'), 'utf8');
  const thirdPartyNoticesText = readFileSync(join(REPO_ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  const robustnessStackText = readFileSync(join(REPO_ROOT, 'docs', 'ROBUSTNESS-STACK.md'), 'utf8');
  const rulesCustomReadmeText = readFileSync(join(REPO_ROOT, 'rules', 'custom', 'README.md'), 'utf8');
  const robustnessReadmeText = readFileSync(join(REPO_ROOT, 'scripts', 'robustness', 'README.md'), 'utf8');

  const docSources = [
    ['README.md', readmeText], ['CLAUDE.md', claudeMdText], ['ROADMAP.md', roadmapText],
    ['SKILL.md', skillText], ['EVALUATION.md', evaluationText],
    ['docs/bpmn-generator-pipeline.md', pipelineDocText],
    ['references/api-reference.md', apiReferenceText],
    ['references/fachliches-regelwerk.md', fachlichesRegelwerkText],
    ['CONTRIBUTING.md', contributingText],
    ['COMPATIBILITY.md', compatibilityText],
    ['SECURITY.md', securityText],
    ['THIRD-PARTY-NOTICES.md', thirdPartyNoticesText],
    ['docs/ROBUSTNESS-STACK.md', robustnessStackText],
    ['rules/custom/README.md', rulesCustomReadmeText],
    ['scripts/robustness/README.md', robustnessReadmeText],
  ];

  const exists = (relPath) => existsSync(join(REPO_ROOT, relPath));

  return { docSources, exists };
}

// ========================================================= 4. package-integrity

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
 * uses in scripts/shared/resource-paths.js (the single place scripts/bpmn/schema-gate.js
 * and scripts/agents/prompt-sections.js both resolve `references/` through) is
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

// ========================================================== 5. changelog-nudge

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
    lines.push('PROOF — all checks passed (response contract, numbers, doc paths, package integrity)');
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
  const { docSources, exists } = gatherDocPathInputs();
  const violations = [
    ...checkResponseContract(responses, schema, ajv),
    ...checkNumbers(await gatherNumberInputs()),
    ...checkDocPaths(docSources, exists),
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
