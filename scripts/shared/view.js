/**
 * Views — the small named file that decides how a model is processed.
 *
 * A view says which rule profile, which layout switches and which derivations apply. It lives
 * outside the model and has the same standing as a rule profile: client input on every channel, so
 * it is bounded, schema-gated (references/view-schema.json, `additionalProperties: false` at every
 * level) and, when named, resolved inside one directory only (views/<name>-view.json).
 *
 * The file machinery is rule-profile.js's (`readBoundedJsonText`, `exceedsBounds`, the same limits);
 * only the failure type differs, so a caller maps `ViewRejectedError` to its own client error.
 * Unlike a rule profile, a view that cannot be found is an error, never an empty view: a typo must
 * not silently fall back to the default.
 */

import { realpathSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  PROFILE_LIMITS, ProfileRejectedError, readBoundedJsonText, exceedsBounds, quoteForMessage,
  isPlainObject, describeSchemaError, jsonErrorLocation, loadNamedRuleProfile,
} from './rule-profile.js';
import { viewSchemaPath, viewsDirPath, rulesDirPath } from './resource-paths.js';

/** Hard limits on view input: those of a rule profile. */
export const VIEW_LIMITS = PROFILE_LIMITS;

/** A view that is refused: unreadable, not JSON, over a bound, or failing the schema. */
export class ViewRejectedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ViewRejectedError';
    this.code = 'VIEW_REJECTED';
  }
}

const VIEW_SCHEMA = JSON.parse(readFileSync(viewSchemaPath(), 'utf8'));
const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(VIEW_SCHEMA);

/** The pipeline options a view's `layout` may set — the schema's list, so the two cannot drift. */
const LAYOUT_KEYS = Object.freeze(Object.keys(VIEW_SCHEMA.properties.layout.properties));

/** Refuse anything that is not a view: not a plain object, too deep or large, or off the schema. Returns the view. */
export function assertView(view, label) {
  if (!isPlainObject(view)) {
    const kind = view === null ? 'null' : Array.isArray(view) ? 'an array' : typeof view === 'object' ? 'a non-plain object' : `a ${typeof view}`;
    throw new ViewRejectedError(`a view must be a JSON object, not ${kind}`);
  }
  const name = label ?? quoteForMessage(view.view);
  const bound = exceedsBounds(view, VIEW_LIMITS);
  if (bound) throw new ViewRejectedError(`view ${name} is ${bound}`);
  if (!validateSchema(view)) {
    const errors = validateSchema.errors ?? [];
    const listed = errors.slice(0, VIEW_LIMITS.schemaErrors).map(describeSchemaError);
    if (errors.length > listed.length) listed.push(`… and ${errors.length - listed.length} more`);
    throw new ViewRejectedError(`view ${name} does not match the view schema: ${listed.join('; ')}`);
  }
  return view;
}

/** Read a view file's text; the shared reader's refusals surface as `ViewRejectedError`. */
function readViewText(path, label) {
  try {
    return readBoundedJsonText(path, { label: 'view', name: label });
  } catch (err) {
    if (err instanceof ProfileRejectedError) throw new ViewRejectedError(err.message);
    throw err;
  }
}

function parseView(text, label) {
  const json = text.replace(/^﻿/, '');
  let view;
  try {
    view = JSON.parse(json);
  } catch (err) {
    // The parser's own message quotes the start of the input; only the position is passed on.
    throw new ViewRejectedError(`view ${label} is not valid JSON at ${jsonErrorLocation(json, err)}`);
  }
  return assertView(view, label);
}

/**
 * A view from a path (local, trusted callers) or an object already in hand. A missing file throws:
 * a view that was asked for and is not there is an error, not "no view".
 */
export function loadView(pathOrObject) {
  if (typeof pathOrObject !== 'string') return assertView(pathOrObject);
  const path = resolve(pathOrObject);
  const label = quoteForMessage(path, 4096); // a local caller's own path, shown whole
  let real;
  try {
    real = realpathSync(path);
  } catch (err) {
    throw new ViewRejectedError(`view ${label} cannot be read (${err.code ?? 'error'})`);
  }
  return parseView(readViewText(real, label), label);
}

const VIEW_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VIEW_SUFFIX = '-view.json';

/** True for a string that is a view NAME (as opposed to a path). */
export function isViewName(value) {
  return typeof value === 'string' && VIEW_NAME.test(value);
}

function shippedNames(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(VIEW_SUFFIX)).map((f) => f.slice(0, -VIEW_SUFFIX.length)).sort();
  } catch {
    return [];
  }
}

/**
 * A view by NAME, from `views/<name>-view.json` of this checkout only (there is no custom/
 * directory). The name is checked before the file system is touched, a symlink leaving the
 * directory is refused, and an unknown name lists the views that exist.
 */
export function loadNamedView(name) {
  const shown = quoteForMessage(name);
  if (!isViewName(name)) {
    throw new ViewRejectedError(`view name ${shown} is not valid — use a name such as "default" or "explicit-joins"`);
  }
  const dir = viewsDirPath();
  if (!dir) throw new ViewRejectedError('named views need a repository checkout; pass a file instead');
  const root = realpathSync(dir);
  let real;
  try {
    real = realpathSync(join(root, `${name}${VIEW_SUFFIX}`));
  } catch {
    const known = shippedNames(root).join(', ');
    throw new ViewRejectedError(`unknown view ${shown} — available: ${known}`);
  }
  if (!real.startsWith(root + sep)) throw new ViewRejectedError(`view ${shown} points outside the views directory`);
  return parseView(readViewText(real, shown), shown);
}

/**
 * The options a pipeline run uses under `view` (an already loaded view, or null for none). For
 * `ruleProfile` and every `layout` key the explicit option wins when it is not `undefined`, then
 * the view's value; a key neither sets stays absent, so config.json's default applies unchanged.
 * `layout.alignParticipantPorts` is one such key (read from the schema like the rest): the view
 * `aligned-ports` switches it on, the explicit option still wins, config.json's `false` otherwise.
 * A view names its rule profile, which resolves inside rules/ only (loadNamedRuleProfile); a
 * name that does not resolve rejects the view. The view's `derivations` and `lanes` (a string or the object form `{ by: 'role'|'unit', level?, nested?, automatic?, automaticName? }`) and its name
 * (`viewName`) are passed on as given; without a view all three are `undefined`.
 *
 * @param {object|null} view - a view that passed assertView, or null
 * @param {object} [opts] - the caller's runPipeline options; never changed
 * @returns {object} `{ ...effectiveOpts, derivations, lanes, viewName }`
 */
export function resolveViewOptions(view, opts = {}) {
  const resolved = { ...opts };
  if (view) {
    if (resolved.ruleProfile === undefined && view.ruleProfile !== undefined) {
      try {
        resolved.ruleProfile = loadNamedRuleProfile(view.ruleProfile, rulesDirPath());
      } catch (err) {
        if (err instanceof ProfileRejectedError) {
          throw new ViewRejectedError(`view ${quoteForMessage(view.view)}: ${err.message}`);
        }
        throw err;
      }
    }
    for (const key of LAYOUT_KEYS) {
      if (resolved[key] === undefined && view.layout?.[key] !== undefined) resolved[key] = view.layout[key];
    }
  }
  return { ...resolved, derivations: view?.derivations, lanes: view?.lanes, viewName: view?.view };
}
