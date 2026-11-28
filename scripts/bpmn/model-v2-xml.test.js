/**
 * XML places of a 2.0 model (design 11 a): every assignment as `<bg:assignment>` in the node's
 * extensionElements, a formed lane's `<bg:derived>` marker in the lane's extensionElements, and
 * the origin as attributes on `bpmn:definitions`. Fed a hand-built 1.x-shaped model carrying the
 * private fields of the intermediate form (design 7.5), through `runPipeline` without a view.
 */
import { describe, test, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bpmnXsdStatus, xsdDir } from '../../.github/scripts/fetch-bpmn-xsd.mjs';
import { runPipeline } from './pipeline.js';
import { bpmnToLogicCore, bpmnToLogicCoreLegacy } from './import.js';
import { validateLogicCoreSchema } from './schema-gate.js';
import { loadNamedView } from '../shared/view.js';

const PINNED = 'sha256:bbe131aa583483354fce5fede3ed1d170ce97b1fa90a1341b5a6af5af6d77273';
const ASSIGNMENT = '<bg:assignment type="D" actor="sb_einkauf" />';
const LANE_MARKER = '<bg:derived by="role" actor="sb_einkauf">lane</bg:derived>';
const LANE = 'L.P._sb';
const MODEL_INFO = { version: '2.0', view: 'rollen', catalogFingerprint: PINNED };
const D = [{ type: 'D', actor: 'sb_einkauf' }];

const copy = (v) => JSON.parse(JSON.stringify(v));
const count = (xml, re) => (xml.match(re) || []).length;

/** The intermediate form: lanes formed by role, every node with one D assignment. */
function formed() {
  return {
    id: 'P', name: 'Bestellung abwickeln',
    _modelInfo: { ...MODEL_INFO },
    lanes: [{ id: LANE, name: 'Sachbearbeitung Einkauf', _derived: 'lane', _laneBy: 'role', _laneActor: 'sb_einkauf' }],
    nodes: [
      { id: 's', type: 'startEvent', name: 'Bestellung eingegangen', lane: LANE, _assignments: D },
      { id: 't', type: 'userTask', name: 'Auftrag prüfen', lane: LANE, _assignments: D },
      { id: 'b', type: 'boundaryEvent', marker: 'timer', attachedTo: 't', cancelActivity: false,
        name: '3 Tage vergangen', lane: LANE, _assignments: D },
      { id: 'eb', type: 'endEvent', name: 'Erinnert', lane: LANE },
      { id: 'gw', type: 'exclusiveGateway', name: 'Auftrag freigegeben?', lane: LANE, _assignments: D },
      {
        id: 'sp', type: 'subProcess', name: 'Zahlung abwickeln', isExpanded: true, lane: LANE,
        nodes: [
          { id: 'c_s', type: 'startEvent', name: 'Zahlung beginnt' },
          { id: 'c_t', type: 'userTask', name: 'Zahlung freigeben', _assignments: D },
          { id: 'c_e', type: 'endEvent', name: 'Zahlung freigegeben' },
        ],
        edges: [
          { id: 'c_f1', source: 'c_s', target: 'c_t' },
          { id: 'c_f2', source: 'c_t', target: 'c_e' },
        ],
      },
      { id: 'e1', type: 'endEvent', name: 'Auftrag erledigt', lane: LANE },
      { id: 'e2', type: 'endEvent', name: 'Auftrag abgelehnt', lane: LANE },
    ],
    edges: [
      { id: 'f1', source: 's', target: 't' },
      { id: 'f2', source: 't', target: 'gw' },
      { id: 'f3', source: 'gw', target: 'sp', label: 'ja' },
      { id: 'f4', source: 'gw', target: 'e2', label: 'nein' },
      { id: 'f5', source: 'sp', target: 'e1' },
      { id: 'f6', source: 'b', target: 'eb' },
    ],
  };
}

/** The same model without any private field of the intermediate form. */
function stripPrivate(value) {
  return JSON.parse(JSON.stringify(value, (k, v) => (k.startsWith('_') ? undefined : v)));
}

/** The element `<bpmn:<tag> id="<id>" …>…</bpmn:<tag>>` of `xml`. */
function element(xml, tag, id) {
  const m = xml.match(new RegExp(`<bpmn:${tag} id="${id}"[\\s\\S]*?</bpmn:${tag}>`));
  if (!m) throw new Error(`no <bpmn:${tag} id="${id}"> in the XML`);
  return m[0];
}
const extensionOf = (el) => el.match(/<bpmn:extensionElements>[\s\S]*?<\/bpmn:extensionElements>/)?.[0] ?? '';
const definitionsTag = (xml) => xml.match(/<bpmn:definitions\b[^>]*>/)[0];

async function generate(model) {
  const r = await runPipeline(copy(model));
  expect(r.validation.errors).toEqual([]);
  return r;
}

describe('2.0 XML places (design 11 a)', () => {
  test('every assignment sits in the node\'s extensionElements, subprocess children included', async () => {
    const { bpmnXml, validation } = await generate(formed());
    expect(validation.xmlWarnings).toEqual([]);
    for (const [tag, id] of [['userTask', 't'], ['startEvent', 's'], ['exclusiveGateway', 'gw'],
      ['boundaryEvent', 'b'], ['userTask', 'c_t']]) {
      expect(extensionOf(element(bpmnXml, tag, id))).toContain(ASSIGNMENT);
    }
    expect(count(bpmnXml, /<bg:assignment\b/g)).toBe(5);
  });

  test('a formed lane carries its marker as first child, before flowNodeRef', async () => {
    const { bpmnXml } = await generate(formed());
    const lane = element(bpmnXml, 'lane', LANE.replace(/\./g, '\\.'));
    const body = lane.replace(/^<bpmn:lane[^>]*>\s*/, '');
    expect(body).toMatch(/^<bpmn:extensionElements>\s*<bg:derived by="role" actor="sb_einkauf">lane<\/bg:derived>\s*<\/bpmn:extensionElements>\s*<bpmn:flowNodeRef>/);
    expect(lane.indexOf(LANE_MARKER)).toBeLessThan(lane.indexOf('<bpmn:flowNodeRef>'));
  });

  test('definitions carry the origin, exporter, no exporterVersion, one xmlns:bg', async () => {
    const { bpmnXml } = await generate(formed());
    const defs = definitionsTag(bpmnXml);
    expect(defs).toContain(`bg:modelVersion="2.0"`);
    expect(defs).toContain(`bg:view="rollen"`);
    expect(defs).toContain(`bg:catalog="${PINNED}"`);
    expect(defs).toContain('exporter="bpmn-generator"');
    expect(bpmnXml).not.toContain('exporterVersion');
    expect(count(bpmnXml, /xmlns:bg=/g)).toBe(1);
    expect(defs).toContain('xmlns:bg="http://bpmn-generator/schema/1.0"');
  });

  test('xmlns:bg is declared once with no assignment and no lane', async () => {
    const bare = {
      id: 'P', name: 'Bestellung aufgeben', _modelInfo: { ...MODEL_INFO, view: 'default' },
      nodes: [
        { id: 's', type: 'startEvent', name: 'Bedarf entstanden' },
        { id: 't', type: 'userTask', name: 'Bestellung aufgeben' },
        { id: 'e', type: 'endEvent', name: 'Bestellung eingegangen' },
      ],
      edges: [{ id: 'f1', source: 's', target: 't' }, { id: 'f2', source: 't', target: 'e' }],
    };
    const { bpmnXml, validation } = await generate(bare);
    expect(validation.xmlWarnings).toEqual([]);
    expect(count(bpmnXml, /xmlns:bg=/g)).toBe(1);
    expect(count(bpmnXml, /<bg:/g)).toBe(0);
    expect(definitionsTag(bpmnXml)).toContain('bg:view="default"');
  });

  test('no performer, resource or system in 2.0 output', async () => {
    const { bpmnXml } = await generate(formed());
    expect(bpmnXml).not.toMatch(/<bpmn:(performer|humanPerformer|resource)\b/);
    expect(bpmnXml).not.toContain('<bg:system');
  });

  test('a collaboration: assignments and lane markers of both pools are written', async () => {
    const pool = (id, nodePrefix) => ({
      id, name: `Pool ${id}`,
      lanes: [{ id: `L.${id}`, name: 'Sachbearbeitung Einkauf', _derived: 'lane', _laneBy: 'role', _laneActor: 'sb_einkauf' }],
      nodes: [
        { id: `${nodePrefix}s`, type: 'startEvent', name: 'Bestellung eingegangen', lane: `L.${id}`, _assignments: D },
        { id: `${nodePrefix}t`, type: 'userTask', name: 'Auftrag prüfen', lane: `L.${id}`, _assignments: D },
        { id: `${nodePrefix}e`, type: 'endEvent', name: 'Auftrag geprüft', lane: `L.${id}` },
      ],
      edges: [{ id: `${nodePrefix}f1`, source: `${nodePrefix}s`, target: `${nodePrefix}t` }, { id: `${nodePrefix}f2`, source: `${nodePrefix}t`, target: `${nodePrefix}e` }],
    });
    const model = { id: 'C', name: 'Bestellung', _modelInfo: { ...MODEL_INFO }, pools: [pool('PA', 'a'), pool('PB', 'b')],
      messageFlows: [{ id: 'm1', source: 'at', target: 'bs' }] };
    const { bpmnXml, validation } = await generate(model);
    expect(validation.xmlWarnings).toEqual([]);
    expect(count(bpmnXml, /<bg:assignment\b/g)).toBe(4);
    expect(count(bpmnXml, /<bg:derived\b/g)).toBe(2);
    for (const [tag, id] of [['userTask', 'at'], ['startEvent', 'as'], ['userTask', 'bt'], ['startEvent', 'bs']]) {
      expect(extensionOf(element(bpmnXml, tag, id))).toContain(ASSIGNMENT);
    }
    expect(count(bpmnXml, /xmlns:bg=/g)).toBe(1);
  });

  test('without the private fields nothing of it is written', async () => {
    const { bpmnXml } = await generate(stripPrivate(formed()));
    expect(bpmnXml).not.toMatch(/bg:assignment|bg:derived|bg:modelVersion|exporter=/);
  });

  test.each([
    ['bpmnToLogicCore', (xml) => bpmnToLogicCore(xml)],
    ['bpmnToLogicCoreLegacy', async (xml) => bpmnToLogicCoreLegacy(xml)],
  ])('%s reads the same model as without the private fields', async (_name, read) => {
    const withFields = (await generate(formed())).bpmnXml;
    const without = (await generate(stripPrivate(formed()))).bpmnXml;
    expect(await read(withFields)).toEqual(await read(without));
  });
});

const xsd = bpmnXsdStatus();
(xsd.available ? test : test.skip)('2.0 output validates against BPMN20.xsd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-v2-xml-'));
  try {
    const files = [];
    for (const [name, model] of [['formed', formed()], ['bare', { ...stripPrivate(formed()), _modelInfo: MODEL_INFO }]]) {
      const file = join(dir, `${name}.bpmn`);
      writeFileSync(file, (await generate(model)).bpmnXml);
      files.push(file);
    }
    // Throws with xmllint's message when a file fails to validate.
    execFileSync('xmllint', ['--noout', '--schema', join(xsdDir(), 'BPMN20.xsd'), ...files], { encoding: 'utf8', stdio: 'pipe' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── the language of a model on bpmn:definitions ───────────────────────────────────────────────
const fixture = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
const withoutDefinitionsTag = (xml) => xml.replace(/<bpmn:definitions\b[^>]*>/, '<bpmn:definitions>');
const ONE_X = [
  ['simple-approval (no bg: element)', 'tests/fixtures/simple-approval.json'],
  ['nested-lanes-role-system (bg:system elements)', 'tests/fixtures/nested-lanes-role-system.json'],
];

describe('bg:language on bpmn:definitions', () => {
  test.each(ONE_X)('a 1.x model %s: one xmlns:bg, bg:language, no other difference', async (_name, path) => {
    const plain = await generate(fixture(path));
    const tagged = await generate({ ...fixture(path), language: 'de' });
    const defs = definitionsTag(tagged.bpmnXml);
    expect(defs).toContain('bg:language="de"');
    expect(defs).toContain('xmlns:bg="http://bpmn-generator/schema/1.0"');
    expect(count(tagged.bpmnXml, /xmlns:bg=/g)).toBe(1);
    expect(defs).not.toContain('exporter=');
    expect(tagged.bpmnXml).not.toBe(plain.bpmnXml);
    expect(withoutDefinitionsTag(tagged.bpmnXml)).toBe(withoutDefinitionsTag(plain.bpmnXml));
    expect(tagged.svg).toBe(plain.svg);
    expect(tagged.validation.xmlWarnings).toEqual(plain.validation.xmlWarnings);
  });

  test('the attribute follows the origin attributes', async () => {
    const defs = definitionsTag((await generate({ ...formed(), language: 'en-GB' })).bpmnXml);
    expect(defs).toContain('bg:language="en-GB"');
    expect(defs.indexOf('bg:catalog=')).toBeLessThan(defs.indexOf('bg:language='));
    expect(count(defs, /xmlns:bg=/g)).toBe(1);
  });

  test('a 2.0 model carries modelVersion, view, catalog and language', async () => {
    const model = { ...fixture('tests/fixtures-v2/bestellung.json'), language: 'de' };
    const r = await runPipeline(model, { catalog: fixture('tests/fixtures-v2/bestellung-catalog.json') });
    expect(r.validation.errors).toEqual([]);
    const defs = definitionsTag(r.bpmnXml);
    expect(defs).toMatch(/bg:modelVersion="2\.0" bg:view="default" bg:catalog="sha256:[0-9a-f]{64}" bg:language="de"/);
    expect(count(r.bpmnXml, /xmlns:bg=/g)).toBe(1);
  });

  test.each([['German'], ['DE'], [5], [null], ['de" x="1']])('an invalid language %p writes no attribute (Review Focus 1)', async (language) => {
    const plain = await generate(fixture('tests/fixtures/simple-approval.json'));
    const r = await runPipeline({ ...fixture('tests/fixtures/simple-approval.json'), language });
    expect(r.bpmnXml).toBe(plain.bpmnXml);
    expect(r.svg).toBe(plain.svg);
  });

  test.each([
    ['bpmnToLogicCore', (xml) => bpmnToLogicCore(xml)],
    ['bpmnToLogicCoreLegacy', async (xml) => bpmnToLogicCoreLegacy(xml)],
  ])('%s reads language back as the last key', async (_name, read) => {
    const lc = await read((await generate({ ...fixture('tests/fixtures/simple-approval.json'), language: 'en-GB' })).bpmnXml);
    expect(lc.language).toBe('en-GB');
    expect(Object.keys(lc).at(-1)).toBe('language');
    const { language: _drop, ...rest } = lc;
    expect(rest).toEqual(await read((await generate(fixture('tests/fixtures/simple-approval.json'))).bpmnXml));
  });
});

(xsd.available ? test : test.skip)('1.x output with bg:language validates against BPMN20.xsd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-v2-xml-lang-'));
  try {
    const files = [];
    for (const [i, [, path]] of ONE_X.entries()) {
      const file = join(dir, `lang-${i}.bpmn`);
      writeFileSync(file, (await generate({ ...fixture(path), language: 'de' })).bpmnXml);
      files.push(file);
    }
    execFileSync('xmllint', ['--noout', '--schema', join(xsdDir(), 'BPMN20.xsd'), ...files], { encoding: 'utf8', stdio: 'pipe' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── format 2.1 data: the test model (bestellung.json with data access, a nested step) ─────────
const DATA = [
  { id: 'd_bestellung', name: 'Bestellung', kind: 'object' },
  { id: 'd_rechnungen', name: 'Rechnungen', kind: 'object', isCollection: true },
  { id: 'd_register', name: 'Bestellregister', kind: 'store' },
];
const DATA_CATALOG = { ...fixture('tests/fixtures-v2/bestellung-catalog.json'), data: DATA };
/**
 * bestellung.json as "2.1": pruefen reads the order and writes the register, rueck uses the order
 * (access not recorded), zahlen writes the invoices (a collection), and the expanded subprocess sp
 * holds buchen, which reads the order and writes the invoices.
 */
function dataModel() {
  const m = { ...fixture('tests/fixtures-v2/bestellung.json'), $schemaVersion: '2.1' };
  delete m.catalog;
  const edit = {
    pruefen: { dataAccess: [{ data: 'd_bestellung', access: 'read' }, { data: 'd_register', access: 'write' }] },
    rueck: { dataAccess: [{ data: 'd_bestellung' }] },
    zahlen: { dataAccess: [{ data: 'd_rechnungen', access: 'write' }] },
  };
  for (const n of m.nodes) if (edit[n.id]) Object.assign(n, edit[n.id]);
  m.nodes.splice(5, 0, { id: 'sp', type: 'subProcess', name: 'Zahlung buchen', isExpanded: true, assignments: [{ type: 'D', actor: 'zahlung' }],
    nodes: [
      { id: 'sp_s', type: 'startEvent', name: 'Buchung beginnt' },
      { id: 'buchen', type: 'userTask', name: 'Rechnung buchen', dataAccess: [{ data: 'd_bestellung', access: 'read' }, { data: 'd_rechnungen', access: 'write' }] },
      { id: 'sp_e', type: 'endEvent', name: 'Rechnung gebucht' }],
    edges: [{ source: 'sp_s', target: 'buchen' }, { source: 'buchen', target: 'sp_e' }] });
  m.edges = m.edges.filter((e) => !(e.source === 'zahlen' && e.target === 'end'));
  m.edges.push({ source: 'zahlen', target: 'sp' }, { source: 'sp', target: 'end' });
  return m;
}

// ─── format 2.1: the system of a task ──────────────────────────────────────────────────────────
describe('format 2.1: <bg:system ref> in the task\'s extensionElements', () => {
  const CATALOG_S = {
    scheme: 'demi',
    actors: [{ id: 'sb_einkauf', name: 'Sachbearbeitung Einkauf', kind: 'role' }],
    systems: [{ id: 'sys_akte', name: 'Bestellakte' }],
  };
  const MODEL_S = {
    $schemaVersion: '2.1', id: 'Process_Bestellung', name: 'Bestellung abwickeln',
    nodes: [
      { id: 'start', type: 'startEvent', name: 'Bestellung eingegangen', assignments: D },
      { id: 'pruefen', type: 'userTask', name: 'Auftrag prüfen', system: 'sys_akte', assignments: D },
      { id: 'end', type: 'endEvent', name: 'Auftrag geprüft' },
    ],
    edges: [{ source: 'start', target: 'pruefen' }, { source: 'pruefen', target: 'end' }],
  };
  const SYSTEM = '<bg:system ref="sys_akte">Bestellakte</bg:system>';
  const generateS = async () => {
    const r = await runPipeline(copy(MODEL_S), { catalog: copy(CATALOG_S) });
    expect(r.validation.errors).toEqual([]);
    return r;
  };

  test('the system sits before the assignment; nowhere else', async () => {
    const { bpmnXml, validation } = await generateS();
    expect(validation.xmlWarnings).toEqual([]);
    const ext = extensionOf(element(bpmnXml, 'userTask', 'pruefen'));
    expect(ext).toContain(SYSTEM);
    expect(ext.indexOf(SYSTEM)).toBeLessThan(ext.indexOf(ASSIGNMENT));
    expect(count(bpmnXml, /<bg:system\b/g)).toBe(1);
    expect(definitionsTag(bpmnXml)).toContain('bg:modelVersion="2.1"');
  });

  test.each([
    ['bpmnToLogicCore', (xml) => bpmnToLogicCore(xml)],
    ['bpmnToLogicCoreLegacy', async (xml) => bpmnToLogicCoreLegacy(xml)],
  ])('%s reads it back as system: "Bestellakte", no ref; the result passes the 1.x gate', async (_name, read) => {
    const lc = await read((await generateS()).bpmnXml);
    const pruefen = lc.nodes.find((n) => n.id === 'pruefen');
    expect(pruefen.system).toBe('Bestellakte');
    expect(JSON.stringify(lc)).not.toContain('sys_akte');
    expect(validateLogicCoreSchema(lc)).toEqual({ valid: true, errors: [] });
  });

  const generateView = async (name) => {
    const r = await runPipeline(copy(MODEL_S), { catalog: copy(CATALOG_S), view: loadNamedView(name) });
    expect(r.validation.errors).toEqual([]);
    return r;
  };

  test('view systeme: a system lane carries by="system" system="…"; view rollen keeps actor="…"', async () => {
    const { bpmnXml, validation } = await generateView('systeme');
    expect(validation.xmlWarnings).toEqual([]);
    const lane = element(bpmnXml, 'lane', 'L\\.Process_Bestellung\\.sys_akte');
    expect(extensionOf(lane)).toContain('<bg:derived by="system" system="sys_akte">lane</bg:derived>');
    expect(lane).not.toContain('actor=');
    expect(bpmnXml).toContain('name="Bestellakte"');
    expect(count(bpmnXml, /<bg:derived\b/g)).toBe(1);
    const roles = (await generateView('rollen')).bpmnXml;
    expect(extensionOf(element(roles, 'lane', 'L\\.Process_Bestellung\\.sb_einkauf'))).toContain(LANE_MARKER);
    expect(roles).not.toContain('by="system"');
  });

  (xsd.available ? test : test.skip)('2.1 output validates against BPMN20.xsd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-v2-xml-sys-'));
    try {
      const file = join(dir, 'system.bpmn');
      writeFileSync(file, (await generateS()).bpmnXml);
      const lanes = join(dir, 'system-lanes.bpmn');
      writeFileSync(lanes, (await generateView('systeme')).bpmnXml);
      // the data model: shared data objects, a data store, properties, data associations, a nested reference
      const data = join(dir, 'data.bpmn');
      const r = await runPipeline(dataModel(), { catalog: copy(DATA_CATALOG), view: loadNamedView('rollen') });
      expect(r.validation.errors).toEqual([]);
      expect(r.bpmnXml).toContain('<bpmn:dataInputAssociation');
      writeFileSync(data, r.bpmnXml);
      execFileSync('xmllint', ['--noout', '--schema', join(xsdDir(), 'BPMN20.xsd'), file, lanes, data], { encoding: 'utf8', stdio: 'pipe' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── format 2.1: data references, shared data objects, data stores, data associations ──────────
describe('format 2.1: native data associations, shared data objects and data stores', () => {
  const run = async () => {
    const r = await runPipeline(dataModel(), { catalog: copy(DATA_CATALOG), view: loadNamedView('rollen') });
    expect(r.validation.errors).toEqual([]);
    return r;
  };
  const startTag = (xml, tag, id) => {
    const m = xml.match(new RegExp(`<bpmn:${tag} id="${id}"[^>]*>`));
    if (!m) throw new Error(`no <bpmn:${tag} id="${id}">`);
    return m[0];
  };
  /** The whole element, self-closing or not. */
  const whole = (xml, tag, id) => {
    const open = startTag(xml, tag, id);
    return open.endsWith('/>') ? open : element(xml, tag, id);
  };
  const REFS = ['pruefen__d_bestellung', 'rueck__d_bestellung', 'zahlen__d_rechnungen', 'buchen__d_bestellung', 'buchen__d_rechnungen'];

  test('one shared DataObject per item and process, no <id>_do, every reference points to it', async () => {
    const { bpmnXml, validation } = await run();
    expect(validation.xmlWarnings).toEqual([]);
    expect(count(bpmnXml, /<bpmn:dataObject id="Process_Bestellung__d_bestellung" name="Bestellung" \/>/g)).toBe(1);
    expect(count(bpmnXml, /<bpmn:dataObject id="Process_Bestellung__d_rechnungen" name="Rechnungen" isCollection="true" \/>/g)).toBe(1);
    expect(count(bpmnXml, /<bpmn:dataObject\b/g)).toBe(2);
    expect(bpmnXml).not.toMatch(/_do"/);
    expect(count(bpmnXml, /<bpmn:dataObjectReference\b/g)).toBe(REFS.length);
    for (const id of REFS) {
      const item = id.split('__')[1];
      expect(startTag(bpmnXml, 'dataObjectReference', id)).toContain(`dataObjectRef="Process_Bestellung__${item}"`);
      expect(extensionOf(whole(bpmnXml, 'dataObjectReference', id))).toContain(`<bg:data ref="${item}" />`);
    }
  });

  test('a nested reference points to the DataObject at process level', async () => {
    const { bpmnXml } = await run();
    const sub = element(bpmnXml, 'subProcess', 'sp');
    expect(sub).toContain('<bpmn:dataObjectReference id="buchen__d_bestellung"');
    expect(sub).not.toContain('<bpmn:dataObject ');
    expect(startTag(bpmnXml, 'dataObjectReference', 'buchen__d_bestellung')).toContain('dataObjectRef="Process_Bestellung__d_bestellung"');
    // the shared object sits in the process, after the subprocess
    expect(bpmnXml.indexOf('<bpmn:dataObject id="Process_Bestellung__d_bestellung"')).toBeGreaterThan(bpmnXml.indexOf('</bpmn:subProcess>'));
  });

  test('a store: one root DataStore before the collaboration and the process, dataStoreRef on the reference', async () => {
    const { bpmnXml } = await run();
    expect(count(bpmnXml, /<bpmn:dataStore id="d_register__store" name="Bestellregister" \/>/g)).toBe(1);
    expect(count(bpmnXml, /<bpmn:dataStore\b/g)).toBe(1);
    const at = bpmnXml.indexOf('<bpmn:dataStore ');
    expect(at).toBeLessThan(bpmnXml.indexOf('<bpmn:collaboration'));
    expect(at).toBeLessThan(bpmnXml.indexOf('<bpmn:process'));
    expect(bpmnXml.indexOf('<bpmn:resource')).toBeLessThan(at);
    const ref = whole(bpmnXml, 'dataStoreReference', 'pruefen__d_register');
    expect(ref).toContain('dataStoreRef="d_register__store"');
    expect(extensionOf(ref)).toContain('<bg:data ref="d_register" />');
  });

  test('pruefen holds the placeholder property, the input and the output association', async () => {
    const { bpmnXml } = await run();
    const step = element(bpmnXml, 'userTask', 'pruefen');
    expect(step).toContain('<bpmn:property id="pruefen__input" name="__targetRef_placeholder" />');
    expect(step).toMatch(/<bpmn:dataInputAssociation id="pruefen__d_bestellung__read">\s*<bpmn:sourceRef>pruefen__d_bestellung<\/bpmn:sourceRef>\s*<bpmn:targetRef>pruefen__input<\/bpmn:targetRef>\s*<\/bpmn:dataInputAssociation>/);
    expect(step).toMatch(/<bpmn:dataOutputAssociation id="pruefen__d_register__write">\s*<bpmn:targetRef>pruefen__d_register<\/bpmn:targetRef>\s*<\/bpmn:dataOutputAssociation>/);
    expect(bpmnXml).not.toMatch(/<bpmn:association id="[^"]*__(read|write)"/);
  });

  test('the property exists only on a step with a read; the counts', async () => {
    const { bpmnXml } = await run();
    expect(count(bpmnXml, /<bpmn:property\b/g)).toBe(2);
    expect(element(bpmnXml, 'userTask', 'buchen')).toContain('<bpmn:property id="buchen__input" name="__targetRef_placeholder" />');
    for (const id of ['rueck', 'zahlen']) expect(element(bpmnXml, 'userTask', id)).not.toContain('<bpmn:property');
    expect(count(bpmnXml, /<bpmn:dataInputAssociation\b/g)).toBe(2);
    expect(count(bpmnXml, /<bpmn:dataOutputAssociation\b/g)).toBe(3);
    expect(count(bpmnXml, /<bpmn:association\b/g)).toBe(1);
    expect(count(bpmnXml, /<bg:data\b/g)).toBe(REFS.length + 1);
  });

  test('a link of unrecorded access is a plain association without direction, at process level', async () => {
    const { bpmnXml } = await run();
    const link = startTag(bpmnXml, 'association', 'rueck__d_bestellung__link');
    expect(link).toBe('<bpmn:association id="rueck__d_bestellung__link" sourceRef="rueck__d_bestellung" targetRef="rueck" />');
    expect(element(bpmnXml, 'process', 'Process_Bestellung')).toContain(link);
  });

  test('every link has a BPMNEdge <id>_di on its own element, with at least two waypoints', async () => {
    const { bpmnXml } = await run();
    const ids = ['rueck__d_bestellung__link', 'pruefen__d_bestellung__read', 'pruefen__d_register__write',
      'zahlen__d_rechnungen__write', 'buchen__d_bestellung__read', 'buchen__d_rechnungen__write'];
    for (const id of ids) {
      const edge = bpmnXml.match(new RegExp(`<bpmndi:BPMNEdge id="${id}_di" bpmnElement="${id}">[\\s\\S]*?</bpmndi:BPMNEdge>`))?.[0];
      expect({ id, edge: !!edge }).toEqual({ id, edge: true });
      expect(count(edge, /<di:waypoint\b/g)).toBeGreaterThanOrEqual(2);
    }
    expect(bpmnXml).not.toContain('bpmnElement="undefined"');
  });
});

describe('format 2.1 data: a collaboration and a nested link of unrecorded access', () => {
  const CATALOG_C = {
    actors: [{ id: 'sb', name: 'Sachbearbeitung', kind: 'role' }, { id: 'lager', name: 'Lager', kind: 'role' }],
    data: [{ id: 'd_auftrag', name: 'Auftrag', kind: 'object' }, { id: 'd_reg', name: 'Bestellregister', kind: 'store' },
      { id: 'd_notiz', name: 'Notiz' }],
  };
  const D_SB = [{ type: 'D', actor: 'sb' }];
  const D_LAGER = [{ type: 'D', actor: 'lager' }];
  const TWO_POOLS = {
    $schemaVersion: '2.1',
    pools: [
      { id: 'P_Einkauf', name: 'Einkauf',
        nodes: [
          { id: 'e_s', type: 'startEvent', name: 'Bestellung eingegangen' },
          { id: 'e_t', type: 'userTask', name: 'Auftrag prüfen', assignments: D_SB,
            dataAccess: [{ data: 'd_auftrag', access: 'read' }, { data: 'd_reg', access: 'write' }, { data: 'd_notiz' }] },
          { id: 'e_e', type: 'endEvent', name: 'Auftrag geprüft' }],
        edges: [{ source: 'e_s', target: 'e_t' }, { source: 'e_t', target: 'e_e' }] },
      { id: 'P_Lager', name: 'Lager',
        nodes: [
          { id: 'l_s', type: 'startEvent', name: 'Auftrag eingegangen' },
          { id: 'l_t', type: 'userTask', name: 'Ware kommissionieren', assignments: D_LAGER,
            dataAccess: [{ data: 'd_auftrag', access: 'read' }, { data: 'd_reg', access: 'read' }, { data: 'd_auftrag', access: 'write' }] },
          { id: 'l_sp', type: 'subProcess', name: 'Ware verpacken', isExpanded: true, assignments: D_LAGER,
            nodes: [
              { id: 'l_sp_s', type: 'startEvent', name: 'Verpackung beginnt' },
              { id: 'l_pack', type: 'userTask', name: 'Paket packen', dataAccess: [{ data: 'd_auftrag' }, { data: 'd_reg', access: 'write' }] },
              { id: 'l_sp_e', type: 'endEvent', name: 'Paket gepackt' }],
            edges: [{ source: 'l_sp_s', target: 'l_pack' }, { source: 'l_pack', target: 'l_sp_e' }] },
          { id: 'l_e', type: 'endEvent', name: 'Ware versandt' }],
        edges: [{ source: 'l_s', target: 'l_t' }, { source: 'l_t', target: 'l_sp' }, { source: 'l_sp', target: 'l_e' }] },
    ],
    messageFlows: [{ id: 'mf1', source: 'e_t', target: 'l_s' }],
  };
  const generateC = async () => {
    const r = await runPipeline(copy(TWO_POOLS), { catalog: copy(CATALOG_C), view: loadNamedView('rollen') });
    expect(r.validation.errors).toEqual([]);
    expect(r.validation.xmlWarnings).toEqual([]);
    return r.bpmnXml;
  };
  const processOf = (xml, id) => element(xml, 'process', id);
  const edgeOf = (xml, id) => xml.match(new RegExp(`<bpmndi:BPMNEdge id="${id}_di" bpmnElement="([^"]*)"`))?.[1];

  test('two pools: each DataObject in its own process, one shared DataStore, each association in its own pool\'s step', async () => {
    const xml = await generateC();
    const einkauf = processOf(xml, 'P_Einkauf');
    const lager = processOf(xml, 'P_Lager');
    for (const [own, other, item] of [[einkauf, lager, 'P_Einkauf__d_auftrag'], [einkauf, lager, 'P_Einkauf__d_notiz'], [lager, einkauf, 'P_Lager__d_auftrag']]) {
      expect(count(xml, new RegExp(`<bpmn:dataObject id="${item}"`, 'g'))).toBe(1);
      expect(own).toContain(`<bpmn:dataObject id="${item}"`);
      expect(other).not.toContain(`id="${item}"`);
    }
    expect(lager).toContain('dataObjectRef="P_Lager__d_auftrag"');
    expect(lager).not.toContain('dataObjectRef="P_Einkauf__');
    expect(count(xml, /<bpmn:dataStore\b/g)).toBe(1);
    expect(xml.indexOf('<bpmn:dataStore id="d_reg__store"')).toBeLessThan(xml.indexOf('<bpmn:collaboration'));
    for (const [proc, ref] of [[einkauf, 'e_t__d_reg'], [lager, 'l_t__d_reg'], [lager, 'l_pack__d_reg']]) {
      expect(proc).toMatch(new RegExp(`<bpmn:dataStoreReference id="${ref}" name="Bestellregister" dataStoreRef="d_reg__store"`));
    }
    const steps = { e_t: element(einkauf, 'userTask', 'e_t'), l_t: element(lager, 'userTask', 'l_t'), l_pack: element(lager, 'userTask', 'l_pack') };
    const owned = { e_t__d_auftrag__read: 'e_t', e_t__d_reg__write: 'e_t', l_t__d_auftrag__read: 'l_t', l_t__d_reg__read: 'l_t',
      l_t__d_auftrag__write: 'l_t', l_pack__d_reg__write: 'l_pack' };
    for (const [id, step] of Object.entries(owned)) {
      expect(steps[step]).toContain(`id="${id}"`);
      for (const other of Object.keys(steps).filter((s) => s !== step)) expect(steps[other]).not.toContain(`id="${id}"`);
      expect(edgeOf(xml, id)).toBe(id);
    }
    expect(count(xml, /<bpmn:dataInputAssociation\b/g)).toBe(3);
    expect(count(xml, /<bpmn:dataOutputAssociation\b/g)).toBe(3);
    // links of unrecorded access: a top-level one in Einkauf, a nested one in Lager
    expect(einkauf).toContain('<bpmn:association id="e_t__d_notiz__link"');
    expect(lager).toContain('<bpmn:association id="l_pack__d_auftrag__link"');
    expect(edgeOf(xml, 'l_pack__d_auftrag__link')).toBe('l_pack__d_auftrag__link');
    expect(xml).not.toContain('bpmnElement="undefined"');
  });

  (xsd.available ? test : test.skip)('two pools: the output validates against BPMN20.xsd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'model-v2-xml-data-pools-'));
    try {
      const file = join(dir, 'pools.bpmn');
      writeFileSync(file, await generateC());
      execFileSync('xmllint', ['--noout', '--schema', join(xsdDir(), 'BPMN20.xsd'), file], { encoding: 'utf8', stdio: 'pipe' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a link of unrecorded access between nested ends is a child of the process, with a real BPMNEdge', async () => {
    const m = dataModel();
    const buchen = m.nodes.find((n) => n.id === 'sp').nodes.find((n) => n.id === 'buchen');
    buchen.dataAccess.push({ data: 'd_register' });
    const r = await runPipeline(m, { catalog: copy(DATA_CATALOG), view: loadNamedView('rollen') });
    expect(r.validation.errors).toEqual([]);
    expect(r.validation.xmlWarnings).toEqual([]);
    const xml = r.bpmnXml;
    const link = '<bpmn:association id="buchen__d_register__link" sourceRef="buchen__d_register" targetRef="buchen" />';
    expect(element(xml, 'process', 'Process_Bestellung')).toContain(link);
    expect(element(xml, 'subProcess', 'sp')).not.toContain(link);
    expect(element(xml, 'subProcess', 'sp')).toContain('<bpmn:dataStoreReference id="buchen__d_register"');
    expect(edgeOf(xml, 'buchen__d_register__link')).toBe('buchen__d_register__link');
    expect(xml).not.toContain('bpmnElement="undefined"');
  });
});
