/**
 * The organigram level of the unit view (design 7.1): with `lanes: { by: 'unit', level: k }` each
 * performer keys on the unit at depth k of its unit's chain (1 = units without `partOf`); a unit
 * shallower than k keeps its own lane. Without a level each performer keys on its own unit. A
 * kind-less actor that another actor names as `unit` or `partOf` counts as a unit.
 *
 * With `nested: true` the lanes follow the organigram: each key unit gets a lane for every unit of
 * its chain, as children; a key unit with child lanes holds its own steps in the extra first child
 * `L.<process>.<unit>._own`; the placeholders are top-level lanes after the tree.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFields, formLanes, checkProjection, UNIT_UNKNOWN, UNASSIGNED } from './model-v2.js';
import { catalogErrors } from '../shared/catalog.js';
import { loadNamedView } from '../shared/view.js';

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');
const copy = (v) => JSON.parse(JSON.stringify(v));

/** The organigram test catalogue: plain JSON, shared with the nested view and its golden. */
const ORG = JSON.parse(readFileSync(resolvePath(root, 'tests/fixtures-v2/organigramm-catalog.json'), 'utf8'));
/** The model of design 5.6 (steps start, pruefen, gw, regr, zahlen, end). */
const SCHADEN = JSON.parse(readFileSync(resolvePath(root, 'tests/fixtures-v2/schaden.json'), 'utf8'));

function form(model, catalog, lanes) {
  const r = resolveFields(copy(model), { catalog: copy(catalog) });
  expect(r.errors).toEqual([]);
  return formLanes(r.lc, r.resolved, { lanes });
}
/** Lane membership of a process: `_laneActor` → node ids in node order. */
function members(container) {
  const byLane = new Map((container.lanes ?? []).map((l) => [l.id, l._laneActor]));
  const out = {};
  for (const n of container.nodes) {
    if (n.lane === undefined) continue;
    (out[byLane.get(n.lane)] ??= []).push(n.id);
  }
  return out;
}
const lanesOf = (out) => out.lc.lanes.map((l) => [l.id, l.name]);

describe('unit view — organigram level on the catalogue org', () => {
  test('level 1: Leistung {start, pruefen, gw, regr}, Finanzen {zahlen, end}', () => {
    const out = form(SCHADEN, ORG, { by: 'unit', level: 1 });
    expect(out.errors).toEqual([]);
    expect(out.hints).toEqual([]);
    expect(lanesOf(out)).toEqual([['L.Process_Schaden.bereich_leistung', 'Leistung'], ['L.Process_Schaden.abt_finanzen', 'Finanzen']]);
    expect(members(out.lc)).toEqual({ bereich_leistung: ['start', 'gw', 'pruefen', 'regr'], abt_finanzen: ['zahlen', 'end'] });
    expect(out.lc.lanes.every((l) => l._laneBy === 'unit' && l._derived === 'lane')).toBe(true);
  });

  test('level 2: Leistung {regr} keeps its lane, Schadenabteilung {start, pruefen, gw}, Finanzen {zahlen, end}', () => {
    const out = form(SCHADEN, ORG, { by: 'unit', level: 2 });
    expect(out.errors).toEqual([]);
    expect(out.hints).toEqual([]);
    expect(lanesOf(out)).toEqual([
      ['L.Process_Schaden.bereich_leistung', 'Leistung'],
      ['L.Process_Schaden.abt_schaden', 'Schadenabteilung'],
      ['L.Process_Schaden.abt_finanzen', 'Finanzen'],
    ]);
    expect(members(out.lc)).toEqual({ abt_schaden: ['start', 'gw', 'pruefen'], bereich_leistung: ['regr'], abt_finanzen: ['zahlen', 'end'] });
  });

  test('no level: each performer keys on its own unit, here the same as level 2', () => {
    const level2 = form(SCHADEN, ORG, { by: 'unit', level: 2 });
    for (const lanes of ['unit', { by: 'unit' }]) {
      const out = form(SCHADEN, ORG, lanes);
      expect(out).toEqual(level2);
    }
  });

  test('a level deeper than every chain keeps each unit in its own lane', () => {
    expect(form(SCHADEN, ORG, { by: 'unit', level: 16 })).toEqual(form(SCHADEN, ORG, 'unit'));
  });
});

describe('unit view — a chain of depth 4', () => {
  const CHAIN = {
    actors: [
      { id: 'u1', name: 'Ebene 1', kind: 'unit' },
      { id: 'u2', name: 'Ebene 2', kind: 'unit', partOf: 'u1' },
      { id: 'u3', name: 'Ebene 3', kind: 'unit', partOf: 'u2' },
      { id: 'u4', name: 'Ebene 4', kind: 'unit', partOf: 'u3' },
      { id: 'r2', name: 'Rolle 2', kind: 'role', unit: 'u2' },
      { id: 'r3', name: 'Rolle 3', kind: 'role', unit: 'u3' },
      { id: 'r4', name: 'Rolle 4', kind: 'role', unit: 'u4' },
    ],
  };
  const task = (id, actor) => ({ id, type: 'userTask', name: id, assignments: [{ type: 'D', actor }] });
  const MODEL = {
    $schemaVersion: '2.0', id: 'P',
    nodes: [{ id: 'S', type: 'startEvent' }, task('T2', 'r2'), task('T3', 'r3'), task('T4', 'r4'), task('U4', 'u4'), { id: 'E', type: 'endEvent' }],
    edges: [['S', 'T2'], ['T2', 'T3'], ['T3', 'T4'], ['T4', 'U4'], ['U4', 'E']].map(([source, target]) => ({ source, target })),
  };

  test('level 3 maps the depth-4 unit up, shallower units keep their lane', () => {
    const out = form(MODEL, CHAIN, { by: 'unit', level: 3 });
    expect(out.hints).toEqual([]);
    expect(lanesOf(out)).toEqual([['L.P.u2', 'Ebene 2'], ['L.P.u3', 'Ebene 3']]);
    expect(members(out.lc)).toEqual({ u2: ['S', 'T2'], u3: ['T3', 'T4', 'U4', 'E'] });
  });

  test('level 1 puts every step in the root; no level keys each on its own unit', () => {
    expect(members(form(MODEL, CHAIN, { by: 'unit', level: 1 }).lc)).toEqual({ u1: ['S', 'T2', 'T3', 'T4', 'U4', 'E'] });
    expect(members(form(MODEL, CHAIN, 'unit').lc)).toEqual({ u2: ['S', 'T2'], u3: ['T3'], u4: ['T4', 'U4', 'E'] });
  });

  test('the role view ignores the organigram', () => {
    expect(members(form(MODEL, CHAIN, 'role').lc)).toEqual({ r2: ['S', 'T2'], r3: ['T3'], r4: ['T4'], u4: ['U4', 'E'] });
  });
});

describe('unit view — a kind-less actor named as a unit', () => {
  const task = (id, actor) => ({ id, type: 'userTask', name: id, ...(actor ? { assignments: [{ type: 'D', actor }] } : {}) });
  const MODEL = {
    $schemaVersion: '2.0', id: 'P',
    nodes: [task('T1', 'x'), task('T2', 'r'), task('T3', 'y')],
    edges: [{ source: 'T1', target: 'T2' }, { source: 'T2', target: 'T3' }],
  };

  test('performing a step itself, it forms its own unit lane L.P.x without H04', () => {
    const catalog = {
      actors: [
        { id: 'x', name: 'Akteur ohne Art' },
        { id: 'r', name: 'Rolle', kind: 'role', unit: 'x' },
        { id: 'y', name: 'Noch ein Akteur ohne Art' },
      ],
    };
    const out = form(MODEL, catalog, 'unit');
    expect(lanesOf(out)).toEqual([['L.P.x', 'Akteur ohne Art'], ['L.P._unitUnknown', '(Einheit nicht erhoben)']]);
    expect(members(out.lc)).toEqual({ x: ['T1', 'T2'], [UNIT_UNKNOWN]: ['T3'] });
    // y is named by nobody: it stays without unit
    expect(out.hints.map((h) => [h.code, h.elements])).toEqual([['H04', ['T3', 'y']]]);
  });

  test('named as partOf, it is a unit too and the level climbs through it', () => {
    const catalog = {
      actors: [
        { id: 'x', name: 'Akteur ohne Art' },
        { id: 'y', name: 'Einheit', kind: 'unit', partOf: 'x' },
        { id: 'r', name: 'Rolle', kind: 'role', unit: 'y' },
      ],
    };
    const out = form(MODEL, catalog, { by: 'unit', level: 1 });
    expect(out.hints).toEqual([]);
    expect(members(out.lc)).toEqual({ x: ['T1', 'T2', 'T3'] });
    expect(members(form(MODEL, catalog, 'unit').lc)).toEqual({ x: ['T1'], y: ['T2', 'T3'] });
  });
});

/** The lane tree without the node lists: `[id, name, _laneActor, children?]` per lane. */
const tree = (lanes) => lanes.map((l) => (l.children ? [l.id, l.name, l._laneActor, tree(l.children)] : [l.id, l.name, l._laneActor]));
const walk = (lanes, fn) => { for (const l of lanes ?? []) { fn(l); walk(l.children, fn); } };
/** Node ids per lane id, in node order. */
const byLane = (container) => {
  const out = {};
  for (const n of container.nodes) if (n.lane !== undefined) (out[n.lane] ??= []).push(n.id);
  return out;
};
const P = 'L.Process_Schaden';

describe('unit view nested along the organigram', () => {
  const NESTED = { by: 'unit', nested: true };

  test('Leistung { Leistung (own) {regr}, Schadenabteilung {start, pruefen, gw} }, Finanzen {zahlen, end}', () => {
    const out = form(SCHADEN, ORG, NESTED);
    expect(out.errors).toEqual([]);
    expect(out.hints).toEqual([]);
    expect(tree(out.lc.lanes)).toEqual([
      [`${P}.bereich_leistung`, 'Leistung', 'bereich_leistung', [
        [`${P}.bereich_leistung._own`, 'Leistung', 'bereich_leistung'],
        [`${P}.abt_schaden`, 'Schadenabteilung', 'abt_schaden'],
      ]],
      [`${P}.abt_finanzen`, 'Finanzen', 'abt_finanzen'],
    ]);
    expect(byLane(out.lc)).toEqual({
      [`${P}.abt_schaden`]: ['start', 'gw', 'pruefen'],
      [`${P}.bereich_leistung._own`]: ['regr'],
      [`${P}.abt_finanzen`]: ['zahlen', 'end'],
    });
    walk(out.lc.lanes, (l) => {
      expect(Object.keys(l).filter((k) => k !== 'children').sort()).toEqual(['_derived', '_laneActor', '_laneBy', 'id', 'name']);
      expect([l._derived, l._laneBy]).toEqual(['lane', 'unit']);
    });
  });

  test('the shipped view organigramm is this view', () => {
    expect(form(SCHADEN, ORG, loadNamedView('organigramm').lanes)).toEqual(form(SCHADEN, ORG, NESTED));
  });

  test('level 2 changes nothing here; level 1 cuts the tree to the flat level-1 lanes', () => {
    expect(form(SCHADEN, ORG, { ...NESTED, level: 2 })).toEqual(form(SCHADEN, ORG, NESTED));
    expect(form(SCHADEN, ORG, { ...NESTED, level: 1 })).toEqual(form(SCHADEN, ORG, { by: 'unit', level: 1 }));
  });

  test('a unit with no step of its own has no own lane; a deep chain nests one lane per level', () => {
    const CHAIN = {
      actors: [
        { id: 'u1', name: 'Ebene 1', kind: 'unit' },
        { id: 'u2', name: 'Ebene 2', kind: 'unit', partOf: 'u1' },
        { id: 'u3', name: 'Ebene 3', kind: 'unit', partOf: 'u2' },
        { id: 'u4', name: 'Ebene 4', kind: 'unit', partOf: 'u3' },
        { id: 'r2', name: 'Rolle 2', kind: 'role', unit: 'u2' },
        { id: 'r3', name: 'Rolle 3', kind: 'role', unit: 'u3' },
        { id: 'r4', name: 'Rolle 4', kind: 'role', unit: 'u4' },
      ],
    };
    const task = (id, actor) => ({ id, type: 'userTask', name: id, assignments: [{ type: 'D', actor }] });
    const MODEL = {
      $schemaVersion: '2.0', id: 'P',
      nodes: [{ id: 'S', type: 'startEvent' }, task('T2', 'r2'), task('T3', 'r3'), task('T4', 'r4'), { id: 'E', type: 'endEvent' }],
      edges: [['S', 'T2'], ['T2', 'T3'], ['T3', 'T4'], ['T4', 'E']].map(([source, target]) => ({ source, target })),
    };
    const out = form(MODEL, CHAIN, NESTED);
    expect(out.hints).toEqual([]);
    expect(tree(out.lc.lanes)).toEqual([
      ['L.P.u1', 'Ebene 1', 'u1', [
        ['L.P.u2', 'Ebene 2', 'u2', [
          ['L.P.u2._own', 'Ebene 2', 'u2'],
          ['L.P.u3', 'Ebene 3', 'u3', [
            ['L.P.u3._own', 'Ebene 3', 'u3'],
            ['L.P.u4', 'Ebene 4', 'u4'],
          ]],
        ]],
      ]],
    ]);
    expect(byLane(out.lc)).toEqual({ 'L.P.u2._own': ['S', 'T2'], 'L.P.u3._own': ['T3'], 'L.P.u4': ['T4', 'E'] });
    // level 3: u4 maps to u3, so u3 is a leaf and holds its steps itself
    const cut = form(MODEL, CHAIN, { ...NESTED, level: 3 });
    expect(tree(cut.lc.lanes)).toEqual([
      ['L.P.u1', 'Ebene 1', 'u1', [['L.P.u2', 'Ebene 2', 'u2', [['L.P.u2._own', 'Ebene 2', 'u2'], ['L.P.u3', 'Ebene 3', 'u3']]]]],
    ]);
    expect(byLane(cut.lc)).toEqual({ 'L.P.u2._own': ['S', 'T2'], 'L.P.u3': ['T3', 'T4', 'E'] });
  });

  test('siblings in catalogue order, the own lane first', () => {
    const catalog = {
      actors: [
        { id: 'top', name: 'Oben', kind: 'unit' },
        { id: 'b', name: 'B', kind: 'unit', partOf: 'top' },
        { id: 'a', name: 'A', kind: 'unit', partOf: 'top' },
      ],
    };
    const task = (id, actor) => ({ id, type: 'userTask', name: id, assignments: [{ type: 'D', actor }] });
    const MODEL = {
      $schemaVersion: '2.0', id: 'P',
      nodes: [task('T1', 'a'), task('T2', 'b'), task('T3', 'top')],
      edges: [{ source: 'T1', target: 'T2' }, { source: 'T2', target: 'T3' }],
    };
    expect(tree(form(MODEL, catalog, NESTED).lc.lanes)).toEqual([
      ['L.P.top', 'Oben', 'top', [['L.P.top._own', 'Oben', 'top'], ['L.P.b', 'B', 'b'], ['L.P.a', 'A', 'a']]],
    ]);
  });

  // Review Focus 3
  describe('placeholders: a role without unit, a kind-less performer without unit, an unassigned task', () => {
    const catalog = {
      ...ORG,
      actors: [...ORG.actors, { id: 'r_ohne', name: 'Rolle ohne Einheit', kind: 'role' }, { id: 'k_ohne', name: 'Akteur ohne Art' }],
    };
    const task = (id, actor) => ({ id, type: 'userTask', name: id, ...(actor ? { assignments: [{ type: 'D', actor }] } : {}) });
    const MODEL = {
      $schemaVersion: '2.0', id: 'P',
      nodes: [{ id: 'S', type: 'startEvent' }, task('T1', 'sb_schaden'), task('T2', 'r_ohne'), task('T3', 'k_ohne'),
        task('T4'), task('T5', 'regress'), task('T6', 'zahlung'), { id: 'E', type: 'endEvent' }],
      edges: [['S', 'T1'], ['T1', 'T2'], ['T2', 'T3'], ['T3', 'T4'], ['T4', 'T5'], ['T5', 'T6'], ['T6', 'E']]
        .map(([source, target]) => ({ source, target })),
    };
    const HINTS = [['H04', ['T2', 'r_ohne']], ['H04', ['T3', 'k_ohne']], ['H02', ['T4']]];
    const PLACEHOLDERS = [
      ['L.P._unassigned', '(nicht zugeordnet)', UNASSIGNED],
      ['L.P._unitUnknown', '(Einheit nicht erhoben)', UNIT_UNKNOWN],
    ];

    test('nested: the placeholders are top-level lanes after the tree, H04 and H02 as in the flat view', () => {
      const out = form(MODEL, catalog, NESTED);
      expect(out.errors).toEqual([]);
      expect(out.hints.map((h) => [h.code, h.elements])).toEqual(HINTS);
      expect(tree(out.lc.lanes)).toEqual([
        ['L.P.bereich_leistung', 'Leistung', 'bereich_leistung', [
          ['L.P.bereich_leistung._own', 'Leistung', 'bereich_leistung'],
          ['L.P.abt_schaden', 'Schadenabteilung', 'abt_schaden'],
        ]],
        ['L.P.abt_finanzen', 'Finanzen', 'abt_finanzen'],
        ...PLACEHOLDERS,
      ]);
      expect(byLane(out.lc)).toEqual({
        'L.P.abt_schaden': ['S', 'T1'], 'L.P._unitUnknown': ['T2', 'T3'], 'L.P._unassigned': ['T4'],
        'L.P.bereich_leistung._own': ['T5'], 'L.P.abt_finanzen': ['T6', 'E'],
      });
      expect(out.hints.find((h) => h.code === 'H04').message).toBe('Unit of performer "Rolle ohne Einheit" not recorded: "T2" (T2) is in lane "(Einheit nicht erhoben)".');
    });

    test('nested with level 1: a performer without unit stays in the placeholder after the tree, with H04', () => {
      const out = form(MODEL, catalog, { ...NESTED, level: 1 });
      expect(out.hints.map((h) => [h.code, h.elements])).toEqual(HINTS);
      expect(tree(out.lc.lanes)).toEqual([
        ['L.P.bereich_leistung', 'Leistung', 'bereich_leistung'],
        ['L.P.abt_finanzen', 'Finanzen', 'abt_finanzen'],
        ...PLACEHOLDERS,
      ]);
      expect(byLane(out.lc)).toEqual({
        'L.P.bereich_leistung': ['S', 'T1', 'T5'], 'L.P._unitUnknown': ['T2', 'T3'], 'L.P._unassigned': ['T4'], 'L.P.abt_finanzen': ['T6', 'E'],
      });
    });
  });

  test('a kind-less actor naming itself as unit keys on itself: a top-level lane without children', () => {
    const catalog = { actors: [...ORG.actors, { id: 'x', name: 'Selbst', unit: 'x' }] };
    const task = (id, actor) => ({ id, type: 'userTask', name: id, assignments: [{ type: 'D', actor }] });
    const MODEL = {
      $schemaVersion: '2.0', id: 'P',
      nodes: [task('T1', 'sb_schaden'), task('T2', 'x')],
      edges: [{ source: 'T1', target: 'T2' }],
    };
    const r = resolveFields(copy(MODEL), { catalog: copy(catalog) });
    expect(r.resolved.isUnit('x')).toBe(false);
    const out = formLanes(r.lc, r.resolved, { lanes: NESTED });
    expect(out.hints).toEqual([]);
    expect(tree(out.lc.lanes)).toEqual([
      ['L.P.bereich_leistung', 'Leistung', 'bereich_leistung', [['L.P.abt_schaden', 'Schadenabteilung', 'abt_schaden']]],
      ['L.P.x', 'Selbst', 'x'],
    ]);
    expect(byLane(out.lc)).toEqual({ 'L.P.abt_schaden': ['T1'], 'L.P.x': ['T2'] });

    // With partOf as well it nests under its parent, as the level climbs through its chain.
    const withParent = { actors: [...ORG.actors, { id: 'x', name: 'Selbst', unit: 'x', partOf: 'bereich_leistung' }] };
    const nested = form(MODEL, withParent, NESTED);
    expect(tree(nested.lc.lanes)).toEqual([
      ['L.P.bereich_leistung', 'Leistung', 'bereich_leistung', [['L.P.abt_schaden', 'Schadenabteilung', 'abt_schaden'], ['L.P.x', 'Selbst', 'x']]],
    ]);
    expect(byLane(form(MODEL, withParent, { by: 'unit', level: 1 }).lc)).toEqual({ 'L.P.bereich_leistung': ['T1', 'T2'] });
  });

  test('an annotation without association goes to the first leaf lane', () => {
    const model = copy(SCHADEN);
    model.nodes.push({ id: 'N', type: 'textAnnotation', name: 'Frei' });
    const out = form(model, ORG, NESTED);
    expect(out.lc.nodes.find((n) => n.id === 'N').lane).toBe(`${P}.bereich_leistung._own`);
  });

  test('H05 once for a long unit name, not again for its own lane', () => {
    const long = 'Leistungsbereich Schaden und Regress';
    const catalog = { ...ORG, actors: ORG.actors.map((a) => (a.id === 'bereich_leistung' ? { ...a, name: long } : a)) };
    const out = form(SCHADEN, catalog, NESTED);
    expect(out.lc.lanes[0].children[0].name).toBe(long);
    expect(out.hints.map((h) => [h.code, h.elements])).toEqual([['H05', [`${P}.bereich_leistung`, 'bereich_leistung']]]);
  });

  test('C10 covers every lane of the tree, the own lane and its _di included', () => {
    for (const id of [`${P}.bereich_leistung`, `${P}.bereich_leistung._own`, `${P}.bereich_leistung._own_di`]) {
      const model = copy(SCHADEN);
      model.edges[5].id = id;
      const out = form(model, ORG, NESTED);
      expect(out.lc).toBeNull();
      expect(out.errors).toHaveLength(1);
      expect(out.errors[0]).toMatch(/^\[C10\] lane id "L\.Process_Schaden\.bereich_leistung(\._own)?" \(actor "bereich_leistung"\) collides with /);
    }
  });

  test('no actor can take the id of an own lane: the catalogue id pattern refuses "bereich_leistung._own"', () => {
    const errors = catalogErrors({ actors: [{ id: 'bereich_leistung._own', name: 'Leistung', kind: 'unit' }] });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toMatch(/C12.*\/actors\/0\/id/);
  });

  test('checkProjection: a node in a parent lane, a node in no lane of the tree, a lane id twice', () => {
    const out = form(SCHADEN, ORG, NESTED);
    expect(() => checkProjection(out.lc)).not.toThrow();
    const inParent = copy(out.lc);
    inParent.nodes.find((n) => n.id === 'regr').lane = `${P}.bereich_leistung`;
    expect(() => checkProjection(inParent)).toThrow(/^formLanes internal error: flow node "regr" is in parent lane/);
    const nowhere = copy(out.lc);
    nowhere.nodes.find((n) => n.id === 'regr').lane = `${P}.gone`;
    expect(() => checkProjection(nowhere)).toThrow(/^formLanes internal error: flow node "regr" is in no lane/);
    const twice = copy(out.lc);
    twice.lanes[0].children.push({ ...twice.lanes[1] });
    expect(() => checkProjection(twice)).toThrow(/^formLanes internal error: lane id "L\.Process_Schaden\.abt_finanzen" occurs twice/);
    const listed = copy(out.lc);
    listed.lanes[0].children[0].nodeIds = ['start'];
    expect(() => checkProjection(listed)).toThrow(/^formLanes internal error: flow node "start" is in more than one lane/);
  });
});
