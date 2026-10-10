/**
 * Cross-notation rules — SC02 (a BPMN decisionRef that resolves to no DMN decision) and SC03 (one
 * that resolves to more than one), the rule set that belongs to no single notation: in
 * references/ontology.jsonld both are `crossNotation` rules naming BPMN and DMN, layer
 * `consistency` ("Consistency between notations"). Which notations they connect is stated there
 * only — this module does not repeat it. They run in the scenario pipeline
 * (scripts/scenarios/pipeline.js), read the bridge result from `context`, import nothing from
 * bpmn/, dmn/ or scenarios/, and are not profile-switchable yet. Severity rationale:
 * scripts/bpmn/scenario-rules.js.
 */

import { buildRuleCatalog } from '../shared/rule-catalog.js';

// ═══════════════════════════════════════════════════════════════════════
// SC02 / SC03 — directly from BridgeResult
// ═══════════════════════════════════════════════════════════════════════

function checkUnresolvedDecisionRefs(bridge, severity) {
  return (bridge?.unresolved || []).map((f) => ({
    rule: 'SC02',
    severity,
    nodeId: f.occurrence.nodeId,
    poolId: f.occurrence.poolId ?? null,
    decisionRef: f.occurrence.decisionRef,
    message: `node "${f.occurrence.nodeId}"${f.occurrence.poolId ? ` (pool "${f.occurrence.poolId}")` : ''} `
      + `references decisionRef "${f.occurrence.decisionRef}", which resolves to no decision in any `
      + 'of the given Decision-Core documents',
  }));
}

function checkAmbiguousDecisionRefs(bridge, severity) {
  return (bridge?.ambiguous || []).map((f) => ({
    rule: 'SC03',
    severity,
    nodeId: f.occurrence.nodeId,
    poolId: f.occurrence.poolId ?? null,
    decisionRef: f.occurrence.decisionRef,
    candidateDecisionCoreIds: f.candidates.map((c) => c.decisionCoreId),
    message: `node "${f.occurrence.nodeId}"${f.occurrence.poolId ? ` (pool "${f.occurrence.poolId}")` : ''} `
      + `references decisionRef "${f.occurrence.decisionRef}", which resolves to `
      + `${f.candidates.length} distinct decisions (${f.candidates.map((c) => c.decisionCoreId).join(', ')}) — `
      + 'no single answer is possible',
  }));
}

/** What this module implements, for buildRuleCatalog and the parity tests. */
export const RULE_REGISTER = {
  module: 'scripts/cross/rules.js',
  partition: { ruleSet: 'cross-notation', runsIn: 'scenario' },
  entries: [
    { id: 'SC02', description: 'A decisionRef that resolves to no decision in any given Decision-Core document',
      check: (context, rule) => checkUnresolvedDecisionRefs(context.bridge, rule.defaultSeverity) },
    { id: 'SC03', description: 'A decisionRef that resolves to decisions in more than one Decision-Core document',
      check: (context, rule) => checkAmbiguousDecisionRefs(context.bridge, rule.defaultSeverity) },
  ],
};

export const CROSS_RULES = buildRuleCatalog(RULE_REGISTER);

/** SC02 then SC03 findings for one scenario-pipeline context. */
export function runCrossRules(context = {}) {
  return CROSS_RULES.flatMap((rule) => rule.check(context, rule));
}
