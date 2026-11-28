/**
 * Format 2.x, first stage (design 7.3 step 2, 7.5, 8): `resolveFields` checks a 2.x model against its
 * actor, system and data catalogue and responsibility scheme (rules C01–C07, C14–C17, hints H09, H21)
 * and translates it into the intermediate form the pipeline already reads — the 1.x shape without lanes, plus private
 * carrier fields.
 *
 * The C rules run here and are not entries of the rule register (design 8). `resolveFields` sets
 * no `role` or `lane`; a task's `system` (format 2.1, a catalogue id) becomes the 1.x `system` text,
 * the entry's name, with the id kept in `_systemRef`. `formLanes` forms the lanes afterwards from
 * the catalogue and the chosen view, by the inheritance rule of design 7.2.
 *
 * Data (format 2.1): the model's `data` merges into the catalogue's like `systems`; a node's
 * `dataAccess` is checked against it (C15 on a node that is no activity, C16) and resolved into
 * data references, their connections and input placeholders (private carriers `_dataRef`,
 * `_dataObject`, `_dataStore`, `_dataProperty`, `_access`; C17 when a derived id collides); the
 * keys `data` and `dataAccess` are left out of the intermediate form.
 */

import { validateModelSchema } from './schema-gate.js';
import { coded } from '../shared/message-codes.js';
import { isEvent, isGateway, isActivity, isBoundaryEvent, FLOW_NODE_TYPES, TASK_TYPES, ACTIVITY_TYPES } from './types.js';
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

/** C07, once per cycle of the parent map, named at the member that comes first in the catalogue. */
function partOfCycles(parentOf, order) {
  const errors = [];
  const done = new Set();
  for (const start of parentOf.keys()) {
    if (done.has(start)) continue;
    const path = [];
    let at = start;
    while (at !== undefined && !done.has(at) && !path.includes(at)) { path.push(at); at = parentOf.get(at); }
    if (at !== undefined && path.includes(at)) {
      const ring = path.slice(path.indexOf(at));
      let first = 0;
      ring.forEach((id, i) => { if (order.get(id) < order.get(ring[first])) first = i; });
      const named = [...ring.slice(first), ...ring.slice(0, first)];
      errors.push(`[C07] unit "${q(named[0])}": partOf forms a cycle (${[...named, named[0]].map(q).join(' \u2192 ')})`);
    }
    for (const id of path) done.add(id);
  }
  return errors;
}

/**
 * Merges `own` into `base`: an entry of `base` whose id `own` also has is replaced in place by the
 * entry of `own`, and the entries of `own` with a new id are appended; `replaced` lists the ids of
 * `own` found in `base` (model order).
 */
function mergeEntries(base, own) {
  const byId = new Map();
  for (const entry of own) if (!byId.has(entry.id)) byId.set(entry.id, entry);
  const inBase = new Set(base.map((e) => e.id));
  const merged = base.map((e) => byId.get(e.id) ?? e);
  for (const entry of own) if (!inBase.has(entry.id)) merged.push(entry);
  return { merged, replaced: [...byId.keys()].filter((id) => inBase.has(id)) };
}

const NO_CATALOG_HELP = 'pass one with --catalog=<path>, the "catalog" field of the process file, the catalog option of runPipeline or the `catalog` object of an MCP or HTTP request';

/**
 * Checks a 2.x model and translates it into the intermediate form. Neither argument is changed.
 * `catalog` is `{ actors, systems?, data?, scheme? }`; the model's `actors`, `systems` and `data` then
 * replace or extend it (its `scheme` is C13); a model without one may carry `actors`, `systems`, `data`
 * (and `scheme`) itself. `hints` lists H09 per catalogue entry the model replaces (its `actors` in
 * model order, then its `systems`, then its `data`), then H21 per used data item without `kind`. With findings the result is `{ lc: null, resolved: null, errors, hints: [] }`.
 */
export function resolveFields(model, options) {
  const { catalog, viewName = 'default' } = options ?? {};
  const fail = (errors) => ({ lc: null, resolved: null, errors, hints: [] });

  // (1) format schema
  const gate = validateModelSchema(model, { accept: ['2'] });
  if (!gate.valid) return fail(gate.errors.map((e) => (e.code ? coded(e.code, `${e.path} ${e.message}`) : e.message)));

  // (2) the source of the actors, systems and data. With a catalogue object the model's own `actors`,
  // `systems` and `data` replace entries of it (same id, in place) or are appended (new id); the C rules then
  // run on those effective lists.
  let source = null;
  let ownActors = null;
  let ownSystems = null;
  let ownData = null;
  const hints = [];
  const replacedHints = (ids) => {
    for (const id of ids) hints.push({ code: 'H09', message: `Catalogue entry "${q(id)}" is replaced by the process file.`, elements: [id] });
  };
  if (catalog !== undefined && catalog !== null) {
    if (model.scheme !== undefined) return fail([coded('C13', 'the process file cannot change the responsibility scheme of the catalogue')]);
    const problems = catalogErrors(catalog);
    if (problems.length) return fail(problems);
    source = catalog;
    if (model.actors !== undefined || model.systems !== undefined || model.data !== undefined) {
      source = { ...catalog };
      if (model.actors !== undefined) {
        ownActors = model.actors;
        const { merged, replaced } = mergeEntries(catalog.actors, ownActors);
        source.actors = merged;
        replacedHints(replaced);
      }
      if (model.systems !== undefined) {
        ownSystems = model.systems;
        const { merged, replaced } = mergeEntries(catalog.systems ?? [], ownSystems);
        source.systems = merged;
        replacedHints(replaced);
      }
      if (model.data !== undefined) {
        ownData = model.data;
        const { merged, replaced } = mergeEntries(catalog.data ?? [], ownData);
        source.data = merged;
        replacedHints(replaced);
      }
      const effective = catalogErrors(source);
      if (effective.length) return fail(effective);
    }
  } else if (typeof model.catalog === 'string') {
    return fail([coded('C13', `the model names catalogue "${q(model.catalog)}" but no catalogue object was passed — the CLI reads it relative to the model file, a library caller passes { catalog }`)]);
  } else if (model.actors !== undefined || model.systems !== undefined || model.data !== undefined) {
    source = { actors: model.actors ?? [] };
    if (model.systems !== undefined) source.systems = model.systems;
    if (model.data !== undefined) source.data = model.data;
    if (model.scheme !== undefined) source.scheme = model.scheme;
    const problems = catalogErrors(source);
    if (problems.length) return fail(problems);
  }
  // An actor catalogue is given when the call passes one or the model carries `actors` (an inline
  // list of systems alone is none: its assignments get the one leading C01, ruling 6 b).
  const actorsGiven = (catalog !== undefined && catalog !== null) || model.actors !== undefined;

  const actors = source ? clone(source.actors) : [];
  const systems = source?.systems ? clone(source.systems) : [];
  const data = source?.data ? clone(source.data) : [];
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
    if (!byId.has(actor.id)) { byId.set(actor.id, actor); order.set(actor.id, index); }
  });
  // C03: duplicates inside one source list; a model entry that replaces a catalogue id is none.
  const duplicates = (list, where, what = 'actor') => {
    const counts = new Map();
    for (const entry of list) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
    for (const [id, n] of counts) if (n > 1) errors.push(`[C03] ${what} id "${q(id)}" occurs ${n} times in ${where}`);
  };
  if (ownActors) {
    duplicates(catalog.actors, 'the catalogue');
    duplicates(ownActors, 'the actors of the process file');
  } else {
    duplicates(actors, 'the catalogue');
  }
  if (ownSystems) {
    duplicates(catalog.systems ?? [], 'the catalogue', 'system');
    duplicates(ownSystems, 'the systems of the process file', 'system');
  } else {
    duplicates(systems, 'the catalogue', 'system');
  }
  if (ownData) {
    duplicates(catalog.data ?? [], 'the catalogue', 'data');
    duplicates(ownData, 'the data of the process file', 'data');
  } else {
    duplicates(data, 'the catalogue', 'data');
  }
  // C03: actors, systems and data share one id space (effective lists).
  const systemById = new Map();
  const systemOrder = new Map();
  systems.forEach((system, index) => {
    if (systemById.has(system.id)) return;
    systemById.set(system.id, system);
    systemOrder.set(system.id, index);
    if (byId.has(system.id)) errors.push(`[C03] id "${q(system.id)}" is both an actor and a system in the catalogue`);
  });
  const dataById = new Map();
  const dataOrder = new Map();
  data.forEach((item, index) => {
    if (dataById.has(item.id)) return;
    dataById.set(item.id, item);
    dataOrder.set(item.id, index);
    if (byId.has(item.id)) errors.push(`[C03] id "${q(item.id)}" is both an actor and a data item in the catalogue`);
    if (systemById.has(item.id)) errors.push(`[C03] id "${q(item.id)}" is both a system and a data item in the catalogue`);
  });
  // A reference to an actor or unit that names a system or a data item says so (C01).
  const missing = (ref, as) => (systemById.has(ref) ? `is a system, not ${as}`
    : dataById.has(ref) ? `is a data item, not ${as}` : 'is not in the catalogue');

  const nodes = allNodes(model);
  // No catalogue handed over at all (no source): one leading error instead of a C01 line per
  // assignment; the checks that need only the scheme (C04, C05) still run. An empty actors list is
  // a catalogue that was given; its C01 lines stay.
  const noCatalog = !actorsGiven && nodes.some((n) => (n.assignments ?? []).length > 0);
  if (noCatalog) {
    errors.push(`[C01] the model has assignments but no actor catalogue was given; ${NO_CATALOG_HELP}`);
  } else {
    for (const node of nodes) {
      for (const a of node.assignments ?? []) {
        if (!byId.has(a.actor)) errors.push(`[C01] node "${q(node.id)}": actor "${q(a.actor)}" ${missing(a.actor, 'an actor')}`);
      }
    }
  }
  for (const actor of actors) {
    if (actor.unit !== undefined && !byId.has(actor.unit)) {
      errors.push(`[C01] actor "${q(actor.id)}": unit "${q(actor.unit)}" ${missing(actor.unit, 'a unit')}`);
    }
  }
  for (const actor of actors) {
    const target = actor.unit !== undefined ? byId.get(actor.unit) : undefined;
    if (target && target.kind !== undefined && target.kind !== 'unit') {
      errors.push(`[C02] actor "${q(actor.id)}": unit "${q(actor.unit)}" is a role, not a unit`);
    }
  }
  // partOf: the parent unit (organigram). Only edges that pass C01/C02 take part in the cycle search.
  const parentOf = new Map();
  for (const actor of actors) {
    if (actor.partOf === undefined || parentOf.has(actor.id) || byId.get(actor.id) !== actor) continue;
    const target = byId.get(actor.partOf);
    if (!target) {
      errors.push(`[C01] actor "${q(actor.id)}": partOf "${q(actor.partOf)}" ${missing(actor.partOf, 'a unit')}`);
    } else if (target.kind !== undefined && target.kind !== 'unit') {
      errors.push(`[C02] actor "${q(actor.id)}": partOf "${q(actor.partOf)}" is a role, not a unit`);
    } else {
      parentOf.set(actor.id, actor.partOf);
    }
  }
  errors.push(...partOfCycles(parentOf, order));

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

  // C14: a task's system names a system of the catalogue; with no catalogue source at all, one
  // leading error instead of a line per node. C15: only a task carries a system.
  const withSystem = nodes.filter((n) => n.system !== undefined);
  if (withSystem.length > 0 && !source) {
    errors.push(`[C14] the model names systems but no catalogue was given; ${NO_CATALOG_HELP}`);
  } else {
    for (const node of withSystem) {
      if (systemById.has(node.system)) continue;
      errors.push(byId.has(node.system)
        ? `[C14] node "${q(node.id)}": "${q(node.system)}" is an actor, not a system`
        : dataById.has(node.system)
          ? `[C14] node "${q(node.id)}": "${q(node.system)}" is a data item, not a system`
          : `[C14] node "${q(node.id)}": system "${q(node.system)}" is not in the catalogue`);
    }
  }
  for (const node of withSystem) {
    if (!TASK_TYPES.has(node.type)) errors.push(`[C15] node "${q(node.id)}": a system belongs on a task, not on ${q(node.type)}`);
  }

  // C15: data access only on an activity. C16: it names a data item of the catalogue, lists no
  // access twice and does not mix a recorded and a not-recorded access to one item; with no
  // catalogue source at all, one leading error instead of a line per node.
  const withAccess = nodes.filter((n) => n.dataAccess !== undefined);
  for (const node of withAccess) {
    if (!ACTIVITY_TYPES.has(node.type)) errors.push(`[C15] node "${q(node.id)}": data access belongs on an activity, not on ${q(node.type)}`);
  }
  if (!source && withAccess.some((n) => n.dataAccess.length > 0)) {
    errors.push(`[C16] the model names data but no catalogue was given; ${NO_CATALOG_HELP}`);
  } else {
    for (const node of withAccess) {
      const byItem = new Map();
      for (const entry of node.dataAccess) {
        if (!byItem.has(entry.data)) byItem.set(entry.data, []);
        byItem.get(entry.data).push(entry.access ?? null);
      }
      for (const [ref, accesses] of byItem) {
        const who = `[C16] node "${q(node.id)}":`;
        if (!dataById.has(ref)) {
          errors.push(byId.has(ref) ? `${who} "${q(ref)}" is an actor, not a data item`
            : systemById.has(ref) ? `${who} "${q(ref)}" is a system, not a data item`
              : `${who} data "${q(ref)}" is not in the catalogue`);
          continue;
        }
        const counts = new Map();
        for (const a of accesses) counts.set(a, (counts.get(a) ?? 0) + 1);
        for (const [a, n] of counts) {
          if (n > 1) errors.push(`${who} data access to "${q(ref)}" (${a ?? 'access not recorded'}) is listed ${n} times`);
        }
        const recorded = accesses.find((a) => a !== null);
        if (recorded !== undefined && counts.has(null)) {
          errors.push(`${who} data access to "${q(ref)}" is both recorded (${recorded}) and not recorded; keep one form`);
        }
      }
    }
  }
  if (errors.length) return fail(errors);

  // H21: a used data item without a recorded kind, once, in order of first use
  const kindless = new Set();
  for (const node of withAccess) {
    for (const entry of node.dataAccess) {
      const item = dataById.get(entry.data);
      if (item.kind === undefined && !kindless.has(item.id)) {
        kindless.add(item.id);
        hints.push({ code: 'H21', message: `Data item "${q(item.name)}" (${q(item.id)}) has no recorded kind: drawn as a data object.`, elements: [item.id] });
      }
    }
  }

  const fingerprint = catalogFingerprint(actors, scheme, systems, data);
  const namedAsUnit = new Set();
  for (const actor of actors) {
    for (const ref of [actor.unit, actor.partOf]) if (ref !== undefined && ref !== actor.id) namedAsUnit.add(ref);
  }
  const isUnit = (id) => {
    const actor = byId.get(id);
    // a kind-less actor is a unit when another actor names it, or when its own partOf was accepted
    return actor !== undefined && (actor.kind === 'unit' || (actor.kind === undefined && (namedAsUnit.has(id) || parentOf.has(id))));
  };
  const unitChain = (id) => {
    const chain = [id];
    const seen = new Set(chain);
    for (let up = parentOf.get(id); up !== undefined && !seen.has(up); up = parentOf.get(up)) {
      chain.unshift(up);
      seen.add(up);
    }
    return chain;
  };
  const resolved = {
    actors, byId, order, systems, systemById, systemOrder, data, dataById, dataOrder, scheme: clone(scheme), performsType, fingerprint, parentOf, isUnit, unitChain,
  };

  // the intermediate form: a task's system as the 1.x writer reads it (the name), its id kept private
  const lc = clone(model);
  for (const key of ['$schemaVersion', 'catalog', 'actors', 'systems', 'data', 'scheme']) delete lc[key];
  const steps = dataSteps(lc);
  for (const node of allNodes(lc)) {
    if (node.assignments !== undefined) { node._assignments = node.assignments; delete node.assignments; }
    delete node.dataAccess;
    if (node.system !== undefined) { node._systemRef = node.system; node.system = systemById.get(node.system).name; }
  }
  const collisions = deriveData(lc, steps, dataById);
  if (collisions.length) return fail(collisions);
  lc._modelInfo = { version: model.$schemaVersion, view: viewName, catalogFingerprint: fingerprint };
  return { lc, resolved, errors: [], hints };
}

/**
 * The steps with data access of an intermediate form, depth-first in document order (top level,
 * or each pool): `{ node, container, processId, access }`, `container` the node list the step sits in.
 */
function dataSteps(lc) {
  const steps = [];
  const walk = (nodes, processId) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!isPlainObject(node)) continue;
      if (Array.isArray(node.dataAccess) && node.dataAccess.length > 0) {
        steps.push({ node, container: nodes, processId, access: node.dataAccess });
      }
      walk(node.nodes, processId);
    }
  };
  if (Array.isArray(lc.pools)) for (const pool of lc.pools) { if (isPlainObject(pool)) walk(pool.nodes, pool.id); }
  else walk(lc.nodes, lc.id);
  return steps;
}

/**
 * Derives, in place, the data references, their connections and the input placeholders of the
 * checked `steps` (design of format 2.1): per step and distinct item a reference `s__d` appended
 * to the step's container, a link `s__d__read` / `s__d__write` / `s__d__link` per access, and
 * `_dataProperty = 's__input'` on a step that reads. Root `associations`: the model's own, then
 * every not-recorded link, then per step its reads and then its writes.
 *
 * C17 first: every derived id (and the `_di` / `_do` forms the writers give it) against the ids
 * of the document as it stands (catalogue keys already gone) and their `_di` / `_do` forms, and
 * the derived ids against each other. The DataObject `p__d` and the DataStore `d__store` are one
 * id however many steps use them. Returns the C17 messages; with any, `lc` must not be used.
 */
function deriveData(lc, steps, dataById) {
  if (steps.length === 0) return [];
  const taken = new Map();
  for (const id of collectDocumentIds(lc)) {
    for (const v of [id, `${id}_di`, `${id}_do`]) if (!taken.has(v)) taken.set(v, id);
  }
  const errors = [];
  const derived = new Map();
  const self = (o) => (o.kind === 'placeholder' ? `input placeholder of step "${q(o.step)}"`
    : o.kind === 'object' ? `data object of data "${q(o.data)}" in process "${q(o.process)}"`
      : o.kind === 'store' ? `data store of data "${q(o.data)}"`
        : `step "${q(o.step)}", data "${q(o.data)}"`);
  const other = (o) => (o.kind === 'placeholder' || o.kind === 'object' || o.kind === 'store' ? `the ${self(o)}` : `the data id of ${self(o)}`);
  // one finding per derived id: the model first, then the derived ids before it
  const claim = (id, forms, owner) => {
    const inModel = forms.find((v) => taken.has(v));
    const inDerived = forms.find((v) => derived.has(v) && derived.get(v) !== owner);
    if (inModel !== undefined) {
      errors.push(`[C17] data id "${q(id)}" (${self(owner)}) collides with "${q(taken.get(inModel))}"; rename that id of the model`);
    } else if (inDerived !== undefined) {
      errors.push(`[C17] data id "${q(id)}" (${self(owner)}) collides with ${other(derived.get(inDerived))}; rename one of the steps or data items`);
    }
    for (const v of forms) if (!derived.has(v)) derived.set(v, owner);
  };
  const shared = new Map();
  const sharedOwner = (key, make) => {
    if (!shared.has(key)) shared.set(key, { owner: make(), claimed: false });
    return shared.get(key);
  };

  const links = [];
  const readWrite = [];
  const appended = new Map();
  for (const { node, container, processId, access } of steps) {
    const s = node.id;
    const reads = access.filter((e) => e.access === 'read');
    if (reads.length > 0) {
      node._dataProperty = `${s}__input`;
      claim(node._dataProperty, [node._dataProperty], { kind: 'placeholder', step: s });
    }
    const items = [...new Set(access.map((e) => e.data))];
    for (const d of items) {
      const item = dataById.get(d);
      const id = `${s}__${d}`;
      const ref = { id, type: item.kind === 'store' ? 'dataStoreReference' : 'dataObjectReference', name: item.name };
      if (item.kind !== 'store' && item.isCollection === true) ref.isCollection = true;
      ref._dataRef = d;
      claim(id, [id, `${id}_di`, `${id}_do`], { kind: 'reference', step: s, data: d });
      const target = item.kind === 'store'
        ? sharedOwner(`store\u0000${d}`, () => ({ kind: 'store', data: d, id: `${d}__store` }))
        : sharedOwner(`object\u0000${processId}\u0000${d}`, () => ({ kind: 'object', data: d, process: processId, id: `${processId}__${d}` }));
      if (item.kind === 'store') ref._dataStore = target.owner.id;
      else ref._dataObject = target.owner.id;
      if (!target.claimed) { target.claimed = true; claim(target.owner.id, [target.owner.id], target.owner); }
      if (!appended.has(container)) appended.set(container, []);
      appended.get(container).push(ref);
    }
    const owned = { reads: [], writes: [] };
    for (const entry of access) {
      const d = entry.data;
      const ref = `${s}__${d}`;
      const suffix = entry.access === 'read' ? 'read' : entry.access === 'write' ? 'write' : 'link';
      const id = `${ref}__${suffix}`;
      claim(id, [id, `${id}_di`], { kind: 'link', step: s, data: d });
      if (entry.access === 'read') owned.reads.push({ id, source: ref, target: s, directed: true, _access: 'read' });
      else if (entry.access === 'write') owned.writes.push({ id, source: s, target: ref, directed: true, _access: 'write' });
      else links.push({ id, source: ref, target: s, _access: 'unrecorded' });
    }
    readWrite.push(...owned.reads, ...owned.writes);
  }
  if (errors.length) return errors;
  for (const [container, refs] of appended) container.push(...refs);
  const derivedLinks = [...links, ...readWrite];
  if (derivedLinks.length > 0) lc.associations = [...(lc.associations ?? []), ...derivedLinks];
  return [];
}

// ---------------------------------------------------------------------------------------------
// formLanes: the view's lanes from the assignments (design 7.1, 7.2, 7.4; C10 of design 8)
// ---------------------------------------------------------------------------------------------

export const UNASSIGNED = '_unassigned';
export const UNIT_UNKNOWN = '_unitUnknown';
/** The placeholder key of the system view: an activity without a recorded system. */
export const SYSTEM_UNKNOWN = '_systemUnknown';
/** The placeholder key of the view option `lanes.automatic: 'lane'`: an automatic task without performer. */
export const AUTOMATIC = '_automatic';

/** The automatic activities of design 7.2 step 5: without performer they inherit instead of taking the placeholder. */
export const AUTOMATIC_ACTIVITY_TYPES = new Set(['serviceTask', 'scriptTask', 'businessRuleTask', 'sendTask', 'receiveTask']);

export function laneIdFor(processId, key) {
  return `L.${processId}.${key}`;
}

const PLACEHOLDER_NAMES = {
  [UNASSIGNED]: () => CFG.laneFormation.unassignedName,
  [UNIT_UNKNOWN]: () => CFG.laneFormation.unitUnknownName,
  [SYSTEM_UNKNOWN]: () => CFG.laneFormation.systemUnknownName,
  [AUTOMATIC]: () => CFG.laneFormation.automaticName,
};
/** The name of a placeholder lane; the automatic lane takes the view's `automaticName` when set. */
const placeholderName = (key, automaticName = null) => (key === AUTOMATIC && automaticName !== null ? automaticName : PLACEHOLDER_NAMES[key]());

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

/**
 * Rank of a key for ties and declaration: catalogue order, then the placeholders. In the system
 * view (`laneBy === 'system'`) the systems in catalogue order, then the system placeholder.
 */
function keyRank(resolved, key, laneBy) {
  if (laneBy === 'system') return key === SYSTEM_UNKNOWN ? resolved.systemOrder.size : resolved.systemOrder.get(key);
  if (key === UNASSIGNED) return resolved.order.size;
  if (key === UNIT_UNKNOWN) return resolved.order.size + 1;
  if (key === AUTOMATIC) return resolved.order.size + 2;
  return resolved.order.get(key);
}

/**
 * The inheritance rule for one process (design 7.2 steps 2–7). Returns the key of every top-level
 * flow node and the hints that do not need the lane name; `inherited` lists the automatic
 * activities that took their key in a round (H03, written once the lanes exist). In the system
 * view the key of steps 2–3 is the activity's system: every activity (automatic or not, a
 * subprocess included) has one, `SYSTEM_UNKNOWN` (H20) without a recorded system; assignments play
 * no part, and the fallback of the later steps is `SYSTEM_UNKNOWN`.
 *
 * With `automatic === 'lane'` (never in the system view) the rounds run exactly as without it;
 * only after them every automatic activity still without a performer key takes `AUTOMATIC`
 * instead of its inherited key or the fallback (no H08 for it), and is listed in `moved` (H19,
 * written once the lanes exist). Boundary events on it follow in step 7, and `formLanes` puts a
 * text annotation (artefact) associated with it into the automatic lane too. Every other node keeps
 * the key it has without the switch: the placeholder is never passed on by inheritance.
 */
function inheritKeys(proc, resolved, laneBy, level, performerOf, prefix, automatic = 'neighbour') {
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
  const rank = (k) => keyRank(resolved, k, laneBy);
  const fallback = laneBy === 'system' ? SYSTEM_UNKNOWN : UNASSIGNED;
  // steps 2 and 3
  for (const n of inner) {
    if (laneBy === 'system') {
      if (!isActivity(n.type)) continue;
      const k = n._systemRef ?? SYSTEM_UNKNOWN;
      key.set(n.id, k);
      if (k === SYSTEM_UNKNOWN) {
        hints.push({ code: 'H20', message: `${prefix}No system recorded for ${nodeLabel(n)}: lane "${placeholderName(SYSTEM_UNKNOWN)}".`, elements: [n.id] });
      }
      continue;
    }
    const p = performerOf(n);
    if (p) {
      let k = p.id;
      if (laneBy === 'unit') {
        k = resolved.isUnit(p.id) ? p.id : p.unit ?? UNIT_UNKNOWN;
        if (k !== UNIT_UNKNOWN && level !== null) {
          // the unit at the chosen depth; a unit shallower than the level keeps its own lane
          const chain = resolved.unitChain(k);
          if (chain.length >= level) k = chain[level - 1];
        }
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
        if (best === undefined || c > b || (c === b && rank(k) < rank(best))) best = k;
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
  const moved = [];
  const moveAutomatic = automatic === 'lane' && laneBy !== 'system';
  for (const n of keyless) {
    if (moveAutomatic && isAuto(n)) {
      key.set(n.id, AUTOMATIC);
      moved.push(n);
    } else if (key.has(n.id)) {
      if (isAuto(n)) inherited.push(n);
    } else {
      key.set(n.id, fallback);
      hints.push({ code: 'H08', message: `${prefix}No neighbour with a lane: ${nodeLabel(n)} is in lane "${placeholderName(fallback)}".`, elements: [n.id] });
    }
  }

  // step 7: boundary events go with their host. Without a host that has a key the fallback stays:
  // migrateModel calls formLanes without validateLogicCore, so the host may be missing.
  for (const n of flowNodes) {
    if (!isBoundaryEvent(n)) continue;
    const host = key.get(n.attachedTo);
    if (host !== undefined) key.set(n.id, host);
    else {
      key.set(n.id, fallback);
      hints.push({ code: 'H08', message: `${prefix}Boundary event ${nodeLabel(n)} has no host with a lane: lane "${placeholderName(fallback)}".`, elements: [n.id] });
    }
  }
  return { key, hints, inherited, moved };
}

/**
 * The lanes option of a view in one shape: the strings `role`, `unit`, `system`, `none` or the
 * object `{ by: 'role'|'unit', level?, nested?, automatic?, automaticName? }` (`level` and `nested`
 * for `unit` only; `automaticName` only with `automatic: 'lane'`); `undefined` means `role`.
 * Anything else is an unknown option and throws instead of being treated as a default.
 * @returns {{ by: 'role'|'unit'|'system'|'none', level: number|null, nested: boolean, automatic: 'neighbour'|'lane', automaticName: string|null }}
 */
export function normalizeLanesOption(lanes) {
  const plain = { level: null, nested: false, automatic: 'neighbour', automaticName: null };
  if (lanes === undefined) return { by: 'role', ...plain };
  if (lanes === 'role' || lanes === 'unit' || lanes === 'system' || lanes === 'none') return { by: lanes, ...plain };
  if (isPlainObject(lanes) && (lanes.by === 'unit' || lanes.by === 'role')
    && Object.keys(lanes).every((k) => k === 'by' || k === 'automatic' || k === 'automaticName' || (lanes.by === 'unit' && (k === 'level' || k === 'nested')))
    && (lanes.level === undefined || (Number.isInteger(lanes.level) && lanes.level >= 1 && lanes.level <= 16))
    && (lanes.nested === undefined || typeof lanes.nested === 'boolean')
    && (lanes.automatic === undefined || lanes.automatic === 'neighbour' || lanes.automatic === 'lane')
    && (lanes.automaticName === undefined
      || (lanes.automatic === 'lane' && typeof lanes.automaticName === 'string' && [...lanes.automaticName].length >= 1
        && [...lanes.automaticName].length <= LANE_NAME_LIMIT && /\S/.test(lanes.automaticName)))) {
    return { by: lanes.by, level: lanes.level ?? null, nested: lanes.nested ?? false, automatic: lanes.automatic ?? 'neighbour', automaticName: lanes.automaticName ?? null };
  }
  throw new TypeError(`unknown lanes option ${JSON.stringify(lanes)}`);
}

const isPlaceholder = (key) => key === UNASSIGNED || key === UNIT_UNKNOWN || key === SYSTEM_UNKNOWN || key === AUTOMATIC;

/** Every lane of a lane tree, depth-first in declaration order. */
function allLanes(laneList, out = []) {
  for (const l of laneList) { out.push(l); if (l.children) allLanes(l.children, out); }
  return out;
}

/**
 * The lanes of the nested unit view for the keys of one process: a lane
 * for every unit of each key's chain, children in catalogue order. A key unit with child lanes
 * holds its own steps in the extra first child `L.<process>.<unit>._own`, named like the unit, so
 * no parent lane holds a node itself; the placeholders are top-level lanes after the tree. A key
 * that is no unit (a kind-less actor naming itself) follows its own chain, as the level does;
 * without `partOf` that is a top-level lane without children. `automaticName` names the automatic
 * lane (null: the configured name).
 * @returns {{ laneList: object[], laneOf: Map<string, object> }} `laneOf`: key → its leaf lane
 */
function laneTree(processId, keys, resolved, automaticName = null) {
  const lane = (id, name, key) => ({ id, name, _derived: 'lane', _laneBy: 'unit', _laneActor: key });
  const byRank = (a, b) => keyRank(resolved, a, 'unit') - keyRank(resolved, b, 'unit');
  const units = keys.filter((k) => !isPlaceholder(k));
  const isKey = new Set(units);
  const roots = new Set();
  const childrenOf = new Map();
  for (const k of units) {
    const chain = resolved.unitChain(k);
    roots.add(chain[0]);
    for (let i = 1; i < chain.length; i++) {
      if (!childrenOf.has(chain[i - 1])) childrenOf.set(chain[i - 1], new Set());
      childrenOf.get(chain[i - 1]).add(chain[i]);
    }
  }
  const laneOf = new Map();
  const build = (u) => {
    const l = lane(laneIdFor(processId, u), resolved.byId.get(u).name, u);
    const kids = [...(childrenOf.get(u) ?? [])].sort(byRank);
    if (kids.length === 0) {
      laneOf.set(u, l);
      return l;
    }
    l.children = [];
    if (isKey.has(u)) {
      const own = lane(`${l.id}._own`, l.name, u);
      l.children.push(own);
      laneOf.set(u, own);
    }
    l.children.push(...kids.map(build));
    return l;
  };
  const laneList = [...roots].sort(byRank).map(build);
  for (const k of keys.filter(isPlaceholder)) {
    const l = lane(laneIdFor(processId, k), placeholderName(k, automaticName), k);
    laneList.push(l);
    laneOf.set(k, l);
  }
  return { laneList, laneOf };
}

/**
 * Forms the lanes of the chosen view (`role`, `unit`, `system`, `none` or the object form, see
 * `normalizeLanesOption`) from the assignments of an intermediate form made by `resolveFields`,
 * or in the system view from the systems of its tasks (`_systemRef`). With `automatic: 'lane'`
 * (role and unit view) every automatic task without performer is in the lane
 * `L.<process>._automatic`, named `automaticName` or `laneFormation.automaticName`, with one H19
 * each where H03 would be; its boundary events and the artefacts associated with it follow it.
 * Without it such a task goes with its neighbour (H03).
 * Neither argument is changed. A C10 collision stops the run: `{ lc: null, hints: [], errors }`.
 */
export function formLanes(lc, resolved, { lanes: lanesOption } = {}) {
  const { by: lanes, level, nested, automatic, automaticName } = normalizeLanesOption(lanesOption);
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
    if (lanes === 'system') {
      if (!top.some((n) => isFlowNode(n) && !isBoundaryEvent(n) && isActivity(n.type) && n._systemRef !== undefined)) {
        hints.push({ code: 'H06', message: `${proc.prefix}No systems in process "${proc.label}": no lanes.`, elements: [proc.id] });
        continue;
      }
    } else if (!top.some((n) => isFlowNode(n) && !isBoundaryEvent(n) && performerOf(n))) {
      hints.push({ code: 'H06', message: `${proc.prefix}No assignments in process "${proc.label}": no lanes.`, elements: [proc.id] });
      continue;
    }
    const { key, hints: found, inherited, moved } = inheritKeys(proc, resolved, lanes, level, performerOf, proc.prefix, automatic);

    // step 8: one lane per key used, in declaration order; nested, the tree along the organigram
    const keys = [...new Set(key.values())].sort((a, b) => keyRank(resolved, a, lanes) - keyRank(resolved, b, lanes));
    const nameOf = (k) => {
      if (isPlaceholder(k)) return placeholderName(k, automaticName);
      return (lanes === 'system' ? resolved.systemById : resolved.byId).get(k).name;
    };
    let laneList;
    let laneOf;
    if (nested) ({ laneList, laneOf } = laneTree(proc.id, keys, resolved, automaticName));
    else {
      laneList = keys.map((k) => ({
        id: laneIdFor(proc.id, k),
        name: nameOf(k),
        _derived: 'lane', _laneBy: lanes, _laneActor: k,
      }));
      laneOf = new Map(laneList.map((l) => [l._laneActor, l]));
    }
    for (const n of top) if (key.has(n.id)) n.lane = laneOf.get(key.get(n.id)).id;
    const firstLeaf = allLanes(laneList).find((l) => !l.children);

    // artefacts: the lane of the node an association connects them to, else the first lane
    const flowLane = new Map(top.filter((n) => key.has(n.id)).map((n) => [n.id, n.lane]));
    // a node inside a subprocess counts as its top-level subprocess
    const collectNested = (sp, id) => {
      for (const c of sp.nodes ?? []) {
        if (!isPlainObject(c)) continue;
        if (c.id !== undefined) flowLane.set(c.id, flowLane.get(id));
        collectNested(c, id);
      }
    };
    for (const n of top) if (isPlainObject(n) && flowLane.has(n.id)) collectNested(n, n.id);
    for (const n of top) {
      if (!isPlainObject(n) || isFlowNode(n)) continue;
      let laneId;
      for (const a of out.associations ?? []) {
        const other = a.source === n.id ? a.target : a.target === n.id ? a.source : undefined;
        if (other !== undefined && flowLane.has(other)) { laneId = flowLane.get(other); break; }
      }
      n.lane = laneId ?? firstLeaf.id;
    }

    for (const n of inherited) {
      const l = laneOf.get(key.get(n.id));
      found.push({
        code: 'H03',
        message: `${proc.prefix}Automatic step ${nodeLabel(n)} has no performer; it is placed with its neighbour in lane "${l.name}". Set lanes.automatic to "lane" for a lane of its own.`,
        elements: [n.id, l.id],
      });
    }
    for (const n of moved) {
      const l = laneOf.get(AUTOMATIC);
      found.push({
        code: 'H19',
        message: `${proc.prefix}Automatic step ${nodeLabel(n)} has no performer: lane "${l.name}".`,
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
    for (const l of allLanes(laneList)) {
      const hit = [l.id, `${l.id}_di`].find((v) => taken.has(v));
      if (hit !== undefined) {
        const kind = l._laneBy === 'system' ? 'system' : 'actor';
        errors.push(`[C10] lane id "${q(l.id)}" (${kind} "${q(l._laneActor)}") collides with "${q(taken.get(hit))}"; rename the catalogue id`);
      }
      for (const v of [l.id, `${l.id}_di`]) if (!taken.has(v)) taken.set(v, l.id);
    }
    // an own lane bears its parent's name: the parent's H05 covers it; a view's automaticName is
    // capped at LANE_NAME_LIMIT code points by the view gate, so it gets none (a configured name does)
    const fromView = (x) => x._laneActor === AUTOMATIC && automaticName !== null;
    for (const l of allLanes(laneList).filter((x) => !x.id.endsWith('._own') && !fromView(x))) {
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
 * leaf lane of that process (never in a parent lane of a nested tree), no artefact is listed in a
 * lane, no lane id repeats anywhere in the tree. A violation is a bug of formLanes, never a
 * finding about the model.
 */
export function checkProjection(lc) {
  const fail = (what) => { throw new Error(`formLanes internal error: ${what}`); };
  const seen = new Set();
  for (const proc of processesOf(lc)) {
    const laneList = proc.container.lanes;
    if (!Array.isArray(laneList) || laneList.length === 0) continue;
    const every = allLanes(laneList);
    const leaves = new Set();
    const parents = new Set();
    for (const l of every) {
      if (seen.has(l.id)) fail(`lane id "${l.id}" occurs twice`);
      seen.add(l.id);
      (l.children?.length ? parents : leaves).add(l.id);
    }
    for (const n of proc.container.nodes) {
      if (!isPlainObject(n)) continue;
      const listedIn = every.filter((l) => Array.isArray(l.nodeIds) && l.nodeIds.includes(n.id)).map((l) => l.id);
      if (!isFlowNode(n)) {
        if (listedIn.length) fail(`artefact "${n.id}" is listed in lane "${listedIn[0]}"`);
        continue;
      }
      if (typeof n.lane === 'string' && parents.has(n.lane)) fail(`flow node "${n.id}" is in parent lane "${n.lane}"`);
      if (typeof n.lane !== 'string' || !leaves.has(n.lane)) fail(`flow node "${n.id}" is in no lane of process "${proc.id}"`);
      if (listedIn.some((id) => id !== n.lane)) fail(`flow node "${n.id}" is in more than one lane`);
    }
  }
}
