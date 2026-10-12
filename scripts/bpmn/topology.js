/**
 * BPMN Topology — Gateway Direction Inference, Topological Sort, Lane Ordering
 * Pre-processing steps before ELK layout.
 */

import { isGateway } from './types.js';

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

    if (n.has_join && outs <= 1 && ins > 1) {
      dirs.set(n.id, 'Converging');
    } else if (!n.has_join && outs > 1 && ins <= 1) {
      dirs.set(n.id, 'Diverging');
    } else if (outs > 1 && ins > 1) {
      dirs.set(n.id, 'Mixed');
    } else if (n.has_join) {
      dirs.set(n.id, 'Converging');
    } else {
      dirs.set(n.id, 'Diverging');
    }
  }
  return dirs;
}

/**
 * Which sequence flows of ONE process level the BPMN XML marks as their source's `default`, and
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
 *     `isDefault` gets its LAST outgoing flow as default;
 *   - every other outgoing flow of such a gateway gets a condition, its body `condition` or else
 *     `label` (or empty).
 * An explicit `condition` gives any flow a condition. An explicit `isDefault` makes the flow its
 * source's default, whatever the source (the last one wins, as in the serialiser it replaces).
 *
 * Pure: gateway directions are computed, not read from or written to `_direction`.
 * Called per process level; nested container edges are not serialised with either (the `condition`
 * and `isDefault` rows in `types.js`), so a caller asks only about a process's own edges.
 *
 * @returns {{ defaultBySource: Map<string,string>, conditionById: Map<string,string> }}
 */
export function resolveFlowSemantics(nodes = [], edges = []) {
  const dirs = gatewayDirections(nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const isConditionalSplit = (n) => !!n
    && (n.type === 'exclusiveGateway' || n.type === 'inclusiveGateway')
    && dirs.get(n.id) === 'Diverging';

  const defaultBySource = new Map();
  for (const e of edges) {
    if (e.isDefault) defaultBySource.set(e.source, e.id);
  }
  for (const n of nodes) {
    if (!isConditionalSplit(n) || defaultBySource.has(n.id)) continue;
    const outs = edges.filter((e) => e.source === n.id);
    if (outs.length > 1) defaultBySource.set(n.id, outs[outs.length - 1].id);
  }

  const defaultIds = new Set(defaultBySource.values());
  const conditionById = new Map();
  for (const e of edges) {
    const needsCondition = e.condition || (isConditionalSplit(byId.get(e.source)) && !defaultIds.has(e.id));
    if (needsCondition) conditionById.set(e.id, e.condition || e.label || '');
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
  for (const p of procs) {
    const lane = (p.lanes || []).find(l => Array.isArray(l.nodeIds) && l.nodeIds.includes(node.id));
    if (lane) return lane.id;
  }
  return undefined;
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
 * Pre-process a Logic-Core before ELK graph construction.
 */
export function preprocessLogicCore(lc, opts = {}) {
  const processes = lc.pools ? lc.pools : [lc];
  for (const proc of processes) {
    normalizeLaneAssignments(proc);
    sortNodesTopologically(proc);
    orderLanesByFlow(proc);
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
