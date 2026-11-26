import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { loadLexicon, NamingDataError, NAMING_LANGUAGES } from './lexicon.js';
import { namingEnPath } from '../../shared/resource-paths.js';
import { foldWord } from './tokens.js';

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
    expect(en.infinitiveSuffixes).toEqual([{ suffix: 'ify', minLength: 6 }, { suffix: 'ise', minLength: 6 }, { suffix: 'ize', minLength: 6 }]);
    expect(en.participles.suffix).toBe('ed');
  });

  test('loadLexicon caches per language', () => {
    expect(loadLexicon('en')).toBe(en);
  });

  test('verbs: exactly 296 and every sourced literal is in', () => {
    expect(BUILT_IN_39).toHaveLength(39);
    expect(CORPUS_109).toHaveLength(109);
    expect(NAMED_22).toHaveLength(22);
    expect(RULING_44).toHaveLength(44);
    expect(en.verbs.size).toBe(296);
    for (const v of [...BUILT_IN_39, ...CORPUS_109, ...NAMED_22, ...RULING_44]) expect(en.verbs.has(v)).toBe(true);
    expect(en.verbs.has('invoice')).toBe(false);
    for (const v of ['nudge', 'path', 'step', 'case', 'need']) expect(en.verbs.has(v)).toBe(false);
  });

  test('verb phrases: the 8 of the contributor plus three', () => {
    expect(PHRASES_8).toHaveLength(8);
    const phrases = raw().verbPhrases;
    expect(phrases).toHaveLength(11);
    for (const p of [...PHRASES_8, 'carry out', 'look up', 'e mail']) expect(phrases).toContain(p);
    expect(en.verbPhrases).toHaveLength(11);
  });

  test('homographs: 167, a subset of verbs, with the named members', () => {
    expect(en.nounVerbHomographs.size).toBe(167);
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
    expect(exceptions).toHaveLength(13);
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
      data.participles.exceptions, data.stateWords, ...Object.values(data.eventMarkers)];
    for (const list of lists) {
      expect([...list]).toEqual([...list].sort(cmp));
      expect(new Set(list.map(foldWord)).size).toBe(list.length);
    }
  });

  test('sources credit the contributor', () => {
    const credited = en.sources.find((s) => s.reference === '#151');
    expect(credited.author).toBe('Jérôme Fenal (@jfenal)');
  });

  test('namingEnPath resolves, the registry lists en, an unregistered language throws', () => {
    expect(namingEnPath()).toMatch(/references[\\/]naming[\\/]en\.json$/);
    expect(Object.keys(NAMING_LANGUAGES)).toEqual(['en']);
    expect(() => loadLexicon('xx')).toThrow(NamingDataError);
    expect(() => loadLexicon('xx')).toThrow('no naming data for language "xx"');
  });
});
