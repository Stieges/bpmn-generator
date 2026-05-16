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
