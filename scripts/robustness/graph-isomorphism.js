/**
 * Graph-isomorphism — structural equality check for Logic-Core JSON.
 * Approximate: canonical sort by type sequence, no full VF2.
 * Sufficient for typical sample sizes (≤50 nodes).
 */

export function toAdjacencyList(lc) {
  const nodes = [];
  const lanes = [];
  const pools = lc.pools || [];

  for (const pool of pools) {
    for (const lane of (pool.lanes || [])) {
      lanes.push({ id: lane.id, poolId: pool.id });
      for (const node of (lane.nodes || [])) {
        nodes.push({ id: node.id, type: node.type });
      }
    }
  }

  const edges = (lc.flows || []).map(f => ({ source: f.source, target: f.target }));
  return { pools: pools.map(p => ({ id: p.id })), lanes, nodes, edges };
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
