import { describe, test, expect, afterAll } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  examples: { task: 'a', event: 'b', message: 'c', subprocess: 'd' },
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

describe('compoundMarkers schema', () => {
  test('a boolean is accepted, an array is rejected', () => {
    expect(readLexiconFile(write({ ...verbFirst, compoundMarkers: true })).compoundMarkers).toBe(true);
    expect(() => readLexiconFile(write({ ...verbFirst, compoundMarkers: ['x'] }))).toThrow(NamingDataError);
  });
});

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
    ['an array as an example value', { ...verbFirst, examples: { ...common.examples, task: ['a'] } }],
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
  // Patches fs on the default export AND syncs the named ESM exports, so named imports are seen.
  const probe = (importLine) => `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const seen = [];
    for (const k of ['readFileSync', 'openSync']) {
      const orig = fs[k];
      fs[k] = (p, ...a) => { seen.push(String(p)); return orig(p, ...a); };
    }
    syncBuiltinESMExports();
    ${importLine}
    console.log(JSON.stringify(seen.filter(p => /[\\\\/]references[\\\\/]/.test(p))));
  `;
  const run = (code) => JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }).trim());

  test('reads no file under references/', () => {
    expect(run(probe(`await import(${JSON.stringify(join(here, 'lexicon.js'))});`))).toEqual([]);
  });

  test('positive control: the probe reports a named-import read of the schema', () => {
    const scratch = join(dir, 'control.mjs');
    writeFileSync(scratch, `import { readFileSync } from 'node:fs';
import { namingSchemaPath } from ${JSON.stringify(pathToFileURL(join(here, '..', '..', 'shared', 'resource-paths.js')).href)};
readFileSync(namingSchemaPath(), 'utf8');
`);
    const seen = run(probe(`await import(${JSON.stringify(pathToFileURL(scratch).href)});`));
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe('a validator that cannot be built', () => {
  test('is a NamingDataError naming the data path and the reason', () => {
    const data = write('{}');
    const code = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const orig = fs.readFileSync;
      fs.readFileSync = (p, ...a) => {
        if (String(p).endsWith('naming-schema.json')) throw new Error('schema gone');
        return orig(p, ...a);
      };
      syncBuiltinESMExports();
      const { readLexiconFile, NamingDataError } = await import(${JSON.stringify(pathToFileURL(join(here, 'lexicon.js')).href)});
      try { readLexiconFile(${JSON.stringify(data)}); console.log('no throw'); }
      catch (e) { console.log(JSON.stringify({ named: e instanceof NamingDataError, message: e.message })); }
    `;
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }).trim());
    expect(out.named).toBe(true);
    expect(out.message).toContain(data);
    expect(out.message).toContain('cannot be validated: schema gone');
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
