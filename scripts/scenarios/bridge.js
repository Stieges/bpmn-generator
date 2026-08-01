/**
 * Phase C — the bridge: resolving BPMN `decisionRef` against DMN decision tables.
 *
 * A Business Rule Task carries a `decisionRef` (`references/input-schema.json`,
 * `Node.decisionRef`) naming the DMN decision it invokes. This module is a **pure static
 * resolution pass**: given a Logic-Core document and a set of Decision-Core documents, it
 * finds every `decisionRef` occurrence on the BPMN side, every decision-with-a-table on
 * the DMN side, and matches them by id. No live calls, no per-firing lookup during
 * enumeration (that would be a different, unimplemented feature), and no analysis of the
 * matched table itself — `decision-table.js`'s `analyzeDecisionTable` does that, one step
 * later, over the raw table object this module hands back unchanged.
 *
 * ── Why this needs its own recursive walker ────────────────────────────────────────────
 * A `businessRuleTask` is not necessarily a top-level pool node. Per `input-schema.json`'s
 * `Node` definition, `nodes` (and `edges`) is a property of every `Node`, not just ones of
 * type `subProcess` — used "for expanded subProcess" per its description, but the schema
 * does not gate it by type, and `transaction` (a specialised subProcess, same nesting
 * idiom) is a distinct `NodeType` that can carry children the same way. A node's own
 * `nodes` array can therefore appear at any depth, holding another node with its own
 * `nodes` array, and so on. `tests/fixtures/subprocess-child-fidelity.json` is the fixture
 * this project keeps around specifically to catch a walker that only checks the top level:
 * its `c_rule` (`decisionRef: "RatingDecision"`) sits one level inside `outer`'s children.
 * CLAUDE.md's "Adding a per-node field" section documents this exact failure mode
 * recurring in this codebase (a different field, the same root cause: a non-recursive
 * `nodes` walk that misses subprocess children silently, because bpmn-moddle only warns
 * about attributes it does not recognise, never about ones that never arrived). The walker
 * below recurses into `node.nodes` unconditionally, regardless of `node.type` — precisely
 * so no future node type that adopts the same nesting idiom has to be special-cased in.
 *
 * ── Two Logic-Core shapes ───────────────────────────────────────────────────────────────
 * Mirrors the shape-sniffing `toAdjacencyList` (`scripts/robustness/graph-isomorphism.js`)
 * already does: a collaboration (`lc.pools`, each pool with its own `nodes`) or a legacy
 * flat single-process document (`lc.nodes` directly). Both are handled; a `poolId` is
 * carried through only in the collaboration case, since a flat document has no pools to
 * distinguish.
 *
 * ── Cross-document ambiguity ────────────────────────────────────────────────────────────
 * A `decisionRef` is unique WITHIN one Decision-Core document (DMN's namespace model), but
 * this module accepts an ARRAY of Decision-Core documents, and nothing stops two of them
 * from declaring a decision with the same id — each document's own `namespace` field would
 * disambiguate in a real DMN deployment, but resolving namespaces is out of scope here.
 * When that happens, the resolution is reported as "ambiguous", a distinct outcome from
 * "unresolved" (found nothing) — see `resolveBridge`'s three-way split below.
 */

/**
 * One `decisionRef` occurrence found on the BPMN side.
 *
 * @typedef {object} DecisionRefOccurrence
 * @property {string} nodeId - the businessRuleTask's own (local, unprefixed) BPMN id.
 * @property {string} decisionRef - the raw `decisionRef` value on that node.
 * @property {string} [poolId] - the enclosing pool's id, only set for a collaboration
 *   (`lc.pools`) document. Absent for a flat single-process document.
 * @property {string[]} ancestry - ids of every enclosing subProcess/transaction node,
 *   outermost first, empty for a top-level node. `['outer']` for `c_rule` in
 *   `subprocess-child-fidelity.json`.
 */

/**
 * One decision-with-a-table found on the DMN side.
 *
 * @typedef {object} DecisionTableEntry
 * @property {string} decisionId - the decision node's own id (e.g. `dec_discountLevel`).
 * @property {string} decisionCoreId - the id of the Decision-Core document it came from
 *   (`Decision-Core.id`, e.g. `Definitions_discount`). Falls back to the document's array
 *   index (as a string, `'#0'`-style) if the document carries no `id`.
 * @property {string} decisionName - the decision node's `name`, for readable reporting.
 * @property {object} decisionTable - the raw `decisionTable` object, passed through
 *   unchanged. NOT analyzed here — hand it to `analyzeDecisionTable` (decision-table.js).
 */

/**
 * A single resolved link: one BPMN `decisionRef` occurrence matched to exactly one DMN
 * decision table.
 *
 * @typedef {object} ResolvedLink
 * @property {'resolved'} status
 * @property {DecisionRefOccurrence} occurrence
 * @property {DecisionTableEntry} decision
 */

/**
 * A `decisionRef` with no matching decision in any given Decision-Core document.
 *
 * @typedef {object} UnresolvedFinding
 * @property {'unresolved'} status
 * @property {DecisionRefOccurrence} occurrence
 */

/**
 * A `decisionRef` matched by MORE than one decision across the given Decision-Core
 * documents — the resolver refuses to guess which one is meant.
 *
 * @typedef {object} AmbiguousFinding
 * @property {'ambiguous'} status
 * @property {DecisionRefOccurrence} occurrence
 * @property {DecisionTableEntry[]} candidates - every matching decision, so a caller can
 *   see exactly what collided (their `decisionCoreId`s in particular).
 */

/**
 * The complete result of one bridge run.
 *
 * @typedef {object} BridgeResult
 * @property {ResolvedLink[]} resolved
 * @property {UnresolvedFinding[]} unresolved - flat, not nested — Task 6 (the judging
 *   layer) consumes exactly this list without re-walking anything.
 * @property {AmbiguousFinding[]} ambiguous - flat, same reason.
 * @property {DecisionRefOccurrence[]} occurrences - every `decisionRef` occurrence found
 *   on the BPMN side, resolved or not (union of the three lists above, in encounter
 *   order) — a caller who wants "all of them, regardless of outcome" in one place.
 * @property {Map<string, ResolvedLink|UnresolvedFinding|AmbiguousFinding>} byKey - the
 *   same three lists merged into one lookup, keyed by `linkKey(occurrence)`, so "what
 *   table does this node invoke, or why couldn't I find one?" is an O(1) lookup, not a
 *   re-walk of `resolved`/`unresolved`/`ambiguous`.
 */

/** Node types whose own `nodes` array holds children one further level in. Kept as a
 * named export so a future type that adopts the same nesting idiom (e.g. an ad-hoc
 * subprocess, if it ever gains this shape) has a single flag to add rather than a
 * hidden assumption to find. The walker below does not actually consult this set — it
 * recurses on ANY node carrying a non-empty `nodes` array, regardless of `type` — which
 * is the point: no per-type branch to keep in sync. The set exists for documentation and
 * for tests to assert against explicitly (Verification item 6). */
export const NESTING_NODE_TYPES = new Set(['subProcess', 'transaction']);

/**
 * Build the lookup key used by `BridgeResult.byKey`: pool-qualified when `poolId` is
 * present, plain node id otherwise. Exported so a caller building its own lookup key
 * (e.g. Task 6, matching against a scenario trace's node ids) uses the identical scheme.
 *
 * @param {{nodeId: string, poolId?: string}} occurrence
 * @returns {string}
 */
export function linkKey(occurrence) {
  return occurrence.poolId !== undefined ? `${occurrence.poolId}::${occurrence.nodeId}` : occurrence.nodeId;
}

/**
 * Recursively collect every `decisionRef` occurrence under one node list.
 *
 * @param {object[]} nodes
 * @param {string|undefined} poolId
 * @param {string[]} ancestry - ids of enclosing subProcess/transaction nodes, outermost
 *   first; mutated and restored (not copied) for traversal efficiency — callers only see
 *   the finished, per-occurrence snapshot.
 * @param {DecisionRefOccurrence[]} out
 */
function walkNodes(nodes, poolId, ancestry, out) {
  for (const node of nodes || []) {
    if (typeof node.decisionRef === 'string' && node.decisionRef.length > 0) {
      const occurrence = { nodeId: node.id, decisionRef: node.decisionRef, ancestry: [...ancestry] };
      if (poolId !== undefined) occurrence.poolId = poolId;
      out.push(occurrence);
    }
    // Recurse into ANY node's own `nodes` array, unconditionally — not gated by
    // `node.type`. See the module doc: the schema does not restrict nesting to
    // `subProcess`, and a non-recursive, type-gated walk is exactly the bug class this
    // module exists to not repeat.
    if (Array.isArray(node.nodes) && node.nodes.length > 0) {
      ancestry.push(node.id);
      walkNodes(node.nodes, poolId, ancestry, out);
      ancestry.pop();
    }
  }
}

/**
 * Find every `decisionRef` occurrence in a Logic-Core document, recursively, in both the
 * collaboration (`lc.pools`) and legacy flat single-process shapes.
 *
 * @param {object} lc - a Logic-Core document.
 * @returns {DecisionRefOccurrence[]} in encounter order (pools/nodes array order, depth
 *   first).
 */
export function findDecisionRefs(lc) {
  const out = [];
  if (!lc || typeof lc !== 'object') return out;

  if (Array.isArray(lc.pools)) {
    for (const pool of lc.pools) {
      walkNodes(pool.nodes, pool.id, [], out);
    }
  } else {
    walkNodes(lc.nodes, undefined, [], out);
  }
  return out;
}

/**
 * Find every decision-with-a-table across a set of Decision-Core documents.
 *
 * @param {object[]} decisionCores - array of Decision-Core documents (each shaped like
 *   `tests/fixtures/dmn/discount-decision.json`). May be empty.
 * @returns {DecisionTableEntry[]} in encounter order (document order, then node order
 *   within each document).
 */
export function findDecisionTables(decisionCores) {
  const out = [];
  (decisionCores || []).forEach((dc, index) => {
    if (!dc || typeof dc !== 'object') return;
    const decisionCoreId = typeof dc.id === 'string' && dc.id.length > 0 ? dc.id : `#${index}`;
    for (const node of dc.nodes || []) {
      if (node.type === 'decision' && node.decisionTable) {
        out.push({
          decisionId: node.id,
          decisionCoreId,
          decisionName: node.name,
          decisionTable: node.decisionTable,
        });
      }
    }
  });
  return out;
}

/**
 * Resolve every BPMN-side `decisionRef` occurrence against the DMN-side decision tables.
 *
 * @param {object} lc - a Logic-Core document (collaboration or flat single-process).
 * @param {object[]} decisionCores - an array of Decision-Core documents. May be empty —
 *   an empty array is valid input, and simply means every occurrence found is unresolved.
 * @returns {BridgeResult}
 */
export function resolveBridge(lc, decisionCores) {
  const occurrences = findDecisionRefs(lc);
  const decisions = findDecisionTables(decisionCores);

  // Group decisions by id so a collision across Decision-Core documents is visible in
  // O(1) per lookup rather than a full re-scan per occurrence.
  const decisionsById = new Map();
  for (const d of decisions) {
    if (!decisionsById.has(d.decisionId)) decisionsById.set(d.decisionId, []);
    decisionsById.get(d.decisionId).push(d);
  }

  const resolved = [];
  const unresolved = [];
  const ambiguous = [];
  const byKey = new Map();

  for (const occurrence of occurrences) {
    const candidates = decisionsById.get(occurrence.decisionRef) || [];
    let entry;
    if (candidates.length === 0) {
      entry = { status: 'unresolved', occurrence };
      unresolved.push(entry);
    } else if (candidates.length === 1) {
      entry = { status: 'resolved', occurrence, decision: candidates[0] };
      resolved.push(entry);
    } else {
      entry = { status: 'ambiguous', occurrence, candidates };
      ambiguous.push(entry);
    }
    byKey.set(linkKey(occurrence), entry);
  }

  return { resolved, unresolved, ambiguous, occurrences, byKey };
}
