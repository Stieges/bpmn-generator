/**
 * Phase E — the judging layer over Tasks 1-5's scenario-enumeration outputs.
 *
 * Every other module in `scripts/scenarios/` computes or presents; this is the one place
 * allowed to say something is wrong. Modeled on `scripts/bpmn/workflow-net.js`'s WF01-WF03
 * pattern (compute over an already-built structure, then a thin rule layer names only what
 * is objectively broken): six rules, each reading a fact Tasks 1-5 already produced, never
 * re-deriving it. Rule-id prefix `SC` (Scenario) — `D`/`B` (DMN, `dmn/rules.js`) and
 * `S`/`M`/`P`/`WF`/`O` (BPMN, `bpmn/rules.js`) are taken; confirmed clear at the time of
 * writing (`grep -c "id: '" bpmn/rules.js dmn/rules.js`).
 *
 * ── Severity: WARNING, deliberately ─────────────────────────────────────────────────────────
 * `severity` is always `'WARNING'`. An earlier version declared `'ERROR'` on all six, on the
 * argument that each names a structural defect rather than a style opinion. The whole-branch
 * review rejected that on two grounds, both correct. First, it contradicted the CLI: every
 * pipeline in this repo reserves "print under `⚠`, exit 0 unless `--strict`" for the WARNING
 * tier and blocks by default (exit 1, no flag needed) on ERROR — `scripts/scenarios/pipeline.js`
 * printed these six as warnings while the value said ERROR, so the declaration and the
 * behaviour disagreed and one of them was wrong. Second, and the reason the CLI was the half
 * that was right: every one of these six is a statement about a COMPUTED model — a Petri-net
 * translation with documented limitations (`bpmnToPN` fires an OR split as an AND, does not
 * model `eventBasedGateway` at all, and gives a gateway JOIN AND semantics), enumerated under
 * configurable caps. A finding derived through that much machinery is a strong signal worth a
 * human's attention, not the "definitely broken, must not ship" verdict an ERROR carries
 * elsewhere in this codebase, where ERRORs sit on things like schema violations and broken
 * geometry. `--strict` remains the way to make them block.
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
 * ── SC01 declines to judge THREE things ──────────────────────────────────────────────────────
 * SC01's whole claim is "no enumerated scenario ever takes this branch". That claim is only
 * worth making when the enumerated set is a trustworthy stand-in for the model's real
 * behaviour. Three situations break that, and in each SC01 returns NO findings at all rather
 * than a partial answer — a declined judgment is honest, a misattributed one is worse than
 * silence:
 *
 *   1. **cyclic gateways** — excluded per gateway (see below);
 *   2. **truncated runs** — declined for the whole rule (see below);
 *   3. **runs containing dead-end paths** — declined for the whole rule (see below).
 *
 * ── (1) SC01's scope, deliberately narrow: acyclic decision points only ──────────────────────
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
 * ── (2) Truncated runs: SC01 declines entirely ───────────────────────────────────────────────
 * A second, independently necessary limitation: SC01 declines ENTIRELY (returns no findings
 * for that rule, not a partial answer) when enumeration itself is a PREFIX rather than the
 * complete set — `enumerationResult.truncated === true` (the `maxScenarios` cap fired) or
 * `stats.lengthTruncatedPaths > 0` (`maxTraceLength` cut a path short). The plan states this
 * explicitly: a branch must be judged unreachable only "nach Abzug der Schranken-Sperrungen"
 * (after subtracting cap-suppressed cases). Both count-based caps are orthogonal to cycles
 * entirely: an un-enumerated acyclic branch under either of them may simply not have been
 * reached YET, and reporting it as an objective defect would be exactly the false-positive
 * class the rest of this plan's truncation honesty (`truncated`, `cappedPaths` vs.
 * `deadEndPaths`, `gapAnalysis.attempted`) exists to prevent.
 *
 * The THIRD cap, `stats.cappedPaths` (the cycle bound), has NO guard here, and that is a known
 * residual gap rather than a proof of safety. An earlier version of this comment argued one
 * was unnecessary because "every continuation the cycle bound suppresses is, by construction,
 * adjacent to a backward edge, so the gateway exclusion above already removes it". That is
 * false, and the counter-example is small: `gw --e3--> b`, `b → c`, `c → b`. The suppressed
 * continuation IS adjacent to the backward edge `c → b`, but `gw` is not adjacent to anything
 * cyclic, so the per-gateway exclusion never fires and SC01 reports `e3` as never taken — when
 * `e3` was taken and only its continuation ran out of laps. Deliberately NOT fixed in the same
 * round as limitation (3), because a fourth decline would leave SC01 with almost no reach at
 * all and the trade deserves its own decision; recorded here so nobody re-derives the false
 * argument from the code's silence.
 *
 * ── (3) Dead-end paths: SC01 declines entirely ───────────────────────────────────────────────
 * The third limitation, and the one the whole-branch review found live in production. SC01
 * reads only COMPLETED scenarios' decision lists. It therefore cannot distinguish "this branch
 * was never entered" from "this branch WAS entered, and its continuation later stalled before
 * reaching completion" — in both cases the branch is simply absent from every completed
 * scenario. The second reading makes the finding a MISATTRIBUTION: it names an upstream
 * gateway for a defect that lives downstream, sending a reader to the one place in the model
 * that is fine.
 *
 * Originally reproduced on `tests/fixtures/multi-pool-collaboration.json`: SC01 reported both
 * branches of `s_gw` as never taken, though both were taken — the real stall was at `s_merge`,
 * an `exclusiveGateway` with two incoming edges that `bpmnToPN`'s implicit-merge guard did not
 * catch precisely BECAUSE it was a gateway, so it fell through to the default single-transition
 * path and acquired AND semantics, requiring a token from both incoming edges at once, which an
 * XOR split can never deliver. That `bpmnToPN` limitation is fixed now (`workflow-net.js`'s
 * `isImplicitMerge` also covers an `exclusiveGateway` acting as a join, not only non-gateway
 * nodes), so this exact fixture no longer dead-ends and is no longer a live example — it is kept
 * here as the historical motivation for the guard below, not a current reproduction. The guard
 * itself stays: `deadEndPaths > 0` can still arise from other structural causes (an unresolved
 * black-box gap, a genuinely unreachable branch, a model shape nobody has hit yet), and SC01
 * still cannot tell "never entered" from "entered, stalled downstream" in any of them without
 * re-deriving the traversal it deliberately does not own.
 *
 * So: `stats.deadEndPaths > 0` ⇒ no SC01 findings. This is blunt — it declines for the WHOLE
 * document, including gateways whose branches all completed fine — and that bluntness is the
 * point. A dead end anywhere means the completed-scenario set is not the set of paths the
 * traversal attempted, and SC01 has no way to attribute a specific missing branch to a specific
 * stall without re-deriving the traversal it deliberately does not own. The cost is real:
 * SC01's remaining reach is narrow, because most genuinely-dead branches also produce a dead
 * end (the branch is explored, then goes nowhere). It is still worth having — a declined rule
 * costs a reader nothing, a misattributed one costs them a search in the wrong place — and the
 * `⚠ Enumeration completeness` channel (`format.js`'s `describeEnumerationCompleteness`,
 * surfaced by `pipeline.js` and in the Markdown view) now reports the dead-end count itself, so
 * declining here hides nothing: the reader still learns that something stalled, just not a
 * fabricated claim about where.
 *
 * ── SC01's pool-id keys: read from the enumeration result, never re-derived from `lc` ────────
 * A gateway's `poolId` (used to build the lookup key compared against `formatted`'s
 * `decisions`) is taken from `enumerationResult.poolIds` when present (the collaboration
 * path) — NEVER independently computed as `pool.id` off `lc`. `composeCollaboration`
 * (`collaboration.js`) synthesizes an id for any pool that declares none (`pool.id ||
 * freshPoolId(index)`), and every `CompositeScenario.poolIds` entry — and therefore every
 * `FormattedScenario.decisions[].poolId` derived from it — carries that SYNTHESIZED id, never
 * `undefined`/`null`. Deriving this module's own gateway `poolId` as `pool.id ?? null`
 * independently would silently disagree with what `decisions` actually contains for any
 * pool without a declared `id` (or a fully non-pooled `lc`, handed to the collaboration
 * functions per this module's own documented calling convention below) — producing an empty
 * "taken" match for every one of that pool's gateways and reporting every branch as SC01,
 * regardless of real coverage. Positional alignment holds because `enumerationResult.poolIds`
 * and this module's own pool walk both iterate `lc.pools` (or `[lc]`) in the same order
 * `composeCollaboration` does.
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
 * the whole document treated as a single unnamed pool — the exact fallback
 * `composeCollaboration` (`collaboration.js`) uses. `poolId` is read POSITIONALLY from
 * `actualPoolIds` (typically `enumerationResult.poolIds`) rather than derived from `pool.id`
 * — see the module header's "SC01's pool-id keys" section for why that distinction matters.
 * When `actualPoolIds` is absent (the single-process path has no such field — there is only
 * ever one implicit pool, `poolId: null`, and no synthesis ever happens for it), every entry
 * falls back to `null`, matching `formatScenarioResult`'s own convention.
 *
 * @param {object} lc
 * @param {string[]} [actualPoolIds] - `enumerationResult.poolIds`, positionally aligned with
 *   `lc.pools` (or `[lc]` when `lc` has no `pools`).
 * @returns {Array<{poolId: string|null, pool: object}>}
 */
function poolsOf(lc, actualPoolIds) {
  const rawPools = Array.isArray(lc?.pools) ? lc.pools : [lc];
  const hasActualIds = Array.isArray(actualPoolIds);
  return rawPools.map((pool, i) => ({ poolId: hasActualIds ? (actualPoolIds[i] ?? null) : null, pool }));
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
 * @param {string[]} [actualPoolIds] - `enumerationResult.poolIds`, when the result is a
 *   `CollaborationEnumerationResult` — see `poolsOf` and the module header for why this must
 *   NOT be re-derived from `lc.pools[i].id` independently.
 * @returns {Array<{poolId: string|null, gatewayId: string, edges: Array<{id: string, label: string|null}>}>}
 */
export function findAcyclicDecisionGateways(lc, backwardEdges, actualPoolIds) {
  const excluded = new Set();
  for (const e of backwardEdges || []) {
    const scope = e.poolId ?? null;
    excluded.add(`${scope ?? ''}::${e.source}`);
    excluded.add(`${scope ?? ''}::${e.target}`);
  }

  const gateways = [];
  for (const { poolId, pool } of poolsOf(lc, actualPoolIds)) {
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
 * SC01 — a branch no enumerated scenario ever reaches, restricted to acyclic gateways, and
 * only when the enumerated set can be trusted to stand in for the model's behaviour. See the
 * module header's "SC01 declines to judge THREE things" for the full argument behind each of
 * the two guards below (the third, cyclic gateways, is applied per gateway inside
 * `findAcyclicDecisionGateways`).
 *
 * @param {object} lc
 * @param {object} enumerationResult - `EnumerationResult` or `CollaborationEnumerationResult`.
 * @param {object} formatted - the matching `FormattedView`.
 * @returns {Array<object>} SC01 issues.
 */
function checkUnreachableBranches(lc, enumerationResult, formatted) {
  // Enumeration is a PREFIX, not the complete set, under either count-based cap — see the
  // module header. SC01 declines entirely rather than report an un-enumerated branch as an
  // objective defect.
  if (enumerationResult?.truncated || (enumerationResult?.stats?.lengthTruncatedPaths || 0) > 0) {
    return [];
  }
  // A dead end anywhere means the completed-scenario set is NOT the set of paths the traversal
  // attempted, so "absent from every completed scenario" stops meaning "never taken" — see the
  // module header's limitation (3). Blunt on purpose: attributing a specific missing branch to
  // a specific downstream stall would mean re-deriving the traversal this module does not own.
  if ((enumerationResult?.stats?.deadEndPaths || 0) > 0) {
    return [];
  }

  const actualPoolIds = Array.isArray(enumerationResult?.poolIds) ? enumerationResult.poolIds : undefined;
  const gateways = findAcyclicDecisionGateways(lc, enumerationResult?.stats?.backwardEdges || [], actualPoolIds);
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
        severity: 'WARNING',
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
    severity: 'WARNING',
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
    severity: 'WARNING',
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
function countSkippedTableAnalyses(bridge, tableAnalyses) {
  if (!tableAnalyses) return 0;
  let skipped = 0;
  for (const link of bridge?.resolved || []) {
    if (!tableAnalyses.has(tableAnalysisKey(link))) skipped++;
  }
  return skipped;
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
        severity: 'WARNING',
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
        severity: 'WARNING',
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
      severity: 'WARNING',
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
 * @property {'WARNING'} severity - always WARNING; this module has no ERROR tier. See the
 *   module header's "Severity: WARNING, deliberately" for why, and what `--strict` is for.
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
 * @returns {{issues: ScenarioRuleIssue[], skippedTableAnalyses: number}} `skippedTableAnalyses`
 *   counts resolved bridge links `tableAnalyses` was supplied for but had no entry matching —
 *   see `countSkippedTableAnalyses`. Always 0 when `context.tableAnalyses` is omitted.
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
  return { issues, skippedTableAnalyses: countSkippedTableAnalyses(bridge, tableAnalyses) };
}
