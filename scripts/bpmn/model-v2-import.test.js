/**
 * Importing a diagram generated from a format 2.0 model (design 10 "Zwischenzeit", 11 a, 11 e):
 * both importers give a 1.x model (formed lanes as ordinary lanes, no `role`, no `bg:` data), the
 * result passes the 1.x gate, and every import entry point reports the origin with one notice.
 * The import never refuses. A foreign tool may drop the `bg:` attributes on saving; the file then
 * imports as plain 1.x output, without a notice.
 */
import { describe, test, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bpmnToLogicCore, bpmnToLogicCoreLegacy, readModelMarker, readModelLanguage, MODEL_V2_IMPORT_NOTICE, MODEL_V2_IMPORT_NOTICE_CODE } from './import.js';
import { validateLogicCoreSchema } from './schema-gate.js';
import { runPipeline } from './pipeline.js';
import { loadNamedView, ViewRejectedError } from '../shared/view.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const GOLDEN_MODEL = { organigramm: 'organigramm', systeme: 'schaden-systeme' };
const golden = (view) => resolve(root, `tests/fixtures-v2/${GOLDEN_MODEL[view] ?? 'schaden'}.${view}.expected.bpmn`);
const read = (path) => readFileSync(path, 'utf8');
const CATALOG = 'sha256:1839c85404873913d420764884aa77ed37f54a3341df18b7e641c0f85f70c9a4';
const CATALOG_ORG = 'sha256:0261e68c2a37cc3d7a5eef8a2ca8d10314ec949abcb0af30514e1fe04b126842';
const CATALOG_SYS = 'sha256:ca38a972cb2661579c6d2ded39f4625c3a3bab332d58c9ef9c7eb5f56be6fc43';
const LANE_IDS = {
  rollen: ['L.Process_Schaden.sb_schaden', 'L.Process_Schaden.regress', 'L.Process_Schaden.zahlung'],
  einheiten: ['L.Process_Schaden.abt_schaden', 'L.Process_Schaden.abt_finanzen'],
};
const READERS = { bpmnToLogicCore, bpmnToLogicCoreLegacy };

/** Every key anywhere in a JSON value. */
function keysOf(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.push(k); keysOf(v, out); }
  }
  return out;
}

/** The golden as a foreign modeler might save it: the `bg:` attributes on `definitions` gone. */
const edited = (xml) => xml.replace(/<bpmn:definitions[^>]*>/, (tag) => tag.replace(/\s+bg:(modelVersion|view|catalog)="[^"]*"/g, ''));

describe('MODEL_V2_IMPORT_NOTICE_CODE', () => {
  test('is N01', () => {
    expect(MODEL_V2_IMPORT_NOTICE_CODE).toBe('N01');
  });
});

describe('MODEL_V2_IMPORT_NOTICE', () => {
  test('is the agreed text', () => {
    expect(MODEL_V2_IMPORT_NOTICE).toBe('Diagram generated from a format 2.0 model. Changes belong in the model. '
      + 'Importing yields a format 1.x model; assignments and catalogue references are lost.');
  });
});

for (const view of ['rollen', 'einheiten']) {
  describe(`the ${view} golden`, () => {
    for (const [name, reader] of Object.entries(READERS)) {
      test(`${name} gives a 1.x model that passes the 1.x gate`, async () => {
        const lc = await reader(read(golden(view)));
        expect(validateLogicCoreSchema(lc)).toEqual({ valid: true, errors: [] });
        expect(lc.$schemaVersion).toBeUndefined();
        expect(lc.lanes.map((l) => l.id)).toEqual(LANE_IDS[view]);
        expect(lc.lanes.every((l) => Object.keys(l).sort().join() === 'id,name')).toBe(true);
        expect(lc.nodes.some((n) => 'role' in n || 'assignments' in n)).toBe(false);
        expect(lc.nodes.every((n) => LANE_IDS[view].includes(n.lane))).toBe(true);
        const text = JSON.stringify(lc);
        expect(text).not.toMatch(/bg:|modelVersion|sha256|assignment|derived/);
        expect(keysOf(lc).filter((k) => k.startsWith('_') || k.startsWith('$'))).toEqual([]);
      });
    }

    test('both readers give the same model', async () => {
      const xml = read(golden(view));
      expect(await bpmnToLogicCore(xml)).toEqual(bpmnToLogicCoreLegacy(xml));
    });

    test('readModelMarker reads the origin from the root element', () => {
      expect(readModelMarker(read(golden(view)))).toEqual({ modelVersion: '2.0', view, catalog: CATALOG });
    });
  });
}

// The system golden: system lanes import as ordinary lanes, the system of a task as its 1.x `system` text.
describe('the systeme golden', () => {
  const LANES = ['L.Process_Schaden.sys_schaden', 'L.Process_Schaden.sys_regress'];
  for (const [name, reader] of Object.entries(READERS)) {
    test(`${name} gives a 1.x model that passes the 1.x gate, with the system texts`, async () => {
      const lc = await reader(read(golden('systeme')));
      expect(validateLogicCoreSchema(lc)).toEqual({ valid: true, errors: [] });
      expect(lc.$schemaVersion).toBeUndefined();
      expect(lc.lanes.map((l) => l.id)).toEqual(LANES);
      expect(lc.nodes.some((n) => 'role' in n || 'assignments' in n)).toBe(false);
      expect(Object.fromEntries(lc.nodes.filter((n) => n.system).map((n) => [n.id, n.system])))
        .toEqual({ pruefen: 'Schadensystem', regr: 'Regressportal', zahlen: 'Schadensystem' });
      expect(JSON.stringify(lc)).not.toMatch(/bg:|modelVersion|sha256|assignment|derived/);
      expect(keysOf(lc).filter((k) => k.startsWith('_') || k.startsWith('$'))).toEqual([]);
    });
  }

  test('both readers give the same model', async () => {
    const xml = read(golden('systeme'));
    expect(await bpmnToLogicCore(xml)).toEqual(bpmnToLogicCoreLegacy(xml));
  });

  test('readModelMarker reads the origin from the root element', () => {
    expect(readModelMarker(read(golden('systeme')))).toEqual({ modelVersion: '2.1', view: 'systeme', catalog: CATALOG_SYS });
  });

  test('the CLI prints one N01 notice on stderr', () => {
    const { status, stderr } = spawnSync(process.execPath, [resolve(here, 'import.js'), golden('systeme')], { encoding: 'utf8' });
    expect(status).toBe(0);
    expect(stderr.match(/\[N01\]/g)).toHaveLength(1);
  });
});

// The nested golden: the lane tree imports as 1.x nested lanes, every node in a leaf lane.
describe('the organigramm golden', () => {
  const P = 'L.Process_Schaden';
  const TREE = [
    // the flow ordering stacks Schadenabteilung (with the start event) above the own lane
    { id: `${P}.bereich_leistung`, name: 'Leistung', children: [
      { id: `${P}.abt_schaden`, name: 'Schadenabteilung' },
      { id: `${P}.bereich_leistung._own`, name: 'Leistung' },
    ] },
    { id: `${P}.abt_finanzen`, name: 'Finanzen' },
  ];
  const LEAF = { start: 'abt_schaden', pruefen: 'abt_schaden', gw: 'abt_schaden', regr: 'bereich_leistung._own', zahlen: 'abt_finanzen', end: 'abt_finanzen' };

  for (const [name, reader] of Object.entries(READERS)) {
    test(`${name} gives a 1.x model with the nested lanes that passes the 1.x gate`, async () => {
      const lc = await reader(read(golden('organigramm')));
      expect(validateLogicCoreSchema(lc)).toEqual({ valid: true, errors: [] });
      expect(lc.$schemaVersion).toBeUndefined();
      expect(lc.lanes).toEqual(TREE);
      expect(Object.fromEntries(lc.nodes.map((n) => [n.id, n.lane]))).toEqual(
        Object.fromEntries(Object.entries(LEAF).map(([id, leaf]) => [id, `${P}.${leaf}`])));
      expect(lc.nodes.some((n) => 'role' in n || 'assignments' in n)).toBe(false);
      expect(JSON.stringify(lc)).not.toMatch(/bg:|modelVersion|sha256|assignment|derived/);
      expect(keysOf(lc).filter((k) => k.startsWith('_') || k.startsWith('$'))).toEqual([]);
    });
  }

  test('both readers give the same model', async () => {
    const xml = read(golden('organigramm'));
    expect(await bpmnToLogicCore(xml)).toEqual(bpmnToLogicCoreLegacy(xml));
  });

  test('readModelMarker reads the origin from the root element', () => {
    expect(readModelMarker(read(golden('organigramm')))).toEqual({ modelVersion: '2.0', view: 'organigramm', catalog: CATALOG_ORG });
  });

  test('the CLI prints the notice on stderr', () => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [resolve(here, 'import.js'), golden('organigramm')], { encoding: 'utf8' });
    expect(status).toBe(0);
    expect(stderr).toContain(`[N01] ${MODEL_V2_IMPORT_NOTICE}`);
    expect(stdout).toContain('"L.Process_Schaden.bereich_leistung._own"');
  });
});

describe('readModelMarker', () => {
  const xml = read(golden('rollen'));

  test('finds the marker by its namespace URI, under any prefix', () => {
    const renamed = xml.replace(/xmlns:bg=/g, 'xmlns:x=').replace(/\bbg:/g, 'x:');
    expect(renamed).not.toContain('bg:');
    expect(readModelMarker(renamed)).toEqual({ modelVersion: '2.0', view: 'rollen', catalog: CATALOG });
  });

  test('a prefix bound to another namespace is no marker', () => {
    const foreign = xml.replace('xmlns:bg="http://bpmn-generator/schema/1.0"', 'xmlns:bg="http://example.org/other"');
    expect(readModelMarker(foreign)).toBeNull();
  });

  test('tolerates a missing bg:view and bg:catalog', () => {
    const bare = xml.replace(/\s+bg:(view|catalog)="[^"]*"/g, '');
    expect(readModelMarker(bare)).toEqual({ modelVersion: '2.0', view: null, catalog: null });
  });

  test('is null for 1.x output, an edited golden and text that is no XML', () => {
    expect(readModelMarker(read(resolve(root, 'tests/fixtures/simple-approval.expected.bpmn')))).toBeNull();
    expect(readModelMarker(edited(xml))).toBeNull();
    for (const junk of ['', 'not xml', '<', '<a', null, undefined, 7]) expect(readModelMarker(junk)).toBeNull();
  });

  test('never changes what the importer returns', async () => {
    const before = await bpmnToLogicCore(xml);
    readModelMarker(xml);
    expect(await bpmnToLogicCore(xml)).toEqual(before);
    expect(await bpmnToLogicCore(edited(xml))).toEqual(before);
  });
});

describe('an edited 2.0 diagram (Review Focus 1)', () => {
  const xml = read(golden('rollen'));

  test('without the bg: attributes it imports without a notice, passes the 1.x gate and regenerates', async () => {
    const changed = edited(xml);
    expect(changed).not.toMatch(/bg:modelVersion|bg:view|bg:catalog/);
    expect(readModelMarker(changed)).toBeNull();
    for (const reader of Object.values(READERS)) {
      const lc = await reader(changed);
      expect(validateLogicCoreSchema(lc).valid).toBe(true);
      const { bpmnXml } = await runPipeline(lc);
      expect(bpmnXml).toContain('id="L.Process_Schaden.regress"');
    }
  });

  test('the unedited import is a 1.x model: the view rollen on it is the 1.x view error', async () => {
    const lc = await bpmnToLogicCore(xml);
    await expect(runPipeline(lc, { view: loadNamedView('rollen') })).rejects.toThrow(ViewRejectedError);
    await expect(runPipeline(lc, { view: loadNamedView('rollen') }))
      .rejects.toThrow('view "rollen" forms lanes from assignments; this model (format 1.x) carries its own lanes — translate it with node bpmn/migrate.js');
  });
});

describe('CLI node bpmn/import.js', () => {
  const cli = (file) => spawnSync(process.execPath, [resolve(here, 'import.js'), file], { encoding: 'utf8' });

  test('prints the notice on stderr, not on stdout, for 2.0 output', () => {
    const { status, stdout, stderr } = cli(golden('rollen'));
    expect(status).toBe(0);
    expect(stderr).toContain(`[N01] ${MODEL_V2_IMPORT_NOTICE}`);
    expect(stdout).not.toContain(MODEL_V2_IMPORT_NOTICE);
    expect(stdout).toContain('"L.Process_Schaden.regress"');
  });

  test('prints no notice for 1.x output', () => {
    const { status, stderr } = cli(resolve(root, 'tests/fixtures/simple-approval.expected.bpmn'));
    expect(status).toBe(0);
    expect(stderr).not.toContain(MODEL_V2_IMPORT_NOTICE);
  });

  test('prints no notice for an edited 2.0 golden (bg: attributes removed)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'import-edited-'));
    try {
      const file = resolve(dir, 'edited.bpmn');
      writeFileSync(file, edited(read(golden('rollen'))));
      const { status, stderr } = cli(file);
      expect(status).toBe(0);
      expect(stderr).not.toContain(MODEL_V2_IMPORT_NOTICE);
      expect(stderr).not.toContain('N01');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ─── bg:language on bpmn:definitions ──────────────────────────────────────────────────────────
describe('readModelLanguage', () => {
  const plain = read(resolve(root, 'tests/fixtures/simple-approval.expected.bpmn'));
  /** 1.x output with `attrs` added to the definitions start tag. */
  const withAttrs = (attrs) => plain.replace(/<bpmn:definitions\b/, (tag) => `${tag} ${attrs}`);
  const NS = 'http://bpmn-generator/schema/1.0';

  test('reads the tag under any prefix bound to the namespace', () => {
    expect(readModelLanguage(withAttrs(`xmlns:bg="${NS}" bg:language="en-GB"`))).toBe('en-GB');
    expect(readModelLanguage(withAttrs(`xmlns:x="${NS}" x:language="de"`))).toBe('de');
  });

  test('null for a foreign namespace, an invalid tag, no attribute, and text that is no XML', () => {
    expect(readModelLanguage(withAttrs('xmlns:bg="http://example.org/other" bg:language="de"'))).toBeNull();
    expect(readModelLanguage(withAttrs(`xmlns:bg="${NS}" bg:language="German"`))).toBeNull();
    expect(readModelLanguage(withAttrs(`xmlns:bg="${NS}" bg:language=""`))).toBeNull();
    expect(readModelLanguage(withAttrs(`bg:language="de"`))).toBeNull();
    expect(readModelLanguage(plain)).toBeNull();
    expect(readModelLanguage(read(golden('rollen')))).toBeNull();
    for (const junk of ['', 'not xml', '<', '<a', null, undefined, 7, {}]) expect(readModelLanguage(junk)).toBeNull();
  });

  for (const [name, reader] of Object.entries(READERS)) {
    test(`${name}: an invalid tag imports without the field`, async () => {
      const lc = await reader(withAttrs(`xmlns:bg="${NS}" bg:language="German"`));
      expect(lc).not.toHaveProperty('language');
      expect(lc).toEqual(await reader(plain));
    });

    test(`${name}: a valid tag is the last key, nothing else changes`, async () => {
      const lc = await reader(withAttrs(`xmlns:bg="${NS}" bg:language="en-GB"`));
      expect(Object.keys(lc).at(-1)).toBe('language');
      expect(lc.language).toBe('en-GB');
      const { language: _drop, ...rest } = lc;
      expect(rest).toEqual(await reader(plain));
    });
  }

  test('a 1.x XML with bg:language is no 2.0 marker and raises no N01', () => {
    const xml = withAttrs(`xmlns:bg="${NS}" bg:language="de"`);
    expect(readModelMarker(xml)).toBeNull();
    const dir = mkdtempSync(resolve(tmpdir(), 'import-language-'));
    try {
      const file = resolve(dir, 'language.bpmn');
      writeFileSync(file, xml);
      const { status, stdout, stderr } = spawnSync(process.execPath, [resolve(here, 'import.js'), file], { encoding: 'utf8' });
      expect(status).toBe(0);
      expect(stderr).not.toContain('N01');
      expect(stderr).not.toContain(MODEL_V2_IMPORT_NOTICE);
      expect(stdout).toContain('"language": "de"');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
