/**
 * The naming data files explain themselves: the optional top-level `purpose` and `listNotes`
 * (documentation only; no rule, strategy or hint reads them).
 */
import { describe, test, expect, afterAll } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLexiconFile, loadLexicon, NamingDataError, namingSchemaPath } from './lexicon.js';
import { namingEnPath, namingDePath } from '../../shared/resource-paths.js';
import { verbFirst } from './verb-first.js';
import { verbLast } from './verb-last.js';
import { TASK_TYPES, CONTAINER_TYPES, EVENT_TYPES } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'naming-docs-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
let n = 0;
const write = (content) => {
  const p = join(dir, `f${n++}.json`);
  writeFileSync(p, JSON.stringify(content));
  return p;
};

const schema = readJson(namingSchemaPath());
const DOC_KEYS = ['purpose', 'listNotes'];
const LIST_NAMES = ['verbs', 'verbPhrases', 'verbPrefixes', 'nounVerbHomographs', 'participles', 'stateWords', 'stateMarkers',
  'infinitiveSuffixes', 'participleHomographs', 'inseparablePrefixes', 'separablePrefixes', 'geInfinitives',
  'adjectiveStoplist', 'conjunctions', 'eventMarkers', 'questionMarks', 'nonVerbStarters', 'nounStarters', 'auxiliaries', 'messageNouns', 'instructionVerbs'];
const SHIPPED = { de: namingDePath(), en: namingEnPath() };

describe('schema', () => {
  test('purpose and listNotes are optional; listNotes allows exactly the list properties of the schema', () => {
    expect(schema.required).not.toEqual(expect.arrayContaining(DOC_KEYS));
    expect(schema.properties.purpose).toEqual({ type: 'string', minLength: 1, maxLength: 1500 });
    const notes = schema.properties.listNotes;
    expect(notes.type).toBe('object');
    expect(notes.additionalProperties).toBe(false);
    expect(Object.keys(notes.properties).sort()).toEqual([...LIST_NAMES].sort());
    for (const k of LIST_NAMES) expect(Object.hasOwn(schema.properties, k)).toBe(true);
    for (const p of Object.values(notes.properties)) expect(p).toEqual({ type: 'string', minLength: 1, maxLength: 300 });
  });

  test('the overlay format has neither field', () => {
    const lang = schema.$defs.LanguageOverlay.properties;
    for (const k of DOC_KEYS) {
      expect(Object.hasOwn(schema.$defs.Overlay.properties, k)).toBe(false);
      expect(Object.hasOwn(lang, k)).toBe(false);
      expect(Object.hasOwn(lang.add.properties, k)).toBe(false);
      expect(Object.hasOwn(lang.remove.properties, k)).toBe(false);
    }
  });
});

describe('readLexiconFile with the documentation fields', () => {
  const base = readJson(SHIPPED.en);
  test('a file with purpose and listNotes validates', () => {
    const f = write({ ...base, purpose: 'Why.', listNotes: { verbs: 'First word.', eventMarkers: 'Markers.' } });
    expect(readLexiconFile(f).language).toBe('en');
  });

  test.each([
    ['an unknown listNotes key', { listNotes: { nouns: 'x' } }],
    ['a listNotes value that is no string', { listNotes: { verbs: 5 } }],
    ['an empty listNotes value', { listNotes: { verbs: '' } }],
    ['an over-long listNotes value', { listNotes: { verbs: 'x'.repeat(301) } }],
    ['listNotes that is no object', { listNotes: ['verbs'] }],
    ['an over-long purpose', { purpose: 'x'.repeat(1501) }],
    ['an empty purpose', { purpose: '' }],
    ['a purpose that is no string', { purpose: 7 }],
  ])('%s throws a NamingDataError naming the path', (_n, extra) => {
    const f = write({ ...base, ...extra });
    let err;
    try { readLexiconFile(f); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(NamingDataError);
    expect(err.message).toContain(f);
  });

  test('an overlay carrying purpose or listNotes is rejected', () => {
    for (const extra of [{ purpose: 'x' }, { listNotes: {} }]) {
      const f = write({ languages: {}, ...extra });
      expect(() => loadLexicon('en', { overlayPath: f })).toThrow(NamingDataError);
    }
    const inLanguage = write({ languages: { en: { purpose: 'x' } } });
    expect(() => loadLexicon('en', { overlayPath: inLanguage })).toThrow(NamingDataError);
    const inAdd = write({ languages: { en: { add: { listNotes: {} } } } });
    expect(() => loadLexicon('en', { overlayPath: inAdd })).toThrow(NamingDataError);
  });
});

describe.each(Object.keys(SHIPPED))('shipped %s file', (language) => {
  const data = readJson(SHIPPED[language]);

  test('carries a purpose and a note for lists it has', () => {
    expect(typeof data.purpose).toBe('string');
    expect(data.purpose.length).toBeGreaterThan(200);
    expect(data.purpose.length).toBeLessThanOrEqual(1500);
    const keys = Object.keys(data.listNotes);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(LIST_NAMES).toContain(k);
      expect(Object.hasOwn(data, k)).toBe(true);
      expect(data.listNotes[k].length).toBeLessThanOrEqual(300);
    }
  });

  test('every list present in the file has a note', () => {
    const read = language === 'de'
      ? ['verbs', 'nounVerbHomographs', 'participles', 'stateMarkers', 'infinitiveSuffixes', 'participleHomographs',
        'inseparablePrefixes', 'separablePrefixes', 'geInfinitives', 'adjectiveStoplist', 'conjunctions', 'eventMarkers', 'questionMarks']
      : ['verbs', 'verbPhrases', 'verbPrefixes', 'nounVerbHomographs', 'participles', 'stateWords', 'infinitiveSuffixes',
        'nonVerbStarters', 'nounStarters', 'auxiliaries', 'messageNouns', 'instructionVerbs', 'eventMarkers', 'questionMarks'];
    expect(Object.keys(data.listNotes).sort()).toEqual([...read].sort());
  });

  test('the documentation fields come before the word lists', () => {
    const keys = Object.keys(data);
    expect(keys.indexOf('purpose')).toBeLessThan(keys.indexOf('verbs'));
    expect(keys.indexOf('listNotes')).toBeLessThan(keys.indexOf('verbs'));
  });
});

describe('the fields change no behaviour', () => {
  const root = join(here, '..', '..', '..', 'tests', 'fixtures');
  const languages = readJson(join(root, 'rules-characterization', 'fixture-languages.json'));

  function labelsOf(model) {
    const out = { taskName: [], containerName: [], eventName: [], messageName: [] };
    const walk = (nodes) => {
      for (const node of nodes ?? []) {
        if (typeof node.name === 'string' && node.name !== '') {
          if (CONTAINER_TYPES.has(node.type)) out.containerName.push(node.name);
          else if (TASK_TYPES.has(node.type)) out.taskName.push(node.name);
          else if (EVENT_TYPES.has(node.type)) out.eventName.push(node.name);
        }
        walk(node.nodes);
      }
    };
    for (const p of Array.isArray(model.pools) ? model.pools : [model]) walk(p.nodes);
    for (const m of model.messageFlows ?? []) if (typeof m.name === 'string' && m.name !== '') out.messageName.push(m.name);
    return out;
  }

  test('all 28 fixtures are in the language map', () => {
    expect(readdirSync(root).filter((f) => f.endsWith('.json') && !f.endsWith('.expected.json'))).toHaveLength(28);
  });

  test.each(Object.keys(SHIPPED))('%s: a stripped copy gives the same lexicon and the same verdicts', (language) => {
    const { purpose, listNotes, ...stripped } = readJson(SHIPPED[language]);
    expect(purpose).toBeDefined();
    expect(listNotes).toBeDefined();
    const full = readLexiconFile(SHIPPED[language]);
    const bare = readLexiconFile(write(stripped));
    expect(bare).toEqual(full);
    for (const k of DOC_KEYS) expect(Object.hasOwn(full, k)).toBe(false);
    const build = language === 'de' ? verbLast : verbFirst;
    const a = build(full);
    const b = build(bare);
    let checked = 0;
    for (const [file, l] of Object.entries(languages)) {
      if (l !== language) continue;
      const labels = labelsOf(readJson(join(root, file)));
      for (const [judge, names] of Object.entries(labels)) {
        for (const name of names) {
          expect(b[judge](name)).toEqual(a[judge](name));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});
