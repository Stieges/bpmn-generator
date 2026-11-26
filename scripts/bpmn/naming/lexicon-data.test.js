import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLexicon, NamingDataError, NAMING_LANGUAGES } from './lexicon.js';
import { namingEnPath, namingDePath } from '../../shared/resource-paths.js';
import { foldWord, labelTokens } from './tokens.js';
import { TASK_TYPES } from '../types.js';

const BUILT_IN_39 = ['review', 'approve', 'send', 'receive', 'check', 'create', 'update', 'delete',
  'reject', 'submit', 'notify', 'validate', 'process', 'archive', 'assign', 'verify',
  'confirm', 'record', 'issue', 'close', 'open', 'prepare', 'request', 'forward',
  'escalate', 'sign', 'evaluate', 'calculate', 'generate', 'publish', 'cancel',
  'release', 'collect', 'enter', 'add', 'remove', 'store', 'fetch', 'handle'];

const CORPUS_109 = ['accept', 'add', 'adjust', 'apply', 'approve', 'archive', 'assign', 'attach', 'book', 'calculate',
  'cancel', 'check', 'choose', 'close', 'collect', 'complete', 'configure', 'confirm', 'copy', 'create', 'cross',
  'crosscheck', 'delete', 'deploy', 'disable', 'download', 'enable', 'ensure', 'enter', 'escalate', 'evaluate',
  'export', 'fetch', 'fill', 'finalize', 'follow', 'forecast', 'forward', 'generate', 'grant', 'handle', 'import',
  'interlock', 'isolate', 'issue', 'link', 'load', 'mark', 'merge', 'move', 'negotiate', 'notify', 'obtain', 'open',
  'paste', 'place', 'populate', 'post', 'prepare', 'present', 'preview', 'process', 'provide', 'publish', 'pull',
  'quote', 'receive', 'reconcile', 'record', 'redirect', 'reject', 'release', 'remove', 'request', 'respond',
  'return', 'review', 'rework', 'roll', 'route', 'run', 'save', 'select', 'send', 'set', 'setup', 'show', 'sign',
  'split', 'start', 'store', 'submit', 'sync', 'tag', 'tie', 'trigger', 'update', 'upload', 'use', 'validate',
  'verify', 'view', 'wait', 'identify', 'assess', 'advise', 'lead', 'build', 'discuss'];

const PHRASES_8 = ['stand up', 'stand down', 'hand off', 'hand over', 'kick off', 'pre qualify', 'pre screen', 'pre approve'];

const TWO_WORD_VERBS = ['back up', 'shut down', 'set up', 'log in', 'log out', 'sign off', 'sign up', 'roll back',
  'roll out', 'follow up', 'hand over', 'check in', 'check out', 'clean up', 'look up', 'fill in', 'fill out', 'opt in',
  'opt out', 'write off', 'phase out', 'scale up', 'scale down', 'ramp up', 'wind down'];

const NAMED_22 = ['print', 'pack', 'book', 'await', 'register', 'query', 'assess', 'schedule', 'decide', 'revise',
  'render', 'log', 'deploy', 'run', 'route', 'repair', 'do', 'compute', 'repeat', 'fulfil', 'fulfill', 'call'];

const RULING_44 = ['agree', 'alert', 'assemble', 'attend', 'begin', 'bill', 'buy', 'chase', 'combine', 'comment',
  'commit', 'continue', 'credit', 'decline', 'delegate', 'deposit', 'enrol', 'enroll', 'finish', 'help', 'hire',
  'integrate', 'interview', 'lock', 'mail', 'meet', 'pause', 'predict', 'prevent', 'procure', 'promote', 'recruit',
  'refer', 'reimburse', 'reply', 'resume', 'revoke', 'sell', 'support', 'triage', 'unlock', 'upgrade', 'visit', 'warn'];

const LEGACY_EVENT_KEYWORDS = ['nachricht', 'message', 'mail', 'e-mail', 'timer', 'zeit', 'frist', 'warte', 'deadline',
  'fehler', 'error', 'exception', 'störung', 'signal', 'eskalation', 'escalation', 'kompensation', 'compensation',
  'bedingung', 'conditional', 'condition', 'abbruch', 'cancel', 'abgebrochen', 'stornierung', 'terminat', 'beendet',
  'sofortiger abbruch'];

const raw = () => JSON.parse(readFileSync(namingEnPath(), 'utf8'));
const cmp = (a, b) => {
  const fa = foldWord(a), fb = foldWord(b);
  return fa < fb ? -1 : fa > fb ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

describe('English', () => {
  const en = loadLexicon('en');

  test('validates and has the declared switches', () => {
    expect(en.language).toBe('en');
    expect(en.wordOrder).toBe('verb-first');
    expect(en.questionMarks).toEqual(['?']);
    expect(en.verbPrefixes).toEqual(['pre', 'co', 're'].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)));
    expect(en.infinitiveSuffixes).toEqual([
      { suffix: 'ate', minLength: 6, exceptions: new Set(raw().infinitiveSuffixes[0].exceptions) },
      { suffix: 'ify', minLength: 6 }, { suffix: 'ise', minLength: 6 }, { suffix: 'ize', minLength: 6 },
    ]);
    expect(en.participles.suffix).toBe('ed');
  });

  test('loadLexicon caches per language', () => {
    expect(loadLexicon('en')).toBe(en);
  });

  test('verbs: exactly 452 and every sourced literal is in', () => {
    expect(BUILT_IN_39).toHaveLength(39);
    expect(CORPUS_109).toHaveLength(109);
    expect(NAMED_22).toHaveLength(22);
    expect(RULING_44).toHaveLength(44);
    expect(en.verbs.size).toBe(452);
    for (const v of ['diagnose', 'screen', 'underwrite', 'disburse', 'patch', 'provision', 'decommission']) expect(en.verbs.has(v)).toBe(true);
    for (const v of [...BUILT_IN_39, ...CORPUS_109, ...NAMED_22, ...RULING_44]) expect(en.verbs.has(v)).toBe(true);
    expect(en.verbs.has('invoice')).toBe(false);
    for (const v of ['nudge', 'path', 'step', 'case', 'need']) expect(en.verbs.has(v)).toBe(false);
  });

  test('verb phrases: the 8 of the contributor, three more and the common two-word verbs', () => {
    expect(PHRASES_8).toHaveLength(8);
    const phrases = raw().verbPhrases;
    expect(phrases).toHaveLength(52);
    for (const p of [...PHRASES_8, 'carry out', 'look up', 'e mail']) expect(phrases).toContain(p);
    for (const p of TWO_WORD_VERBS) expect(phrases).toContain(p);
    expect(en.verbPhrases).toHaveLength(52);
  });

  test('homographs: 246, a subset of verbs, with the named members', () => {
    expect(en.nounVerbHomographs.size).toBe(246);
    for (const w of en.nounVerbHomographs) expect(en.verbs.has(w)).toBe(true);
    for (const w of ['start', 'order', 'request', 'register', 'archive', 'report', 'lead', 'build', 'pay', 'merge', 'read', 'close', 'follow']) {
      expect(en.nounVerbHomographs.has(w)).toBe(true);
    }
    for (const w of ['send', 'notify']) expect(en.nounVerbHomographs.has(w)).toBe(false);
  });

  test('participles: 47 irregular, none a verb; every exception ends in ed', () => {
    expect(en.participles.irregular.size).toBe(47);
    for (const w of en.participles.irregular) expect(en.verbs.has(w)).toBe(false);
    const exceptions = raw().participles.exceptions;
    expect(exceptions).toHaveLength(14);
    for (const w of exceptions) expect(w.endsWith('ed')).toBe(true);
  });

  test('every event-marker keyword contains a legacy keyword', () => {
    for (const words of Object.values(raw().eventMarkers)) {
      for (const w of words) expect(LEGACY_EVENT_KEYWORDS.some((k) => w.includes(k))).toBe(true);
    }
  });

  test('lists are sorted by foldWord and unique after it', () => {
    const data = raw();
    const lists = [data.verbs, data.verbPhrases, data.nounVerbHomographs, data.participles.irregular,
      data.participles.exceptions, data.stateWords, data.nonVerbStarters, data.nounStarters, data.auxiliaries, data.messageNouns, data.instructionVerbs,
      data.infinitiveSuffixes[0].exceptions, ...Object.values(data.eventMarkers)];
    for (const list of lists) {
      expect([...list]).toEqual([...list].sort(cmp));
      expect(new Set(list.map(foldWord)).size).toBe(list.length);
    }
  });

  test('the word lists that make a task name fail hold no verb', () => {
    const data = raw();
    expect(data.nonVerbStarters).toHaveLength(86);
    expect(data.nounStarters).toHaveLength(48);
    expect(data.auxiliaries).toHaveLength(13);
    for (const w of data.auxiliaries) expect([w, en.verbs.has(w)]).toEqual([w, false]);
    for (const w of ['invoice', 'stock', 'claim', 'address']) expect(en.nounStarters.has(w)).toBe(false);
    for (const w of [...data.nonVerbStarters, ...data.nounStarters]) expect([w, en.verbs.has(w)]).toEqual([w, false]);
    for (const w of ['the', 'a', 'for', 'our', 'is', 'and']) expect(en.nonVerbStarters.has(w)).toBe(true);
    for (const w of ['customer', 'final', 'system']) expect(en.nounStarters.has(w)).toBe(true);
  });

  test('message nouns and the verbs that make a name with one an instruction', () => {
    const data = raw();
    expect(data.messageNouns).toHaveLength(40);
    expect(data.instructionVerbs).toHaveLength(17);
    for (const w of ['request', 'order', 'notice', 'notification', 'response', 'reply', 'confirmation', 'report', 'message',
      'offer', 'invoice', 'receipt', 'reminder', 'alert', 'update']) expect(en.messageNouns.has(w)).toBe(true);
    for (const w of ['send', 'submit', 'transmit', 'approve', 'confirm', 'cancel']) expect(en.instructionVerbs.has(w)).toBe(true);
    for (const w of data.instructionVerbs) expect([w, en.verbs.has(w), en.nounVerbHomographs.has(w)]).toEqual([w, true, false]);
  });

  test('-ate is a verb ending from six letters; its exceptions are nouns and adjectives in -ate', () => {
    const [ate] = raw().infinitiveSuffixes;
    expect([ate.suffix, ate.minLength]).toEqual(['ate', 6]);
    expect(ate.exceptions).toHaveLength(30);
    for (const w of ate.exceptions) {
      expect(w.endsWith('ate') && w.length >= 6).toBe(true);
      expect(en.verbs.has(w)).toBe(false);
    }
    for (const w of ['certificate', 'candidate', 'template', 'climate', 'private', 'corporate', 'accurate', 'appropriate', 'surrogate']) {
      expect(ate.exceptions).toContain(w);
    }
    for (const w of ['duplicate', 'delegate']) expect(ate.exceptions).not.toContain(w);
  });

  test('examples are single strings', () => {
    expect(en.examples).toEqual({ task: 'Review application', event: 'Application received', message: 'Invoice', subprocess: 'Claims handling' });
  });

  test('sources credit the contributor', () => {
    const credited = en.sources.find((s) => s.reference === '#151');
    expect(credited.author).toBe('Jérôme Fenal (@jfenal)');
    expect(en.sources).toEqual([
      { name: 'built-in M01 verb list of bpmn-generator (39 verbs)' },
      { name: 'verb corpus and verb phrases of pull request #151 (109 verbs, 8 phrases)', author: 'Jérôme Fenal (@jfenal)', reference: '#151' },
      { name: 'common analyst verbs, compiled for this file' },
    ]);
  });

  test('namingEnPath resolves, the registry lists de then en, an unregistered language throws', () => {
    expect(namingEnPath()).toMatch(/references[\\/]naming[\\/]en\.json$/);
    expect(Object.keys(NAMING_LANGUAGES)).toEqual(['de', 'en']);
    expect(() => loadLexicon('xx')).toThrow(NamingDataError);
    expect(() => loadLexicon('xx')).toThrow('no naming data for language "xx"');
  });
});

// Strong stems whose past participle equals the infinitive (geben → vergeben, halten → erhalten).
const HOMOGRAPH_STEMS = ['blasen', 'braten', 'essen', 'fahren', 'fallen', 'fangen', 'fressen', 'geben', 'gessen',
  'graben', 'halten', 'heißen', 'kommen', 'laden', 'lassen', 'laufen', 'lesen', 'messen', 'raten', 'rufen',
  'schlafen', 'schlagen', 'sehen', 'stoßen', 'tragen', 'treten', 'wachsen', 'waschen'];

const REQUIRED_DE = ['erhalten', 'empfangen', 'bekommen', 'vergeben', 'übergeben', 'genehmigen', 'gewähren', 'zahlen',
  'kündigen', 'erstatten', 'erfolgen', 'archivieren', 'gegenlesen', 'gegenzeichnen'];

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures');

/** The last token of every task label of the German fixtures that starts lower-case and ends like an infinitive. */
function germanFixtureVerbs() {
  const languages = JSON.parse(readFileSync(join(fixturesRoot, 'rules-characterization', 'fixture-languages.json'), 'utf8'));
  const files = Object.entries(languages).filter(([, l]) => l === 'de').map(([f]) => f);
  expect(files).toHaveLength(13);
  const words = new Set();
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (TASK_TYPES.has(n.type) && typeof n.name === 'string') {
        const { tokens } = labelTokens(n.name);
        const last = tokens.at(-1)?.raw;
        if (last && /^[a-zäöüß]/.test(last) && /(en|eln|ern)$/.test(last)) words.add(last);
      }
      walk(n.nodes);
    }
  };
  for (const file of files) {
    const model = JSON.parse(readFileSync(join(fixturesRoot, file), 'utf8'));
    for (const p of Array.isArray(model.pools) ? model.pools : [model]) walk(p.nodes);
  }
  return [...words];
}

describe('German', () => {
  const de = loadLexicon('de');
  const data = JSON.parse(readFileSync(namingDePath(), 'utf8'));

  test('validates and has the declared switches', () => {
    expect(de.language).toBe('de');
    expect(de.wordOrder).toBe('verb-last');
    expect(de.nounsCapitalized).toBe(true);
    expect(de.compoundMarkers).toBe(true);
    expect(de.questionMarks).toEqual(['?']);
    expect(data.conjunctions).toEqual(['bzw', 'oder', 'sowie', 'und']);
    expect(de.infinitiveSuffixes).toEqual([{ suffix: 'eln', minLength: 4 }, { suffix: 'en', minLength: 4 }, { suffix: 'ern', minLength: 4 }]);
    expect(data.participles).toEqual({ suffix: 'iert' });
    expect(de.examples).toEqual({ task: 'Antrag prüfen', event: 'Antrag eingegangen', message: 'Rechnung', subprocess: 'Schadenprüfung' });
    expect(loadLexicon('de')).toBe(de);
  });

  test('verbs: 250 to 400 lower-case infinitives with the required members', () => {
    expect(de.verbs.size).toBeGreaterThanOrEqual(250);
    expect(de.verbs.size).toBeLessThanOrEqual(400);
    for (const v of data.verbs) expect(v).toMatch(/^[a-zäöüß]+(en|eln|ern)$/);
    for (const v of REQUIRED_DE) expect(de.verbs.has(foldWord(v))).toBe(true);
  });

  test('every task verb of the German fixtures is a verb', () => {
    const words = germanFixtureVerbs();
    expect(words.length).toBeGreaterThanOrEqual(45);
    for (const w of words) expect([w, de.verbs.has(foldWord(w))]).toEqual([w, true]);
  });

  test('participleHomographs are exactly the verbs built from a prefix and a strong stem', () => {
    const insep = data.inseparablePrefixes.map(foldWord);
    const sep = ['', ...data.separablePrefixes.map(foldWord)];
    const stems = HOMOGRAPH_STEMS.map(foldWord);
    const built = new Set(sep.flatMap((s) => insep.flatMap((i) => stems.map((st) => s + i + st))));
    const derived = data.verbs.map(foldWord).filter((v) => built.has(v)).sort();
    expect([...de.participleHomographs].sort()).toEqual(derived);
    for (const w of ['erhalten', 'empfangen', 'bekommen', 'vergeben', 'übergeben']) expect(de.participleHomographs.has(foldWord(w))).toBe(true);
    for (const w of ['freigeben', 'genehmigen', 'prüfen']) expect(de.participleHomographs.has(foldWord(w))).toBe(false);
  });

  test('the lists keep their bounds and their shape', () => {
    expect(data.inseparablePrefixes.length).toBeLessThanOrEqual(16);
    expect(data.separablePrefixes.length).toBeLessThanOrEqual(50);
    expect(data.geInfinitives.length).toBeLessThanOrEqual(40);
    expect(data.adjectiveStoplist.length).toBeLessThanOrEqual(60);
    expect(data.stateMarkers.length).toBeLessThanOrEqual(20);
    expect(data.nounVerbHomographs.length).toBeLessThanOrEqual(30);
    for (const w of data.geInfinitives) expect(w.startsWith('ge')).toBe(true);
    for (const w of data.adjectiveStoplist) {
      expect(w).toMatch(/(en|eln|ern)$/);
      expect(de.verbs.has(foldWord(w))).toBe(false);
    }
    for (const w of ['bzw', 'zu', 'muss']) expect(de.verbs.has(w)).toBe(false);
  });

  test('geInfinitives lists every verb whose rest after the separable prefix looks like a participle', () => {
    const seps = [...data.separablePrefixes].sort((a, b) => b.length - a.length);
    const rest = (x) => {
      const p = seps.find((s) => x.startsWith(s) && x.length - s.length >= 3);
      return p ? x.slice(p.length) : x;
    };
    const gePart = (x) => /^ge.+(t|en)$/.test(x);
    const missing = data.verbs.filter((v) => gePart(rest(v)) && !data.geInfinitives.includes(rest(v)));
    expect(missing).toEqual([]);
    expect(data.geInfinitives).toContain('generieren');
    expect(data.geInfinitives.length).toBe(31);
  });

  test('everyday nouns equal to a verb are nounVerbHomographs', () => {
    for (const w of ['fragen', 'laden', 'messen', 'schulen', 'sichten', 'sperren', 'stellen', 'steuern', 'zahlen']) {
      expect(data.nounVerbHomographs).toContain(w);
    }
    expect(data.nounVerbHomographs.length).toBe(27);
    expect(data.verbs).not.toContain('instandhalten');
    expect(data.verbs).not.toContain('instandsetzen');
  });

  test('every event-marker keyword contains a legacy keyword', () => {
    expect(Object.keys(data.eventMarkers).sort()).toEqual(['conditional', 'error', 'escalation', 'message', 'signal', 'timer']);
    for (const words of Object.values(data.eventMarkers)) {
      for (const w of words) expect(LEGACY_EVENT_KEYWORDS.some((k) => w.includes(k))).toBe(true);
    }
  });

  test('lists are sorted by foldWord and unique after it', () => {
    const lists = [data.verbs, data.inseparablePrefixes, data.separablePrefixes, data.geInfinitives,
      data.participleHomographs, data.adjectiveStoplist, data.stateMarkers, data.nounVerbHomographs, data.conjunctions,
      ...Object.values(data.eventMarkers)];
    for (const list of lists) {
      expect([...list]).toEqual([...list].sort(cmp));
      expect(new Set(list.map(foldWord)).size).toBe(list.length);
    }
  });

  test('namingDePath resolves to the German file', () => {
    expect(namingDePath()).toMatch(/references[\\/]naming[\\/]de\.json$/);
  });
});
