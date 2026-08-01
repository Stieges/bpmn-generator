/**
 * Phase E — the judging layer over Tasks 1-5's scenario-enumeration outputs.
 *
 * Every other module in `scripts/scenarios/` computes or presents; this is the one place
 * allowed to say something is wrong. Modeled on `scripts/bpmn/workflow-net.js`'s WF01-WF03
 * pattern (compute over an already-built structure, then a thin rule layer names only what
 * is objectively broken): six rules, each reading a fact Tasks 1-5 already produced, never
 * re-deriving it. `severity` is always `'ERROR'` — there is no WARNING tier here, unlike the
 * BPMN/DMN rule engines, because every one of these six findings is a structural defect, not
 * a style opinion. Rule-id prefix `SC` (Scenario) — `D`/`B` (DMN, `dmn/rules.js`) and
 * `S`/`M`/`P`/`WF`/`O` (BPMN, `bpmn/rules.js`) are taken; confirmed clear at the time of
 * writing (`grep -c "id: '" bpmn/rules.js dmn/rules.js`).
 *
 * **No fachliche/business-sense judgment. Ever.** If a check would ask "is this a reasonable
 * process", it does not belong here — that question is explicitly out of scope for the whole
 * scenario-enumeration plan (`docs/superpowers/plans/2026-08-01-scenario-enumeration.md`,
 * "Bewusst nicht in diesem Vorhaben"). And no rule beyond these six without checking with the
 * plan owner first: this module's entire value is narrowness, and adding a seventh rule here
 * without that discipline is exactly how "objectively wrong only" erodes into "wrong in this
 * module's opinion".
 *
 * ── The six rules ──────────────────────────────────────────────────────────────────────────
 *
 *   SC01 — a branch no scenario ever reaches (acyclic gateways only, see below)
 *   SC02 — a decisionRef that resolves to nothing            (BridgeResult.unresolved)
 *   SC03 — a decisionRef that resolves to more than one table (BridgeResult.ambiguous)
 *   SC04 — a decision table has a gap                         (DecisionTableAnalysis.gaps)
 *   SC05 — a decision table has an illegal overlap (UNIQUE only) (DecisionTableAnalysis.overlaps)
 *   SC06 — improper completion at a scenario's shared sink     (CompositeScenario.sinkTokens)
 *
 * ── SC01's scope, deliberately narrow: acyclic decision points only ──────────────────────────
 * A branch's reachability at a gateway that is part of a graph cycle is inherently
 * bound-dependent (`enumerate.js`'s `cycleBound`): whether a loop-continuation edge "was
 * never reached" or "just needed one more lap" is not something this module can honestly
 * tell apart without guessing at an appropriate bound. So: this rule EXCLUDES any gateway
 * that is the source or target of a backward edge (`EnumerationResult.stats.backwardEdges` /
 * `CollaborationEnumerationResult.stats.backwardEdges`) from consideration entirely. This is
 * a real, stated limitation, not an oversight — a gateway on a cycle can still have a
 * genuinely dead branch, and SC01 will not see it.
 *
 * For every remaining (acyclic) `exclusiveGateway` split with more than one outgoing edge,
 * this module compares the FULL set of its outgoing edges (derived structurally, by
 * flattening the process the same way `bpmnToPN`/`format.js` already do — filtering nodes by
 * type and counting outgoing edges is not the branch-identification logic below, just a
 * structural enumeration) against the set of edges TAKEN across every scenario. The "taken"
 * side is read from `FormattedView.json.scenarios[].decisions` (Task 5's
 * `extractScenarioDecisions`/`resolveGatewayChoice`) — not re-derived here. Task 5's own two
 * review rounds already fixed the fabricated-pass-through-node bug and the inclusive-gateway
 * exclusion bug in that logic; re-deriving it a second time here risks silently
 * reintroducing either.
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
 * ── Single process vs. collaboration ──────────────────────────────────────────────────────────
 * `context.lc` is a Logic-Core document, with or without `pools` — mirroring
 * `collaboration.js`'s own acceptance of both shapes. `context.enumerationResult` /
 * `context.formatted` are whatever the caller produced for the SAME `lc`: either the
 * single-process pair (`enumerateScenarios`/`formatScenarioResult`, called once per pool) or
 * the collaboration pair (`enumerateCollaboration`/`formatCollaborationResult`). SC06 reads
 * `sinkTokens`, which only exists on a `CompositeScenario` (the collaboration path) — on a
 * plain `Scenario` (single-process path) SC06 finds nothing, silently, because there is
 * nothing there for it to read. A caller who wants SC06 coverage for a single, non-pooled
 * process should still call the collaboration functions on it: `enumerateCollaboration`
 * accepts an `lc` without `pools` and treats it as one pool, exactly as `composeCollaboration`
 * documents.
 */

import { bpmnToPN } from '../bpmn/workflow-net.js';

// ═══════════════════════════════════════════════════════════════════════
// Structural gateway enumeration (SC01) — NOT branch/decision identification
// ═══════════════════════════════════════════════════════════════════════

/**
 * The pools this rule set should walk, normalized: a real collaboration's `pools` array, or
 * the whole document treated as a single unnamed pool — the exact fallback `collaboration.js`
 * (`composeCollaboration`) and `format.js` (`formatScenarioResult`'s implicit `poolId: null`)
 * already use. `poolId` is `null` for the single-process case so it matches the `poolId` a
 * `FormattedScenario`'s `decisions` entries carry in that same case.
 *
 * @param {object} lc
 * @returns {Array<{poolId: string|null, pool: object}>}
 */
function poolsOf(lc) {
  if (Array.isArray(lc?.pools)) return lc.pools.map((pool) => ({ poolId: pool.id ?? null, pool }));
  return [{ poolId: null, pool: lc }];
}

/**
 * Every acyclic `exclusiveGateway` split (more than one outgoing edge, not itself the source
 * or target of a backward edge) in `lc`, with the full set of its outgoing edges.
 *
 * Purely structural: node type + outgoing-edge count, nothing about which edge a scenario
 * took. That derivation stays in `format.js` and is read from `formatted`, not repeated here.
 *
 * @param {object} lc
 * @param {Array<{id: string, source: string, target: string, poolId?: string}>} backwardEdges -
 *   `EnumerationResult.stats.backwardEdges` or `CollaborationEnumerationResult.stats.backwardEdges`.
 * @returns {Array<{poolId: string|null, gatewayId: string, edges: Array<{id: string, label: string|null}>}>}
 */
export function findAcyclicDecisionGateways(lc, backwardEdges) {
  const excluded = new Set();
  for (const e of backwardEdges || []) {
    const scope = e.poolId ?? null;
    excluded.add(`${scope ?? ''}::${e.source}`);
    excluded.add(`${scope ?? ''}::${e.target}`);
  }

  const gateways = [];
  for (const { poolId, pool } of poolsOf(lc)) {
    const { flatNodes, flatEdges } = bpmnToPN(pool);
    const outBySource = new Map();
    for (const e of flatEdges) {
      if (!outBySource.has(e.source)) outBySource.set(e.source, []);
      outBySource.get(e.source).push(e);
    }
    for (const node of flatNodes) {
      if (node.type !== 'exclusiveGateway') continue;
      const outEdges = outBySource.get(node.id) || [];
      if (outEdges.length <= 1) continue;
      if (excluded.has(`${poolId ?? ''}::${node.id}`)) continue;
      gateways.push({
        poolId,
        gatewayId: node.id,
        edges: outEdges.map((e) => ({ id: e.id, label: e.label || null })),
      });
    }
  }
  return gateways;
}

/**
 * SC01 — a branch no enumerated scenario ever reaches, restricted to acyclic gateways.
 *
 * @param {object} lc
 * @param {object} enumerationResult - `EnumerationResult` or `CollaborationEnumerationResult`.
 * @param {object} formatted - the matching `FormattedView`.
 * @returns {Array<object>} SC01 issues.
 */
function checkUnreachableBranches(lc, enumerationResult, formatted) {
  const gateways = findAcyclicDecisionGateways(lc, enumerationResult?.stats?.backwardEdges || []);
  if (gateways.length === 0) return [];

  const takenEdges = new Set(); // `${poolId}::${gatewayId}::${edgeId}`
  for (const s of formatted?.json?.scenarios || []) {
    for (const d of s.decisions || []) {
      if (d.kind !== 'bpmn-gateway' || !d.edgeId) continue;
      takenEdges.add(`${d.poolId ?? ''}::${d.gatewayId}::${d.edgeId}`);
    }
  }

  const issues = [];
  for (const gw of gateways) {
    for (const edge of gw.edges) {
      const key = `${gw.poolId ?? ''}::${gw.gatewayId}::${edge.id}`;
      if (takenEdges.has(key)) continue;
      issues.push({
        rule: 'SC01',
        severity: 'ERROR',
        gatewayId: gw.gatewayId,
        poolId: gw.poolId,
        edgeId: edge.id,
        message: `gateway "${gw.gatewayId}"${gw.poolId ? ` (pool "${gw.poolId}")` : ''}, branch `
          + `"${edge.id}"${edge.label ? ` (${JSON.stringify(edge.label)})` : ''}, is never taken by `
          + 'any enumerated scenario',
      });
    }
  }
  return issues;
}

// ═══════════════════════════════════════════════════════════════════════
// SC02 / SC03 — directly from BridgeResult
// ═══════════════════════════════════════════════════════════════════════

function checkUnresolvedDecisionRefs(bridge) {
  return (bridge?.unresolved || []).map((f) => ({
    rule: 'SC02',
    severity: 'ERROR',
    nodeId: f.occurrence.nodeId,
    poolId: f.occurrence.poolId ?? null,
    decisionRef: f.occurrence.decisionRef,
    message: `node "${f.occurrence.nodeId}"${f.occurrence.poolId ? ` (pool "${f.occurrence.poolId}")` : ''} `
      + `references decisionRef "${f.occurrence.decisionRef}", which resolves to no decision in any `
      + 'of the given Decision-Core documents',
  }));
}

function checkAmbiguousDecisionRefs(bridge) {
  return (bridge?.ambiguous || []).map((f) => ({
    rule: 'SC03',
    severity: 'ERROR',
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

// ═══════════════════════════════════════════════════════════════════════
// SC04 / SC05 — decision table gaps and illegal overlaps
// ═══════════════════════════════════════════════════════════════════════

/**
 * The key `context.tableAnalyses` is expected to be indexed by, for one resolved bridge link.
 * Exported so a caller building the map uses the identical scheme.
 *
 * @param {import('./bridge.js').ResolvedLink} link
 * @returns {string}
 */
export function tableAnalysisKey(link) {
  return `${link.decision.decisionCoreId}::${link.decision.decisionId}`;
}

function checkTableGaps(bridge, tableAnalyses) {
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
        severity: 'ERROR',
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

function checkTableOverlaps(bridge, tableAnalyses) {
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
        severity: 'ERROR',
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

// ═══════════════════════════════════════════════════════════════════════
// SC06 — improper completion at a scenario's shared sink
// ═══════════════════════════════════════════════════════════════════════

/**
 * SC06 closes a gap Task 1's own review explicitly left open for this task: "'improper
 * completion' (sink marked while a token is stranded elsewhere ... e.g. one AND branch
 * reaches its end event while another strands at an unsatisfiable join) is currently
 * classified as an ordinary complete scenario ... The judging layer should decide
 * whether/how to surface this." `sinkTokens[poolId] > 1` on any scenario IS that shape: an
 * AND fork that should have produced tokens at multiple end events instead left more than one
 * token on the shared sink (`bpmnToPN` wires every end event of a pool to the same sink,
 * `workflow-net.js`). `workflow-net.js`'s WF03 already names this at the whole-model
 * soundness level; SC06 names it again here PER SCENARIO, because a specific enumerated
 * scenario exhibiting it is a more concrete, actionable finding than a whole-model verdict.
 *
 * Only present on `CompositeScenario` (the collaboration path, `collaboration.js`) — a plain
 * `Scenario` (single-process path, `enumerate.js`) carries no `sinkTokens` field at all, so
 * this simply finds nothing for it.
 */
function checkImproperCompletion(enumerationResult) {
  const issues = [];
  for (const s of enumerationResult?.scenarios || []) {
    if (!s.sinkTokens) continue;
    const overfull = Object.entries(s.sinkTokens).filter(([, tokens]) => tokens > 1);
    if (overfull.length === 0) continue;
    issues.push({
      rule: 'SC06',
      severity: 'ERROR',
      scenarioIndex: s.index,
      pools: overfull.map(([poolId]) => poolId),
      message: `scenario #${s.index} completes improperly: pool(s) `
        + `${overfull.map(([poolId, tokens]) => `"${poolId}" (${tokens} tokens)`).join(', ')} `
        + 'left more than one token on the shared sink — an AND fork whose branches did not '
        + 'all reach their own end event before the scenario was recorded complete',
    });
  }
  return issues;
}

// ═══════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════

/**
 * One judged finding.
 *
 * @typedef {object} ScenarioRuleIssue
 * @property {'SC01'|'SC02'|'SC03'|'SC04'|'SC05'|'SC06'} rule
 * @property {'ERROR'} severity - always ERROR; this module has no WARNING tier.
 * @property {string} message - human-readable, self-contained.
 * (Structured fields beyond `rule`/`severity`/`message` vary per rule — see each `check*`
 * function above for the exact shape; every one carries enough of node/table/edge/scenario id
 * to act on without re-parsing `message`.)
 */

/**
 * Run all six Phase-E rules over the outputs of Tasks 1-5.
 *
 * @param {object} context
 * @param {object} context.lc - the Logic-Core document `context.enumerationResult` /
 *   `context.formatted` were produced from (with or without `pools`).
 * @param {object} context.enumerationResult - `EnumerationResult` (enumerate.js) or
 *   `CollaborationEnumerationResult` (collaboration.js), matching `lc`.
 * @param {object} context.formatted - the `FormattedView` (format.js) built from the SAME
 *   `enumerationResult` and `lc`.
 * @param {object} [context.bridge] - `BridgeResult` (bridge.js). Omit to skip SC02-SC05
 *   entirely (e.g. a process with no `decisionRef` at all).
 * @param {Map<string, object>} [context.tableAnalyses] - `tableAnalysisKey(link) →
 *   DecisionTableAnalysis` (decision-table.js), one entry per resolved bridge link the caller
 *   wants judged. This module never calls `analyzeDecisionTable` itself — see the module
 *   header for why. Omit (or a link missing from the map) to skip SC04/SC05 for that link.
 * @returns {{issues: ScenarioRuleIssue[]}}
 */
export function runScenarioRules(context) {
  const { lc, enumerationResult, formatted, bridge, tableAnalyses } = context || {};
  const issues = [
    ...checkUnreachableBranches(lc, enumerationResult, formatted),
    ...checkUnresolvedDecisionRefs(bridge),
    ...checkAmbiguousDecisionRefs(bridge),
    ...checkTableGaps(bridge, tableAnalyses),
    ...checkTableOverlaps(bridge, tableAnalyses),
    ...checkImproperCompletion(enumerationResult),
  ];
  return { issues };
}
