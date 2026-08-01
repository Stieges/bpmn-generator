/**
 * Scenario-Enumeration Pipeline — Orchestrator + CLI + Public API (runScenarioPipeline).
 *
 * Phase F of `docs/superpowers/plans/2026-08-01-scenario-enumeration.md`. Mirrors
 * `scripts/dmn/pipeline.js`'s shape and idiom (which itself mirrors `scripts/bpmn/pipeline.js`):
 * a pure orchestrator function plus a thin CLI wrapper around it. This module does ONLY
 * integration — it calls Tasks 1-6's six modules in the right order and assembles their
 * outputs. No new computation, no new judgment: any check that looks like a decision belongs
 * in `rules.js` (the only module in this subsystem allowed to call something wrong), not here.
 *
 * Call order: enumerate (single-process or collaboration, auto-detected) -> bridge -> analyze
 * every resolved table -> format -> judge (`runScenarioRules`).
 *
 * Usage:
 *   node pipeline.js input.json [output-basename] [--decisions <files>] [--strict]
 *   cat input.json | node pipeline.js - output-basename
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { enumerateScenarios } from './enumerate.js';
import { enumerateCollaboration } from './collaboration.js';
import { analyzeDecisionTable } from './decision-table.js';
import { resolveBridge } from './bridge.js';
import { formatScenarioResult, formatCollaborationResult } from './format.js';
import { runScenarioRules, tableAnalysisKey } from './rules.js';

/**
 * The complete, final result of the scenario-enumeration subsystem for one Logic-Core
 * document. This is the public contract the whole plan (Tasks 1-7) has been building toward.
 *
 * @typedef {object} ScenarioPipelineResult
 * @property {import('./enumerate.js').EnumerationResult|import('./collaboration.js').CollaborationEnumerationResult} enumerationResult -
 *   `EnumerationResult` (single process, `lc` has no `pools`) or `CollaborationEnumerationResult`
 *   (`lc.pools` present, even if it holds only one pool) — see the auto-detection rule below.
 * @property {import('./bridge.js').BridgeResult} bridgeResult - always computed, even with
 *   `decisionCores` empty (`resolveBridge` documents empty as valid input: every `decisionRef`
 *   occurrence found simply comes back `unresolved`, which is what surfaces as SC02).
 * @property {Map<string, import('./decision-table.js').DecisionTableAnalysis>} tableAnalyses -
 *   keyed by `tableAnalysisKey(link)` (imported, never reinvented), one entry per
 *   `bridgeResult.resolved` link. Not JSON-serializable as-is (it is a `Map`) — a caller
 *   writing this to disk must convert it; the CLI below does not include it in the written
 *   `.scenarios.json` for that reason.
 * @property {import('./format.js').FormattedView} formatted - the JSON + Markdown views, built
 *   with `formatScenarioResult` or `formatCollaborationResult` to match `enumerationResult`.
 * @property {import('./rules.js').ScenarioRuleIssue[]} issues - every SC01-SC06 finding.
 * @property {number} skippedTableAnalyses - see `runScenarioRules`'s return value; always 0
 *   here in practice, since `tableAnalyses` is always built from exactly `bridgeResult.resolved`
 *   using the same key function `runScenarioRules` reads with — surfaced anyway because it is
 *   part of `runScenarioRules`'s contract and dropping it would silently hide a future drift
 *   between the two.
 */

/**
 * Run the complete scenario-enumeration subsystem over one Logic-Core document.
 *
 * Auto-detects single-process vs. collaboration the same way `checkWorkflowNetSoundness`
 * does (`scripts/bpmn/workflow-net.js`: `lc.pools ? lc.pools : [lc]`), but at the granularity
 * of choosing which pair of Tasks 1/4 functions to call, not per pool: `lc.pools` present ->
 * `enumerateCollaboration`/`formatCollaborationResult` on the whole document (this also covers
 * a collaboration with exactly one declared pool — it still goes through the composed net,
 * which is a strict superset of the single-process net when there are no message flows);
 * `lc.pools` absent -> `lc` itself is the one process, `enumerateScenarios`/
 * `formatScenarioResult` are called on it directly.
 *
 * The bridge is always resolved (never conditionally skipped on empty `decisionCores`) so that
 * a `decisionRef` with no `decisionCores` supplied still surfaces as an SC02 finding rather
 * than silently passing judgment-free — `resolveBridge([], lc)` document its own empty-array
 * input as exactly this case, and `rules.js`'s SC02 reads `bridge.unresolved`, which needs a
 * real (if empty-handed) `BridgeResult` to be non-empty.
 *
 * @param {object} lc - Logic-Core document, collaboration or flat single-process.
 * @param {object[]} [decisionCores] - Decision-Core documents to resolve `decisionRef`
 *   occurrences against. Default `[]` — every occurrence then comes back unresolved.
 * @param {object} [options] - passed through unchanged to `enumerateScenarios`/
 *   `enumerateCollaboration` (cycle/scenario/trace-length bounds), `formatScenarioResult`/
 *   `formatCollaborationResult` (`maxGroupsRendered`) and `analyzeDecisionTable`
 *   (`maxPartitionCells`) — each reads only the option keys it defines, so one shared object
 *   is safe to hand to all of them, mirroring how they all fall back to the same `config.json
 *   -> scenarios` block.
 * @returns {ScenarioPipelineResult}
 */
export function runScenarioPipeline(lc, decisionCores = [], options = {}) {
  const isCollaboration = Array.isArray(lc?.pools);

  const enumerationResult = isCollaboration
    ? enumerateCollaboration(lc, options)
    : enumerateScenarios(lc, options);

  const formatted = isCollaboration
    ? formatCollaborationResult(enumerationResult, lc, options)
    : formatScenarioResult(enumerationResult, lc, options);

  const bridgeResult = resolveBridge(lc, decisionCores);

  const tableAnalyses = new Map();
  for (const link of bridgeResult.resolved) {
    tableAnalyses.set(tableAnalysisKey(link), analyzeDecisionTable(link.decision.decisionTable, options));
  }

  const { issues, skippedTableAnalyses } = runScenarioRules({
    lc, enumerationResult, formatted, bridge: bridgeResult, tableAnalyses,
  });

  return { enumerationResult, bridgeResult, tableAnalyses, formatted, issues, skippedTableAnalyses };
}

// ═══════════════════════════════════════════════════════════════════════
// CLI ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════

/** Read and JSON.parse one input source ('-' for stdin, else a file path), with a clean
 * `✗ <message>` error and exit 1 on any read/parse failure — never a raw Node stack trace. */
async function readJsonInput(arg) {
  let raw;
  if (arg === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    raw = Buffer.concat(chunks).toString();
  } else {
    raw = readFileSync(resolve(arg), 'utf8');
  }
  return JSON.parse(raw);
}

async function main() {
  const args = process.argv.slice(2);
  const positional = [];
  let decisionsArg = null;
  let strict = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--decisions') {
      decisionsArg = args[++i];
    } else if (a.startsWith('--decisions=')) {
      decisionsArg = a.slice('--decisions='.length);
    } else if (a === '--strict') {
      strict = true;
    } else if (!a.startsWith('--')) {
      positional.push(a);
    }
  }
  const inputArg = positional[0];
  const outputBase = positional[1] || 'output';

  if (!inputArg) {
    console.error('Usage: node pipeline.js <input.json | -> [output-basename] [--decisions <files>] [--strict]');
    process.exit(1);
  }

  let lc;
  try {
    lc = await readJsonInput(inputArg);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }

  const decisionCores = [];
  if (decisionsArg) {
    const paths = decisionsArg.split(',').map((p) => p.trim()).filter(Boolean);
    for (const p of paths) {
      try {
        decisionCores.push(await readJsonInput(p));
      } catch (e) {
        console.error(`✗ ${e.message}`);
        process.exit(1);
      }
    }
  }

  const result = runScenarioPipeline(lc, decisionCores);

  if (result.issues.length) {
    console.warn('\n⚠ Findings:');
    result.issues.forEach((i) => console.warn(`  · [${i.rule}] ${i.message}`));
  }
  // --strict: abort BEFORE writing files if any SC01-SC06 finding is present — mirroring the
  // --strict convention in scripts/bpmn/pipeline.js and scripts/dmn/pipeline.js exactly.
  if (strict && result.issues.length) {
    console.error(`\n✗ --strict: ${result.issues.length} finding(s). No files written.`);
    process.exit(1);
  }
  console.log(`✓ Scenarios enumerated: ${result.formatted.json.scenarios.length}`);

  const jsonPath = `${outputBase}.scenarios.json`;
  const mdPath = `${outputBase}.scenarios.md`;
  // The Map `tableAnalyses` is not part of the written JSON (see ScenarioPipelineResult's
  // JSDoc) — `formatted.json` already carries everything Task 5 designed for machine
  // consumption; `issues`/`skippedTableAnalyses` are added because they are the one thing
  // `formatted.json` never had a slot for and a caller reading only the file would otherwise
  // never see them.
  const jsonOutput = {
    ...result.formatted.json,
    issues: result.issues,
    skippedTableAnalyses: result.skippedTableAnalyses,
  };
  writeFileSync(jsonPath, JSON.stringify(jsonOutput, null, 2), 'utf8');
  writeFileSync(mdPath, result.formatted.markdown, 'utf8');
  console.log(`✓ JSON  → ${jsonPath}`);
  console.log(`✓ Markdown → ${mdPath}`);
}

// Only run CLI when executed directly (not imported) — same idiom as scripts/bpmn/pipeline.js
// and scripts/dmn/pipeline.js.
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch((err) => { console.error('Pipeline error:', err); process.exit(1); });
}
