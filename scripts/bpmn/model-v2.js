/**
 * Format 2.0, first stage (design 7.3 step 2, 7.5, 8): `resolveFields` checks a 2.0 model against its
 * actor catalogue and responsibility scheme (rules C01–C06) and translates it into the intermediate
 * form the pipeline already reads — the 1.x shape without lanes, plus private carrier fields.
 *
 * The C rules run here and are not entries of the rule register (design 8). Nothing here sets
 * `role`, `system` or `lane`: lanes are formed later from the catalogue and the chosen view.
 */

import { validateModelSchema } from './schema-gate.js';
import { isEvent, isGateway } from './types.js';
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
  if (!gate.valid) return fail(gate.errors.map((e) => `[format 2.0] ${e.path} ${e.message}`));

  // (2) the source of the actors
  let source = null;
  if (catalog !== undefined && catalog !== null) {
    if (model.actors !== undefined) {
      return fail(['[catalog] the model carries actors and a catalogue was passed; replacing entries comes in a later version']);
    }
    source = catalog;
  } else if (typeof model.catalog === 'string') {
    return fail([`[catalog] the model names catalogue "${q(model.catalog)}" but no catalogue object was passed — the CLI reads it relative to the model file, a library caller passes { catalog }`]);
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
  for (const node of nodes) {
    for (const a of node.assignments ?? []) {
      if (!byId.has(a.actor)) errors.push(`[C01] node "${q(node.id)}": actor "${q(a.actor)}" is not in the catalogue`);
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
