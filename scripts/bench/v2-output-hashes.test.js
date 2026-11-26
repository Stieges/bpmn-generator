/**
 * The two format 2.0 golden diagrams (schaden × rollen, schaden × einheiten): each pair equals its
 * golden files byte for byte and its entry in tests/bench/v2-output-hashes.json. See
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

const CATALOG_HASH = 'sha256:1839c85404873913d420764884aa77ed37f54a3341df18b7e641c0f85f70c9a4';

describe('format 2.0 golden diagrams', () => {
  test('exactly the two pairs of design 9', () => {
    expect(V2_PAIRS).toEqual([['schaden.json', 'rollen'], ['schaden.json', 'einheiten']]);
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
    expect(r.bpmnXml).toContain(`bg:catalog="${CATALOG_HASH}"`);
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

  test('every pair hashes to the committed snapshot', async () => {
    const expected = JSON.parse(readFileSync(V2_SNAPSHOT_PATH, 'utf8'));
    expect(await computeV2Hashes()).toEqual(expected);
  }, 60000);
});
