/**
 * `migrateModel` (design 6): a 1.x model becomes a format 2.0 model whose lanes are kind-less actors
 * and whose activities carry the performer assignment of their lane (or role); the 1.x-only fields
 * are stripped, and every step the author should check is an entry of the report.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateModel } from './migrate.js';
import { validateModelSchema } from './schema-gate.js';
import { runPipeline } from './pipeline.js';
import { loadNamedView } from '../shared/view.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const fixture = (name) => JSON.parse(readFileSync(resolve(root, 'tests/fixtures', name), 'utf8'));
const copy = (v) => JSON.parse(JSON.stringify(v));

const codes = (result) => result.report.entries.map((e) => e.code);
const entriesOf = (result, code) => result.report.entries.filter((e) => e.code === code);
const processesOf = (model) => (model.pools ? model.pools : [model]);
const nodeOf = (model, id) => processesOf(model).flatMap((p) => p.nodes).find((n) => n.id === id);
/** Top-level node id → its assignments (absent → undefined), over every process. */
const assignmentsOf = (model) => Object.fromEntries(processesOf(model).flatMap((p) => p.nodes).map((n) => [n.id, n.assignments]));

/** Every key anywhere in a JSON value. */
function keysIn(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysIn(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysIn(v, out); }
  return out;
}

function expectTranslatedAndValid(result) {
  expect(result.report.status).toBe('translated');
  const gate = validateModelSchema(result.model, { accept: ['2'] });
  expect(gate.errors).toEqual([]);
  expect(gate.valid).toBe(true);
}

async function generate(result, { lanes = true } = {}) {
  const out = await runPipeline(copy(result.model), { catalog: copy(result.catalog), view: loadNamedView('rollen') });
  expect(out.validation.errors).toEqual([]);
  if (lanes) expect(out.bpmnXml).toContain('<bpmn:lane ');
  else expect(out.bpmnXml).not.toContain('<bpmn:lane ');
  return out;
}

describe('migrateModel — simple-approval.json', () => {
  const input = fixture('simple-approval.json');
  const result = migrateModel(input);

  test('one kind-less actor per lane, every top-level activity assigned to it', () => {
    expectTranslatedAndValid(result);
    expect(result.supplement).toEqual({ actors: [{ id: 'lane1', name: 'Default Lane' }] });
    expect(result.catalog).toEqual({ actors: [{ id: 'lane1', name: 'Default Lane' }] });
    expect(assignmentsOf(result.model)).toEqual({
      start1: undefined, task1: [{ type: 'D', actor: 'lane1' }], gw1: undefined,
      task2: [{ type: 'D', actor: 'lane1' }], task3: [{ type: 'D', actor: 'lane1' }], end1: undefined,
    });
    expect(result.report.summary).toEqual({ processes: 1, lanes: 1, actors: 1, activities: 3, assigned: 3 });
  });

  test('no lane, lanes or role left; $schemaVersion "2.0"; no catalogue path or actors in the model', () => {
    const keys = keysIn(result.model);
    for (const k of ['lane', 'lanes', 'role', 'system', 'nodeIds', 'children', 'catalog', 'actors', 'scheme']) expect(keys.has(k)).toBe(false);
    expect(result.model.$schemaVersion).toBe('2.0');
    expect(result.model.pools[0].edges).toEqual(input.pools[0].edges);
  });

  test('H07 per actor, coded, with the actor as element', () => {
    expect(result.report.entries).toEqual([{
      code: 'H07',
      message: '[H07] Lane "Default Lane" became actor "lane1" without kind; check its kind.',
      elements: ['lane1'],
    }]);
  });

  test('the result generates under the rollen view with the original lane name', async () => {
    const out = await generate(result);
    expect(out.bpmnXml).toContain('name="Default Lane"');
  });

  test('the input object is unchanged', () => {
    const before = copy(input);
    migrateModel(input);
    expect(input).toEqual(before);
  });

  test('language and marker "none" are carried over unchanged', () => {
    const m = copy(input);
    m.language = 'en-GB';
    m.pools[0].nodes.find((n) => n.id === 'end1').marker = 'none';
    const r = migrateModel(m);
    expectTranslatedAndValid(r);
    expect(r.model.language).toBe('en-GB');
    expect(nodeOf(r.model, 'end1').marker).toBe('none');
  });

  test('a 1.x $schemaVersion is replaced by "2.0"', () => {
    const r = migrateModel(fixture('loop-with-join.json'));
    expectTranslatedAndValid(r);
    expect(r.model.$schemaVersion).toBe('2.0');
  });
});

describe('migrateModel — nested-lanes-role-system.json', () => {
  const input = fixture('nested-lanes-role-system.json');

  test('without dropUnsupported it is refused with one MG02 per system field', () => {
    const r = migrateModel(input);
    expect(r.report.status).toBe('refused');
    expect(r.model).toBeNull();
    expect(r.supplement).toBeNull();
    expect(r.catalog).toBeNull();
    expect(codes(r)).toEqual(['MG02', 'MG02']);
    expect(r.report.entries.map((e) => e.elements)).toEqual([['erfassen'], ['freigeben']]);
    for (const e of r.report.entries) expect(e.message).toMatch(/^\[MG02\] .*"system"/);
  });

  test('with dropUnsupported: child lanes carry their parent as unit, three role actors, MG03 per role node', async () => {
    const before = copy(input);
    const r = migrateModel(input, { dropUnsupported: true });
    expect(input).toEqual(before);
    expectTranslatedAndValid(r);
    expect(keysIn(r.model).has('system')).toBe(false);
    expect(r.supplement.actors).toEqual([
      { id: 'lane_service', name: 'Kundenservice' },
      { id: 'lane_fach', name: 'Fachabteilung' },
      { id: 'lane_pruefung', name: 'Prüfung', unit: 'lane_fach' },
      { id: 'lane_freigabe', name: 'Freigabe', unit: 'lane_fach' },
      { id: 'role_Sachbearbeitung', name: 'Sachbearbeitung', unit: 'lane_service' },
      { id: 'role_Pr_fer', name: 'Prüfer', unit: 'lane_pruefung' },
      { id: 'role_Teamleitung', name: 'Teamleitung', unit: 'lane_freigabe' },
    ]);
    expect(assignmentsOf(r.model)).toEqual({
      start: undefined, gw: undefined, end: undefined,
      erfassen: [{ type: 'D', actor: 'role_Sachbearbeitung' }],
      pruefen: [{ type: 'D', actor: 'role_Pr_fer' }],
      freigeben: [{ type: 'D', actor: 'role_Teamleitung' }],
    });
    expect(entriesOf(r, 'MG02').map((e) => e.elements)).toEqual([['erfassen'], ['freigeben']]);
    expect(entriesOf(r, 'MG03').map((e) => e.elements)).toEqual([
      ['erfassen', 'lane_service', 'role_Sachbearbeitung'],
      ['pruefen', 'lane_pruefung', 'role_Pr_fer'],
      ['freigeben', 'lane_freigabe', 'role_Teamleitung'],
    ]);
    expect(entriesOf(r, 'H07')).toHaveLength(7);
    expect(entriesOf(r, 'H07')[4].message).toBe('[H07] Role "Sachbearbeitung" became actor "role_Sachbearbeitung" without kind; check its kind.');
    expect(codes(r)).toEqual(['MG02', 'MG02', ...Array(7).fill('H07'), 'MG03', 'MG03', 'MG03']);
    expect(r.report.summary).toEqual({ processes: 1, lanes: 4, actors: 7, activities: 3, assigned: 3 });
    await generate(r);
  });
});

describe('migrateModel — roles across lanes and processes (Review Focus 5)', () => {
  const lane = (id, name) => ({ id, name });
  const model = {
    pools: [
      { id: 'P_A', name: 'A', lanes: [lane('a1', 'Eingang'), lane('a2', 'Prüfung')],
        nodes: [
          { id: 'sa', type: 'startEvent', name: 'Antrag eingegangen', lane: 'a1' },
          { id: 'ta', type: 'userTask', name: 'Antrag prüfen', lane: 'a1', role: 'Prüfer' },
          { id: 'tb', type: 'userTask', name: 'Antrag ablegen', lane: 'a2' },
          { id: 'ea', type: 'endEvent', name: 'Antrag geprüft', lane: 'a2' }],
        edges: [{ source: 'sa', target: 'ta' }, { source: 'ta', target: 'tb' }, { source: 'tb', target: 'ea' }] },
      { id: 'P_B', name: 'B', lanes: [lane('b1', 'Fach')],
        nodes: [
          { id: 'sb', type: 'startEvent', name: 'Fall eingegangen', lane: 'b1' },
          { id: 'tc', type: 'userTask', name: 'Fall prüfen', lane: 'b1', role: 'Prüfer' },
          { id: 'eb', type: 'endEvent', name: 'Fall geprüft', lane: 'b1' }],
        edges: [{ source: 'sb', target: 'tc' }, { source: 'tc', target: 'eb' }] },
    ],
  };

  test('one actor for the same role name in two processes, no unit, MG03 per node saying so', async () => {
    const r = migrateModel(model);
    expectTranslatedAndValid(r);
    const roleActors = r.supplement.actors.filter((a) => a.id.startsWith('role_'));
    expect(roleActors).toEqual([{ id: 'role_Pr_fer', name: 'Prüfer' }]);
    expect(nodeOf(r.model, 'ta').assignments).toEqual([{ type: 'D', actor: 'role_Pr_fer' }]);
    expect(nodeOf(r.model, 'tc').assignments).toEqual([{ type: 'D', actor: 'role_Pr_fer' }]);
    expect(nodeOf(r.model, 'tb').assignments).toEqual([{ type: 'D', actor: 'a2' }]);
    const mg03 = entriesOf(r, 'MG03');
    expect(mg03.map((e) => e.elements)).toEqual([['ta', 'a1', 'role_Pr_fer'], ['tc', 'b1', 'role_Pr_fer']]);
    for (const e of mg03) expect(e.message).toContain('no unit');
    await generate(r);
  });
});

describe('migrateModel — lanes given by nodeIds (Review Focus 1)', () => {
  const stripNodeLane = (m) => {
    const c = copy(m);
    for (const p of processesOf(c)) for (const n of p.nodes) delete n.lane;
    return c;
  };

  test.each(['bpmn-generator-pipeline.json', 'loop-with-join.json'])('%s: the same assignments as with node.lane', (name) => {
    const original = fixture(name);
    const withLane = migrateModel(original);
    const byNodeIds = migrateModel(stripNodeLane(original));
    expectTranslatedAndValid(withLane);
    expectTranslatedAndValid(byNodeIds);
    expect(assignmentsOf(byNodeIds.model)).toEqual(assignmentsOf(withLane.model));
    expect(byNodeIds.supplement).toEqual(withLane.supplement);
    // every top-level activity has its lane as performer
    for (const p of processesOf(original)) {
      for (const n of p.nodes) {
        const a = nodeOf(withLane.model, n.id).assignments;
        if (['startEvent', 'endEvent', 'exclusiveGateway', 'parallelGateway', 'intermediateCatchEvent', 'intermediateThrowEvent', 'boundaryEvent', 'eventBasedGateway', 'inclusiveGateway'].includes(n.type)) {
          expect([n.id, a]).toEqual([n.id, undefined]);
        } else {
          expect([n.id, a]).toEqual([n.id, [{ type: 'D', actor: n.lane }]]);
        }
      }
    }
    expect(entriesOf(byNodeIds, 'MG05')).toEqual([]);
  });
});

describe('migrateModel — ids (Review Focus 2)', () => {
  const model = () => ({
    id: 'Process_Ids', name: 'Ids',
    lanes: [{ id: '1x', name: 'Eins' }, { id: 'a.b', name: 'Punkt' }, { id: 'a_b', name: 'Unterstrich' },
      { id: 'x.y', name: 'Erste' }, { id: 'x:y', name: 'Zweite' }],
    nodes: [
      { id: 's', type: 'startEvent', name: 'Start', lane: '1x' },
      { id: 't1', type: 'task', name: 'Eins tun', lane: '1x' },
      { id: 't2', type: 'task', name: 'Punkt tun', lane: 'a.b' },
      { id: 't3', type: 'task', name: 'Strich tun', lane: 'a_b' },
      { id: 't4', type: 'task', name: 'Erstes tun', lane: 'x.y' },
      { id: 't5', type: 'task', name: 'Zweites tun', lane: 'x:y' },
      { id: 'e', type: 'endEvent', name: 'Ende', lane: 'x:y' }],
    edges: [{ source: 's', target: 't1' }, { source: 't1', target: 't2' }, { source: 't2', target: 't3' },
      { source: 't3', target: 't4' }, { source: 't4', target: 't5' }, { source: 't5', target: 'e' }],
  });

  test('a lane id that is no actor id is renamed, colliding slugs get _2, MG06 each; generation works', async () => {
    const r = migrateModel(model());
    expectTranslatedAndValid(r);
    expect(r.supplement.actors.map((a) => a.id)).toEqual(['L_1x', 'a_b_2', 'a_b', 'x_y', 'x_y_2']);
    expect(entriesOf(r, 'MG06').map((e) => e.elements)).toEqual([['1x', 'L_1x'], ['a.b', 'a_b_2'], ['x.y', 'x_y'], ['x:y', 'x_y_2']]);
    for (const e of entriesOf(r, 'MG06')) expect(e.message).toMatch(/^\[MG06\] /);
    expect(assignmentsOf(r.model)).toMatchObject({
      t1: [{ type: 'D', actor: 'L_1x' }], t2: [{ type: 'D', actor: 'a_b_2' }], t3: [{ type: 'D', actor: 'a_b' }],
      t4: [{ type: 'D', actor: 'x_y' }], t5: [{ type: 'D', actor: 'x_y_2' }],
    });
    await generate(r);
  });

  test('a long id is cut to 64 characters, the suffix included', () => {
    const m = model();
    const long = `${'a'.repeat(70)}.z`;
    m.lanes.push({ id: long, name: 'Lang' }, { id: `${long}:`, name: 'Lang2' });
    m.nodes.splice(1, 0, { id: 't6', type: 'task', name: 'Lang tun', lane: long }, { id: 't7', type: 'task', name: 'Lang2 tun', lane: `${long}:` });
    const r = migrateModel(m);
    expectTranslatedAndValid(r);
    const ids = r.supplement.actors.map((a) => a.id);
    expect(ids).toContain('a'.repeat(64));
    expect(ids).toContain(`${'a'.repeat(62)}_2`);
  });

  test('a single process without id gets Process_1 with MG06', () => {
    const m = model();
    delete m.id;
    const r = migrateModel(m);
    expectTranslatedAndValid(r);
    expect(r.model.id).toBe('Process_1');
    expect(entriesOf(r, 'MG06')[0]).toEqual({ code: 'MG06', message: '[MG06] the process has no id; it is given "Process_1".', elements: ['Process_1'] });
  });

  test.each([['Process.Ids'], ['1Process']])('a process or pool id %s outside the 2.0 pattern is refused with MG01', (id) => {
    const single = model();
    single.id = id;
    const r1 = migrateModel(single);
    expect(r1.report.status).toBe('refused');
    expect(codes(r1)).toEqual(['MG01']);
    expect(r1.report.entries[0].elements).toEqual([id]);
    const pooled = copy(fixture('simple-approval.json'));
    pooled.pools[0].id = id;
    expect(codes(migrateModel(pooled))).toEqual(['MG01']);
  });
});

describe('migrateModel — refusals (Review Focus 3)', () => {
  test('a 2.0 input is refused with MG01', () => {
    const v2 = migrateModel(fixture('simple-approval.json')).model;
    const r = migrateModel(v2);
    expect(r).toEqual({
      model: null, supplement: null, catalog: null,
      report: { status: 'refused', entries: [expect.objectContaining({ code: 'MG01' })], summary: { processes: 0, lanes: 0, actors: 0, activities: 0, assigned: 0 } },
    });
    expect(r.report.entries[0].message).toMatch(/^\[MG01\] input refused: .*2\.0/);
  });

  test.each([[null], ['text'], [42], [[]], [{ nodes: 'x' }], [{ $schemaVersion: '1.0', nodes: [], edges: [], extra: 1 }]])(
    'a schema failure is refused with MG01 and never throws (%p)', (input) => {
      const r = migrateModel(input);
      expect(r.report.status).toBe('refused');
      expect(codes(r)).toEqual(['MG01']);
      expect(r.report.entries[0].message).toMatch(/^\[MG01\] input refused: /);
    });
});

describe('migrateModel — activities without lane, lane-less processes, data nodes', () => {
  test('an activity without lane in a laned process gets no assignment and MG05', () => {
    const m = copy(fixture('simple-approval.json'));
    delete m.pools[0].nodes.find((n) => n.id === 'task3').lane;
    const r = migrateModel(m);
    expectTranslatedAndValid(r);
    expect(nodeOf(r.model, 'task3').assignments).toBeUndefined();
    expect(entriesOf(r, 'MG05')).toEqual([{ code: 'MG05', message: expect.stringMatching(/^\[MG05\] .*"task3"/), elements: ['task3'] }]);
    expect(r.report.summary.assigned).toBe(2);
  });

  test('a lane-less pool gets no assignments, message flows survive', () => {
    const input = fixture('realistic-collaboration.json');
    const r = migrateModel(input);
    expectTranslatedAndValid(r);
    expect(r.model.messageFlows).toEqual(input.messageFlows);
    for (const id of ['Process_Applicant', 'Process_Archive']) {
      const pool = r.model.pools.find((p) => p.id === id);
      expect(pool.nodes.every((n) => n.assignments === undefined)).toBe(true);
    }
    expect(entriesOf(r, 'MG05')).toEqual([]);
  });

  test('subprocess children and boundary events get no assignment; their lane fields go', () => {
    const r = migrateModel(fixture('expanded-subprocess.json'));
    expectTranslatedAndValid(r);
    const keys = keysIn(r.model);
    expect(keys.has('lane')).toBe(false);
    for (const p of processesOf(r.model)) {
      for (const n of p.nodes) {
        if (n.type === 'boundaryEvent' || n.attachedTo) expect(n.assignments).toBeUndefined();
        for (const c of n.nodes || []) expect(c.assignments).toBeUndefined();
      }
    }
  });

  test('a role that becomes no assignment is MG02 (refused; dropped with dropUnsupported)', () => {
    const m = copy(fixture('realistic-collaboration.json'));
    const pool = m.pools.find((p) => p.id === 'Process_Applicant');
    const task = pool.nodes.find((n) => n.type.endsWith('Task') || n.type === 'task');
    task.role = 'Antragsteller';
    const r = migrateModel(m);
    expect(r.report.status).toBe('refused');
    expect(entriesOf(r, 'MG02').map((e) => e.elements)).toEqual([[task.id]]);
    const dropped = migrateModel(m, { dropUnsupported: true });
    expectTranslatedAndValid(dropped);
    expect(nodeOf(dropped.model, task.id).role).toBeUndefined();
    expect(dropped.supplement.actors.some((a) => a.name === 'Antragsteller')).toBe(false);
  });

  test('data nodes and their associations: MG02 each; dropped with dropUnsupported', async () => {
    const input = fixture('artifacts-laneless-pool.json');
    const refused = migrateModel(input);
    expect(refused.report.status).toBe('refused');
    expect(entriesOf(refused, 'MG02').map((e) => e.elements)).toEqual([
      ['formular'], ['anlagen'], ['register'], ['as_formular'], ['as_anlagen'], ['as_register'],
    ]);
    expect(codes(refused).every((c) => c === 'MG02')).toBe(true);
    const r = migrateModel(input, { dropUnsupported: true });
    expectTranslatedAndValid(r);
    const types = processesOf(r.model).flatMap((p) => p.nodes).map((n) => n.type);
    expect(types).not.toContain('dataObjectReference');
    expect(types).not.toContain('dataStoreReference');
    // its three associations each touch a data node
    expect(r.model.associations).toEqual([]);
    await generate(r, { lanes: false });
  });

  test('data nodes inside a subprocess are dropped too', () => {
    const r = migrateModel(fixture('subprocess-child-fidelity.json'), { dropUnsupported: true });
    expectTranslatedAndValid(r);
    expect(JSON.stringify(r.model)).not.toMatch(/data(Object|Store)Reference/);
    expect(entriesOf(r, 'MG02').map((e) => e.elements[0]).sort()).toEqual(['c_data', 'g_data']);
  });
});

describe('migrateModel — the catalogue option', () => {
  test('the performs type comes from the given catalogue scheme; the effective catalogue appends the new actors', () => {
    const scheme = { scheme: 'rasci', types: [{ key: 'R', label: 'Responsible', performs: true }, { key: 'I', label: 'Informed' }] };
    const given = { scheme, actors: [{ id: 'other', name: 'Andere', kind: 'unit' }] };
    const before = copy(given);
    const r = migrateModel(fixture('simple-approval.json'), { catalog: given });
    expect(given).toEqual(before);
    expectTranslatedAndValid(r);
    expect(nodeOf(r.model, 'task1').assignments).toEqual([{ type: 'R', actor: 'lane1' }]);
    expect(r.supplement).toEqual({ actors: [{ id: 'lane1', name: 'Default Lane' }] });
    expect(r.catalog).toEqual({ scheme, actors: [{ id: 'other', name: 'Andere', kind: 'unit' }, { id: 'lane1', name: 'Default Lane' }] });
  });

  test('a malformed catalogue is refused with MG01', () => {
    const r = migrateModel(fixture('simple-approval.json'), { catalog: { actors: 'x' } });
    expect(codes(r)).toEqual(['MG01']);
    expect(r.report.entries[0].message).toMatch(/^\[MG01\] input refused: the catalogue/);
  });
});
