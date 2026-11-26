/**
 * The organigram level of the unit view (design 7.1): with `lanes: { by: 'unit', level: k }` each
 * performer keys on the unit at depth k of its unit's chain (1 = units without `partOf`); a unit
 * shallower than k keeps its own lane. Without a level each performer keys on its own unit. A
 * kind-less actor that another actor names as `unit` or `partOf` counts as a unit.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFields, formLanes, UNIT_UNKNOWN } from './model-v2.js';

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');
const copy = (v) => JSON.parse(JSON.stringify(v));

/** The organigram test catalogue: plain JSON, shared with the nested view and its golden. */
const ORG = {
  scheme: 'demi',
  actors: [
    { id: 'bereich_leistung', name: 'Leistung', kind: 'unit' },
    { id: 'abt_schaden', name: 'Schadenabteilung', kind: 'unit', partOf: 'bereich_leistung' },
    { id: 'abt_finanzen', name: 'Finanzen', kind: 'unit' },
    { id: 'sb_schaden', name: 'Sachbearbeitung Schaden', kind: 'role', unit: 'abt_schaden' },
    { id: 'regress', name: 'Regressspezialist', kind: 'role', unit: 'bereich_leistung' },
    { id: 'zahlung', name: 'Zahlungsverkehr', kind: 'role', unit: 'abt_finanzen' },
  ],
};
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
