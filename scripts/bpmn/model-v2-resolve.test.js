import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
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

const simpleApproval = () => JSON.parse(readFileSync(new URL('../../tests/fixtures/simple-approval.json', import.meta.url), 'utf8'));
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
    expect(errors.every((e) => e.startsWith('[F01] '))).toBe(true);
  });

  test('an annotation with assignments: exactly one F01 entry', () => {
    const m = withNodes([{ id: 'ta', type: 'textAnnotation', assignments: [] }]);
    expect(run(m).errors).toEqual(['[F01] /nodes/0/assignments is not allowed here']);
  });

  test('options null behave as no options', () => {
    expect(resolveFields(copy(MODEL), null)).toEqual(resolveFields(copy(MODEL)));
    expect(resolveFields(withNodes([task('t', [])], { catalog: undefined }), null).errors).toEqual([]);
  });

  test('resolved.scheme is a clone: changing it leaves the caller catalogue alone', () => {
    const scheme = { scheme: 'own', types: [{ key: 'A', label: 'a', performs: true }] };
    const catalog = { actors: [], scheme };
    const { resolved } = resolveFields(withNodes([task('t', [])]), { catalog });
    resolved.scheme.types[0].label = 'changed';
    resolved.scheme.types.push({ key: 'B', label: 'b' });
    expect(scheme).toEqual({ scheme: 'own', types: [{ key: 'A', label: 'a', performs: true }] });
    expect(catalog.scheme).toBe(scheme);
  });

  test('model-carried actors that pass the format schema but fail the catalogue bounds give [C12]', () => {
    const { catalog: _drop, ...rest } = copy(MODEL);
    const actors = Array.from({ length: 5000 }, (_, i) => ({ id: `a${i}`, name: 'x'.repeat(200) }));
    expect(resolveFields({ ...rest, actors }).errors).toEqual(['[C12] "/" is larger than 1024 KiB']);
  });

  test('a 1.x model is not a format 2.0 model: the text carries no code', () => {
    expect(resolveFields(simpleApproval()).errors).toEqual(['this is not a format 2.0 model ($schemaVersion absent)']);
    expect(resolveFields({ ...simpleApproval(), $schemaVersion: '1.2' }).errors).toEqual(['this is not a format 2.0 model ($schemaVersion "1.2")']);
  });

  test('scheme beside a catalogue object is C13', () => {
    const { catalog: _drop, ...rest } = copy(MODEL);
    expect(run({ ...rest, actors: [{ id: 'x', name: 'X' }], scheme: 'demi' }).errors)
      .toEqual(['[C13] the process file cannot change the responsibility scheme of the catalogue']);
  });

  test('a catalogue path without a catalogue object', () => {
    expect(run(copy(MODEL), null).errors).toEqual(['[C13] the model names catalogue "../bpmn-catalog.json" but no catalogue object was passed — the CLI reads it relative to the model file, a library caller passes { catalog }']);
  });

  test('a bad catalogue object gives [C12] lines', () => {
    const errors = run(copy(MODEL), { actors: [{ id: '1bad', name: 'x' }] }).errors;
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.startsWith('[C12] '))).toBe(true);
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
    const NONE = '[C01] the model has assignments but no actor catalogue was given; pass one with --catalog=<path>, the "catalog" field of the process file, the catalog option of runPipeline or the `catalog` object of an MCP or HTTP request';
    const { catalog: _drop, ...bare } = MODEL;

    test('exactly one leading error, not one C01 line per assignment', () => {
      const { lc, resolved, errors } = resolveFields(copy(bare));
      expect(errors).toEqual([NONE]);
      expect(lc).toBeNull(); expect(resolved).toBeNull();
    });

    test('scheme-only errors (C04, C05) still show, after the one leading error and without C01 lines', () => {
      const model = withNodes([
        task('two', [{ type: 'D', actor: 'a' }, { type: 'D', actor: 'b' }]),
        task('odd', [{ type: 'X', actor: 'a' }]),
        { id: 'ev', type: 'startEvent', name: 'ev', assignments: [{ type: 'I', actor: 'a' }] },
      ]);
      delete model.catalog;
      const { errors } = resolveFields(model);
      expect(errors[0]).toBe(NONE);
      expect(errors.some((e) => /not in the catalogue/.test(e))).toBe(false);
      expect(errors).toContain('[C04] node "two" has 2 performers; at most one');
      expect(errors.some((e) => e.startsWith('[C04] node "odd": type "X"'))).toBe(true);
      expect(errors.some((e) => e.startsWith('[C05] event "ev"'))).toBe(true);
      // the same scheme-only lines appear with a catalogue
      const withCat = resolveFields(model, { catalog: { actors: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } }).errors;
      expect(errors.slice(1)).toEqual(withCat);
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

    test('an empty catalogue object {} is given but invalid: [C12] lines, not the no-catalogue error', () => {
      const errors = resolveFields(copy(bare), { catalog: {} }).errors;
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((e) => e.startsWith('[C12] '))).toBe(true);
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

  test('C04 and C05 are found inside a subprocess', () => {
    const sub = { id: 'sp', type: 'subProcess', name: 'sp', isExpanded: true, edges: [], nodes: [
      task('inner', [{ type: 'X', actor: 'regress' }]),
      { id: 'ie', type: 'startEvent', name: 'ie', assignments: [{ type: 'I', actor: 'regress' }] },
    ] };
    expect(run(withNodes([sub])).errors).toEqual([
      '[C04] node "inner": type "X" is not in scheme "demi"',
      '[C05] event "ie": only the performer type "D" is allowed, not "I"',
    ]);
  });

  test('C04 and C05 stay silent when C06 fails', () => {
    const nodes = [
      task('t', [{ type: 'X', actor: 'regress' }, { type: 'X', actor: 'zahlung' }]),
      { id: 'e', type: 'startEvent', name: 'e', assignments: [{ type: 'I', actor: 'regress' }] },
    ];
    const scheme = { scheme: 'own', types: [{ key: 'A', label: 'a' }] };
    const errors = run(withNodes(nodes), { ...CATALOG, scheme }).errors;
    expect(errors).toEqual(['[C06] scheme "own" must have exactly one type with performs (has 0)']);
  });

  test('assignments inside a subprocess are carried at every depth', () => {
    const sub = { id: 'sp', type: 'subProcess', name: 'sp', isExpanded: true, nodes: [task('inner', [{ type: 'D', actor: 'regress' }])], edges: [] };
    const { lc, errors } = run(withNodes([sub]));
    expect(errors).toEqual([]);
    expect(lc.nodes[0].nodes[0]._assignments).toEqual([{ type: 'D', actor: 'regress' }]);
    expect(lc.nodes[0].nodes[0]).not.toHaveProperty('assignments');
  });
});

describe('organigram: partOf, parentOf, isUnit, unitChain', () => {
  const org = (...actors) => run(withNodes([{ id: 'start', type: 'startEvent', name: 'S' }]), { actors });
  const u = (id, partOf) => ({ id, name: id, kind: 'unit', ...(partOf ? { partOf } : {}) });

  test('a catalogue without partOf keeps its fingerprint', () => {
    const { resolved } = run(MODEL);
    expect(resolved.fingerprint).toBe(PINNED);
    expect(resolved.parentOf.size).toBe(0);
  });

  test('unitChain of a depth-3 unit runs root first and ends with the unit', () => {
    const { resolved, errors } = org(u('a'), u('b', 'a'), u('c', 'b'), { id: 'r', name: 'R', kind: 'role', unit: 'c' });
    expect(errors).toEqual([]);
    expect(resolved.unitChain('c')).toEqual(['a', 'b', 'c']);
    expect(resolved.unitChain('a')).toEqual(['a']);
    expect(resolved.parentOf.get('c')).toBe('b');
  });

  test('isUnit: kind unit, or kind-less and named as unit or partOf', () => {
    const { resolved } = org(
      { id: 'k1', name: 'K1' }, { id: 'k2', name: 'K2' }, { id: 'k3', name: 'K3' },
      { id: 'x', name: 'X', unit: 'k1' }, { id: 'y', name: 'Y', partOf: 'k2' }, u('real'),
      { id: 'role', name: 'Role', kind: 'role' },
    );
    expect(['k1', 'k2', 'k3', 'real', 'role', 'x', 'nope'].map((id) => resolved.isUnit(id))).toEqual([true, true, false, true, false, false, false]);
  });

  test('partOf to a missing actor is C01, to a role is C02', () => {
    expect(org(u('a', 'ghost')).errors).toEqual(['[C01] actor "a": partOf "ghost" is not in the catalogue']);
    expect(org({ id: 'r', name: 'R', kind: 'role' }, u('a', 'r')).errors).toEqual(['[C02] actor "a": partOf "r" is a role, not a unit']);
  });

  test('a self-cycle gives one C07', () => {
    expect(org(u('a', 'a')).errors).toEqual(['[C07] unit "a": partOf forms a cycle (a \u2192 a)']);
  });

  test('a two-cycle gives one C07, named at its first member in catalogue order', () => {
    expect(org(u('a', 'b'), u('b', 'a')).errors).toEqual(['[C07] unit "a": partOf forms a cycle (a \u2192 b \u2192 a)']);
  });

  test('a cycle behind a chain gives exactly one C07, none for the chain', () => {
    const { errors } = org(u('t1', 't2'), u('t2', 'c'), u('c', 'd'), u('d', 'c'));
    expect(errors).toEqual(['[C07] unit "c": partOf forms a cycle (c \u2192 d \u2192 c)']);
  });

  test('two separate cycles give two C07', () => {
    expect(org(u('a', 'a'), u('b', 'c'), u('c', 'b')).errors).toHaveLength(2);
  });
});

describe('resolveFields — the process file replaces and adds catalogue entries', () => {
  const REGRESS = { id: 'regress', name: 'Regress (lokal)', kind: 'role', unit: 'abt_finanzen' };
  const deepFreeze = (v) => { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };
  const withActors = (actors) => ({ ...copy(MODEL), actors });
  const resolveWith = (actors) => resolveFields(deepFreeze(withActors(actors)), { catalog: deepFreeze(copy(CATALOG)), viewName: 'einheiten' });

  test('an actor of the catalogue is replaced in place; one H09; fingerprint over the effective list', () => {
    const { resolved, errors, hints } = resolveWith([REGRESS]);
    expect(errors).toEqual([]);
    expect(resolved.actors.map((a) => a.id)).toEqual(['abt_schaden', 'abt_finanzen', 'sb_schaden', 'regress', 'zahlung']);
    expect(resolved.byId.get('regress')).toEqual(REGRESS);
    expect(resolved.order.get('regress')).toBe(3);
    expect(resolved.parentOf.size).toBe(0);
    expect(hints).toEqual([{ code: 'H09', message: 'Catalogue entry "regress" is replaced by the process file.', elements: ['regress'] }]);
    expect(resolved.fingerprint).not.toBe(PINNED);
    expect(resolved.fingerprint).toBe(catalogFingerprint(resolved.actors, resolveScheme('demi')));
  });

  test('a new id is appended, no hint', () => {
    const extra = { id: 'neu', name: 'Neu', kind: 'role', unit: 'abt_finanzen' };
    const { resolved, errors, hints } = resolveWith([extra]);
    expect(errors).toEqual([]);
    expect(hints).toEqual([]);
    expect(resolved.actors.map((a) => a.id)).toEqual(['abt_schaden', 'abt_finanzen', 'sb_schaden', 'regress', 'zahlung', 'neu']);
    expect(resolved.order.get('neu')).toBe(5);
  });

  test('hints come in model order', () => {
    const { hints, resolved } = resolveWith([{ id: 'zahlung', name: 'Z2', kind: 'role' }, { id: 'neu', name: 'N' }, REGRESS]);
    expect(hints.map((h) => h.elements[0])).toEqual(['zahlung', 'regress']);
    expect(resolved.actors.map((a) => a.id)).toEqual(['abt_schaden', 'abt_finanzen', 'sb_schaden', 'regress', 'zahlung', 'neu']);
  });

  test('a plain catalogue keeps its fingerprint and has no hints', () => {
    const { resolved, hints } = resolveFields(copy(MODEL), { catalog: copy(CATALOG) });
    expect(resolved.fingerprint).toBe(PINNED);
    expect(hints).toEqual([]);
  });

  test('C02 is judged on the effective catalogue: the model turns a unit into a role: C02 for the actor that names it', () => {
    const { errors, resolved } = resolveWith([{ id: 'abt_schaden', name: 'Schaden', kind: 'role' }]);
    expect(resolved).toBeNull();
    expect(errors).toEqual(expect.arrayContaining(['[C02] actor "sb_schaden": unit "abt_schaden" is a role, not a unit']));
  });

  test('C01 on the effective list: a replaced actor names an unknown unit', () => {
    expect(resolveWith([{ ...REGRESS, unit: 'nirgends' }]).errors).toEqual(['[C01] actor "regress": unit "nirgends" is not in the catalogue']);
  });

  test('C03 counts duplicates inside the model\'s own actors only', () => {
    expect(resolveWith([REGRESS, REGRESS]).errors).toEqual(expect.arrayContaining([expect.stringMatching(/^\[C03\] actor id "regress" occurs 2 times/)]));
    expect(resolveWith([REGRESS]).errors).toEqual([]);
  });

  test('C07 on the effective list: the model closes a partOf cycle', () => {
    const { errors } = resolveWith([{ id: 'abt_schaden', name: 'S', kind: 'unit', partOf: 'abt_finanzen' }, { id: 'abt_finanzen', name: 'F', kind: 'unit', partOf: 'abt_schaden' }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^\[C07\] /);
  });

  test('the unit view puts regr into Finanzen after the replacement', () => {
    const { resolved } = resolveWith([REGRESS]);
    expect(resolved.byId.get('regress').unit).toBe('abt_finanzen');
    expect(resolved.isUnit('abt_finanzen')).toBe(true);
  });

  test('the caller\'s objects are not changed (frozen input passes)', () => {
    expect(() => resolveWith([REGRESS])).not.toThrow();
  });
});

describe('resolveFields and language', () => {
  test('the intermediate form keeps language', () => {
    const { lc, errors } = resolveFields({ ...copy(MODEL), language: 'de' }, { catalog: copy(CATALOG) });
    expect(errors).toEqual([]);
    expect(lc.language).toBe('de');
  });
});

describe('resolveFields — systems (format 2.1)', () => {
  const SYSTEMS = [{ id: 'sys_akte', name: 'Schadenakte' }];
  const CATALOG_S = { ...CATALOG, systems: SYSTEMS };
  const NO_CATALOG_C14 = '[C14] the model names systems but no catalogue was given; pass one with --catalog=<path>, the "catalog" field of the process file, the catalog option of runPipeline or the `catalog` object of an MCP or HTTP request';
  const NO_CATALOG_C01 = '[C01] the model has assignments but no actor catalogue was given; pass one with --catalog=<path>, the "catalog" field of the process file, the catalog option of runPipeline or the `catalog` object of an MCP or HTTP request';
  const deepFreeze = (v) => { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };
  /** The 5.6 model as "2.1"; `edit` changes nodes by id. */
  const model21 = (edit = {}, extra = {}) => {
    const m = { ...copy(MODEL), $schemaVersion: '2.1', ...extra };
    for (const n of m.nodes) if (edit[n.id]) Object.assign(n, edit[n.id]);
    return m;
  };
  const bare = (m) => { const { catalog: _drop, ...rest } = m; return rest; };

  test('a task names a catalogue system: the intermediate form carries its name and a private ref', () => {
    const model = deepFreeze(model21({ pruefen: { system: 'sys_akte' } }));
    const catalog = deepFreeze(copy(CATALOG_S));
    const { lc, resolved, errors, hints } = resolveFields(model, { catalog });
    expect(errors).toEqual([]);
    expect(hints).toEqual([]);
    const pruefen = lc.nodes.find((n) => n.id === 'pruefen');
    expect(pruefen.system).toBe('Schadenakte');
    expect(pruefen._systemRef).toBe('sys_akte');
    expect(lc).not.toHaveProperty('systems');
    expect(lc._modelInfo.version).toBe('2.1');
    expect(resolved.systems).toEqual(SYSTEMS);
    expect(resolved.systemById.get('sys_akte')).toEqual(SYSTEMS[0]);
    expect(resolved.systemOrder.get('sys_akte')).toBe(0);
    expect(resolved.fingerprint).toBe(catalogFingerprint(resolved.actors, resolveScheme('demi'), SYSTEMS));
    expect(resolved.fingerprint).not.toBe(PINNED);
    expect(lc.nodes.find((n) => n.id === 'regr')).not.toHaveProperty('_systemRef');
  });

  test('a "2.1" model without systems keeps the pinned fingerprint; an empty systems list too', () => {
    expect(resolveFields(model21(), { catalog: copy(CATALOG) }).resolved.fingerprint).toBe(PINNED);
    const { resolved, lc } = resolveFields(model21(), { catalog: { ...copy(CATALOG), systems: [] } });
    expect(resolved.fingerprint).toBe(PINNED);
    expect(resolved.systems).toEqual([]);
    expect(lc._modelInfo.catalogFingerprint).toBe(PINNED);
  });

  test('C03: a system id twice in the catalogue, twice in the process file, and an id both actor and system', () => {
    expect(run(model21(), { ...CATALOG, systems: [...SYSTEMS, { id: 'sys_akte', name: 'Zweite' }] }).errors)
      .toEqual(['[C03] system id "sys_akte" occurs 2 times in the catalogue']);
    expect(run(model21({}, { systems: [...SYSTEMS, ...SYSTEMS] }), CATALOG).errors)
      .toEqual(['[C03] system id "sys_akte" occurs 2 times in the systems of the process file']);
    expect(run(model21(), { ...CATALOG, systems: [{ id: 'regress', name: 'Regress-System' }] }).errors)
      .toEqual(['[C03] id "regress" is both an actor and a system in the catalogue']);
    // the shared id space spans the effective lists: a model system meets a catalogue actor
    expect(run(model21({}, { systems: [{ id: 'zahlung', name: 'Zahlungssystem' }] }), CATALOG).errors)
      .toEqual(['[C03] id "zahlung" is both an actor and a system in the catalogue']);
  });

  test('C01: an assignment, a unit or a partOf naming a system says so', () => {
    expect(run(model21({ pruefen: { assignments: [{ type: 'D', actor: 'sys_akte' }] } }), CATALOG_S).errors)
      .toEqual(['[C01] node "pruefen": actor "sys_akte" is a system, not an actor']);
    const catalog = { ...CATALOG_S, actors: [...CATALOG.actors, { id: 'r', name: 'R', kind: 'role', unit: 'sys_akte' }, { id: 'u', name: 'U', kind: 'unit', partOf: 'sys_akte' }] };
    expect(run(model21(), catalog).errors).toEqual([
      '[C01] actor "r": unit "sys_akte" is a system, not a unit',
      '[C01] actor "u": partOf "sys_akte" is a system, not a unit',
    ]);
  });

  test('C14: an unknown system, an actor named as system', () => {
    expect(run(model21({ pruefen: { system: 'sys_crm' } }), CATALOG_S).errors)
      .toEqual(['[C14] node "pruefen": system "sys_crm" is not in the catalogue']);
    expect(run(model21({ pruefen: { system: 'regress' } }), CATALOG_S).errors)
      .toEqual(['[C14] node "pruefen": "regress" is an actor, not a system']);
  });

  test('C14 inside a subprocess and a pool', () => {
    const sub = { id: 'sp', type: 'subProcess', name: 'sp', isExpanded: true, nodes: [{ id: 'inner', type: 'serviceTask', name: 'inner', system: 'ghost' }], edges: [] };
    expect(run({ ...withNodes([sub]), $schemaVersion: '2.1' }, CATALOG_S).errors).toEqual(['[C14] node "inner": system "ghost" is not in the catalogue']);
    const pooled = { $schemaVersion: '2.1', pools: [{ id: 'P1', name: 'P', nodes: [{ id: 't', type: 'userTask', name: 't', system: 'ghost' }], edges: [] }] };
    expect(run(pooled, CATALOG_S).errors).toEqual(['[C14] node "t": system "ghost" is not in the catalogue']);
  });

  test('C15: a system on a gateway or on a subprocess', () => {
    expect(run(model21({ gw: { system: 'sys_akte' } }), CATALOG_S).errors)
      .toEqual(['[C15] node "gw": a system belongs on a task, not on exclusiveGateway']);
    const sub = { id: 'sp', type: 'subProcess', name: 'sp', isExpanded: true, system: 'sys_akte',
      nodes: [{ id: 'inner', type: 'userTask', name: 'inner', system: 'sys_akte' }], edges: [] };
    expect(run({ ...withNodes([sub]), $schemaVersion: '2.1' }, CATALOG_S).errors)
      .toEqual(['[C15] node "sp": a system belongs on a task, not on subProcess']);
    expect(run(model21({ start: { system: 'sys_akte' } }), CATALOG_S).errors)
      .toEqual(['[C15] node "start": a system belongs on a task, not on startEvent']);
  });

  test('the process file replaces a catalogue system in place: H09 after the actors\' H09; a new id is appended', () => {
    const own = [{ id: 'neu', name: 'Neues System' }, { id: 'sys_akte', name: 'Akte (lokal)' }];
    const actors = [{ id: 'regress', name: 'Regress (lokal)', kind: 'role', unit: 'abt_finanzen' }];
    const catalog = deepFreeze({ ...copy(CATALOG), systems: [...SYSTEMS, { id: 'sys_zwei', name: 'Zwei' }] });
    const model = deepFreeze(model21({ pruefen: { system: 'sys_akte' } }, { systems: own, actors }));
    const { lc, resolved, errors, hints } = resolveFields(model, { catalog });
    expect(errors).toEqual([]);
    expect(resolved.systems.map((s) => s.id)).toEqual(['sys_akte', 'sys_zwei', 'neu']);
    expect(resolved.systemOrder.get('neu')).toBe(2);
    expect(lc.nodes.find((n) => n.id === 'pruefen').system).toBe('Akte (lokal)');
    expect(hints).toEqual([
      { code: 'H09', message: 'Catalogue entry "regress" is replaced by the process file.', elements: ['regress'] },
      { code: 'H09', message: 'Catalogue entry "sys_akte" is replaced by the process file.', elements: ['sys_akte'] },
    ]);
  });

  test('systems only in the model and no catalogue: resolves', () => {
    const model = bare(model21({ pruefen: { system: 'sys_akte', assignments: undefined } }, { systems: SYSTEMS }));
    for (const n of model.nodes) delete n.assignments;
    const { lc, resolved, errors } = resolveFields(model);
    expect(errors).toEqual([]);
    expect(resolved.actors).toEqual([]);
    expect(lc.nodes.find((n) => n.id === 'pruefen')).toMatchObject({ system: 'Schadenakte', _systemRef: 'sys_akte' });
    expect(resolved.fingerprint).toBe(catalogFingerprint([], resolveScheme(), SYSTEMS));
  });

  test('systems in the model, no actors, no catalogue, but assignments: the one leading C01', () => {
    expect(resolveFields(bare(model21({}, { systems: SYSTEMS }))).errors).toEqual([NO_CATALOG_C01]);
  });

  test('a system with no catalogue source at all: one leading C14', () => {
    const model = bare(model21({ pruefen: { system: 'sys_akte' }, zahlen: { system: 'sys_zwei' } }));
    for (const n of model.nodes) delete n.assignments;
    expect(resolveFields(model).errors).toEqual([NO_CATALOG_C14]);
    const both = bare(model21({ pruefen: { system: 'sys_akte' } }));
    expect(resolveFields(both).errors).toEqual([NO_CATALOG_C01, NO_CATALOG_C14]);
  });

  test('a model with actors but no systems: per-node C14 lines (a catalogue was given)', () => {
    const model = { ...bare(model21({ pruefen: { system: 'sys_akte' } })), ...copy(CATALOG) };
    expect(resolveFields(model).errors).toEqual(['[C14] node "pruefen": system "sys_akte" is not in the catalogue']);
  });

  test('a "2.0" model with system is F06 through resolveFields', () => {
    const model = { ...model21({ pruefen: { system: 'sys_akte' } }), $schemaVersion: '2.0' };
    expect(run(model, CATALOG_S).errors).toEqual(['[F06] /nodes/2/system "system" needs format 2.1; set "$schemaVersion" to "2.1"']);
  });

  test('malformed model systems beside a catalogue are refused before the C rules', () => {
    const model = model21({}, { systems: [{ id: 'x', name: 'x'.repeat(201) }] });
    expect(run(model, CATALOG_S).errors.every((e) => /^\[F01\] /.test(e))).toBe(true);
  });
});
