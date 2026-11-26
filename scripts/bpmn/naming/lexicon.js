/**
 * Reader for the naming data files (`references/naming/<language>.json`).
 *
 * The schema is read and the validator compiled on the FIRST call, never at import: the rule
 * engine imports this module, and a model without `language` must read no naming file.
 */

import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { namingSchemaPath } from '../../shared/resource-paths.js';
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
function validator() {
  if (validate === null) {
    validate = new Ajv2020({ allErrors: true, strict: true })
      .compile(JSON.parse(readFileSync(namingSchemaPath(), 'utf8')));
  }
  return validate;
}

const byLengthDesc = (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0);
const foldedSet = (list) => new Set((list ?? []).map(foldWord));
const foldedPrefixes = (list) => (list ?? []).map(foldWord).sort(byLengthDesc);
const failure = (path, reason) => new NamingDataError(`naming data "${path}" ${reason}`);

function describeFirstError(errors) {
  const e = errors[0];
  return `${e.instancePath || '/'} ${e.message}`;
}

/** Reads, validates and folds one naming data file. Throws `NamingDataError`. */
export function readLexiconFile(path) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw failure(path, `cannot be read: ${e.message}`);
  }
  const check = validator();
  if (!check(data)) {
    throw failure(path, `does not match the naming schema: ${describeFirstError(check.errors)}`);
  }
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
    participles: {
      suffix: data.participles.suffix,
      irregular: foldedSet(data.participles.irregular),
      exceptions: foldedSet(data.participles.exceptions),
    },
    verbPhrases: (data.verbPhrases ?? []).map((p) => p.split(' ').map(foldWord)),
    verbPrefixes: foldedPrefixes(data.verbPrefixes),
    separablePrefixes: foldedPrefixes(data.separablePrefixes),
    inseparablePrefixes: foldedPrefixes(data.inseparablePrefixes),
    infinitiveSuffixes: (data.infinitiveSuffixes ?? []).map((s) => ({ suffix: s.suffix, minLength: s.minLength })),
    eventMarkers: Object.fromEntries(Object.entries(data.eventMarkers).map(([k, v]) => [k, v.map(foldWord)])),
    nounsCapitalized: data.nounsCapitalized,
    compoundMarkers: data.compoundMarkers,
    questionMarks: data.questionMarks,
    examples: data.examples,
    sources: data.sources,
  };
  return Object.freeze(lexicon);
}
