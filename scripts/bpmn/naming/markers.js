/**
 * Event markers a label can imply, and where each marker is legal (BPMN 2.0.2, Tables 10.84–10.90
 * and 10.93). Data and one pure function; no I/O.
 */

import { labelTokens } from './tokens.js';
import { isWrittenEventSubProcess } from '../types.js';

/** The markers a label can imply, in the order they are tried. */
export const INFERABLE_MARKERS = Object.freeze(['message', 'timer', 'error', 'signal', 'escalation', 'conditional']);

const ALL = ['startEvent', 'intermediateCatchEvent', 'intermediateThrowEvent', 'boundaryEvent', 'endEvent'];

/** Marker → the event types that may carry it (BPMN 2.0.2, Tables 10.84–10.90 and 10.93). */
export const MARKER_ALLOWED_ON = Object.freeze({
  message: Object.freeze([...ALL]),
  timer: Object.freeze(['startEvent', 'intermediateCatchEvent', 'boundaryEvent']),
  error: Object.freeze(['boundaryEvent', 'endEvent']),
  signal: Object.freeze([...ALL]),
  escalation: Object.freeze(['intermediateThrowEvent', 'boundaryEvent', 'endEvent']),
  conditional: Object.freeze(['startEvent', 'intermediateCatchEvent', 'boundaryEvent']),
});

/** The `marker` value of a plain event on purpose: no event definition, and no marker is inferred from the name. */
export const MARKER_NONE = 'none';

/**
 * The event types that may be plain, without an event definition (`marker: "none"`): start, end
 * and intermediate throw (the None event of BPMN 2.0.2 §10.5). A boundary event and an intermediate
 * catch event need a trigger, and so does the start event of an event subprocess (§10.5.2):
 * `allowsMarkerNone` says which, and S15 reports `"none"` everywhere else.
 */
export const MARKER_NONE_ALLOWED_ON = Object.freeze(['startEvent', 'endEvent', 'intermediateThrowEvent']);

/**
 * May `node` inside `parent` (`null` at process level) be a plain event (`marker: "none"`)? Its type
 * is in `MARKER_NONE_ALLOWED_ON`, and it is not the start event of an event subprocess.
 */
export function allowsMarkerNone(node, parent) {
  if (!MARKER_NONE_ALLOWED_ON.includes(node?.type)) return false;
  return !(node.type === 'startEvent' && isWrittenEventSubProcess(parent));
}

const COMPOUND_REST = 4;

// "Further letters" counts letters only (digits do not count), so `frist2024` is not a compound.
const letterCount = (s) => (s.match(/\p{L}/gu) ?? []).length;

/** True when the token begins with one of the folded `exceptions`: it is a known non-event compound. */
const isException = (token, exceptions) => exceptions.some((e) => token.startsWith(e));

/**
 * How `token` matches `keyword`: `'whole'` (the same word), `'start'` or `'end'` (a compound that
 * begins or ends with it, only with `compound`), else `null`.
 */
function matchKind(token, keyword, compound, exceptions) {
  if (token === keyword) return 'whole';
  if (!compound || keyword === '') return null;
  if (token.length <= keyword.length) return null;
  const endMatch = () => (token.endsWith(keyword)
    && letterCount(token.slice(0, token.length - keyword.length)) >= COMPOUND_REST ? 'end' : null);
  if (token.startsWith(keyword)) {
    // A known exception (Zeitschrift) blocks only the leading match; a keyword at the end of the word still counts.
    if (!isException(token, exceptions)) return letterCount(token.slice(keyword.length)) >= COMPOUND_REST ? 'start' : null;
    return endMatch();
  }
  return endMatch();
}

/**
 * True when the label says the time ran out: a token is one of the folded `expiryWords`; a word of
 * at most two letters (`um`) counts only as the last token.
 */
function hasExpiryWord(tokens, expiryWords) {
  return tokens.some((t, i) => expiryWords.includes(t) && (t.length > 2 || i === tokens.length - 1));
}

/**
 * Does `marker` match the label? On an event that may be plain (`plainAllowed`), a timer that
 * matches only at the end of compounds through `durationKeywords` (Arbeitszeit: a duration, not its
 * end) matches only with an expiry word (Lieferzeit überschritten); on an event that needs a
 * trigger, and for every other match, the match counts on its own.
 */
function markerMatches(lexicon, marker, tokens, compound, exceptions, plainAllowed) {
  const keywords = lexicon.eventMarkers?.[marker] ?? [];
  const durations = marker === 'timer' && plainAllowed ? (lexicon.durationKeywords ?? []) : [];
  let durationEnd = false;
  for (const k of keywords) {
    for (const t of tokens) {
      const kind = matchKind(t, k, compound, exceptions);
      if (kind === null) continue;
      if (kind === 'end' && durations.includes(k)) durationEnd = true;
      else return true;
    }
  }
  return durationEnd && hasExpiryWord(tokens, lexicon.expiryWords ?? []);
}

/**
 * The marker a label's words imply, if that marker is legal on `eventType`: the first marker of
 * `INFERABLE_MARKERS` with a keyword matching a token decides; there is no fall-through to a later
 * one. `null` when nothing matches or the marker is not allowed on the type. `parent` is the
 * node that contains the event (`null` at process level): with it, the start event of an event
 * subprocess counts as an event that needs a trigger (`allowsMarkerNone`). Never throws.
 */
export function inferMarker(lexicon, name, eventType, parent = null) {
  try {
    const tokens = labelTokens(name).tokens.map((t) => t.folded);
    if (tokens.length === 0) return null;
    // `compoundMarkers: true` is a language-wide switch: every keyword may also match inside a compound word.
    const compound = lexicon.compoundMarkers === true;
    // Words that begin with a keyword but name no such event (`compoundExceptions`), checked before the compound match.
    const exceptions = lexicon.compoundExceptions ?? [];
    // The expiry-word requirement applies only where a plain event is valid; an event that needs a trigger keeps the timer.
    const plainAllowed = allowsMarkerNone({ type: eventType }, parent);
    for (const marker of INFERABLE_MARKERS) {
      if (markerMatches(lexicon, marker, tokens, compound, exceptions, plainAllowed)) {
        return MARKER_ALLOWED_ON[marker].includes(eventType) ? marker : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
