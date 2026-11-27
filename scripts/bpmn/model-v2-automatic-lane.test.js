/**
 * The automatic lane (view option lanes.automatic "lane") on a reproduction and on the shipped
 * fixtures: the lane tables in three views, switch on and off; byte-equality where nothing is
 * automatic without performer; the round trip through both importers; the CLI; the shipped views.
 */
import { describe, test, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './pipeline.js';
import { bpmnToLogicCore, bpmnToLogicCoreLegacy } from './import.js';
import { validateLogicCoreSchema } from './schema-gate.js';
import { loadCatalog } from '../shared/catalog.js';
import { loadNamedView } from '../shared/view.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const scripts = resolve(root, 'scripts');
const fx = (name) => resolve(root, 'tests/fixtures-v2', name);
const model = (name) => JSON.parse(readFileSync(fx(name), 'utf8'));
const catalog = (name) => loadCatalog(fx(name));
const copy = (v) => JSON.parse(JSON.stringify(v));
const CAT = 'automatic-steps-catalog.json';

/** [[laneId, name, [flowNodeRef…]], …] in XML order. */
function laneTable(xml) {
  return [...xml.matchAll(/<bpmn:lane id="([^"]+)" name="([^"]*)"[^>]*>([\s\S]*?)<\/bpmn:lane>/g)]
    .map((m) => [m[1], m[2], [...m[3].matchAll(/<bpmn:flowNodeRef>([^<]+)<\/bpmn:flowNodeRef>/g)].map((r) => r[1])]);
}

const VIEWS = {
  role: { off: 'role', on: { by: 'role', automatic: 'lane' }, ids: { first: 'clerk', second: 'teamlead' }, names: ['Case worker', 'Team lead'], by: 'role' },
  unit: { off: 'unit', on: { by: 'unit', automatic: 'lane' }, ids: { first: 'dept_case', second: 'mgmt' }, names: ['Order desk', 'Team management'], by: 'unit' },
  organigram: { off: { by: 'unit', nested: true }, on: { by: 'unit', nested: true, automatic: 'lane' }, ids: { first: 'dept_case', second: 'mgmt' }, names: ['Order desk', 'Team management'], by: 'unit' },
};
const view = (lanes) => ({ view: 'automatik', version: '1.0', lanes });
const run = (m, cat, lanes) => runPipeline(copy(m), { catalog: copy(cat), view: view(lanes) });
const h19 = (id, name, proc) => ({
  code: 'H19', message: `Automatic step "${name}" (${id}) has no performer: lane "(automatisch)".`, elements: [id, `L.${proc}._automatic`],
});
const NAMES = { register: 'Register order', send: 'Send confirmation' };

describe('the reproduction: lane tables in three views, switch off and on', () => {
  const FIXTURES = {
    'automatic-steps.json': {
      proc: 'Process_Order',
      off: { first: ['start', 'register', 'check', 'file', 'end'], second: ['approve', 'send'] },
      on: { first: ['start', 'check', 'file', 'end'], second: ['approve'] },
    },
    'automatic-steps-short.json': {
      proc: 'Process_Order2',
      off: { first: ['start', 'register', 'check'], second: ['approve', 'send', 'end'] },
      on: { first: ['start', 'check'], second: ['approve', 'end'] },
    },
  };
  for (const [file, spec] of Object.entries(FIXTURES)) {
    for (const [vname, v] of Object.entries(VIEWS)) {
      const L = (id) => `L.${spec.proc}.${id}`;
      test(`${file} x ${vname}, switch off: two lanes, two H03 with the pointer`, async () => {
        const r = await run(model(file), catalog(CAT), v.off);
        expect(r.validation.errors).toEqual([]);
        expect(r.validation.warnings).toEqual([]);
        expect(laneTable(r.bpmnXml)).toEqual([
          [L(v.ids.first), v.names[0], spec.off.first],
          [L(v.ids.second), v.names[1], spec.off.second],
        ]);
        const hints = r.validation.hints.filter((h) => h.code !== 'H18');
        expect(hints.map((h) => h.code)).toEqual(['H03', 'H03']);
        expect(hints.map((h) => h.elements)).toEqual([
          ['register', L(spec.off.first.includes('register') ? v.ids.first : v.ids.second)],
          ['send', L(spec.off.first.includes('send') ? v.ids.first : v.ids.second)],
        ]);
        for (const h of hints) expect(h.message).toMatch(/ Set lanes\.automatic to "lane" for a lane of its own\.$/);
        expect(r.bpmnXml).not.toContain('_automatic');
      });

      test(`${file} x ${vname}, switch on: the lane (automatisch) sits between the two`, async () => {
        const r = await run(model(file), catalog(CAT), v.on);
        expect(r.validation.errors).toEqual([]);
        expect(r.validation.warnings).toEqual([]);
        expect(laneTable(r.bpmnXml)).toEqual([
          [L(v.ids.first), v.names[0], spec.on.first],
          [`L.${spec.proc}._automatic`, '(automatisch)', ['register', 'send']],
          [L(v.ids.second), v.names[1], spec.on.second],
        ]);
        expect(r.validation.hints.filter((h) => h.code !== 'H18')).toEqual([
          h19('register', NAMES.register, spec.proc), h19('send', NAMES.send, spec.proc),
        ]);
        expect(r.bpmnXml).toMatch(new RegExp(`<bg:derived by="${v.by}" actor="_automatic">lane</bg:derived>`));
        expect(r.svg).toContain('(automatisch)');
      });
    }
  }
});

describe('with the switch on or off, nothing else changes', () => {
  const CASES = [
    ['schaden.json', 'schaden-catalog.json'], ['organigramm.json', 'organigramm-catalog.json'],
    ['message-hub.json', 'message-hub-catalog.json'], ['schaden-systeme.json', 'schaden-systeme-catalog.json'],
  ];
  const ON = (lanes) => (typeof lanes === 'string' ? { by: lanes, automatic: 'lane' } : { ...lanes, automatic: 'lane' });
  for (const [file, cat] of CASES) {
    for (const [vname, v] of Object.entries(VIEWS)) {
      test(`${file} x ${vname}: XML, SVG and hints are equal`, async () => {
        const off = await run(model(file), catalog(cat), v.off);
        const on = await run(model(file), catalog(cat), ON(v.off));
        expect(off.bpmnXml).toBeTruthy();
        expect(on.bpmnXml).toBe(off.bpmnXml);
        expect(on.svg).toBe(off.svg);
        expect(on.validation.hints).toEqual(off.validation.hints);
      });
    }
  }

  test('positive control: automatic-steps.json differs between off and on', async () => {
    const off = await run(model('automatic-steps.json'), catalog(CAT), 'role');
    const on = await run(model('automatic-steps.json'), catalog(CAT), ON('role'));
    expect(on.bpmnXml).not.toBe(off.bpmnXml);
  });

  test('automatic: "neighbour" gives the XML of the plain string view', async () => {
    const plain = await run(model('automatic-steps.json'), catalog(CAT), 'role');
    const neighbour = await run(model('automatic-steps.json'), catalog(CAT), { by: 'role', automatic: 'neighbour' });
    expect(neighbour.bpmnXml).toBe(plain.bpmnXml);
    expect(neighbour.validation.hints).toEqual(plain.validation.hints);
  });
});

describe('the views as shipped', () => {
  test.each([['rollen', 'role'], ['einheiten', 'unit'], ['organigramm', 'organigram']])('%s gives the switch-off table', async (name, vname) => {
    const v = VIEWS[vname];
    const r = await runPipeline(model('automatic-steps.json'), { catalog: catalog(CAT), view: loadNamedView(name) });
    expect(r.validation.errors).toEqual([]);
    expect(laneTable(r.bpmnXml)).toEqual([
      [`L.Process_Order.${v.ids.first}`, v.names[0], ['start', 'register', 'check', 'file', 'end']],
      [`L.Process_Order.${v.ids.second}`, v.names[1], ['approve', 'send']],
    ]);
    expect(r.validation.hints.filter((h) => h.code === 'H03')).toHaveLength(2);
  });

  test('none of the seven shipped views carries the automatic key', () => {
    const names = ['aligned-ports', 'default', 'einheiten', 'explicit-joins', 'organigramm', 'rollen', 'systeme'];
    expect(readdirSync(resolve(root, 'views')).filter((f) => f.endsWith('-view.json')).map((f) => f.replace(/-view\.json$/, '')).sort()).toEqual(names);
    for (const n of names) {
      const v = loadNamedView(n);
      expect('automatic' in (typeof v.lanes === 'object' && v.lanes !== null ? v.lanes : {})).toBe(false);
    }
  });
});

describe('round trip: the lane (automatisch) is an ordinary 1.x lane after import', () => {
  const unassigned = () => {
    const m = copy(model('automatic-steps.json'));
    delete m.nodes.find((n) => n.id === 'file').assignments;
    return m;
  };
  const LANES = [
    { id: 'L.Process_Order.clerk', name: 'Case worker' },
    { id: 'L.Process_Order._automatic', name: '(automatisch)' },
    { id: 'L.Process_Order.teamlead', name: 'Team lead' },
    { id: 'L.Process_Order._unassigned', name: '(nicht zugeordnet)' },
  ];
  test.each([['bpmnToLogicCore', bpmnToLogicCore], ['bpmnToLogicCoreLegacy', bpmnToLogicCoreLegacy]])('%s', async (_n, reader) => {
    const gen = await run(unassigned(), catalog(CAT), { by: 'role', automatic: 'lane' });
    expect(gen.validation.errors).toEqual([]);
    const lc = await reader(gen.bpmnXml);
    expect(validateLogicCoreSchema(lc)).toEqual({ valid: true, errors: [] });
    expect(lc.lanes).toEqual(LANES);
    const lane = (id) => lc.nodes.find((n) => n.id === id).lane;
    expect(lane('register')).toBe('L.Process_Order._automatic');
    expect(lane('send')).toBe('L.Process_Order._automatic');
    expect(lane('file')).toBe('L.Process_Order._unassigned');
    expect(lane('end')).toBe('L.Process_Order._unassigned');
    expect(lc.lanes.every((l) => Object.keys(l).sort().join() === 'id,name')).toBe(true);
    expect(JSON.stringify(lc)).not.toMatch(/bg:|modelVersion|sha256|assignment|derived/);
    const again = await runPipeline(lc);
    expect(again.validation.errors).toEqual([]);
    expect(laneTable(again.bpmnXml).map(([id, name]) => ({ id, name }))).toEqual(LANES);
  });
});

describe('the command line with a view file of its own', () => {
  test('--view=<file> --strict exits 0, prints H19 and draws three lanes', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'automatic-lane-'));
    try {
      mkdirSync(join(tmp, 'out'));
      const viewFile = join(tmp, 'automatik-view.json');
      writeFileSync(viewFile, JSON.stringify({ view: 'automatik', version: '1.0', lanes: { by: 'role', automatic: 'lane' } }));
      const out = join(tmp, 'out', 'r');
      const r = spawnSync(process.execPath, ['bpmn/pipeline.js', fx('automatic-steps.json'), out, '--strict',
        `--view=${viewFile}`, '--catalog', fx(CAT)], { cwd: scripts, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('[H19] Automatic step "Send confirmation" (send) has no performer: lane "(automatisch)".');
      expect(r.stdout).toContain('[H19] Automatic step "Register order" (register) has no performer: lane "(automatisch)".');
      expect(r.stdout).not.toMatch(/⚠ Warnings/);
      expect(existsSync(`${out}.bpmn`)).toBe(true);
      expect(laneTable(readFileSync(`${out}.bpmn`, 'utf8'))).toHaveLength(3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
