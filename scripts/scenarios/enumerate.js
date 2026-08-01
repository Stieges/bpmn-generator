/**
 * Phase A — Scenario enumeration over a single BPMN process (one pool).
 *
 * What this is for: the rule engine only ever inspects the generated Logic-Core, never
 * the text it came from, so it cannot see that an XOR should have been an AND. This
 * module does not judge anything — it lists every distinct path a token can take from
 * the start event to the end event, so a reviewer (human or LLM) can spot a missing or
 * wrong scenario in a list, where it is findable, instead of in a diagram, where it is
 * invisible.
 *
 * It reuses the existing Petri-net translation (`bpmnToPN`, workflow-net.js:49) and the
 * existing firing semantics (`getEnabledTransitions` / `fireTransition`,
 * workflow-net.js:260/273), but NOT `checkSoundness`'s traversal: that one deduplicates
 * markings (`visitedEncodings`, workflow-net.js:298/376), which is correct for "is the
 * sink reachable?" and wrong for "which distinct paths reach it?". Two things replace
 * the dedup as the termination argument:
 *
 *   1. a per-backward-edge traversal bound (see `findBackwardEdges`), and
 *   2. hard caps on scenario count and trace length, both from `config.json`.
 *
 * Scope: ONE process. Message flows between pools are deliberately not composed here —
 * `bpmnToPN` never reads `messageFlows`, and joining pools is its own piece of work.
 * Call this once per pool.
 */

import { bpmnToPN, getEnabledTransitions, fireTransition } from '../bpmn/workflow-net.js';
import { CFG } from '../shared/utils.js';

const DEFAULTS = {
  defaultCycleBound: 1,
  maxScenarios: 10_000,
  maxTraceLength: 500,
  maxInterleavingIdeals: 100_000,
};

// ═══════════════════════════════════════════════════════════════════════
// Graph cycles
// ═══════════════════════════════════════════════════════════════════════

/**
 * Find the set of backward (graph-cycle) edges of a process graph.
 *
 * DFS with on-stack colouring — the technique of `countBackEdges` (optimize.js:201-218),
 * which returns only a count, so it cannot be reused as is. Two things this must NOT be
 * confused with, both of which an earlier design draft got wrong:
 *
 *   - `sortNodesTopologically` (topology.js) is NOT a cycle detector: it is a BFS that
 *     `continue`s on an already-visited target (topology.js:62) and returns nothing.
 *   - `loopType` / `loopMaximum` (input-schema.json, `Node.loopType`) is BPMN's
 *     `standardLoopCharacteristics` — ONE activity repeating itself. A backward sequence
 *     flow spanning several nodes is a different thing entirely, and the `Edge` schema
 *     has no field for it. Nothing in here reads `loopType`.
 *
 * @param {Array<object>} nodes - flattened node list
 * @param {Array<object>} edges - flattened edge list
 * @returns {Array<object>} the edges that close a cycle, in DFS discovery order
 */
export function findBackwardEdges(nodes, edges) {
  const outMap = new Map();
  for (const e of edges) {
    if (!outMap.has(e.source)) outMap.set(e.source, []);
    outMap.get(e.source).push(e);
  }

  const ON_STACK = 1, DONE = 2;
  const state = new Map();
  const back = [];

  const dfs = (id) => {
    state.set(id, ON_STACK);
    for (const e of outMap.get(id) || []) {
      if (state.get(e.target) === ON_STACK) back.push(e);
      else if (!state.has(e.target)) dfs(e.target);
    }
    state.set(id, DONE);
  };

  // `dfs` recurses once per node, so its depth is bounded by the graph, not by
  // `maxTraceLength` the way the enumeration traversal is. Every model this has been run
  // against is orders of magnitude away from the stack limit; a genuinely huge imported
  // model would want an explicit stack here.
  const starts = nodes.filter(n => n.type === 'startEvent').map(n => n.id);
  const roots = starts.length ? starts : (nodes[0] ? [nodes[0].id] : []);
  for (const r of roots) if (!state.has(r)) dfs(r);
  // Sweep anything the start events do not reach — `countBackEdges` stops after the
  // roots. Not a correctness requirement: a component no token can reach is never fired,
  // so its cycles could not have run away either. It is defence in depth, and it makes
  // `stats.backwardEdges` an honest description of the graph rather than of the part of
  // the graph that happens to be live.
  for (const n of nodes) if (!state.has(n.id)) dfs(n.id);

  return back;
}

/**
 * The Petri-net place a sequence-flow edge becomes.
 *
 * `bpmnToPN` names one place per flattened edge, `p_${source}_${target}`
 * (workflow-net.js:66), and every later arc-building branch re-derives the id from the
 * same two fields — the XOR-split branch (workflow-net.js:117/121), the implicit-merge
 * branch (workflow-net.js:142/149) and `connectTransition` (workflow-net.js:200/207).
 * So the formula survives every transformation `bpmnToPN` applies; what changes is which
 * transition the place is wired to, never the place's name.
 *
 * @param {object} edge - {source, target}
 * @returns {string} place id
 */
export function backwardEdgePlaceId(edge) {
  return `p_${edge.source}_${edge.target}`;
}

// ═══════════════════════════════════════════════════════════════════════
// Net indices
// ═══════════════════════════════════════════════════════════════════════

function indexArcs(transitions, arcs) {
  const inputs = new Map();
  const outputs = new Map();
  for (const [tId] of transitions) {
    inputs.set(tId, []);
    outputs.set(tId, []);
  }
  for (const a of arcs) {
    if (a.type === 'P→T' && inputs.has(a.to)) inputs.get(a.to).push(a.from);
    if (a.type === 'T→P' && outputs.has(a.from)) outputs.get(a.from).push(a.to);
  }
  return { inputs, outputs };
}

/**
 * Partition enabled transitions into concurrency groups.
 *
 * Two transitions are in the same group when they share an input place, transitively.
 * Shared input place = they compete for the same token = an XOR choice, and the choice
 * is exactly the information this whole feature exists to surface, so those stay fully
 * branched. Disjoint inputs = genuinely concurrent (AND-split branches); those must not
 * each spawn their own scenario, or one parallel block turns into multinomially many
 * copies of the same scenario written in different orders.
 *
 * INVARIANT this relies on, and a warning for Task 2: under today's `bpmnToPN`, two
 * transitions either share ALL their input places or none of them — an XOR split's
 * branch transitions all consume the same set (workflow-net.js:116-119), a merge
 * transition consumes exactly one (workflow-net.js:142), and no transition mixes places
 * from different sources. With no partial overlap, transitive grouping is exact:
 * "connected in the sharing graph" and "actually competing" coincide. Composing pools
 * over message flows breaks that — a receive task would consume both a sequence-flow
 * place and a message place, so an A-B-C chain could link two transitions that do not
 * compete at all and collapse a real choice into one group. Revisit this function then;
 * do not assume it still holds.
 *
 * @returns {Array<Array<string>>} groups, each sorted by transition id, groups sorted by
 *   their first member — so the choice of which group to advance is deterministic.
 */
function groupBySharedInput(enabled, inputs) {
  const parent = new Map(enabled.map(t => [t, t]));
  const find = (t) => {
    while (parent.get(t) !== t) {
      parent.set(t, parent.get(parent.get(t)));
      t = parent.get(t);
    }
    return t;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };

  const owner = new Map(); // place id → first transition seen consuming it
  for (const t of enabled) {
    for (const p of inputs.get(t) || []) {
      if (owner.has(p)) union(owner.get(p), t);
      else owner.set(p, t);
    }
  }

  const groups = new Map();
  for (const t of enabled) {
    const r = find(t);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  }
  const result = [...groups.values()].map(g => g.slice().sort());
  result.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// Interleaving count
// ═══════════════════════════════════════════════════════════════════════

/**
 * How many firing orders would have produced this same scenario.
 *
 * The traversal follows exactly one canonical order through a parallel block; this is
 * the number it stands in for. Definition: the number of linear extensions of the
 * trace's causality order — transition j precedes i when i consumed a token j produced.
 * A trace with no concurrency has exactly one, three independent branches of one task
 * each have 3! = 6.
 *
 * Computed by the standard dynamic program over downward-closed subsets (ideals):
 * f(∅) = 1, f(S) = Σ f(S \ {m}) over the maximal elements m of S. Cheap on the shape
 * traces actually have (a chain has n+1 ideals); capped by `maxInterleavingIdeals` so a
 * pathologically concurrent net cannot hang the run — over the cap it returns null
 * rather than a wrong number.
 *
 * @returns {number|null} null when the trace exceeded the ideal cap
 */
function countLinearExtensions(trace, inputs, outputs, initialMarking, idealCap) {
  const n = trace.length;
  if (n === 0) return 1;

  // Causality: for each consumed token, which step produced it (-1 = initial marking).
  const producers = new Map(); // place id → stack of step indices
  for (const [pid, tokens] of initialMarking) {
    if (tokens > 0) producers.set(pid, Array(tokens).fill(-1));
  }
  const preds = trace.map(() => new Set());
  for (let i = 0; i < n; i++) {
    for (const p of inputs.get(trace[i]) || []) {
      const stack = producers.get(p);
      const j = stack && stack.length ? stack.pop() : -1;
      if (j >= 0) preds[i].add(j);
    }
    for (const p of outputs.get(trace[i]) || []) {
      if (!producers.has(p)) producers.set(p, []);
      producers.get(p).push(i);
    }
  }

  // Transitive closure, then successors — needed to test maximality inside an ideal.
  const anc = trace.map(() => new Set());
  for (let i = 0; i < n; i++) {
    for (const j of preds[i]) {
      anc[i].add(j);
      for (const a of anc[j]) anc[i].add(a);
    }
  }
  const succMask = new Array(n).fill(0n);
  for (let i = 0; i < n; i++) for (const j of anc[i]) succMask[j] |= 1n << BigInt(i);

  const memo = new Map();
  let overCap = false;
  const f = (mask) => {
    if (mask === 0n) return 1;
    const key = mask.toString(36);
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    if (memo.size >= idealCap) { overCap = true; return 0; }
    let total = 0;
    for (let i = 0; i < n; i++) {
      const bit = 1n << BigInt(i);
      if (!(mask & bit)) continue;
      if (succMask[i] & mask) continue; // not maximal in this ideal
      total += f(mask & ~bit);
      if (overCap) return 0;
    }
    memo.set(key, total);
    return total;
  };

  const all = (1n << BigInt(n)) - 1n;
  const value = f(all);
  return overCap ? null : value;
}

// ═══════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════

/**
 * A single enumerated execution scenario.
 *
 * @typedef {object} Scenario
 * @property {number} index - position in `scenarios`, 0-based; the enumeration order is
 *   deterministic for a given input and set of options.
 * @property {string[]} transitions - Petri-net transition ids in canonical firing order.
 *   Note these are net ids, not BPMN ids: an XOR split contributes `t_<gw>_choice_<i>`
 *   (workflow-net.js:112) and a node with several incoming flows `t_<node>_merge_<i>`
 *   (workflow-net.js:138), so the id says which branch was taken.
 * @property {string[]} nodes - the BPMN node id behind each entry of `transitions`, same
 *   length and order. Consecutive duplicates are possible (a node can fire more than
 *   once across a loop).
 * @property {number|null} interleavingCount - how many firing orders of the same
 *   transitions would have produced this same scenario; 1 when the scenario is fully
 *   sequential. null when the count exceeded `maxInterleavingIdeals` (never guessed).
 * @property {Object<string, number>} cycleUseCounts - one entry per backward-edge place
 *   of this process (so the key set is the same for every scenario), value = how often
 *   this scenario traversed it. Always ≤ the applied cycle bound.
 */

/**
 * The result of enumerating one process.
 *
 * @typedef {object} EnumerationResult
 * @property {string|undefined} processId - `proc.id`, passed through unchanged.
 * @property {Scenario[]} scenarios
 * @property {boolean} truncated - true when a cap actually suppressed something, so
 *   `scenarios` is a prefix and not the complete set. A run that finds fewer scenarios
 *   than `maxScenarios` allows is never flagged, however much state it walked to get
 *   there. Never silently false either.
 * @property {object} stats
 * @property {Array<{id, source, target, placeId}>} stats.backwardEdges - the detected
 *   graph cycles and the places they map to.
 * @property {number} stats.cycleBound - the bound actually applied.
 * @property {number} stats.scenarioCount - `scenarios.length`.
 * @property {number} stats.cappedPaths - how many branch continuations were not followed
 *   because taking them would have exceeded the cycle bound. Counted per suppressed
 *   branch, not only when the bound emptied a whole state: a back edge starting at the
 *   gateway itself is one alternative among several, and the suppression has to show up
 *   anyway. These are NOT dead ends and NOT a soundness finding — the path exists in the
 *   model, it was simply not explored. A later judging layer must be able to tell them
 *   from the next field, which is why they are counted apart.
 * @property {number} stats.deadEndPaths - partial paths that reached a marking with no
 *   enabled transition at all (before any capping) and no token on the sink. Reported as
 *   a number, without judgement — WF03 in `workflow-net.js` is where deadlocks get called
 *   deadlocks.
 * @property {number} stats.lengthTruncatedPaths - paths abandoned at `maxTraceLength`.
 * @property {number} stats.statesExplored
 * @property {string[]} stats.orGateways - inclusive gateways in this process, passed
 *   through from `pn.orGateways`. **Read this before treating the scenario list as
 *   complete.** `bpmnToPN` models an OR split as a forced AND (workflow-net.js:90-92 —
 *   it records the id and then builds the ordinary transition, which fires every
 *   branch), so an OR split with two branches yields one scenario where the semantics
 *   allow three: x only, y only, both. That is a limitation of the existing translation,
 *   not something this module fixes; it is surfaced so a consumer cannot mistake the
 *   under-enumeration for the whole truth.
 * @property {Array<{id, reason}>} stats.skipped - passed through from `pn.skipped`:
 *   artifacts (no control-flow role, harmless here) and `eventBasedGateway`, whose race
 *   semantics are not modelled at all (workflow-net.js:95-101). Same warning as above.
 */

/**
 * Enumerate every distinct execution scenario of ONE process.
 *
 * @param {object} proc - a Logic-Core process/pool ({nodes, edges, ...}); for a
 *   multi-pool document call this once per entry of `lc.pools`.
 * @param {object} [options]
 * @param {number} [options.cycleBound] - how often a single backward edge may be
 *   traversed within one path. Counted per backward edge, not globally. A path that
 *   would exceed it is discarded whole — not shortened, not reported. Default:
 *   `config.json → scenarios.defaultCycleBound`.
 * @param {number} [options.maxScenarios] - global cap; on reaching it the result is
 *   flagged `truncated`.
 * @param {number} [options.maxTraceLength] - safety cap on a single path's length.
 * @param {number} [options.maxInterleavingIdeals] - cap for the interleaving count.
 * @param {object} [options.config] - config object to read the `scenarios` block from;
 *   defaults to the loaded `CFG`.
 * @returns {EnumerationResult}
 */
export function enumerateScenarios(proc, options = {}) {
  const cfg = { ...DEFAULTS, ...(((options.config || CFG) || {}).scenarios || {}) };
  const cycleBound = options.cycleBound ?? cfg.defaultCycleBound;
  const maxScenarios = options.maxScenarios ?? cfg.maxScenarios;
  const maxTraceLength = options.maxTraceLength ?? cfg.maxTraceLength;
  const idealCap = options.maxInterleavingIdeals ?? cfg.maxInterleavingIdeals;

  const pn = bpmnToPN(proc);
  const { transitions, arcs, initialMarking, sinkPlace } = pn;

  // Cycles are found on the very arrays bpmnToPN named its places from, not on a second
  // flatten of the same input — a backward edge inside an expanded subprocess is a
  // backward edge of the net, and identity beats agreement here.
  const backEdges = findBackwardEdges(pn.flatNodes, pn.flatEdges);

  const { inputs, outputs } = indexArcs(transitions, arcs);

  const cappedPlaces = new Map(); // place id → the backward edge it came from
  for (const e of backEdges) cappedPlaces.set(backwardEdgePlaceId(e), e);

  const scenarios = [];
  let truncated = false;
  let cappedPaths = 0;
  let deadEndPaths = 0;
  let lengthTruncatedPaths = 0;
  let statesExplored = 0;

  const zeroCounts = () => {
    const m = new Map();
    for (const p of cappedPlaces.keys()) m.set(p, 0);
    return m;
  };

  const record = (trace, counts) => {
    // The cap is checked here and nowhere else. Checking it on entering a state instead
    // would flag runs that had states left to visit but no scenarios left to find, and
    // `truncated` has to mean "something was actually cut", or it is worthless.
    if (scenarios.length >= maxScenarios) { truncated = true; return; }
    scenarios.push({
      index: scenarios.length,
      transitions: [...trace],
      nodes: trace.map(t => transitions.get(t)?.bpmnNodeId ?? t),
      interleavingCount: countLinearExtensions(trace, inputs, outputs, initialMarking, idealCap),
      cycleUseCounts: Object.fromEntries(counts),
    });
  };

  const walk = (marking, trace, counts) => {
    if (truncated) return;
    statesExplored++;

    if (trace.length >= maxTraceLength) {
      lengthTruncatedPaths++;
      truncated = true;
      return;
    }

    const enabled = getEnabledTransitions(marking, transitions, arcs).slice().sort();

    // Cycle bound: a transition that would push one of its output places past the bound
    // is not eligible in THIS path. Nothing about the model changes — only this path.
    const eligible = enabled.filter(t =>
      (outputs.get(t) || []).every(p => !cappedPlaces.has(p) || (counts.get(p) || 0) + 1 <= cycleBound)
    );
    // Count every branch the bound suppressed, not only the case where it emptied the
    // whole set. A back edge that starts at the gateway itself (gw →No→ task) is one of
    // several competing alternatives, so the state stays alive and the suppression would
    // otherwise be invisible — a path the model has, dropped with no accounting.
    cappedPaths += enabled.length - eligible.length;

    if (eligible.length > 0) {
      // Advance exactly one concurrency group. Deferring the others loses nothing: their
      // input places are disjoint from this group's, so firing here cannot disable them —
      // they stay enabled and get their turn. What it does lose is the redundant copies of
      // this scenario in every other interleaving, which is the point (see A1).
      const group = groupBySharedInput(eligible, inputs)[0];

      for (const tId of group) {
        const nextMarking = fireTransition(marking, tId, arcs);
        const nextCounts = new Map(counts);
        for (const p of outputs.get(tId) || []) {
          if (cappedPlaces.has(p)) nextCounts.set(p, (nextCounts.get(p) || 0) + 1);
        }
        trace.push(tId);
        walk(nextMarking, trace, nextCounts);
        trace.pop();
        if (truncated) return;
      }
      return;
    }

    // Nothing left to fire: this is where the path ends, and only here.
    //
    // Reaching the sink is deliberately NOT the stop condition. `bpmnToPN` wires every
    // end event to one shared `p_sink` (workflow-net.js:161/181), so with an AND split
    // whose branches finish at different end events, the first branch to arrive would end
    // the trace and the second would never be recorded — a wrong enumeration handed over
    // as a complete one, in a subsystem whose entire purpose is that the reviewer can see
    // what is missing. Draining the net first costs nothing on a single-end process (the
    // marking after the end event holds only the sink token anyway) and is the difference
    // between right and wrong on a multi-end one.
    if ((marking.get(sinkPlace) || 0) >= 1) { record(trace, counts); return; }

    // Not at the sink either. If the bound took the last option away, the increment above
    // already accounts for it — this path was capped, not deadlocked. Only a state that
    // had nothing on offer in the first place is a dead end.
    if (enabled.length === 0) deadEndPaths++;
  };

  walk(initialMarking, [], zeroCounts());

  return {
    processId: proc.id,
    scenarios,
    truncated,
    stats: {
      backwardEdges: backEdges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        placeId: backwardEdgePlaceId(e),
      })),
      cycleBound,
      scenarioCount: scenarios.length,
      cappedPaths,
      deadEndPaths,
      lengthTruncatedPaths,
      statesExplored,
      orGateways: [...pn.orGateways],
      skipped: pn.skipped.map(s => ({ ...s })),
    },
  };
}
