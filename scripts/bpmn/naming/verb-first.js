/**
 * The verb-first naming conventions (English): a task starts with an imperative verb, a container
 * names a topic, an event or message does not. A pure strategy object built from a lexicon; every
 * judge returns `null` (ok) or `{ reason }` and never throws. Nothing here reads a file.
 */

import { labelTokens } from './tokens.js';
import { inferMarker } from './markers.js';

const HAS_LETTER = /\p{L}/u;
const MIN_PARTICIPLE = 5;
const MIN_PREFIX_REST = 3;

const ok = null;
const flag = (reason) => ({ reason });

/** The folded words of a label, as the judges see them (never throws). */
function read(name) {
  try {
    return labelTokens(name);
  } catch {
    return { wordCount: 0, tokens: [] };
  }
}

export function verbFirst(lexicon) {
  const { verbs, nounVerbHomographs, stateWords, verbPrefixes, verbPhrases, infinitiveSuffixes, participles } = lexicon;

  const isVerb = (x) => verbs.has(x);

  function isParticiple(x) {
    if (participles.irregular.has(x)) return true;
    return x.length >= MIN_PARTICIPLE && x.endsWith(participles.suffix) && !participles.exceptions.has(x);
  }

  /** Index of the first token with a letter; tokens before it are numbering (`1.`, `2)`). */
  function firstWord(tokens) {
    let i = 0;
    while (i < tokens.length && !HAS_LETTER.test(tokens[i].raw)) i++;
    return i;
  }

  /** Number of tokens (from `from`) that make up the leading verb; 0 when there is none. */
  function lead(tokens, from) {
    const rest = tokens.length - from;
    if (rest <= 0) return 0;
    const t0 = tokens[from].folded;
    for (const phrase of verbPhrases ?? []) {
      if (phrase.length >= rest) continue; // at least one token must follow
      let match = true;
      for (let j = 0; j < phrase.length; j++) {
        if (tokens[from + j].folded !== phrase[j]) { match = false; break; }
      }
      if (match) return phrase.length;
    }
    if (isVerb(t0)) return 1;
    if (rest >= 2 && verbPrefixes.includes(t0) && isVerb(tokens[from + 1].folded)) return 2;
    for (const prefix of verbPrefixes) {
      if (t0.length >= prefix.length + MIN_PREFIX_REST && t0.startsWith(prefix) && isVerb(t0.slice(prefix.length))) return 1;
    }
    for (const { suffix, minLength } of infinitiveSuffixes ?? []) {
      if (t0.length >= minLength && t0.endsWith(suffix)) return 1;
    }
    return 0;
  }

  function taskName(name) {
    const { wordCount, tokens } = read(name);
    if (wordCount < 2) return flag('A task name needs a verb and an object, e.g. "Review application".');
    const from = firstWord(tokens);
    const k = lead(tokens, from);
    if (k === 0) return flag('A task name starts with a verb in the imperative, e.g. "Review application".');
    const after = tokens.slice(from + k);
    if (!after.some((t) => HAS_LETTER.test(t.raw))) return flag('A task name needs an object after the verb.');
    return ok;
  }

  function containerName(name) {
    const { wordCount, tokens } = read(name);
    if (tokens.length === 0) return ok;
    const last = tokens[tokens.length - 1].folded;
    if (isParticiple(last)) return flag('A container names a topic, not a state; avoid a participle at the end.');
    if (wordCount === 1 && tokens.length === 1 && isVerb(tokens[0].folded)) {
      return flag('A container names a topic, not an instruction; a bare verb reads as a task.');
    }
    return ok;
  }

  function eventName(name) {
    const { wordCount, tokens } = read(name);
    if (wordCount < 2 || tokens.length === 0) return ok;
    const t0 = tokens[0].folded;
    const last = tokens[tokens.length - 1].folded;
    if (isVerb(t0) && !nounVerbHomographs.has(t0) && !isParticiple(last) && !stateWords.has(last)) {
      return flag('An event names a state or occurrence, e.g. "Invoice received", not an instruction.');
    }
    return ok;
  }

  function messageName(name) {
    const { wordCount, tokens } = read(name);
    if (wordCount < 2 || tokens.length === 0) return ok;
    const t0 = tokens[0].folded;
    const last = tokens[tokens.length - 1].folded;
    if (isVerb(t0) && !nounVerbHomographs.has(t0)) {
      return flag('A message names its content, e.g. "Invoice", not an instruction.');
    }
    if (isParticiple(last)) return flag('A message names its content, not a state; avoid a participle at the end.');
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
