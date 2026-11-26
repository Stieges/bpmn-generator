import { describe, test, expect, afterAll } from '@jest/globals';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  LANGUAGE_TAG, languageTag, modelLanguage, namingFor, checkNamingOverlay, NAMING_LANGUAGES, NamingDataError,
} from './index.js';

const readSchema = (name) => JSON.parse(readFileSync(new URL(`../../../references/${name}`, import.meta.url), 'utf8'));

/** Every `properties.language.pattern` anywhere in a schema. */
function languagePatterns(value, out = []) {
  if (Array.isArray(value)) { for (const v of value) languagePatterns(v, out); return out; }
  if (value && typeof value === 'object') {
    const pattern = value.properties?.language?.pattern;
    if (typeof pattern === 'string') out.push(pattern);
    for (const v of Object.values(value)) languagePatterns(v, out);
  }
  return out;
}

describe('LANGUAGE_TAG', () => {
  test.each([['input-schema.json'], ['input-schema-v2.json']])('is the pattern of %s', (name) => {
    const patterns = languagePatterns(readSchema(name));
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) expect(LANGUAGE_TAG.source).toBe(pattern);
  });
});

describe('modelLanguage', () => {
  test.each([
    [{ language: 'de' }, 'de'],
    [{ language: 'en-GB' }, 'en'],
    [{ language: 'gsw-CH' }, 'gsw'],
    [{}, null],
    [{ language: 'German' }, null],
    [{ language: 'DE' }, null],
    [{ language: 5 }, null],
    [{ language: null }, null],
    [{ language: 'de" x="1' }, null],
  ])('%j → %p', (lc, expected) => {
    expect(modelLanguage(lc)).toBe(expected);
  });

  test.each([[null], [[]], ['x'], [undefined], [5], [[{ language: 'de' }]]])('never throws: %p → null', (lc) => {
    expect(modelLanguage(lc)).toBeNull();
  });
});

describe('languageTag', () => {
  test('is the whole valid tag', () => {
    expect(languageTag({ language: 'en-GB' })).toBe('en-GB');
    expect(languageTag({ language: 'de' })).toBe('de');
  });

  test.each([[{ language: 'German' }], [{ language: 'de" x="1' }], [{}], [null], [[]], ['de'], [undefined]])('null for %p', (lc) => {
    expect(languageTag(lc)).toBeNull();
  });
});

describe('the registry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'naming-index-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const overlayFile = (name, content) => {
    const p = join(dir, name);
    writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
    return p;
  };
  const withEnv = (value, fn) => {
    const before = process.env.BPMN_NAMING;
    if (value === undefined) delete process.env.BPMN_NAMING; else process.env.BPMN_NAMING = value;
    try { return fn(); } finally {
      if (before === undefined) delete process.env.BPMN_NAMING; else process.env.BPMN_NAMING = before;
    }
  };

  test('namingFor gives null for no or an unregistered language', () => {
    expect(namingFor(null)).toBeNull();
    expect(namingFor('fr')).toBeNull();
    expect(namingFor('toString')).toBeNull();
  });

  test('one strategy per registered language, cached', () => {
    withEnv(undefined, () => {
      expect(namingFor('de').wordOrder).toBe('verb-last');
      expect(namingFor('en').wordOrder).toBe('verb-first');
      expect(namingFor('en')).toBe(namingFor('en'));
    });
  });

  test('re-exports NAMING_LANGUAGES and NamingDataError', () => {
    expect(Object.keys(NAMING_LANGUAGES)).toEqual(['de', 'en']);
    expect(new NamingDataError('x').code).toBe('NAMING_DATA');
  });

  test('BPMN_NAMING is read at call time: add makes a name pass, remove makes it fail', () => {
    const add = overlayFile('add.json', { languages: { en: { add: { verbs: ['invoice'] } } } });
    const remove = overlayFile('remove.json', { languages: { en: { remove: { verbs: ['check'] } } } });
    expect(withEnv(undefined, () => namingFor('en').taskName('Invoice customer'))).not.toBeNull();
    expect(withEnv(add, () => namingFor('en').taskName('Invoice customer'))).toBeNull();
    expect(withEnv(undefined, () => namingFor('en').taskName('Check order'))).toBeNull();
    expect(withEnv(remove, () => namingFor('en').taskName('Check order'))).not.toBeNull();
  });

  test('a broken overlay makes namingFor throw a NamingDataError naming the path', () => {
    const broken = overlayFile('broken.json', '{ nope');
    let err;
    try { withEnv(broken, () => namingFor('en')); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(NamingDataError);
    expect(err.message).toContain(broken);
    expect(withEnv(broken, () => namingFor('fr'))).toBeNull();
  });

  test('checkNamingOverlay: nothing without BPMN_NAMING, throws for a broken file, passes a good one', () => {
    expect(() => checkNamingOverlay({})).not.toThrow();
    const broken = overlayFile('broken2.json', '{ nope');
    expect(() => checkNamingOverlay({ BPMN_NAMING: broken })).toThrow(NamingDataError);
    expect(() => checkNamingOverlay({ BPMN_NAMING: join(dir, 'missing.json') })).toThrow(NamingDataError);
    const good = overlayFile('good.json', { languages: { de: { add: { verbs: ['fooen'] } } } });
    expect(() => checkNamingOverlay({ BPMN_NAMING: good })).not.toThrow();
  });
});

describe('BPMN_NAMING on the CLI', () => {
  const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const run = (extraEnv) => {
    const out = mkdtempSync(join(tmpdir(), 'naming-cli-'));
    try {
      const env = { ...process.env, ...extraEnv };
      if (extraEnv.BPMN_NAMING === undefined) delete env.BPMN_NAMING;
      const r = spawnSync(process.execPath, ['bpmn/pipeline.js', '../tests/fixtures/simple-approval.json', join(out, 'out')],
        { cwd: scripts, encoding: 'utf8', env });
      return { status: r.status, stdout: r.stdout.split(out).join('<out>'), stderr: r.stderr.split(out).join('<out>') };
    } finally { rmSync(out, { recursive: true, force: true }); }
  };

  test('a model without language ignores a missing overlay file entirely', () => {
    const plain = run({});
    const withVar = run({ BPMN_NAMING: '/nonexistent.json' });
    expect(plain.status).toBe(0);
    expect(withVar).toEqual(plain);
  });
});

describe('importing naming/index.js', () => {
  test('reads no naming data file', () => {
    const code = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const seen = [];
      for (const k of ['readFileSync', 'openSync']) {
        const orig = fs[k];
        fs[k] = (p, ...a) => { seen.push(String(p)); return orig(p, ...a); };
      }
      syncBuiltinESMExports();
      await import(${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'index.js')).href)});
      console.log(JSON.stringify(seen.filter(p => /[\\\\/]references[\\\\/]naming/.test(p))));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }).trim();
    expect(JSON.parse(out)).toEqual([]);
  });
});
