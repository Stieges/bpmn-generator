/**
 * The actor catalogue — the list of roles and units a 2.0 model points at, and the responsibility
 * scheme (DEMI by default) that names the assignment types.
 *
 * A catalogue is client input, so it has the standing of a view: bounded, then schema-gated
 * (references/catalog-schema.json, `additionalProperties: false` at every level). The file
 * machinery is rule-profile.js's (`readBoundedJsonText`, `exceedsBounds`); only the limits and the
 * failure type differ. The fingerprint (design 11 a) lets an importer recompute which catalogue a
 * model was generated against.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  ProfileRejectedError, readBoundedJsonText, exceedsBounds, quoteForMessage,
  describeSchemaError, jsonErrorLocation,
} from './rule-profile.js';
import { catalogSchemaPath, demiSchemePath } from './resource-paths.js';
import { coded, withCode } from './message-codes.js';

/** Hard limits on catalogue input; a catalogue of a few thousand actors must fit. */
export const CATALOG_LIMITS = Object.freeze({
  inlineBytes: 1024 * 1024, // estimated JSON size of a catalogue object, checked before the schema
  fileBytes: 1024 * 1024,   // size of a catalogue file, checked before it is read
  depth: 5,                 // object/array nesting (root, actors, actor, scheme types, type)
  messages: 20,             // errors listed before "… and N more"
  schemaErrors: 5,          // schema problems listed in one refusal
  token: 80,                // characters of one client-derived token in a message
});

/** A catalogue that is refused: unreadable, not JSON, over a bound, or failing the schema. */
export class CatalogRejectedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CatalogRejectedError';
    this.code = 'CATALOG_REJECTED';
  }
}

const validateSchema = new Ajv2020({ allErrors: true, strict: true })
  .compile(JSON.parse(readFileSync(catalogSchemaPath(), 'utf8')));

/** Problems of a catalogue as `[C12] <path> <message>` lines: bounds first, then the schema. `[]` when valid. */
export function catalogErrors(catalog) {
  const bound = exceedsBounds(catalog, CATALOG_LIMITS);
  if (bound) return [coded('C12', `"/" is ${bound}`)];
  if (validateSchema(catalog)) return [];
  // An `if` error only says that a `then` or `else` failed; that one is the readable entry.
  const errors = (validateSchema.errors ?? []).filter((e) => e.keyword !== 'if').map((e) => coded('C12', describeSchemaError(e)));
  if (errors.length > CATALOG_LIMITS.messages) {
    const more = errors.length - CATALOG_LIMITS.messages;
    return [...errors.slice(0, CATALOG_LIMITS.messages), coded('C12', `… and ${more} more`)];
  }
  return errors;
}

function readCatalogText(path, label) {
  try {
    return readBoundedJsonText(path, { label: 'catalog', name: label, maxBytes: CATALOG_LIMITS.fileBytes });
  } catch (err) {
    if (err instanceof ProfileRejectedError) throw withCode(new CatalogRejectedError(err.message), 'C11');
    throw err;
  }
}

/** A catalogue from a file path (local, trusted callers). Anything but a valid catalogue throws `CatalogRejectedError`. */
export function loadCatalog(path) {
  const abs = resolve(path);
  const label = quoteForMessage(abs, 4096);
  let real;
  try {
    real = realpathSync(abs);
  } catch (err) {
    throw withCode(new CatalogRejectedError(`catalog ${label} cannot be read (${err.code ?? 'error'})`), 'C11');
  }
  const json = readCatalogText(real, label).replace(/^﻿/, '');
  let catalog;
  try {
    catalog = JSON.parse(json);
  } catch (err) {
    // The parser's own message quotes the start of the input; only the position is passed on.
    throw withCode(new CatalogRejectedError(`catalog ${label} is not valid JSON at ${jsonErrorLocation(json, err)}`), 'C11');
  }
  const errors = catalogErrors(catalog);
  if (errors.length) {
    const listed = errors.slice(0, CATALOG_LIMITS.schemaErrors).map((e) => e.slice('[C12] '.length));
    throw withCode(new CatalogRejectedError(`catalog ${label} is refused: ${listed.join('; ')}`), 'C12');
  }
  return catalog;
}

/** Names of the schemes that ship in references/schemes/<name>-scheme.json. */
export const SHIPPED_SCHEMES = Object.freeze(['demi']);

const SCHEME_PATHS = Object.freeze({ demi: demiSchemePath });

/**
 * The scheme object for a catalogue's `scheme` field: absent means DEMI, a shipped name its file,
 * an object itself, anything else (an unknown name, a number, an array, `null`) `null` (the caller reports it).
 */
export function resolveScheme(ref) {
  if (ref === undefined) ref = 'demi';
  if (typeof ref === 'string') {
    if (!Object.hasOwn(SCHEME_PATHS, ref)) return null;
    return JSON.parse(readFileSync(SCHEME_PATHS[ref](), 'utf8'));
  }
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) return null;
  return ref;
}

/** JSON with keys sorted at every level, arrays in order, no whitespace; strings as JSON.stringify writes them. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** `sha256:<hex>` over the UTF-8 bytes of the canonical JSON of `{ actors, scheme }` (scheme as a resolved object). */
export function catalogFingerprint(actors, scheme) {
  return `sha256:${createHash('sha256').update(canonicalJson({ actors, scheme }), 'utf8').digest('hex')}`;
}
