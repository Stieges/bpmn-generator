/**
 * Phase A2 — scenario enumeration across pools: message flows as synchronisation.
 *
 * `enumerate.js` enumerates ONE process. A collaboration's interesting failure class is
 * exactly the one a per-pool view cannot see: a receive that waits for a message nobody
 * ever sends. This module composes the per-pool Petri nets into one net and runs the same
 * traversal (`enumerateNet`, enumerate.js) over the result, so a joint scenario lists the
 * steps of all pools in an order that respects send-before-receive.
 *
 * ── What is deliberately NOT done here ────────────────────────────────────────────────
 * `bpmnToPN` (workflow-net.js:49) is called once per pool and is **not modified**. It is
 * also what `checkWorkflowNetSoundness` (workflow-net.js:477-495) calls per pool for
 * WF01-WF03; teaching it about `messageFlows` would change every collaboration's
 * soundness verdict as a side effect of a feature that is not about soundness. Everything
 * below therefore operates on `bpmnToPN`'s OUTPUT.
 *
 * ── Namespacing: why every place and transition gets a pool prefix ────────────────────
 * `bpmnToPN` names its source and sink `p_source` / `p_sink` (workflow-net.js:75-78) —
 * the same two ids in every pool's net. Merging the nets as they come would silently fuse
 * five pools' sources into one place holding one token, i.e. only one pool could ever
 * start. So every place and transition id is prefixed with `${pool.id}::` on the way in.
 * Trace entries and `cycleUseCounts` keys carry that prefix; `Scenario.nodes` does not —
 * it stays BPMN node ids, exactly as in the single-process contract.
 *
 * ── Black-box participants: the decision ──────────────────────────────────────────────
 * A `collapsedPools` entry has no internal process and therefore no transition. Two
 * codings were on the table (see the task brief): seed the message place with one initial
 * token, or never gate on it at all. **Chosen: never gate.** A message flow whose SOURCE
 * is a black box adds no input requirement to the receiving transitions — the environment
 * is treated as always able to deliver. Seeding one token is the same thing exactly once
 * and an artificial cap from the second time on: a receive inside a loop, or a second
 * receive of the same conversation, would deadlock for no reason in the model. Since the
 * black box is unobservable anyway, "it answers whenever asked" is the only assumption
 * that adds no claim the model does not make. These flows are reported by id in
 * `stats.ungatedMessageFlows`, so a consumer can see which orderings were NOT enforced.
 * The other direction needs nothing: a message flow whose TARGET is a black box gets its
 * place and its producing arc, and the token simply stays there — an unconsumed token
 * blocks nothing, and `Scenario.residualPlaces` names it rather than hiding it.
 *
 * ── Several message flows into one node ───────────────────────────────────────────────
 * Not anticipated by the plan, and unavoidable here: `realistic-collaboration.json`'s
 * `ap_wait` is the target of BOTH `mf6` (decision) and `mf8` (reminder). Requiring both
 * tokens is Petri-net AND semantics and is wrong for BPMN — a receive task consumes ONE
 * message — and it would deadlock this fixture outright, because `mf8`'s sender hangs off
 * a boundary timer that `bpmnToPN` leaves unfireable. So a node gated by k > 1 message
 * flows is split into one transition per gating flow, the same device `bpmnToPN` itself
 * uses for an implicit merge (workflow-net.js:136-165): id `${tId}__recv_${mfId}`, same
 * `bpmnNodeId`, same sequence-flow inputs and outputs, one message place each. Which
 * message a scenario arrived on is then readable off the trace.
 */

import { bpmnToPN, fireTransition } from '../bpmn/workflow-net.js';
import {
  enumerateNet, resolveLimits, findBackwardEdges, backwardEdgePlaceId,
} from './enumerate.js';

const SEP = '::';

/** Prefixed id of a per-pool place or transition inside the composed net. */
export function scopedId(poolId, localId) {
  return `${poolId}${SEP}${localId}`;
}

/** The place a message flow becomes. Cannot collide with `p_${src}_${tgt}` or a prefix. */
export function messagePlaceId(messageFlowId) {
  return `pmsg_${messageFlowId}`;
}

/**
 * Every transition of `pn` that stands for `nodeId`.
 *
 * Not 1:1 on purpose: an XOR split contributes one transition per outgoing edge
 * (workflow-net.js:111-122) and an implicit merge one per incoming edge
 * (workflow-net.js:136-165). A message arc has to apply to ALL of them — any one of them
 * firing IS that node executing.
 *
 * Since Stage 1 a CONTAINER also has more than one, and for a different reason: `bpmnToPN`
 * refines a subprocess into a subnet whose boundary is an entry/exit pair
 * (workflow-net.js:382-418) — `t_C#enter` (or one `t_C#enter#i` per incoming edge) and
 * `t_C#exit`, all carrying the container's `bpmnNodeId`. Those two are not alternatives, they
 * are the two ENDS of one execution, so the "any one of them firing IS that node executing"
 * reading above does not hold for them. That is why `composeCollaboration` never routes a
 * container id through here for message-flow wiring — see the `'container'` branch in
 * `resolve()`.
 *
 * @param {object} pn - a net from `bpmnToPN`
 * @param {string} nodeId
 * @returns {string[]} local (unprefixed) transition ids, in insertion order
 */
export function transitionsForNode(pn, nodeId) {
  const out = [];
  for (const [tId, t] of pn.transitions) if (t.bpmnNodeId === nodeId) out.push(tId);
  return out;
}

/**
 * The composed net plus everything a caller needs to interpret it.
 *
 * @typedef {object} ComposedNet
 * @property {Map<string, object>} transitions - id → {id, label, bpmnNodeId, poolId,
 *   messageFlowId?} (the last one only on a receive transition split per message flow).
 * @property {Array<object>} arcs - `{from, to, type}`, exactly `bpmnToPN`'s shape.
 * @property {Map<string, number>} initialMarking - one token on every real pool's source.
 * @property {Map<string, object>} places
 * @property {Array<object>} pools - `{poolId, sourcePlace, sinkPlace, backwardEdges}`,
 *   one per REAL pool, place ids already prefixed.
 * @property {string[]} collapsedPoolIds
 * @property {Map<string, object>} cappedPlaces - union of every pool's backward-edge
 *   places, value `{poolId, edge}`.
 * @property {Array<object>} messagePlaces - one per wired message flow:
 *   `{messageFlowId, placeId, senderTransitions, receiverTransitions, senderIsBlackBox,
 *   receiverIsBlackBox, senderKind, receiverKind, gates}`. The two `*Kind` fields are
 *   `resolve()`'s verdict verbatim — `'node' | 'blackBox' | 'container' | 'unresolved'`.
 * @property {string[]} unconsumablePlaces - message places no transition consumes.
 * @property {Array<object>} unresolved - message flows an endpoint could not be resolved
 *   for: `{messageFlowId, endpoint: 'source'|'target', id, reason}`, where `reason` is
 *   `'unknownId'` (names nothing in the model) or `'container'` (names a subprocess, which
 *   is not a valid MessageFlow endpoint — see `resolve()`). Reported, never thrown.
 */

/**
 * Compose one Petri net out of all pools of a Logic-Core collaboration.
 *
 * @param {object} lc - Logic-Core with `pools` (and optionally `collapsedPools`,
 *   `messageFlows`). A single-process document (no `pools`) is accepted and composes to
 *   exactly one pool, so callers do not need a special case.
 * @returns {ComposedNet}
 */
export function composeCollaboration(lc) {
  const pools = lc.pools ? lc.pools : [lc];
  const collapsedPoolIds = (lc.collapsedPools || []).map(p => p.id);
  const collapsed = new Set(collapsedPoolIds);
  const messageFlows = lc.messageFlows || [];

  const places = new Map();
  const transitions = new Map();
  let arcs = [];
  const initialMarking = new Map();
  const cappedPlaces = new Map();
  const poolInfos = [];
  // BPMN node id → [{poolId, transitionIds (prefixed)}]. A node id is expected to be
  // unique across pools; if it is not, every match is wired, which is the only reading
  // that cannot silently drop a synchronisation.
  const nodeOwners = new Map();
  // Container nodes, across all pools. Kept apart from `nodeOwners` because a container is not
  // a legal message-flow endpoint at all (see `resolve()`), so the question is never "which
  // transitions" but "is this an endpoint we must refuse".
  const containerIds = new Set();

  // A pool without an `id` still needs one to scope its places with. Generated rather
  // than assumed free: `pool_0` is a legal pool id, and colliding with a real one would
  // fuse two pools' sources into a single place — the exact defect the scoping prevents.
  const declaredIds = new Set(pools.map(p => p.id).filter(Boolean));
  const freshPoolId = (i) => {
    let candidate = `pool_${i}`;
    while (declaredIds.has(candidate)) candidate = `_${candidate}`;
    declaredIds.add(candidate);
    return candidate;
  };

  for (const pool of pools) {
    const poolId = pool.id || freshPoolId(poolInfos.length);
    const pn = bpmnToPN(pool);

    for (const [pid, p] of pn.places) {
      const sid = scopedId(poolId, pid);
      places.set(sid, { ...p, id: sid, poolId });
      initialMarking.set(sid, pn.initialMarking.get(pid) || 0);
    }
    for (const [tId, t] of pn.transitions) {
      const sid = scopedId(poolId, tId);
      transitions.set(sid, { ...t, id: sid, poolId });
    }
    for (const a of pn.arcs) {
      arcs.push({ from: scopedId(poolId, a.from), to: scopedId(poolId, a.to), type: a.type });
    }

    // Cycle bounds stay per pool: message flows are in neither `flatNodes` nor
    // `flatEdges`, so they cannot participate in a pool's own graph cycles, and they
    // cannot create new ones either (see the module-level note in the report).
    const backEdges = findBackwardEdges(pn.flatNodes, pn.flatEdges);
    for (const e of backEdges) {
      cappedPlaces.set(scopedId(poolId, backwardEdgePlaceId(e)), { poolId, edge: e });
    }

    for (const n of pn.flatNodes) {
      // `bpmnToPN`'s own container predicate, by the same criterion (workflow-net.js:128) —
      // a node with children is a subnet, not a transition. Recorded whether or not the
      // container was actually refined: the fallback path (no inner start/end) gives it a
      // single transition and so would wire cleanly, but the reason to refuse is the class,
      // not the translation. See `resolve()`.
      if (Array.isArray(n.nodes) && n.nodes.length > 0) containerIds.add(n.id);
      const tIds = transitionsForNode(pn, n.id).map(t => scopedId(poolId, t));
      if (!tIds.length) continue;
      if (!nodeOwners.has(n.id)) nodeOwners.set(n.id, []);
      nodeOwners.get(n.id).push({ poolId, transitionIds: tIds });
    }

    poolInfos.push({
      poolId,
      sourcePlace: scopedId(poolId, pn.sourcePlace),
      sinkPlace: scopedId(poolId, pn.sinkPlace),
      backwardEdges: backEdges.map(e => ({
        id: e.id, source: e.source, target: e.target,
        placeId: scopedId(poolId, backwardEdgePlaceId(e)),
      })),
      orGateways: [...pn.orGateways],
      skipped: pn.skipped.map(s => ({ ...s })),
    });
  }

  // ── Why a container endpoint resolves to NOTHING ────────────────────────────────────────
  // A message flow naming a subprocess is not an under-modelled legal shape, it is a schema
  // violation: `MessageFlow.sourceRef`/`targetRef` are typed `InteractionNode`
  // (BPMN20.cmof:851-852). `Task` (:1191) and `Event` (:287) are InteractionNodes by an
  // explicit second superclass and `Participant` (:863) likewise, but `Activity` is
  // `superClass="FlowNode"` alone (:1095), and `SubProcess` (:1147), `CallActivity` (:1188),
  // `AdHocSubProcess` (:1222) and `Transaction` (:1233) all inherit from it. S14
  // (`scripts/bpmn/rules.js`) is where the author hears about it.
  //
  // Given that, neither of the container's two transitions is the right attach point, and this
  // branch has to come BEFORE the `nodeOwners` lookup or one of two wrong things happens:
  //   - wiring both (what the plain `nodeOwners` path does since Stage 1 put the container in
  //     `flatNodes`) makes a container-as-source push a `T→P` arc into `pmsg_<mf>` from BOTH
  //     `t_C#enter` and `t_C#exit` — the message is sent twice, from a model that says nothing
  //     of the kind — and flips `gates` to `true` for a container-as-target, hanging consuming
  //     arcs on both ends of the subnet;
  //   - picking one invents a reading the standard does not offer. "Source → exit" and
  //     "target → entry" are each defensible in isolation, and neither is what the model says.
  // Refusing is the only answer that adds no claim. It is also not a dead end for the author:
  // the remedy always exists one level down — a send/receive task or a message start/end event
  // inside the subprocess — which is exactly what S14's message names.
  const resolve = (id) => {
    if (containerIds.has(id)) return { kind: 'container', transitionIds: [] };
    const owners = nodeOwners.get(id);
    if (owners) return { kind: 'node', transitionIds: owners.flatMap(o => o.transitionIds) };
    if (collapsed.has(id)) return { kind: 'blackBox', transitionIds: [] };
    return { kind: 'unresolved', transitionIds: [] };
  };

  const messagePlaces = [];
  const unresolved = [];
  // Pass 1 — the place itself and the producing arcs.
  for (const mf of messageFlows) {
    const src = resolve(mf.source);
    const tgt = resolve(mf.target);
    // Both kinds land on `unresolved[]`, because from the net's point of view they are the same
    // fact — this endpoint wires to no transition — but they are NOT the same defect, so the
    // `reason` travels with them. `'unknownId'` names nothing in the model; `'container'` names
    // something real that may not be named here. A reader told only "could not be mapped" would
    // go looking for a missing node in the second case.
    const record = (endpoint, id, kind) => {
      if (kind === 'unresolved') unresolved.push({ messageFlowId: mf.id, endpoint, id, reason: 'unknownId' });
      else if (kind === 'container') unresolved.push({ messageFlowId: mf.id, endpoint, id, reason: 'container' });
    };
    record('source', mf.source, src.kind);
    record('target', mf.target, tgt.kind);

    const placeId = messagePlaceId(mf.id);
    places.set(placeId, { id: placeId, label: mf.name || '', messageFlowId: mf.id });
    initialMarking.set(placeId, 0);

    for (const t of src.transitionIds) arcs.push({ from: t, to: placeId, type: 'T→P' });

    messagePlaces.push({
      messageFlowId: mf.id,
      placeId,
      senderTransitions: src.transitionIds,
      receiverTransitions: tgt.transitionIds,
      senderIsBlackBox: src.kind === 'blackBox',
      receiverIsBlackBox: tgt.kind === 'blackBox',
      // The raw `resolve()` verdicts, kept rather than collapsed into the two booleans above.
      // `senderIsBlackBox === false` used to mean "a real node", and since the `'container'` and
      // `'unresolved'` kinds exist it does not — anything deriving from the booleans alone would
      // report a failure to map as a deliberate black box.
      senderKind: src.kind,
      receiverKind: tgt.kind,
      // "gates" = does this flow actually constrain the receiver? Only a real sender does;
      // a black-box sender is the always-available environment (module header). This already
      // yields `false` for `'container'` and `'unresolved'` without a change — both compare
      // unequal to `'node'` — which is checked rather than assumed in `collaboration.test.js`.
      gates: src.kind === 'node' && tgt.kind === 'node',
    });
  }

  // Pass 2/3 — the consuming side. Grouped by receiving node, because a node gated by
  // more than one flow is split rather than AND-joined (module header).
  const gatingByTransition = new Map();
  for (const mp of messagePlaces) {
    if (!mp.gates) continue;
    for (const t of mp.receiverTransitions) {
      if (!gatingByTransition.has(t)) gatingByTransition.set(t, []);
      gatingByTransition.get(t).push(mp);
    }
  }

  for (const [tId, gating] of gatingByTransition) {
    if (gating.length === 1) {
      arcs.push({ from: gating[0].placeId, to: tId, type: 'P→T' });
      continue;
    }
    const base = transitions.get(tId);
    const inArcs = arcs.filter(a => a.type === 'P→T' && a.to === tId);
    const outArcs = arcs.filter(a => a.type === 'T→P' && a.from === tId);
    const cloneIds = [];
    for (const mp of gating) {
      const cloneId = `${tId}__recv_${mp.messageFlowId}`;
      cloneIds.push(cloneId);
      transitions.set(cloneId, { ...base, id: cloneId, messageFlowId: mp.messageFlowId });
      for (const a of inArcs) arcs.push({ from: a.from, to: cloneId, type: 'P→T' });
      arcs.push({ from: mp.placeId, to: cloneId, type: 'P→T' });
      for (const a of outArcs) arcs.push({ from: cloneId, to: a.to, type: 'T→P' });
      mp.receiverTransitions = mp.receiverTransitions.map(t => (t === tId ? cloneId : t));
    }
    transitions.delete(tId);
    arcs = arcs.filter(a => a.to !== tId && a.from !== tId);

    // The id `tId` no longer exists in the net, so EVERY record still naming it is now a
    // dangling reference — not only the gated receiver entries remapped above. A split
    // node that also SENDS a flow, or that receives a second, ungated one, kept the
    // pre-split id and a consumer correlating it against a trace would conclude the
    // message was never sent, while `messagesSent` (built from the arcs) says it was:
    // two contradicting answers in one result object. On these sides the id expands to
    // ALL clones — any clone firing IS that node executing — unlike a gated receiver,
    // which maps to the one clone that consumes its own message.
    for (const mp of messagePlaces) {
      mp.senderTransitions = mp.senderTransitions.flatMap(t => (t === tId ? cloneIds : [t]));
      mp.receiverTransitions = mp.receiverTransitions.flatMap(t => (t === tId ? cloneIds : [t]));
    }
  }

  const consumed = new Set(arcs.filter(a => a.type === 'P→T').map(a => a.from));
  const unconsumablePlaces = messagePlaces
    .map(mp => mp.placeId)
    .filter(p => !consumed.has(p));

  return {
    places, transitions, arcs, initialMarking,
    pools: poolInfos, collapsedPoolIds, cappedPlaces,
    messagePlaces, unconsumablePlaces, unresolved,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════

/**
 * One joint execution scenario across all pools.
 *
 * Extends `Scenario` (enumerate.js) — every field there is present with the same meaning;
 * three are added. A consumer written against the single-process shape keeps working, it
 * just does not read the new fields.
 *
 * @typedef {object} CompositeScenario
 * @property {number} index - as `Scenario.index`.
 * @property {string[]} transitions - composed-net transition ids in canonical firing
 *   order. **Prefixed**: `${poolId}::${localTransitionId}`, and a receive split per
 *   incoming message flow additionally carries `__recv_${messageFlowId}` (see the module
 *   header). The local part is exactly what the single-process enumerator would emit.
 * @property {string[]} nodes - the BPMN node id behind each entry, same length and order,
 *   unprefixed — identical in meaning to `Scenario.nodes`.
 * @property {string[]} poolIds - the pool each entry belongs to, same length and order.
 *   A parallel array rather than a richer entry object: `nodes` and `transitions` are
 *   already parallel arrays, and later phases (output formatting, judging) want to slice
 *   one pool's steps out of a joint trace without rewriting the two arrays they already
 *   read.
 * @property {number|null} interleavingCount - as `Scenario.interleavingCount`; across
 *   pools it now also counts the orders in which independent pools could have run.
 * @property {Object<string, number>} cycleUseCounts - as `Scenario.cycleUseCounts`, keys
 *   prefixed with the owning pool.
 * @property {string[]} messagesSent - message flow ids whose place received a token in
 *   this scenario, in the order they were produced.
 * @property {string[]} messagesReceived - message flow ids this scenario consumed, in
 *   order. A flow in `messagesSent` but not here was sent and never picked up — either to
 *   a black box, or a genuine loose end worth showing. **An ungated flow never appears
 *   here at all**, because nothing consumes its place: the receive happened, it was simply
 *   not synchronised. `stats.ungatedMessageFlows` lists which ones those are.
 * @property {string[]} residualPlaces - places still holding a token when the net ran dry,
 *   **excluding the pool sinks** — see `sinkTokens` for those. Normally the message places
 *   nothing consumes; anything else here is a stranded token, which is WF03's to call a
 *   deadlock, not this module's.
 * @property {Object<string, number>} sinkTokens - tokens on each real pool's sink at the
 *   end, one entry per pool, normally all 1. **More than 1 is improper completion**:
 *   `bpmnToPN` wires every end event to the same sink (workflow-net.js:161/181), so an AND
 *   fork ending at two end events leaves 2 there. Reported because `residualPlaces` skips
 *   the sinks and would otherwise make that case read as a clean finish. Still no verdict
 *   — WF03 is where improper completion gets named.
 *
 * A caveat this shape inherits from the traversal, carried forward for anyone COUNTING
 * scenarios: in a composed net `groupBySharedInput`'s grouping can be coarser than the
 * true conflict set (see its JSDoc in enumerate.js), so two scenarios could in principle
 * describe the same execution in two different orders. No construction has been found
 * that makes it happen, and none has been proven impossible either; nothing is ever lost,
 * only possibly repeated.
 */

/**
 * The result of enumerating a collaboration.
 *
 * Mirrors `EnumerationResult` (enumerate.js) field for field, with `processId` replaced —
 * there is no single process — and the message-flow bookkeeping added.
 *
 * @typedef {object} CollaborationEnumerationResult
 * @property {string[]} poolIds - the REAL pools, in document order.
 * @property {string[]} collapsedPoolIds - black-box participants, from `lc.collapsedPools`.
 * @property {CompositeScenario[]} scenarios
 * @property {boolean} truncated - as `EnumerationResult.truncated`.
 * @property {object} stats - every field of `EnumerationResult.stats`, plus:
 * @property {Array<object>} stats.backwardEdges - as before, each additionally carrying
 *   `poolId`; `placeId` is prefixed.
 * @property {Array<object>} stats.orGateways - `{poolId, nodeId}` instead of a bare id,
 *   because two pools can both have one. Same warning as in the single-process contract:
 *   an OR split is fired as an AND, so the list is an under-enumeration marker.
 * @property {Array<object>} stats.skipped - `{poolId, id, reason}`.
 * @property {Array<object>} stats.messageFlows - one per flow: `{id, placeId, gates,
 *   senderIsBlackBox, receiverIsBlackBox, ungatedReason, senderTransitions,
 *   receiverTransitions}`. `ungatedReason` is `null` when the flow gates, and otherwise
 *   `'blackBox'` (a deliberate modelling choice — see the module header) or
 *   `'unmappedEndpoint'` (an endpoint that could not be mapped: a container or an unknown
 *   id, both listed in `unresolvedEndpoints` — a defect, not a choice).
 * @property {string[]} stats.ungatedMessageFlows - flows that enforce NO ordering: sent by a
 *   black box (nothing produces the token, and by the decision above nothing waits for it),
 *   received by one (nothing consumes it), or with an endpoint that could not be mapped at
 *   all. **Read this before trusting the joint order** — for these, the two ends are not
 *   synchronised at all. `stats.messageFlows[].ungatedReason` tells the three apart.
 * @property {string[]} stats.unconsumedMessagePlaces - message places no transition can
 *   ever consume: every ungated flow qualifies, whether because its receiver is a black
 *   box or because its black-box SENDER means no consuming arc was added (`mf4` in
 *   `realistic-collaboration.json` is the second kind — its receiver is a real node).
 * @property {Array<object>} stats.unresolvedEndpoints - message flow endpoints this
 *   module could not map to a transition, each carrying a `reason`. `'unknownId'`: an id
 *   matching no node and no collapsed pool (malformed), but also the legal shape of
 *   addressing an expanded participant by its POOL id rather than by a node inside it,
 *   which is simply not handled. `'container'`: an id naming a subprocess, which is not a
 *   valid MessageFlow endpoint at all (`resolve()`, and S14 in `scripts/bpmn/rules.js`).
 *   Never thrown, always reported — such a flow synchronises nothing.
 * @property {number} stats.deadEndPaths - includes genuine CROSS-POOL deadlocks: a path
 *   where one pool's branch means a message is never sent and the partner waits forever.
 *   Deliberately not a separate category — the accounting is the same as Task 1's, and
 *   `stats.messageFlows` plus the trace say which message was missing.
 */

/**
 * Enumerate the joint scenarios of a multi-pool collaboration.
 *
 * A joint scenario is complete when EVERY real pool's own sink holds a token and the net
 * has run dry (no transition enabled) — the cross-pool generalisation of the single
 * process rule that draining beats "the sink was touched". Tokens may remain in message
 * places nobody consumes; those are listed per scenario in `residualPlaces` instead of
 * disqualifying an otherwise finished run, because a message sent to a black box is not
 * an unfinished process.
 *
 * @param {object} lc - Logic-Core collaboration.
 * @param {object} [options] - identical to `enumerateScenarios`'s options.
 * @returns {CollaborationEnumerationResult}
 */
export function enumerateCollaboration(lc, options = {}) {
  const limits = resolveLimits(options);
  const net = composeCollaboration(lc);

  const sinkPlaces = net.pools.map(p => p.sinkPlace);
  const run = enumerateNet({
    transitions: net.transitions,
    arcs: net.arcs,
    initialMarking: net.initialMarking,
    cappedPlaces: net.cappedPlaces,
    isComplete: (marking) => sinkPlaces.every(p => (marking.get(p) || 0) >= 1),
  }, limits);

  const placeByMessage = new Map(net.messagePlaces.map(mp => [mp.placeId, mp.messageFlowId]));
  const produces = new Map();  // transition id → message flow ids it puts a token on
  const consumes = new Map();
  for (const a of net.arcs) {
    const mfId = placeByMessage.get(a.type === 'T→P' ? a.to : a.from);
    if (!mfId) continue;
    const map = a.type === 'T→P' ? produces : consumes;
    const key = a.type === 'T→P' ? a.from : a.to;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(mfId);
  }

  const sinkSet = new Set(sinkPlaces);
  const scenarios = run.scenarios.map(s => {
    const marking = replay(net, s.transitions);
    const residualPlaces = [...marking.entries()]
      .filter(([p, n]) => n > 0 && !sinkSet.has(p))
      .map(([p]) => p)
      .sort();
    return {
      ...s,
      poolIds: s.transitions.map(t => net.transitions.get(t)?.poolId ?? null),
      messagesSent: s.transitions.flatMap(t => produces.get(t) || []),
      messagesReceived: s.transitions.flatMap(t => consumes.get(t) || []),
      residualPlaces,
      // The sinks are excluded from `residualPlaces` (a token there is the point), which
      // used to hide the one thing that place can still say: `bpmnToPN` wires every end
      // event to the SAME sink (workflow-net.js:161/181), so an AND fork to two end
      // events lands two tokens on it. That is the WF03 improper-completion shape, and
      // with the sink filtered out unconditionally the result read as a clean finish.
      sinkTokens: Object.fromEntries(net.pools.map(p => [p.poolId, marking.get(p.sinkPlace) || 0])),
    };
  });

  return {
    poolIds: net.pools.map(p => p.poolId),
    collapsedPoolIds: net.collapsedPoolIds,
    scenarios,
    truncated: run.truncated,
    stats: {
      backwardEdges: net.pools.flatMap(p =>
        p.backwardEdges.map(e => ({ ...e, poolId: p.poolId }))),
      cycleBound: limits.cycleBound,
      scenarioCount: scenarios.length,
      cappedPaths: run.cappedPaths,
      deadEndPaths: run.deadEndPaths,
      lengthTruncatedPaths: run.lengthTruncatedPaths,
      statesExplored: run.statesExplored,
      orGateways: net.pools.flatMap(p =>
        p.orGateways.map(nodeId => ({ poolId: p.poolId, nodeId }))),
      skipped: net.pools.flatMap(p => p.skipped.map(s => ({ poolId: p.poolId, ...s }))),
      messageFlows: net.messagePlaces.map(mp => ({
        id: mp.messageFlowId,
        placeId: mp.placeId,
        gates: mp.gates,
        senderIsBlackBox: mp.senderIsBlackBox,
        receiverIsBlackBox: mp.receiverIsBlackBox,
        // WHY this flow enforces no ordering, in one field, derived here rather than in
        // `format.js`: this module's own rule is that `stats` is passed through whole rather
        // than curated downstream, so a presentation layer must not have to re-derive a fact
        // the composition already knows. `'blackBox'` is a modelling CHOICE (the module header
        // argues for it at length); `'unmappedEndpoint'` is a defect in the model or in this
        // translation, and `stats.unresolvedEndpoints` says which endpoint and why.
        ungatedReason: mp.gates
          ? null
          : ((mp.senderKind === 'blackBox' || mp.receiverKind === 'blackBox')
            ? 'blackBox'
            : 'unmappedEndpoint'),
        senderTransitions: [...mp.senderTransitions],
        receiverTransitions: [...mp.receiverTransitions],
      })),
      ungatedMessageFlows: net.messagePlaces.filter(mp => !mp.gates).map(mp => mp.messageFlowId),
      unconsumedMessagePlaces: [...net.unconsumablePlaces],
      unresolvedEndpoints: net.unresolved.map(u => ({ ...u })),
    },
  };
}

/**
 * Re-fire a recorded trace to get its final marking (for `residualPlaces`), by the very
 * firing rule the traversal used — `fireTransition`, not a second copy of it.
 */
function replay(net, trace) {
  return trace.reduce((m, tId) => fireTransition(m, tId, net.arcs), new Map(net.initialMarking));
}
