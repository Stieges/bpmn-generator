/**
 * runPipeline reads format 2.0 (design 5.3, 5.6, 6, 7.1, 7.3, 7.4): the view resolves first, then
 * `resolveFields` checks the model against its catalogue, the model is validated once (check M:
 * one verdict per model, whatever the view), `formLanes` forms the view's lanes and the view's
 * derivations run on the formed model. A 1.x model under a view with `lanes` is a view error.
 */
import { describe, test, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './pipeline.js';
import { loadNamedView, ViewRejectedError } from '../shared/view.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const copy = (v) => JSON.parse(JSON.stringify(v));
const simpleApproval = () => JSON.parse(readFileSync(resolve(root, 'tests/fixtures/simple-approval.json'), 'utf8'));
const LANES_ON_1X = 'view "rollen" forms lanes from assignments; this model (format 1.x) carries its own lanes';

// The pair of design 5.6.
const CATALOG = {
  scheme: 'demi',
  actors: [
    { id: 'abt_schaden', name: 'Schadenabteilung', kind: 'unit' },
    { id: 'abt_finanzen', name: 'Finanzen', kind: 'unit' },
    { id: 'sb_schaden', name: 'Sachbearbeitung Schaden', kind: 'role', unit: 'abt_schaden' },
    { id: 'regress', name: 'Regressspezialist', kind: 'role', unit: 'abt_schaden' },
    { id: 'zahlung', name: 'Zahlungsverkehr', kind: 'role', unit: 'abt_finanzen' },
  ],
};
const MODEL = {
  $schemaVersion: '2.0', catalog: '../bpmn-catalog.json', id: 'Process_Schaden', name: 'Schaden regulieren',
  nodes: [
    { id: 'start', type: 'startEvent', name: 'Schaden gemeldet' },
    { id: 'gw', type: 'exclusiveGateway', name: 'Regress möglich?' },
    { id: 'pruefen', type: 'userTask', name: 'Schaden prüfen', assignments: [{ type: 'D', actor: 'sb_schaden' }] },
    { id: 'regr', type: 'userTask', name: 'Regress prüfen',
      assignments: [{ type: 'D', actor: 'regress' }, { type: 'I', actor: 'sb_schaden' }] },
    { id: 'zahlen', type: 'userTask', name: 'Zahlung anweisen', assignments: [{ type: 'D', actor: 'zahlung' }] },
    { id: 'end', type: 'endEvent', name: 'Schaden reguliert' },
  ],
  edges: [
    { source: 'start', target: 'pruefen' }, { source: 'pruefen', target: 'gw' },
    { source: 'gw', target: 'regr', label: 'ja' }, { source: 'gw', target: 'zahlen', label: 'nein' },
    { source: 'regr', target: 'zahlen' }, { source: 'zahlen', target: 'end' },
  ],
};
const L = (actor) => `L.Process_Schaden.${actor}`;

/** Lane id → its flowNodeRef ids, read from the XML. */
function laneMembers(xml) {
  const out = {};
  for (const m of xml.matchAll(/<bpmn:lane id="([^"]+)"[^>]*>([\s\S]*?)<\/bpmn:lane>/g)) {
    out[m[1]] = [...m[2].matchAll(/<bpmn:flowNodeRef>([^<]+)<\/bpmn:flowNodeRef>/g)].map((r) => r[1]).sort();
  }
  return out;
}
const verdict = ({ validation: { errors, warnings } }) => ({ errors, warnings });
const run = (opts = {}, model = MODEL) => runPipeline(copy(model), { catalog: copy(CATALOG), ...opts });

describe('runPipeline — format 2.0, the two views of design 5.6', () => {
  const ROLLEN = {
    [L('sb_schaden')]: ['gw', 'pruefen', 'start'],
    [L('regress')]: ['regr'],
    [L('zahlung')]: ['end', 'zahlen'],
  };
  const EINHEITEN = {
    [L('abt_schaden')]: ['gw', 'pruefen', 'regr', 'start'],
    [L('abt_finanzen')]: ['end', 'zahlen'],
  };

  test.each([['rollen', ROLLEN], ['einheiten', EINHEITEN]])('view %s forms the lanes of design 5.6', async (name, expected) => {
    const result = await run({ view: loadNamedView(name) });
    expect(result.validation.errors).toEqual([]);
    expect(Object.keys(result.coordMap.laneCoords).sort()).toEqual(Object.keys(expected).sort());
    expect(laneMembers(result.bpmnXml)).toEqual(expected);
    expect(result.bpmnXml).toContain(`bg:view="${name}"`);
    expect(result.validation.hints).toEqual([]);
  });

  test('without a view a 2.0 model gets role lanes', async () => {
    const result = await run();
    expect(Object.keys(result.coordMap.laneCoords).sort()).toEqual(Object.keys(ROLLEN).sort());
    expect(laneMembers(result.bpmnXml)).toEqual(ROLLEN);
    expect(result.bpmnXml).toContain('bg:view="default"');
  });

  test('check M: one verdict per model, under both views and under none', async () => {
    const none = verdict(await run());
    expect(verdict(await run({ view: loadNamedView('rollen') }))).toEqual(none);
    expect(verdict(await run({ view: loadNamedView('einheiten') }))).toEqual(none);
  });

  test('explicit-joins puts the derived join into the lane of its target', async () => {
    const result = await run({ view: loadNamedView('explicit-joins') });
    expect(result.validation.hints).toEqual([expect.objectContaining({ code: 'H01', elements: ['gw_join_zahlen', 'zahlen', expect.any(String)] })]);
    expect(laneMembers(result.bpmnXml)[L('zahlung')]).toEqual(['end', 'gw_join_zahlen', 'zahlen']);
  });

  test('validation.hints: the lane hints first, then H01', async () => {
    const model = copy(MODEL);
    delete model.nodes.find((n) => n.id === 'regr').assignments;
    const result = await run({ view: loadNamedView('explicit-joins') }, model);
    expect(result.validation.errors).toEqual([]);
    expect(result.validation.hints.map((h) => h.code)).toEqual(['H02', 'H01']);
  });

  test('the caller\'s model and catalogue are not changed', async () => {
    const model = copy(MODEL);
    const catalog = copy(CATALOG);
    await runPipeline(model, { catalog, view: loadNamedView('einheiten') });
    expect(model).toEqual(MODEL);
    expect(catalog).toEqual(CATALOG);
  });
});

describe('runPipeline — format 2.0 early returns', () => {
  const early = (errors) => ({
    bpmnXml: null, svg: null, coordMap: null, diagnostics: null, netDiagnostics: null,
    validation: { errors, warnings: [], advisories: [], metrics: {}, hints: [] },
  });

  test.each(['optimize', 'soll'])('mode %s is refused', async (mode) => {
    expect(await run({ mode })).toEqual(early([`[format 2.0] mode "${mode}" is not available for format 2.0 models yet`]));
  });

  test('a C01 finding stops the run with no artefact and no hints', async () => {
    const model = copy(MODEL);
    model.nodes.find((n) => n.id === 'zahlen').assignments[0].actor = 'kasse';
    const result = await run({ view: loadNamedView('rollen') }, model);
    expect(result).toEqual(early([expect.stringMatching(/^\[C01\] node "zahlen": actor "kasse"/)]));
  });

  test('a model naming its catalogue as a path without a catalogue object is an error', async () => {
    const result = await runPipeline(copy(MODEL));
    expect(result.bpmnXml).toBeNull();
    expect(result.validation.errors).toEqual([expect.stringMatching(/^\[catalog\] the model names catalogue/)]);
  });
});

describe('runPipeline — the catalog option', () => {
  test('a string is refused: the library takes only a catalogue object', async () => {
    await expect(runPipeline(copy(MODEL), { catalog: '../bpmn-catalog.json' }))
      .rejects.toThrow(new TypeError('catalog must be a catalogue object; read a file with loadCatalog'));
  });

  test('a catalogue with a 1.x model is refused', async () => {
    await expect(runPipeline(simpleApproval(), { catalog: copy(CATALOG) }))
      .rejects.toThrow(new TypeError('catalog applies to format 2.0 models only'));
  });
});

describe('a 1.x model under a view with lanes is a view error (design 6)', () => {
  test('runPipeline rejects with ViewRejectedError', async () => {
    const p = runPipeline(simpleApproval(), { view: loadNamedView('rollen') });
    await expect(p).rejects.toBeInstanceOf(ViewRejectedError);
    await expect(runPipeline(simpleApproval(), { view: loadNamedView('rollen') })).rejects.toThrow(LANES_ON_1X);
  });

  test('the CLI exits 1 and prints the message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v2-cli-'));
    try {
      let err;
      try {
        execFileSync(process.execPath, [resolve(here, 'pipeline.js'), resolve(root, 'tests/fixtures/simple-approval.json'), join(dir, 'out'), '--view=rollen'], { stdio: 'pipe' });
      } catch (e) { err = e; }
      expect(err?.status).toBe(1);
      expect(err.stderr.toString()).toContain(`✗ ${LANES_ON_1X}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('response contract', () => {
  test('the hint code pattern in api-schema.json accepts H01–H09', () => {
    const api = JSON.parse(readFileSync(resolve(root, 'references/api-schema.json'), 'utf8'));
    const find = (v) => {
      if (v && typeof v === 'object') {
        if (v.hints?.items?.properties?.code?.pattern) return v.hints.items.properties.code.pattern;
        for (const x of Object.values(v)) { const r = find(x); if (r) return r; }
      }
      return undefined;
    };
    const re = new RegExp(find(api));
    for (const code of ['H01', 'H02', 'H06', 'H08']) expect(re.test(code)).toBe(true);
    expect(re.test('H10')).toBe(false);
  });
});
