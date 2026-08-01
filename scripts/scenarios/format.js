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
 * @returns {{gatewayId: string, choiceIndex: number}|null} null for anything that is not an
 *   XOR/inclusive-gateway SPLIT transition (an implicit merge `t_<node>_merge_<i>`, a plain
 *   `t_<node>`, or an event-based-gateway `t_<node>` — none of those are decision points).
 */
export function parseDecisionTransition(localTransitionId) {
  const m = CHOICE_TRANSITION_RE.exec(localTransitionId);
  if (!m) return null;
  return { gatewayId: m[1], choiceIndex: Number(m[2]) };
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
 * Recover the decision sequence of one scenario: one entry per XOR/inclusive-gateway SPLIT
 * transition it fired, in firing order, naming the edge actually taken.
 *
 * @param {string[]} transitions - `Scenario.transitions` / `CompositeScenario.transitions`.
 * @param {Array<string|null>} poolIds - parallel array; `null`/absent entries for a
 *   single-process scenario (every transition has no pool prefix to strip).
 * @param {(poolId: string|null) => Array<object>} edgesForPool - returns the flattened edge
 *   list of the pool (or the single process) a step belongs to.
 * @returns {Array<{kind: 'bpmn-gateway', gatewayId: string, poolId: string|null,
 *   choiceIndex: number, edgeId: string|null, label: string}>}
 */
export function extractScenarioDecisions(transitions, poolIds, edgesForPool) {
  const decisions = [];
  transitions.forEach((tId, i) => {
    const poolId = poolIds[i] ?? null;
    const local = stripTransitionPrefix(tId, poolId);
    const parsed = parseDecisionTransition(local);
    if (!parsed) return;

    const flatEdges = edgesForPool(poolId) || [];
    const outEdges = flatEdges.filter(e => e.source === parsed.gatewayId);
    const edge = outEdges[parsed.choiceIndex];
    // `edge` is expected to always exist — the index came from the same construction rule
    // `bpmnToPN` used to build the transition in the first place. The fallback label below
    // is defence in depth, never expected to fire, and deliberately still informative
    // rather than silently dropping the decision point.
    const label = edge ? (edge.label || edge.id) : `${parsed.gatewayId}[${parsed.choiceIndex}]`;

    decisions.push({
      kind: 'bpmn-gateway',
      gatewayId: parsed.gatewayId,
      poolId,
      choiceIndex: parsed.choiceIndex,
      edgeId: edge ? edge.id : null,
      label,
    });
  });
  return decisions;
}

/**
 * Canonical string key for a decision sequence — two scenarios group together exactly when
 * this is identical. Deliberately keyed on `(poolId, gatewayId, label)`, not `edgeId`: the
 * label IS the human-readable identity of the choice; `edgeId` still travels on each entry
 * for anything that wants the exact edge.
 *
 * @param {ReturnType<typeof extractScenarioDecisions>} decisions
 * @returns {string}
 */
export function decisionSequenceKey(decisions) {
  return JSON.stringify(decisions.map(d => [d.poolId, d.gatewayId, d.label]));
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
 * edge whose source is an XOR/inclusive-gateway SPLIT (matching the same "only splits are
 * decision points" rule `extractScenarioDecisions` applies to transitions).
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
      && (src.type === 'exclusiveGateway' || src.type === 'inclusiveGateway')
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
 * @returns {{derived: boolean, edges: Array<object>, decisions: ReturnType<typeof extractScenarioDecisions>}}
 */
export function computeHappyPath(flatNodes, flatEdges, poolId = null) {
  const markedNodeIds = identifyHappyPathNodes(flatNodes, flatEdges);
  if (markedNodeIds.size > 0) {
    const edges = orderHappyPathEdges(flatEdges.filter(e => e.isHappyPath));
    return { derived: false, edges, decisions: decisionsFromEdgePath(edges, flatNodes, flatEdges, poolId) };
  }
  const edges = deriveHappyPathEdges(flatNodes, flatEdges);
  return { derived: true, edges, decisions: decisionsFromEdgePath(edges, flatNodes, flatEdges, poolId) };
}

// ═══════════════════════════════════════════════════════════════════════
// Part 3 — distance and sort
// ═══════════════════════════════════════════════════════════════════════

/** `(poolId, gatewayId)` → the happy path's label there, first occurrence wins. */
export function happyPathDecisionMap(happyDecisions) {
  const map = new Map();
  for (const d of happyDecisions) {
    const key = `${d.poolId ?? ''}::${d.gatewayId}`;
    if (!map.has(key)) map.set(key, d.label);
  }
  return map;
}

/**
 * Distance of one scenario's decisions from the happy path: the count of happy-path
 * gateways where this scenario chose differently OR never reached the gateway at all. See
 * the module doc for why both cases score identically.
 *
 * @param {ReturnType<typeof extractScenarioDecisions>} decisions
 * @param {Map<string, string>} happyMap - from `happyPathDecisionMap`.
 * @returns {number}
 */
export function distanceFromHappyPath(decisions, happyMap) {
  if (happyMap.size === 0) return 0;
  const scenarioMap = new Map();
  for (const d of decisions) {
    const key = `${d.poolId ?? ''}::${d.gatewayId}`;
    if (!scenarioMap.has(key)) scenarioMap.set(key, d.label);
  }
  let dist = 0;
  for (const [key, happyLabel] of happyMap) {
    if (scenarioMap.get(key) !== happyLabel) dist++;
  }
  return dist;
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

function renderDecisionLabel(d) {
  return d.poolId ? `${d.gatewayId}@${d.poolId} → ${d.label}` : `${d.gatewayId} → ${d.label}`;
}

function renderMarkdown(groups, happyPath, maxGroupsRendered) {
  const lines = [];
  lines.push('# Scenario Overview');
  lines.push('');
  lines.push(happyPath.derived
    ? '_Happy path: DERIVED — no `isHappyPath` edge was declared; this is the shortest ' +
      'start→end path excluding boundary-event and backward (cycle) edges._'
    : '_Happy path: declared via `isHappyPath` edges._');
  lines.push('');

  const rendered = groups.slice(0, maxGroupsRendered);
  for (const g of rendered) {
    const heading = g.decisions.length
      ? g.decisions.map(renderDecisionLabel).join('; ')
      : '(no decision points — single path)';
    lines.push(`## ${heading}`);
    for (const m of g.members) {
      const interleaving = m.interleavingCount > 1 ? ` (×${m.interleavingCount} interleavings)` : '';
      lines.push(`- Scenario #${m.index} — distance ${m.happyPathDistance}${interleaving}: ${m.nodes.join(' → ')}`);
    }
    lines.push('');
  }

  const omitted = groups.length - rendered.length;
  if (omitted > 0) {
    lines.push(`_${omitted} more group${omitted === 1 ? '' : 's'} not shown, see the JSON view._`);
  }
  return lines.join('\n');
}

function assemble(scenarios, decisionsFor, happyPath, options) {
  const happyMap = happyPathDecisionMap(happyPath.decisions);
  const enriched = scenarios.map(s => {
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

  return {
    json: {
      happyPath,
      scenarios: enriched,
      groupCount: groups.length,
    },
    markdown: renderMarkdown(groups, happyPath, maxGroupsRendered),
  };
}

/**
 * Format the result of `enumerateScenarios` (single process, `../scenarios/enumerate.js`)
 * into the JSON and Markdown views.
 *
 * @param {import('./enumerate.js').EnumerationResult} enumerationResult
 * @param {object} proc - the SAME process object `enumerateScenarios` was called with.
 * @param {object} [options] - `{maxGroupsRendered?, config?}`; `config` mirrors
 *   `enumerateScenarios`'s option of the same name (defaults to the loaded `CFG`).
 * @returns {{json: object, markdown: string}}
 */
export function formatScenarioResult(enumerationResult, proc, options = {}) {
  const pn = bpmnToPN(proc);
  const happyPath = computeHappyPath(pn.flatNodes, pn.flatEdges, null);
  const decisionsFor = (s) =>
    extractScenarioDecisions(s.transitions, s.transitions.map(() => null), () => pn.flatEdges);
  return assemble(enumerationResult.scenarios, decisionsFor, happyPath, options);
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
 *
 * @param {import('./collaboration.js').CollaborationEnumerationResult} collabResult
 * @param {object} lc - the SAME Logic-Core `enumerateCollaboration` was called with.
 * @param {object} [options] - as `formatScenarioResult`.
 * @returns {{json: object, markdown: string}}
 */
export function formatCollaborationResult(collabResult, lc, options = {}) {
  const pools = lc.pools || [];
  const flatEdgesByPool = new Map();
  const perPool = [];

  for (const pool of pools) {
    const pn = bpmnToPN(pool);
    flatEdgesByPool.set(pool.id, pn.flatEdges);
    const hp = computeHappyPath(pn.flatNodes, pn.flatEdges, pool.id);
    perPool.push({ poolId: pool.id, ...hp });
  }

  const happyPath = {
    derived: perPool.some(p => p.derived),
    decisions: perPool.flatMap(p => p.decisions),
    perPool,
  };

  const decisionsFor = (s) =>
    extractScenarioDecisions(s.transitions, s.poolIds, (poolId) => flatEdgesByPool.get(poolId) || []);

  return assemble(collabResult.scenarios, decisionsFor, happyPath, options);
}
