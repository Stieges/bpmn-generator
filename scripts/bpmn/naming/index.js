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

/** Fails early on an unusable `BPMN_NAMING` file: loads every registered language with it. */
export function checkNamingOverlay(env = process.env) {
  if (!env.BPMN_NAMING) return;
  for (const language of Object.keys(NAMING_LANGUAGES)) loadLexicon(language, { overlayPath: env.BPMN_NAMING });
}
