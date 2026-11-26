/**
 * The registry of message codes of a format 2.x run.
 *
 * A code names a kind of message, not its wording. A text carrier keeps its string and leads with
 * `[<code>] `; an object carrier (a schema-gate entry, a finding, a notice, an HTTP error body)
 * carries the code as a field of its own; a thrown error carries it as `messageCode`.
 * `message-codes.test.js` fences the sources: every bracketed code literal and every `coded(…)` /
 * `withCode(…)` names a code of this registry, and every code has a row in the "Message codes"
 * section of references/api-reference.md.
 *
 * No dependencies. Families: `catalogue` (C), `format` (F), `hint` (H), `notice` (N).
 */

const entry = (family, summary) => Object.freeze({ family, summary });

export const MESSAGE_CODES = Object.freeze({
  C01: entry('catalogue', 'a reference to an actor or unit that the catalogue does not have, or assignments without a catalogue'),
  C02: entry('catalogue', 'an actor\'s unit is a role, not a unit'),
  C03: entry('catalogue', 'an actor id occurs more than once in the catalogue'),
  C04: entry('catalogue', 'an assignment type outside the scheme, or more than one performer on a node'),
  C05: entry('catalogue', 'an assignment type not allowed on this kind of node'),
  C06: entry('catalogue', 'the responsibility scheme is unknown or malformed'),
  C07: entry('catalogue', 'units nest in a cycle: partOf leads back to the unit it started from'),
  C10: entry('catalogue', 'a lane id collides with another id of the model'),
  C11: entry('catalogue', 'the catalogue cannot be read: missing, not a regular file, too large, not JSON, or an empty path'),
  C12: entry('catalogue', 'the catalogue content is refused: bounds or catalogue schema, also model-carried actors'),
  C13: entry('catalogue', 'the catalogue source is wrong for a 2.x model: a path without an object, a catalogue besides model-carried actors, or a catalog field on stdin'),
  F01: entry('format', 'a format 2.0 schema violation (one per schema error)'),
  F02: entry('format', 'a $schemaVersion of the 2 line other than "2.0"'),
  F03: entry('format', 'format 2.0 is not accepted at this entry point'),
  F04: entry('format', 'an option or mode that is not available for format 2.0'),
  F05: entry('format', 'a decisions option that fails the Decision-Core schema'),
  H01: entry('hint', 'a join gateway was derived in front of a node that more than one flow enters'),
  H02: entry('hint', 'a node has no performer and is placed in the unassigned lane'),
  H03: entry('hint', 'an automatic step has no performer and is placed in its neighbour\'s lane'),
  H04: entry('hint', 'the unit of a performer is not recorded'),
  H05: entry('hint', 'a lane name is longer than the lane name limit'),
  H06: entry('hint', 'a process has no assignments, so no lanes'),
  H08: entry('hint', 'a node has no neighbour with a lane (or a boundary event no host with a lane) and is placed in the unassigned lane'),
  N01: entry('notice', 'a format 2.0 import notice'),
});

const CODE_PREFIX = /^\[([A-Z]{1,2}\d{2})\] /;

/** `[code] text`; throws for a code that is not registered. */
export function coded(code, text) {
  if (!Object.hasOwn(MESSAGE_CODES, code)) throw new Error(`unregistered message code "${code}"`);
  return `[${code}] ${text}`;
}

/** The registered code of a leading bracketed one- or two-letter code prefix, else null. */
export function codeOf(text) {
  if (typeof text !== 'string') return null;
  const m = CODE_PREFIX.exec(text);
  return m && Object.hasOwn(MESSAGE_CODES, m[1]) ? m[1] : null;
}

/**
 * Sets `err.messageCode` and prefixes `err.message` with `[code] ` unless it already carries that
 * prefix. The class and any class code (`err.code`) stay. Returns `err`.
 */
export function withCode(err, code) {
  if (!Object.hasOwn(MESSAGE_CODES, code)) throw new Error(`unregistered message code "${code}"`);
  err.messageCode = code;
  const prefix = `[${code}] `;
  if (!err.message.startsWith(prefix)) err.message = prefix + err.message;
  return err;
}
