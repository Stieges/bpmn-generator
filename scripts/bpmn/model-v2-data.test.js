/**
 * resolveFields and data (format 2.1): the model's `data` merges into the catalogue's like
 * `systems`, a step's `dataAccess` is checked against it (C01, C03, C14, C15, C16, hints H09, H21)
 * and neither key reaches the intermediate form.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveFields } from './model-v2.js';
import { catalogFingerprint, resolveScheme } from '../shared/catalog.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../tests/fixtures-v2/${name}`, import.meta.url), 'utf8'));
const copy = (v) => JSON.parse(JSON.stringify(v));
const deepFreeze = (v) => { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };

const DATA = [
  { id: 'd_bestellung', name: 'Bestellung', kind: 'object' },
  { id: 'd_rechnungen', name: 'Rechnungen', kind: 'object', isCollection: true },
  { id: 'd_register', name: 'Bestellregister', kind: 'store' },
];
const CATALOG = { ...fixture('bestellung-catalog.json'), data: DATA };
const SYSTEMS = [{ id: 'sys_akte', name: 'Bestellakte' }];
const NO_CATALOG_HELP = 'pass one with --catalog=<path>, the "catalog" field of the process file, the catalog option of runPipeline or the `catalog` object of an MCP or HTTP request';

/** bestellung.json as "2.1"; `edit` changes nodes by id, `extra` adds root fields. */
const model21 = (edit = {}, extra = {}) => {
  const m = { ...fixture('bestellung.json'), $schemaVersion: '2.1', ...extra };
  for (const n of m.nodes) if (edit[n.id]) Object.assign(n, edit[n.id]);
  return m;
};
const access = (...list) => ({ pruefen: { dataAccess: list } });
const run = (model, catalog = CATALOG) => resolveFields(model, { catalog: catalog ? copy(catalog) : undefined });
/** Every key of the value, at any depth. */
const keysOf = (v, out = new Set()) => {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
};

describe('resolveFields data: the check', () => {
  test('a valid data access resolves; neither data nor dataAccess reaches the intermediate form', () => {
    const model = deepFreeze(model21(access({ data: 'd_bestellung', access: 'read' }, { data: 'd_register', access: 'write' }, { data: 'd_rechnungen' }), { data: [] }));
    const { lc, resolved, errors, hints } = resolveFields(model, { catalog: deepFreeze(copy(CATALOG)) });
    expect(errors).toEqual([]);
    expect(hints).toEqual([]);
    expect(keysOf(lc).has('dataAccess')).toBe(false);
    expect(lc).not.toHaveProperty('data');
    expect(resolved.data).toEqual(DATA);
    expect(resolved.dataById.get('d_register')).toEqual(DATA[2]);
    expect(resolved.dataOrder.get('d_rechnungen')).toBe(1);
    expect(resolved.fingerprint).toBe(catalogFingerprint(resolved.actors, resolveScheme('demi'), [], DATA));
  });

  test('dataAccess is removed at every depth, in a subprocess and in a pool', () => {
    const inner = { id: 'inner', type: 'userTask', name: 'Innen', dataAccess: [{ data: 'd_bestellung', access: 'read' }] };
    const sub = { id: 'sp', type: 'subProcess', name: 'Teil', dataAccess: [{ data: 'd_register' }], nodes: [inner] };
    const pooled = { $schemaVersion: '2.1', pools: [{ id: 'Process_P', name: 'P', nodes: [{ id: 't', type: 'userTask', name: 'T', dataAccess: [{ data: 'd_bestellung', access: 'write' }] }, sub], edges: [] }] };
    const { lc, errors } = run(pooled);
    expect(errors).toEqual([]);
    expect(keysOf(lc).has('dataAccess')).toBe(false);
  });

  test('a model without data gives the same intermediate form as before: snapshot of bestellung.json', () => {
    const base = resolveFields(fixture('bestellung.json'), { catalog: fixture('bestellung-catalog.json') });
    const withData = resolveFields(fixture('bestellung.json'), { catalog: copy(CATALOG) });
    expect(base.errors).toEqual([]);
    // only the fingerprint differs: the catalogue grew
    const { _modelInfo: infoWith, ...restWith } = withData.lc;
    const { _modelInfo: infoBase, ...restBase } = base.lc;
    expect(JSON.stringify(restWith)).toBe(JSON.stringify(restBase));
    expect(infoWith).toEqual({ ...infoBase, catalogFingerprint: withData.resolved.fingerprint });
    // frozen at 5188f2d (before the data checks): sha256 of JSON.stringify of the intermediate form
    expect(createHash('sha256').update(JSON.stringify(base.lc)).digest('hex')).toBe('3c478f5f367469b23b08412821444def02b8bf1eae475a45ece7c7b581108b90');
    expect(base.hints).toEqual([]);
    expect(base.errors).toEqual([]);
    expect(base.lc._modelInfo.catalogFingerprint).toBe('sha256:bbe131aa583483354fce5fede3ed1d170ce97b1fa90a1341b5a6af5af6d77273');
    const noKeys = keysOf(base.lc);
    for (const key of ['data', 'dataAccess', '_dataRef', '_dataObject', '_dataStore', '_dataProperty', '_access']) expect(noKeys.has(key)).toBe(false);
    // a catalogue with data changes the fingerprint, an empty list does not
    expect(withData.resolved.fingerprint).not.toBe(base.resolved.fingerprint);
    expect(resolveFields(fixture('bestellung.json'), { catalog: { ...fixture('bestellung-catalog.json'), data: [] } }).resolved.fingerprint).toBe(base.resolved.fingerprint);
  });

  test('a "2.0" model with dataAccess is F06 through resolveFields', () => {
    const model = { ...model21(access({ data: 'd_bestellung' })), $schemaVersion: '2.0' };
    expect(run(model).errors).toEqual(['[F06] /nodes/2/dataAccess "dataAccess" needs format 2.1; set "$schemaVersion" to "2.1"']);
  });

  test('C16: an unknown data id, an actor, a system', () => {
    const catalog = { ...CATALOG, systems: SYSTEMS };
    expect(run(model21(access({ data: 'd_ghost' })), catalog).errors)
      .toEqual(['[C16] node "pruefen": data "d_ghost" is not in the catalogue']);
    expect(run(model21(access({ data: 'leitung', access: 'read' })), catalog).errors)
      .toEqual(['[C16] node "pruefen": "leitung" is an actor, not a data item']);
    expect(run(model21(access({ data: 'sys_akte' })), catalog).errors)
      .toEqual(['[C16] node "pruefen": "sys_akte" is a system, not a data item']);
  });

  test('C16: an unknown id listed twice is one error', () => {
    expect(run(model21(access({ data: 'd_ghost', access: 'read' }, { data: 'd_ghost', access: 'write' }))).errors)
      .toEqual(['[C16] node "pruefen": data "d_ghost" is not in the catalogue']);
  });

  test('C16 inside a subprocess and a pool', () => {
    const sub = { id: 'sp', type: 'subProcess', name: 'Teil', nodes: [{ id: 'inner', type: 'userTask', name: 'Innen', dataAccess: [{ data: 'ghost' }] }] };
    expect(run({ $schemaVersion: '2.1', id: 'Process_P', name: 'P', nodes: [sub], edges: [] }).errors).toEqual(['[C16] node "inner": data "ghost" is not in the catalogue']);
    const pooled = { $schemaVersion: '2.1', pools: [{ id: 'Process_P', name: 'P', nodes: [{ id: 't', type: 'userTask', name: 'T', dataAccess: [{ data: 'ghost' }] }], edges: [] }] };
    expect(run(pooled).errors).toEqual(['[C16] node "t": data "ghost" is not in the catalogue']);
  });

  test('C16: the same access twice, the same unrecorded access twice', () => {
    expect(run(model21(access({ data: 'd_bestellung', access: 'read' }, { data: 'd_bestellung', access: 'read' }))).errors)
      .toEqual(['[C16] node "pruefen": data access to "d_bestellung" (read) is listed 2 times']);
    expect(run(model21(access({ data: 'd_register' }, { data: 'd_register' }, { data: 'd_register' }))).errors)
      .toEqual(['[C16] node "pruefen": data access to "d_register" (access not recorded) is listed 3 times']);
  });

  test('C16: read and write of one item is no duplicate', () => {
    expect(run(model21(access({ data: 'd_bestellung', access: 'read' }, { data: 'd_bestellung', access: 'write' }))).errors).toEqual([]);
  });

  test('C16 (N1): a not-recorded entry beside a recorded one of the same item', () => {
    expect(run(model21(access({ data: 'd_bestellung' }, { data: 'd_bestellung', access: 'write' }))).errors)
      .toEqual(['[C16] node "pruefen": data access to "d_bestellung" is both recorded (write) and not recorded; keep one form']);
    // both recorded plus an unrecorded one: one error naming the first recorded access
    expect(run(model21(access({ data: 'd_bestellung', access: 'write' }, { data: 'd_bestellung', access: 'read' }, { data: 'd_bestellung' }))).errors)
      .toEqual(['[C16] node "pruefen": data access to "d_bestellung" is both recorded (write) and not recorded; keep one form']);
    // another item is no conflict
    expect(run(model21(access({ data: 'd_bestellung' }, { data: 'd_register', access: 'write' }))).errors).toEqual([]);
  });

  test('C16: data without any catalogue source is one leading error', () => {
    const model = model21({ pruefen: { dataAccess: [{ data: 'd_bestellung' }] }, zahlen: { dataAccess: [{ data: 'd_register' }] } });
    for (const n of model.nodes) delete n.assignments;
    delete model.catalog;
    expect(resolveFields(model).errors)
      .toEqual([`[C16] the model names data but no catalogue was given; ${NO_CATALOG_HELP}`]);
  });

  test('an empty dataAccess list with no catalogue names no data: no C16', () => {
    const model = model21({ pruefen: { dataAccess: [] } });
    for (const n of model.nodes) delete n.assignments;
    delete model.catalog;
    const { errors, lc } = resolveFields(model);
    expect(errors).toEqual([]);
    expect(keysOf(lc).has('dataAccess')).toBe(false);
  });

  test('a model without a catalogue may carry data itself', () => {
    const model = model21(access({ data: 'd_bestellung', access: 'read' }), { data: DATA });
    for (const n of model.nodes) delete n.assignments;
    const { catalog: _drop, ...rest } = model;
    const { resolved, errors } = resolveFields(rest);
    expect(errors).toEqual([]);
    expect(resolved.actors).toEqual([]);
    expect(resolved.data).toEqual(DATA);
    expect(resolved.fingerprint).toBe(catalogFingerprint([], resolveScheme(), [], DATA));
    // assignments still need an actor catalogue: data alone is none
    expect(resolveFields({ ...rest, nodes: model21().nodes }).errors[0]).toMatch(/^\[C01\] the model has assignments but no actor catalogue/);
  });

  test('C15: data access on a gateway and a boundary event; a text annotation stops at the gate', () => {
    expect(run(model21({ gw: { dataAccess: [{ data: 'd_bestellung' }] } })).errors)
      .toEqual(['[C15] node "gw": data access belongs on an activity, not on exclusiveGateway']);
    const boundary = { id: 'b', type: 'boundaryEvent', name: 'Frist', attachedTo: 'pruefen', dataAccess: [{ data: 'd_bestellung' }] };
    const m = model21();
    m.nodes.push(boundary);
    expect(run(m).errors).toEqual(['[C15] node "b": data access belongs on an activity, not on boundaryEvent']);
    // an annotation does not take the field at all: the format gate answers first (F01), as for `system`
    const ta = model21();
    ta.nodes.push({ id: 'ta', type: 'textAnnotation', text: 'Hinweis', dataAccess: [{ data: 'd_bestellung' }] });
    expect(run(ta).errors).toEqual(['[F01] /nodes/6 must NOT have additional properties']);
  });

  test('C15: every activity carries data access', () => {
    for (const type of ['task', 'userTask', 'manualTask', 'serviceTask', 'scriptTask', 'businessRuleTask', 'sendTask', 'receiveTask', 'subProcess', 'transaction', 'callActivity']) {
      const m = model21();
      m.nodes.push({ id: 'x', type, name: 'X', dataAccess: [{ data: 'd_bestellung', access: 'read' }] });
      expect({ type, errors: run(m).errors }).toEqual({ type, errors: [] });
    }
  });

  test('C14 naming a data id; C01 naming a data id', () => {
    expect(run(model21({ pruefen: { system: 'd_register' } }), { ...CATALOG, systems: SYSTEMS }).errors)
      .toEqual(['[C14] node "pruefen": "d_register" is a data item, not a system']);
    expect(run(model21({ pruefen: { assignments: [{ type: 'D', actor: 'd_register' }] } })).errors)
      .toEqual(['[C01] node "pruefen": actor "d_register" is a data item, not an actor']);
    const catalog = { ...CATALOG, actors: [...CATALOG.actors, { id: 'r', name: 'R', kind: 'role', unit: 'd_register' }, { id: 'u', name: 'U', kind: 'unit', partOf: 'd_bestellung' }] };
    expect(run(model21(), catalog).errors).toEqual([
      '[C01] actor "r": unit "d_register" is a data item, not a unit',
      '[C01] actor "u": partOf "d_bestellung" is a data item, not a unit',
    ]);
  });

  test('C03: a data id twice, twice in the process file, an id both actor and data, both system and data', () => {
    expect(run(model21(), { ...CATALOG, data: [...DATA, { id: 'd_register', name: 'Zweites' }] }).errors)
      .toEqual(['[C03] data id "d_register" occurs 2 times in the catalogue']);
    expect(run(model21({}, { data: [...DATA, ...DATA.slice(0, 1)] })).errors)
      .toEqual(['[C03] data id "d_bestellung" occurs 2 times in the data of the process file']);
    expect(run(model21(), { ...CATALOG, data: [{ id: 'leitung', name: 'Leitungsakte' }] }).errors)
      .toEqual(['[C03] id "leitung" is both an actor and a data item in the catalogue']);
    expect(run(model21(), { ...CATALOG, systems: [{ id: 'd_register', name: 'Registersystem' }] }).errors)
      .toEqual(['[C03] id "d_register" is both a system and a data item in the catalogue']);
    // the effective lists: a model data entry meets a catalogue actor
    expect(run(model21({}, { data: [{ id: 'zahlung', name: 'Zahlungsakte' }] })).errors)
      .toEqual(['[C03] id "zahlung" is both an actor and a data item in the catalogue']);
  });
});

describe('resolveFields data: hints', () => {
  test('H21 once for a kind-less item used by two steps, in order of first use', () => {
    const catalog = { ...CATALOG, data: [...DATA, { id: 'd_notiz', name: 'Notiz' }, { id: 'd_frei', name: 'Frei' }, { id: 'd_zwei', name: 'Zwei' }] };
    const model = model21({
      pruefen: { dataAccess: [{ data: 'd_zwei' }, { data: 'd_notiz', access: 'read' }] },
      rueck: { dataAccess: [{ data: 'd_notiz', access: 'write' }, { data: 'd_bestellung' }] },
    });
    const { hints, errors } = run(model, catalog);
    expect(errors).toEqual([]);
    expect(hints).toEqual([
      { code: 'H21', message: 'Data item "Zwei" (d_zwei) has no recorded kind: drawn as a data object.', elements: ['d_zwei'] },
      { code: 'H21', message: 'Data item "Notiz" (d_notiz) has no recorded kind: drawn as a data object.', elements: ['d_notiz'] },
    ]);
  });

  test('an item no step uses gives no H21', () => {
    expect(run(model21(), { ...CATALOG, data: [{ id: 'd_notiz', name: 'Notiz' }] }).hints).toEqual([]);
  });

  test('H09 for a data entry the process file replaces, after the actors and systems', () => {
    const own = [{ id: 'd_register', name: 'Register (lokal)', kind: 'store' }, { id: 'd_neu', name: 'Neu', kind: 'object' }];
    const actors = [{ id: 'leitung', name: 'Leitung (lokal)', kind: 'role', unit: 'abt_buchhaltung' }];
    const catalog = deepFreeze({ ...copy(CATALOG), systems: SYSTEMS });
    const model = deepFreeze(model21(access({ data: 'd_register', access: 'write' }), { data: own, actors, systems: [{ id: 'sys_akte', name: 'Akte (lokal)' }] }));
    const { resolved, errors, hints } = resolveFields(model, { catalog });
    expect(errors).toEqual([]);
    expect(resolved.data.map((d) => d.id)).toEqual(['d_bestellung', 'd_rechnungen', 'd_register', 'd_neu']);
    expect(resolved.data[2].name).toBe('Register (lokal)');
    expect(resolved.dataOrder.get('d_neu')).toBe(3);
    expect(hints).toEqual([
      { code: 'H09', message: 'Catalogue entry "leitung" is replaced by the process file.', elements: ['leitung'] },
      { code: 'H09', message: 'Catalogue entry "sys_akte" is replaced by the process file.', elements: ['sys_akte'] },
      { code: 'H09', message: 'Catalogue entry "d_register" is replaced by the process file.', elements: ['d_register'] },
    ]);
    expect(resolved.fingerprint).toBe(catalogFingerprint(resolved.actors, resolveScheme('demi'), resolved.systems, resolved.data));
  });
});
