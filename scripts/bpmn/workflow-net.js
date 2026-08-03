/**
 * L2 — Workflow-Net Soundness Checker
 *
 * Converts BPMN Logic-Core to a Place/Transition-Net (Petri-Net)
 * and performs state-space exploration (BFS) to verify soundness.
 *
 * Soundness properties (van der Aalst):
 *   WF01 — Liveness:        Every transition fires at least once in some trace
 *   WF02 — 1-Boundedness:   No place ever holds more than 1 token
 *   WF03 — Proper Completion: Final marking is always reachable (no deadlocks)
 *
 * Scope:
 *   ✅ XOR gateways (exclusive choice)
 *   ✅ AND gateways (parallel fork/join)
 *   ✅ SubProcesses (own subnet, entered and left through synthesized transitions)
 *   ✅ Boundary events (XOR alternative to their host — see `wireBoundaryEvents`)
 *   ⚠️  Non-interrupting boundary events → modelled as interrupting, listed in `approximations`
 *   ⚠️  OR gateways → warning only (not formally verifiable in classical WF-nets)
 *   ❌ Event-Based Gateways → skipped (race conditions)
 *   ❌ Timer/Signal Events → skipped (external triggers)
 *
 * Reference: van der Aalst, "Workflow Nets" (1998), "Soundness of WF-Nets" (2011)
 */

import { isGateway, isBoundaryEvent } from './types.js';

// ═══════════════════════════════════════════════════════════════════════
// BPMN → Petri-Net Conversion
// ═══════════════════════════════════════════════════════════════════════

/**
 * Convert a Logic-Core process to a Place/Transition-Net.
 *
 * Model:
 *   - Each BPMN node → a Transition
 *   - Each SequenceFlow → a Place of its own (between source-transition and target-transition);
 *     `namePlaces` names them and publishes the edge→place map as `pn.placeOfEdge`
 *   - Source place (before startEvent) gets initial token
 *   - Sink place (after endEvent) is the target marking
 *
 * AND-Gateway (parallel):
 *   - Split: 1 input place → transition → N output places (fork)
 *   - Join: N input places → transition → 1 output place (synchronization)
 *
 * XOR-Gateway (exclusive):
 *   - Split: 1 input place → transition → N output places, but only one fires
 *   - Modeled as N separate transitions (one per outgoing edge)
 *
 * SubProcess (any node carrying children):
 *   - Its own source/sink place pair, entered through a synthesized `enter` transition and
 *     left through a synthesized `exit` transition. See `buildContainer` for why dissolving
 *     the container into its children instead is wrong.
 *
 * Boundary event:
 *   - An XOR alternative to its host: it consumes exactly the places the host consumes.
 *     See `wireBoundaryEvents` for the full argument, including the two shapes (a host that
 *     is a container, a host built through the implicit-merge branch) where "exactly the
 *     places the host consumes" needs more than one transition.
 *
 * @param {object} proc - Process with nodes and edges
 * @returns {{ places, transitions, arcs, initialMarking, sinkPlace, orGateways, skipped,
 *   approximations, unproducedPlaces, flatNodes, flatEdges, placeOfEdge }}
 */
function bpmnToPN(proc) {
  const nodes = proc.nodes || [];
  const edges = proc.edges || [];

  const places = new Map();     // placeId → { id, label }
  const transitions = new Map(); // transId → { id, label, bpmnNodeId, role? }
  const arcs = [];               // { from, to, type: 'P→T' | 'T→P' }
  const orGateways = [];
  const skipped = [];
  // Nodes this translation models by something OTHER than what BPMN says they mean — as
  // opposed to `skipped`, which is "not modelled at all". Both are disclosure channels; the
  // difference matters to a reader, because an approximated node DOES appear in traces (just
  // not in every trace the semantics allow) while a skipped one never appears at all.
  const approximations = [];
  // Boundary events are collected here and wired AFTER the whole net is built, because a
  // boundary event's input places are its HOST's input places and the host may be declared
  // after it, or (legally) be a container whose entry transitions only exist once
  // `buildContainer` has run. Deferring is what makes the translation order-independent
  // instead of order-dependent-and-usually-lucky.
  const boundaryEvents = [];
  // Places this translation deliberately leaves with no producing transition, because the node
  // that would have produced them was skipped and disclosed on `skipped`. `net-check.js`'s
  // NC03a exempts them: a place nothing produces is a translation defect when the translation
  // lost the producer, and a fact about the model when the translation says out loud that it
  // did not model it. Narrow on purpose — only NC03a, never NC03b, and only from a disclosed
  // skip — so a genuinely unproduced place is still caught.
  const unproducedPlaces = [];

  // The flattened views: every node at every nesting level, every edge at every nesting level.
  const flatNodes = flattenNodes(nodes);
  const flatEdges = flattenEdges(nodes, edges);

  // Create places for EVERY sequence flow, at every nesting level, in one pass before any
  // scope is built. Every arc-building branch below guards with `places.has(...)`, so a place
  // minted lazily — only once its own scope is entered — would make those guards silently drop
  // arcs rather than fail. Creating them all up front is what keeps the guards honest. The only
  // places minted later are a container's own two (`buildContainer`), and those are created
  // before the arcs that reference them.
  const placeOfEdge = namePlaces(flatEdges, places);

  // The process-level source and sink place.
  const sourcePlace = 'p_source';
  const sinkPlace = 'p_sink';
  places.set(sourcePlace, { id: sourcePlace, label: 'source' });
  places.set(sinkPlace, { id: sinkPlace, label: 'sink' });

  // The process itself is just the outermost scope: its start events draw from `p_source` and
  // its end events produce on `p_sink`, exactly as a subprocess's do from its own pair.
  const ctx = {
    places, transitions, arcs, orGateways, skipped, approximations, boundaryEvents,
    unproducedPlaces, flatNodes, flatEdges, placeOfEdge,
  };
  buildScope(proc, sourcePlace, sinkPlace, ctx);

  // After every scope, at every nesting level, has its transitions and arcs.
  wireBoundaryEvents(ctx);

  // Initial marking: 1 token on source place
  const initialMarking = new Map();
  for (const [pid] of places) {
    initialMarking.set(pid, 0);
  }
  initialMarking.set(sourcePlace, 1);

  // flatNodes/flatEdges travel with the net on purpose. Anything reasoning about cycles
  // has to use the *same* graph the places were named from — `scripts/scenarios/`
  // does — and handing back the actual arrays guarantees identity, where re-running the
  // flatten outside would only ever guarantee agreement.
  //
  // `placeOfEdge` travels for exactly that reason, one level down: it is the edge→place
  // mapping itself rather than the graph it was computed from. The place id used to be a
  // formula every caller re-derived — three branches in this file, `connectTransition`,
  // `wireBoundaryEvents`, `backwardEdgePlaceId` in `scripts/scenarios/enumerate.js`, and two
  // checks in `net-check.js`. Eight copies of one rule agree only until someone edits one of
  // them, which is precisely what happened: `p_<src>_<tgt>` cannot name two flows between the
  // same node pair, and every copy had to learn the fix separately or silently disagree.
  // Keyed on the edge OBJECT, not on `edge.id`: `references/input-schema.json` leaves `Edge.id`
  // optional and unconstrained (only `Node.id` carries `^[a-zA-Z_][a-zA-Z0-9_-]*$`), so an
  // edge id is not a key at all. Object identity always is, and the objects are the very ones
  // in `flatEdges`.
  //
  // `flatNodes` lists a container BEFORE its children, and the container IS in the list — the
  // same parent-then-children shape `di-check.js` and `coordinates.js` already use. It used to
  // be replaced by its children, which meant `scripts/scenarios/` could not name the container
  // at all: it walks `flatNodes` to decide which pool owns a node (`collaboration.js`) and to
  // build the id→name index behind every human-facing trace (`format.js`). A message flow or a
  // scenario step naming a subprocess had nothing to resolve against.
  return {
    places, transitions, arcs, initialMarking, sinkPlace, sourcePlace, orGateways, skipped,
    approximations, unproducedPlaces, flatNodes, flatEdges, placeOfEdge,
  };
}

/**
 * Mint one place per sequence flow and return the edge→place map.
 *
 * ── The naming rule ───────────────────────────────────────────────────────────────────────
 * The counter is keyed on the **concatenation** `<src>_<tgt>`, i.e. on the place id the old
 * scheme would have produced, not on the (source, target) pair:
 *   - `p_<src>_<tgt>` when that concatenation occurs exactly once across `flatEdges`;
 *   - `p_<src>_<tgt>#<k>`, `k = 0…n-1` in `flatEdges` order, when it occurs n > 1 times.
 *
 * Keying on the concatenation rather than on the pair is deliberate, and it closes a second
 * collision the old scheme had. Node ids may contain `_` (`Node.id` is
 * `^[a-zA-Z_][a-zA-Z0-9_-]*$`), so two DIFFERENT pairs can concatenate to the same string:
 * `a → b_c` and `a_b → c` both give `a_b_c`. Under the old formula those two unrelated flows
 * silently shared `p_a_b_c` — the same overwrite as a repeated pair, arrived at by a different
 * route. Here they simply count as two occurrences of one key and become `p_a_b_c#0` and
 * `p_a_b_c#1`: two places, both labels intact, each edge wired to its own. So the invariant
 * this function actually guarantees is the stronger and simpler one — **distinct edges never
 * share a place id** — rather than anything about pairs. Note the consequence a reader
 * debugging an id should know: a `#<k>` does NOT prove the node pair repeats, only that the
 * concatenation does.
 *
 * The unsuffixed form is kept for the overwhelmingly common single case on purpose: every
 * place id in every existing model is unchanged by this, so the suffix appears only where the
 * old scheme was actually wrong. Two flows between one node pair is legal BPMN — a gateway
 * with two conditions leading to the same consequence is the everyday shape — and under the
 * pair-only formula they collapsed onto one place. The second flow's label overwrote the
 * first's, and the net offered one token where the model offers two alternatives, so a
 * reader was shown a decision the trace did not support.
 *
 * ── Why not `p_<edgeId>` ──────────────────────────────────────────────────────────────────
 * `references/input-schema.json` makes `Edge.id` neither required nor pattern-constrained,
 * unlike `Node.id` (`^[a-zA-Z_][a-zA-Z0-9_-]*$`). An edge id may therefore be absent, or
 * contain `#`, or collide with another edge's — none of which a place id may do.
 *
 * ── Why `#<k>` cannot collide ─────────────────────────────────────────────────────────────
 * `#` is this file's reserved separator, and `buildContainer`'s doc carries the proof that no
 * node id can contain it (schema pattern at the HTTP gate; XSD `NCName` everywhere else). So
 * `p_<src>_<tgt>#<k>` holds exactly one `#`, and so does a container's `p_<C>#source` /
 * `p_<C>#sink`. Comparing the two ids therefore reduces to comparing what follows that one
 * `#`: a decimal integer here, the literals `source` / `sink` there. Disjoint, whatever the
 * ids on either side of the separator are — which is what makes the argument robust to the
 * concatenation keying above. The case worth spelling out because it looks alarming: a
 * container `C = "a_b"` mints `p_a_b#source` / `p_a_b#sink`, and a recurring key `a_b` mints
 * `p_a_b#0` / `p_a_b#1`. Identical to the left of the `#`, still disjoint to the right of it.
 *
 * ── The same edge object listed twice ─────────────────────────────────────────────────────
 * Skipped rather than counted twice. An identity-keyed map cannot represent one object as two
 * places, so counting it twice would mint a place nothing ever references (NC03a/NC03b, an
 * invented defect). One object is one edge is one place — the only self-consistent reading,
 * and `net-check.js`'s NC04 dedupes by identity for the same reason.
 *
 * @param {Array<object>} flatEdges - every sequence flow, at every nesting level
 * @param {Map<string, object>} places - written into
 * @returns {Map<object, string>} edge object → place id
 */
function namePlaces(flatEdges, places) {
  // The base id the unsuffixed scheme would have produced. Named once so the counting pass and
  // the minting pass cannot drift, and so it is visible that the key is a STRING, not a pair —
  // see the naming-rule section above for why that is the stronger invariant.
  const baseKey = (edge) => `${edge.source}_${edge.target}`;

  // Two passes so the mint order is exactly `flatEdges` order: a running index alone cannot
  // know whether a key will recur later, and grouping first would move a recurring key's
  // second place next to its first.
  const keyCount = new Map();
  const distinct = [];
  const seen = new Set();
  for (const edge of flatEdges) {
    if (seen.has(edge)) continue;
    seen.add(edge);
    distinct.push(edge);
    const key = baseKey(edge);
    keyCount.set(key, (keyCount.get(key) || 0) + 1);
  }

  const placeOfEdge = new Map();
  const nextIndex = new Map();
  for (const edge of distinct) {
    const key = baseKey(edge);
    const k = nextIndex.get(key) || 0;
    nextIndex.set(key, k + 1);
    const placeId = keyCount.get(key) === 1 ? `p_${key}` : `p_${key}#${k}`;
    placeOfEdge.set(edge, placeId);
    places.set(placeId, { id: placeId, label: edge.label || '' });
  }
  return placeOfEdge;
}

/**
 * Does this node carry a subnet of its own?
 *
 * Type-agnostic on purpose, matching every other descent in the repo — `di-check.js`'s
 * `flattenNodes`, `coordinates.js`'s `flattenProcessNodes` and S13's `collect`
 * (`rules.js`) all recurse on `n.nodes` without asking what `type` says. That also picks up
 * `transaction`, which `NodeType` allows and which is a subprocess in every semantic respect.
 *
 * Note what is deliberately NOT consulted: `isExpanded`. It exists only as a `BPMNShape`
 * attribute (`references/omg-spec/normative/BPMNDI.xsd`, `BPMNDI.cmof`) and has no semantic
 * counterpart — it says how the shape is drawn, nothing about how tokens move. `bpmn-xml.js`
 * makes the same argument for serialisation. Gating *semantic* recursion on a *rendering* flag
 * meant a collapsed subprocess carrying children was silently modelled as an atomic task.
 */
function isContainer(node) {
  return Array.isArray(node.nodes) && node.nodes.length > 0;
}

/**
 * Will this container actually be refined into a subnet, or fall back to the atomic treatment?
 *
 * A container needs both an inner `startEvent` and an inner `endEvent` to have a well-defined
 * entry and exit marking; without either there is nothing to route a token through, and
 * `buildContainer` degrades it to a single transition without descending.
 *
 * This predicate is deliberately shared with `flattenNodes`/`flattenEdges`, and that sharing is
 * the load-bearing part. The place pass runs over the WHOLE of `flatEdges` up front, so if the
 * flatten descended somewhere the translation does not, the subtree's nodes would appear in
 * `flatNodes` with no transition and its inner edges would become places nothing produces and
 * nothing consumes — precisely the disconnected-net defect this stage exists to remove, just
 * relocated into the fallback path. One predicate makes the two passes agree by construction;
 * two copies would only ever agree by coincidence.
 *
 * Dropping the subtree (rather than keeping it and pushing every descendant onto `skipped`) is
 * the choice that keeps the `flatNodes`/`flatEdges` contract honest: `scripts/scenarios/` reads
 * those arrays as "what this net is about", and a node that has no transition can never appear
 * in a trace, be resolved to a pool, or be named in a scenario. Listing it would promise a
 * resolution the net cannot deliver. The container itself stays — it does get a transition —
 * and `skipped` names it, so the under-model is disclosed at exactly the boundary where it
 * starts.
 */
function isRefinableContainer(node) {
  if (!isContainer(node)) return false;
  return node.nodes.some(n => n.type === 'startEvent') && node.nodes.some(n => n.type === 'endEvent');
}

/**
 * Build the transitions and arcs for one scope — the process itself, or one container's
 * interior — into the shared `ctx`.
 *
 * The scope's own source/sink pair is passed in rather than read from module scope, which is
 * the whole point: a `startEvent` inside a subprocess must draw from THAT subprocess's source
 * place, not from the global `p_source`. Binding it globally let the inner start compete with
 * the real start for the single initial token, and let an inner `endEvent` mark the entire
 * process complete.
 *
 * `orGateways` and `skipped` live on `ctx` and accumulate across every scope, so an OR gateway
 * or an event-based gateway nested three levels deep is still disclosed to the caller.
 *
 * @param {object} container - the process or container node whose `nodes` define this scope
 * @param {string} scopeSource - place a `startEvent` in this scope draws its token from
 * @param {string} scopeSink - place an `endEvent` in this scope produces its token on
 * @param {{places, transitions, arcs, orGateways, skipped, approximations, boundaryEvents,
 *   flatEdges}} ctx
 */
function buildScope(container, scopeSource, scopeSink, ctx) {
  const { places, transitions, arcs, orGateways, skipped, boundaryEvents, flatEdges,
    placeOfEdge } = ctx;

  for (const node of container.nodes || []) {
    // Skip elements that don't participate in control flow
    if (node.type === 'dataObjectReference' || node.type === 'dataStoreReference' ||
        node.type === 'textAnnotation' || node.type === 'group') {
      skipped.push({ id: node.id, reason: 'artifact' });
      continue;
    }

    // A boundary event is not enabled by a sequence flow, so none of the branches below can
    // wire it: they all read `flatEdges` for incoming edges and a boundary event has none.
    // That is exactly how it used to end up with a transition and no input arc — unfireable
    // in every marking, deleting its whole escalation path from every analysis, silently.
    // Deferred to `wireBoundaryEvents`, which needs the host's transitions to exist first.
    if (isBoundaryEvent(node)) {
      boundaryEvents.push(node);
      continue;
    }

    // A node with children is a subnet, not a transition.
    if (isContainer(node)) {
      buildContainer(node, ctx);
      continue;
    }

    // OR gateways: warn but don't model formally
    if (node.type === 'inclusiveGateway') {
      orGateways.push(node.id);
    }

    // Event-Based Gateways: skip formal verification
    if (node.type === 'eventBasedGateway') {
      skipped.push({ id: node.id, reason: 'eventBasedGateway' });
      // Still create a transition so the net is connected
      const tId = `t_${node.id}`;
      transitions.set(tId, { id: tId, label: node.name || node.id, bpmnNodeId: node.id });
      connectTransition(tId, node.id, ctx);
      continue;
    }

    // XOR-Gateway split: model as N separate transitions (non-deterministic choice)
    if (node.type === 'exclusiveGateway') {
      const outEdges = flatEdges.filter(e => e.source === node.id);
      const inEdges = flatEdges.filter(e => e.target === node.id);

      if (outEdges.length > 1) {
        // XOR split: one transition per outgoing edge
        for (let i = 0; i < outEdges.length; i++) {
          const tId = `t_${node.id}_choice_${i}`;
          transitions.set(tId, { id: tId, label: `${node.name || node.id}[${i}]`, bpmnNodeId: node.id });

          // All incoming places → this transition
          for (const ie of inEdges) {
            arcs.push({ from: placeOfEdge.get(ie), to: tId, type: 'P→T' });
          }
          // This transition → the specific outgoing place. One place per outgoing EDGE, which
          // is what makes the branch observable when two of them run to the same target.
          arcs.push({ from: tId, to: placeOfEdge.get(outEdges[i]), type: 'T→P' });
        }
        continue; // Don't create the default transition
      }
    }

    // Check for implicit merge: a node with multiple incoming edges and no more than
    // one outgoing edge acts as an OR-join (any one incoming token activates it) — either
    // a plain task with 2+ incoming flows (BPMN's implicit merge), or an exclusiveGateway
    // used as a join rather than a split. Naively giving such a node ONE transition with
    // one P→T arc per incoming place would require ALL of them to hold a token at once —
    // AND semantics — which is wrong for both shapes. `outEdges.length > 1` above already
    // `continue`s an exclusiveGateway that's splitting, so any exclusiveGateway reaching
    // this line has at most one outgoing edge and is a join if it is anything.
    // Fix: create one transition per incoming edge, so any single arrival can fire it.
    const inEdges = flatEdges.filter(e => e.target === node.id);
    const outEdges = flatEdges.filter(e => e.source === node.id);
    const isExclusiveJoin = node.type === 'exclusiveGateway' && outEdges.length <= 1;
    const isImplicitMerge = (!isGateway(node.type) || isExclusiveJoin) && inEdges.length > 1;

    if (isImplicitMerge) {
      for (let i = 0; i < inEdges.length; i++) {
        const tId = `t_${node.id}_merge_${i}`;
        transitions.set(tId, { id: tId, label: `${node.name || node.id}[m${i}]`, bpmnNodeId: node.id });

        // Only this specific incoming place → transition
        const inPlace = placeOfEdge.get(inEdges[i]);
        if (places.has(inPlace)) {
          arcs.push({ from: inPlace, to: tId, type: 'P→T' });
        }

        // All outgoing places
        for (const oe of outEdges) {
          const outPlace = placeOfEdge.get(oe);
          if (places.has(outPlace)) {
            arcs.push({ from: tId, to: outPlace, type: 'T→P' });
          }
        }

        // Start event: this scope's source place → transition
        if (node.type === 'startEvent') {
          arcs.push({ from: scopeSource, to: tId, type: 'P→T' });
        }
        // End event: transition → this scope's sink place
        if (node.type === 'endEvent') {
          arcs.push({ from: tId, to: scopeSink, type: 'T→P' });
        }
      }
      continue;
    }

    // Default: one transition per node
    const tId = `t_${node.id}`;
    transitions.set(tId, { id: tId, label: node.name || node.id, bpmnNodeId: node.id });

    // Connect: incoming places → transition → outgoing places
    connectTransition(tId, node.id, ctx);

    // Start event: this scope's source place → transition. Several start events in one scope
    // are XOR alternatives over that scope's single entry token — OMG §10.4.2's reading, and
    // what the process level has always done.
    if (node.type === 'startEvent') {
      arcs.push({ from: scopeSource, to: tId, type: 'P→T' });
    }

    // End event: transition → this scope's sink place. Several end events in one scope can put
    // more than one token on it; WF02 then reports the accumulation, exactly as it already does
    // for the process-level `p_sink`.
    if (node.type === 'endEvent') {
      arcs.push({ from: tId, to: scopeSink, type: 'T→P' });
    }
  }
}

/**
 * Translate a container node into a proper subnet:
 *
 *   outer incoming places ──► t_C#enter ──► p_C#source
 *                                              │
 *                          children, built with scope (p_C#source, p_C#sink)
 *                                              │
 *   outer outgoing places ◄── t_C#exit  ◄── p_C#sink
 *
 * `#` is the reserved separator for synthesized container ids, and it is safe by construction
 * rather than by convention — but the claim has to be stated precisely, because the schema is
 * narrower than it first looks.
 *
 * `references/input-schema.json` puts the pattern `^[a-zA-Z_][a-zA-Z0-9_-]*$` on **`Node.id`
 * only**. Process, Pool, Participant, Edge and Lane ids carry no pattern at all, so no argument
 * may lean on them. It does not need to: every id THIS file mints is built from node ids and
 * ASCII-word literals — `t_<id>`, `t_<id>_choice_<i>`, `t_<id>_merge_<i>` from `node.id`, and
 * `p_<src>_<tgt>` from `edge.source`/`edge.target`, which are node ids by reference even though
 * `Edge.id` itself is unconstrained. So no id minted here can contain a `#` it did not put
 * there itself, and the container ids below cannot collide with any of them. The one id
 * minted here that DOES carry a `#` is a recurring key's `p_<src>_<tgt>#<k>` (`namePlaces`),
 * and its own doc carries the one-line argument for why a decimal `<k>` can never be read as
 * `source` or `sink`.
 *
 * Second leg, which the schema alone does not give us: `schema-gate.js` runs only at the HTTP
 * entry, so on the CLI and library paths — and on anything arriving through `import.js` /
 * `moddle-import.js` — nothing has enforced that pattern. There the invariant rests on BPMN's
 * own XSD typing ids as `NCName`, which likewise excludes `#`.
 *
 * Downstream consumers mint further ids (`pmsg_<mfId>`, `<poolId>::`, `<tId>__recv_<mfId>`);
 * those are `scripts/scenarios/`'s namespace to keep disjoint, not this file's, and the pool
 * component in particular is NOT schema-constrained.
 *
 * Only the container's OWN two transitions carry `#`. Ordinary transitions inside a container
 * keep their plain names, because `scripts/scenarios/format.js`'s `CHOICE_TRANSITION_RE`
 * (`/^t_(.+)_choice_(\d+)$/`) has to keep matching a gateway that happens to live inside a
 * subprocess — every decision-label recovery path depends on it.
 */
function buildContainer(node, ctx) {
  const { places, transitions, arcs, skipped, flatEdges, placeOfEdge } = ctx;

  const label = node.name || node.id;

  // A container without an inner start or an inner end has no well-defined entry or exit
  // marking, so there is nothing to route a token through. Fall back to the atomic treatment
  // (one transition, wired to the outer edges) and DISCLOSE the under-model rather than let it
  // pass as a faithful translation — `scripts/scenarios/format.js` renders a non-artifact skip
  // reason as an explicit "not modelled at all" note. Rejecting such input in S11 instead would
  // be a new input restriction, which is a separate decision from this translation fix.
  //
  // The same `isRefinableContainer` already stopped `flattenNodes`/`flattenEdges` from
  // descending here, so the subtree is absent from both flattened views and there are no
  // orphaned inner places for this branch to leave behind. Testing the condition separately in
  // the two places is what would reintroduce them.
  if (!isRefinableContainer(node)) {
    const tId = `t_${node.id}`;
    transitions.set(tId, { id: tId, label, bpmnNodeId: node.id });
    connectTransition(tId, node.id, ctx);
    skipped.push({ id: node.id, reason: 'subProcessWithoutStartOrEnd' });
    return;
  }

  const scopeSource = `p_${node.id}#source`;
  const scopeSink = `p_${node.id}#sink`;
  places.set(scopeSource, { id: scopeSource, label: `${label} source` });
  places.set(scopeSink, { id: scopeSink, label: `${label} sink` });

  // `inEdges`/`outEdges` filter the FLATTENED edge list, not `node.edges`: an outer edge into
  // the container lives in the parent's edge list while an inner edge lives in the child's, and
  // filtering the flattened list by node id gets both right. This relies on node ids being
  // unique across nesting levels — an assumption the repo already makes (`redesign-core.js`'s
  // `collectIds` flattens every level into one `Set`) and which `net-check.js`'s NC06 checks.
  const inEdges = flatEdges.filter(e => e.target === node.id);
  const outEdges = flatEdges.filter(e => e.source === node.id);

  // A container with ZERO outer edges on either side gets no special case, deliberately.
  // With no incoming edge `t_C#enter` has no input place and can never fire; with no outgoing
  // edge `t_C#exit` consumes the scope's sink token and produces nothing. Both are exactly what
  // `connectTransition` does to a plain node in the same shape, and consistency with the atomic
  // case is the right answer here rather than an oversight. Do not add a guard.
  //
  // Which layer says so: **the rule engine, not `net-check.js`**. A container nothing routes to
  // is a defect in the MODEL — S04 (isolated node) / S07 (no outgoing flow) — and `net-check.js`
  // judges the translation only, so its NC02/NC02b exempt a transition whose Logic-Core node
  // genuinely has no incoming (resp. outgoing) sequence flow. This comment used to claim the
  // opposite, and the two files documenting opposite doctrines about the same code is how the
  // next reader gets it wrong. What NC02 still catches, at ERROR, is the case that matters here:
  // an outer edge that EXISTS in the Logic-Core and whose place never reached `t_C#enter`.
  // At the top level such a model is additionally rejected by S02 before it reaches anything,
  // since a process must have at least one end event.
  if (inEdges.length > 1) {
    // One entry transition per incoming edge, each consuming ONLY its own place. A single
    // transition consuming all of them would demand a token on every incoming flow at once —
    // AND semantics, the exact defect the implicit-merge branch in `buildScope` exists to fix
    // for plain nodes.
    for (let i = 0; i < inEdges.length; i++) {
      const tId = `t_${node.id}#enter#${i}`;
      transitions.set(tId, { id: tId, label: `${label}[enter${i}]`, bpmnNodeId: node.id, role: 'enter' });
      const inPlace = placeOfEdge.get(inEdges[i]);
      if (places.has(inPlace)) {
        arcs.push({ from: inPlace, to: tId, type: 'P→T' });
      }
      arcs.push({ from: tId, to: scopeSource, type: 'T→P' });
    }
  } else {
    const tId = `t_${node.id}#enter`;
    transitions.set(tId, { id: tId, label: `${label}[enter]`, bpmnNodeId: node.id, role: 'enter' });
    for (const ie of inEdges) {
      const inPlace = placeOfEdge.get(ie);
      if (places.has(inPlace)) {
        arcs.push({ from: inPlace, to: tId, type: 'P→T' });
      }
    }
    arcs.push({ from: tId, to: scopeSource, type: 'T→P' });
  }

  // The exit side needs no such split: it has exactly one input place (`p_C#sink`), and its
  // multi-output case is the implicit parallel split `connectTransition` already produces.
  const exitId = `t_${node.id}#exit`;
  transitions.set(exitId, { id: exitId, label: `${label}[exit]`, bpmnNodeId: node.id, role: 'exit' });
  arcs.push({ from: scopeSink, to: exitId, type: 'P→T' });
  for (const oe of outEdges) {
    const outPlace = placeOfEdge.get(oe);
    if (places.has(outPlace)) {
      arcs.push({ from: exitId, to: outPlace, type: 'T→P' });
    }
  }

  buildScope(node, scopeSource, scopeSink, ctx);
}

/**
 * Give every boundary event a translation.
 *
 * ── The rule ──────────────────────────────────────────────────────────────────────────────
 * An interrupting boundary event `b` on host `h` is an **XOR alternative to the host**: the
 * token that would have enabled `h` enables `b` instead. So `t_b` consumes exactly the places
 * `t_h` consumes, and produces on `p_<b>_<y>` for every outgoing edge of `b`.
 *
 * Implemented by reading the arcs the host's transitions ACTUALLY got, not by re-deriving
 * which branch of `buildScope`/`buildContainer` built them. That is the load-bearing choice
 * here, for the same reason `flatNodes`/`flatEdges` travel with the net: a second copy of the
 * branch logic would agree with the first only by coincidence, and every future branch would
 * have to remember to update both. Reading the arcs makes "exactly the places the host
 * consumes" true by construction, whatever produced them.
 *
 * ── Shape 1: the host is a container ──────────────────────────────────────────────────────
 * Then the host has an entry/exit PAIR, and only the entry side is a competitor. `t_C#exit`
 * consumes `p_C#sink`, i.e. the marking in which the subprocess has already finished;
 * a boundary transition drawing from there would fire the escalation path AFTER the very
 * execution it is supposed to cut short. Hence the `role === 'exit'` exclusion below.
 *
 * With several incoming edges the container has one `t_C#enter#<i>` per edge, each consuming
 * ONLY its own place — `buildContainer` argues why (a single transition consuming all of them
 * is AND semantics). The boundary event inherits that argument unchanged: one boundary
 * transition per entry transition, each consuming that entry transition's own place. One
 * boundary transition consuming the union would demand a token on every incoming flow at once,
 * and picking a single incoming edge would leave the container enterable-but-not-interruptible
 * on all the others.
 *
 * The under-model this leaves is real and is disclosed as `boundaryEventOnContainer`: the net
 * says "either the subprocess runs to completion, or the boundary event fires instead", where
 * BPMN says the subprocess may run partway and then be cancelled. Modelling that faithfully
 * needs a cancel region — removing tokens from a set of places not known until run time —
 * which no fixed set of P/T arcs expresses. The alternative encodings all invent something
 * (see the non-interrupting argument below); under-modelling and saying so does not.
 *
 * ── Shape 2: the host went through the implicit-merge branch ──────────────────────────────
 * A host with several incoming edges has one `t_<h>_merge_<i>` per edge, each consuming one
 * place, because any single arrival executes the host. Same answer, same reason: one boundary
 * transition per merge transition. One transition consuming all incoming places would be the
 * AND the merge branch exists to avoid — a token invented on every other incoming flow —
 * and one transition consuming a single arbitrarily chosen place would reproduce the original
 * bug for the other arrivals: the host is reachable by a route on which its boundary event can
 * never fire.
 *
 * Both shapes fall out of the one rule without a special case, which is the point.
 *
 * ── Non-interrupting (`cancelActivity === false`) ─────────────────────────────────────────
 * Translated IDENTICALLY, and recorded in `approximations`. This is a deliberate under-model,
 * not an oversight — do not "fix" it without reading this:
 *   - a faithful encoding needs the host's input token to enable BOTH the host and the event,
 *     which in a P/T net means either a second token (a forced AND: the model is then claimed
 *     to always do both, a path the BPMN model does not have), or
 *   - a silent skip transition so the event path can be bypassed — which puts a transition
 *     that stands for nothing into `Scenario.nodes`, i.e. tells the reader a step happened
 *     that did not.
 * Under-modelling AND SAYING SO is the only one of the three that never invents a path.
 * `scripts/scenarios/format.js` renders `approximations` next to `orGateways`, which is the
 * same kind of statement about the same kind of gap.
 *
 * ── A host that cannot be found ───────────────────────────────────────────────────────────
 * No transition, and disclosed on `skipped`. Minting an input-less transition instead is
 * precisely the defect this function removes, and NC02 (`net-check.js`) is ERROR from here on.
 * The same branch also catches a boundary event chained onto another boundary event declared
 * after it — illegal BPMN (`BoundaryEvent.attachedToRef` is typed `Activity`), and worth
 * naming here because the outcome is deliberately the safe one rather than the clever one: it
 * is disclosed and left out, never given a transition on a guess.
 */
function wireBoundaryEvents(ctx) {
  const { places, transitions, arcs, skipped, approximations, boundaryEvents,
    unproducedPlaces, flatNodes, flatEdges, placeOfEdge } = ctx;

  for (const node of boundaryEvents) {
    const hostId = node.attachedTo;
    const host = (flatNodes || []).find(n => n.id === hostId);

    // Every input-place set that enables the host, one per host transition.
    //
    // Two exclusions, and the reason they are `role` tests rather than anything cleverer is
    // that `role` is the only thing that distinguishes these transitions from the host's own:
    //   - `role === 'exit'` is the container's far end, never a competitor (see above);
    //   - `role === 'boundary'` keeps a boundary event attached to ANOTHER boundary event out.
    //     `BoundaryEvent.attachedToRef` is typed `Activity`, so that shape is illegal BPMN, and
    //     nothing upstream of this file rejects it (S13 only checks that `attachedTo` names a
    //     node in the same container). Without the test it resolved or did not depending purely
    //     on declaration order — chained if its host happened to be wired first, disclosed on
    //     `skipped` if not. Refusing it outright makes the outcome the same either way, which
    //     is worth more than accidentally supporting a shape the standard forbids.
    //
    // Note what does NOT protect this loop: it reads a `transitions` map that earlier
    // iterations have already written to. An earlier comment here claimed the collection ran
    // before anything was added, and that was simply false. The protection is the
    // `t.bpmnNodeId !== hostId` filter — a boundary event's own transitions carry ITS node id,
    // not its host's — plus the `role` exclusion above for the one case where that filter
    // would otherwise match.
    const groups = [];
    for (const [tId, t] of transitions) {
      if (t.bpmnNodeId !== hostId || t.role === 'exit' || t.role === 'boundary') continue;
      const inPlaces = arcs.filter(a => a.type === 'P→T' && a.to === tId).map(a => a.from);
      if (inPlaces.length > 0) groups.push(inPlaces);
    }

    // A boundary event carries no incoming sequence flow in BPMN (OMG §10.4.4) — but nothing
    // upstream of this file enforces that, and dropping such an edge here would leave its
    // place produced and never consumed, which `net-check.js` would then report as a
    // TRANSLATION defect (NC03b, ERROR) for what is really a malformed model. Counting it as
    // one more alternative trigger keeps the net well-formed and stays XOR — the one thing
    // that must not happen is an AND across it and the host's places.
    for (const ie of flatEdges.filter(e => e.target === node.id)) {
      const pid = placeOfEdge.get(ie);
      if (places.has(pid)) groups.push([pid]);
    }

    // Two host transitions with identical input sets (an XOR split's branches, say) are one
    // trigger condition, not two — collapsing them keeps the boundary event from being
    // duplicated into transitions that are literally interchangeable.
    const seen = new Set();
    const distinct = [];
    for (const g of groups) {
      const key = [...g].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      distinct.push(g);
    }

    if (distinct.length === 0) {
      skipped.push({ id: node.id, reason: 'boundaryEventWithoutHost' });
      // The event gets no transition — but the places for its OUTGOING edges were already
      // minted by `bpmnToPN`'s up-front pass, and nothing produces them now. That is the exact
      // mirror of the incoming-edge argument above, and it needs the same care: leaving it
      // unaccounted made `net-check.js` report NC03a (ERROR) — a TRANSLATION defect — for what
      // is a malformed MODEL, the category error net-check's own doc comment forbids.
      //
      // Recorded rather than repaired, and the two repairs are worth naming so nobody tries
      // them: deleting the place leaves the downstream node's consuming arc dangling, and
      // deleting the arc too leaves that node with no input place at all — NC02, ERROR, a
      // fresh defect invented to hide this one. The place SHOULD be there and SHOULD have no
      // producer: the escalation path really is unreachable in this model, which is a
      // model-level fact and is what WF01 reports about it.
      //
      // Passed IN on the net rather than re-derived inside `net-check.js`, for the reason that
      // module already gives for `exemptUnconsumedPlaces`: identity beats agreement.
      for (const oe of flatEdges.filter(e => e.source === node.id)) {
        const pid = placeOfEdge.get(oe);
        if (places.has(pid)) unproducedPlaces.push(pid);
      }
      continue;
    }

    if (node.cancelActivity === false) {
      approximations.push({ id: node.id, reason: 'nonInterruptingBoundaryEvent' });
    }
    if (host && isRefinableContainer(host)) {
      approximations.push({ id: node.id, reason: 'boundaryEventOnContainer' });
    }

    const outPlaces = flatEdges
      .filter(e => e.source === node.id)
      .map(e => placeOfEdge.get(e))
      .filter(p => places.has(p));

    const label = node.name || node.id;
    const single = distinct.length === 1;
    for (let i = 0; i < distinct.length; i++) {
      // `#` is the separator reserved for synthesized ids and provably absent from every node
      // id — `buildContainer`'s doc carries the argument. `_alt_` would have been a collision
      // risk against a real node called `<b>_alt_0`, and `_choice_` would additionally be
      // misread by `scripts/scenarios/format.js`'s `CHOICE_TRANSITION_RE` as a gateway
      // decision. The single-group case keeps the plain `t_<b>` id it has always had.
      const tId = single ? `t_${node.id}` : `t_${node.id}#alt#${i}`;
      transitions.set(tId, {
        id: tId,
        label: single ? label : `${label}[alt${i}]`,
        bpmnNodeId: node.id,
        role: 'boundary',
      });
      for (const p of distinct[i]) arcs.push({ from: p, to: tId, type: 'P→T' });
      for (const p of outPlaces) arcs.push({ from: tId, to: p, type: 'T→P' });
    }
  }
}

/**
 * Wire one transition to the places of every edge touching its node.
 *
 * Takes the whole `ctx` rather than the four pieces it uses, because `placeOfEdge` and
 * `flatEdges` must be the ones the places were minted from — passing them separately is how a
 * caller ends up handing over a filtered edge list and an unrelated map.
 */
function connectTransition(tId, nodeId, ctx) {
  const { places, arcs, flatEdges, placeOfEdge } = ctx;
  const inEdges = flatEdges.filter(e => e.target === nodeId);
  const outEdges = flatEdges.filter(e => e.source === nodeId);

  for (const ie of inEdges) {
    const placeId = placeOfEdge.get(ie);
    if (places.has(placeId)) {
      arcs.push({ from: placeId, to: tId, type: 'P→T' });
    }
  }
  for (const oe of outEdges) {
    const placeId = placeOfEdge.get(oe);
    if (places.has(placeId)) {
      arcs.push({ from: tId, to: placeId, type: 'T→P' });
    }
  }
}

/**
 * Every node at every nesting level, parent BEFORE its children — the same shape
 * `di-check.js` and `coordinates.js`'s `flattenProcessNodes` produce. A container used to be
 * REPLACED by its children here, which is what made it invisible to everything downstream.
 */
function flattenNodes(nodes) {
  const out = [];
  for (const n of nodes || []) {
    out.push(n);
    // Descend only where `buildContainer` will — see `isRefinableContainer` for why the two
    // passes must share one predicate rather than each testing for themselves.
    if (isRefinableContainer(n)) out.push(...flattenNodes(n.nodes));
  }
  return out;
}

/**
 * Flatten edges: include container-internal edges at every nesting level that is actually
 * refined into a subnet. A container that falls back to the atomic treatment contributes none
 * of its inner edges, because no transition would ever produce or consume the resulting places.
 */
function flattenEdges(nodes, edges) {
  const result = [...edges];
  for (const n of nodes || []) {
    if (isRefinableContainer(n)) {
      result.push(...flattenEdges(n.nodes, n.edges || []));
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// State-Space Exploration (BFS)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Encode a marking as a string for Set-based duplicate detection.
 */
function encodeMarking(marking) {
  const entries = [];
  for (const [place, tokens] of marking) {
    if (tokens > 0) entries.push(`${place}=${tokens}`);
  }
  entries.sort();
  return entries.join(',');
}

/**
 * Get enabled transitions for a given marking.
 */
function getEnabledTransitions(marking, transitions, arcs) {
  const enabled = [];
  for (const [tId] of transitions) {
    const inputArcs = arcs.filter(a => a.to === tId && a.type === 'P→T');
    const isEnabled = inputArcs.length > 0 && inputArcs.every(a => (marking.get(a.from) || 0) >= 1);
    if (isEnabled) enabled.push(tId);
  }
  return enabled;
}

/**
 * Fire a transition: consume from input places, produce on output places.
 */
function fireTransition(marking, tId, arcs) {
  const newMarking = new Map(marking);
  for (const a of arcs) {
    if (a.to === tId && a.type === 'P→T') {
      newMarking.set(a.from, (newMarking.get(a.from) || 0) - 1);
    }
    if (a.from === tId && a.type === 'T→P') {
      newMarking.set(a.to, (newMarking.get(a.to) || 0) + 1);
    }
  }
  return newMarking;
}

/**
 * Run state-space exploration (BFS) on a Petri-Net.
 *
 * @param {object} pn - Petri-Net from bpmnToPN()
 * @param {object} options - { maxStates: number }
 * @returns {{ issues, stats }}
 */
function checkSoundness(pn, options = {}) {
  const maxStates = options.maxStates || 10_000;
  const { places, transitions, arcs, initialMarking, sinkPlace, sourcePlace, orGateways } = pn;

  const issues = [];
  const visitedEncodings = new Set();
  const firedTransitions = new Set();
  let maxTokens = 0;
  let maxTokenPlace = null;
  let deadlockStates = [];
  let sinkReached = false;
  let statesExplored = 0;
  let truncated = false;

  // BFS
  const queue = [initialMarking];
  visitedEncodings.add(encodeMarking(initialMarking));

  while (queue.length > 0) {
    if (statesExplored >= maxStates) {
      truncated = true;
      break;
    }

    const marking = queue.shift();
    statesExplored++;

    // Check boundedness
    for (const [pid, tokens] of marking) {
      if (tokens > maxTokens) {
        maxTokens = tokens;
        maxTokenPlace = pid;
      }
    }

    // Check if sink reached
    if ((marking.get(sinkPlace) || 0) >= 1) {
      sinkReached = true;
      // Check proper completion: only sink has tokens
      let improperCompletion = false;
      for (const [pid, tokens] of marking) {
        if (pid !== sinkPlace && tokens > 0) {
          improperCompletion = true;
          break;
        }
      }
      if (improperCompletion) {
        const remaining = [];
        for (const [pid, tokens] of marking) {
          if (pid !== sinkPlace && tokens > 0) remaining.push(`${pid}=${tokens}`);
        }
        issues.push({
          rule: 'WF03',
          severity: 'WARNING',
          message: `Improper completion: sink reached but tokens remain at: ${remaining.slice(0, 3).join(', ')}`,
        });
      }
    }

    // Get enabled transitions
    const enabled = getEnabledTransitions(marking, transitions, arcs);

    if (enabled.length === 0) {
      // Check if this is a deadlock (not at final marking)
      const sinkTokens = marking.get(sinkPlace) || 0;
      if (sinkTokens === 0) {
        // Deadlock: no transition enabled and not at sink
        const state = [];
        for (const [pid, tokens] of marking) {
          if (tokens > 0) state.push(`${pid}=${tokens}`);
        }
        if (deadlockStates.length < 3) { // Limit reported deadlocks
          deadlockStates.push(state.join(', '));
        }
      }
      continue;
    }

    // Fire each enabled transition (explore all interleavings)
    for (const tId of enabled) {
      firedTransitions.add(tId);
      const newMarking = fireTransition(marking, tId, arcs);
      const encoded = encodeMarking(newMarking);
      if (!visitedEncodings.has(encoded)) {
        visitedEncodings.add(encoded);
        queue.push(newMarking);
      }
    }
  }

  // ── Evaluate results ──

  // WF01 — Liveness: every transition should fire at least once
  const deadTransitions = [];
  for (const [tId, tInfo] of transitions) {
    if (!firedTransitions.has(tId)) {
      deadTransitions.push(tInfo);
    }
  }
  if (deadTransitions.length > 0) {
    const names = deadTransitions.slice(0, 5).map(t => `"${t.label}" (${t.bpmnNodeId})`).join(', ');
    issues.push({
      rule: 'WF01',
      severity: 'WARNING',
      message: `Dead transition(s) never fire: ${names}${deadTransitions.length > 5 ? ` (+${deadTransitions.length - 5} more)` : ''}`,
    });
  }

  // WF02 — Boundedness
  if (maxTokens > 1) {
    issues.push({
      rule: 'WF02',
      severity: 'WARNING',
      message: `Unbounded place "${maxTokenPlace}" accumulated ${maxTokens} tokens (expected ≤1). Possible token accumulation at parallel join.`,
    });
  }

  // WF03 — Deadlock detection
  if (deadlockStates.length > 0) {
    for (const state of deadlockStates) {
      issues.push({
        rule: 'WF03',
        severity: 'ERROR',
        message: `Deadlock state reachable: {${state}} — no enabled transition, sink not reached.`,
      });
    }
  }

  // WF03 — Sink unreachable
  if (!sinkReached && !truncated) {
    issues.push({
      rule: 'WF03',
      severity: 'ERROR',
      message: `Final marking (sink) is unreachable from initial marking. Process cannot complete.`,
    });
  }

  // OR-Gateway warning
  if (orGateways.length > 0) {
    issues.push({
      rule: 'WF_OR',
      severity: 'INFO',
      message: `OR-Gateway(s) ${orGateways.map(id => `"${id}"`).join(', ')} not formally verifiable in WF-Net analysis. Results may be incomplete.`,
    });
  }

  return {
    issues,
    stats: {
      statesExplored,
      truncated,
      places: places.size,
      transitions: transitions.size,
      arcs: arcs.length,
      firedTransitions: firedTransitions.size,
      deadTransitions: deadTransitions.length,
      maxTokens,
      deadlockStates: deadlockStates.length,
      sinkReached,
      orGateways: orGateways.length,
      skipped: pn.skipped.length,
      approximations: (pn.approximations || []).length,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Check Workflow-Net soundness for a Logic-Core document.
 * Runs per-process analysis.
 *
 * @param {object} lc - Logic-Core JSON
 * @param {object} options - { maxStates: number }
 * @returns {{ issues: Array<{rule, severity, message, process?}>, stats: object }}
 */
export function checkWorkflowNetSoundness(lc, options = {}) {
  const processes = lc.pools ? lc.pools : [lc];
  const allIssues = [];
  const allStats = {};

  for (const proc of processes) {
    const prefix = lc.pools ? `[${proc.name || proc.id}] ` : '';
    const pn = bpmnToPN(proc);
    const result = checkSoundness(pn, options);

    for (const issue of result.issues) {
      allIssues.push({
        ...issue,
        message: prefix + issue.message,
        process: proc.id,
      });
    }
    allStats[proc.id || 'default'] = result.stats;
  }

  return { issues: allIssues, stats: allStats };
}

export { bpmnToPN, checkSoundness };

// Firing primitives, exported verbatim (no behaviour change) for
// scripts/scenarios/enumerate.js. The scenario enumerator needs its own traversal loop —
// checkSoundness deduplicates markings, which is right for "is the sink reachable?" and
// wrong for "which distinct paths reach it?" — but it must fire transitions by exactly
// these semantics. The flattened graph it also needs travels on the net itself
// (`flatNodes`/`flatEdges` above), so there is no second flatten to drift.
export { getEnabledTransitions, fireTransition, encodeMarking };
