/**
 * DMN scenario rules — SC04 (a decision-table gap) and SC05 (an illegal overlap under UNIQUE), the
 * two rules of the DMN rule set that run in the scenario pipeline (scripts/scenarios/pipeline.js).
 * Layer (semantics) and default severity come from references/ontology.jsonld via buildRuleCatalog;
 * not profile-switchable yet. Bridge results and table analyses arrive as `context`: this module
 * imports nothing from scripts/scenarios/ and nothing from scripts/bpmn/ (dmn/ never does).
 * Why severity is WARNING and what the rules decline to judge: scripts/bpmn/scenario-rules.js.
 *
 * ── SC04/SC05's input: pre-computed analyses, not a live call ────────────────────────────────
 * `runScenarioRules` takes `context.tableAnalyses`, a `Map` from `tableAnalysisKey(link)` to
 * an already-computed `DecisionTableAnalysis` (Task 3's `analyzeDecisionTable`) — this module
 * never calls `analyzeDecisionTable` itself. Two reasons: (1) it keeps this module free of a
 * dependency on `decision-table.js`, mirroring how it already depends on nothing but the
 * shapes Tasks 1-5 hand it; (2) a caller assembling a `FormattedView` for display has very
 * likely already run the analysis for every resolved link (to show gaps/overlaps to a human),
 * and this module recomputing it as a hidden side effect of "judging" would mean the same
 * table gets analyzed twice per request for no benefit. A resolved link with no entry in
 * `tableAnalyses` simply produces no SC04/SC05 findings for that link — this module refuses
 * to guess at an analysis it was not given, the same discipline `decision-table.js` applies
 * to gaps it cannot compute.
 *
 */

import { buildRuleCatalog } from '../shared/rule-catalog.js';

// ═══════════════════════════════════════════════════════════════════════
// SC04 / SC05 — decision table gaps and illegal overlaps
// ═══════════════════════════════════════════════════════════════════════

/**
 * The key `context.tableAnalyses` is expected to be indexed by, for one resolved bridge link.
 * Exported so a caller building the map uses the identical scheme.
 *
 * @param {object} link - a ResolvedLink from scripts/scenarios/bridge.js (passed in, never imported)
 * @returns {string}
 */
export function tableAnalysisKey(link) {
  return `${link.decision.decisionCoreId}::${link.decision.decisionId}`;
}

/**
 * Count resolved bridge links whose table has NO entry in `tableAnalyses` — a link SC04/SC05
 * silently skipped, e.g. because the caller's map was built with a different key scheme than
 * `tableAnalysisKey` produces. Zero when `tableAnalyses` was not supplied at all (that is the
 * documented "skip SC04/SC05 entirely" case, not a mismatch) — this only counts the case
 * where a caller clearly intended those two rules to run but a specific link fell through.
 * Surfaced on the return value of `runScenarioRules` so this failure mode reads as visible
 * ("N links could not be judged") rather than being indistinguishable from "clean".
 *
 * @param {object} bridge - `BridgeResult`, or undefined.
 * @param {Map<string, object>} [tableAnalyses]
 * @returns {number}
 */
export function countSkippedTableAnalyses(bridge, tableAnalyses) {
  if (!tableAnalyses) return 0;
  let skipped = 0;
  for (const link of bridge?.resolved || []) {
    if (!tableAnalyses.has(tableAnalysisKey(link))) skipped++;
  }
  return skipped;
}

function checkTableGaps(bridge, tableAnalyses, severity) {
  if (!tableAnalyses) return [];
  const issues = [];
  for (const link of bridge?.resolved || []) {
    const analysis = tableAnalyses.get(tableAnalysisKey(link));
    if (!analysis) continue;
    // `gaps === null` means gap analysis was not attempted at all (Task 3's own honest
    // "couldn't check" signal — `analysis.gapAnalysis.attempted === false`); that is NOT an
    // SC04 finding. Only a non-null, non-empty `gaps` array is.
    if (!Array.isArray(analysis.gaps) || analysis.gaps.length === 0) continue;
    for (const gap of analysis.gaps) {
      issues.push({
        rule: 'SC04',
        severity,
        nodeId: link.occurrence.nodeId,
        poolId: link.occurrence.poolId ?? null,
        tableId: analysis.tableId,
        gap: gap.describe,
        message: `business rule task "${link.occurrence.nodeId}"${link.occurrence.poolId ? ` (pool "${link.occurrence.poolId}")` : ''} `
          + `invokes table "${analysis.tableId}", which has a coverage gap: ${gap.describe}`,
      });
    }
  }
  return issues;
}

function checkTableOverlaps(bridge, tableAnalyses, severity) {
  if (!tableAnalyses) return [];
  const issues = [];
  for (const link of bridge?.resolved || []) {
    const analysis = tableAnalyses.get(tableAnalysisKey(link));
    if (!analysis) continue;
    // Overlap is only illegal under UNIQUE. FIRST/PRIORITY permit it by design (and Task 3
    // already flags those branches `mayOverestimate`); COLLECT/ANY/RULE ORDER/OUTPUT ORDER
    // are aggregating policies where several rules matching at once is the intended
    // semantics, not a defect — "overlap" is structurally meaningless as "wrong" there.
    if (analysis.hitPolicy !== 'UNIQUE') continue;
    for (const overlap of analysis.overlaps || []) {
      issues.push({
        rule: 'SC05',
        severity,
        nodeId: link.occurrence.nodeId,
        poolId: link.occurrence.poolId ?? null,
        tableId: analysis.tableId,
        ruleIds: overlap.ruleIds,
        message: `business rule task "${link.occurrence.nodeId}"${link.occurrence.poolId ? ` (pool "${link.occurrence.poolId}")` : ''} `
          + `invokes table "${analysis.tableId}" (hitPolicy UNIQUE), where rules `
          + `${overlap.ruleIds.map((id) => `"${id}"`).join(' and ')} overlap — UNIQUE forbids overlap`,
      });
    }
  }
  return issues;
}

/** What this module implements, for buildRuleCatalog and the parity tests. */
export const RULE_REGISTER = {
  module: 'scripts/dmn/scenario-rules.js',
  partition: { ruleSet: 'DMN', runsIn: 'scenario' },
  entries: [
    { id: 'SC04', description: 'A decision table invoked by a business rule task has a coverage gap',
      check: (context, rule) => checkTableGaps(context.bridge, context.tableAnalyses, rule.defaultSeverity) },
    { id: 'SC05', description: 'A UNIQUE decision table invoked by a business rule task has overlapping rules',
      check: (context, rule) => checkTableOverlaps(context.bridge, context.tableAnalyses, rule.defaultSeverity) },
  ],
};

export const DMN_SCENARIO_RULES = buildRuleCatalog(RULE_REGISTER);

/** SC04 then SC05 findings for one scenario-pipeline context. */
export function runDmnScenarioRules(context = {}) {
  return DMN_SCENARIO_RULES.flatMap((rule) => rule.check(context, rule));
}
