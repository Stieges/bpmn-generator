/**
 * The registry of message codes.
 *
 * A code names a kind of message, not its wording. A text carrier keeps its string and leads with
 * `[<code>] `; an object carrier (a schema-gate entry, a finding, a notice, an HTTP error body)
 * carries the code as a field of its own; a thrown error carries it as `messageCode`.
 * `message-codes.test.js` fences the sources: every bracketed code literal and every `coded(…)` /
 * `withCode(…)` names a code of this registry, and every code has a row in the "Message codes"
 * section of references/api-reference.md.
 *
 * No dependencies. Families: `catalogue` (C), `format` (F), `hint` (H), `migrate` (MG), `notice` (N).
 */

const entry = (family, summary) => Object.freeze({ family, summary });

export const MESSAGE_CODES = Object.freeze({
  C01: entry('catalogue', 'a reference to an actor or unit that the catalogue does not have, or assignments without a catalogue'),
  C02: entry('catalogue', 'an actor\'s unit is a role, not a unit'),
  C03: entry('catalogue', 'an id occurs more than once in the catalogue (actors and systems share one id space)'),
  C04: entry('catalogue', 'an assignment type outside the scheme, or more than one performer on a node'),
  C05: entry('catalogue', 'an assignment type not allowed on this kind of node'),
  C06: entry('catalogue', 'the responsibility scheme is unknown or malformed'),
  C07: entry('catalogue', 'units nest in a cycle: partOf leads back to the unit it started from'),
  C10: entry('catalogue', 'a lane id collides with another id of the model'),
  C11: entry('catalogue', 'the catalogue cannot be read: missing, not a regular file, too large, not JSON, or an empty path'),
  C12: entry('catalogue', 'the catalogue content is refused: bounds or catalogue schema, also model-carried actors'),
  C13: entry('catalogue', 'the catalogue source is wrong for a 2.x model: a path without an object, the process file changing the scheme of a catalogue, or a catalog field on stdin'),
  C14: entry('catalogue', 'a system reference that names no system of the catalogue (an unknown id, an actor id), or systems without a catalogue'),
  C15: entry('catalogue', 'a step field on a node that cannot carry it: system off a task'),
  F01: entry('format', 'a format 2.0 schema violation (one per schema error)'),
  F02: entry('format', 'a $schemaVersion of the 2 line other than "2.0" and "2.1"'),
  F03: entry('format', 'format 2.0 is not accepted at this entry point'),
  F04: entry('format', 'an option or mode that is not available for format 2.0'),
  F05: entry('format', 'a decisions option that fails the Decision-Core schema'),
  F06: entry('format', 'a field of a later 2.x version in a model that declares an earlier one (system or systems in a "2.0" model)'),
  H01: entry('hint', 'a join gateway was derived in front of a node that more than one flow enters'),
  H02: entry('hint', 'a node has no performer and is placed in the unassigned lane'),
  H03: entry('hint', 'an automatic step has no performer and is placed in its neighbour\'s lane'),
  H04: entry('hint', 'the unit of a performer is not recorded'),
  H05: entry('hint', 'a lane name is longer than the lane name limit'),
  H06: entry('hint', 'a process has no assignments, so no lanes'),
  H07: entry('hint', 'migrate: a lane or a role became an actor without kind; check its kind'),
  H08: entry('hint', 'a node has no neighbour with a lane (or a boundary event no host with a lane) and is placed in the unassigned lane'),
  H09: entry('hint', 'a catalogue entry (actor or system) is replaced by an entry of the process file'),
  H10: entry('hint', 'the marker of an event was inferred from its name, under the declared language'),
  H11: entry('hint', 'the name of an event gave a marker before a language was declared and gives none or another one under it'),
  H12: entry('hint', 'the declared language has no naming conventions, so the naming rules M01, M05 and M06 are skipped'),
  H13: entry('hint', 'the task names follow the naming convention of another registered language than the declared one'),
  H14: entry('hint', 'task names pass the naming convention only because their first word is not on the verb list of the declared language'),
  H15: entry('hint', 'a message flow crosses an uninvolved participant in every order of the stacked participants; its DI05 does not fail --strict'),
  H16: entry('hint', 'a label is broken inside a word that has no break point; a soft hyphen (U+00AD) in the name sets one'),
  H17: entry('hint', 'a message start, catch or boundary event or a receive task has no incoming message flow in a model with more than one participant'),
  H18: entry('hint', 'a flow crosses a label, an edge label sits nearer to a foreign shape than to its own flow, or two labels overlap or nearly touch'),
  MG01: entry('migrate', 'migrate refuses the input: not a valid 1.x model (a format 2.x model included), an id that occurs more than once in the document, a process or pool id outside the 2.0 pattern, a malformed catalogue, or a translation that fails the final self-check (the format 2.0 gate, the catalogue schema, or the catalogue check and lane formation of the lane comparison)'),
  MG02: entry('migrate', 'a field format 2.0 cannot hold yet (system, a data object or data store reference, a flow or association touching one); refused, or dropped and listed with dropUnsupported'),
  MG03: entry('migrate', 'an activity\'s role differs from its lane: the role\'s actor (a role actor, or the lane actor of the same process the role names) performs it; also says when that role actor gets no unit because its activities sit in several lanes'),
  MG04: entry('migrate', 'an event or gateway lands in another lane under the inheritance rule (view rollen) than in the 1.x model'),
  MG05: entry('migrate', 'an activity without a lane in a process with lanes (no assignment, or its role\'s actor as performer), or a role dropped from a node that gets no assignment'),
  MG06: entry('migrate', 'an id was renamed to fit format 2.0 (no actor id, or a collision with another actor id), or a process without id was given one'),
  MG07: entry('migrate', 'a lane or role was mapped by its exact name to an actor of the given catalogue (the first one when several share the name)'),
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
