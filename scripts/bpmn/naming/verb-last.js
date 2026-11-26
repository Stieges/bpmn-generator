/**
 * The verb-last naming conventions (German): a task ends with an infinitive ("Antrag prüfen"), a
 * container names a topic, an event or message does not end with an instruction. A pure strategy
 * object built from a lexicon; every judge returns `null` (ok) or `{ reason }` and never throws.
 * Nothing here reads a file.
 *
 * Prefix and `zu` detection work on the raw lower-case word: a separable prefix only counts when it
 * ends on a letter boundary of the raw word, so `anzünden` (folded `anzuenden`) is `an` + `zünden`,
 * never `an` + `zu` + `enden`. Word lists are compared in folded form.
 */

import { foldWord, labelTokens } from './tokens.js';
import { inferMarker } from './markers.js';

const HAS_LETTER = /\p{L}/u;
const LOWER_START = /^\p{Ll}/u;
const LETTERS = /\p{L}/gu;
const MIN_PREFIX_REST = 3;
const VERB_SUFFIX = 'ieren';

const ok = null;
const flag = (reason) => ({ reason });
const letterCount = (s) => (s.match(LETTERS) ?? []).length;

/** The folded words of a label, as the judges see them (never throws). */
function read(name) {
  try {
    return labelTokens(name);
  } catch {
    return { wordCount: 0, tokens: [] };
  }
}

const isLower = (token) => LOWER_START.test(token.raw);

export function verbLast(lexicon) {
  const {
    verbs, nounVerbHomographs, stateMarkers, participleHomographs, geInfinitives, adjectiveStoplist,
    conjunctions, separablePrefixes, infinitiveSuffixes, participles,
  } = lexicon;

  /**
   * `[prefix, rest]`: the longest separable prefix (folded) the raw word starts with, ending on a
   * raw character boundary, with a rest of at least three letters; the rest is the raw lower-case
   * remainder. `['', word]` when there is none.
   */
  function split(raw) {
    const lower = String(raw).toLowerCase();
    let folded = '';
    const boundary = new Map(); // folded length → raw index after the character that reached it
    let i = 0;
    for (const ch of lower) {
      i += ch.length;
      folded += foldWord(ch);
      boundary.set(folded.length, i);
    }
    for (const p of separablePrefixes) {
      if (!folded.startsWith(p) || !boundary.has(p.length)) continue;
      const rest = lower.slice(boundary.get(p.length));
      if (letterCount(rest) >= MIN_PREFIX_REST) return [p, rest];
    }
    return ['', lower];
  }

  function suffixInf(x) {
    return infinitiveSuffixes.some(({ suffix, minLength }) => x.length >= minLength && x.endsWith(suffix));
  }

  /** `ge…t` / `ge…en` after the separable prefix, unless that rest is an infinitive beginning with `ge`. */
  function gePart(token) {
    const r = foldWord(split(token.raw)[1]);
    if (!r.startsWith('ge') || geInfinitives.has(r)) return false;
    return (r.length >= 4 && r.endsWith('t')) || (r.length >= 5 && r.endsWith('en'));
  }

  function infinitive(token) {
    const x = token.folded;
    if (verbs.has(x) || x.endsWith(VERB_SUFFIX)) return true;
    return suffixInf(x) && !gePart(token) && !adjectiveStoplist.has(x);
  }

  /** A separable prefix, then `zu`, then a verb: `auszuzahlen`, `abzurechnen`, `zuzuordnen`. */
  function zuInf(token) {
    const [p, r] = split(token.raw);
    if (p === '' || !r.startsWith('zu')) return false;
    const rest = foldWord(r.slice(2));
    return verbs.has(rest) || suffixInf(rest);
  }

  const isParticipleEnd = (token) => token.folded.endsWith(participles.suffix);

  function stateGuard(tokens) {
    for (let i = 0; i < tokens.length - 1; i++) if (stateMarkers.has(tokens[i].folded)) return true;
    return zuInf(tokens[tokens.length - 1]);
  }

  function taskName(name) {
    const { wordCount, tokens } = read(name);
    if (wordCount < 2 || tokens.length < 2) return flag('A task name needs an object and a verb, e.g. "Antrag prüfen".');
    const last = tokens[tokens.length - 1];
    if (!isLower(last) || !infinitive(last)) return flag('A task name ends with a verb in the infinitive, e.g. "Antrag prüfen".');
    if (stateMarkers.has(tokens[tokens.length - 2].folded) || zuInf(last)) {
      return flag('A task name is an instruction, not a state; write "Rechnung zahlen", not "Rechnung zu zahlen".');
    }
    const others = tokens.slice(0, -1);
    if (!others.some((t) => !conjunctions.has(t.folded) && HAS_LETTER.test(t.raw))) {
      return flag('A task name needs an object before the verb.');
    }
    return ok;
  }

  function containerName(name) {
    const { wordCount, tokens } = read(name);
    if (tokens.length === 0) return ok;
    const last = tokens[tokens.length - 1];
    if (isLower(last) && (gePart(last) || isParticipleEnd(last))) {
      return flag('A container names a topic, not a state; avoid a participle at the end.');
    }
    if (wordCount === 1 && tokens.length === 1) {
      const x = last.folded;
      if ((verbs.has(x) || x.endsWith(VERB_SUFFIX)) && !nounVerbHomographs.has(x)) {
        return flag('A container names a topic, not an instruction; a bare verb reads as a task.');
      }
    }
    return ok;
  }

  function eventName(name) {
    const { tokens } = read(name);
    if (tokens.length === 0) return ok;
    const last = tokens[tokens.length - 1];
    if (!isLower(last) || stateGuard(tokens)) return ok;
    const x = last.folded;
    if ((verbs.has(x) && !participleHomographs.has(x)) || x.endsWith(VERB_SUFFIX)) {
      return flag('An event names a state or occurrence, e.g. "Antrag eingegangen", not an instruction.');
    }
    return ok;
  }

  function messageName(name) {
    const { tokens } = read(name);
    if (tokens.length === 0) return ok;
    const last = tokens[tokens.length - 1];
    if (!isLower(last) || stateGuard(tokens)) return ok;
    if (infinitive(last)) return flag('A message names its content, e.g. "Rechnung", not an instruction.');
    if (gePart(last) || isParticipleEnd(last)) {
      return flag('A message names its content, not a state; avoid a participle at the end.');
    }
    return ok;
  }

  function isQuestion(name) {
    try {
      if (typeof name !== 'string') return false;
      const text = name.replace(/[\r\n]/g, ' ');
      return lexicon.questionMarks.some((m) => text.includes(m));
    } catch {
      return false;
    }
  }

  function guard(judge) {
    return (name) => {
      try {
        return judge(name);
      } catch {
        return ok;
      }
    };
  }

  return Object.freeze({
    language: lexicon.language,
    wordOrder: lexicon.wordOrder,
    taskName: guard(taskName),
    containerName: guard(containerName),
    eventName: guard(eventName),
    messageName: guard(messageName),
    isQuestion,
    eventMarker: (name, eventType) => inferMarker(lexicon, name, eventType),
    examples: lexicon.examples,
  });
}
