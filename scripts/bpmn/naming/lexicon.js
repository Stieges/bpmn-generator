/**
 * Reader for the naming data files (`references/naming/<language>.json`).
 *
 * The schema is read and the validator compiled on the FIRST call, never at import: the rule
 * engine imports this module, and a model without `language` must read no naming file.
 */

import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { namingSchemaPath, namingEnPath, namingDePath } from '../../shared/resource-paths.js';
import { readBoundedJsonText, ProfileRejectedError } from '../../shared/rule-profile.js';
import { foldWord } from './tokens.js';

export { namingSchemaPath };

/** Naming data that cannot be read or does not match the naming schema. */
export class NamingDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NamingDataError';
    this.code = 'NAMING_DATA';
  }
}

let validate = null;
let validateOverlay = null;
function compileSchema() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const schema = JSON.parse(readFileSync(namingSchemaPath(), 'utf8'));
  validate = ajv.compile(schema);
  validateOverlay = ajv.compile({ $schema: schema.$schema, $defs: schema.$defs, $ref: '#/$defs/Overlay' });
}
function validator() {
  if (validate === null) compileSchema();
  return validate;
}
function overlayValidator() {
  if (validateOverlay === null) compileSchema();
  return validateOverlay;
}

const byLengthDesc = (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0);
const foldedSet = (list) => new Set((list ?? []).map(foldWord));
const foldedPrefixes = (list) => (list ?? []).map(foldWord).sort(byLengthDesc);
const failure = (path, reason) => new NamingDataError(`naming data "${path}" ${reason}`);

function describeFirstError(errors) {
  const e = errors[0];
  return `${e.instancePath || '/'} ${e.message}`;
}

/** Reads and validates one naming data file, unfolded. Throws `NamingDataError`. */
function readData(path) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw failure(path, `cannot be read: ${e.message}`);
  }
  let check;
  try {
    check = validator();
  } catch (e) {
    throw failure(path, `cannot be validated: ${e.message}`);
  }
  if (!check(data)) {
    throw failure(path, `does not match the naming schema: ${describeFirstError(check.errors)}`);
  }
  return data;
}

function buildLexicon(data) {
  const lexicon = {
    language: data.language,
    wordOrder: data.wordOrder,
    verbs: foldedSet(data.verbs),
    nounVerbHomographs: foldedSet(data.nounVerbHomographs),
    stateWords: foldedSet(data.stateWords),
    stateMarkers: foldedSet(data.stateMarkers),
    participleHomographs: foldedSet(data.participleHomographs),
    geInfinitives: foldedSet(data.geInfinitives),
    adjectiveStoplist: foldedSet(data.adjectiveStoplist),
    conjunctions: foldedSet(data.conjunctions),
    nonVerbStarters: foldedSet(data.nonVerbStarters),
    nounStarters: foldedSet(data.nounStarters),
    auxiliaries: foldedSet(data.auxiliaries),
    messageNouns: foldedSet(data.messageNouns),
    instructionVerbs: foldedSet(data.instructionVerbs),
    participles: {
      suffix: data.participles.suffix,
      irregular: foldedSet(data.participles.irregular),
      exceptions: foldedSet(data.participles.exceptions),
    },
    verbPhrases: (data.verbPhrases ?? []).map((p) => p.split(' ').map(foldWord)),
    verbPrefixes: foldedPrefixes(data.verbPrefixes),
    separablePrefixes: foldedPrefixes(data.separablePrefixes),
    inseparablePrefixes: foldedPrefixes(data.inseparablePrefixes),
    infinitiveSuffixes: (data.infinitiveSuffixes ?? []).map((s) => (s.exceptions
      ? { suffix: s.suffix, minLength: s.minLength, exceptions: foldedSet(s.exceptions) }
      : { suffix: s.suffix, minLength: s.minLength })),
    eventMarkers: Object.fromEntries(Object.entries(data.eventMarkers).map(([k, v]) => [k, v.map(foldWord)])),
    nounsCapitalized: data.nounsCapitalized,
    compoundMarkers: data.compoundMarkers,
    compoundExceptions: (data.compoundExceptions ?? []).map(foldWord),
    questionMarks: data.questionMarks,
    examples: data.examples,
    sources: data.sources,
  };
  return Object.freeze(lexicon);
}

/** Reads, validates and folds one naming data file. Throws `NamingDataError`. */
export function readLexiconFile(path) {
  return buildLexicon(readData(path));
}

/** Language → path function of its naming data file: the one registry line per language. */
export const NAMING_LANGUAGES = Object.freeze({ de: namingDePath, en: namingEnPath });

const loaded = new Map();

const phraseKey = (w) => w.split(' ').map(foldWord).join(' ');
const wordKey = (list, w) => (list === 'verbPhrases' ? phraseKey(w) : foldWord(w));

/** Reads and validates a BPMN_NAMING overlay. Every failure is a `NamingDataError` naming the path. */
function readOverlay(path) {
  let text;
  try {
    text = readBoundedJsonText(path, { label: 'naming overlay', name: path });
  } catch (e) {
    if (e instanceof ProfileRejectedError) throw failure(path, `cannot be used as a naming overlay: ${e.message}`);
    throw failure(path, `cannot be read: ${e.message}`);
  }
  let overlay;
  try {
    overlay = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    throw failure(path, `is not valid JSON: ${e.message}`);
  }
  let check;
  try {
    check = overlayValidator();
  } catch (e) {
    throw failure(path, `cannot be validated: ${e.message}`);
  }
  if (!check(overlay)) {
    throw failure(path, `does not match the naming overlay schema: ${describeFirstError(check.errors)}`);
  }
  for (const language of Object.keys(overlay.languages)) {
    if (!Object.hasOwn(NAMING_LANGUAGES, language)) {
      throw failure(path, `names language "${language}", for which no naming data ships`);
    }
  }
  return overlay;
}

/** The data with the overlay's words of its language added, then removed (compared folded). */
function applyOverlay(data, languageOverlay) {
  if (!languageOverlay) return data;
  const out = { ...data };
  const lists = new Set([
    ...Object.keys(languageOverlay.add ?? {}), ...Object.keys(languageOverlay.remove ?? {}),
  ]);
  for (const list of lists) {
    const seen = new Set();
    let words = [];
    for (const w of [...(data[list] ?? []), ...(languageOverlay.add?.[list] ?? [])]) {
      const k = wordKey(list, w);
      if (!seen.has(k)) { seen.add(k); words.push(w); }
    }
    const drop = new Set((languageOverlay.remove?.[list] ?? []).map((w) => wordKey(list, w)));
    words = words.filter((w) => !drop.has(wordKey(list, w)));
    out[list] = words;
  }
  return out;
}

/**
 * The lexicon of a registered language, read once per language and overlay path. With `overlayPath`
 * (the `BPMN_NAMING` file) its words are added to and removed from the flat word lists first.
 * Throws `NamingDataError` for an unregistered language or any unusable data or overlay.
 */
export function loadLexicon(language, { overlayPath = null } = {}) {
  if (!Object.hasOwn(NAMING_LANGUAGES, language)) {
    throw new NamingDataError(`no naming data for language "${language}"`);
  }
  const key = `${language}\0${overlayPath ?? ''}`;
  if (!loaded.has(key)) {
    const data = readData(NAMING_LANGUAGES[language]());
    const overlay = overlayPath === null ? null : readOverlay(overlayPath);
    loaded.set(key, buildLexicon(applyOverlay(data, overlay?.languages[language])));
  }
  return loaded.get(key);
}
