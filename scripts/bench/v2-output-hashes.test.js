/**
 * The three format 2.0 golden diagrams (schaden × rollen, schaden × einheiten, organigramm ×
 * organigramm): each pair equals its golden files byte for byte and its entry in
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

/** The fingerprint of each pair's catalogue: schaden-catalog.json, organigramm-catalog.json. */
const CATALOG_HASH = {
  'schaden.json': 'sha256:1839c85404873913d420764884aa77ed37f54a3341df18b7e641c0f85f70c9a4',
  'organigramm.json': 'sha256:0261e68c2a37cc3d7a5eef8a2ca8d10314ec949abcb0af30514e1fe04b126842',
};

describe('format 2.0 golden diagrams', () => {
  test('exactly three pairs: the two flat views of design 9 and the nested organigram view', () => {
    expect(V2_PAIRS).toEqual([['schaden.json', 'rollen'], ['schaden.json', 'einheiten'], ['organigramm.json', 'organigramm']]);
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

  test.each(V2_PAIRS)('%s × %s: no hints, view, catalogue fingerprint and the information assignment', (name, viewName) => {
    const r = generated(name, viewName);
    expect(r.validation.hints).toEqual([]);
    expect(r.bpmnXml).toContain(`bg:view="${viewName}"`);
    expect(r.bpmnXml).toContain(`bg:catalog="${CATALOG_HASH[name]}"`);
    expect(r.bpmnXml).toContain('<bg:assignment type="I" actor="sb_schaden" />');
  });

  test.each(V2_PAIRS)('%s × %s: no performer, resource or system in the golden', (name, viewName) => {
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

  test('organigramm: the lanes nest along partOf, Leistung holds its own steps in the first child lane', () => {
    const xml = golden('organigramm.json', 'organigramm', 'bpmn');
    // the parent lane and its own lane both carry the actor of the unit
    expect(xml.match(/<bg:derived by="unit" actor="bereich_leistung">lane<\/bg:derived>/g)).toHaveLength(2);
    expect(xml.match(/<bpmn:childLaneSet\b/g)).toHaveLength(1);
    const lane = (id) => xml.match(new RegExp(`<bpmn:lane id="${id.replace(/\./g, '\\.')}"[\\s\\S]*?</bpmn:lane>`))?.[0];
    const own = lane('L.Process_Schaden.bereich_leistung._own');
    expect(own).toContain('name="Leistung"');
    expect(own).toContain('<bpmn:flowNodeRef>regr</bpmn:flowNodeRef>');
    for (const id of ['start', 'pruefen', 'gw']) expect(lane('L.Process_Schaden.abt_schaden')).toContain(`<bpmn:flowNodeRef>${id}</bpmn:flowNodeRef>`);
    for (const id of ['zahlen', 'end']) expect(lane('L.Process_Schaden.abt_finanzen')).toContain(`<bpmn:flowNodeRef>${id}</bpmn:flowNodeRef>`);
    // the parent lane lists no node of its own: every flowNodeRef in it is inside the childLaneSet
    const parent = xml.slice(xml.indexOf('<bpmn:lane id="L.Process_Schaden.bereich_leistung"'), xml.indexOf('<bpmn:childLaneSet'));
    expect(parent).not.toContain('<bpmn:flowNodeRef>');
    for (const id of ['L.Process_Schaden.bereich_leistung', 'L.Process_Schaden.bereich_leistung._own', 'L.Process_Schaden.abt_schaden', 'L.Process_Schaden.abt_finanzen']) {
      expect(xml).toContain(`bpmnElement="${id}"`);
    }
  });

  test('every pair hashes to the committed snapshot', async () => {
    const expected = JSON.parse(readFileSync(V2_SNAPSHOT_PATH, 'utf8'));
    expect(await computeV2Hashes()).toEqual(expected);
  }, 60000);
});
