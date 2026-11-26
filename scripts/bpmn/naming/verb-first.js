/**
 * The verb-first naming conventions (English): a task starts with an imperative verb, a container
 * names a topic, an event or message does not. A pure strategy object built from a lexicon; every
 * judge returns `null` (ok) or `{ reason }` and never throws. Nothing here reads a file.
 *
 * No closed word list holds every English verb, so a task name is flagged only on positive evidence
 * of a wrong form; a name whose first word is merely unlisted passes, and `unlistedFirstWord` names
 * that word for the hint H14.
 */

import { labelTokenWords } from './tokens.js';
import { inferMarker } from './markers.js';

const HAS_LETTER = /\p{L}/u;
const MIN_PARTICIPLE = 5;
const MIN_PREFIX_REST = 3;
const MIN_GERUND = 6;
const MIN_ACTION_STEM = 3;
/** Suffix of an action noun → the endings that give back its verb. */
const ACTION_NOUN_SUFFIXES = [
  ['ification', ['ify']], ['ation', ['', 'e', 'ate']], ['ment', ['']], ['ance', ['', 'e']], ['ence', ['', 'e']],
  ['ion', ['', 'e']], ['al', ['', 'e']],
];

const ok = null;
const flag = (reason) => ({ reason });

/** The folded words of a label, as the judges see them (never throws). */
function read(name) {
  try {
    return labelTokenWords(name);
  } catch {
    return { wordCount: 0, tokens: [] };
  }
}

export function verbFirst(lexicon) {
  const { verbs, nounVerbHomographs, stateWords, verbPrefixes, verbPhrases, infinitiveSuffixes, participles } = lexicon;
  const nonVerbStarters = lexicon.nonVerbStarters ?? new Set();
  const nounStarters = lexicon.nounStarters ?? new Set();
  const auxiliaries = lexicon.auxiliaries ?? new Set();
  const messageNouns = lexicon.messageNouns ?? new Set();
  const instructionVerbs = lexicon.instructionVerbs ?? new Set();

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
    if (rest >= 2 && verbPrefixes.includes(t0) && isVerb(tokens[from + 1].folded)) return 2;
    if (isVerbWord(t0)) return 1;
    // Quality-check, Fast-track: a hyphenated first word whose last part is a verb.
    const parts = wordParts(tokens, from);
    if (parts > 1 && parts < rest && isVerbWord(tokens[from + parts - 1].folded)) return parts;
    return 0;
  }

  /** Number of tokens from `from` that belong to the same whitespace word. */
  function wordParts(tokens, from) {
    let n = 1;
    while (from + n < tokens.length && tokens[from + n].word === tokens[from].word) n++;
    return n;
  }

  /** A single folded word is a verb: listed, a listed prefix joined to a listed verb, or a verb suffix. */
  function isVerbWord(x) {
    if (isVerb(x)) return true;
    for (const prefix of verbPrefixes) {
      if (x.length >= prefix.length + MIN_PREFIX_REST && x.startsWith(prefix) && isVerb(x.slice(prefix.length))) return true;
    }
    for (const { suffix, minLength, exceptions } of infinitiveSuffixes ?? []) {
      if (x.length >= minLength && x.endsWith(suffix) && !exceptions?.has(x)) return true;
    }
    return false;
  }

  /** `checking`, `shipping`, `updating`: -ing on a verb (as is, with its final e, or with a doubled consonant). */
  function isGerund(x) {
    if (x.length < MIN_GERUND || !x.endsWith('ing')) return false;
    const stem = x.slice(0, -3);
    if (isVerbWord(stem) || isVerbWord(`${stem}e`)) return true;
    return stem.length >= 2 && stem.at(-1) === stem.at(-2) && isVerbWord(stem.slice(0, -1));
  }

  /**
   * A noun formed from a listed verb: `approval`, `assessment`, `acceptance`, `validation`
   * (validate), `registration` (register), `verification` (verify).
   */
  function isActionNoun(x) {
    for (const [suffix, endings] of ACTION_NOUN_SUFFIXES) {
      if (x.length < suffix.length + MIN_ACTION_STEM || !x.endsWith(suffix)) continue;
      const base = x.slice(0, -suffix.length);
      if (endings.some((e) => isVerb(base + e))) return true;
    }
    return false;
  }

  /** A word the data names as no verb: the -ate nouns and adjectives (certificate, template). */
  function knownNonVerb(x) {
    return (infinitiveSuffixes ?? []).some(({ suffix, exceptions }) => x.endsWith(suffix) && exceptions?.has(x));
  }

  const hasLetter = (t) => HAS_LETTER.test(t.raw);

  const NEEDS_VERB = 'A task name needs a verb and an object, e.g. "Review application".';
  const STARTS_WITH_VERB = 'A task name starts with a verb in the imperative, e.g. "Review application".';

  /**
   * `{ reason }` for a task name with positive evidence of a wrong form, `{ unlisted }` (the raw
   * first word) for one without a recognised verb and without such evidence, else `null`.
   */
  function judgeTask(name) {
    const { wordCount, tokens } = read(name);
    if (wordCount < 2) return flag(NEEDS_VERB);
    const from = firstWord(tokens);
    if (from === tokens.length) return flag(STARTS_WITH_VERB);
    const first = tokens[from];
    const last = tokens[tokens.length - 1].folded;
    // The rules up to the verb test do not read the verb list. After it the list is read only to
    // recognise a word as a verb, and a recognised verb can only end a test: a shorter verb list
    // therefore never adds a finding (en-sample.test.js proves it over both samples).
    if (!tokens.slice(from + 1).some(hasLetter)) return flag(STARTS_WITH_VERB); // Step 3
    if (first.raw.endsWith(':')) return flag(STARTS_WITH_VERB); // SAP: Review invoice
    if (tokens.length - from === 2 && isParticiple(last)) return flag(STARTS_WITH_VERB); // Invoice checked
    const second = tokens[from + 1]?.folded;
    // `to` and the auxiliary as words of their own: "to-be" in "Design to-be process" is a noun.
    const third = tokens[from + 2];
    if (auxiliaries.has(second)
      || (second === 'to' && third && auxiliaries.has(third.folded) && third.word !== tokens[from + 1].word)) {
      return flag(STARTS_WITH_VERB); // Invoice is checked, Invoice to be checked
    }
    const k = lead(tokens, from);
    if (k > 0) {
      if (!tokens.slice(from + k).some(hasLetter)) return flag('A task name needs an object after the verb.');
      // Request pending, Document missing: a noun that is also a verb, then a state.
      if (k === 1 && tokens.length - from === 2 && nounVerbHomographs.has(first.folded) && stateWords.has(last)) {
        return flag(STARTS_WITH_VERB);
      }
      return ok;
    }
    // A whole first word only: in Quality-check the first part is no verb but the word may be one.
    const whole = wordParts(tokens, from) === 1;
    if (whole && (nonVerbStarters.has(first.folded) || nounStarters.has(first.folded))) return flag(STARTS_WITH_VERB);
    if (whole && isGerund(first.folded)) return flag(STARTS_WITH_VERB); // Checking invoice, not Billing-check
    // The end of a name counts only after a first word known not to be a verb (certificate): an
    // object such as "request" or "document" is often a verb too, and a verb that is merely
    // unlisted must give the hint, never a finding.
    if (knownNonVerb(first.folded)
      && (isParticiple(last) || stateWords.has(last) || isVerb(last) || isActionNoun(last))) {
      return flag(STARTS_WITH_VERB); // Certificate check
    }
    return { unlisted: tokens.slice(from, from + wordParts(tokens, from)).map((t) => t.raw).join('-') };
  }

  function taskName(name) {
    const verdict = judgeTask(name);
    return verdict === null || verdict.unlisted !== undefined ? ok : verdict;
  }

  /** The raw first word of a task name that passes without a recognised verb, else `null`. */
  function unlistedFirstWord(name) {
    const verdict = judgeTask(name);
    return verdict?.unlisted ?? null;
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
    // Deploy request, Sell order: a compound that ends in a message noun, unless the verb sends it (Send invoice).
    const compound = messageNouns.has(last) && !instructionVerbs.has(t0);
    if (isVerb(t0) && !nounVerbHomographs.has(t0) && !compound) {
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
    unlistedFirstWord: guard(unlistedFirstWord),
    containerName: guard(containerName),
    eventName: guard(eventName),
    messageName: guard(messageName),
    isQuestion,
    eventMarker: (name, eventType) => inferMarker(lexicon, name, eventType),
    examples: lexicon.examples,
  });
}
