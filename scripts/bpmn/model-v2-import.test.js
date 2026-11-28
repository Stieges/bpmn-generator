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
import { resolveFields } from './model-v2.js';
import { runPipeline } from './pipeline.js';
import { loadNamedView, ViewRejectedError } from '../shared/view.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const GOLDEN_MODEL = { organigramm: 'organigramm', systeme: 'bestellung-systeme' };
const golden = (view) => resolve(root, `tests/fixtures-v2/${GOLDEN_MODEL[view] ?? 'bestellung'}.${view}.expected.bpmn`);
const read = (path) => readFileSync(path, 'utf8');
const CATALOG = 'sha256:bbe131aa583483354fce5fede3ed1d170ce97b1fa90a1341b5a6af5af6d77273';
const CATALOG_ORG = 'sha256:19836e2ecd105136b1682f33b53a4ebd32a8a5039625fc09dde25578ae38c00b';
const CATALOG_SYS = 'sha256:c5ac5f1c62842fdd693bb58878cffa81b217335d2c9f16500b8ce7d3fb3a5cdb';
const LANE_IDS = {
  rollen: ['L.Process_Bestellung.sb_einkauf', 'L.Process_Bestellung.leitung', 'L.Process_Bestellung.zahlung'],
  einheiten: ['L.Process_Bestellung.abt_einkauf', 'L.Process_Bestellung.abt_buchhaltung'],
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
  const LANES = ['L.Process_Bestellung.sys_ordersystem', 'L.Process_Bestellung.sys_lieferportal'];
  for (const [name, reader] of Object.entries(READERS)) {
    test(`${name} gives a 1.x model that passes the 1.x gate, with the system texts`, async () => {
      const lc = await reader(read(golden('systeme')));
      expect(validateLogicCoreSchema(lc)).toEqual({ valid: true, errors: [] });
      expect(lc.$schemaVersion).toBeUndefined();
      expect(lc.lanes.map((l) => l.id)).toEqual(LANES);
      expect(lc.nodes.some((n) => 'role' in n || 'assignments' in n)).toBe(false);
      expect(Object.fromEntries(lc.nodes.filter((n) => n.system).map((n) => [n.id, n.system])))
        .toEqual({ pruefen: 'Bestellsystem', rueck: 'Lieferportal', zahlen: 'Bestellsystem' });
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
  const P = 'L.Process_Bestellung';
  const TREE = [
    // the flow ordering stacks Einkauf (with the start event) above the own lane
    { id: `${P}.bereich_beschaffung`, name: 'Beschaffung', children: [
      { id: `${P}.abt_einkauf`, name: 'Einkauf' },
      { id: `${P}.bereich_beschaffung._own`, name: 'Beschaffung' },
    ] },
    { id: `${P}.abt_buchhaltung`, name: 'Buchhaltung' },
  ];
  const LEAF = { start: 'abt_einkauf', pruefen: 'abt_einkauf', gw: 'abt_einkauf', rueck: 'bereich_beschaffung._own', zahlen: 'abt_buchhaltung', end: 'abt_buchhaltung' };

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
    expect(stdout).toContain('"L.Process_Bestellung.bereich_beschaffung._own"');
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
      expect(bpmnXml).toContain('id="L.Process_Bestellung.leitung"');
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
    expect(stdout).toContain('"L.Process_Bestellung.leitung"');
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

// ─── format 2.1 data: the import of native data associations, shared objects and stores ────────
describe('format 2.1 data: both readers read the output into a 1.x model', () => {
  const fixture = (name) => JSON.parse(read(resolve(root, `tests/fixtures-v2/${name}`)));
  const DATA_CATALOG = { ...fixture('bestellung-catalog.json'), data: [
    { id: 'd_bestellung', name: 'Bestellung', kind: 'object' },
    { id: 'd_rechnungen', name: 'Rechnungen', kind: 'object', isCollection: true },
    { id: 'd_register', name: 'Bestellregister', kind: 'store' },
  ] };
  const copy = (v) => JSON.parse(JSON.stringify(v));
  /** bestellung.json as "2.1" with the data access of `edit`, optionally an expanded subprocess `sp` holding `buchen`. */
  const model = (edit, { sub = false } = {}) => {
    const m = { ...fixture('bestellung.json'), $schemaVersion: '2.1' };
    delete m.catalog;
    for (const n of m.nodes) if (edit[n.id]) Object.assign(n, edit[n.id]);
    if (sub) {
      m.nodes.splice(5, 0, { id: 'sp', type: 'subProcess', name: 'Zahlung buchen', isExpanded: true, assignments: [{ type: 'D', actor: 'zahlung' }],
        nodes: [
          { id: 'sp_s', type: 'startEvent', name: 'Buchung beginnt' },
          { id: 'buchen', type: 'userTask', name: 'Rechnung buchen', dataAccess: [{ data: 'd_bestellung', access: 'read' }, { data: 'd_rechnungen', access: 'write' }] },
          { id: 'sp_e', type: 'endEvent', name: 'Rechnung gebucht' }],
        edges: [{ source: 'sp_s', target: 'buchen' }, { source: 'buchen', target: 'sp_e' }] });
      m.edges = m.edges.filter((e) => !(e.source === 'zahlen' && e.target === 'end'));
      m.edges.push({ source: 'zahlen', target: 'sp' }, { source: 'sp', target: 'end' });
    }
    return m;
  };
  const MAIN = model({
    pruefen: { dataAccess: [{ data: 'd_bestellung', access: 'read' }, { data: 'd_register', access: 'write' }] },
    rueck: { dataAccess: [{ data: 'd_bestellung' }] },
    zahlen: { dataAccess: [{ data: 'd_rechnungen', access: 'write' }] },
  }, { sub: true });
  const generate = async (m) => {
    const r = await runPipeline(copy(m), { catalog: copy(DATA_CATALOG), view: loadNamedView('rollen') });
    expect(r.validation.errors).toEqual([]);
    expect(r.validation.xmlWarnings).toEqual([]);
    return r.bpmnXml;
  };
  /** The intermediate associations as a 1.x import gives them: no `_access`, a link undirected. */
  const expectedAssociations = (m) => {
    const { lc, errors } = resolveFields(copy(m), { catalog: copy(DATA_CATALOG) });
    expect(errors).toEqual([]);
    return lc.associations.map(({ _access, ...a }) => ({ ...a, directed: a.directed === true }));
  };
  const byId = (list) => [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const allNodes = (nodes, out = []) => { for (const n of nodes ?? []) { out.push(n); allNodes(n.nodes, out); } return out; };

  for (const [name, reader] of Object.entries(READERS)) {
    test(`${name}: passes the 1.x gate; references are nodes with names and isCollection; associations by id`, async () => {
      const lc = await reader(await generate(MAIN));
      expect(validateLogicCoreSchema(lc)).toEqual({ valid: true, errors: [] });
      const refs = allNodes(lc.nodes).filter((n) => n.type.startsWith('data'))
        .map(({ id, type, name: label, isCollection }) => ({ id, type, name: label, ...(isCollection ? { isCollection } : {}) }));
      expect(byId(refs)).toEqual([
        { id: 'buchen__d_bestellung', type: 'dataObjectReference', name: 'Bestellung' },
        { id: 'buchen__d_rechnungen', type: 'dataObjectReference', name: 'Rechnungen', isCollection: true },
        { id: 'pruefen__d_bestellung', type: 'dataObjectReference', name: 'Bestellung' },
        { id: 'pruefen__d_register', type: 'dataStoreReference', name: 'Bestellregister' },
        { id: 'rueck__d_bestellung', type: 'dataObjectReference', name: 'Bestellung' },
        { id: 'zahlen__d_rechnungen', type: 'dataObjectReference', name: 'Rechnungen', isCollection: true },
      ]);
      const expected = expectedAssociations(MAIN);
      expect(expected.find((a) => a.id === 'rueck__d_bestellung__link').directed).toBe(false);
      expect(expected.filter((a) => a.directed)).toHaveLength(5);
      expect(byId(lc.associations)).toEqual(byId(expected));
      expect(JSON.stringify(lc)).not.toMatch(/bg:|__input|__store|Process_Bestellung__/);
      expect(keysOf(lc).filter((k) => k.startsWith('_') || k.startsWith('$'))).toEqual([]);
    });
  }

  test('both readers give the same model', async () => {
    const xml = await generate(MAIN);
    expect(await bpmnToLogicCore(xml)).toEqual(bpmnToLogicCoreLegacy(xml));
  });

  test('the CLI prints one N01 notice', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'import-data-'));
    try {
      const file = resolve(dir, 'data.bpmn');
      writeFileSync(file, await generate(MAIN));
      const { status, stderr } = spawnSync(process.execPath, [resolve(here, 'import.js'), file], { encoding: 'utf8' });
      expect(status).toBe(0);
      expect(stderr.match(/\[N01\]/g)).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a model listed out of flow order: the associations equal as a set, though the orders differ', async () => {
    const m = model({
      pruefen: { dataAccess: [{ data: 'd_bestellung', access: 'read' }, { data: 'd_register', access: 'write' }] },
      zahlen: { dataAccess: [{ data: 'd_rechnungen', access: 'write' }, { data: 'd_bestellung', access: 'read' }] },
    });
    const at = (id) => m.nodes.findIndex((n) => n.id === id);
    const [zahlen] = m.nodes.splice(at('zahlen'), 1);
    m.nodes.splice(at('pruefen'), 0, zahlen);
    expect(at('zahlen')).toBeLessThan(at('pruefen'));
    const expected = expectedAssociations(m);
    const xml = await generate(m);
    for (const reader of Object.values(READERS)) {
      const lc = await reader(xml);
      expect(lc.associations.map((a) => a.id)).not.toEqual(expected.map((a) => a.id));
      expect(byId(lc.associations)).toEqual(byId(expected));
    }
  });
});
