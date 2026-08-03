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
 *   ⚠️  OR gateways → warning only (not formally verifiable in classical WF-nets)
 *   ❌ Event-Based Gateways → skipped (race conditions)
 *   ❌ Timer/Signal Events → skipped (external triggers)
 *
 * Reference: van der Aalst, "Workflow Nets" (1998), "Soundness of WF-Nets" (2011)
 */

import { isGateway } from './types.js';

// ═══════════════════════════════════════════════════════════════════════
// BPMN → Petri-Net Conversion
// ═══════════════════════════════════════════════════════════════════════

/**
 * Convert a Logic-Core process to a Place/Transition-Net.
 *
 * Model:
 *   - Each BPMN node → a Transition
 *   - Each SequenceFlow → a Place (between source-transition and target-transition)
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
 * @param {object} proc - Process with nodes and edges
 * @returns {{ places, transitions, arcs, initialMarking, sinkPlace, orGateways, skipped }}
 */
function bpmnToPN(proc) {
  const nodes = proc.nodes || [];
  const edges = proc.edges || [];

  const places = new Map();     // placeId → { id, label }
  const transitions = new Map(); // transId → { id, label, bpmnNodeId, role? }
  const arcs = [];               // { from, to, type: 'P→T' | 'T→P' }
  const orGateways = [];
  const skipped = [];

  // The flattened views: every node at every nesting level, every edge at every nesting level.
  const flatNodes = flattenNodes(nodes);
  const flatEdges = flattenEdges(nodes, edges);

  // Create places for EVERY sequence flow, at every nesting level, in one pass before any
  // scope is built. Every arc-building branch below guards with `places.has(...)`, so a place
  // minted lazily — only once its own scope is entered — would make those guards silently drop
  // arcs rather than fail. Creating them all up front is what keeps the guards honest. The only
  // places minted later are a container's own two (`buildContainer`), and those are created
  // before the arcs that reference them.
  for (const edge of flatEdges) {
    const placeId = `p_${edge.source}_${edge.target}`;
    places.set(placeId, { id: placeId, label: edge.label || '' });
  }

  // The process-level source and sink place.
  const sourcePlace = 'p_source';
  const sinkPlace = 'p_sink';
  places.set(sourcePlace, { id: sourcePlace, label: 'source' });
  places.set(sinkPlace, { id: sinkPlace, label: 'sink' });

  // The process itself is just the outermost scope: its start events draw from `p_source` and
  // its end events produce on `p_sink`, exactly as a subprocess's do from its own pair.
  buildScope(proc, sourcePlace, sinkPlace, { places, transitions, arcs, orGateways, skipped, flatEdges });


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
  // `flatNodes` lists a container BEFORE its children, and the container IS in the list — the
  // same parent-then-children shape `di-check.js` and `coordinates.js` already use. It used to
  // be replaced by its children, which meant `scripts/scenarios/` could not name the container
  // at all: it walks `flatNodes` to decide which pool owns a node (`collaboration.js`) and to
  // build the id→name index behind every human-facing trace (`format.js`). A message flow or a
  // scenario step naming a subprocess had nothing to resolve against.
  return {
    places, transitions, arcs, initialMarking, sinkPlace, sourcePlace, orGateways, skipped,
    flatNodes, flatEdges,
  };
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
 * @param {{places, transitions, arcs, orGateways, skipped, flatEdges}} ctx
 */
function buildScope(container, scopeSource, scopeSink, ctx) {
  const { places, transitions, arcs, orGateways, skipped, flatEdges } = ctx;

  for (const node of container.nodes || []) {
    // Skip elements that don't participate in control flow
    if (node.type === 'dataObjectReference' || node.type === 'dataStoreReference' ||
        node.type === 'textAnnotation' || node.type === 'group') {
      skipped.push({ id: node.id, reason: 'artifact' });
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
      connectTransition(tId, node.id, flatEdges, places, arcs);
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
            const inPlace = `p_${ie.source}_${ie.target}`;
            arcs.push({ from: inPlace, to: tId, type: 'P→T' });
          }
          // This transition → the specific outgoing place
          const outPlace = `p_${outEdges[i].source}_${outEdges[i].target}`;
          arcs.push({ from: tId, to: outPlace, type: 'T→P' });
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
        const inPlace = `p_${inEdges[i].source}_${inEdges[i].target}`;
        if (places.has(inPlace)) {
          arcs.push({ from: inPlace, to: tId, type: 'P→T' });
        }

        // All outgoing places
        for (const oe of outEdges) {
          const outPlace = `p_${oe.source}_${oe.target}`;
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
    connectTransition(tId, node.id, flatEdges, places, arcs);

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
 * rather than by convention: `references/input-schema.json` constrains `Node.id` to
 * `^[a-zA-Z_][a-zA-Z0-9_-]*$`, so no node id can contain `#`. Every other net id
 * (`p_<src>_<tgt>`, `t_<id>`, `t_<id>_choice_<i>`, `t_<id>_merge_<i>`, and downstream
 * `pmsg_<mfId>`, `<poolId>::`, `<tId>__recv_<mfId>`) is assembled from node ids and ASCII-word
 * literals. The two id spaces therefore cannot intersect.
 *
 * Only the container's OWN two transitions carry `#`. Ordinary transitions inside a container
 * keep their plain names, because `scripts/scenarios/format.js`'s `CHOICE_TRANSITION_RE`
 * (`/^t_(.+)_choice_(\d+)$/`) has to keep matching a gateway that happens to live inside a
 * subprocess — every decision-label recovery path depends on it.
 */
function buildContainer(node, ctx) {
  const { places, transitions, arcs, skipped, flatEdges } = ctx;

  const label = node.name || node.id;
  const children = node.nodes || [];
  const hasStart = children.some(n => n.type === 'startEvent');
  const hasEnd = children.some(n => n.type === 'endEvent');

  // A container without an inner start or an inner end has no well-defined entry or exit
  // marking, so there is nothing to route a token through. Fall back to the atomic treatment
  // (one transition, wired to the outer edges) and DISCLOSE the under-model rather than let it
  // pass as a faithful translation — `scripts/scenarios/format.js` renders a non-artifact skip
  // reason as an explicit "not modelled at all" note. Rejecting such input in S11 instead would
  // be a new input restriction, which is a separate decision from this translation fix.
  if (!hasStart || !hasEnd) {
    const tId = `t_${node.id}`;
    transitions.set(tId, { id: tId, label, bpmnNodeId: node.id });
    connectTransition(tId, node.id, flatEdges, places, arcs);
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

  if (inEdges.length > 1) {
    // One entry transition per incoming edge, each consuming ONLY its own place. A single
    // transition consuming all of them would demand a token on every incoming flow at once —
    // AND semantics, the exact defect the implicit-merge branch in `buildScope` exists to fix
    // for plain nodes.
    for (let i = 0; i < inEdges.length; i++) {
      const tId = `t_${node.id}#enter#${i}`;
      transitions.set(tId, { id: tId, label: `${label}[enter${i}]`, bpmnNodeId: node.id, role: 'enter' });
      const inPlace = `p_${inEdges[i].source}_${inEdges[i].target}`;
      if (places.has(inPlace)) {
        arcs.push({ from: inPlace, to: tId, type: 'P→T' });
      }
      arcs.push({ from: tId, to: scopeSource, type: 'T→P' });
    }
  } else {
    const tId = `t_${node.id}#enter`;
    transitions.set(tId, { id: tId, label: `${label}[enter]`, bpmnNodeId: node.id, role: 'enter' });
    for (const ie of inEdges) {
      const inPlace = `p_${ie.source}_${ie.target}`;
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
    const outPlace = `p_${oe.source}_${oe.target}`;
    if (places.has(outPlace)) {
      arcs.push({ from: exitId, to: outPlace, type: 'T→P' });
    }
  }

  buildScope(node, scopeSource, scopeSink, ctx);
}

function connectTransition(tId, nodeId, edges, places, arcs) {
  const inEdges = edges.filter(e => e.target === nodeId);
  const outEdges = edges.filter(e => e.source === nodeId);

  for (const ie of inEdges) {
    const placeId = `p_${ie.source}_${ie.target}`;
    if (places.has(placeId)) {
      arcs.push({ from: placeId, to: tId, type: 'P→T' });
    }
  }
  for (const oe of outEdges) {
    const placeId = `p_${oe.source}_${oe.target}`;
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
    if (n.nodes?.length) out.push(...flattenNodes(n.nodes));
  }
  return out;
}

/**
 * Flatten edges: include container-internal edges at every nesting level.
 */
function flattenEdges(nodes, edges) {
  const result = [...edges];
  for (const n of nodes || []) {
    if (n.nodes?.length) {
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
