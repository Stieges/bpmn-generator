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
export function preprocessLogicCore(lc) {
  const processes = lc.pools ? lc.pools : [lc];
  for (const proc of processes) {
    normalizeLaneAssignments(proc);
    sortNodesTopologically(proc);
    orderLanesByFlow(proc);
  }
}
