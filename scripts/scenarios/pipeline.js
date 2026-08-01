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
 * Call order: enumerate (always via the collaboration pair — see `runScenarioPipeline`'s own
 * doc comment for why a pool-less `lc` is not special-cased) -> bridge -> analyze every
 * resolved table -> format -> judge (`runScenarioRules`).
 *
 * ── What the CLI writes ───────────────────────────────────────────────────────────────────
 * `<basename>.scenarios.json` — every field of `FormattedView.json` (`format.js`), i.e.
 * `happyPath`, `scenarios`, `groupCount`, **`truncated` and `stats`** (the enumeration's own
 * incompleteness bookkeeping: `deadEndPaths`, `cappedPaths`, `lengthTruncatedPaths`,
 * `orGateways`, `skipped`, and the collaboration's message-flow fields), plus `issues` and
 * `skippedTableAnalyses`, which `FormattedView` has no slot for.
 * `<basename>.scenarios.md` — the human view, which now opens with an
 * `## Enumeration summary` section carrying the same completeness information in prose.
 *
 * Both of those carry `stats` because the whole-branch review found the seam where they did
 * not: an input whose every path deadlocks produced an empty scenario list, a three-line
 * Markdown file and `✓ Scenarios enumerated: 0` at exit 0 — six individually-correct modules
 * combining into a CLI that reported success on total failure.
 *
 * Usage:
 *   node pipeline.js input.json [output-basename] [--decisions <files>] [--strict]
 *   cat input.json | node pipeline.js - output-basename
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { enumerateCollaboration } from './collaboration.js';
import { analyzeDecisionTable } from './decision-table.js';
import { resolveBridge } from './bridge.js';
import { formatCollaborationResult, describeEnumerationCompleteness } from './format.js';
import { runScenarioRules, tableAnalysisKey } from './rules.js';

/**
 * The complete, final result of the scenario-enumeration subsystem for one Logic-Core
 * document. This is the public contract the whole plan (Tasks 1-7) has been building toward.
 *
 * @typedef {object} ScenarioPipelineResult
 * @property {import('./collaboration.js').CollaborationEnumerationResult} enumerationResult -
 *   ALWAYS a `CollaborationEnumerationResult`, even for a pool-less `lc` — see "Why always the
 *   collaboration pair" below for why `enumerateScenarios`/`formatScenarioResult` (the plain
 *   single-process pair) are never called from here.
 * @property {import('./bridge.js').BridgeResult} bridgeResult - always computed, even with
 *   `decisionCores` empty (`resolveBridge` documents empty as valid input: every `decisionRef`
 *   occurrence found simply comes back `unresolved`, which is what surfaces as SC02).
 * @property {Map<string, import('./decision-table.js').DecisionTableAnalysis>} tableAnalyses -
 *   keyed by `tableAnalysisKey(link)` (imported, never reinvented), one entry per
 *   `bridgeResult.resolved` link. Not JSON-serializable as-is (it is a `Map`) — a caller
 *   writing this to disk must convert it; the CLI below does not include it in the written
 *   `.scenarios.json` for that reason.
 * @property {import('./format.js').FormattedView} formatted - the JSON + Markdown views, built
 *   with `formatCollaborationResult` to match `enumerationResult`. `formatted.json` carries
 *   `enumerationResult`'s `stats`/`truncated` verbatim, so a caller writing only this to disk
 *   still ships the incompleteness signals.
 * @property {import('./rules.js').ScenarioRuleIssue[]} issues - every SC01-SC06 finding, all
 *   WARNING-tier (see `rules.js`'s header) — present findings do not by themselves make this
 *   run a failure; the CLI's `--strict` is what turns them into one.
 * @property {number} skippedTableAnalyses - see `runScenarioRules`'s return value; always 0
 *   here in practice, since `tableAnalyses` is always built from exactly `bridgeResult.resolved`
 *   using the same key function `runScenarioRules` reads with — surfaced anyway because it is
 *   part of `runScenarioRules`'s contract and dropping it would silently hide a future drift
 *   between the two.
 */

/**
 * Run the complete scenario-enumeration subsystem over one Logic-Core document.
 *
 * ── Why always the collaboration pair ─────────────────────────────────────────────────────
 * An earlier version of this function auto-detected single-process vs. collaboration from
 * `lc.pools` (mirroring `checkWorkflowNetSoundness`'s `lc.pools ? lc.pools : [lc]`,
 * `scripts/bpmn/workflow-net.js`) and, for a pool-less `lc`, called `enumerateScenarios`/
 * `formatScenarioResult` (the plain single-process pair) directly. That silently dropped SC06
 * coverage for every pool-less input: SC06 reads `sinkTokens`, a field `enumerateCollaboration`
 * computes (via `CompositeScenario`) but `enumerateScenarios`'s plain `Scenario` never carries
 * at all — `rules.js`'s own module header names this exact gap and its own recommended fix:
 * "A caller who wants SC06 coverage for a single, non-pooled process should still call the
 * collaboration functions on it: `enumerateCollaboration` accepts an `lc` without `pools`."
 * `composeCollaboration` (`collaboration.js`) documents accepting a pool-less `lc` as exactly
 * this case — treating the whole document as one synthesized pool — so there is no capability
 * gap to route around: every `lc`, with or without `pools`, now goes through
 * `enumerateCollaboration`/`formatCollaborationResult` uniformly, and the single-process pair
 * (`enumerate.js`/`format.js`'s `enumerateScenarios`/`formatScenarioResult`) is simply never
 * called from this orchestrator. That also removes a branch this module had to maintain for
 * no coverage benefit — the composed net is a strict superset of the plain net when there are
 * no message flows, which is always true for a pool-less document.
 *
 * The bridge is always resolved (never conditionally skipped on empty `decisionCores`) so that
 * a `decisionRef` with no `decisionCores` supplied still surfaces as an SC02 finding rather
 * than silently passing judgment-free — `resolveBridge([], lc)` document its own empty-array
 * input as exactly this case, and `rules.js`'s SC02 reads `bridge.unresolved`, which needs a
 * real (if empty-handed) `BridgeResult` to be non-empty.
 *
 * @param {object} lc - Logic-Core document, collaboration (`lc.pools`) or flat single-process
 *   (no `pools` key — treated as one synthesized pool, per `composeCollaboration`'s own
 *   documented acceptance of that shape).
 * @param {object[]} [decisionCores] - Decision-Core documents to resolve `decisionRef`
 *   occurrences against. Default `[]` — every occurrence then comes back unresolved.
 * @param {object} [options] - passed through unchanged to `enumerateCollaboration`
 *   (cycle/scenario/trace-length bounds), `formatCollaborationResult` (`maxGroupsRendered`)
 *   and `analyzeDecisionTable` (`maxPartitionCells`) — each reads only the option keys it
 *   defines, so one shared object is safe to hand to all of them, mirroring how they all fall
 *   back to the same `config.json -> scenarios` block.
 * @returns {ScenarioPipelineResult}
 */
export function runScenarioPipeline(lc, decisionCores = [], options = {}) {
  const enumerationResult = enumerateCollaboration(lc, options);
  const formatted = formatCollaborationResult(enumerationResult, lc, options);

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

/** Read and JSON.parse one input source, with a clean `✗ <message>` error and exit 1 on any
 * read/parse failure — never a raw Node stack trace.
 *
 * @param {string} arg - a file path, or `-` for stdin when `allowStdin` is true.
 * @param {object} [opts]
 * @param {boolean} [opts.allowStdin=true] - the `-`-for-stdin convention is only meaningful
 *   for the main input (there is exactly one stdin, and it can be read only once); `--decisions`
 *   entries always pass `allowStdin: false` so a literal `-` there is read as a file named `-`
 *   (and fails cleanly with ENOENT) rather than silently trying to read stdin a second time.
 */
async function readJsonInput(arg, { allowStdin = true } = {}) {
  let raw;
  if (allowStdin && arg === '-') {
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
      // args[i + 1] is required — a bare trailing `--decisions` (no value follows) is a
      // malformed flag, not "no --decisions given"; silently swallowing it used to mean
      // every decisionRef came back unresolved with no hint the flag itself was broken.
      if (i + 1 >= args.length) {
        console.error('✗ --decisions requires a value (comma-separated Decision-Core file paths)');
        process.exit(1);
      }
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
        decisionCores.push(await readJsonInput(p, { allowStdin: false }));
      } catch (e) {
        console.error(`✗ ${e.message}`);
        process.exit(1);
      }
    }
  }

  const result = runScenarioPipeline(lc, decisionCores);

  // Three channels, in the order a reader needs them, mirroring scripts/dmn/pipeline.js's
  // two-tier shape and scripts/bpmn/pipeline.js's non-blocking `💡` advisory channel:
  //
  //   ⚠ Findings              — SC01-SC06 (WARNING tier, see rules.js's header). --strict blocks.
  //   ⚠ Enumeration completeness — the run did not finish the job. --strict blocks.
  //   💡 Enumeration notes    — what the translation structurally cannot see. Never blocks.
  //
  // The completeness channel is the fix for the seam the whole-branch review found: without it
  // a document whose every path deadlocks printed "✓ Scenarios enumerated: 0" at exit 0, which
  // reads as "this process has no branches" rather than "enumeration failed completely".
  if (result.issues.length) {
    console.warn('\n⚠ Findings:');
    result.issues.forEach((i) => console.warn(`  · [${i.rule}] ${i.message}`));
  }
  const completeness = describeEnumerationCompleteness(result.enumerationResult);
  if (completeness.warnings.length) {
    console.warn('\n⚠ Enumeration completeness:');
    completeness.warnings.forEach((w) => console.warn(`  · ${w}`));
  }
  if (completeness.notes.length) {
    console.log('\n💡 Enumeration notes (no verdict — what the Petri-net translation cannot see):');
    completeness.notes.forEach((n) => console.log(`  · ${n}`));
  }
  // --strict: abort BEFORE writing files on any unresolved warning — mirroring the --strict
  // convention in scripts/bpmn/pipeline.js and scripts/dmn/pipeline.js, which treat every
  // warning channel as a --strict channel. The completeness warnings are included on purpose:
  // "the enumeration produced nothing" is precisely the class of failure --strict exists to
  // stop from reaching delivery, and leaving it out would mean a totally failed run still
  // passes --strict as long as no SC0x rule happens to fire.
  const blocking = result.issues.length + completeness.warnings.length;
  if (strict && blocking) {
    console.error(`\n✗ --strict: ${result.issues.length} finding(s), `
      + `${completeness.warnings.length} completeness warning(s). No files written.`);
    process.exit(1);
  }
  console.log(`✓ Scenarios enumerated: ${result.formatted.json.scenarios.length}`);

  const jsonPath = `${outputBase}.scenarios.json`;
  const mdPath = `${outputBase}.scenarios.md`;
  // The Map `tableAnalyses` is not part of the written JSON (see ScenarioPipelineResult's
  // JSDoc) — `formatted.json` already carries everything Task 5 designed for machine
  // consumption, INCLUDING the enumeration's own `stats`/`truncated` bookkeeping (see
  // `FormattedView`); `issues`/`skippedTableAnalyses` are added because they are the one thing
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
