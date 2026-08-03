/**
 * Phase D — presentation layer over Tasks 1-2's enumerated scenarios.
 *
 * Two views of the same data:
 *
 *   - **Machine (JSON)**: every scenario, tagged with its decision sequence, group key and
 *     happy-path distance. Nothing dropped, nothing summarized — Task 6 (or an LLM
 *     reviewer) consumes this for exhaustive checking.
 *   - **Human (Markdown)**: the same scenarios grouped by decision sequence, sorted around
 *     the happy path, parallel interleavings collapsed to a count. Capped so a reviewer is
 *     never handed an unreadable wall of text, and the cap is always visible when it bites.
 *
 * ── Grouping key: BPMN gateways only, not DMN ─────────────────────────────────────────────
 * No task built so far attaches "which DMN rule this scenario's business-rule-task visit
 * took" to a `Scenario`/`CompositeScenario` — Task 3's decision-table analysis is per-table,
 * context-free of any specific scenario, and Task 4's bridge only resolves
 * `decisionRef → table`, it never touches scenarios. Building DMN-aware grouping now would
 * mean inventing integration machinery for data that does not exist yet. The key is shaped
 * as an ordered list of `{kind: 'bpmn-gateway', ...}` entries specifically so that if a later
 * task ever attaches DMN branch info to a scenario, a `{kind: 'dmn-rule', ...}` entry can be
 * appended to the same list without a redesign.
 *
 * ── Recovering a decision label from a transition id ──────────────────────────────────────
 * Verified directly against `scripts/bpmn/workflow-net.js`'s XOR-split construction (around
 * lines 105-122): for gateway node `gw`, `bpmnToPN` builds `outEdges = flatEdges.filter(e =>
 * e.source === gw.id)` and creates transition `t_${gw.id}_choice_${i}` for `outEdges[i]`. So
 * a transition id matching that pattern names the taken edge exactly: filter the process's
 * own (flattened) edges by `source === gatewayId`, in the SAME order, index with `i`. Any
 * other transition shape (`t_<node>_merge_<i>`, a plain `t_<node>`) is not a decision point
 * and never contributes an entry — an implicit merge or a pass-through node is not a choice.
 *
 * Only `exclusiveGateway` produces `_choice_` transitions at all — `bpmnToPN` never branches
 * an `inclusiveGateway` split into one transition per edge, it falls through to the default
 * single-transition (forced-AND) handling, same as any plain node. So `_choice_` naming a
 * SHAPE match is not enough either way: the regex `/^t_(.+)_choice_(\d+)$/` matches on string
 * shape alone, and node ids are only constrained by `input-schema.json`'s
 * `^[a-zA-Z_][a-zA-Z0-9_-]*$` — an ordinary task legally named `my_choice_1` produces
 * transition `t_my_choice_1`, which the regex parses exactly like a real gateway choice.
 * `extractScenarioDecisions` therefore verifies the captured id against `flatNodes`/
 * `flatEdges` before accepting a match: it must name an actual `exclusiveGateway` node with
 * more than one outgoing edge, or the match is rejected outright (not a decision point) —
 * never turned into a fabricated label.
 *
 * ── Happy path: marked or derived ─────────────────────────────────────────────────────────
 * `isHappyPath` is a declared edge field; `identifyHappyPathNodes` (`../bpmn/topology.js`)
 * already tells us whether any edge carries it. When none does, the fallback is the
 * shortest start→end path that uses neither a boundary-event-adjacent edge nor a backward
 * (cycle) edge (`findBackwardEdges`, `./enumerate.js`) — a plain BFS with deterministic
 * tie-breaking (smallest edge id, then smallest target id, at every node). Whichever path is
 * used, the output says explicitly whether it was DERIVED or declared; a consumer must never
 * be able to mistake one for the other.
 *
 * ── Scoring a scenario that skips a happy-path gateway ────────────────────────────────────
 * Distance is computed per happy-path gateway, not per scenario step: for every gateway the
 * happy path made a choice at, a scenario that does not pass through that same gateway AT
 * ALL contributes exactly one unit of distance for it — the same as a scenario that reaches
 * the gateway but chooses differently. A "genuinely different route" is scored identically
 * to "same route, different choice", which is deliberate: both are one gateway's worth of
 * divergence from the reference path, and a scenario that skips more of the happy path's
 * gateways is, by construction, further from it. See `distanceFromHappyPath`.
 *
 * ── Completeness travels WITH the views, it is not a separate channel ─────────────────────
 * Both views carry the enumeration's own incompleteness bookkeeping (`stats`, `truncated`)
 * verbatim — see `describeEnumerationCompleteness` and the `FormattedView` typedef. The
 * whole-branch review found the opposite: every signal `enumerate.js`/`collaboration.js`
 * compute (`deadEndPaths`, `truncated`, `cappedPaths`, …) was dropped here, so a run that
 * enumerated NOTHING because every path dead-ended was presented as an empty scenario list
 * with no explanation, in both files and on stdout. A presentation layer is exactly where
 * that must not happen: the reader of these two views has no other source. `stats` is passed
 * through whole rather than curated for the same reason — a curated subset silently stops
 * carrying whatever field a later task adds upstream, which is how the signal got lost once
 * already.
 */

import { bpmnToPN } from '../bpmn/workflow-net.js';
import { identifyHappyPathNodes } from '../bpmn/topology.js';
import { findBackwardEdges } from './enumerate.js';
import { CFG } from '../shared/utils.js';

const DEFAULT_MAX_GROUPS_RENDERED = 50;

// ═══════════════════════════════════════════════════════════════════════
// Part 1 — decision-label derivation
// ═══════════════════════════════════════════════════════════════════════

const CHOICE_TRANSITION_RE = /^t_(.+)_choice_(\d+)$/;

/**
 * Parse a (local, unprefixed) net transition id into the gateway split it names, if it is
 * one at all.
 *
 * @param {string} localTransitionId
 * @returns {{gatewayId: string, choiceIndex: number}|null} null for anything that does not
 *   even have the right SHAPE for an exclusiveGateway split transition (an implicit merge
 *   `t_<node>_merge_<i>`, a plain `t_<node>`, or an event-based-gateway `t_<node>` — none of
 *   those are decision points). A shape match alone is not proof — see
 *   `resolveGatewayChoice`, which `extractScenarioDecisions` also runs before accepting one.
 */
export function parseDecisionTransition(localTransitionId) {
  const m = CHOICE_TRANSITION_RE.exec(localTransitionId);
  if (!m) return null;
  return { gatewayId: m[1], choiceIndex: Number(m[2]) };
}

/**
 * Confirm a `parseDecisionTransition` match is a REAL exclusiveGateway split, not just a
 * transition id that happens to have the right shape. See the module doc's "Recovering a
 * decision label from a transition id" section for why this check exists: node ids are only
 * constrained by `^[a-zA-Z_][a-zA-Z0-9_-]*$`, so an ordinary task named e.g. `my_choice_1`
 * produces a transition id indistinguishable from a real gateway choice by shape alone.
 *
 * @param {string} gatewayId
 * @param {number} choiceIndex
 * @param {Map<string, object>} nodeById - node lookup for the SAME (flattened) process/pool
 *   the transition came from.
 * @param {Array<object>} flatEdges - the SAME flattened edge list.
 * @returns {object|null} the taken edge if `gatewayId` really is an exclusiveGateway split
 *   and `choiceIndex` is in range; `null` otherwise (reject, do not fabricate).
 */
function resolveGatewayChoice(gatewayId, choiceIndex, nodeById, flatEdges) {
  const node = nodeById.get(gatewayId);
  if (!node || node.type !== 'exclusiveGateway') return null;
  const outEdges = flatEdges.filter(e => e.source === gatewayId);
  if (outEdges.length <= 1 || choiceIndex >= outEdges.length) return null;
  return outEdges[choiceIndex];
}

/**
 * Strip a `CompositeScenario` transition id down to the plain, `bpmnToPN`-style local id:
 * remove the `${poolId}::` prefix (collaboration.js's `scopedId`) and any trailing
 * `__recv_${messageFlowId}` suffix (the receive-split device, collaboration.js:246). A
 * single-process transition id (no `poolId`) passes through unchanged.
 *
 * @param {string} transitionId
 * @param {string|null} [poolId]
 * @returns {string}
 */
export function stripTransitionPrefix(transitionId, poolId) {
  let id = transitionId;
  if (poolId && id.startsWith(`${poolId}::`)) id = id.slice(poolId.length + 2);
  const recvAt = id.indexOf('__recv_');
  if (recvAt >= 0) id = id.slice(0, recvAt);
  return id;
}

/**
 * Recover the decision sequence of one scenario: one entry per exclusiveGateway SPLIT
 * transition it fired, in firing order, naming the edge actually taken. A transition id
 * that merely LOOKS like a gateway choice (see `resolveGatewayChoice`) but does not resolve
 * to a real exclusiveGateway split is silently excluded, not fabricated.
 *
 * @param {string[]} transitions - `Scenario.transitions` / `CompositeScenario.transitions`.
 * @param {Array<string|null>} poolIds - parallel array; `null`/absent entries for a
 *   single-process scenario (every transition has no pool prefix to strip).
 * @param {(poolId: string|null) => {flatNodes: Array<object>, flatEdges: Array<object>}} contextForPool -
 *   returns the flattened node/edge lists of the pool (or the single process) a step
 *   belongs to.
 * @returns {DecisionEntry[]}
 */
export function extractScenarioDecisions(transitions, poolIds, contextForPool) {
  const nodeIndexCache = new Map(); // poolId → Map(nodeId → node), built once per pool

  const decisions = [];
  transitions.forEach((tId, i) => {
    const poolId = poolIds[i] ?? null;
    const local = stripTransitionPrefix(tId, poolId);
    const parsed = parseDecisionTransition(local);
    if (!parsed) return;

    const { flatNodes = [], flatEdges = [] } = contextForPool(poolId) || {};
    if (!nodeIndexCache.has(poolId)) {
      nodeIndexCache.set(poolId, new Map(flatNodes.map(n => [n.id, n])));
    }
    const edge = resolveGatewayChoice(parsed.gatewayId, parsed.choiceIndex, nodeIndexCache.get(poolId), flatEdges);
    if (!edge) return; // shape matched, but not a real gateway split — reject, don't guess

    decisions.push({
      kind: 'bpmn-gateway',
      gatewayId: parsed.gatewayId,
      poolId,
      choiceIndex: parsed.choiceIndex,
      edgeId: edge.id,
      label: edge.label || edge.id,
    });
  });
  return decisions;
}

/**
 * The gateway/decision-point identity a `DecisionEntry` belongs to, independent of `kind`.
 * Only `'bpmn-gateway'` exists today (keyed on `gatewayId`); this is the one place a future
 * `kind` (e.g. `'dmn-rule'`, keyed on its own `decisionId`-style field) needs to be taught
 * about, so `decisionSequenceKey`/`happyPathDecisionMap`/`distanceFromHappyPath` do not have
 * to change themselves when that day comes.
 *
 * @param {object} d - a `DecisionEntry`.
 * @returns {string}
 */
function decisionPointKey(d) {
  const subject = d.kind === 'bpmn-gateway' ? d.gatewayId : (d.gatewayId ?? d.id ?? d.kind);
  return `${d.poolId ?? ''}::${subject}`;
}

/**
 * The identity of the CHOICE made at one decision point — `edgeId` when the taken edge was
 * resolved (always true for `extractScenarioDecisions`/`decisionsFromEdgePath` output),
 * falling back to `choiceIndex` otherwise. Deliberately NOT `label`: M04 only requires an
 * XOR split's outgoing edges to carry A label, not a DISTINCT one per edge, so two edges out
 * of the same gateway may legally share identical label text while being structurally
 * different choices — grouping/distance must not collapse them just because they read the
 * same. `label` stays display-only (see `renderDecisionLabel`).
 *
 * @param {object} d - a `DecisionEntry`.
 * @returns {string}
 */
function decisionChoiceKey(d) {
  return d.edgeId ?? (d.choiceIndex != null ? `#${d.choiceIndex}` : `label:${d.label}`);
}

/**
 * Canonical string key for a decision sequence — two scenarios group together exactly when
 * this is identical. Keyed on `(poolId, gatewayId, edgeId)`, not `label` — see
 * `decisionChoiceKey`.
 *
 * @param {ReturnType<typeof extractScenarioDecisions>} decisions
 * @returns {string}
 */
export function decisionSequenceKey(decisions) {
  return JSON.stringify(decisions.map(d => [decisionPointKey(d), decisionChoiceKey(d)]));
}

// ═══════════════════════════════════════════════════════════════════════
// Part 2 — the happy path: marked or derived
// ═══════════════════════════════════════════════════════════════════════

/**
 * Order a set of `isHappyPath` edges into the single chain they are meant to describe,
 * starting from the edge whose source is never anyone's target (the chain head) and walking
 * `source → edge` until the chain runs out. Assumes — as `topology.js`'s own consumers of
 * `isHappyPath` do — that at most one outgoing edge per node is marked; a model that marks
 * two produces a shorter chain (the second marked edge simply never gets visited), which is
 * a model-authoring problem, not something this function silently repairs.
 *
 * @param {Array<object>} happyEdges - edges with `isHappyPath: true`.
 * @returns {Array<object>} the edges in chain order.
 */
function orderHappyPathEdges(happyEdges) {
  const bySource = new Map(happyEdges.map(e => [e.source, e]));
  const targets = new Set(happyEdges.map(e => e.target));
  const heads = [...bySource.keys()].filter(id => !targets.has(id)).sort();
  if (heads.length === 0) return [];

  const ordered = [];
  const seen = new Set();
  let cur = heads[0];
  while (bySource.has(cur) && !seen.has(cur)) {
    const e = bySource.get(cur);
    ordered.push(e);
    seen.add(cur);
    cur = e.target;
  }
  return ordered;
}

/**
 * Shortest-path fallback used when no edge in the process is marked `isHappyPath`. Plain
 * BFS (unweighted shortest path) over the edges that are neither a backward (cycle) edge nor
 * adjacent to a boundary event, deterministic by construction: a single, lexicographically
 * smallest root among the start events, and at every node its outgoing edges tried in
 * ascending `(edge id, target id)` order — so the first BFS run to claim an unvisited node
 * always wins the same way on every re-run.
 *
 * @param {Array<object>} flatNodes
 * @param {Array<object>} flatEdges
 * @returns {Array<object>} the path's edges, start to end; empty if no start/end event
 *   exists or nothing connects them under the exclusions.
 */
export function deriveHappyPathEdges(flatNodes, flatEdges) {
  const starts = flatNodes.filter(n => n.type === 'startEvent').map(n => n.id).sort();
  const ends = new Set(flatNodes.filter(n => n.type === 'endEvent').map(n => n.id));
  if (starts.length === 0 || ends.size === 0) return [];

  const backward = new Set(findBackwardEdges(flatNodes, flatEdges).map(e => e.id));
  const boundaryIds = new Set(flatNodes.filter(n => n.type === 'boundaryEvent').map(n => n.id));
  const eligible = flatEdges.filter(e =>
    !backward.has(e.id) && !boundaryIds.has(e.source) && !boundaryIds.has(e.target));

  const outMap = new Map();
  for (const e of eligible) {
    if (!outMap.has(e.source)) outMap.set(e.source, []);
    outMap.get(e.source).push(e);
  }
  for (const [, arr] of outMap) {
    arr.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : (a.target < b.target ? -1 : a.target > b.target ? 1 : 0)));
  }

  const root = starts[0];
  const prevEdge = new Map();
  const visited = new Set([root]);
  const queue = [root];
  let foundEnd = null;

  while (queue.length > 0) {
    const cur = queue.shift();
    if (ends.has(cur)) { foundEnd = cur; break; }
    for (const e of outMap.get(cur) || []) {
      if (!visited.has(e.target)) {
        visited.add(e.target);
        prevEdge.set(e.target, e);
        queue.push(e.target);
      }
    }
  }
  if (foundEnd === null) return [];

  const path = [];
  let node = foundEnd;
  while (prevEdge.has(node)) {
    const e = prevEdge.get(node);
    path.push(e);
    node = e.source;
  }
  return path.reverse();
}

/**
 * Turn an ordered edge path into the Part 1 decision sequence it represents: one entry per
 * edge whose source is an exclusiveGateway SPLIT — deliberately the SAME node-type
 * restriction `resolveGatewayChoice` applies to a transition id, and for the same reason:
 * `bpmnToPN` only ever emits a `_choice_` transition (a real decision point in the net) for
 * `exclusiveGateway`; an `inclusiveGateway` split falls through to the forced-AND default
 * handling and produces no `_choice_` transition at all (workflow-net.js ~89-92, 105-122,
 * 168). Counting an inclusive split here would put a decision point into the happy path's
 * key that no scenario's own `extractScenarioDecisions` can ever match — every scenario
 * would silently carry a constant +1 `happyPathDistance` penalty for it, including the
 * scenario that IS the happy path.
 *
 * @param {Array<object>} pathEdges
 * @param {Array<object>} flatNodes
 * @param {Array<object>} flatEdges
 * @param {string|null} poolId
 * @returns {ReturnType<typeof extractScenarioDecisions>}
 */
function decisionsFromEdgePath(pathEdges, flatNodes, flatEdges, poolId) {
  const nodeById = new Map(flatNodes.map(n => [n.id, n]));
  const outCount = new Map();
  for (const e of flatEdges) outCount.set(e.source, (outCount.get(e.source) || 0) + 1);

  const decisions = [];
  for (const e of pathEdges) {
    const src = nodeById.get(e.source);
    const isSplitGateway = src
      && src.type === 'exclusiveGateway'
      && (outCount.get(e.source) || 0) > 1;
    if (!isSplitGateway) continue;
    decisions.push({
      kind: 'bpmn-gateway',
      gatewayId: e.source,
      poolId,
      choiceIndex: null, // not derived via a transition id here — the edge itself IS the choice
      edgeId: e.id,
      label: e.label || e.id,
    });
  }
  return decisions;
}

/**
 * The happy path of one process (or one pool): marked if any edge carries `isHappyPath`,
 * derived (shortest path, excluding boundary/backward edges) otherwise. Always says which.
 *
 * @param {Array<object>} flatNodes
 * @param {Array<object>} flatEdges
 * @param {string|null} [poolId] - null for a single process; the pool id for a collaboration
 *   pool, so the resulting decision entries carry the same `poolId` a scenario's would.
 * @returns {{derived: boolean, found: boolean, edges: Array<object>, decisions: DecisionEntry[]}}
 *   `found` is false only for the derived (BFS) case when no start/end event exists or
 *   nothing connects them under the exclusions — an honest "no happy path could be
 *   identified", distinct from "found one with zero decision points on it".
 */
export function computeHappyPath(flatNodes, flatEdges, poolId = null) {
  const markedNodeIds = identifyHappyPathNodes(flatNodes, flatEdges);
  if (markedNodeIds.size > 0) {
    const edges = orderHappyPathEdges(flatEdges.filter(e => e.isHappyPath));
    return {
      derived: false,
      found: edges.length > 0,
      edges,
      decisions: decisionsFromEdgePath(edges, flatNodes, flatEdges, poolId),
    };
  }
  const edges = deriveHappyPathEdges(flatNodes, flatEdges);
  return {
    derived: true,
    found: edges.length > 0,
    edges,
    decisions: decisionsFromEdgePath(edges, flatNodes, flatEdges, poolId),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Part 3 — distance and sort
// ═══════════════════════════════════════════════════════════════════════

/**
 * `decisionPointKey(d)` → the happy path's `decisionChoiceKey(d)` there, first occurrence
 * wins — relevant when the happy path (marked or derived) visits the same gateway more than
 * once, e.g. because a marked chain loops; only the first choice counts as "the" happy
 * answer for that gateway.
 */
export function happyPathDecisionMap(happyDecisions) {
  const map = new Map();
  for (const d of happyDecisions) {
    const key = decisionPointKey(d);
    if (!map.has(key)) map.set(key, decisionChoiceKey(d));
  }
  return map;
}

/**
 * Distance of one scenario's decisions from the happy path: the count of happy-path
 * gateways where this scenario chose differently OR never reached the gateway at all. See
 * the module doc for why both cases score identically. Compared by `decisionChoiceKey`
 * (effectively `edgeId`), never by `label` — two edges out of the same gateway may legally
 * share identical label text (M04 requires A label, not a unique one).
 *
 * @param {ReturnType<typeof extractScenarioDecisions>} decisions
 * @param {Map<string, string>} happyMap - from `happyPathDecisionMap`.
 * @returns {number}
 */
export function distanceFromHappyPath(decisions, happyMap) {
  if (happyMap.size === 0) return 0;
  const scenarioMap = new Map();
  for (const d of decisions) {
    // First occurrence wins here too, mirroring `happyPathDecisionMap` — relevant for a
    // scenario that visits the same gateway more than once inside a loop.
    const key = decisionPointKey(d);
    if (!scenarioMap.has(key)) scenarioMap.set(key, decisionChoiceKey(d));
  }
  let dist = 0;
  for (const [key, happyChoice] of happyMap) {
    if (scenarioMap.get(key) !== happyChoice) dist++;
  }
  return dist;
}

// ═══════════════════════════════════════════════════════════════════════
// Part 3b — enumeration completeness, in words
// ═══════════════════════════════════════════════════════════════════════

/** Render up to `limit` ids as a quoted, comma-separated list, with a `(+N more)` tail. */
function idList(ids, limit = 8) {
  const shown = ids.slice(0, limit).map((id) => `"${id}"`).join(', ');
  const rest = ids.length - Math.min(ids.length, limit);
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}

/** `stats.orGateways` is `string[]` single-process, `{poolId, nodeId}[]` for a collaboration;
 *  `stats.skipped` and `stats.approximations` are `{id, reason}[]` / `{poolId, id, reason}[]`.
 *  One id shape out of all three. */
function scopedIds(entries, idKey) {
  return (entries || []).map((e) =>
    (typeof e === 'string' ? e : (e.poolId ? `${e.poolId}::${e[idKey]}` : e[idKey])));
}

/**
 * Everything an `EnumerationResult`/`CollaborationEnumerationResult` knows about its own
 * incompleteness, in two tiers a consumer must treat differently. Pure derivation from
 * `stats`/`truncated` — the single source both the Markdown view and the CLI render from, so
 * the file a human reads and the line the CLI prints cannot say different things.
 *
 * ── Why two tiers ─────────────────────────────────────────────────────────────────────────
 * `enumerate.js`'s own `stats.cappedPaths` doc states the distinction and instructs this
 * layer to keep it: cycle-bound suppressions "are NOT dead ends and NOT a soundness finding —
 * the path exists in the model, it was simply not explored. A later judging layer must be
 * able to tell them from the next field, which is why they are counted apart."
 *
 *   - `warnings` — **the enumeration did not finish the job**: it produced nothing, ran into
 *     states it could not leave, or was cut off mid-way. Something is unresolved, and the
 *     CLI's `--strict` blocks on these, exactly as it blocks on an unresolved warning in
 *     `scripts/bpmn/pipeline.js` and `scripts/dmn/pipeline.js`.
 *   - `notes` — **the enumeration finished; here is what it structurally cannot see**: a
 *     configured cycle bound doing its job, an OR split the Petri-net translation fires as an
 *     AND, a node class it does not model, a message flow with a black-box end. These are
 *     properties of the input and the translation, not failures of this run, so they are
 *     printed (never hidden) but never block — mirroring the non-blocking `💡` advisory
 *     channel `scripts/bpmn/pipeline.js` already uses for its Optimization layer.
 *
 * @param {object} enumerationResult - `EnumerationResult` (enumerate.js) or
 *   `CollaborationEnumerationResult` (collaboration.js).
 * @returns {{warnings: string[], notes: string[]}} both empty for a run that enumerated a
 *   complete scenario set over a fully modelled process — the only case in which silence is
 *   the honest answer.
 */
export function describeEnumerationCompleteness(enumerationResult) {
  const stats = enumerationResult?.stats || {};
  const scenarioCount = enumerationResult?.scenarios?.length ?? 0;
  const warnings = [];
  const notes = [];

  if (scenarioCount === 0) {
    warnings.push('No scenario reached completion — not one path ended with every pool\'s end '
      + 'event reached. An empty scenario list is a total enumeration failure, not a clean process.');
  }
  if ((stats.deadEndPaths || 0) > 0) {
    warnings.push(`${stats.deadEndPaths} path(s) dead-ended: reached a state with no enabled `
      + 'transition and no completion. Counted, not judged — WF03 (`scripts/bpmn/workflow-net.js`) '
      + 'is where a deadlock gets called a deadlock.');
  }
  if (enumerationResult?.truncated) {
    warnings.push('The scenario cap fired: the list is a PREFIX of the scenario set, not the '
      + 'complete set.');
  }
  if ((stats.lengthTruncatedPaths || 0) > 0) {
    warnings.push(`${stats.lengthTruncatedPaths} path(s) were abandoned at the maximum trace `
      + 'length before reaching completion.');
  }

  if ((stats.cappedPaths || 0) > 0) {
    notes.push(`${stats.cappedPaths} branch continuation(s) were not followed because the cycle `
      + `bound (${stats.cycleBound}) would have been exceeded. Those paths exist in the model; `
      + 'they were simply not explored — this is the bound working, not a defect.');
  }
  const orIds = scopedIds(stats.orGateways, 'nodeId');
  if (orIds.length > 0) {
    notes.push(`${orIds.length} inclusive (OR) gateway(s) are modelled as a forced AND (every `
      + `branch fires): ${idList(orIds)}. For those, the scenario set is an under-enumeration.`);
  }
  // Split by reason: an artifact has no control-flow role to lose, an eventBasedGateway does —
  // its race semantics are simply not modelled, so scenarios ARE missing. Reporting the two
  // under one count would bury the second in the first, which is the common case.
  const skippedArtifacts = scopedIds((stats.skipped || []).filter((s) => s.reason === 'artifact'), 'id');
  const skippedOther = (stats.skipped || []).filter((s) => s.reason !== 'artifact');
  if (skippedArtifacts.length > 0) {
    notes.push(`${skippedArtifacts.length} artifact(s) carry no control-flow model: `
      + `${idList(skippedArtifacts)}. Harmless here — an artifact has no control-flow role to lose.`);
  }
  // One note PER reason, not one note with a hardcoded explanation. The count here was always
  // reason-agnostic while the sentence explaining it named only `eventBasedGateway`, so when
  // Stage 1 added `subProcessWithoutStartOrEnd` the new reason was disclosed with an
  // explanation about race semantics that has nothing to do with it — the reader is told the
  // wrong thing about the right node. Grouping makes the explanation follow the reason.
  const skipExplanation = {
    eventBasedGateway: 'An eventBasedGateway\'s race semantics have no Petri-net translation '
      + 'here, so its scenarios are missing from the list entirely.',
    subProcessWithoutStartOrEnd: 'A container without an inner startEvent or endEvent has no '
      + 'well-defined entry or exit marking, so it is translated as a single atomic transition '
      + 'and its children do not appear in any scenario.',
    boundaryEventWithoutHost: 'A boundary event is triggered by its host, so with no host that '
      + 'can be found — or a host nothing can enable — there is nothing to trigger it from. '
      + 'Giving it a transition anyway would only recreate the unfireable transition this '
      + 'translation exists to remove; its whole path is missing from the list.',
  };
  const skipReasons = [...new Set(skippedOther.map((s) => s.reason))].sort();
  for (const reason of skipReasons) {
    const ofReason = skippedOther.filter((s) => s.reason === reason);
    notes.push(`${ofReason.length} node(s) are not modelled at all: `
      + `${idList(scopedIds(ofReason, 'id'))} (${reason}). `
      // An unknown reason gets the count and the ids and no invented explanation, which is the
      // honest shape for whatever the next translation gap turns out to be.
      + (skipExplanation[reason] || 'Their scenarios are missing from the list entirely.'));
  }
  // Approximated, not skipped: these nodes DO fire and DO appear in traces — the scenario set
  // is simply narrower than the semantics allow around them. Reported on its own channel for
  // that reason: folding them into the `skipped` notes would tell the reader the node is
  // missing from the list entirely, which is the opposite of what happened. Grouped by reason,
  // for the same argument the skip notes make above — the explanation has to follow the reason,
  // or the next approximation to be added gets described as the previous one.
  const approxExplanation = {
    nonInterruptingBoundaryEvent:
      'A non-interrupting boundary event is translated exactly like an interrupting one — an '
      + 'XOR alternative to its host — so every scenario in which the host AND the event path '
      + 'both run is missing. The faithful alternatives each invent something the model does '
      + 'not say (a forced AND adds a path; a silent skip transition adds a step to the trace), '
      + 'so this one under-models and says so. See `wireBoundaryEvents` in '
      + '`scripts/bpmn/workflow-net.js`.',
    boundaryEventOnContainer:
      'A boundary event on a subprocess competes with the subprocess\'s ENTRY, so the scenarios '
      + 'in which the subprocess ran partway and was then interrupted are missing — only "ran '
      + 'to completion" and "the boundary event fired instead" appear. Cancelling a subprocess '
      + 'mid-flight needs a cancel region, which no fixed set of Petri-net arcs expresses.',
  };
  const approximations = stats.approximations || [];
  const approxReasons = [...new Set(approximations.map((a) => a.reason))].sort();
  for (const reason of approxReasons) {
    const ofReason = approximations.filter((a) => a.reason === reason);
    notes.push(`${ofReason.length} node(s) are modelled by approximation: `
      + `${idList(scopedIds(ofReason, 'id'))} (${reason}). `
      + (approxExplanation[reason]
        || 'The scenario set is an under-enumeration around them.'));
  }

  const ungated = stats.ungatedMessageFlows || [];
  if (ungated.length > 0) {
    // `gates: false` covers three cases and this note used to name only one of them, so a
    // failure to MAP an endpoint was reported to the reader as a deliberate modelling CHOICE —
    // in a view whose own header says the reader has no other source. The distinction is
    // already made upstream (`ungatedReason`, collaboration.js); it is only rendered here.
    const reasonOf = new Map((stats.messageFlows || []).map((mf) => [mf.id, mf.ungatedReason]));
    const blackBox = ungated.filter((id) => reasonOf.get(id) === 'blackBox');
    const unmapped = ungated.filter((id) => reasonOf.get(id) !== 'blackBox');
    if (blackBox.length > 0) {
      notes.push(`${blackBox.length} message flow(s) enforce no ordering at all `
        + `(a black-box endpoint): ${idList(blackBox)}. The joint order across `
        + 'pools is not synchronised for these.');
    }
    if (unmapped.length > 0) {
      notes.push(`${unmapped.length} message flow(s) enforce no ordering because an endpoint `
        + `could not be mapped to a node: ${idList(unmapped)}. See unresolvedEndpoints below for `
        + 'which end and why. Unlike a black-box endpoint this is not a modelling choice — it is '
        + 'a defect in the model or in the translation, and the joint order is unsynchronised as '
        + 'a consequence of that defect rather than by design.');
    }
  }
  if ((stats.unconsumedMessagePlaces || []).length > 0) {
    notes.push(`${stats.unconsumedMessagePlaces.length} message place(s) are never consumed by `
      + `any transition: ${idList(stats.unconsumedMessagePlaces)}.`);
  }
  const unresolved = stats.unresolvedEndpoints || [];
  if (unresolved.length > 0) {
    // The `reason` is carried through rather than flattened: "names a subProcess" points the
    // reader at a real element and at the rule that explains it, where the bare "could not be
    // mapped" would send them looking for a node that is not missing at all.
    const why = {
      container: 'names a subProcess, which is not a valid MessageFlow endpoint (S14)',
      unknownId: 'matches no node and no black-box participant',
    };
    notes.push(`${unresolved.length} message flow endpoint(s) could not be mapped to a node: `
      + `${idList(unresolved.map((u) => `${u.messageFlowId}/${u.endpoint}=${u.id} `
        + `(${why[u.reason] || u.reason || 'reason not recorded'})`))}. Those flows `
      + 'synchronise nothing.');
  }

  return { warnings, notes };
}

// ═══════════════════════════════════════════════════════════════════════
// Part 4 — assembling the two views
// ═══════════════════════════════════════════════════════════════════════

function resolveMaxGroupsRendered(options) {
  const cfg = (options.config || CFG) || {};
  const fmt = (cfg.scenarios || {}).format || {};
  return options.maxGroupsRendered ?? fmt.maxGroupsRendered ?? DEFAULT_MAX_GROUPS_RENDERED;
}

/** Group already-sorted, decision-tagged scenarios by `groupKey`, preserving sort order. */
function groupScenarios(sortedScenarios) {
  const groups = new Map();
  for (const s of sortedScenarios) {
    if (!groups.has(s.groupKey)) {
      groups.set(s.groupKey, { groupKey: s.groupKey, decisions: s.decisions, members: [] });
    }
    groups.get(s.groupKey).members.push(s);
  }
  return [...groups.values()];
}

/** `id` → display name, falling back to `id` itself when the node has none. */
function buildNameIndex(flatNodes) {
  const map = new Map();
  for (const n of flatNodes) map.set(n.id, n.name || n.id);
  return map;
}

function displayName(nameById, id) {
  return nameById.get(id) || id;
}

function renderDecisionLabel(d, nameById) {
  const gwName = displayName(nameById, d.gatewayId);
  return d.poolId ? `${gwName}@${d.poolId} → ${d.label}` : `${gwName} → ${d.label}`;
}

function renderMarkdown(groups, happyPath, maxGroupsRendered, nameById, scenarioCount, completeness) {
  const lines = [];
  lines.push('# Scenario Overview');
  lines.push('');
  lines.push(happyPath.derived
    ? '_Happy path: DERIVED — no `isHappyPath` edge was declared; this is the shortest ' +
      'start→end path excluding boundary-event and backward (cycle) edges._'
    : '_Happy path: declared via `isHappyPath` edges._');
  if (!happyPath.found) {
    lines.push('_No happy path could be identified at all (disconnected process, or no ' +
      'start/end event) — distances below are all 0 and carry no information._');
  }
  lines.push('');

  // The summary goes FIRST, above the groups: when `scenarioCount` is 0 there are no groups to
  // read at all, and the reader's only question is why. A completeness note appended after an
  // empty list would be a footnote to nothing.
  lines.push('## Enumeration summary');
  lines.push('');
  lines.push(`- Scenarios enumerated: **${scenarioCount}**, in ${groups.length} decision group(s).`);
  if (completeness.warnings.length > 0) {
    lines.push('');
    lines.push('**⚠ Completeness — resolve these before reading the list below as the whole truth:**');
    lines.push('');
    for (const w of completeness.warnings) lines.push(`- ${w}`);
  }
  if (completeness.notes.length > 0) {
    lines.push('');
    lines.push('**Notes — what the Petri-net translation structurally cannot see (no verdict):**');
    lines.push('');
    for (const n of completeness.notes) lines.push(`- ${n}`);
  }
  lines.push('');

  const rendered = groups.slice(0, maxGroupsRendered);
  for (const g of rendered) {
    const heading = g.decisions.length
      ? g.decisions.map(d => renderDecisionLabel(d, nameById)).join('; ')
      : '(no decision points — single path)';
    lines.push(`## ${heading}`);
    for (const m of g.members) {
      const interleaving = m.interleavingCount > 1 ? ` (×${m.interleavingCount} interleavings)` : '';
      const trace = m.nodes.map(id => displayName(nameById, id)).join(' → ');
      lines.push(`- Scenario #${m.index} — distance ${m.happyPathDistance}${interleaving}: ${trace}`);
    }
    lines.push('');
  }

  const omitted = groups.length - rendered.length;
  if (omitted > 0) {
    lines.push(`_${omitted} more group${omitted === 1 ? '' : 's'} not shown, see the JSON view._`);
  }
  return lines.join('\n');
}

function assemble(enumerationResult, decisionsFor, happyPath, options, nameById) {
  const happyMap = happyPathDecisionMap(happyPath.decisions);
  const enriched = (enumerationResult.scenarios || []).map(s => {
    const decisions = decisionsFor(s);
    return {
      ...s,
      decisions,
      groupKey: decisionSequenceKey(decisions),
      happyPathDistance: distanceFromHappyPath(decisions, happyMap),
    };
  });
  enriched.sort((a, b) => (a.happyPathDistance - b.happyPathDistance) || (a.index - b.index));

  const groups = groupScenarios(enriched);
  const maxGroupsRendered = resolveMaxGroupsRendered(options);
  const completeness = describeEnumerationCompleteness(enumerationResult);

  return {
    json: {
      happyPath,
      scenarios: enriched,
      groupCount: groups.length,
      // Passed through whole, never curated — see the module header's "Completeness travels
      // WITH the views" section. `truncated` sits alongside `stats` rather than inside it
      // because that is where `EnumerationResult` itself puts it.
      truncated: enumerationResult.truncated ?? false,
      stats: enumerationResult.stats ?? {},
    },
    markdown: renderMarkdown(groups, happyPath, maxGroupsRendered, nameById, enriched.length, completeness),
  };
}

/**
 * One decision-point entry, as produced by `extractScenarioDecisions` (from a scenario's own
 * transitions) or `decisionsFromEdgePath` (from the happy path's edges). Deliberately
 * `kind`-tagged and shaped as one entry in an ordered list — see the module doc's "Grouping
 * key: BPMN gateways only, not DMN" section for why, and `decisionPointKey` for the one place
 * a future `kind` needs to be taught about.
 *
 * @typedef {object} DecisionEntry
 * @property {'bpmn-gateway'} kind
 * @property {string} gatewayId - the exclusiveGateway node's own (unprefixed) BPMN id.
 * @property {string|null} poolId - null for a single-process scenario/happy path.
 * @property {number|null} choiceIndex - the `_choice_<i>` index this entry came from; null
 *   when the entry was derived directly from an edge (`decisionsFromEdgePath`) rather than a
 *   transition id.
 * @property {string|null} edgeId - the taken edge's own id. This, not `label`, is the
 *   identity used for grouping and distance (`decisionChoiceKey`).
 * @property {string} label - the taken edge's `label`, falling back to its `id`. DISPLAY
 *   ONLY: two distinct edges out of the same gateway may legally share an identical label
 *   (M04 only requires A label per edge, not a unique one).
 */

/**
 * The happy path used as the sorting/distance reference for one `FormattedView`.
 *
 * @typedef {object} FormattedHappyPath
 * @property {boolean} derived - true = the BFS fallback was used (no relevant
 *   `isHappyPath` edge declared); false = an `isHappyPath`-marked chain was found and used
 *   verbatim. A consumer must check this before treating the path as authored.
 * @property {boolean} found - false only when no happy path could be identified at all
 *   (disconnected process, or missing start/end event) — distinct from "found one with zero
 *   decision points on it", which is `found: true` with an empty `decisions` array.
 * @property {DecisionEntry[]} decisions - the happy path's own decision sequence.
 * @property {Array<object>} [edges] - single-process (`formatScenarioResult`) only: the
 *   happy path's own edge chain, start to end.
 * @property {Array<{poolId: string, derived: boolean, found: boolean, edges: Array<object>, decisions: DecisionEntry[]}>} [perPool] -
 *   collaboration (`formatCollaborationResult`) only: one entry per pool, since a
 *   collaboration's happy path is computed per pool and concatenated, not walked jointly.
 */

/**
 * One scenario as it appears in the JSON view: every field of `Scenario`
 * (`enumerate.js`)/`CompositeScenario` (`collaboration.js`), unchanged, plus the three this
 * module adds.
 *
 * @typedef {object} FormattedScenario
 * @property {number} index
 * @property {string[]} transitions
 * @property {string[]} nodes
 * @property {number|null} interleavingCount
 * @property {Object<string, number>} cycleUseCounts
 * @property {string[]} [poolIds] - `CompositeScenario` only.
 * @property {string[]} [messagesSent] - `CompositeScenario` only.
 * @property {string[]} [messagesReceived] - `CompositeScenario` only.
 * @property {string[]} [residualPlaces] - `CompositeScenario` only.
 * @property {Object<string, number>} [sinkTokens] - `CompositeScenario` only.
 * @property {DecisionEntry[]} decisions - this scenario's own decision sequence (Part 1).
 * @property {string} groupKey - canonical string from `decisionSequenceKey(decisions)`; two
 *   scenarios share a Markdown group iff their `groupKey`s are identical.
 * @property {number} happyPathDistance - see `distanceFromHappyPath`.
 */

/**
 * The complete result of formatting one `EnumerationResult`/`CollaborationEnumerationResult`.
 *
 * @typedef {object} FormattedView
 * @property {object} json
 * @property {FormattedHappyPath} json.happyPath
 * @property {FormattedScenario[]} json.scenarios - EVERY scenario, sorted ascending by
 *   `(happyPathDistance, index)`; nothing dropped or summarized.
 * @property {number} json.groupCount - distinct `groupKey`s over the FULL set, independent
 *   of any Markdown rendering cap.
 * @property {boolean} json.truncated - `EnumerationResult.truncated` /
 *   `CollaborationEnumerationResult.truncated`, passed through unchanged: true means
 *   `json.scenarios` is a PREFIX of the scenario set.
 * @property {object} json.stats - the source `EnumerationResult.stats` /
 *   `CollaborationEnumerationResult.stats`, **passed through whole and unchanged** —
 *   `deadEndPaths`, `cappedPaths`, `lengthTruncatedPaths`, `backwardEdges`, `orGateways`,
 *   `skipped`, `approximations`, `statesExplored`, and, on the collaboration path, `messageFlows`,
 *   `ungatedMessageFlows`, `unconsumedMessagePlaces`, `unresolvedEndpoints`. A consumer that
 *   reads `json.scenarios` without reading this is reading an answer without its error bars;
 *   `describeEnumerationCompleteness` turns the same data into prose for a human.
 * @property {string} markdown - the grouped, capped, human-readable rendering: a heading, a
 *   line stating whether the happy path is declared or DERIVED, an `## Enumeration summary`
 *   section carrying the scenario count and `describeEnumerationCompleteness`'s two tiers,
 *   one `##` section per rendered group (decision sequence in plain language, member
 *   scenarios with their node trace and, when `interleavingCount > 1`, that count), and — if
 *   `maxGroupsRendered` truncated the group list — an explicit `_N more group(s) not shown,
 *   see the JSON view._` line. See `renderMarkdown`.
 */

/**
 * Format the result of `enumerateScenarios` (single process, `../scenarios/enumerate.js`)
 * into the JSON and Markdown views.
 *
 * **Prefer `formatCollaborationResult`** (with `enumerateCollaboration`): that pair is a
 * strict superset for single-process input and the only one that yields `SC06` coverage.
 * `pipeline.js` routes every document, pooled or not, through it. This function is kept for
 * direct single-process library use, where the plain `Scenario` shape is what the caller
 * wants.
 *
 * @param {import('./enumerate.js').EnumerationResult} enumerationResult
 * @param {object} proc - the SAME process object `enumerateScenarios` was called with.
 * @param {object} [options] - `{maxGroupsRendered?, config?}`; `config` mirrors
 *   `enumerateScenarios`'s option of the same name (defaults to the loaded `CFG`).
 * @returns {FormattedView}
 */
export function formatScenarioResult(enumerationResult, proc, options = {}) {
  const pn = bpmnToPN(proc);
  const happyPath = computeHappyPath(pn.flatNodes, pn.flatEdges, null);
  const context = { flatNodes: pn.flatNodes, flatEdges: pn.flatEdges };
  const decisionsFor = (s) =>
    extractScenarioDecisions(s.transitions, s.transitions.map(() => null), () => context);
  const nameById = buildNameIndex(pn.flatNodes);
  return assemble(enumerationResult, decisionsFor, happyPath, options, nameById);
}

/**
 * Format the result of `enumerateCollaboration` (`../scenarios/collaboration.js`) into the
 * JSON and Markdown views.
 *
 * Happy path is computed PER POOL (each pool's own `isHappyPath` marks or its own BFS
 * fallback — a collaboration's happy path is not one cross-pool synchronised walk, it is
 * "the favoured route through each participant"), then concatenated in `lc.pools`'
 * declaration order. `happyPath.derived` is true if ANY pool's contribution was derived —
 * a joint result is never allowed to read as fully declared when part of it was inferred.
 * `happyPath.found` is true only if EVERY pool found one.
 *
 * @param {import('./collaboration.js').CollaborationEnumerationResult} collabResult
 * @param {object} lc - the SAME Logic-Core `enumerateCollaboration` was called with.
 * @param {object} [options] - as `formatScenarioResult`.
 * @returns {FormattedView}
 */
export function formatCollaborationResult(collabResult, lc, options = {}) {
  // Mirror `collaboration.js`'s `composeCollaboration` exactly: a document without `pools`
  // is one unnamed pool, not zero pools. Getting this wrong used to mean a fully flat `lc`
  // silently produced NO per-pool context at all (the loop below never ran), which in turn
  // made every scenario's `decisions` come out empty — not a rendering quirk, a correctness
  // bug that `rules.js`'s SC01 surfaced downstream as false positives on every branch.
  const pools = lc.pools ? lc.pools : [lc];
  const flatContextByPool = new Map();
  const nameById = new Map();
  const perPool = [];

  pools.forEach((pool, i) => {
    // The id actually wired into the composed net: `collabResult.poolIds[i]`, positionally
    // aligned with `pools` (both walk `lc.pools`/`[lc]` in the same order — see
    // `composeCollaboration`'s own loop). NOT `pool.id` directly: `composeCollaboration`
    // synthesizes an id (`freshPoolId`) whenever a pool declares none, and `CompositeScenario
    // .poolIds` carries that synthesized id, never `undefined`. Keying this module's own
    // per-pool context by the raw (possibly-undefined) `pool.id` instead made every lookup
    // against a synthesized id miss, silently — the map held a `undefined` key nothing ever
    // queried for. Falling back to `pool.id` only covers the pathological case where
    // `collabResult` was not actually produced by `enumerateCollaboration(lc)` for this same
    // `lc` (a caller contract violation, not a shape this function needs to serve well).
    const poolId = collabResult.poolIds?.[i] ?? pool.id ?? null;
    const pn = bpmnToPN(pool);
    flatContextByPool.set(poolId, { flatNodes: pn.flatNodes, flatEdges: pn.flatEdges });
    // Node ids are assumed globally unique across pools (the same assumption
    // `collaboration.js`'s `nodeOwners` makes); a collision has the later pool's name win.
    for (const [id, name] of buildNameIndex(pn.flatNodes)) nameById.set(id, name);
    const hp = computeHappyPath(pn.flatNodes, pn.flatEdges, poolId);
    perPool.push({ poolId, ...hp });
  });

  const happyPath = {
    derived: perPool.some(p => p.derived),
    found: perPool.length > 0 && perPool.every(p => p.found),
    decisions: perPool.flatMap(p => p.decisions),
    perPool,
  };

  const decisionsFor = (s) =>
    extractScenarioDecisions(s.transitions, s.poolIds, (poolId) => flatContextByPool.get(poolId) || {});

  return assemble(collabResult, decisionsFor, happyPath, options, nameById);
}
