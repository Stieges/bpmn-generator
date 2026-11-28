/**
 * The five golden diagrams (format 2.0: bestellung × rollen, bestellung × einheiten, organigramm ×
 * organigramm; format 2.1: bestellung-systeme × systeme, bestellung-daten × rollen): each pair equals its golden files byte for byte and its entry in
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

/** The fingerprint of each pair's catalogue: bestellung-catalog.json, organigramm-catalog.json, bestellung-systeme-catalog.json, bestellung-daten-catalog.json. */
const CATALOG_HASH = {
  'bestellung.json': 'sha256:bbe131aa583483354fce5fede3ed1d170ce97b1fa90a1341b5a6af5af6d77273',
  'organigramm.json': 'sha256:19836e2ecd105136b1682f33b53a4ebd32a8a5039625fc09dde25578ae38c00b',
  'bestellung-systeme.json': 'sha256:c5ac5f1c62842fdd693bb58878cffa81b217335d2c9f16500b8ce7d3fb3a5cdb',
  'bestellung-daten.json': 'sha256:2f48cfeb7c399a484050ba01813ec7c945ba239a28a71db702d15895779067c2',
};

describe('format 2.x golden diagrams', () => {
  test('exactly five pairs: the two flat views of design 9, the nested organigram view, the system view and the data references', () => {
    expect(V2_PAIRS).toEqual([['bestellung.json', 'rollen'], ['bestellung.json', 'einheiten'], ['organigramm.json', 'organigramm'], ['bestellung-systeme.json', 'systeme'], ['bestellung-daten.json', 'rollen']]);
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
    // XML document order is the topological order, not the model order: compare the associations by id.
    const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const sorted = (m) => (m.associations ? { ...m, associations: [...m.associations].sort(byId) } : m);
    expect(sorted(await bpmnToLogicCore(golden(name, viewName, 'bpmn')))).toEqual(sorted(await bpmnToLogicCore(bpmnXml)));
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

  test('bestellung-daten × rollen: five references, two data objects, one data store, the lanes of bestellung × rollen', () => {
    const xml = golden('bestellung-daten.json', 'rollen', 'bpmn');
    const count = (re) => (xml.match(re) || []).length;
    for (const id of ['pruefen__d_bestellung', 'pruefen__d_register', 'rueck__d_bestellung', 'zahlen__d_bestellung', 'zahlen__d_rechnungen']) {
      expect(xml).toContain(`bpmnElement="${id}"`);
    }
    expect(count(/<bpmn:dataObjectReference\b/g)).toBe(4);
    expect(count(/<bpmn:dataStoreReference\b/g)).toBe(1);
    expect(count(/<bpmn:dataObject\b/g)).toBe(2);
    expect(count(/<bpmn:dataStore\b/g)).toBe(1);
    expect(count(/<bpmn:dataInputAssociation\b/g)).toBe(3);
    expect(count(/<bpmn:dataOutputAssociation\b/g)).toBe(2);
    expect(count(/<bpmn:association\b/g)).toBe(1);
    expect(count(/<bpmn:property\b/g)).toBe(2);
    expect(xml).toContain('bg:modelVersion="2.1"');
    const lanes = (x) => x.match(/<bpmn:laneSet[\s\S]*?<\/bpmn:laneSet>/)[0];
    expect(lanes(xml)).toBe(lanes(golden('bestellung.json', 'rollen', 'bpmn')));
  });

  test('bestellung-daten × rollen: each reference lies inside the lane band of its step', () => {
    const xml = golden('bestellung-daten.json', 'rollen', 'bpmn');
    const bounds = (id) => {
      const m = xml.match(new RegExp(`<bpmndi:BPMNShape[^>]*bpmnElement="${id.replace(/\./g, '\\.')}"[^>]*>\\s*<dc:Bounds x="([\\d.-]+)" y="([\\d.-]+)" width="([\\d.-]+)" height="([\\d.-]+)"`));
      expect(m).not.toBeNull();
      return { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
    };
    const laneOf = { pruefen: 'sb_einkauf', rueck: 'leitung', zahlen: 'zahlung' };
    for (const ref of ['pruefen__d_bestellung', 'pruefen__d_register', 'rueck__d_bestellung', 'zahlen__d_bestellung', 'zahlen__d_rechnungen']) {
      const r = bounds(ref);
      const l = bounds(`L.Process_Bestellung.${laneOf[ref.split('__')[0]]}`);
      expect(r.y).toBeGreaterThanOrEqual(l.y);
      expect(r.y + r.h).toBeLessThanOrEqual(l.y + l.h);
      expect(r.x).toBeGreaterThanOrEqual(l.x);
      expect(r.x + r.w).toBeLessThanOrEqual(l.x + l.w);
      const lm = xml.match(new RegExp(`bpmnElement="${ref}">\\s*<dc:Bounds[^>]*/>\\s*<bpmndi:BPMNLabel>\\s*<dc:Bounds x="([\\d.-]+)" y="([\\d.-]+)" width="([\\d.-]+)" height="([\\d.-]+)"`));
      expect(lm).not.toBeNull();
      const [lx, ly, lw, lh] = lm.slice(1).map(Number);
      expect(ly).toBeGreaterThanOrEqual(l.y);
      expect(ly + lh).toBeLessThanOrEqual(l.y + l.h);
      expect(lx).toBeGreaterThanOrEqual(l.x);
      expect(lx + lw).toBeLessThanOrEqual(l.x + l.w);
    }
  });

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
