/**
 * Graph-isomorphism — structural equality check for Logic-Core JSON.
 * Approximate: canonical sort by type sequence, no full VF2.
 * Sufficient for typical sample sizes (≤50 nodes).
 */

export function toAdjacencyList(lc) {
  // Format-tolerant: handles both the collaboration/pool format and the legacy flat format.
  //
  // Collaboration format (used by Logic-Core fixtures and pipeline input):
  //   { pools: [{ id, nodes: [...], edges: [...], lanes: [...] }] }
  //   nodes/edges live directly on the pool; lanes is a flat array of {id, name}.
  //
  // Legacy flat format (returned by bpmnToLogicCore / import.js):
  //   { id, name, nodes: [...], edges: [...], lanes: [...] }
  //   No pools wrapper; everything is top-level.

  if (lc.pools !== undefined) {
    // Collaboration/pool format.
    // Two sub-variants exist:
    //   (a) Pool-level nodes: pool.nodes + pool.edges + flat pool.lanes (Logic-Core project schema)
    //   (b) Lane-nested nodes: pool.lanes[i].nodes + top-level flows (test-internal phantom format)
    // Detect by checking whether the first pool has nodes directly or not.
    const nodes = [];
    const lanes = [];
    const edges = [];
    const pools = lc.pools || [];

    for (const pool of pools) {
      if (pool.nodes !== undefined) {
        // Sub-variant (a): nodes/edges live directly on the pool
        for (const node of (pool.nodes || [])) {
          nodes.push({ id: node.id, type: node.type });
        }
        for (const lane of (pool.lanes || [])) {
          lanes.push({ id: lane.id, poolId: pool.id });
        }
        for (const e of (pool.edges || [])) {
          edges.push({ source: e.source, target: e.target });
        }
      } else {
        // Sub-variant (b): nodes nested inside lanes
        for (const lane of (pool.lanes || [])) {
          lanes.push({ id: lane.id, poolId: pool.id });
          for (const node of (lane.nodes || [])) {
            nodes.push({ id: node.id, type: node.type });
          }
        }
      }
    }
    // Top-level flows (used in sub-variant (b) or messageFlows-free collaborations)
    for (const f of (lc.flows || [])) {
      edges.push({ source: f.source, target: f.target });
    }
    return { pools: pools.map(p => ({ id: p.id })), lanes, nodes, edges };
  }

  // Legacy flat format: { id, name, nodes: [...], edges: [...], lanes: [...] }
  // Wrap into a synthetic single-pool view for comparison purposes.
  const flatNodes = (lc.nodes || []).map(n => ({ id: n.id, type: n.type }));
  const flatEdges = (lc.edges || lc.flows || []).map(e => ({ source: e.source, target: e.target }));
  const flatLanes = (lc.lanes || []).map(l => ({ id: l.id, poolId: lc.id || 'flat' }));
  // If no lanes in legacy, use a single synthetic lane so lane count is at least 1 when nodes exist
  const lanes = flatLanes.length > 0 ? flatLanes : (flatNodes.length > 0 ? [{ id: 'default', poolId: lc.id || 'flat' }] : []);
  return {
    pools: [{ id: lc.id || 'flat' }],
    lanes,
    nodes: flatNodes,
    edges: flatEdges,
  };
}

export function canonicalSignature(lc) {
  const adj = toAdjacencyList(lc);
  const typeSequence = adj.nodes.map(n => n.type).sort().join(',');
  const edgeCount = adj.edges.length;
  const laneCount = adj.lanes.length;
  const poolCount = adj.pools.length;
  return `pools=${poolCount}|lanes=${laneCount}|edges=${edgeCount}|types=[${typeSequence}]`;
}

export function isStructurallyEqual(lcA, lcB) {
  const sigA = canonicalSignature(lcA);
  const sigB = canonicalSignature(lcB);
  if (sigA === sigB) return { equal: true, delta: null };

  const adjA = toAdjacencyList(lcA);
  const adjB = toAdjacencyList(lcB);

  return {
    equal: false,
    delta: {
      nodeCount: { a: adjA.nodes.length, b: adjB.nodes.length },
      edgeCount: { a: adjA.edges.length, b: adjB.edges.length },
      laneCount: { a: adjA.lanes.length, b: adjB.lanes.length },
      poolCount: { a: adjA.pools.length, b: adjB.pools.length },
      sigA, sigB,
    }
  };
}
