/**
 * Event markers a label can imply, and where each marker is legal (BPMN 2.0.2, Tables 10.84–10.90
 * and 10.93). Data and one pure function; no I/O.
 */

import { labelTokens, foldWord } from './tokens.js';

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

const COMPOUND_REST = 4;

function matches(token, keyword, compound) {
  if (token === keyword) return true;
  if (!compound.has(keyword) || keyword === '') return false;
  if (token.length < keyword.length + COMPOUND_REST) return false;
  return token.startsWith(keyword) || token.endsWith(keyword);
}

/**
 * The marker a label's words imply, if that marker is legal on `eventType`: the first marker of
 * `INFERABLE_MARKERS` with a keyword matching a token decides; there is no fall-through to a later
 * one. `null` when nothing matches or the marker is not allowed on the type. Never throws.
 */
export function inferMarker(lexicon, name, eventType) {
  try {
    const tokens = labelTokens(name).tokens.map((t) => t.folded);
    if (tokens.length === 0) return null;
    // `compoundMarkers` lists the keywords that may also match inside a compound word.
    const compound = new Set((lexicon.compoundMarkers ?? []).map(foldWord));
    for (const marker of INFERABLE_MARKERS) {
      const keywords = lexicon.eventMarkers?.[marker] ?? [];
      if (keywords.some((k) => tokens.some((t) => matches(t, k, compound)))) {
        return MARKER_ALLOWED_ON[marker].includes(eventType) ? marker : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
