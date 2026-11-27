/**
 * The four golden diagrams (format 2.0: bestellung × rollen, bestellung × einheiten, organigramm ×
 * organigramm; format 2.1: bestellung-systeme × systeme): each pair equals its golden files byte for byte and its entry in
 * tests/bench/v2-output-hashes.json. See
 * v2-output-hashes.mjs; regenerate with `node bench/v2-output-hashes.mjs` only when the change is intended.
 */
import { describe, test, expect, beforeAll } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPipeline } from '../bpmn/pipeline.js';
import { resolveFields, formLanes } from '../bpmn/model-v2.js';
import { bpmnToLogicCore } from '../bpmn/import.js';
import { loadCatalog } from '../shared/catalog.js';
import { loadNamedView } from '../shared/view.js';
import { V2_PAIRS, V2_SNAPSHOT_PATH, FIXTURES_V2_DIR, goldenBase, generateV2, computeV2Hashes } from './v2-output-hashes.mjs';

/** The fingerprint of each pair's catalogue: bestellung-catalog.json, organigramm-catalog.json. */
const CATALOG_HASH = {
  'bestellung.json': 'sha256:bbe131aa583483354fce5fede3ed1d170ce97b1fa90a1341b5a6af5af6d77273',
  'organigramm.json': 'sha256:19836e2ecd105136b1682f33b53a4ebd32a8a5039625fc09dde25578ae38c00b',
  'bestellung-systeme.json': 'sha256:c5ac5f1c62842fdd693bb58878cffa81b217335d2c9f16500b8ce7d3fb3a5cdb',
};

describe('format 2.x golden diagrams', () => {
  test('exactly four pairs: the two flat views of design 9, the nested organigram view and the system view', () => {
    expect(V2_PAIRS).toEqual([['bestellung.json', 'rollen'], ['bestellung.json', 'einheiten'], ['organigramm.json', 'organigramm'], ['bestellung-systeme.json', 'systeme']]);
  });

  // Each pair is generated once; generateV2 reads the fixture afresh on every call, so no run sees a model another run changed.
  const results = new Map();
  beforeAll(async () => {
    for (const [name, viewName] of V2_PAIRS) results.set(`${name} × ${viewName}`, await generateV2(name, viewName));
  }, 120000);
  const generated = (name, viewName) => results.get(`${name} × ${viewName}`);
  const golden = (name, viewName, ext) => readFileSync(`${join(FIXTURES_V2_DIR, goldenBase(name, viewName))}.expected.${ext}`, 'utf8');

  test.each(V2_PAIRS)('%s × %s equals its golden files byte for byte', (name, viewName) => {
    const r = generated(name, viewName);
    expect(r.bpmnXml).toBe(golden(name, viewName, 'bpmn'));
    expect(r.svg).toBe(golden(name, viewName, 'svg'));
  });

  test.each(V2_PAIRS)('%s × %s: no hints but H18, view, catalogue fingerprint and the information assignment', (name, viewName) => {
    const r = generated(name, viewName);
    expect(r.validation.hints.filter((h) => h.code !== 'H18')).toEqual([]);
    expect(r.bpmnXml).toContain(`bg:view="${viewName}"`);
    expect(r.bpmnXml).toContain(`bg:catalog="${CATALOG_HASH[name]}"`);
    expect(r.bpmnXml).toContain('<bg:assignment type="I" actor="sb_einkauf" />');
  });

  const OLD_PAIRS = [['bestellung.json', 'rollen'], ['bestellung.json', 'einheiten'], ['organigramm.json', 'organigramm']];
  test.each(OLD_PAIRS)('%s × %s: no performer, resource or system in the golden', (name, viewName) => {
    const xml = golden(name, viewName, 'bpmn');
    expect(xml).not.toMatch(/<bpmn:(performer|humanPerformer|resource)\b/);
    expect(xml).not.toContain('<bg:system');
  });

  test.each(V2_PAIRS)('%s × %s: the import of the golden equals the import of the model generated without the private fields', async (name, viewName) => {
    const model = JSON.parse(readFileSync(join(FIXTURES_V2_DIR, name), 'utf8'));
    const catalog = loadCatalog(join(FIXTURES_V2_DIR, model.catalog));
    const fields = resolveFields(model, { catalog, viewName });
    const { lc } = formLanes(fields.lc, fields.resolved, { lanes: loadNamedView(viewName).lanes });
    const bare = JSON.parse(JSON.stringify(lc, (k, v) => (k.startsWith('_') ? undefined : v)));
    const { bpmnXml } = await runPipeline(bare);
    expect(await bpmnToLogicCore(golden(name, viewName, 'bpmn'))).toEqual(await bpmnToLogicCore(bpmnXml));
  }, 60000);

  test('bestellung-systeme × systeme: three system references, two system lanes, nothing else', () => {
    const xml = golden('bestellung-systeme.json', 'systeme', 'bpmn');
    expect(xml).not.toMatch(/<bpmn:(performer|humanPerformer|resource)\b/);
    expect(xml).toContain('bg:modelVersion="2.1"');
    expect(xml).toContain('bg:view="systeme"');
    expect(xml.match(/<bg:system ref="sys_ordersystem">Bestellsystem<\/bg:system>/g)).toHaveLength(2);
    expect(xml.match(/<bg:system ref="sys_lieferportal">Lieferportal<\/bg:system>/g)).toHaveLength(1);
    expect(xml.match(/<bg:system\b/g)).toHaveLength(3);
    expect(xml).not.toContain('_systemUnknown');
    expect(xml).not.toContain('nicht erhoben');
    const lane = (id) => xml.match(new RegExp(`<bpmn:lane id="${id.replace(/\./g, '\\.')}"[\\s\\S]*?</bpmn:lane>`))?.[0];
    const sys = lane('L.Process_Bestellung.sys_ordersystem');
    expect(sys).toContain('name="Bestellsystem"');
    for (const id of ['start', 'pruefen', 'gw', 'zahlen', 'end']) expect(sys).toContain(`<bpmn:flowNodeRef>${id}</bpmn:flowNodeRef>`);
    const reg = lane('L.Process_Bestellung.sys_lieferportal');
    expect(reg).toContain('name="Lieferportal"');
    expect(reg.match(/<bpmn:flowNodeRef>/g)).toHaveLength(1);
    expect(reg).toContain('<bpmn:flowNodeRef>rueck</bpmn:flowNodeRef>');
    expect(xml.match(/<bpmn:lane\b/g)).toHaveLength(2);
  });

  test('bestellung-systeme × rollen draws the diagram of bestellung × rollen; the XML differs only by the system lines, the version and the catalogue', async () => {
    const r = await generateV2('bestellung-systeme.json', 'rollen');
    expect(r.svg).toBe(golden('bestellung.json', 'rollen', 'svg'));
    const base = golden('bestellung.json', 'rollen', 'bpmn');
    const stripped = r.bpmnXml.replace(/^[ \t]*<bg:system [^>]*>[^<]*<\/bg:system>\r?\n/gm, '')
      .replace('bg:modelVersion="2.1"', 'bg:modelVersion="2.0"')
      .replace(/bg:catalog="[^"]*"/, `bg:catalog="${CATALOG_HASH['bestellung.json']}"`);
    expect(r.bpmnXml.match(/<bg:system\b/g)).toHaveLength(3);
    expect(stripped).toBe(base);
  }, 60000);

  test('organigramm: the lanes nest along partOf, Beschaffung holds its own steps in the first child lane', () => {
    const xml = golden('organigramm.json', 'organigramm', 'bpmn');
    // the parent lane and its own lane both carry the actor of the unit
    expect(xml.match(/<bg:derived by="unit" actor="bereich_beschaffung">lane<\/bg:derived>/g)).toHaveLength(2);
    expect(xml.match(/<bpmn:childLaneSet\b/g)).toHaveLength(1);
    const lane = (id) => xml.match(new RegExp(`<bpmn:lane id="${id.replace(/\./g, '\\.')}"[\\s\\S]*?</bpmn:lane>`))?.[0];
    const own = lane('L.Process_Bestellung.bereich_beschaffung._own');
    expect(own).toContain('name="Beschaffung"');
    expect(own).toContain('<bpmn:flowNodeRef>rueck</bpmn:flowNodeRef>');
    for (const id of ['start', 'pruefen', 'gw']) expect(lane('L.Process_Bestellung.abt_einkauf')).toContain(`<bpmn:flowNodeRef>${id}</bpmn:flowNodeRef>`);
    for (const id of ['zahlen', 'end']) expect(lane('L.Process_Bestellung.abt_buchhaltung')).toContain(`<bpmn:flowNodeRef>${id}</bpmn:flowNodeRef>`);
    // the parent lane lists no node of its own: every flowNodeRef in it is inside the childLaneSet
    const parent = xml.slice(xml.indexOf('<bpmn:lane id="L.Process_Bestellung.bereich_beschaffung"'), xml.indexOf('<bpmn:childLaneSet'));
    expect(parent).not.toContain('<bpmn:flowNodeRef>');
    for (const id of ['L.Process_Bestellung.bereich_beschaffung', 'L.Process_Bestellung.bereich_beschaffung._own', 'L.Process_Bestellung.abt_einkauf', 'L.Process_Bestellung.abt_buchhaltung']) {
      expect(xml).toContain(`bpmnElement="${id}"`);
    }
  });

  test('every pair hashes to the committed snapshot', async () => {
    const expected = JSON.parse(readFileSync(V2_SNAPSHOT_PATH, 'utf8'));
    expect(await computeV2Hashes()).toEqual(expected);
  }, 60000);
});
