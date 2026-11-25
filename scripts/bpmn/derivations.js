/**
 * Derivations: elements a view adds to the output without changing the author's model.
 *
 * `applyDerivations(lc, derivations)` works on a JSON copy (never structuredClone — see CLAUDE.md,
 * Known Limitations) and returns it together with one entry per derived element, so later steps
 * can mark the elements in the XML and drop them again on import. A view switches each
 * derivation on by name (`derivations` in references/view-schema.json); the registry below is
 * the one list of what exists.
 */
import { isGateway } from './types.js';
import { collectDocumentIds } from './topology.js';

/** `<base>`, else `<base>_2`, `<base>_3`, ... — the first one not in `used`, which it joins. */
function mintId(used, base) {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
  used.add(id);
  return id;
}

/** The `nodeIds` list (nested `children` walked) that holds `nodeId`, or undefined. */
function laneListHolding(lanes, nodeId) {
  for (const lane of lanes || []) {
    if (Array.isArray(lane.nodeIds) && lane.nodeIds.includes(nodeId)) return lane.nodeIds;
    const inner = laneListHolding(lane.children, nodeId);
    if (inner) return inner;
  }
  return undefined;
}

/**
 * An explicit exclusive join in front of every non-gateway node that two or more sequence flows
 * enter, per process (single process or each pool). The incoming flows keep their ids and now
 * end at the gateway; one new flow leads on to the node. Message flows do not count, and
 * subprocess children are not touched in v1 (their ids still count for collisions).
 */
function deriveJoinGateways(lc, derived) {
  const used = collectDocumentIds(lc);
  const processes = lc.pools ? lc.pools.map(p => [p, p.id]) : [[lc, null]];
  for (const [proc, processId] of processes) {
    if (!Array.isArray(proc.nodes) || !Array.isArray(proc.edges)) continue;
    const incoming = new Map();
    for (const edge of proc.edges) incoming.set(edge.target, (incoming.get(edge.target) || 0) + 1);
    const targets = proc.nodes.filter(node => !isGateway(node.type) && (incoming.get(node.id) || 0) >= 2);

    for (const target of targets) {
      const id = mintId(used, `gw_join_${target.id}`);
      const gateway = { id, type: 'exclusiveGateway' };
      if (target.lane) gateway.lane = target.lane;
      else laneListHolding(proc.lanes, target.id)?.push(id);
      gateway.has_join = true;
      gateway._derived = 'joinGateway';
      proc.nodes.splice(proc.nodes.indexOf(target), 0, gateway);

      for (const edge of proc.edges) if (edge.target === target.id) edge.target = id;
      const edgeId = mintId(used, `flow_${id}_${target.id}`);
      proc.edges.push({ id: edgeId, source: id, target: target.id });
      derived.push({ kind: 'joinGateway', id, target: target.id, edge: edgeId, process: processId });
    }
  }
}

const DERIVATIONS = { joinGateways: deriveJoinGateways };

/**
 * @param {object} lc - Logic-Core (single process or collaboration); never changed
 * @param {object} [derivations] - `{ <name>: true }` switches a derivation on
 * @returns {{ lc: object, derived: Array<{ kind: 'joinGateway', id: string, target: string,
 *   edge: string, process: string | null }> }}
 */
export function applyDerivations(lc, derivations) {
  const copy = JSON.parse(JSON.stringify(lc));
  const derived = [];
  for (const [name, derive] of Object.entries(DERIVATIONS)) {
    if (derivations?.[name] === true) derive(copy, derived);
  }
  return { lc: copy, derived };
}
