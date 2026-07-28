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
  const outCount = {}, inCount = {};
  for (const e of edges) {
    outCount[e.source] = (outCount[e.source] || 0) + 1;
    inCount[e.target]  = (inCount[e.target]  || 0) + 1;
  }
  for (const n of nodes) {
    if (!isGateway(n.type)) continue;
    const outs = outCount[n.id] || 0;
    const ins  = inCount[n.id]  || 0;

    if (n.has_join && outs <= 1 && ins > 1) {
      n._direction = 'Converging';
    } else if (!n.has_join && outs > 1 && ins <= 1) {
      n._direction = 'Diverging';
    } else if (outs > 1 && ins > 1) {
      n._direction = 'Mixed';
    } else if (n.has_join) {
      n._direction = 'Converging';
    } else {
      n._direction = 'Diverging';
    }
  }
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
