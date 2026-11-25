import { describe, test, expect } from '@jest/globals';
import { resolveFields } from './model-v2.js';
import { catalogFingerprint, resolveScheme } from '../shared/catalog.js';

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
const PINNED = 'sha256:1839c85404873913d420764884aa77ed37f54a3341df18b7e641c0f85f70c9a4';

const MODEL = {
  $schemaVersion: '2.0', catalog: '../bpmn-catalog.json', id: 'Process_Schaden', name: 'Schaden regulieren',
  nodes: [
    { id: 'start', type: 'startEvent', name: 'Schaden gemeldet' },
    { id: 'gw', type: 'exclusiveGateway', name: 'Regress möglich?' },
    { id: 'pruefen', type: 'userTask', name: 'Schaden prüfen', assignments: [{ type: 'D', actor: 'sb_schaden' }] },
    { id: 'regr', type: 'userTask', name: 'Regress prüfen', assignments: [{ type: 'D', actor: 'regress' }, { type: 'I', actor: 'sb_schaden' }] },
    { id: 'zahlen', type: 'userTask', name: 'Zahlung anweisen', assignments: [{ type: 'D', actor: 'zahlung' }] },
    { id: 'end', type: 'endEvent', name: 'Schaden reguliert' },
  ],
  edges: [
    { source: 'start', target: 'pruefen' }, { source: 'pruefen', target: 'gw' },
    { source: 'gw', target: 'regr', label: 'ja' }, { source: 'gw', target: 'zahlen', label: 'nein' },
    { source: 'regr', target: 'zahlen' }, { source: 'zahlen', target: 'end' },
  ],
};

const copy = (v) => JSON.parse(JSON.stringify(v));
const withNodes = (nodes, extra = {}) => ({ ...copy(MODEL), nodes, edges: [], ...extra });
const task = (id, assignments) => ({ id, type: 'userTask', name: id, assignments });
const run = (model, catalog = CATALOG) => resolveFields(model, { catalog: catalog ? copy(catalog) : undefined });

describe('resolveFields', () => {
  test('the 5.6 model with the 5.6 catalogue resolves', () => {
    const model = copy(MODEL); const catalog = copy(CATALOG);
    const snapshots = [JSON.stringify(model), JSON.stringify(catalog)];
    const { lc, resolved, errors } = resolveFields(model, { catalog });
    expect(errors).toEqual([]);
    expect(resolved.performsType).toBe('D');
    expect(resolved.fingerprint).toBe(PINNED);
    expect(resolved.order.get('zahlung')).toBe(4);
    expect(resolved.byId.get('regress').name).toBe('Regressspezialist');
    expect(lc._modelInfo).toEqual({ version: '2.0', view: 'default', catalogFingerprint: PINNED });
    const regr = lc.nodes.find((n) => n.id === 'regr');
    expect(regr._assignments).toEqual([{ type: 'D', actor: 'regress' }, { type: 'I', actor: 'sb_schaden' }]);
    expect(regr).not.toHaveProperty('assignments');
    for (const key of ['actors', 'scheme', 'catalog', '$schemaVersion']) expect(lc).not.toHaveProperty(key);
    expect([JSON.stringify(model), JSON.stringify(catalog)]).toEqual(snapshots);
  });

  test('a model carrying actors and scheme itself resolves to the same fingerprint', () => {
    const { catalog: _drop, ...rest } = copy(MODEL);
    const { resolved, errors } = resolveFields({ ...rest, ...copy(CATALOG) });
    expect(errors).toEqual([]);
    expect(resolved.fingerprint).toBe(PINNED);
  });

  test('no catalogue and no assignments resolves against an empty catalogue and demi', () => {
    const { catalog: _drop, ...rest } = copy(MODEL);
    const model = { ...rest, nodes: [{ id: 'a', type: 'userTask', name: 'A' }], edges: [] };
    const { resolved, errors } = resolveFields(model);
    expect(errors).toEqual([]);
    expect(resolved.actors).toEqual([]);
    expect(resolved.fingerprint).toBe(catalogFingerprint([], resolveScheme()));
  });

  test('viewName ends up in _modelInfo', () => {
    expect(resolveFields(copy(MODEL), { catalog: copy(CATALOG), viewName: 'rollen' }).lc._modelInfo.view).toBe('rollen');
  });

  test('format errors', () => {
    const { errors, lc, resolved } = resolveFields({ $schemaVersion: '2.0', nodes: 5 });
    expect(lc).toBeNull(); expect(resolved).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.startsWith('[format 2.0] '))).toBe(true);
  });

  test('catalogue and model actors together', () => {
    const { catalog: _drop, ...rest } = copy(MODEL);
    expect(run({ ...rest, ...copy(CATALOG) }).errors).toEqual(['[catalog] the model carries actors and a catalogue was passed; replacing entries comes in a later version']);
  });

  test('a catalogue path without a catalogue object', () => {
    expect(run(copy(MODEL), null).errors).toEqual(['[catalog] the model names catalogue "../bpmn-catalog.json" but no catalogue object was passed — the CLI reads it relative to the model file, a library caller passes { catalog }']);
  });

  test('a bad catalogue object gives [catalog] lines', () => {
    const errors = run(copy(MODEL), { actors: [{ id: '1bad', name: 'x' }] }).errors;
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.startsWith('[catalog] '))).toBe(true);
  });

  test('C06 unknown scheme name', () => {
    expect(run(copy(MODEL), { ...CATALOG, scheme: 'raci' }).errors).toEqual(['[C06] responsibility scheme "raci" is unknown (shipped: demi)']);
  });

  test('C06 performs count and duplicate key', () => {
    const scheme = { scheme: 'own', types: [{ key: 'A', label: 'a' }, { key: 'A', label: 'b' }] };
    expect(run(copy(MODEL), { ...CATALOG, scheme }).errors).toEqual([
      '[C06] scheme "own" must have exactly one type with performs (has 0)',
      '[C06] scheme "own" has type key "A" twice',
    ]);
  });

  test('C03 duplicate id', () => {
    const catalog = { actors: [...CATALOG.actors, { id: 'regress', name: 'Zweiter' }] };
    expect(run(copy(MODEL), catalog).errors).toEqual(['[C03] actor id "regress" occurs 2 times in the catalogue']);
  });

  test('C01 unknown actor, also inside a subprocess and a pool', () => {
    const sub = { id: 'sp', type: 'subProcess', name: 'sp', isExpanded: true, nodes: [task('inner', [{ type: 'D', actor: 'ghost' }])], edges: [] };
    expect(run(withNodes([sub])).errors).toEqual(['[C01] node "inner": actor "ghost" is not in the catalogue']);
    const pooled = { $schemaVersion: '2.0', pools: [{ id: 'P1', name: 'P', nodes: [task('t', [{ type: 'D', actor: 'ghost' }])], edges: [] }] };
    expect(run(pooled).errors).toEqual(['[C01] node "t": actor "ghost" is not in the catalogue']);
  });

  describe('assignments without any catalogue given', () => {
    const NONE = '[C01] the model has assignments but no actor catalogue was given; pass one with --catalog=<path>, the "catalog" field of the process file or the catalog option of runPipeline';
    const { catalog: _drop, ...bare } = MODEL;

    test('exactly one leading error, not one C01 line per assignment', () => {
      const { lc, resolved, errors } = resolveFields(copy(bare));
      expect(errors).toEqual([NONE]);
      expect(lc).toBeNull(); expect(resolved).toBeNull();
    });

    test('also with a catalogue option of null', () => {
      expect(resolveFields(copy(bare), { catalog: null }).errors).toEqual([NONE]);
    });

    test('a catalogue with an empty actors list is given: one C01 line per assignment', () => {
      const errors = resolveFields(copy(bare), { catalog: { actors: [] } }).errors;
      expect(errors).toHaveLength(4);
      expect(errors.every((e) => /^\[C01\] node "\w+": actor "\w+" is not in the catalogue$/.test(e))).toBe(true);
    });

    test('a model with an empty actors list is given too', () => {
      const errors = resolveFields({ ...copy(bare), actors: [] }).errors;
      expect(errors).toHaveLength(4);
      expect(errors).not.toContain(NONE);
    });

    test('an empty catalogue object {} is given but invalid: [catalog] lines, not the no-catalogue error', () => {
      const errors = resolveFields(copy(bare), { catalog: {} }).errors;
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((e) => e.startsWith('[catalog] '))).toBe(true);
    });
  });

  test('C01 unknown unit', () => {
    const catalog = { actors: [{ id: 'r', name: 'R', kind: 'role', unit: 'nowhere' }] };
    expect(run(withNodes([task('t', [])]), catalog).errors).toEqual(['[C01] actor "r": unit "nowhere" is not in the catalogue']);
  });

  test('C02 unit that is a role; a kind-less target is allowed', () => {
    const bad = { actors: [{ id: 'a', name: 'A', kind: 'role' }, { id: 'b', name: 'B', kind: 'role', unit: 'a' }] };
    expect(run(withNodes([task('t', [])]), bad).errors).toEqual(['[C02] actor "b": unit "a" is a role, not a unit']);
    const ok = { actors: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', kind: 'role', unit: 'a' }] };
    expect(run(withNodes([task('t', [])]), ok).errors).toEqual([]);
  });

  test('C04 unknown type and several performers', () => {
    expect(run(withNodes([task('t', [{ type: 'X', actor: 'regress' }])])).errors).toEqual(['[C04] node "t": type "X" is not in scheme "demi"']);
    expect(run(withNodes([task('t', [{ type: 'D', actor: 'regress' }, { type: 'D', actor: 'zahlung' }])])).errors).toEqual(['[C04] node "t" has 2 performers; at most one']);
  });

  test('C05 non-performer type on an event or a gateway', () => {
    const nodes = [
      { id: 'e', type: 'startEvent', name: 'e', assignments: [{ type: 'I', actor: 'regress' }] },
      { id: 'g', type: 'exclusiveGateway', name: 'g?', assignments: [{ type: 'E', actor: 'regress' }] },
    ];
    expect(run(withNodes(nodes)).errors).toEqual([
      '[C05] event "e": only the performer type "D" is allowed, not "I"',
      '[C05] gateway "g": only the performer type "D" is allowed, not "E"',
    ]);
  });

  test('assignments inside a subprocess are carried at every depth', () => {
    const sub = { id: 'sp', type: 'subProcess', name: 'sp', isExpanded: true, nodes: [task('inner', [{ type: 'D', actor: 'regress' }])], edges: [] };
    const { lc, errors } = run(withNodes([sub]));
    expect(errors).toEqual([]);
    expect(lc.nodes[0].nodes[0]._assignments).toEqual([{ type: 'D', actor: 'regress' }]);
    expect(lc.nodes[0].nodes[0]).not.toHaveProperty('assignments');
  });
});
