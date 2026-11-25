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
 * end at the gateway; one new flow leads on to the node, on the happy path when one of the
 * gathered flows is (`isHappyPath`). Message flows do not count, and
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

      let onHappyPath = false;
      for (const edge of proc.edges) {
        if (edge.target !== target.id) continue;
        edge.target = id;
        if (edge.isHappyPath === true) onHappyPath = true;
      }
      const edgeId = mintId(used, `flow_${id}_${target.id}`);
      const onward = { id: edgeId, source: id, target: target.id };
      // The layout reads isHappyPath per flow: the path through the join stays the happy path.
      if (onHappyPath) onward.isHappyPath = true;
      proc.edges.push(onward);
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

// What a derived join gateway and its onward flow carry when they come back exactly as the
// writer left them — after applyDerivations, and after either importer read the XML. Any other
// key (documentation, a colour, a label, a condition, a default mark, a foreign attribute) is an
// edit a person made, and an edited element is theirs.
const UNTOUCHED_JOIN_KEYS = new Set(['id', 'type', 'name', 'lane', 'has_join', '_derived']);
const UNTOUCHED_ONWARD_KEYS = new Set(['id', 'source', 'target', 'isHappyPath']);
const onlyKeys = (obj, allowed) => Object.keys(obj).every(key => allowed.has(key));

/** Drop `id` from every `nodeIds` list in a lane tree. */
function dropFromLanes(lanes, id) {
  for (const lane of lanes || []) {
    if (Array.isArray(lane.nodeIds)) lane.nodeIds = lane.nodeIds.filter(x => x !== id);
    dropFromLanes(lane.children, id);
  }
}

/**
 * Remove the untouched derived elements of one container (a process, a pool or a subprocess,
 * nested containers first) and unmark the rest. `lanes` is the enclosing process's lane tree.
 */
function removeDerivedIn(container, lanes, referenced) {
  if (!Array.isArray(container.nodes)) return;
  for (const node of container.nodes) removeDerivedIn(node, lanes, referenced);
  const edges = Array.isArray(container.edges) ? container.edges : [];

  for (const node of [...container.nodes]) {
    if (!('_derived' in node)) continue;
    const kind = node._derived;
    delete node._derived;
    const outgoing = edges.filter(edge => edge.source === node.id);
    const [onward] = outgoing;
    const untouched = kind === 'joinGateway'
      && node.type === 'exclusiveGateway' && !node.name && onlyKeys(node, UNTOUCHED_JOIN_KEYS)
      && outgoing.length === 1 && onward.target !== node.id && onlyKeys(onward, UNTOUCHED_ONWARD_KEYS)
      && !referenced.has(node.id);
    if (!untouched) continue;

    for (const edge of edges) if (edge.target === node.id) edge.target = onward.target;
    edges.splice(edges.indexOf(onward), 1);
    container.nodes.splice(container.nodes.indexOf(node), 1);
    dropFromLanes(lanes, node.id);
  }
}

/**
 * The inverse of applyDerivations, for a model read back from XML: every derived element still as
 * the writer left it is removed — a join gateway's incoming flows end at the onward flow's target
 * again, the gateway, the onward flow and the gateway's lane `nodeIds` entries go. A derived
 * element a person edited stays and loses its marker. The result carries no `_derived` key at
 * any depth (references/input-schema.json allows no unknown node key).
 *
 * @param {object} lc - Logic-Core (single process or collaboration); never changed
 * @returns {object} a copy without derived elements
 */
export function removeDerivedElements(lc) {
  const copy = JSON.parse(JSON.stringify(lc));
  // An association or message flow that ends at the gateway was drawn by a person.
  const referenced = new Set();
  for (const link of [...(copy.associations || []), ...(copy.messageFlows || [])]) {
    referenced.add(link.source);
    referenced.add(link.target);
  }
  for (const proc of copy.pools || [copy]) removeDerivedIn(proc, proc.lanes, referenced);
  return copy;
}
