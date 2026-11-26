import { describe, test, expect, afterAll } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readLexiconFile, NamingDataError, namingSchemaPath } from './lexicon.js';
import { resolveWithFallback } from '../../shared/resource-paths.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'naming-lexicon-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const common = {
  verbs: ['prüfen', 'erfassen'],
  nounVerbHomographs: [],
  participles: { suffix: 'ed', irregular: ['done'], exceptions: [] },
  eventMarkers: { message: ['empfangen'], timer: [], error: [], signal: [], escalation: [], conditional: [] },
  questionMarks: ['?'],
  examples: { task: ['a'], event: ['b'], message: ['c'], subprocess: ['d'] },
  sources: [{ name: 'test' }],
};
const verbFirst = { language: 'en', wordOrder: 'verb-first', ...common, verbPrefixes: ['re', 'pre'], stateWords: ['ready'] };
const verbLast = {
  language: 'de', wordOrder: 'verb-last', ...common,
  infinitiveSuffixes: [{ suffix: 'en', minLength: 5 }], geInfinitives: ['gehen'], separablePrefixes: ['ab', 'zurück'],
  inseparablePrefixes: ['ver', 'be'], adjectiveStoplist: [], participleHomographs: [], stateMarkers: ['ist'],
  verbPhrases: ['auf nehmen'], conjunctions: ['und'],
};
let n = 0;
const write = (content) => {
  const p = join(dir, `f${n++}.json`);
  writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
};

describe('readLexiconFile', () => {
  test('a valid verb-first file loads with folded sets', () => {
    const lex = readLexiconFile(write(verbFirst));
    expect(lex.verbs).toBeInstanceOf(Set);
    expect(lex.verbs.has('pruefen')).toBe(true);
    expect(lex.verbs.has('prüfen')).toBe(false);
    expect(lex.participles.irregular.has('done')).toBe(true);
    expect(lex.participles.suffix).toBe('ed');
    expect(lex.language).toBe('en');
    expect(lex.wordOrder).toBe('verb-first');
    expect(lex.eventMarkers.message).toEqual(['empfangen']);
    expect(lex.verbPrefixes).toEqual(['pre', 're']);
    expect(Object.isFrozen(lex)).toBe(true);
  });

  test('a valid verb-last file loads: phrases as arrays, prefixes longest first', () => {
    const lex = readLexiconFile(write(verbLast));
    expect(lex.verbPhrases).toEqual([['auf', 'nehmen']]);
    expect(lex.separablePrefixes).toEqual(['zurueck', 'ab']);
    expect(lex.inseparablePrefixes).toEqual(['ver', 'be']);
    expect(lex.infinitiveSuffixes).toEqual([{ suffix: 'en', minLength: 5 }]);
    expect(lex.geInfinitives.has('gehen')).toBe(true);
    expect(lex.stateMarkers.has('ist')).toBe(true);
    expect(lex.conjunctions.has('und')).toBe(true);
  });

  test.each([
    ['an unknown key', { ...verbFirst, surprise: 1 }],
    ['an upper-case word', { ...verbFirst, verbs: ['Prüfen'] }],
    ['a missing required key', (() => { const { verbs, ...r } = verbFirst; return r; })()],
    ['a verb-first file without its prefixes', (() => { const { verbPrefixes, ...r } = verbFirst; return r; })()],
    ['a verb-last file without its stoplist', (() => { const { adjectiveStoplist, ...r } = verbLast; return r; })()],
    ['a duplicate word', { ...verbFirst, verbs: ['a', 'a'] }],
    ['an unknown event marker key', { ...verbFirst, eventMarkers: { ...common.eventMarkers, other: [] } }],
    ['a bad language tag', { ...verbFirst, language: 'EN' }],
  ])('%s throws a NamingDataError naming the path', (_n, content) => {
    const p = write(content);
    let err;
    try { readLexiconFile(p); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(NamingDataError);
    expect(err.code).toBe('NAMING_DATA');
    expect(err.name).toBe('NamingDataError');
    expect(err.message).toContain(p);
    expect(err.message).toContain('does not match the naming schema');
  });

  test('invalid JSON and a missing path throw a NamingDataError naming the path', () => {
    const bad = write('{ nope');
    expect(() => readLexiconFile(bad)).toThrow(NamingDataError);
    expect(() => readLexiconFile(bad)).toThrow(bad);
    const missing = join(dir, 'does-not-exist.json');
    expect(() => readLexiconFile(missing)).toThrow(NamingDataError);
    expect(() => readLexiconFile(missing)).toThrow(missing);
  });
});

describe('importing lexicon.js', () => {
  test('reads no file under references/', () => {
    const code = `
      import fs from 'node:fs';
      const seen = [];
      for (const k of ['readFileSync', 'openSync']) {
        const orig = fs[k];
        fs[k] = (p, ...a) => { seen.push(String(p)); return orig(p, ...a); };
      }
      await import(${JSON.stringify(join(here, 'lexicon.js'))});
      console.log(JSON.stringify(seen.filter(p => /[\\\\/]references[\\\\/]/.test(p))));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    expect(JSON.parse(out.trim())).toEqual([]);
  });
});

describe('namingSchemaPath', () => {
  test('resolves to the repository file', () => {
    expect(namingSchemaPath()).toBe(join(here, '..', '..', '..', 'references', 'naming-schema.json'));
    expect(JSON.parse(readFileSync(namingSchemaPath(), 'utf8')).$schema).toContain('2020-12');
  });

  test('falls back to the packaged twin', () => {
    const packaged = join(dir, 'naming-schema.json');
    writeFileSync(packaged, '{}');
    expect(resolveWithFallback(join(dir, 'nope.json'), packaged, 'naming-schema.json')).toBe(packaged);
  });
});
