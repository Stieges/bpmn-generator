/**
 * BPMN Topology — Gateway Direction Inference, Topological Sort, Lane Ordering
 * Pre-processing steps before ELK layout.
 */

import { isGateway, isActivity, isEvent, edgeFieldSpec, isArtifact } from './types.js';
import { CFG } from '../shared/utils.js';

/**
 * Infer gateway directions (Diverging/Converging/Mixed) based on edge counts.
 * OMG spec §10.5.1
 */
export function inferGatewayDirections(nodes, edges) {
  const dirs = gatewayDirections(nodes, edges);
  for (const n of nodes) if (dirs.has(n.id)) n._direction = dirs.get(n.id);
}

/** The direction `inferGatewayDirections` would assign, per gateway id — without writing it. */
function gatewayDirections(nodes, edges) {
  const outCount = {}, inCount = {};
  for (const e of edges) {
    outCount[e.source] = (outCount[e.source] || 0) + 1;
    inCount[e.target]  = (inCount[e.target]  || 0) + 1;
  }
  const dirs = new Map();
  for (const n of nodes) {
    if (!isGateway(n.type)) continue;
    const outs = outCount[n.id] || 0;
    const ins  = inCount[n.id]  || 0;

    // Degree wins over the has_join hint when the topology is unambiguous: a
    // multi-in / single-out gateway is Converging even when `has_join` is omitted
    // (otherwise resolveFlowSemantics treats it as a 1-out "split"
    // and emits an empty conditionExpression → bpmnlint label-required).
    if (outs > 1 && ins > 1) {
      dirs.set(n.id, 'Mixed');
    } else if (ins > 1 && outs <= 1) {
      dirs.set(n.id, 'Converging');
    } else if (outs > 1 && ins <= 1) {
      dirs.set(n.id, 'Diverging');
    } else if (n.has_join) {
      dirs.set(n.id, 'Converging');
    } else {
      dirs.set(n.id, 'Diverging');
    }
  }
  return dirs;
}

/**
 * Which sequence flows of ONE flow-element container — a process, or an expanded or collapsed
 * subprocess at any depth — the BPMN XML marks as their source's `default`, and
 * which carry a `<bpmn:conditionExpression>` (with its body) — the one place both are decided.
 *
 * `bpmn-xml.js` writes exactly this, and `svg.js` draws its default slash and conditional diamond
 * from exactly this, so the two renderers cannot disagree about a flow's semantics (#84, #85). They
 * used to: the serialiser inferred a default for an unmarked diverging XOR/OR gateway that the SVG
 * never drew, and the SVG drew a conditional diamond from `isConditional` for which the XML carried
 * no condition.
 *
 * Two inferences live here, both pre-existing serialiser behaviour (removal is queued as plan
 * "Root fix", backlog item 7, in the edge-field rows of `types.js`):
 *   - a diverging exclusive/inclusive gateway with more than one outgoing flow and none marked
 *     `isDefault` gets its LAST outgoing flow WITHOUT an authored condition as default (none when
 *     every outgoing flow has one);
 *   - every other outgoing flow of such a gateway gets a condition, its body `condition` or else
 *     `label` (or empty).
 * An explicit `condition` gives any flow a condition. A flow marked `isConditional` with a `label`
 * but no `condition` gets the label as its condition body (owner decision on #84): the author said
 * "conditional" and named the condition, and OMG has no conditional flow without an expression. An
 * `isConditional` flow with neither gets none — there is nothing to write. An explicit `isDefault`
 * makes the flow its source's default, whatever the source (the last one wins, as in the
 * serialiser it replaces).
 *
 * Two limits on conditions, both OMG's (review of #84):
 *   - only a flow leaving an Activity or an exclusive, inclusive or complex Gateway gets one
 *     (§10.3.1; the `condition` row's `allowed`) — a parallel or event-based gateway's flows and an
 *     event's flows get none, whatever was authored;
 *   - a default flow gets none: its condition is ignored (§10.5), so the default wins — which can
 *     only happen for an AUTHORED `isDefault`, because the inferred default is chosen only among
 *     flows without an authored condition, and is not inferred at all when every flow has one.
 * S15 reports an authored condition either limit drops.
 *
 * Pure: gateway directions are computed, not read from or written to `_direction`.
 * Called once per container with that container's own nodes and edges — the process in
 * `buildProcess`, every subprocess in `buildFlowNode`'s child branch, and the same two levels in
 * `svg.js` — so a flow's semantics do not depend on its nesting depth.
 *
 * @returns {{ defaultBySource: Map<string,string>, conditionById: Map<string,string> }}
 */
export function resolveFlowSemantics(nodes = [], edges = []) {
  const dirs = gatewayDirections(nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const isConditionalSplit = (n) => !!n
    && (n.type === 'exclusiveGateway' || n.type === 'inclusiveGateway')
    && dirs.get(n.id) === 'Diverging';

  // A condition the AUTHOR wrote: `condition`, or `isConditional` with a label.
  const authoredCondition = (e) => !!(e.condition || (e.isConditional && e.label));

  const defaultBySource = new Map();
  for (const e of edges) {
    if (e.isDefault) defaultBySource.set(e.source, e.id);
  }
  // The inferred default is chosen only among flows WITHOUT an authored condition — the last one,
  // as before, when it is unconditioned, else the last unconditioned one, else none. An inferred
  // default never overrides a condition the author wrote; "the default wins" is reserved for an
  // authored `isDefault` (review of #84: two fully conditioned branches lost the second condition).
  for (const n of nodes) {
    if (!isConditionalSplit(n) || defaultBySource.has(n.id)) continue;
    const outs = edges.filter((e) => e.source === n.id);
    if (outs.length < 2) continue;
    const free = outs.filter((e) => !authoredCondition(e));
    if (free.length > 0) defaultBySource.set(n.id, free[free.length - 1].id);
  }

  const defaultIds = new Set(defaultBySource.values());
  const conditionSources = edgeFieldSpec('condition').allowed;
  const outCount = {};
  for (const e of edges) outCount[e.source] = (outCount[e.source] || 0) + 1;
  const conditionById = new Map();
  for (const e of edges) {
    const source = byId.get(e.source);
    if (!source || !conditionSources.has(source.type) || defaultIds.has(e.id)) continue;
    // Inferred conditions only on a real split (≥2 outs). A lone out of a
    // mis-tagged "Diverging" join must not get an empty FormalExpression.
    const inferredSplit = isConditionalSplit(source) && (outCount[source.id] || 0) >= 2;
    const needsCondition = authoredCondition(e) || inferredSplit;
    if (!needsCondition) continue;
    const body = e.condition || e.label || '';
    // Never emit an empty conditionExpression — bpmnlint label-required treats
    // the element's presence as "has a condition" and then demands a name.
    if (!body && !authoredCondition(e)) continue;
    conditionById.set(e.id, body);
  }
  return { defaultBySource, conditionById };
}

/**
 * Sort nodes in topological happy-path order.
 * ELK's Sugiyama respects input order for layer assignment (model order).
 */
export function sortNodesTopologically(proc) {
  const nodes = proc.nodes || [];
  const edges = proc.edges || [];
  if (nodes.length === 0) return;

  const outgoing = {};
  for (const e of edges) {
    if (!outgoing[e.source]) outgoing[e.source] = [];
    outgoing[e.source].push(e);
  }

  const visited = new Set();
  const sorted = [];
  const queue = [];

  for (const n of nodes) {
    if (n.type === 'startEvent') queue.push(n.id);
  }

  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    sorted.push(id);

    const outs = (outgoing[id] || []).sort((a, b) => {
      if (a.isHappyPath && !b.isHappyPath) return -1;
      if (!a.isHappyPath && b.isHappyPath) return 1;
      return 0;
    });
    for (const e of outs) {
      if (!visited.has(e.target)) queue.push(e.target);
    }
  }

  for (const n of nodes) {
    if (!visited.has(n.id)) sorted.push(n.id);
  }

  const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]));
  proc.nodes = sorted.map(id => nodeMap[id]).filter(Boolean);
}

/**
 * Reorder lanes based on process flow position.
 * Start-event lanes stay first (top) so the process reads top-left → right.
 */
export function orderLanesByFlow(proc) {
  const lanes = proc.lanes || [];
  const nodes = proc.nodes || [];
  if (lanes.length <= 1) return;

  const nodeIndex = {};
  nodes.forEach((n, i) => { nodeIndex[n.id] = i; });

  const laneScores = {};
  const laneStartCount = {};

  for (const lane of lanes) {
    const laneNodes = nodes.filter(n => n.lane === lane.id);
    if (laneNodes.length === 0) {
      laneScores[lane.id] = 9999;
      laneStartCount[lane.id] = 0;
      continue;
    }
    laneScores[lane.id] = laneNodes.reduce((s, n) => s + (nodeIndex[n.id] || 0), 0) / laneNodes.length;
    laneStartCount[lane.id] = laneNodes.filter(n => n.type === 'startEvent').length;
  }

  proc.lanes = [...lanes].sort((a, b) => {
    if (laneStartCount[a.id] > 0 && laneStartCount[b.id] === 0) return -1;
    if (laneStartCount[b.id] > 0 && laneStartCount[a.id] === 0) return 1;
    return laneScores[a.id] - laneScores[b.id];
  });
}

/**
 * Vertically order a diverging gateway's outgoing edges by target lane.
 *
 * ELK `considerModelOrder: NODES_AND_EDGES` uses edge list order when placing
 * branches: earlier outs tend to sit above later ones. After lanes are ordered
 * (start lane on top), sort each gateway's outs so upper-lane targets come
 * first and lower-lane / cross-lane sinks come last — the visual "swap" that
 * keeps same-band continuations high and deep-lane chains exiting downward.
 * Happy-path edges still win within the same lane band.
 */
export function orderGatewayExitsByTargetLane(proc) {
  const lanes = proc.lanes || [];
  const nodes = proc.nodes || [];
  const edges = proc.edges || [];
  if (lanes.length === 0 || edges.length < 2) return;

  const laneRank = Object.fromEntries(lanes.map((l, i) => [l.id, i]));
  const nodeLane = Object.fromEntries(nodes.map(n => [n.id, n.lane]));
  const outgoing = {};
  const outCount = {};
  for (const e of edges) {
    outCount[e.source] = (outCount[e.source] || 0) + 1;
    if (!outgoing[e.source]) outgoing[e.source] = [];
    outgoing[e.source].push(e);
  }

  /**
   * BFS: { steps, laneRank } of the first node in a strictly lower lane, or null.
   * A branch that drops into the next band (bypass) should sit below one that
   * only later reaches a far band (oti) — otherwise its vertical handoff braids
   * through the sibling.
   */
  const firstLowerLane = (startId, fromRank) => {
    const q = [{ id: startId, steps: 0 }];
    const seen = new Set([startId]);
    while (q.length) {
      const { id, steps } = q.shift();
      const r = laneRank[nodeLane[id]];
      if (r != null && r > fromRank) return { steps, rank: r };
      for (const e of outgoing[id] || []) {
        if (seen.has(e.target)) continue;
        seen.add(e.target);
        q.push({ id: e.target, steps: steps + 1 });
      }
    }
    return null;
  };

  const rankOf = (edge) => {
    const srcRank = laneRank[nodeLane[edge.source]] ?? 0;
    const lane = nodeLane[edge.target];
    const laneIdx = lane != null && laneRank[lane] != null ? laneRank[lane] : 999;
    const lower = firstLowerLane(edge.target, srcRank);
    // Nearer/lower band dive → larger score → later in list → bottom of stack.
    const dive = lower
      ? (20 - Math.min(lower.rank, 19)) * 20 + Math.max(0, 30 - lower.steps)
      : 0;
    const happy = edge.isHappyPath ? 0 : 1;
    return dive * 10 + laneIdx * 2 + happy;
  };

  // Stable partition: keep relative order of non-split edges; within each
  // diverging source, sort that source's outs by target-lane rank.
  const bySource = new Map();
  for (const e of edges) {
    if ((outCount[e.source] || 0) < 2) continue;
    const src = nodes.find(n => n.id === e.source);
    if (!src || !isGateway(src.type)) continue;
    if (!bySource.has(e.source)) bySource.set(e.source, []);
    bySource.get(e.source).push(e);
  }
  if (!bySource.size) return;

  const sortedOuts = new Map();
  for (const [src, outs] of bySource) {
    sortedOuts.set(src, [...outs].sort((a, b) => rankOf(a) - rankOf(b) || 0));
  }

  const used = new Set();
  const next = [];
  for (const e of edges) {
    if (!sortedOuts.has(e.source)) {
      next.push(e);
      continue;
    }
    if (used.has(e.source)) continue;
    used.add(e.source);
    next.push(...sortedOuts.get(e.source));
  }
  proc.edges = next;
}

/**
 * Nodes that only appear via a cross-lane handoff into a lane with no start
 * (e.g. Support) get ELK `layerConstraint: LAST` so a short sink path is not
 * parked under a longer parallel chain in an upper lane.
 */
export function markCrossLaneSinksLast(proc) {
  const nodes = proc.nodes || [];
  const edges = proc.edges || [];
  if (!nodes.length) return;
  const laneOf = Object.fromEntries(nodes.map((n) => [n.id, n.lane]));
  const laneHasStart = {};
  for (const n of nodes) {
    if (n.type === 'startEvent' && n.lane) laneHasStart[n.lane] = true;
  }
  // Only the bottom-most start-less lane (true late sink, e.g. Support) —
  // not every work lane without a start.
  let lastSink = null;
  for (const l of proc.lanes || []) {
    if (l.id && !laneHasStart[l.id]) lastSink = l.id;
  }
  const sinkLanes = lastSink ? new Set([lastSink]) : new Set();
  if (!sinkLanes.size) return;

  const force = new Set();
  for (const e of edges) {
    const sl = laneOf[e.source], tl = laneOf[e.target];
    if (sl != null && tl != null && sl !== tl && sinkLanes.has(tl)) force.add(e.target);
  }
  // Descendants still in a sink lane (End after Task_SN).
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of edges) {
      if (!force.has(e.source)) continue;
      if (!sinkLanes.has(laneOf[e.target])) continue;
      if (force.has(e.target)) continue;
      force.add(e.target);
      grew = true;
    }
  }
  for (const n of nodes) {
    if (force.has(n.id)) n._forceLastLayer = true;
  }
}

/** Above this participant count the exact search is replaced by a heuristic. */
const EXACT_MAX = 8;

/** Heap's algorithm — every permutation of `arr`, handed to `visit`. */
function permute(arr, visit, k = arr.length) {
  if (k === 1) { visit(arr); return; }
  for (let i = 0; i < k; i++) {
    permute(arr, visit, k - 1);
    const j = k % 2 === 0 ? i : 0;
    [arr[j], arr[k - 1]] = [arr[k - 1], arr[j]];
  }
}

/**
 * Order the participants of a collaboration so that the ones that talk to each
 * other end up next to each other.
 *
 * Participants are stacked vertically, so a message flow between participants
 * that are N apart in the stack has to cross N-1 uninvolved pools. Crossing a
 * pool reads as a participation that does not exist, so the sum of those
 * crossings is what we minimise:
 *
 *     cost(order) = Σ over message flows of max(0, |pos(a) - pos(b)| - 1)
 *
 * Expanded pools and black-box participants are ordered TOGETHER — keeping the
 * black boxes at the end (the previous behaviour) is what put an external
 * register 1140 px away from its only partner.
 *
 * Barycentre seed plus adjacent-swap local search. Deterministic: ties keep the
 * declared order, and the result is only adopted if it beats the declared one.
 * Writes the id order to `lc._participantOrder`; layout.js and coordinates.js
 * read it. Sorting the arrays themselves would not help, because expanded and
 * collapsed participants live in two of them.
 *
 * @param {object} lc Logic-Core (mutated)
 */
export function orderParticipantsByMessageFlow(lc) {
  const ids = [
    ...(lc.pools || []).map(p => p.id),
    ...(lc.collapsedPools || []).map(p => p.id),
  ];
  if (ids.length < 3) { lc._participantOrder = ids; return; }

  // Which participant owns a message flow endpoint? Endpoints are node ids for
  // expanded pools and the participant id itself for black boxes.
  const ownerOf = {};
  for (const p of (lc.pools || [])) {
    for (const n of (p.nodes || [])) ownerOf[n.id] = p.id;
  }
  for (const id of ids) ownerOf[id] ??= id;

  const links = [];
  for (const mf of (lc.messageFlows || [])) {
    const a = ownerOf[mf.source];
    const b = ownerOf[mf.target];
    if (a && b && a !== b) links.push([a, b]);
  }
  if (links.length === 0) { lc._participantOrder = ids; return; }

  const cost = (order) => {
    const pos = {};
    order.forEach((id, i) => { pos[id] = i; });
    return links.reduce((s, [a, b]) => s + Math.max(0, Math.abs(pos[a] - pos[b]) - 1), 0);
  };

  const declaredIndex = {};
  ids.forEach((id, i) => { declaredIndex[id] = i; });

  // Up to EXACT_MAX participants the optimum is simply searched for: 8! is
  // 40320 orders, a few milliseconds, and it is provably the best answer.
  // Local search was tried first and is not good enough here — on the
  // six-participant reference collaboration both neighbour swaps and
  // relocation moves settle at 4 crossings where 2 exists.
  let best = ids;
  let bestCost = cost(ids);
  let bestDrift = 0;

  const consider = (order) => {
    const c = cost(order);
    // Among equally good orders keep the one closest to the declared one, so
    // the result stays predictable for whoever wrote the model.
    const drift = order.reduce((s, id, i) => s + Math.abs(declaredIndex[id] - i), 0);
    if (c < bestCost || (c === bestCost && drift < bestDrift)) {
      best = [...order];
      bestCost = c;
      bestDrift = drift;
    }
  };
  bestDrift = 0;

  if (ids.length <= EXACT_MAX) {
    permute([...ids], consider);
  } else {
    // Larger collaborations: barycentre seed plus relocation moves.
    const partners = {};
    for (const [a, b] of links) {
      (partners[a] ??= []).push(b);
      (partners[b] ??= []).push(a);
    }
    const score = id => {
      const ps = partners[id];
      return ps?.length ? ps.reduce((s, p) => s + declaredIndex[p], 0) / ps.length : declaredIndex[id];
    };
    consider([...ids].sort((a, b) => (score(a) - score(b)) || (declaredIndex[a] - declaredIndex[b])));
    for (let pass = 0; pass < ids.length; pass++) {
      const before = bestCost;
      for (let i = 0; i < ids.length; i++) {
        for (let j = 0; j < ids.length; j++) {
          if (i === j) continue;
          const candidate = [...best];
          candidate.splice(j, 0, candidate.splice(i, 1)[0]);
          consider(candidate);
        }
      }
      if (bestCost === before) break;
    }
  }

  lc._participantOrder = best;
}

/**
 * Identify nodes on the happy path (connected by isHappyPath edges).
 * Returns a Set of node IDs.
 */
export function identifyHappyPathNodes(nodes, edges) {
  const happyEdges = edges.filter(e => e.isHappyPath);
  if (happyEdges.length === 0) return new Set();
  const ids = new Set();
  for (const e of happyEdges) {
    ids.add(e.source);
    ids.add(e.target);
  }
  return ids;
}

/**
 * Resolve which lane a node belongs to — READ-ONLY, understands BOTH assignment
 * formats. Format A (`node.lane`) wins when present; otherwise the lane objects'
 * `nodeIds` arrays (Format B) are searched. Multi-pool aware.
 *
 * This lives here, next to normalizeLaneAssignments(), because this module owns
 * the knowledge about the two lane-assignment formats. It must be the ONLY place
 * that resolves lane membership — otherwise the same metric gets two different
 * answers depending on which module asks (that was a real defect).
 *
 * It cannot live in redesign-core.js: optimize.js needs it too, and
 * redesign-core → rules → optimize already exists, so importing back from
 * redesign-core would close an import cycle.
 *
 * @param {object} container - Logic-Core, or a single process/pool
 * @param {object} node
 * @returns {string|undefined} lane id
 */
export function resolveLaneId(container, node) {
  if (node.lane) return node.lane;
  if (!container) return undefined;
  const procs = container.pools ? container.pools : [container];
  // Nested lanes (`children`) carry `nodeIds` too.
  const find = (lanes) => {
    for (const l of lanes || []) {
      if (Array.isArray(l.nodeIds) && l.nodeIds.includes(node.id)) return l.id;
      const inner = find(l.children);
      if (inner) return inner;
    }
    return undefined;
  };
  for (const p of procs) {
    const id = find(p.lanes);
    if (id) return id;
  }
  return undefined;
}

/**
 * Leaf lanes of a process (nested `children` walked) with no element at its top level — a lane is
 * a role, and one without a step shows a role that does nothing in the diagram. Membership through
 * resolveLaneId; artifacts do not count as steps. The one definition for rule M12 and the
 * extraction-quality comparison (robustness/reference-compare.js).
 * @returns {object[]} the empty lane objects, in declaration order
 */
export function emptyLeafLanes(proc) {
  const used = new Set((proc.nodes || []).filter(n => !isArtifact(n.type)).map(n => resolveLaneId(proc, n)).filter(Boolean));
  const empty = [];
  const walk = (lanes) => {
    for (const l of lanes || []) {
      if (l.children?.length) walk(l.children);
      else if (!used.has(l.id)) empty.push(l);
    }
  };
  walk(proc.lanes);
  return empty;
}

/**
 * Normalize lane assignments: convert Format B (lane.nodeIds) → Format A (node.lane).
 * Format A (node.lane) is what the layout engine reads for ELK partitioning.
 * Format B (lane.nodeIds) is what the LLM typically generates.
 * Existing node.lane values (Format A) are NOT overwritten.
 */
export function normalizeLaneAssignments(proc) {
  const lanes = proc.lanes || [];
  const nodes = proc.nodes || [];
  if (lanes.length === 0 || nodes.length === 0) return;

  const nodeIdToLane = {};
  for (const lane of lanes) {
    if (!lane.nodeIds) continue;
    for (const nodeId of lane.nodeIds) {
      nodeIdToLane[nodeId] = lane.id;
    }
  }

  for (const node of nodes) {
    if (!node.lane && nodeIdToLane[node.id]) {
      node.lane = nodeIdToLane[node.id];
    }
  }
}

/**
 * Give every sequence-flow edge without an id a deterministic one, in place.
 *
 * `flow_<source>_<target>`; on a collision with any id anywhere in the document (nodes, edges,
 * pools, lanes, definitions, message flows, associations) or with an id generated earlier in this
 * run, `_2`, `_3`, ... in document order. An id the author gave is never touched. Edges whose
 * source/target are not strings are left alone for validation to report.
 *
 * Idempotent. This is the only fallback for a MISSING edge id (other code mints ids for edges it
 * creates itself): layout, serialisation and rendering all read `edge.id` as-is, so a missing id
 * downstream is a bug, not a case to handle (#64).
 * Message flows and associations require an `id` in the schema and need no such step.
 */
export function assignEdgeIds(lc) {
  const used = new Set();
  const collect = (v) => {
    if (Array.isArray(v)) { v.forEach(collect); return; }
    if (v && typeof v === 'object') {
      if (typeof v.id === 'string') used.add(v.id);
      for (const k of Object.keys(v)) collect(v[k]);
    }
  };
  collect(lc);

  const assign = (v) => {
    if (Array.isArray(v)) { v.forEach(assign); return; }
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v.edges)) {
      for (const e of v.edges) {
        if (!e || typeof e !== 'object') continue;
        if (e.id !== undefined && e.id !== null && e.id !== '') continue;
        if (typeof e.source !== 'string' || typeof e.target !== 'string') continue;
        const base = `flow_${e.source}_${e.target}`;
        let id = base;
        for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
        used.add(id);
        e.id = id;
      }
    }
    for (const k of Object.keys(v)) if (k !== 'edges') assign(v[k]);
  };
  assign(lc);
  return lc;
}

/**
 * Give a single-process Logic-Core (no `pools`) that has no `id` a deterministic one, in place.
 *
 * The schema's `SingleProcess` branch makes `id` optional, unlike `Pool`; everything downstream
 * (the process element, `Participant_<id>`/`processRef`, the plane's `bpmnElement`, lane
 * coordinates, DOT cluster names, the scenario pool label) reads `proc.id` as-is, and a missing
 * one surfaced as the string "undefined" in six places (#37). `Process_1`, then `Process_2`, ...
 * on a collision with any id in the document. A pooled document is left alone (a `Pool`
 * requires its id). Idempotent; like `assignEdgeIds` the only fallback — downstream code has none.
 */
export function assignProcessId(lc) {
  if (!lc || typeof lc !== 'object' || lc.pools) return lc;
  if (typeof lc.id === 'string' && lc.id !== '') return lc;
  const used = new Set();
  const collect = (v) => {
    if (Array.isArray(v)) { v.forEach(collect); return; }
    if (v && typeof v === 'object') {
      if (typeof v.id === 'string') used.add(v.id);
      for (const k of Object.keys(v)) collect(v[k]);
    }
  };
  collect(lc);
  let id = 'Process_1';
  for (let n = 2; used.has(id); n++) id = `Process_${n}`;
  lc.id = id;
  return lc;
}

/**
 * Pure form of `assignProcessId` for the public entries that take a Logic-Core directly
 * (`generateBpmnXml`, `logicCoreToDot`): the caller's object is returned untouched when it needs
 * nothing, and otherwise a shallow copy carries the id.
 */
export function withProcessId(lc) {
  if (!lc || typeof lc !== 'object' || lc.pools || (typeof lc.id === 'string' && lc.id !== '')) return lc;
  return assignProcessId({ ...lc });
}

/** Pure form of `assignEdgeIds`: returns a deep copy, the caller's object is not touched. */
export function normalizeEdgeIds(lc) {
  return assignEdgeIds(JSON.parse(JSON.stringify(lc)));
}

/**
 * Collect every node/edge/lane/pool/message-flow id already used in `lc`
 * (including nested subprocess children). Used by auto-join id allocation.
 */
function collectAllIds(lc) {
  const ids = new Set();
  const walk = (nodes, edges) => {
    for (const n of nodes || []) {
      if (n.id) ids.add(n.id);
      if (n.nodes || n.edges) walk(n.nodes, n.edges);
    }
    for (const e of edges || []) if (e.id) ids.add(e.id);
  };
  const procs = lc.pools ? lc.pools : [lc];
  for (const p of procs) {
    if (p.id) ids.add(p.id);
    walk(p.nodes, p.edges);
    for (const l of p.lanes || []) if (l.id) ids.add(l.id);
  }
  for (const cp of lc.collapsedPools || []) if (cp.id) ids.add(cp.id);
  for (const mf of lc.messageFlows || []) if (mf.id) ids.add(mf.id);
  return ids;
}

function allocateId(used, prefix) {
  if (!used.has(prefix)) {
    used.add(prefix);
    return prefix;
  }
  let i = 2;
  while (used.has(`${prefix}_${i}`)) i++;
  const id = `${prefix}_${i}`;
  used.add(id);
  return id;
}

/**
 * bpmnlint `fake-join`: an Activity or Event with more than one incoming sequence
 * flow. Insert an exclusive converging gateway in front of each such node and
 * rewire the incoming edges through it. Exclusive (not parallel) — multi-in
 * nodes in this convention are XOR rework/merge joins; AND joins stay authored.
 *
 * Mutates `container` in place. Recurses into expanded subprocess children.
 *
 * @returns {number} how many join gateways were inserted
 */
export function insertAutoJoinGateways(container, usedIds) {
  let inserted = 0;
  const nodes = container.nodes || [];
  const edges = container.edges || (container.edges = []);

  for (const n of nodes) {
    if (n.nodes || n.edges) inserted += insertAutoJoinGateways(n, usedIds);
  }

  const incoming = new Map();
  for (const e of edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, []);
    incoming.get(e.target).push(e);
  }

  // Snapshot targets that need a join — rewiring mutates `edges`.
  const victims = nodes.filter((n) => {
    if (isGateway(n.type)) return false;
    if (!isActivity(n.type) && !isEvent(n.type)) return false;
    return (incoming.get(n.id) || []).length > 1;
  });

  for (const n of victims) {
    const ins = incoming.get(n.id) || [];
    if (ins.length <= 1) continue;
    const joinId = allocateId(usedIds, `gw_join_${n.id}`);
    const flowId = allocateId(usedIds, `flow_${joinId}_${n.id}`);
    const lane = n.lane;
    nodes.push({
      id: joinId,
      type: 'exclusiveGateway',
      name: '',
      has_join: true,
      ...(lane !== undefined ? { lane } : {}),
    });
    // Format B: Lane.nodeIds
    for (const l of container.lanes || []) {
      if (Array.isArray(l.nodeIds) && l.nodeIds.includes(n.id) && !l.nodeIds.includes(joinId)) {
        l.nodeIds.push(joinId);
      }
    }
    for (const e of ins) e.target = joinId;
    edges.push({ id: flowId, source: joinId, target: n.id });
    inserted++;
  }
  return inserted;
}

/**
 * Pre-process a Logic-Core before ELK graph construction.
 */
export function preprocessLogicCore(lc, opts = {}) {
  // Opt-in: default off so upstream fixtures/hashes stay stable. Pass
  // autoJoinGateways: true (or CFG.layout.autoJoinGateways / CLI) to enable.
  const autoJoin = opts.autoJoinGateways ?? (CFG.layout?.autoJoinGateways === true);
  if (autoJoin) {
    const used = collectAllIds(lc);
    const processes = lc.pools ? lc.pools : [lc];
    for (const proc of processes) insertAutoJoinGateways(proc, used);
  }
  const processes = lc.pools ? lc.pools : [lc];
  for (const proc of processes) {
    normalizeLaneAssignments(proc);
    sortNodesTopologically(proc);
    orderLanesByFlow(proc);
    orderGatewayExitsByTargetLane(proc);
    markCrossLaneSinksLast(proc);
  }
  if (opts.poolOrder === 'declared') {
    lc._participantOrder = [
      ...(lc.pools || []).map(p => p.id),
      ...(lc.collapsedPools || []).map(p => p.id),
    ];
  } else {
    orderParticipantsByMessageFlow(lc);
  }
}
