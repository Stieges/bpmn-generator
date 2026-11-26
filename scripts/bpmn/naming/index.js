/**
 * The natural language of a model's labels: the optional top-level `language` of both input
 * formats, a language tag with a lowercase primary subtag ("de", "en-GB").
 *
 * A value that is not a valid tag counts as absent everywhere: nothing is written and nothing is
 * selected by it, so such a model gives the same results as one without the field.
 */

/** The `language` pattern of `references/input-schema.json` and `references/input-schema-v2.json`. */
export const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

import { loadLexicon, NAMING_LANGUAGES, NamingDataError } from './lexicon.js';
import { verbFirst } from './verb-first.js';
import { verbLast } from './verb-last.js';
import { isEvent } from '../types.js';
// A cycle with ../icons.js (it imports `namingFor`): both sides use the other's binding inside
// functions only, never while the module is evaluated.
import { inferEventMarker } from '../icons.js';

export { NAMING_LANGUAGES, NamingDataError };

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The whole valid tag of `lc.language` (`"en-GB"`), else `null`. Never throws. */
export function languageTag(lc) {
  let tag;
  try {
    if (!isPlainObject(lc)) return null;
    tag = lc.language;
  } catch {
    return null; // a throwing getter or proxy trap
  }
  return typeof tag === 'string' && LANGUAGE_TAG.test(tag) ? tag : null;
}

/** The primary subtag of the model's language (`"en-GB"` → `"en"`), else `null`. Never throws. */
export function modelLanguage(lc) {
  const tag = languageTag(lc);
  return tag === null ? null : tag.split('-')[0];
}

const BUILDERS = { 'verb-last': verbLast, 'verb-first': verbFirst };
const strategies = new Map();

/**
 * The naming strategy of a registered language, else `null` (no language, or one without data).
 * Word lists are extended by the file `BPMN_NAMING` names, read when this is called. Nothing is
 * read before the first call for a registered language; an unusable data file or overlay throws
 * a `NamingDataError`. Cached with the lexicon.
 */
export function namingFor(language) {
  if (typeof language !== 'string' || !Object.hasOwn(NAMING_LANGUAGES, language)) return null;
  const overlayPath = process.env.BPMN_NAMING || null;
  const key = `${language}\0${overlayPath ?? ''}`;
  if (!strategies.has(key)) {
    const lexicon = loadLexicon(language, { overlayPath });
    strategies.set(key, BUILDERS[lexicon.wordOrder](lexicon));
  }
  return strategies.get(key);
}

/** The English name of a language ("German"), else `language "<code>"`. */
function languageName(code) {
  let name;
  try {
    name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
  } catch {
    name = undefined;
  }
  return !name || name === code ? `language "${code}"` : name;
}

const CONVENTIONS = { 'verb-last': 'object + infinitive', 'verb-first': 'verb + object' };

/**
 * The finding text of a name that breaks a naming convention of `naming` (a strategy).
 * `kind` is `task`, `container` (`nodeType` `callActivity` reads "Call activity", every other
 * container "Subprocess"), `event` or `message`.
 */
export function namingMessage(naming, kind, name, nodeType) {
  const language = languageName(naming.language);
  const examples = naming.examples;
  switch (kind) {
    case 'task':
      return `Task "${name}" does not follow the ${language} convention ${CONVENTIONS[naming.wordOrder]} (e.g. "${examples.task}").`;
    case 'container':
      return `${nodeType === 'callActivity' ? 'Call activity' : 'Subprocess'} "${name}" is named like a state or a bare verb; name it as an activity (e.g. "${examples.task}" or "${examples.subprocess}").`;
    case 'event':
      return `Event "${name}" is named like an activity; the ${language} convention for events is a state or a noun (e.g. "${examples.event}").`;
    case 'message':
      return `Message flow "${name}" is named like an activity or a state; the ${language} convention for message flows is a noun phrase (e.g. "${examples.message}").`;
    default:
      throw new TypeError(`unknown naming kind "${kind}"`);
  }
}

/**
 * The `NamingDataError` behind an error, following `cause` (the orchestrator wraps agent errors),
 * else `null`. Bounded depth, so a cyclic `cause` chain ends.
 */
export function namingDataErrorOf(err) {
  for (let e = err, depth = 0; e && depth < 8; e = e.cause, depth++) {
    if (e instanceof NamingDataError) return e;
  }
  return null;
}

/** Fails early on an unusable `BPMN_NAMING` file: loads every registered language with it. */
export function checkNamingOverlay(env = process.env) {
  if (!env.BPMN_NAMING) return;
  for (const language of Object.keys(NAMING_LANGUAGES)) loadLexicon(language, { overlayPath: env.BPMN_NAMING });
}

/** Every node of a model with its pool's name (`null` outside a collaboration), in document order. Never throws. */
function nodesWithPool(lc) {
  const out = [];
  if (!isPlainObject(lc)) return out;
  const walk = (nodes, pool) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!isPlainObject(node)) continue;
      out.push({ node, pool });
      walk(node.nodes, pool);
    }
  };
  if (Array.isArray(lc.pools)) {
    for (const p of lc.pools) if (isPlainObject(p)) walk(p.nodes, String(p.name || p.id));
  } else {
    walk(lc.nodes, null);
  }
  return out;
}

/**
 * Decides the marker of every event of a model in a supported language, once, for the rules and
 * both writers. `lc` is changed in place — `runPipeline` passes its private copy.
 *
 * First every `_marker` key is removed from every node, so a key a caller supplied decides nothing.
 * Then, when the model's language has a strategy, every event without a `marker` gets `_marker`:
 * the marker its name implies in that language, or `null`. Without a strategy nothing is written.
 *
 * @returns {{ inferred: Marked[], changed: Marked[] }} `Marked` is `{ id, name, type, marker,
 *   legacy, pool }` (`marker` what was written, `legacy` what the inference without a language reads
 *   from the name, `pool` the pool's name in a collaboration, else `null`). `inferred`: the events
 *   that got a marker; `changed`: the events whose `legacy` is a marker and not the one written.
 *   Both in document order.
 */
export function resolveEventMarkers(lc) {
  const all = nodesWithPool(lc);
  for (const { node } of all) delete node._marker;
  const strategy = namingFor(modelLanguage(lc));
  const inferred = [];
  const changed = [];
  if (strategy === null) return { inferred, changed };
  for (const { node, pool } of all) {
    if (!isEvent(node.type) || node.marker) continue;
    const name = typeof node.name === 'string' ? node.name : '';
    const marker = strategy.eventMarker(name, node.type);
    node._marker = marker;
    const legacy = inferEventMarker(name);
    const entry = { id: node.id, name, type: node.type, marker, legacy, pool };
    if (marker !== null) inferred.push(entry);
    if (legacy !== null && legacy !== marker) changed.push(entry);
  }
  return { inferred, changed };
}

/**
 * The hints of the naming layer for a model in a supported language, from the lists of
 * `resolveEventMarkers`: H10 per event whose marker was inferred from its name, then H11 per event
 * whose name gave a marker before a language was declared and now gives none or another one (such
 * an event gets H11 only). In a collaboration the message starts with `[<pool name>] `.
 */
export function namingHints(lc, { inferred = [], changed = [] } = {}) {
  const tag = languageTag(lc);
  const lead = (e) => `${e.pool === null ? '' : `[${e.pool}] `}Event "${e.name}" (${e.id})`;
  const isChanged = new Set(changed);
  return [
    ...inferred.filter((e) => !isChanged.has(e)).map((e) => ({
      code: 'H10',
      message: `${lead(e)}: marker "${e.marker}" inferred from its name (language "${tag}").`,
      elements: [String(e.id)],
    })),
    ...changed.map((e) => ({
      code: 'H11',
      message: `${lead(e)}: its name gave marker "${e.legacy}" before a language was declared; under language "${tag}" it gives ${e.marker === null ? 'no marker' : `"${e.marker}"`}. Set "marker" explicitly.`,
      elements: [String(e.id)],
    })),
  ];
}
