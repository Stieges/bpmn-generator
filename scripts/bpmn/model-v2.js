/**
 * Format 2.0, first stage (design 7.3 step 2, 7.5, 8): `resolveFields` checks a 2.0 model against its
 * actor catalogue and responsibility scheme (rules C01–C06) and translates it into the intermediate
 * form the pipeline already reads — the 1.x shape without lanes, plus private carrier fields.
 *
 * The C rules run here and are not entries of the rule register (design 8). `resolveFields` sets
 * no `role`, `system` or `lane`; `formLanes` forms the lanes afterwards from the catalogue and the
 * chosen view, by the inheritance rule of design 7.2.
 */

import { validateModelSchema } from './schema-gate.js';
import { coded } from '../shared/message-codes.js';
import { isEvent, isGateway, isActivity, isBoundaryEvent, FLOW_NODE_TYPES } from './types.js';
import { findBackEdges, collectDocumentIds } from './topology.js';
import { LANE_NAME_LIMIT } from './rules.js';
import { CFG } from '../shared/utils.js';
import { catalogErrors, resolveScheme, catalogFingerprint, CATALOG_LIMITS } from '../shared/catalog.js';
import { boundText } from '../shared/safe-text.js';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const q = (v) => boundText(v, CATALOG_LIMITS.token);

/** Every flow node of the model, at every depth: top level, the nodes of every pool, nested `nodes` of subprocesses. */
function allNodes(model) {
  const out = [];
  const walk = (nodes) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!isPlainObject(node)) continue;
      out.push(node);
      walk(node.nodes);
    }
  };
  walk(model.nodes);
  if (Array.isArray(model.pools)) for (const pool of model.pools) if (isPlainObject(pool)) walk(pool.nodes);
  return out;
}

/** The scheme's display name for C06 messages: the reference when it is a name, else the embedded object's `scheme`. */
function schemeName(ref) {
  if (ref === undefined) return 'demi';
  if (typeof ref === 'string') return ref;
  return isPlainObject(ref) && typeof ref.scheme === 'string' ? ref.scheme : '?';
}

function schemeErrors(ref, scheme) {
  const name = q(schemeName(ref));
  if (!isPlainObject(scheme) || !Array.isArray(scheme.types)) {
    return [`[C06] responsibility scheme "${name}" is unknown (shipped: demi)`];
  }
  const errors = [];
  const performing = scheme.types.filter((t) => t && t.performs === true).length;
  if (performing !== 1) errors.push(`[C06] scheme "${name}" must have exactly one type with performs (has ${performing})`);
  const seen = new Set();
  const twice = new Set();
  for (const t of scheme.types) {
    if (seen.has(t?.key)) twice.add(t.key);
    seen.add(t?.key);
  }
  for (const key of twice) errors.push(`[C06] scheme "${name}" has type key "${q(key)}" twice`);
  return errors;
}

/**
 * Checks a 2.0 model and translates it into the intermediate form. Neither argument is changed.
 * `catalog` is `{ actors, scheme? }`; a model without one may carry `actors` (and `scheme`) itself.
 * With findings the result is `{ lc: null, resolved: null, errors }`.
 */
export function resolveFields(model, { catalog, viewName = 'default' } = {}) {
  const fail = (errors) => ({ lc: null, resolved: null, errors });

  // (1) format schema
  const gate = validateModelSchema(model, { accept: ['2'] });
  if (!gate.valid) return fail(gate.errors.map((e) => (e.code ? coded(e.code, `${e.path} ${e.message}`) : e.message)));

  // (2) the source of the actors
  let source = null;
  if (catalog !== undefined && catalog !== null) {
    if (model.actors !== undefined) {
      return fail([coded('C13', 'the model carries actors and a catalogue was passed; replacing entries comes in a later version')]);
    }
    source = catalog;
  } else if (typeof model.catalog === 'string') {
    return fail([coded('C13', `the model names catalogue "${q(model.catalog)}" but no catalogue object was passed — the CLI reads it relative to the model file, a library caller passes { catalog }`)]);
  } else if (model.actors !== undefined) {
    source = { actors: model.actors };
    if (model.scheme !== undefined) source.scheme = model.scheme;
  }
  if (source) {
    const problems = catalogErrors(source);
    if (problems.length) return fail(problems);
  }

  const actors = source ? clone(source.actors) : [];
  const schemeRef = source ? source.scheme : undefined;
  const scheme = resolveScheme(schemeRef);

  // (3) the C rules
  const errors = schemeErrors(schemeRef, scheme);
  const schemeOk = errors.length === 0;
  const name = q(schemeName(schemeRef));

  const byId = new Map();
  const order = new Map();
  const counts = new Map();
  actors.forEach((actor, index) => {
    counts.set(actor.id, (counts.get(actor.id) ?? 0) + 1);
    if (!byId.has(actor.id)) { byId.set(actor.id, actor); order.set(actor.id, index); }
  });
  for (const [id, n] of counts) if (n > 1) errors.push(`[C03] actor id "${q(id)}" occurs ${n} times in the catalogue`);

  const nodes = allNodes(model);
  // No catalogue handed over at all (no source): one leading error instead of a C01 line per
  // assignment; the checks that need only the scheme (C04, C05) still run. An empty actors list is
  // a catalogue that was given; its C01 lines stay.
  const noCatalog = !source && nodes.some((n) => (n.assignments ?? []).length > 0);
  if (noCatalog) {
    errors.push('[C01] the model has assignments but no actor catalogue was given; pass one with --catalog=<path>, the "catalog" field of the process file or the catalog option of runPipeline');
  } else {
    for (const node of nodes) {
      for (const a of node.assignments ?? []) {
        if (!byId.has(a.actor)) errors.push(`[C01] node "${q(node.id)}": actor "${q(a.actor)}" is not in the catalogue`);
      }
    }
  }
  for (const actor of actors) {
    if (actor.unit !== undefined && !byId.has(actor.unit)) {
      errors.push(`[C01] actor "${q(actor.id)}": unit "${q(actor.unit)}" is not in the catalogue`);
    }
  }
  for (const actor of actors) {
    const target = actor.unit !== undefined ? byId.get(actor.unit) : undefined;
    if (target && target.kind !== undefined && target.kind !== 'unit') {
      errors.push(`[C02] actor "${q(actor.id)}": unit "${q(actor.unit)}" is a role, not a unit`);
    }
  }

  const performsType = schemeOk ? scheme.types.find((t) => t.performs === true).key : null;
  if (schemeOk) {
    const known = new Set(scheme.types.map((t) => t.key));
    for (const node of nodes) {
      const list = node.assignments ?? [];
      for (const a of list) {
        if (!known.has(a.type)) errors.push(`[C04] node "${q(node.id)}": type "${q(a.type)}" is not in scheme "${name}"`);
      }
      const performers = list.filter((a) => a.type === performsType).length;
      if (performers > 1) errors.push(`[C04] node "${q(node.id)}" has ${performers} performers; at most one`);
    }
    for (const node of nodes) {
      const kind = isEvent(node.type) ? 'event' : isGateway(node.type) ? 'gateway' : null;
      if (!kind) continue;
      for (const a of node.assignments ?? []) {
        if (known.has(a.type) && a.type !== performsType) {
          errors.push(`[C05] ${kind} "${q(node.id)}": only the performer type "${q(performsType)}" is allowed, not "${q(a.type)}"`);
        }
      }
    }
  }
  if (errors.length) return fail(errors);

  const fingerprint = catalogFingerprint(actors, scheme);
  const resolved = { actors, byId, order, scheme, performsType, fingerprint };

  // the intermediate form
  const lc = clone(model);
  for (const key of ['$schemaVersion', 'catalog', 'actors', 'scheme']) delete lc[key];
  for (const node of allNodes(lc)) {
    if (node.assignments !== undefined) { node._assignments = node.assignments; delete node.assignments; }
  }
  lc._modelInfo = { version: model.$schemaVersion, view: viewName, catalogFingerprint: fingerprint };
  return { lc, resolved, errors: [] };
}

// ---------------------------------------------------------------------------------------------
// formLanes: the view's lanes from the assignments (design 7.1, 7.2, 7.4; C10 of design 8)
// ---------------------------------------------------------------------------------------------

export const UNASSIGNED = '_unassigned';
export const UNIT_UNKNOWN = '_unitUnknown';

/** The automatic activities of design 7.2 step 5: without performer they inherit instead of taking the placeholder. */
export const AUTOMATIC_ACTIVITY_TYPES = new Set(['serviceTask', 'scriptTask', 'businessRuleTask', 'sendTask', 'receiveTask']);

export function laneIdFor(processId, key) {
  return `L.${processId}.${key}`;
}

const placeholderName = (key) => (key === UNASSIGNED ? CFG.laneFormation.unassignedName : CFG.laneFormation.unitUnknownName);

/** The modelled processes of an intermediate form: the document itself, or each expanded pool. */
function processesOf(lc) {
  if (Array.isArray(lc.pools)) {
    return lc.pools.filter((p) => isPlainObject(p) && Array.isArray(p.nodes))
      .map((p) => ({ container: p, id: p.id, label: p.name || p.id, prefix: `[${p.name || p.id}] ` }));
  }
  return [{ container: lc, id: lc.id, label: lc.name || lc.id, prefix: '' }];
}

const isFlowNode = (n) => isPlainObject(n) && FLOW_NODE_TYPES.has(n.type);
const nodeLabel = (n) => `"${n.name ?? n.id}" (${n.id})`;

/** Rank of a key for ties and declaration: catalogue order, then the two placeholders. */
function keyRank(resolved, key) {
  if (key === UNASSIGNED) return resolved.order.size;
  if (key === UNIT_UNKNOWN) return resolved.order.size + 1;
  return resolved.order.get(key);
}

/**
 * The inheritance rule for one process (design 7.2 steps 2–7). Returns the key of every top-level
 * flow node and the hints that do not need the lane name; `inherited` lists the automatic
 * activities that took their key in a round (H03, written once the lanes exist).
 */
function inheritKeys(proc, resolved, laneBy, performerOf, prefix) {
  const hints = [];
  const flowNodes = proc.container.nodes.filter(isFlowNode);
  const ids = new Set(flowNodes.map((n) => n.id));
  const edges = (proc.container.edges ?? []).filter((e) => ids.has(e.source) && ids.has(e.target));
  const back = findBackEdges(flowNodes, edges);
  const forward = edges.filter((e) => !back.has(e));

  const inner = flowNodes.filter((n) => !isBoundaryEvent(n));
  const preds = new Map(inner.map((n) => [n.id, []]));
  const succs = new Map(inner.map((n) => [n.id, []]));
  for (const e of forward) {
    succs.get(e.source)?.push(e.target);
    preds.get(e.target)?.push(e.source);
  }

  const key = new Map();
  const isAuto = (n) => AUTOMATIC_ACTIVITY_TYPES.has(n.type);
  // steps 2 and 3
  for (const n of inner) {
    const p = performerOf(n);
    if (p) {
      let k = p.id;
      if (laneBy === 'unit' && p.kind !== 'unit') {
        k = p.unit ?? UNIT_UNKNOWN;
        if (k === UNIT_UNKNOWN) {
          hints.push({
            code: 'H04',
            message: `${prefix}Unit of performer "${p.name}" not recorded: ${nodeLabel(n)} is in lane "${placeholderName(UNIT_UNKNOWN)}".`,
            elements: [n.id, p.id],
          });
        }
      }
      key.set(n.id, k);
    } else if (isActivity(n.type) && !isAuto(n)) {
      key.set(n.id, UNASSIGNED);
      hints.push({ code: 'H02', message: `${prefix}No performer for ${nodeLabel(n)}: lane "${placeholderName(UNASSIGNED)}".`, elements: [n.id] });
    }
  }

  // step 5: the preferred direction of each node still without key
  const successorFirst = (n) => {
    if (n.type === 'startEvent') return true;
    if (!isGateway(n.type)) return false;
    return preds.get(n.id).length >= 2 && succs.get(n.id).length <= 1;
  };
  const keyless = inner.filter((n) => !key.has(n.id));
  const preferred = new Map(keyless.map((n) => [n.id, (successorFirst(n) ? succs : preds).get(n.id)]));
  const other = new Map(keyless.map((n) => [n.id, (successorFirst(n) ? preds : succs).get(n.id)]));

  // step 6: rounds, each read from the state at its start
  const round = (direction) => {
    const updates = [];
    for (const n of keyless) {
      if (key.has(n.id)) continue;
      const counts = new Map();
      for (const m of new Set(direction.get(n.id))) {
        const k = key.get(m);
        if (k !== undefined) counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      let best;
      for (const [k, c] of counts) {
        const b = best === undefined ? undefined : counts.get(best);
        if (best === undefined || c > b || (c === b && keyRank(resolved, k) < keyRank(resolved, best))) best = k;
      }
      if (best !== undefined) updates.push([n.id, best]);
    }
    for (const [id, k] of updates) key.set(id, k);
    return updates.length > 0;
  };
  for (;;) {
    while (round(preferred));
    if (!round(other)) break;
  }
  const inherited = [];
  for (const n of keyless) {
    if (key.has(n.id)) {
      if (isAuto(n)) inherited.push(n);
    } else {
      key.set(n.id, UNASSIGNED);
      hints.push({ code: 'H08', message: `${prefix}No neighbour with a lane: ${nodeLabel(n)} is in lane "${placeholderName(UNASSIGNED)}".`, elements: [n.id] });
    }
  }

  // step 7: boundary events go with their host
  for (const n of flowNodes) {
    if (!isBoundaryEvent(n)) continue;
    const host = key.get(n.attachedTo);
    if (host !== undefined) key.set(n.id, host);
    else {
      key.set(n.id, UNASSIGNED);
      hints.push({ code: 'H08', message: `${prefix}No neighbour with a lane: ${nodeLabel(n)} is in lane "${placeholderName(UNASSIGNED)}".`, elements: [n.id] });
    }
  }
  return { key, hints, inherited };
}

/**
 * Forms the lanes of the chosen view (`role`, `unit` or `none`) from the assignments of an
 * intermediate form made by `resolveFields`. Neither argument is changed. A C10 collision stops
 * the run: `{ lc: null, hints: [], errors }`.
 */
export function formLanes(lc, resolved, { lanes = 'role' } = {}) {
  const out = clone(lc);
  if (lanes === 'none') return { lc: out, hints: [], errors: [] };

  const performerOf = (n) => {
    const a = (n._assignments ?? []).find((x) => x.type === resolved.performsType);
    return a ? resolved.byId.get(a.actor) : undefined;
  };
  const hints = [];
  const formed = [];
  for (const proc of processesOf(out)) {
    const top = proc.container.nodes;
    if (!top.some((n) => isFlowNode(n) && !isBoundaryEvent(n) && performerOf(n))) {
      hints.push({ code: 'H06', message: `${proc.prefix}No assignments in process "${proc.label}": no lanes.`, elements: [proc.id] });
      continue;
    }
    const { key, hints: found, inherited } = inheritKeys(proc, resolved, lanes, performerOf, proc.prefix);

    // step 8: one lane per key used, in declaration order
    const keys = [...new Set(key.values())].sort((a, b) => keyRank(resolved, a) - keyRank(resolved, b));
    const laneList = keys.map((k) => ({
      id: laneIdFor(proc.id, k),
      name: k === UNASSIGNED || k === UNIT_UNKNOWN ? placeholderName(k) : resolved.byId.get(k).name,
      _derived: 'lane', _laneBy: lanes, _laneActor: k,
    }));
    const laneOf = new Map(laneList.map((l) => [l._laneActor, l]));
    for (const n of top) if (key.has(n.id)) n.lane = laneOf.get(key.get(n.id)).id;

    // artefacts: the lane of the node an association connects them to, else the first lane
    const flowLane = new Map(top.filter((n) => key.has(n.id)).map((n) => [n.id, n.lane]));
    for (const n of top) {
      if (!isPlainObject(n) || isFlowNode(n)) continue;
      let laneId;
      for (const a of out.associations ?? []) {
        const other = a.source === n.id ? a.target : a.target === n.id ? a.source : undefined;
        if (other !== undefined && flowLane.has(other)) { laneId = flowLane.get(other); break; }
      }
      n.lane = laneId ?? laneList[0].id;
    }

    for (const n of inherited) {
      const l = laneOf.get(key.get(n.id));
      found.push({
        code: 'H03',
        message: `${proc.prefix}Automatic step ${nodeLabel(n)} has no performer; it is placed with its neighbour in lane "${l.name}".`,
        elements: [n.id, l.id],
      });
    }
    hints.push(...found);
    proc.container.lanes = laneList;
    formed.push({ proc, laneList });
  }

  // C10 against every id of the document as it came in, and against the lanes declared before
  const errors = [];
  const taken = new Map();
  for (const id of collectDocumentIds(lc)) {
    for (const v of [id, `${id}_di`, `${id}_do`]) if (!taken.has(v)) taken.set(v, id);
  }
  for (const { proc, laneList } of formed) {
    for (const l of laneList) {
      const hit = [l.id, `${l.id}_di`].find((v) => taken.has(v));
      if (hit !== undefined) {
        errors.push(`[C10] lane id "${q(l.id)}" (actor "${q(l._laneActor)}") collides with "${q(taken.get(hit))}"; rename the catalogue id`);
      }
      for (const v of [l.id, `${l.id}_di`]) if (!taken.has(v)) taken.set(v, l.id);
    }
    for (const l of laneList) {
      if (l.name.length > LANE_NAME_LIMIT) {
        hints.push({
          code: 'H05',
          message: `${proc.prefix}Lane name "${l.name}" is longer than ${LANE_NAME_LIMIT} characters; shorten the catalogue name.`,
          elements: [l.id, l._laneActor],
        });
      }
    }
  }
  if (errors.length) return { lc: null, hints: [], errors };
  checkProjection(out);
  return { lc: out, hints, errors: [] };
}

/**
 * Check P (design 7.3): in every process with lanes each top-level flow node is in exactly one
 * lane of that process, no artefact is listed in a lane, no lane id repeats. A violation is a
 * bug of formLanes, never a finding about the model.
 */
export function checkProjection(lc) {
  const fail = (what) => { throw new Error(`formLanes internal error: ${what}`); };
  const seen = new Set();
  for (const proc of processesOf(lc)) {
    const laneList = proc.container.lanes;
    if (!Array.isArray(laneList) || laneList.length === 0) continue;
    const own = new Set();
    for (const l of laneList) {
      if (seen.has(l.id)) fail(`lane id "${l.id}" occurs twice`);
      seen.add(l.id);
      own.add(l.id);
    }
    for (const n of proc.container.nodes) {
      if (!isPlainObject(n)) continue;
      const listedIn = laneList.filter((l) => Array.isArray(l.nodeIds) && l.nodeIds.includes(n.id)).map((l) => l.id);
      if (!isFlowNode(n)) {
        if (listedIn.length) fail(`artefact "${n.id}" is listed in lane "${listedIn[0]}"`);
        continue;
      }
      if (typeof n.lane !== 'string' || !own.has(n.lane)) fail(`flow node "${n.id}" is in no lane of process "${proc.id}"`);
      if (listedIn.some((id) => id !== n.lane)) fail(`flow node "${n.id}" is in more than one lane`);
    }
  }
}
