import { describe, test, expect, afterAll } from '@jest/globals';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  LANGUAGE_TAG, languageTag, modelLanguage, namingFor, checkNamingOverlay, namingHints, NAMING_LANGUAGES, NamingDataError, namingDataErrorOf,
  H14_MAX_WORDS,
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

  test('namingDataErrorOf finds a NamingDataError through the cause chain', () => {
    const direct = new NamingDataError('naming data "/x.json" is not valid JSON');
    const once = new Error('Reviewer agent failed (iteration 0): …', { cause: direct });
    const twice = new Error('outer', { cause: once });
    expect(namingDataErrorOf(direct)).toBe(direct);
    expect(namingDataErrorOf(once)).toBe(direct);
    expect(namingDataErrorOf(twice)).toBe(direct);
    expect(namingDataErrorOf(new Error('other', { cause: new TypeError('x') }))).toBeNull();
    expect(namingDataErrorOf(null)).toBeNull();
    expect(namingDataErrorOf(undefined)).toBeNull();
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    a.cause = b; // a cycle without a NamingDataError: bounded, returns null
    expect(namingDataErrorOf(a)).toBeNull();
  });

  test('BPMN_NAMING is read at call time: add makes a word listed, remove unlisted', () => {
    const add = overlayFile('add.json', { languages: { en: { add: { verbs: ['invoice'] } } } });
    const remove = overlayFile('remove.json', { languages: { en: { remove: { verbs: ['check'] } } } });
    expect(withEnv(undefined, () => namingFor('en').unlistedFirstWord('Invoice customer'))).toBe('Invoice');
    expect(withEnv(add, () => namingFor('en').unlistedFirstWord('Invoice customer'))).toBeNull();
    expect(withEnv(undefined, () => namingFor('en').unlistedFirstWord('Check order'))).toBeNull();
    expect(withEnv(remove, () => namingFor('en').unlistedFirstWord('Check order'))).toBe('Check');
    // A shorter list never adds a finding: without "check" the name passes with the hint.
    expect(withEnv(remove, () => namingFor('en').taskName('Check order'))).toBeNull();
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

describe('namingHints: H12 and H13', () => {
  const tasks = (...names) => names.map((name, i) => ({ id: `t${i}`, type: 'userTask', name }));
  const model = (language, names, extra = {}) => ({ id: 'p', language, nodes: tasks(...names), ...extra });
  const ENGLISH = ['Review request', 'Approve invoice', 'Send letter'];
  const GERMAN = ['Antrag prüfen', 'Rechnung freigeben', 'Kunde informieren'];
  // Passes both conventions ("Brief" is also an English verb).
  const BOTH = 'Brief versenden';
  const codes = (lc) => namingHints(lc).map((h) => h.code);

  test('H12 for a valid tag without a strategy, with the whole tag; elements empty', () => {
    expect(namingHints(model('fr-CA', ENGLISH))).toEqual([{
      code: 'H12',
      message: 'Language "fr-CA" has no naming conventions here; the naming rules M01, M05 and M06 are skipped (supported: de, en).',
      elements: [],
    }]);
  });

  test('no valid language: no hint', () => {
    for (const language of [undefined, 'German', 'DE', 5, null, 'de" x="1']) expect(namingHints(model(language, ENGLISH))).toEqual([]);
  });

  test('H13 at 3 tasks, 3 of 3 fail and pass; never both H12 and H13', () => {
    expect(namingHints(model('de', ENGLISH))).toEqual([{
      code: 'H13',
      message: 'The task names look like "en" but the model declares "de": 3 of 3 fail the German convention, 3 pass the English one.',
      elements: [],
    }]);
    expect(namingHints(model('en', GERMAN)).map((h) => h.message)).toEqual([
      'The task names look like "de" but the model declares "en": 3 of 3 fail the English convention, 3 pass the German one.',
    ]);
  });

  test('two named tasks never give H13; unnamed tasks and non-tasks do not count', () => {
    expect(codes(model('de', ENGLISH.slice(0, 2)))).toEqual([]);
    const lc = model('de', ENGLISH.slice(0, 2), {});
    lc.nodes.push({ id: 'u', type: 'userTask' }, { id: 'g', type: 'exclusiveGateway', name: 'Approve invoice' });
    expect(codes(lc)).toEqual([]);
  });

  test('tasks in a subprocess and in a second pool count', () => {
    const lc = { id: 'c', language: 'de', pools: [
      { id: 'a', name: 'A', nodes: [{ id: 's', type: 'subProcess', name: 'Handle case', nodes: tasks('Review request', 'Approve invoice') }] },
      { id: 'b', name: 'B', nodes: [{ id: 'x', type: 'task', name: 'Send letter' }] },
    ] };
    expect(namingHints(lc).map((h) => h.code)).toEqual(['H13']);
  });

  test('thresholds: 60 percent must fail the declared, 80 percent must pass the other', () => {
    const E = ['Review request', 'Approve invoice', 'Send letter'];
    // 3 of 5 fail de (60 %), all 5 pass en: hint
    expect(codes(model('de', [...E, BOTH, BOTH]))).toEqual(['H13']);
    // 2 of 5 fail de (40 %): none
    expect(codes(model('de', [E[0], E[1], BOTH, BOTH, BOTH]))).toEqual([]);
    // all 5 fail de, 4 pass en (80 %): hint
    expect(codes(model('de', [...E, 'Handle case', 'Antrag prüfen']))).toEqual(['H13']);
    // all 5 fail de, 3 pass en (60 %): none
    expect(codes(model('de', [...E, 'Antrag prüfen', 'Rechnung freigeben']))).toEqual([]);
  });

  test('H12 or H13 come before H10 and H11', () => {
    const lc = model('de', ENGLISH);
    const marked = { inferred: [{ id: 'e', name: 'Fristablauf', type: 'startEvent', marker: 'timer', legacy: null, pool: null }], changed: [] };
    expect(namingHints(lc, marked).map((h) => h.code)).toEqual(['H13', 'H10']);
  });
});

describe('namingHints: H14', () => {
  const tasks = (...names) => names.map((name, i) => ({ id: `t${i}`, type: 'userTask', name }));
  const model = (language, names) => ({ id: 'p', language, nodes: tasks(...names) });
  const TAIL = 'If these are verbs nothing is wrong; add them to "verbs" through BPMN_NAMING to silence this hint.';

  test('names the unlisted first words of English task names once, in order of first occurrence', () => {
    expect(namingHints(model('en', ['Groom backlog', 'Review request', 'Apostille certificate', 'groom team']))).toEqual([{
      code: 'H14',
      message: `First word not in the English verb list: 'Groom', 'Apostille'. ${TAIL}`,
      elements: [],
    }]);
  });

  test('lists at most 10 words and says how many more there are', () => {
    expect(H14_MAX_WORDS).toBe(10);
    const words = ['Alfa', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett', 'Kilo', 'Lima'];
    const [hint] = namingHints(model('en', [...words.map((w) => `${w} widget`), 'Alfa widget']));
    expect(hint.message).toBe(`First word not in the English verb list: ${words.slice(0, 10).map((w) => `'${w}'`).join(', ')} and 2 more. ${TAIL}`);
  });

  test('only task names count: containers, events, flagged and verb-first names give none', () => {
    const lc = model('en', ['Review request', 'Checking invoice', 'Invoice checked', 'Groom']);
    lc.nodes.push({ id: 's', type: 'subProcess', name: 'Backlog grooming', nodes: [] }, { id: 'e', type: 'endEvent', name: 'Groom done' });
    expect(namingHints(lc)).toEqual([]);
  });

  test('task names at every level and in every pool count', () => {
    const lc = { id: 'c', language: 'en', pools: [
      { id: 'a', name: 'A', nodes: [{ id: 's', type: 'subProcess', name: 'Backlog handling', nodes: tasks('Groom backlog') }] },
      { id: 'b', name: 'B', nodes: [{ id: 'x', type: 'task', name: 'Escrow funds' }] },
    ] };
    expect(namingHints(lc).map((h) => h.message)).toEqual([`First word not in the English verb list: 'Groom', 'Escrow'. ${TAIL}`]);
  });

  test('never for German, without a language, with H12 or with H13', () => {
    expect(namingHints(model('de', ['Antrag prüfen', 'Rechnung freigeben', 'Groom backlog']))).toEqual([]);
    expect(namingHints(model(undefined, ['Groom backlog']))).toEqual([]);
    expect(namingHints(model('fr', ['Groom backlog'])).map((h) => h.code)).toEqual(['H12']);
    expect(namingHints(model('en', ['Antrag prüfen', 'Rechnung freigeben', 'Kunde informieren'])).map((h) => h.code)).toEqual(['H13']);
  });

  test('comes after H12/H13 and before H10 and H11', () => {
    const marked = { inferred: [{ id: 'e', name: 'Deadline missed', type: 'boundaryEvent', marker: 'timer', legacy: 'timer', pool: null }], changed: [] };
    expect(namingHints(model('en', ['Groom backlog']), marked).map((h) => h.code)).toEqual(['H14', 'H10']);
  });

  test('an overlay that lists the word silences it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'naming-h14-'));
    const before = process.env.BPMN_NAMING;
    try {
      process.env.BPMN_NAMING = join(dir, 'h14.json');
      writeFileSync(process.env.BPMN_NAMING, JSON.stringify({ languages: { en: { add: { verbs: ['groom'] } } } }));
      expect(namingHints(model('en', ['Groom backlog']))).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.BPMN_NAMING; else process.env.BPMN_NAMING = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
