/**
 * The translator `migrate` (design 6): a 1.x model becomes a format 2.0 model, a catalogue
 * supplement and a report.
 *
 * Every lane of every modelled process becomes an actor without `kind` (a child lane gets its parent
 * lane's actor as `unit`); every distinct `role` becomes a kind-less actor `role_<slug>` that performs
 * its activities (a role equal to the name of a lane actor of the same process is that lane actor).
 * Each top-level activity of a process with lanes gets one assignment of the scheme's performs type
 * to its lane's actor (or its role's); events, gateways, boundary events and subprocess children get
 * none, and a role on them is dropped (MG05). `lanes`, `lane` and `role` are stripped; `system`, data
 * nodes and the flows and associations touching them are fields 2.0 cannot hold yet (MG02): refused
 * by default, dropped and listed with `dropUnsupported`. Everything else is kept as given.
 *
 * The report then compares the lanes (plan "Check"): the result goes through `resolveFields` and
 * `formLanes` under the view `rollen`, and every top-level flow node of a process with lanes (no
 * boundary event, no subprocess child) that sat in a lane is compared with its new lane. An activity
 * that lands elsewhere has an MG03 already; an event or gateway that lands elsewhere gets MG04.
 * Boundary events are not compared: they are drawn on their host in both formats, and the 1.x `lane`
 * on a boundary event only places it.
 *
 * `migrateModel` is pure: neither argument is changed, and it never throws on its input; a refused
 * input gives `model: null` and the reason in the report.
 */

import { validateLogicCoreSchema, validateModelSchema, modelFormat, formatSchemaErrors, FORMAT_V2_VERSION } from './schema-gate.js';
import { resolveLaneId, collectDocumentIds } from './topology.js';
import { isActivity, isBoundaryEvent, FLOW_NODE_TYPES } from './types.js';
import { resolveFields, formLanes, UNASSIGNED, UNIT_UNKNOWN } from './model-v2.js';
import { resolveScheme, catalogErrors, CATALOG_LIMITS } from '../shared/catalog.js';
import { coded } from '../shared/message-codes.js';
import { boundText } from '../shared/safe-text.js';

const clone = (v) => JSON.parse(JSON.stringify(v));
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const q = (v) => boundText(v, CATALOG_LIMITS.token);

/** The catalogue's actor id (design 5.2) and the 2.0 process id (design 5.1). */
const ACTOR_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const PROCESS_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const ACTOR_ID_MAX = 64;
const DATA_NODE_TYPES = new Set(['dataObjectReference', 'dataStoreReference']);

/** The code of every refusal of the input. */
const REFUSED_CODE = 'MG01';

/**
 * The order of the report's entry groups; within a group, document order. MG04 (the lane
 * comparison) and MG07 (a lane matched to an existing catalogue actor) have their place already.
 */
const ENTRY_ORDER = ['MG01', 'MG02', 'MG06', 'MG07', 'H07', 'MG03', 'MG05', 'MG04'];

const entry = (code, text, elements) => ({ code, message: coded(code, text), elements });

function orderEntries(entries) {
  return entries
    .map((e, i) => [e, i])
    .sort(([a, i], [b, j]) => (ENTRY_ORDER.indexOf(a.code) - ENTRY_ORDER.indexOf(b.code)) || i - j)
    .map(([e]) => e);
}

/** The codes `summary.deviations` counts, one entry each. */
const DEVIATION_CODES = ['MG03', 'MG04', 'MG05'];

/**
 * The report's summary, the same shape for every status. A refusal at the gate (the 1.x schema, a
 * duplicate id, the catalogue, a process id) is all 0; a later refusal (MG02, the final self-check,
 * the lane comparison) counts the `processes`, `lanes` and `activities` it read, the rest 0:
 * `processes`, `lanes` (every lane at any depth), `actors` (created), `activities` (top-level, no
 * boundary event), `assigned` (activities with an assignment), `laneMatches` (compared top-level flow
 * nodes whose new lane under `rollen` is the actor of their original lane) and `deviations`
 * (`{ MG03, MG04, MG05 }`, the number of report entries of each code).
 */
function summaryOf(counted = {}, entries = []) {
  const deviations = Object.fromEntries(DEVIATION_CODES.map((c) => [c, entries.filter((e) => e.code === c).length]));
  return { processes: 0, lanes: 0, actors: 0, activities: 0, assigned: 0, laneMatches: 0, ...counted, deviations };
}

function refused(entries, counted) {
  return { model: null, supplement: null, catalog: null, report: { status: 'refused', entries, summary: summaryOf(counted) } };
}

function refuse(reason, elements = [], counted = undefined) {
  return refused([entry(REFUSED_CODE, `input refused: ${reason}`, elements)], counted);
}

/**
 * The ids that occur more than once in a 1.x model, in order of first occurrence, with their count.
 * BPMN ids are unique in the document, so one id space holds: the process or every pool and
 * collapsed pool, the lanes at any depth, the nodes at any depth (flow nodes, artefacts, data
 * nodes), the sequence flows at every level, the message flows, the associations and the
 * top-level definitions. A sequence flow without id takes part with none.
 */
function duplicateIds(lc) {
  const count = new Map();
  const add = (item) => { if (isPlainObject(item) && typeof item.id === 'string') count.set(item.id, (count.get(item.id) ?? 0) + 1); };
  const lanes = (list) => { for (const l of list || []) { add(l); lanes(l.children); } };
  const holder = (h) => {
    for (const n of h.nodes || []) { add(n); holder(n); }
    for (const e of h.edges || []) add(e);
  };
  const processes = Array.isArray(lc.pools) ? lc.pools : [lc];
  for (const proc of processes) {
    add(proc);
    lanes(proc.lanes);
    holder(proc);
  }
  for (const list of [lc.collapsedPools, lc.messageFlows, lc.associations, lc.definitions]) for (const x of list || []) add(x);
  return [...count].filter(([, n]) => n > 1);
}

/** The schema gate's errors as one line: distinct lines, `; `-joined, without their own code (the line is MG01). */
function schemaReason(errors) {
  const plain = errors.map(({ code, ...rest }) => rest);
  return [...new Set(formatSchemaErrors(plain, 5).split('\n'))].join('; ');
}

/** `base`, or `base_2`, `base_3` … — cut so the result stays an actor id of at most 64 characters — whichever `taken` does not hold. */
function uniqueId(base, taken) {
  let id = base.slice(0, ACTOR_ID_MAX);
  for (let n = 2; taken.has(id); n++) {
    const suffix = `_${n}`;
    id = base.slice(0, ACTOR_ID_MAX - suffix.length) + suffix;
  }
  taken.add(id);
  return id;
}

/** The slug of a lane id that is no actor id: runs outside `[A-Za-z0-9_-]` become `_`, a leading non-letter gets `L_` in front. */
function laneSlug(id) {
  const slug = String(id).replace(/[^A-Za-z0-9_-]+/g, '_');
  return /^[A-Za-z]/.test(slug) ? slug : `L_${slug}`;
}

/** The `Resource_` slug rule of bpmn-xml.js `buildResources`, under the prefix `role_`. */
function roleBase(role) {
  const slug = role.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return slug ? `role_${slug}` : 'role';
}

/** Lanes of a process depth-first in document order, each with its parent lane (or null). */
function lanesOf(proc) {
  const out = [];
  const walk = (lanes, parent) => {
    for (const lane of lanes || []) {
      out.push({ lane, parent });
      walk(lane.children, lane);
    }
  };
  walk(proc.lanes, null);
  return out;
}

const hasLanes = (proc) => Array.isArray(proc.lanes) && proc.lanes.length > 0;

/** A top-level node that carries a performer assignment in a process with lanes. */
const takesAssignment = (proc, node) => hasLanes(proc) && isActivity(node.type) && !isBoundaryEvent(node);

/** The effective catalogue's scheme and its performs key, or the reason the catalogue is refused. */
function schemeOf(catalog) {
  if (catalog !== null && catalog !== undefined) {
    if (!isPlainObject(catalog)) return { error: 'the catalogue must be an object { actors, scheme? }' };
    const problems = catalogErrors(catalog);
    if (problems.length) return { error: `the catalogue is malformed: ${problems.join('; ')}` };
  }
  const scheme = resolveScheme(catalog?.scheme);
  const performs = Array.isArray(scheme?.types) ? scheme.types.filter((t) => t?.performs === true) : [];
  if (performs.length !== 1) return { error: 'the catalogue\'s responsibility scheme is unknown or has not exactly one performs type' };
  return { performs: performs[0].key };
}

/**
 * The MG02 entries of the input, in document order: per process its nodes depth-first (`system`,
 * a data node), then the flows and associations touching a data node.
 */
function unsupportedFields(processes, lc, dropUnsupported) {
  const entries = [];
  const dataIds = new Set();
  const tail = dropUnsupported ? '; dropped.' : '.';
  const visit = (nodes) => {
    for (const node of nodes || []) {
      if (node.system !== undefined) {
        entries.push(entry('MG02', `node "${q(node.id)}": field "system" ("${q(node.system)}") has no place in format 2.0 yet${tail}`, [node.id]));
      }
      if (DATA_NODE_TYPES.has(node.type)) {
        dataIds.add(node.id);
        entries.push(entry('MG02', `node "${q(node.id)}": ${node.type} has no place in format 2.0 yet${tail}`, [node.id]));
      }
      visit(node.nodes);
    }
  };
  for (const proc of processes) visit(proc.nodes);
  const touching = (kind, list) => {
    for (const c of list || []) {
      const node = dataIds.has(c.source) ? c.source : dataIds.has(c.target) ? c.target : null;
      if (node !== null) entries.push(entry('MG02', `${kind} "${q(c.id ?? `${c.source}->${c.target}`)}" touches the data node "${q(node)}", which has no place in format 2.0 yet${tail}`, [c.id ?? null].filter(Boolean)));
    }
  };
  const edgesIn = (nodes, out = []) => {
    for (const n of nodes || []) { if (n.edges) out.push(...n.edges); edgesIn(n.nodes, out); }
    return out;
  };
  for (const proc of processes) touching('sequence flow', [...(proc.edges || []), ...edgesIn(proc.nodes)]);
  touching('message flow', lc.messageFlows);
  touching('association', lc.associations);
  return { entries, dataIds };
}

/** Strips the 1.x-only fields in place at every depth; drops data nodes and every connection touching one. */
function strip(processes, m, dataIds) {
  const touches = (c) => dataIds.has(c.source) || dataIds.has(c.target);
  const visit = (holder) => {
    if (!Array.isArray(holder.nodes)) return;
    holder.nodes = holder.nodes.filter((n) => !dataIds.has(n.id));
    for (const node of holder.nodes) {
      delete node.lane;
      delete node.role;
      delete node.system;
      visit(node);
    }
    if (Array.isArray(holder.edges)) holder.edges = holder.edges.filter((e) => !touches(e));
  };
  for (const proc of processes) {
    delete proc.lanes;
    visit(proc);
  }
  if (Array.isArray(m.messageFlows)) m.messageFlows = m.messageFlows.filter((f) => !touches(f));
  if (Array.isArray(m.associations)) m.associations = m.associations.filter((a) => !touches(a));
}

const isPlaceholderKey = (key) => key === UNASSIGNED || key === UNIT_UNKNOWN;

/**
 * The lane comparison of the report over prepared sites, one per compared top-level flow node:
 * `{ nodeId, type, originalLaneId, originalActor, newKey, mg03, laneOfActor }`, where `newKey` is
 * the `_laneActor` of the node's new lane (null when its process gets no lanes), `mg03` says whether
 * the node has an MG03 entry and `laneOfActor` maps the lane actors of its process to their
 * original lane ids. Exported for its test; `migrateModel` is its only caller.
 *
 * An activity's new lane is its performer, so it differs from its original lane exactly when it has
 * an MG03; anything else is a bug of `migrateModel` (an inconsistent mapping), never a finding about
 * the input, and throws `Error('migrate internal error: …')`. An event or gateway that differs gets
 * MG04 `[nodeId, originalLaneId, newLaneId]`: `newLaneId` is the original lane whose actor the new
 * lane is; for a new lane that is no lane actor of the process it is the lane's key (a role actor's
 * id, or the placeholder `_unassigned`/`_unitUnknown`), and without any new lane the element is
 * left out (`[nodeId, originalLaneId]`).
 * @returns {{ laneMatches: number, entries: { code, message, elements }[] }}
 */
export function compareLanes(sites) {
  let laneMatches = 0;
  const entries = [];
  for (const s of sites) {
    const same = s.newKey === s.originalActor;
    if (isActivity(s.type)) {
      if (same === s.mg03) {
        const what = s.mg03 ? `has an MG03 but stays in lane "${q(s.originalLaneId)}"` : `lands outside lane "${q(s.originalLaneId)}" (key "${q(s.newKey)}") without an MG03`;
        throw new Error(`migrate internal error: activity "${q(s.nodeId)}" ${what}`);
      }
      if (same) laneMatches++;
      continue;
    }
    if (same) { laneMatches++; continue; }
    const head = `${q(s.type)} "${q(s.nodeId)}" sat in lane "${q(s.originalLaneId)}";`;
    if (s.newKey === null) {
      entries.push(entry('MG04', `${head} format 2.0 gives its process no lanes (no activity has a performer).`, [s.nodeId, s.originalLaneId]));
    } else if (s.laneOfActor.has(s.newKey)) {
      const laneId = s.laneOfActor.get(s.newKey);
      entries.push(entry('MG04', `${head} the inheritance rule places it in lane "${q(laneId)}".`, [s.nodeId, s.originalLaneId, laneId]));
    } else if (isPlaceholderKey(s.newKey)) {
      entries.push(entry('MG04', `${head} the inheritance rule places it in the placeholder lane "${q(s.newKey)}".`, [s.nodeId, s.originalLaneId, s.newKey]));
    } else {
      entries.push(entry('MG04', `${head} the inheritance rule places it with actor "${q(s.newKey)}", which is no lane of its 1.x process.`, [s.nodeId, s.originalLaneId, s.newKey]));
    }
  }
  return { laneMatches, entries };
}

/** The `_laneActor` of every top-level node's new lane, per process id; a process without lanes maps to null. */
function newLaneKeys(formed) {
  const out = new Map();
  for (const proc of Array.isArray(formed.pools) ? formed.pools : [formed]) {
    if (!Array.isArray(proc.lanes) || proc.lanes.length === 0) { out.set(proc.id, null); continue; }
    const keyOf = new Map(proc.lanes.map((l) => [l.id, l._laneActor]));
    out.set(proc.id, new Map((proc.nodes || []).filter((n) => keyOf.has(n.lane)).map((n) => [n.id, keyOf.get(n.lane)])));
  }
  return out;
}

/**
 * Translates a 1.x model into format 2.0. `catalog` (`{ actors, scheme? }`) gives the scheme whose
 * performs type the assignments use (absent: DEMI, `D`); the new actor ids avoid its ids.
 * `dropUnsupported` drops the fields 2.0 cannot hold yet instead of refusing the model.
 *
 * Without `catalog` the model carries neither a catalogue path nor actors: `catalog` of the result
 * (equal to the supplement) is what a library caller passes to `runPipeline(model, { catalog })`.
 * With `catalog` the model carries the new actors itself (decision 2) and `catalog` of the result is
 * the given catalogue with the supplement appended.
 *
 * @returns {{ model: object|null, supplement: { actors: object[] }|null, catalog: object|null,
 *   report: { status: 'translated'|'refused', entries: { code, message, elements }[],
 *   summary: { processes, lanes, actors, activities, assigned, laneMatches,
 *     deviations: { MG03, MG04, MG05 } } } }} (summary: see `summaryOf`)
 */
export function migrateModel(lc, options = {}) {
  const { catalog = null, dropUnsupported = false } = options ?? {};
  // (1) the gate: a 1.x model only
  if (modelFormat(lc) === '2') {
    return refuse(`it is already format 2.x ($schemaVersion "${q(lc.$schemaVersion)}"); there is nothing to translate`);
  }
  const gate = validateLogicCoreSchema(lc);
  if (!gate.valid) return refuse(`it fails the 1.x schema: ${schemaReason(gate.errors)}`);
  const duplicates = duplicateIds(lc);
  if (duplicates.length) {
    const tail = 'an id names one element of the document';
    const [[id, n]] = duplicates;
    const reason = duplicates.length === 1
      ? `the id "${q(id)}" occurs ${n} times; ${tail}`
      : `the ids ${duplicates.map(([d, k]) => `"${q(d)}" (${k} times)`).join(', ')} occur more than once; ${tail}`;
    return refuse(reason, duplicates.map(([d]) => d));
  }

  const { performs, error: catalogError } = schemeOf(catalog);
  if (catalogError) return refuse(catalogError);

  const m = clone(lc);
  const processes = Array.isArray(m.pools) ? m.pools : [m];
  for (const proc of processes) {
    const missing = proc === m && (proc.id === undefined || proc.id === '');
    if (!missing && !PROCESS_ID.test(proc.id)) {
      return refuse(`${proc === m ? 'process' : 'pool'} id "${q(proc.id)}" does not match ${PROCESS_ID.source}`, [proc.id]);
    }
  }

  const allLanes = processes.map(lanesOf);
  const activities = processes.reduce((n, p) => n + (p.nodes || []).filter((node) => isActivity(node.type) && !isBoundaryEvent(node)).length, 0);
  const counted = { processes: processes.length, lanes: allLanes.reduce((n, l) => n + l.length, 0), actors: 0, activities, assigned: 0 };

  // (2) fields 2.0 cannot hold yet
  const unsupported = unsupportedFields(processes, m, dropUnsupported);
  if (unsupported.entries.length && !dropUnsupported) return refused(unsupported.entries, counted);
  const entries = [...unsupported.entries];

  // (3) the process id of a single process
  if (!Array.isArray(m.pools) && (m.id === undefined || m.id === '')) {
    const used = collectDocumentIds(m);
    let id = 'Process_1';
    for (let n = 2; used.has(id); n++) id = `Process_${n}`;
    m.id = id;
    entries.push(entry('MG06', `the process has no id; it is given "${id}".`, [id]));
  }

  // (4) one actor per lane. Lane ids that are actor ids keep their id (first come); every other lane is renamed.
  const taken = new Set(Array.isArray(catalog?.actors) ? catalog.actors.map((a) => a.id) : []);
  const keeps = new Set();
  for (const lanes of allLanes) {
    for (const { lane } of lanes) {
      if (ACTOR_ID.test(lane.id) && !taken.has(lane.id)) { taken.add(lane.id); keeps.add(lane); }
    }
  }
  const actors = [];
  const created = []; // [actor, 'Lane' | 'Role', source name]
  const laneActor = processes.map(() => new Map()); // per process: lane id → actor id
  const actorName = new Map(); // lane actor id → its name
  const laneByName = processes.map(() => new Map()); // per process: lane actor name → the first such actor id
  allLanes.forEach((lanes, p) => {
    for (const { lane, parent } of lanes) {
      let id = lane.id;
      if (!keeps.has(lane)) {
        const valid = ACTOR_ID.test(lane.id);
        id = uniqueId(valid ? lane.id : laneSlug(lane.id), taken);
        const why = valid ? 'collides with another actor id' : 'is no actor id';
        entries.push(entry('MG06', `lane id "${q(lane.id)}" ${why}; the actor is "${id}".`, [lane.id, id]));
      }
      if (!laneActor[p].has(lane.id)) laneActor[p].set(lane.id, id);
      const actor = { id, name: lane.name || lane.id };
      actorName.set(id, actor.name);
      if (!laneByName[p].has(actor.name)) laneByName[p].set(actor.name, id);
      if (parent) actor.unit = laneActor[p].get(parent.id);
      actors.push(actor);
      created.push([actor, 'Lane', actor.name]);
    }
  });

  // (5) one actor per distinct role of the activities that take an assignment, in document order.
  // A role equal to the name of a lane actor of the same process is that lane actor (its own lane's
  // first, else the first in document order): such a node creates no role actor.
  const laneOf = (proc, p, node) => {
    const laneId = resolveLaneId(proc, node);
    return laneActor[p].has(laneId) ? { laneId, actor: laneActor[p].get(laneId) } : null;
  };
  const namesake = (p, lane, role) => (lane && actorName.get(lane.actor) === role ? lane.actor : laneByName[p].get(role));
  const roles = new Map(); // role → { actor, sites: [{ laneId, actor } | null] }
  processes.forEach((proc, p) => {
    for (const node of proc.nodes || []) {
      if (node.role === undefined || !takesAssignment(proc, node)) continue;
      const lane = laneOf(proc, p, node);
      if (namesake(p, lane, node.role) !== undefined) continue;
      if (!roles.has(node.role)) {
        const actor = { id: uniqueId(roleBase(node.role), taken), name: node.role };
        roles.set(node.role, { actor, sites: [] });
      }
      roles.get(node.role).sites.push(lane);
    }
  });
  for (const { actor, sites } of roles.values()) {
    const distinct = new Set(sites.map((s) => s?.actor ?? null));
    if (distinct.size === 1 && !distinct.has(null)) actor.unit = sites[0].actor;
    actors.push(actor);
    created.push([actor, 'Role', actor.name]);
  }
  for (const [actor, kind, name] of created) {
    entries.push(entry('H07', `${kind} "${q(name)}" became actor "${actor.id}" without kind; check its kind.`, [actor.id]));
  }

  // (6) assignments, in document order; a role on a node that gets no assignment is dropped (MG05)
  let assigned = 0;
  const droppedRoles = (nodes) => {
    for (const node of nodes || []) {
      if (unsupported.dataIds.has(node.id)) continue; // dropped under MG02 already
      if (node.role !== undefined) {
        entries.push(entry('MG05', `role "${q(node.role)}" on ${q(node.type)} "${q(node.id)}" is dropped: format 2.0 gives this node no assignment.`, [node.id]));
      }
      droppedRoles(node.nodes);
    }
  };
  processes.forEach((proc, p) => {
    for (const node of proc.nodes || []) {
      if (!takesAssignment(proc, node)) {
        droppedRoles([node]);
        continue;
      }
      droppedRoles(node.nodes);
      const lane = laneOf(proc, p, node);
      const byRole = node.role !== undefined;
      const named = byRole ? namesake(p, lane, node.role) : undefined;
      const role = byRole && named === undefined ? roles.get(node.role) : null;
      const performer = named ?? (role ? role.actor.id : lane?.actor);
      if (performer === undefined) {
        entries.push(entry('MG05', `node "${q(node.id)}" has no lane in a process with lanes; it gets no assignment.`, [node.id]));
        continue;
      }
      node.assignments = [{ type: performs, actor: performer }];
      assigned++;
      if (byRole && !lane) {
        entries.push(entry('MG05', `node "${q(node.id)}" has no lane in a process with lanes; its role "${q(node.role)}" makes actor "${performer}" its performer.`, [node.id, performer]));
      } else if (byRole && performer !== lane.actor) {
        let text = `node "${q(node.id)}": role "${q(node.role)}" performs it as actor "${performer}", not lane "${q(lane.laneId)}".`;
        if (role && role.actor.unit === undefined) {
          const laneIds = [...new Set(role.sites.filter(Boolean).map((s) => s.laneId))].map((id) => `"${q(id)}"`).join(', ');
          const where = role.sites.includes(null) ? `lanes ${laneIds} and outside any lane` : `lanes ${laneIds}`;
          text += ` Actor "${performer}" has no unit: its activities sit in ${where}.`;
        }
        entries.push(entry('MG03', text, [node.id, lane.laneId, performer]));
      }
    }
  });

  // the sites of the lane comparison, read before the lanes are stripped
  const mg03 = new Set(entries.filter((e) => e.code === 'MG03').map((e) => e.elements[0]));
  const sites = [];
  processes.forEach((proc, p) => {
    if (!hasLanes(proc)) return;
    const laneOfActor = new Map();
    for (const [laneId, actor] of laneActor[p]) if (!laneOfActor.has(actor)) laneOfActor.set(actor, laneId);
    for (const node of proc.nodes || []) {
      if (!FLOW_NODE_TYPES.has(node.type) || isBoundaryEvent(node)) continue;
      const lane = laneOf(proc, p, node);
      if (!lane) continue; // no original lane (MG05 for an activity): nothing to compare
      sites.push({ procId: proc.id, nodeId: node.id, type: node.type, originalLaneId: lane.laneId, originalActor: lane.actor, mg03: mg03.has(node.id), laneOfActor });
    }
  });

  // (7) strip the 1.x-only fields; the version first
  strip(processes, m, unsupported.dataIds);
  delete m.$schemaVersion;
  const supplement = { actors };
  const withCatalog = catalog !== null && catalog !== undefined;
  const model = { $schemaVersion: FORMAT_V2_VERSION, ...m, ...(withCatalog ? { actors: clone(actors) } : {}) };
  const effective = withCatalog ? { ...clone(catalog), actors: [...clone(catalog.actors), ...clone(actors)] } : { actors: clone(actors) };

  // (8) the result must pass the 2.0 gate and the catalogue schema (a lane name over the catalogue's bounds, an empty process)
  const check = validateModelSchema(model, { accept: ['2'] });
  if (!check.valid) return refuse(`the translation fails the format 2.0 schema: ${schemaReason(check.errors)}`, [], counted);
  const catalogProblems = catalogErrors(effective);
  if (catalogProblems.length) return refuse(`the translated actors fail the catalogue schema: ${catalogProblems.join('; ')}`, [], counted);

  // (9) the lane comparison: the result's lanes under the view rollen against the original lanes
  const fields = resolveFields(model, { catalog: withCatalog ? catalog : supplement });
  if (fields.errors.length) return refuse(`the translation fails the catalogue check: ${fields.errors.join('; ')}`, [], counted);
  const formed = formLanes(fields.lc, fields.resolved, { lanes: 'role' });
  if (formed.errors.length) {
    // C10: a lane id L.<process>.<actor> (or its _di) meets an id of the document; the 1.x model has to rename one
    const collisions = formed.errors.map((e) => e.replace(/^\[C10\] /, '').replace(/; rename the catalogue id$/, ''));
    return refuse(`the translation's lanes under the view rollen collide: ${collisions.join('; ')}; rename the lane or flow id in the 1.x model`, [], counted);
  }
  const keys = newLaneKeys(formed.lc);
  const compared = compareLanes(sites.map(({ procId, ...s }) => ({ ...s, newKey: keys.get(procId)?.get(s.nodeId) ?? null })));
  entries.push(...compared.entries);

  return {
    model,
    supplement,
    catalog: effective,
    report: {
      status: 'translated',
      entries: orderEntries(entries),
      summary: summaryOf({ ...counted, actors: actors.length, assigned, laneMatches: compared.laneMatches }, entries),
    },
  };
}
