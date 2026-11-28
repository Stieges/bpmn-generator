/**
 * resolveFields and data (format 2.1): the model's `data` merges into the catalogue's like
 * `systems`, a step's `dataAccess` is checked against it (C01, C03, C14, C15, C16, hints H09, H21)
 * and resolved into data references, their connections and input placeholders (C17 when a derived
 * id collides); neither key reaches the intermediate form.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveFields, formLanes } from './model-v2.js';
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

  test('C15: data access on a gateway, a boundary event and a text annotation', () => {
    expect(run(model21({ gw: { dataAccess: [{ data: 'd_bestellung' }] } })).errors)
      .toEqual(['[C15] node "gw": data access belongs on an activity, not on exclusiveGateway']);
    const boundary = { id: 'b', type: 'boundaryEvent', name: 'Frist', attachedTo: 'pruefen', dataAccess: [{ data: 'd_bestellung' }] };
    const m = model21();
    m.nodes.push(boundary);
    expect(run(m).errors).toEqual(['[C15] node "b": data access belongs on an activity, not on boundaryEvent']);
    // the schema does not restrict the field by node type, so an annotation gets the readable C15
    const ta = model21();
    ta.nodes.push({ id: 'ta', type: 'textAnnotation', name: 'Hinweis', dataAccess: [{ data: 'd_bestellung' }] });
    expect(run(ta).errors).toEqual(['[C15] node "ta": data access belongs on an activity, not on textAnnotation']);
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

// -------------------------------------------------------------------------------------------------
// the derivation: data references, their connections and the input placeholder
// -------------------------------------------------------------------------------------------------

const P = 'Process_Bestellung';
const node = (lc, id) => {
  const find = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.id === id) return n;
      const hit = find(n.nodes);
      if (hit) return hit;
    }
    return undefined;
  };
  return find(lc.nodes) ?? (lc.pools ?? []).map((p) => find(p.nodes)).find(Boolean);
};

describe('resolveFields data: the intermediate form', () => {
  test('pruefen reads the order and writes the register', () => {
    const model = deepFreeze(model21(access({ data: 'd_bestellung', access: 'read' }, { data: 'd_register', access: 'write' })));
    const { lc, errors } = resolveFields(model, { catalog: deepFreeze(copy(CATALOG)) });
    expect(errors).toEqual([]);
    expect(lc.nodes.map((n) => n.id)).toEqual(['start', 'gw', 'pruefen', 'rueck', 'zahlen', 'end', 'pruefen__d_bestellung', 'pruefen__d_register']);
    expect(lc.nodes[6]).toEqual({ id: 'pruefen__d_bestellung', type: 'dataObjectReference', name: 'Bestellung', _dataRef: 'd_bestellung', _dataObject: `${P}__d_bestellung` });
    expect(Object.keys(lc.nodes[6])).toEqual(['id', 'type', 'name', '_dataRef', '_dataObject']);
    expect(lc.nodes[7]).toEqual({ id: 'pruefen__d_register', type: 'dataStoreReference', name: 'Bestellregister', _dataRef: 'd_register', _dataStore: 'd_register__store' });
    expect(lc.associations).toEqual([
      { id: 'pruefen__d_bestellung__read', source: 'pruefen__d_bestellung', target: 'pruefen', directed: true, _access: 'read' },
      { id: 'pruefen__d_register__write', source: 'pruefen', target: 'pruefen__d_register', directed: true, _access: 'write' },
    ]);
    expect(Object.keys(lc.associations[0])).toEqual(['id', 'source', 'target', 'directed', '_access']);
    expect(lc.nodes[2]._dataProperty).toBe('pruefen__input');
    for (const id of ['rueck', 'zahlen']) expect(lc.nodes.find((n) => n.id === id)).not.toHaveProperty('_dataProperty');
    expect(keysOf(lc).has('dataAccess')).toBe(false);
    expect(keysOf(lc).has('data')).toBe(false);
  });

  test('read and write of one item: one reference, two associations', () => {
    const { lc } = run(model21(access({ data: 'd_bestellung', access: 'write' }, { data: 'd_bestellung', access: 'read' })));
    expect(lc.nodes.filter((n) => n._dataRef).map((n) => n.id)).toEqual(['pruefen__d_bestellung']);
    expect(lc.associations.map((a) => a.id)).toEqual(['pruefen__d_bestellung__read', 'pruefen__d_bestellung__write']);
  });

  test('access not recorded: a __link without directed; no placeholder without a read', () => {
    const { lc } = run(model21(access({ data: 'd_register' })));
    expect(lc.associations).toEqual([{ id: 'pruefen__d_register__link', source: 'pruefen__d_register', target: 'pruefen', _access: 'unrecorded' }]);
    expect(lc.nodes[2]).not.toHaveProperty('_dataProperty');
    const written = run(model21(access({ data: 'd_register', access: 'write' }))).lc;
    expect(written.nodes[2]).not.toHaveProperty('_dataProperty');
  });

  test('a collection carries isCollection; a kind-less item is a data object', () => {
    const catalog = { ...CATALOG, data: [...DATA, { id: 'd_notiz', name: 'Notiz' }] };
    const { lc } = run(model21(access({ data: 'd_rechnungen', access: 'read' }, { data: 'd_notiz', access: 'write' })), catalog);
    expect(node(lc, 'pruefen__d_rechnungen')).toEqual({ id: 'pruefen__d_rechnungen', type: 'dataObjectReference', name: 'Rechnungen', isCollection: true, _dataRef: 'd_rechnungen', _dataObject: `${P}__d_rechnungen` });
    expect(node(lc, 'pruefen__d_notiz')).toEqual({ id: 'pruefen__d_notiz', type: 'dataObjectReference', name: 'Notiz', _dataRef: 'd_notiz', _dataObject: `${P}__d_notiz` });
  });

  test('a nested step\'s reference sits in the subprocess nodes; the subprocess\'s own in its container', () => {
    const inner = { id: 'inner', type: 'userTask', name: 'Innen', dataAccess: [{ data: 'd_bestellung', access: 'read' }] };
    const m = model21();
    m.nodes.splice(3, 0, { id: 'sp', type: 'subProcess', name: 'Teil', dataAccess: [{ data: 'd_register', access: 'write' }], nodes: [inner] });
    const { lc, errors } = run(m);
    expect(errors).toEqual([]);
    const sp = lc.nodes.find((n) => n.id === 'sp');
    expect(sp.nodes.map((n) => n.id)).toEqual(['inner', 'inner__d_bestellung']);
    expect(sp.nodes[1]._dataObject).toBe(`${P}__d_bestellung`);
    expect(lc.nodes.map((n) => n.id).slice(-1)).toEqual(['sp__d_register']);
    expect(lc.associations.map((a) => a.id)).toEqual(['sp__d_register__write', 'inner__d_bestellung__read']);
  });

  test('a pool step\'s reference sits in its pool, with the DataObject of the pool\'s process', () => {
    const pooled = { $schemaVersion: '2.1', pools: [
      { id: 'Process_Einkauf', name: 'Einkauf', nodes: [{ id: 'a', type: 'userTask', name: 'A' }], edges: [] },
      { id: 'Process_Lager', name: 'Lager', nodes: [{ id: 't', type: 'userTask', name: 'T', dataAccess: [{ data: 'd_bestellung', access: 'write' }, { data: 'd_register', access: 'read' }] }], edges: [] },
    ] };
    const { lc, errors } = run(pooled);
    expect(errors).toEqual([]);
    expect(lc.pools[0].nodes.map((n) => n.id)).toEqual(['a']);
    expect(lc.pools[1].nodes.map((n) => n.id)).toEqual(['t', 't__d_bestellung', 't__d_register']);
    expect(lc.pools[1].nodes[1]._dataObject).toBe('Process_Lager__d_bestellung');
    expect(lc.pools[1].nodes[2]._dataStore).toBe('d_register__store');
    expect(lc.associations.map((a) => a.id)).toEqual(['t__d_register__read', 't__d_bestellung__write']);
  });

  test('association order: the model\'s own, then every unrecorded link, then per step reads and writes', () => {
    const m = model21({
      pruefen: { dataAccess: [{ data: 'd_bestellung', access: 'write' }, { data: 'd_rechnungen', access: 'read' }, { data: 'd_register' }] },
      zahlen: { dataAccess: [{ data: 'd_register', access: 'read' }, { data: 'd_bestellung' }] },
    }, { associations: [{ id: 'a1', source: 'ta', target: 'pruefen' }] });
    m.nodes.push({ id: 'ta', type: 'textAnnotation', name: 'Hinweis' });
    const { lc, errors } = run(m);
    expect(errors).toEqual([]);
    expect(lc.associations.map((a) => a.id)).toEqual([
      'a1', 'pruefen__d_register__link', 'zahlen__d_bestellung__link',
      'pruefen__d_rechnungen__read', 'pruefen__d_bestellung__write', 'zahlen__d_register__read',
    ]);
    // references in first-occurrence order per step, steps in document order
    expect(lc.nodes.filter((n) => n._dataRef).map((n) => n.id))
      .toEqual(['pruefen__d_bestellung', 'pruefen__d_rechnungen', 'pruefen__d_register', 'zahlen__d_register', 'zahlen__d_bestellung']);
    expect(lc.nodes.map((n) => n.id).indexOf('ta')).toBe(6);
  });

  test('an empty dataAccess derives nothing: no associations key, no placeholder', () => {
    const { lc } = run(model21(access()));
    expect(lc).not.toHaveProperty('associations');
    expect(lc.nodes[2]).not.toHaveProperty('_dataProperty');
    expect(lc.nodes).toHaveLength(6);
  });
});

describe('resolveFields data: formLanes places the references', () => {
  const systemsCatalog = { ...fixture('bestellung-systeme-catalog.json'), data: DATA };
  const withSub = (m) => {
    m.nodes.push({ id: 'sp', type: 'subProcess', name: 'Teil', assignments: [{ type: 'D', actor: 'zahlung' }],
      nodes: [{ id: 'inner', type: 'userTask', name: 'Innen', dataAccess: [{ data: 'd_rechnungen', access: 'write' }] }] });
    m.edges.push({ source: 'zahlen', target: 'sp' });
    return m;
  };
  const edit = {
    pruefen: { dataAccess: [{ data: 'd_bestellung', access: 'read' }, { data: 'd_register', access: 'write' }] },
    rueck: { dataAccess: [{ data: 'd_bestellung' }] },
    zahlen: { dataAccess: [{ data: 'd_rechnungen', access: 'write' }] },
  };
  const cases = [
    ['rollen', 'role', () => withSub(model21(edit)), CATALOG],
    ['systeme', 'system', () => { const m = { ...fixture('bestellung-systeme.json') }; for (const n of m.nodes) if (edit[n.id]) Object.assign(n, edit[n.id]); return withSub(m); }, systemsCatalog],
    ['automatic lane', { by: 'role', automatic: 'lane' }, () => withSub(model21(edit)), CATALOG],
  ];
  for (const [label, lanes, build, catalog] of cases) {
    test(`${label}: each top-level reference in its step's lane, a nested one in none`, () => {
      const { lc, resolved, errors } = resolveFields(build(), { catalog: copy(catalog) });
      expect(errors).toEqual([]);
      const out = formLanes(lc, resolved, { lanes });
      expect(out.errors).toEqual([]);
      const refs = out.lc.nodes.filter((n) => n._dataRef);
      expect(refs.map((n) => n.id)).toEqual(['pruefen__d_bestellung', 'pruefen__d_register', 'rueck__d_bestellung', 'zahlen__d_rechnungen']);
      for (const ref of refs) {
        const step = out.lc.nodes.find((n) => n.id === ref.id.split('__')[0]);
        expect({ ref: ref.id, lane: ref.lane }).toEqual({ ref: ref.id, lane: step.lane });
        expect(typeof ref.lane).toBe('string');
      }
      const nested = out.lc.nodes.find((n) => n.id === 'sp').nodes.find((n) => n.id === 'inner__d_rechnungen');
      expect(nested).toBeDefined();
      expect(nested).not.toHaveProperty('lane');
    });
  }
});

describe('resolveFields data: C17', () => {
  const collide = (other) => `; rename ${other ? 'one of the steps or data items' : 'that id of the model'}`;
  test('an edge id equal to a reference', () => {
    const m = model21(access({ data: 'd_bestellung', access: 'read' }));
    m.edges[0].id = 'pruefen__d_bestellung';
    expect(run(m).errors).toEqual([`[C17] data id "pruefen__d_bestellung" (step "pruefen", data "d_bestellung") collides with "pruefen__d_bestellung"${collide()}`]);
  });

  test('a model id equal to the _di form of a reference, of a link; a model id equal to the _do form', () => {
    const m = model21(access({ data: 'd_bestellung', access: 'read' }));
    m.nodes.push({ id: 'pruefen__d_bestellung_di', type: 'task', name: 'X' });
    expect(run(m).errors).toEqual([`[C17] data id "pruefen__d_bestellung" (step "pruefen", data "d_bestellung") collides with "pruefen__d_bestellung_di"${collide()}`]);
    const l = model21(access({ data: 'd_bestellung', access: 'read' }));
    l.nodes.push({ id: 'pruefen__d_bestellung__read_di', type: 'task', name: 'X' });
    expect(run(l).errors).toEqual([`[C17] data id "pruefen__d_bestellung__read" (step "pruefen", data "d_bestellung") collides with "pruefen__d_bestellung__read_di"${collide()}`]);
    const d = model21(access({ data: 'd_bestellung', access: 'read' }));
    d.nodes.push({ id: 'pruefen__d_bestellung_do', type: 'task', name: 'X' });
    expect(run(d).errors).toEqual([`[C17] data id "pruefen__d_bestellung" (step "pruefen", data "d_bestellung") collides with "pruefen__d_bestellung_do"${collide()}`]);
  });

  test('a link against a model id; a near miss is none', () => {
    // step pruefen with data "di" gives "pruefen__di", which is not the _di form of "pruefen" ("pruefen_di")
    const catalog = { ...CATALOG, data: [...DATA, { id: 'di', name: 'Di', kind: 'object' }] };
    expect(run(model21(access({ data: 'di', access: 'write' })), catalog).errors).toEqual([]);
    const n = model21({ pruefen: { dataAccess: [{ data: 'd_bestellung', access: 'write' }] } });
    n.nodes.push({ id: 'pruefen__d_bestellung__write', type: 'task', name: 'X' });
    expect(run(n).errors).toEqual([`[C17] data id "pruefen__d_bestellung__write" (step "pruefen", data "d_bestellung") collides with "pruefen__d_bestellung__write"${collide()}`]);
  });

  test('the input placeholder, the DataObject and the DataStore against model ids', () => {
    const m = model21(access({ data: 'd_bestellung', access: 'read' }, { data: 'd_register', access: 'write' }));
    m.nodes.push({ id: 'pruefen__input', type: 'task', name: 'X' }, { id: `${P}__d_bestellung`, type: 'task', name: 'Y' }, { id: 'd_register__store', type: 'task', name: 'Z' });
    expect(run(m).errors).toEqual([
      `[C17] data id "pruefen__input" (input placeholder of step "pruefen") collides with "pruefen__input"${collide()}`,
      `[C17] data id "${P}__d_bestellung" (data object of data "d_bestellung" in process "${P}") collides with "${P}__d_bestellung"${collide()}`,
      `[C17] data id "d_register__store" (data store of data "d_register") collides with "d_register__store"${collide()}`,
    ]);
  });

  test('two derived ids: step a__b with data c against step a with data b__c', () => {
    const catalog = { ...CATALOG, data: [...DATA, { id: 'c', name: 'C', kind: 'object' }, { id: 'b__c', name: 'BC', kind: 'object' }] };
    const m = model21();
    m.nodes.push({ id: 'a__b', type: 'task', name: 'AB', dataAccess: [{ data: 'c' }] }, { id: 'a', type: 'task', name: 'A', dataAccess: [{ data: 'b__c' }] });
    expect(run(m, catalog).errors).toEqual([
      `[C17] data id "a__b__c" (step "a", data "b__c") collides with the data id of step "a__b", data "c"${collide(true)}`,
      `[C17] data id "a__b__c__link" (step "a", data "b__c") collides with the data id of step "a__b", data "c"${collide(true)}`,
    ]);
  });

  test('a data id "input": the reference against the placeholder of its step', () => {
    const catalog = { ...CATALOG, data: [...DATA, { id: 'input', name: 'Eingabe', kind: 'object' }] };
    expect(run(model21(access({ data: 'input', access: 'read' })), catalog).errors)
      .toEqual([`[C17] data id "pruefen__input" (step "pruefen", data "input") collides with the input placeholder of step "pruefen"${collide(true)}`]);
    // without a read there is no placeholder
    expect(run(model21(access({ data: 'input', access: 'write' })), catalog).errors).toEqual([]);
  });

  test('a data id "d__read": its reference against the read link of the step and d', () => {
    const catalog = { ...CATALOG, data: [...DATA, { id: 'd_bestellung__read', name: 'Gelesen', kind: 'object' }] };
    expect(run(model21(access({ data: 'd_bestellung', access: 'read' }, { data: 'd_bestellung__read', access: 'write' })), catalog).errors)
      .toEqual([`[C17] data id "pruefen__d_bestellung__read" (step "pruefen", data "d_bestellung") collides with the data id of step "pruefen", data "d_bestellung__read"${collide(true)}`]);
  });

  test('the _do form of a reference against another reference (the 1.x regeneration path)', () => {
    const catalog = { ...CATALOG, data: [...DATA, { id: 'd_bestellung_do', name: 'Kopie', kind: 'object' }] };
    expect(run(model21(access({ data: 'd_bestellung', access: 'write' }, { data: 'd_bestellung_do', access: 'write' })), catalog).errors)
      .toEqual([`[C17] data id "pruefen__d_bestellung_do" (step "pruefen", data "d_bestellung_do") collides with the data id of step "pruefen", data "d_bestellung"${collide(true)}`]);
  });

  test('two DataObjects of different processes and items with one id', () => {
    const catalog = { ...CATALOG, data: [...DATA, { id: 'c', name: 'C', kind: 'object' }, { id: 'b__c', name: 'BC', kind: 'object' }] };
    const pooled = { $schemaVersion: '2.1', pools: [
      { id: 'A__b', name: 'AB', nodes: [{ id: 's', type: 'userTask', name: 'S', dataAccess: [{ data: 'c', access: 'write' }] }], edges: [] },
      { id: 'A', name: 'A', nodes: [{ id: 't', type: 'userTask', name: 'T', dataAccess: [{ data: 'b__c', access: 'write' }] }], edges: [] },
    ] };
    expect(run(pooled, catalog).errors)
      .toEqual([`[C17] data id "A__b__c" (data object of data "b__c" in process "A") collides with the data object of data "c" in process "A__b"${collide(true)}`]);
  });

  test('one DataObject and one DataStore shared by several steps are no collision', () => {
    const { errors, lc } = run(model21({
      pruefen: { dataAccess: [{ data: 'd_bestellung', access: 'read' }, { data: 'd_register', access: 'write' }] },
      rueck: { dataAccess: [{ data: 'd_bestellung', access: 'write' }, { data: 'd_register', access: 'read' }] },
    }));
    expect(errors).toEqual([]);
    expect(lc.nodes.filter((n) => n._dataObject).map((n) => n._dataObject)).toEqual([`${P}__d_bestellung`, `${P}__d_bestellung`]);
  });

  test('no C17 from an inline actor or system whose id equals a derived id: only document ids count', () => {
    const m = model21(access({ data: 'd_bestellung', access: 'read' }), {
      actors: [{ id: 'pruefen__d_bestellung', name: 'Doppelt', kind: 'role', unit: 'abt_einkauf' }],
      systems: [{ id: 'pruefen__d_bestellung__read', name: 'System' }],
    });
    const { errors, lc } = run(m);
    expect(errors).toEqual([]);
    expect(node(lc, 'pruefen__d_bestellung')).toBeDefined();
  });

  test('C17 findings drop the hints and the intermediate form', () => {
    const catalog = { ...CATALOG, data: [...DATA, { id: 'input', name: 'Eingabe' }] };
    expect(run(model21(access({ data: 'input', access: 'read' })), catalog)).toEqual({
      lc: null, resolved: null, hints: [],
      errors: [`[C17] data id "pruefen__input" (step "pruefen", data "input") collides with the input placeholder of step "pruefen"${collide(true)}`],
    });
  });
});
