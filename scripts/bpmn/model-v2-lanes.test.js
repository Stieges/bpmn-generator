/**
 * formLanes (design 7.1–7.4): lanes formed from the assignments of a 2.0 model by the inheritance
 * rule. The cases of design 7.2 are the tests `7.2 (a)` … `7.2 (h)`; A, B, C are roles declared
 * in that order.
 */
import { describe, test, expect } from '@jest/globals';
import {
  resolveFields, formLanes, normalizeLanesOption, laneIdFor, checkProjection, UNASSIGNED, UNIT_UNKNOWN, SYSTEM_UNKNOWN,
  AUTOMATIC, AUTOMATIC_ACTIVITY_TYPES,
} from './model-v2.js';
import { runPipeline } from './pipeline.js';
import { loadNamedView, assertView, ViewRejectedError } from '../shared/view.js';
import { readFileSync } from 'node:fs';
import { LANE_NAME_LIMIT } from './rules.js';
import { TASK_TYPES } from './types.js';
import { CFG } from '../shared/utils.js';

const copy = (v) => JSON.parse(JSON.stringify(v));

const ABC = {
  actors: [
    { id: 'A', name: 'Rolle A', kind: 'role' },
    { id: 'B', name: 'Rolle B', kind: 'role' },
    { id: 'C', name: 'Rolle C', kind: 'role' },
  ],
};

const node = (id, type = 'userTask', actor, extra = {}) => ({
  id, type, name: id, ...(actor ? { assignments: [{ type: 'D', actor }] } : {}), ...extra,
});
const flows = (pairs) => pairs.map(([source, target]) => ({ source, target }));
const proc = (nodes, pairs, extra = {}) => ({ $schemaVersion: '2.0', id: 'P', nodes, edges: flows(pairs), ...extra });

function resolve(model, catalog = ABC) {
  const r = resolveFields(copy(model), { catalog: copy(catalog) });
  expect(r.errors).toEqual([]);
  return r;
}
function form(model, { catalog = ABC, lanes = 'role' } = {}) {
  const { lc, resolved } = resolve(model, catalog);
  return formLanes(lc, resolved, { lanes });
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
const codes = (hints) => hints.map((h) => h.code);

describe('formLanes — the cases of design 7.2', () => {
  const caseA = (pairs) => proc(
    [node('T1', 'userTask', 'A'), node('T2', 'userTask', 'B'), node('G', 'exclusiveGateway'), node('T3', 'userTask', 'C')],
    pairs,
  );
  test('7.2 (a) a merging gateway goes with its successor, whatever the order of edges', () => {
    const pairs = [['T1', 'G'], ['T2', 'G'], ['G', 'T3']];
    for (const p of [pairs, [...pairs].reverse()]) {
      const out = form(caseA(p));
      expect(out.errors).toEqual([]);
      expect(members(out.lc)).toEqual({ A: ['T1'], B: ['T2'], C: ['G', 'T3'] });
    }
  });

  test('7.2 (b) an automatic task inherits over the other direction (H03)', () => {
    const out = form(proc(
      [node('S', 'startEvent'), node('X', 'serviceTask'), node('T', 'userTask', 'A'), node('E', 'endEvent')],
      [['S', 'X'], ['X', 'T'], ['T', 'E']],
    ));
    expect(members(out.lc)).toEqual({ A: ['S', 'X', 'T', 'E'] });
    expect(out.hints).toEqual([{
      code: 'H03',
      message: 'Automatic step "X" (X) has no performer; it is placed with its neighbour in lane "Rolle A". Set lanes.automatic to "lane" for a lane of its own.',
      elements: ['X', 'L.P.A'],
    }]);
  });

  test('7.2 (b2) a splitting gateway takes A over the other direction; End 2 inherits from it', () => {
    const out = form(proc(
      [node('S', 'startEvent'), node('G', 'exclusiveGateway'), node('T', 'userTask', 'A'), node('E1', 'endEvent'), node('E2', 'endEvent')],
      [['S', 'G'], ['G', 'T'], ['T', 'E1'], ['G', 'E2']],
    ));
    expect(members(out.lc)).toEqual({ A: ['S', 'G', 'T', 'E1', 'E2'] });
    expect(out.hints).toEqual([]);
  });

  test('7.2 (c) an end event reached from A and B goes to A (tie, A declared first)', () => {
    const pairs = [['T1', 'E'], ['T2', 'E']];
    for (const p of [pairs, [...pairs].reverse()]) {
      const out = form(proc([node('T2', 'userTask', 'B'), node('T1', 'userTask', 'A'), node('E', 'endEvent')], p));
      expect(members(out.lc)).toEqual({ A: ['T1', 'E'], B: ['T2'] });
    }
  });

  test('7.2 (d) a back edge counts neither as predecessor nor as successor', () => {
    const out = form(proc(
      [node('S', 'startEvent'), node('G', 'exclusiveGateway'), node('T1', 'userTask', 'A'), node('T2', 'userTask', 'B'),
        node('G2', 'exclusiveGateway'), node('E', 'endEvent')],
      [['S', 'G'], ['G', 'T1'], ['T1', 'T2'], ['T2', 'G2'], ['G2', 'G'], ['G2', 'E']],
    ));
    expect(members(out.lc)).toEqual({ A: ['S', 'G', 'T1'], B: ['T2', 'G2', 'E'] });
  });

  test('7.2 (e) the placeholder is inherited like any key', () => {
    const out = form(proc(
      [node('S', 'startEvent', 'A'), node('U', 'userTask'), node('G', 'exclusiveGateway'), node('X', 'serviceTask'), node('E', 'endEvent')],
      [['S', 'U'], ['U', 'G'], ['G', 'X'], ['X', 'E']],
    ));
    expect(members(out.lc)).toEqual({ A: ['S'], [UNASSIGNED]: ['U', 'G', 'X', 'E'] });
    expect(codes(out.hints)).toEqual(['H02', 'H03']);
  });

  test("7.2 (e') a task without actor and its gateway are placeholder, T is A", () => {
    const out = form(proc(
      [node('U', 'userTask'), node('G', 'exclusiveGateway'), node('T', 'userTask', 'A')],
      [['U', 'G'], ['G', 'T']],
    ));
    expect(members(out.lc)).toEqual({ [UNASSIGNED]: ['U', 'G'], A: ['T'] });
  });

  test('7.2 (f) two pools with role A, a pool without performer has no lanes (H06)', () => {
    const pool = (id, actor) => ({
      id,
      nodes: [node(`${id}_s`, 'startEvent'), node(`${id}_t`, 'userTask', actor), node(`${id}_e`, 'endEvent')],
      edges: flows([[`${id}_s`, `${id}_t`], [`${id}_t`, `${id}_e`]]),
    });
    const out = form({ $schemaVersion: '2.0', pools: [pool('p1', 'A'), pool('p2', 'A'), pool('p3')] });
    expect(out.errors).toEqual([]);
    const [p1, p2, p3] = out.lc.pools;
    expect(p1.lanes.map((l) => l.id)).toEqual(['L.p1.A']);
    expect(p2.lanes.map((l) => l.id)).toEqual(['L.p2.A']);
    expect(members(p1)).toEqual({ A: ['p1_s', 'p1_t', 'p1_e'] });
    expect(p3).not.toHaveProperty('lanes');
    expect(p3.nodes.every((n) => n.lane === undefined)).toBe(true);
    expect(out.hints).toEqual([{ code: 'H06', message: '[p3] No assignments in process "p3": no lanes.', elements: ['p3'] }]);
  });

  test('7.2 (g) a boundary event on a task without actor stays with its host', () => {
    const out = form(proc(
      [node('S', 'startEvent', 'B'), node('H', 'userTask'), node('BE', 'boundaryEvent', undefined, { attachedTo: 'H' }),
        node('K', 'userTask', 'B'), node('E', 'endEvent')],
      [['S', 'H'], ['H', 'E'], ['BE', 'K']],
    ));
    expect(members(out.lc)).toEqual({ B: ['S', 'K'], [UNASSIGNED]: ['H', 'BE', 'E'] });
  });

  test('7.2 (g2) a boundary event on an automatic task after A is in A; K in B', () => {
    const out = form(proc(
      [node('T', 'userTask', 'A'), node('W', 'serviceTask'), node('BE', 'boundaryEvent', undefined, { attachedTo: 'W' }),
        node('K', 'userTask', 'B')],
      [['T', 'W'], ['BE', 'K']],
    ));
    expect(members(out.lc)).toEqual({ A: ['T', 'W', 'BE'], B: ['K'] });
  });

  test('7.2 (h) unit view: unknown units, a unit as performer, the placeholder', () => {
    const catalog = {
      actors: [
        { id: 'uA', name: 'Einheit A', kind: 'unit' },
        { id: 'r1', name: 'Rolle ohne Einheit', kind: 'role' },
        { id: 'x3', name: 'Akteur ohne Art' },
      ],
    };
    const out = form(proc(
      [node('S', 'startEvent'), node('T1', 'userTask', 'r1'), node('G', 'exclusiveGateway'), node('T2', 'userTask', 'uA'),
        node('T3', 'userTask', 'x3'), node('T4', 'userTask'), node('E', 'endEvent')],
      [['S', 'T1'], ['T1', 'G'], ['G', 'T2'], ['G', 'T3'], ['T3', 'T4'], ['T4', 'E']],
    ), { catalog, lanes: 'unit' });
    expect(members(out.lc)).toEqual({ [UNIT_UNKNOWN]: ['S', 'T1', 'G', 'T3'], uA: ['T2'], [UNASSIGNED]: ['T4', 'E'] });
    expect(out.lc.lanes.map((l) => [l.id, l.name])).toEqual([
      ['L.P.uA', 'Einheit A'], ['L.P._unassigned', '(nicht zugeordnet)'], ['L.P._unitUnknown', '(Einheit nicht erhoben)'],
    ]);
    expect(out.hints.filter((h) => h.code === 'H04').map((h) => h.elements)).toEqual([['T1', 'r1'], ['T3', 'x3']]);
  });
});

const CATALOG_56 = {
  scheme: 'demi',
  actors: [
    { id: 'abt_einkauf', name: 'Einkauf', kind: 'unit' },
    { id: 'abt_buchhaltung', name: 'Buchhaltung', kind: 'unit' },
    { id: 'sb_einkauf', name: 'Sachbearbeitung Einkauf', kind: 'role', unit: 'abt_einkauf' },
    { id: 'leitung', name: 'Abteilungsleitung', kind: 'role', unit: 'abt_einkauf' },
    { id: 'zahlung', name: 'Zahlungsverkehr', kind: 'role', unit: 'abt_buchhaltung' },
  ],
};
const MODEL_56 = {
  $schemaVersion: '2.0', catalog: '../bpmn-catalog.json', id: 'Process_Bestellung', name: 'Bestellung abwickeln',
  nodes: [
    { id: 'start', type: 'startEvent', name: 'Bestellung eingegangen' },
    { id: 'gw', type: 'exclusiveGateway', name: 'Rückfrage nötig?' },
    { id: 'pruefen', type: 'userTask', name: 'Auftrag prüfen', assignments: [{ type: 'D', actor: 'sb_einkauf' }] },
    { id: 'rueck', type: 'userTask', name: 'Lieferant klären', assignments: [{ type: 'D', actor: 'leitung' }, { type: 'I', actor: 'sb_einkauf' }] },
    { id: 'zahlen', type: 'userTask', name: 'Zahlung anweisen', assignments: [{ type: 'D', actor: 'zahlung' }] },
    { id: 'end', type: 'endEvent', name: 'Auftrag erledigt' },
  ],
  edges: [
    { source: 'start', target: 'pruefen' }, { source: 'pruefen', target: 'gw' },
    { source: 'gw', target: 'rueck', label: 'ja' }, { source: 'gw', target: 'zahlen', label: 'nein' },
    { source: 'rueck', target: 'zahlen' }, { source: 'zahlen', target: 'end' },
  ],
};
const lane = (processId, key, name, by) => ({ id: `L.${processId}.${key}`, name, _derived: 'lane', _laneBy: by, _laneActor: key });

describe('formLanes — the example of design 5.6', () => {
  test('role view', () => {
    const out = form(MODEL_56, { catalog: CATALOG_56, lanes: 'role' });
    expect(out.errors).toEqual([]);
    expect(out.hints).toEqual([]);
    expect(out.lc.lanes).toEqual([
      lane('Process_Bestellung', 'sb_einkauf', 'Sachbearbeitung Einkauf', 'role'),
      lane('Process_Bestellung', 'leitung', 'Abteilungsleitung', 'role'),
      lane('Process_Bestellung', 'zahlung', 'Zahlungsverkehr', 'role'),
    ]);
    expect(members(out.lc)).toEqual({ sb_einkauf: ['start', 'gw', 'pruefen'], leitung: ['rueck'], zahlung: ['zahlen', 'end'] });
    expect(out.lc.nodes.find((n) => n.id === 'pruefen').lane).toBe('L.Process_Bestellung.sb_einkauf');
  });

  test('unit view', () => {
    const out = form(MODEL_56, { catalog: CATALOG_56, lanes: 'unit' });
    expect(out.errors).toEqual([]);
    expect(out.hints).toEqual([]);
    expect(out.lc.lanes).toEqual([
      lane('Process_Bestellung', 'abt_einkauf', 'Einkauf', 'unit'),
      lane('Process_Bestellung', 'abt_buchhaltung', 'Buchhaltung', 'unit'),
    ]);
    expect(members(out.lc)).toEqual({ abt_einkauf: ['start', 'gw', 'pruefen', 'rueck'], abt_buchhaltung: ['zahlen', 'end'] });
  });
});

// deterministic shuffle: mulberry32 with a fixed seed per run
function seededShuffle(list, seed) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('formLanes — pinned edge cases', () => {
  test('hint order of 5.6 with one unassigned and one automatic step', () => {
    const model = copy(MODEL_56);
    model.nodes.push({ id: 'u', type: 'userTask', name: 'Ohne Zuständigkeit' }, { id: 'x', type: 'serviceTask', name: 'Automatik' });
    model.edges.push({ source: 'rueck', target: 'u' }, { source: 'u', target: 'x' }, { source: 'x', target: 'zahlen' });
    const out = form(model, { catalog: CATALOG_56 });
    expect(out.errors).toEqual([]);
    expect(out.hints).toEqual([
      { code: 'H02', message: 'No performer for "Ohne Zuständigkeit" (u): lane "(nicht zugeordnet)".', elements: ['u'] },
      { code: 'H03', message: 'Automatic step "Automatik" (x) has no performer; it is placed with its neighbour in lane "(nicht zugeordnet)". Set lanes.automatic to "lane" for a lane of its own.', elements: ['x', 'L.Process_Bestellung._unassigned'] },
    ]);
  });

  test('7.2 (d) and a loop with a tie do not depend on the order of edges (50 seeded shuffles)', () => {
    const d = proc(
      [node('S', 'startEvent'), node('G', 'exclusiveGateway'), node('T1', 'userTask', 'A'), node('T2', 'userTask', 'B'),
        node('G2', 'exclusiveGateway'), node('E', 'endEvent')],
      [['S', 'G'], ['G', 'T1'], ['T1', 'T2'], ['T2', 'G2'], ['G2', 'G'], ['G2', 'E']],
    );
    // a loop whose automatic step sees B and A equally often: the tie goes to A, the role declared first
    const tie = proc(
      [node('T1', 'userTask', 'B'), node('T2', 'userTask', 'A'), node('X', 'serviceTask'), node('T3', 'userTask', 'C')],
      [['T1', 'X'], ['T2', 'X'], ['X', 'T3'], ['T3', 'T1']],
    );
    for (const model of [d, tie]) {
      const reference = form(model);
      for (let seed = 1; seed <= 50; seed++) {
        const shuffled = { ...copy(model), edges: seededShuffle(model.edges, seed) };
        const out = form(shuffled);
        expect(members(out.lc)).toEqual(members(reference.lc));
        expect(out.hints).toEqual(reference.hints);
      }
    }
    expect(members(form(tie).lc)).toEqual({ B: ['T1'], A: ['T2', 'X'], C: ['T3'] });
  });

  test('a boundary event whose host is no top-level flow node: H08 with its own wording', () => {
    const out = form(proc(
      [node('T', 'userTask', 'A'), node('BE', 'boundaryEvent', undefined, { attachedTo: 'nirgends' })],
      [['T', 'BE']],
    ));
    expect(out.errors).toEqual([]);
    expect(out.hints).toEqual([{
      code: 'H08',
      message: 'Boundary event "BE" (BE) has no host with a lane: lane "(nicht zugeordnet)".',
      elements: ['BE'],
    }]);
    expect(members(out.lc)).toEqual({ A: ['T'], [UNASSIGNED]: ['BE'] });
  });
});

describe('formLanes — further behaviour', () => {
  test('unit collapsing: two roles of one unit form one unit lane', () => {
    const catalog = {
      actors: [
        { id: 'U1', name: 'Einheit 1', kind: 'unit' }, { id: 'U2', name: 'Einheit 2', kind: 'unit' },
        { id: 'r1', name: 'Rolle 1', kind: 'role', unit: 'U1' }, { id: 'r2', name: 'Rolle 2', kind: 'role', unit: 'U1' },
        { id: 'r3', name: 'Rolle 3', kind: 'role', unit: 'U2' },
      ],
    };
    const model = proc([node('T1', 'userTask', 'r1'), node('T2', 'userTask', 'r2'), node('T3', 'userTask', 'r3')], [['T1', 'T2'], ['T2', 'T3']]);
    const unit = form(model, { catalog, lanes: 'unit' });
    expect(unit.lc.lanes.map((l) => l.id)).toEqual(['L.P.U1', 'L.P.U2']);
    expect(members(unit.lc)).toEqual({ U1: ['T1', 'T2'], U2: ['T3'] });
    expect(form(model, { catalog, lanes: 'role' }).lc.lanes.map((l) => l.id)).toEqual(['L.P.r1', 'L.P.r2', 'L.P.r3']);
  });

  test('assignments that form no lane: a boundary event with D = B, a subprocess child with D = B', () => {
    const out = form(proc(
      [node('T', 'userTask', 'A'), node('BE', 'boundaryEvent', 'B', { attachedTo: 'T' }), node('E', 'endEvent'),
        node('SP', 'subProcess', 'A', { isExpanded: true, nodes: [node('c1', 'userTask', 'B')], edges: [] })],
      [['T', 'SP'], ['SP', 'E'], ['BE', 'E']],
    ));
    expect(out.lc.lanes.map((l) => l.id)).toEqual(['L.P.A']);
    expect(members(out.lc)).toEqual({ A: ['T', 'BE', 'E', 'SP'] });
    expect(out.lc.nodes.find((n) => n.id === 'SP').nodes[0]).not.toHaveProperty('lane');
  });

  test('every hint code once, with its exact elements', () => {
    const catalog = {
      actors: [
        { id: 'ulong', name: 'Abteilung mit sehr langem Namen', kind: 'unit' },
        { id: 'r1', name: 'Rolle 1', kind: 'role', unit: 'ulong' },
        { id: 'r2', name: 'Rolle 2', kind: 'role' },
      ],
    };
    const model = {
      $schemaVersion: '2.0',
      pools: [
        {
          id: 'p1', name: 'Pool Eins',
          nodes: [node('S', 'startEvent'), node('T1', 'userTask', 'r1'), node('X', 'serviceTask'), node('T2', 'userTask', 'r2'),
            node('U', 'userTask'), node('E', 'endEvent'), node('I', 'intermediateThrowEvent')],
          edges: flows([['S', 'T1'], ['T1', 'X'], ['X', 'T2'], ['T2', 'U'], ['U', 'E']]),
        },
        { id: 'p2', nodes: [node('S2', 'startEvent'), node('E2', 'endEvent')], edges: flows([['S2', 'E2']]) },
      ],
    };
    const out = form(model, { catalog, lanes: 'unit' });
    expect(out.errors).toEqual([]);
    const sorted = [...out.hints].sort((a, b) => a.code.localeCompare(b.code));
    expect(sorted).toEqual([
      { code: 'H02', message: '[Pool Eins] No performer for "U" (U): lane "(nicht zugeordnet)".', elements: ['U'] },
      { code: 'H03', message: '[Pool Eins] Automatic step "X" (X) has no performer; it is placed with its neighbour in lane "Abteilung mit sehr langem Namen". Set lanes.automatic to "lane" for a lane of its own.', elements: ['X', 'L.p1.ulong'] },
      { code: 'H04', message: '[Pool Eins] Unit of performer "Rolle 2" not recorded: "T2" (T2) is in lane "(Einheit nicht erhoben)".', elements: ['T2', 'r2'] },
      { code: 'H05', message: '[Pool Eins] Lane name "Abteilung mit sehr langem Namen" is longer than 25 characters; shorten the catalogue name.', elements: ['L.p1.ulong', 'ulong'] },
      { code: 'H06', message: '[p2] No assignments in process "p2": no lanes.', elements: ['p2'] },
      { code: 'H08', message: '[Pool Eins] No neighbour with a lane: "I" (I) is in lane "(nicht zugeordnet)".', elements: ['I'] },
    ]);
    expect(members(out.lc.pools[0])).toEqual({
      ulong: ['S', 'T1', 'X'], [UNASSIGNED]: ['U', 'E', 'I'], [UNIT_UNKNOWN]: ['T2'],
    });
  });

  test('a single process prefixes no pool name', () => {
    const out = form(proc([node('U', 'userTask'), node('T', 'userTask', 'A')], [['U', 'T']]));
    expect(out.hints).toEqual([{ code: 'H02', message: 'No performer for "U" (U): lane "(nicht zugeordnet)".', elements: ['U'] }]);
  });

  test('a process without any performer: no lanes, H06 with the process name', () => {
    const out = form(proc([node('U', 'userTask')], [], { name: 'Ohne Zuständigkeit' }));
    expect(out.lc).not.toHaveProperty('lanes');
    expect(out.hints).toEqual([{ code: 'H06', message: 'No assignments in process "Ohne Zuständigkeit": no lanes.', elements: ['P'] }]);
  });

  test('C10: actors x and x_di performing in one process', () => {
    const catalog = { actors: [{ id: 'x', name: 'X', kind: 'role' }, { id: 'x_di', name: 'X DI', kind: 'role' }] };
    const out = form(proc([node('T1', 'userTask', 'x'), node('T2', 'userTask', 'x_di')], [['T1', 'T2']]), { catalog });
    expect(out.lc).toBeNull();
    expect(out.errors).toEqual(['[C10] lane id "L.P.x_di" (actor "x_di") collides with "L.P.x"; rename the catalogue id']);
  });

  test('C10: an edge with the id of a lane', () => {
    const model = copy(MODEL_56);
    model.edges[5].id = 'L.Process_Bestellung.zahlung';
    const out = form(model, { catalog: CATALOG_56 });
    expect(out.errors).toEqual([
      '[C10] lane id "L.Process_Bestellung.zahlung" (actor "zahlung") collides with "L.Process_Bestellung.zahlung"; rename the catalogue id',
    ]);
  });

  test('an annotation follows its associated node; without association it goes to the first lane', () => {
    const out = form(proc(
      [node('T1', 'userTask', 'A'), node('T2', 'userTask', 'B'), { id: 'N', type: 'textAnnotation', name: 'Hinweis' },
        { id: 'N2', type: 'textAnnotation', name: 'Frei' }],
      [['T1', 'T2']],
      { associations: [{ id: 'as1', source: 'N', target: 'T2' }] },
    ));
    expect(out.errors).toEqual([]);
    expect(out.lc.nodes.find((n) => n.id === 'N').lane).toBe('L.P.B');
    expect(out.lc.nodes.find((n) => n.id === 'N2').lane).toBe('L.P.A');
  });

  test('an annotation associated with a subprocess child takes the lane of the top-level subprocess', () => {
    const out = form(proc(
      [node('T1', 'userTask', 'A'), node('T2', 'userTask', 'B'),
        node('SP', 'subProcess', 'B', {
          isExpanded: true,
          nodes: [node('c1', 'userTask', 'A'), node('inner', 'subProcess', undefined, { isExpanded: true, nodes: [node('c2', 'userTask')], edges: [] })],
          edges: [],
        }),
        { id: 'N', type: 'textAnnotation', name: 'Kind' }, { id: 'N2', type: 'textAnnotation', name: 'Enkel' }],
      [['T1', 'T2'], ['T2', 'SP']],
      { associations: [{ id: 'as1', source: 'N', target: 'c1' }, { id: 'as2', source: 'c2', target: 'N2' }] },
    ));
    expect(out.errors).toEqual([]);
    expect(out.lc.nodes.find((n) => n.id === 'N').lane).toBe('L.P.B');
    expect(out.lc.nodes.find((n) => n.id === 'N2').lane).toBe('L.P.B');
  });

  test("lanes: 'none' gives no lanes and no hints", () => {
    const out = form(MODEL_56, { catalog: CATALOG_56, lanes: 'none' });
    expect(out.errors).toEqual([]);
    expect(out.hints).toEqual([]);
    expect(out.lc).not.toHaveProperty('lanes');
    expect(out.lc.nodes.every((n) => n.lane === undefined)).toBe(true);
  });

  test('the arguments are unchanged', () => {
    const { lc, resolved } = resolve(MODEL_56, CATALOG_56);
    const snap = () => [JSON.stringify(lc), JSON.stringify(resolved.actors), JSON.stringify(resolved.scheme),
      JSON.stringify([...resolved.byId]), JSON.stringify([...resolved.order])];
    const before = snap();
    const out = formLanes(lc, resolved, { lanes: 'unit' });
    expect(out.lc).not.toBe(lc);
    expect(snap()).toEqual(before);
  });

  test('checkProjection throws on a flow node without lane', () => {
    const out = form(MODEL_56, { catalog: CATALOG_56 });
    expect(() => checkProjection(out.lc)).not.toThrow();
    const broken = copy(out.lc);
    delete broken.nodes[1].lane;
    expect(() => checkProjection(broken)).toThrow(/^formLanes internal error: /);
    const twice = copy(out.lc);
    twice.lanes.push({ ...twice.lanes[0] });
    expect(() => checkProjection(twice)).toThrow(/^formLanes internal error: /);
  });

  test('exports: laneIdFor, placeholders, automatic types, the lane name limit', () => {
    expect(laneIdFor('P', 'A')).toBe('L.P.A');
    expect([UNASSIGNED, UNIT_UNKNOWN]).toEqual(['_unassigned', '_unitUnknown']);
    expect([...AUTOMATIC_ACTIVITY_TYPES].every((t) => TASK_TYPES.has(t))).toBe(true);
    expect(AUTOMATIC_ACTIVITY_TYPES.size).toBe(5);
    expect(LANE_NAME_LIMIT).toBe(25);
    expect(AUTOMATIC).toBe('_automatic');
    expect(laneIdFor('P', AUTOMATIC)).toBe('L.P._automatic');
  });
});

describe('normalizeLanesOption', () => {
  const D = { automatic: 'neighbour', automaticName: null };
  const P = { level: null, nested: false };
  // value -> normalised form; shared by the normaliser rows and the agreement with the view gate
  const ACCEPTED = [
    [undefined, { by: 'role', ...P, ...D }],
    ['role', { by: 'role', ...P, ...D }],
    ['unit', { by: 'unit', ...P, ...D }],
    ['none', { by: 'none', ...P, ...D }],
    [{ by: 'unit' }, { by: 'unit', ...P, ...D }],
    [{ by: 'unit', level: 2 }, { by: 'unit', level: 2, nested: false, ...D }],
    [{ by: 'unit', nested: true }, { by: 'unit', level: null, nested: true, ...D }],
    ['system', { by: 'system', ...P, ...D }],
    [{ by: 'role' }, { by: 'role', ...P, ...D }],
    [{ by: 'role', automatic: 'lane' }, { by: 'role', ...P, automatic: 'lane', automaticName: null }],
    [{ by: 'role', automatic: 'neighbour' }, { by: 'role', ...P, ...D }],
    [{ by: 'unit', nested: true, automatic: 'lane', automaticName: '(maschinell)' }, { by: 'unit', level: null, nested: true, automatic: 'lane', automaticName: '(maschinell)' }],
    [{ by: 'unit', level: 1, automatic: 'lane' }, { by: 'unit', level: 1, nested: false, automatic: 'lane', automaticName: null }],
    [{ by: 'role', automatic: 'lane', automaticName: '\u{1F600}'.repeat(20) }, { by: 'role', ...P, automatic: 'lane', automaticName: '\u{1F600}'.repeat(20) }],
  ];
  const REFUSED = [
    null, 3, { by: 'system' }, { by: 'unit', level: 0 }, { by: 'unit', level: 17 }, { by: 'unit', nested: 1 }, { by: 'unit', x: 1 }, ['unit'],
    { by: 'system', automatic: 'lane' }, { by: 'none', automatic: 'lane' }, { automatic: 'lane' }, { by: 'role', level: 1 }, { by: 'role', nested: true },
    { by: 'role', automatic: 'yes' }, { by: 'role', automatic: true }, { by: 'role', automaticName: 'X' },
    { by: 'role', automatic: 'neighbour', automaticName: 'X' }, { by: 'role', automatic: 'lane', automaticName: '' },
    { by: 'role', automatic: 'lane', automaticName: '   ' }, { by: 'role', automatic: 'lane', automaticName: 'x'.repeat(26) },
    { by: 'role', automatic: 'lane', automaticName: '\u{1F600}'.repeat(26) },
    { by: 'role', automatic: 'lane', automaticName: 7 }, { by: 'role', automatic: 'system' },
  ];

  test.each(ACCEPTED)('%j', (value, expected) => {
    expect(normalizeLanesOption(value)).toEqual(expected);
  });

  test.each(REFUSED.map((v) => [v]))('%j throws', (value) => {
    expect(() => normalizeLanesOption(value)).toThrow(TypeError);
    expect(() => normalizeLanesOption(value)).toThrow(/^unknown lanes option /);
  });

  test('the view gate and the normaliser agree', () => {
    const viewable = (v) => typeof v === 'string' || (v !== null && typeof v === 'object' && !Array.isArray(v));
    for (const [lanes] of ACCEPTED.filter(([v]) => viewable(v))) {
      expect(() => normalizeLanesOption(lanes)).not.toThrow();
      expect(() => assertView({ view: 'x', version: '1.0', lanes })).not.toThrow();
    }
    for (const lanes of REFUSED.filter(viewable)) {
      expect(() => normalizeLanesOption(lanes)).toThrow(TypeError);
      expect(() => assertView({ view: 'x', version: '1.0', lanes })).toThrow(ViewRejectedError);
    }
  });

  test('formLanes with an unknown lanes value throws and accepts the object form', () => {
    const model = proc([{ id: 's', type: 'startEvent' }], []);
    expect(() => form(model, { lanes: 'systems' })).toThrow(TypeError);
    expect(() => form(model, { lanes: { by: 'unit', level: 2, nested: true } })).not.toThrow();
  });
});

// ─── the system view (lanes: 'system'): the step's system as key of design 7.2 ──────────────────
// Systems A, B declared in this order; P is the placeholder "(System nicht erhoben)".
const SYS = {
  actors: [{ id: 'R', name: 'Rolle R', kind: 'role' }],
  systems: [{ id: 'A', name: 'System A' }, { id: 'B', name: 'System B' }],
};
const sysNode = (id, type, system, extra = {}) => ({ id, type, name: id, ...(system ? { system } : {}), ...extra });
const sysProc = (nodes, pairs, extra = {}) => ({ ...proc(nodes, pairs, extra), $schemaVersion: '2.1' });
const formSys = (model, catalog = SYS) => form(model, { catalog, lanes: 'system' });
const h20 = (id, prefix = '') => ({
  code: 'H20', message: `${prefix}No system recorded for "${id}" (${id}): lane "(System nicht erhoben)".`, elements: [id],
});

describe('formLanes — the system view', () => {
  test('(s1) gateways and events inherit; a task without system goes to the placeholder (H20)', () => {
    const out = formSys(sysProc(
      [sysNode('S', 'startEvent'), sysNode('T1', 'userTask', 'A'), sysNode('G', 'exclusiveGateway'), sysNode('T2', 'userTask', 'B'),
        sysNode('T3', 'userTask'), sysNode('E', 'endEvent')],
      [['S', 'T1'], ['T1', 'G'], ['G', 'T2'], ['G', 'T3'], ['T3', 'E']],
    ));
    expect(out.errors).toEqual([]);
    expect(members(out.lc)).toEqual({ A: ['S', 'T1', 'G'], B: ['T2'], [SYSTEM_UNKNOWN]: ['T3', 'E'] });
    expect(out.lc.lanes).toEqual([
      lane('P', 'A', 'System A', 'system'), lane('P', 'B', 'System B', 'system'),
      lane('P', SYSTEM_UNKNOWN, '(System nicht erhoben)', 'system'),
    ]);
    expect(out.hints).toEqual([h20('T3')]);
  });

  test('(s2) an automatic task without system takes the placeholder, not its neighbour (no H03)', () => {
    const out = formSys(sysProc(
      [sysNode('S', 'startEvent'), sysNode('X', 'serviceTask'), sysNode('T', 'userTask', 'A'), sysNode('E', 'endEvent')],
      [['S', 'X'], ['X', 'T'], ['T', 'E']],
    ));
    expect(members(out.lc)).toEqual({ [SYSTEM_UNKNOWN]: ['S', 'X'], A: ['T', 'E'] });
    expect(out.hints).toEqual([h20('X')]);
  });

  test('(s3) an expanded subprocess without system is in the placeholder; its child forms no lane', () => {
    const out = formSys(sysProc(
      [sysNode('T', 'userTask', 'A'),
        sysNode('SP', 'subProcess', undefined, { isExpanded: true, nodes: [sysNode('c1', 'userTask', 'B')], edges: [] })],
      [['T', 'SP']],
    ));
    expect(out.errors).toEqual([]);
    expect(members(out.lc)).toEqual({ A: ['T'], [SYSTEM_UNKNOWN]: ['SP'] });
    expect(out.lc.lanes.map((l) => l.id)).toEqual(['L.P.A', 'L.P._systemUnknown']);
    expect(out.lc.nodes.find((n) => n.id === 'SP').nodes[0]).not.toHaveProperty('lane');
    expect(out.hints).toEqual([h20('SP')]);
  });

  test('(s4) a boundary event follows its host', () => {
    const out = formSys(sysProc(
      [sysNode('T1', 'userTask', 'A'), sysNode('BE', 'boundaryEvent', undefined, { attachedTo: 'T1' }), sysNode('T2', 'userTask', 'B')],
      [['BE', 'T2']],
    ));
    expect(members(out.lc)).toEqual({ A: ['T1', 'BE'], B: ['T2'] });
    expect(out.hints).toEqual([]);
  });

  test('(s5) no task with a system: no lanes, one H06, no H02; assignments play no part', () => {
    const out = formSys(sysProc(
      [node('S', 'startEvent', 'R'), node('T', 'userTask', 'R'), node('X', 'serviceTask'), node('E', 'endEvent')],
      [['S', 'T'], ['T', 'X'], ['X', 'E']],
    ));
    expect(out.errors).toEqual([]);
    expect(out.lc).not.toHaveProperty('lanes');
    expect(out.lc.nodes.every((n) => n.lane === undefined)).toBe(true);
    expect(out.hints).toEqual([{ code: 'H06', message: 'No systems in process "P": no lanes.', elements: ['P'] }]);
  });

  test('assignments decide nothing: a task with a performer and no system is in the placeholder', () => {
    const out = formSys(sysProc(
      [node('T1', 'userTask', 'R', { system: 'A' }), node('T2', 'userTask', 'R')],
      [['T1', 'T2']],
    ));
    expect(members(out.lc)).toEqual({ A: ['T1'], [SYSTEM_UNKNOWN]: ['T2'] });
    expect(codes(out.hints)).toEqual(['H20']);
  });

  test('(s6) two pools using A, a pool without systems has H06 only for it', () => {
    const pool = (id, system) => ({
      id,
      nodes: [sysNode(`${id}_s`, 'startEvent'), sysNode(`${id}_t`, 'userTask', system), sysNode(`${id}_e`, 'endEvent')],
      edges: flows([[`${id}_s`, `${id}_t`], [`${id}_t`, `${id}_e`]]),
    });
    const out = formSys({ $schemaVersion: '2.1', pools: [pool('p1', 'A'), pool('p2', 'A'), pool('p3')] });
    expect(out.errors).toEqual([]);
    const [p1, p2, p3] = out.lc.pools;
    expect(p1.lanes.map((l) => l.id)).toEqual(['L.p1.A']);
    expect(p2.lanes.map((l) => l.id)).toEqual(['L.p2.A']);
    expect(members(p2)).toEqual({ A: ['p2_s', 'p2_t', 'p2_e'] });
    expect(p3).not.toHaveProperty('lanes');
    expect(out.hints).toEqual([{ code: 'H06', message: '[p3] No systems in process "p3": no lanes.', elements: ['p3'] }]);
  });

  test('(s7) C10: systems x and x_di used in one process', () => {
    const catalog = { actors: [], systems: [{ id: 'x', name: 'X' }, { id: 'x_di', name: 'X DI' }] };
    const out = formSys(sysProc([sysNode('T1', 'userTask', 'x'), sysNode('T2', 'userTask', 'x_di')], [['T1', 'T2']]), catalog);
    expect(out.lc).toBeNull();
    expect(out.errors).toEqual(['[C10] lane id "L.P.x_di" (system "x_di") collides with "L.P.x"; rename the catalogue id']);
  });

  test('ties go to the system declared first; the placeholder ranks after every system', () => {
    const pairs = [['T1', 'E'], ['T2', 'E'], ['U', 'E2'], ['T2', 'E2']];
    for (const p of [pairs, [...pairs].reverse()]) {
      const out = formSys(sysProc(
        [sysNode('T2', 'userTask', 'B'), sysNode('U', 'userTask'), sysNode('T1', 'userTask', 'A'), sysNode('E', 'endEvent'), sysNode('E2', 'endEvent')],
        p,
      ));
      expect(members(out.lc)).toEqual({ B: ['T2', 'E2'], [SYSTEM_UNKNOWN]: ['U'], A: ['T1', 'E'] });
      expect(out.lc.lanes.map((l) => l._laneActor)).toEqual(['A', 'B', SYSTEM_UNKNOWN]);
    }
  });

  test('H08 names the system placeholder; H05 for a long system name', () => {
    const catalog = { actors: [], systems: [{ id: 'A', name: 'Ein System mit sehr langem Namen' }] };
    const out = formSys(sysProc(
      [sysNode('T', 'userTask', 'A'), sysNode('I', 'intermediateThrowEvent'),
        sysNode('BE', 'boundaryEvent', undefined, { attachedTo: 'nirgends' })],
      [['T', 'BE']],
    ), catalog);
    expect(out.errors).toEqual([]);
    expect(out.hints).toEqual([
      { code: 'H08', message: 'No neighbour with a lane: "I" (I) is in lane "(System nicht erhoben)".', elements: ['I'] },
      { code: 'H08', message: 'Boundary event "BE" (BE) has no host with a lane: lane "(System nicht erhoben)".', elements: ['BE'] },
      { code: 'H05', message: 'Lane name "Ein System mit sehr langem Namen" is longer than 25 characters; shorten the catalogue name.', elements: ['L.P.A', 'A'] },
    ]);
    expect(members(out.lc)).toEqual({ A: ['T'], [SYSTEM_UNKNOWN]: ['I', 'BE'] });
  });

  test('the role view of the same model ignores systems; the arguments are unchanged', () => {
    const model = sysProc([node('T1', 'userTask', 'R', { system: 'A' }), node('T2', 'userTask', 'R', { system: 'B' })], [['T1', 'T2']]);
    expect(form(model, { catalog: SYS }).lc.lanes.map((l) => l.id)).toEqual(['L.P.R']);
    const { lc, resolved } = resolve(model, SYS);
    const snap = () => [JSON.stringify(lc), JSON.stringify(resolved.systems), JSON.stringify([...resolved.systemById]),
      JSON.stringify([...resolved.systemOrder])];
    const before = snap();
    const out = formLanes(lc, resolved, { lanes: 'system' });
    expect(out.lc).not.toBe(lc);
    expect(snap()).toEqual(before);
  });

  test('exports: the system placeholder', () => {
    expect(SYSTEM_UNKNOWN).toBe('_systemUnknown');
    expect(laneIdFor('P', SYSTEM_UNKNOWN)).toBe('L.P._systemUnknown');
  });

  test('(s8) runPipeline with view systeme: a "2.0" model gets H06 per process and no lanes; a 1.x model the view error', async () => {
    const r = await runPipeline(copy(MODEL_56), { catalog: { ...copy(CATALOG_56), systems: [{ id: 'sys_akte', name: 'Bestellakte' }] }, view: loadNamedView('systeme') });
    expect(r.validation.errors).toEqual([]);
    expect(r.validation.hints.filter((h) => h.code !== 'H18')).toEqual([
      { code: 'H06', message: 'No systems in process "Bestellung abwickeln": no lanes.', elements: ['Process_Bestellung'] },
    ]);
    expect(r.bpmnXml).not.toMatch(/<bpmn:lane\b/);
    expect(r.bpmnXml).toContain('bg:view="systeme"');
    const oneX = JSON.parse(readFileSync(new URL('../../tests/fixtures/simple-approval.json', import.meta.url), 'utf8'));
    const err = await runPipeline(oneX, { view: loadNamedView('systeme') }).catch((e) => e);
    expect(err).toBeInstanceOf(ViewRejectedError);
    expect(err.message).toBe('view "systeme" forms lanes from assignments; this model (format 1.x) carries its own lanes — translate it with node bpmn/migrate.js');
  });
});

// ─── the view switch lanes.automatic "lane": performer-less automatic tasks in a lane of their own ──
describe('formLanes — the automatic lane (lanes.automatic "lane")', () => {
  const LANE = { by: 'role', automatic: 'lane' };
  const UNIT_LANE = { by: 'unit', automatic: 'lane' };
  const h19 = (id, prefix = '', proc = 'P') => ({
    code: 'H19', message: `${prefix}Automatic step "${id}" (${id}) has no performer: lane "(automatisch)".`, elements: [id, `L.${proc}._automatic`],
  });
  // the catalogue ABC with one unit U that A, B and C belong to, for the unit run of the property
  const ABC_U = { actors: [{ id: 'U', name: 'Einheit U', kind: 'unit' }, ...ABC.actors.map((a) => ({ ...a, unit: 'U' }))] };

  const CASE_B = proc(
    [node('S', 'startEvent'), node('X', 'serviceTask'), node('T', 'userTask', 'A'), node('E', 'endEvent')],
    [['S', 'X'], ['X', 'T'], ['T', 'E']],
  );
  const CASE_E = proc(
    [node('S', 'startEvent', 'A'), node('U', 'userTask'), node('G', 'exclusiveGateway'), node('X', 'serviceTask'), node('E', 'endEvent')],
    [['S', 'U'], ['U', 'G'], ['G', 'X'], ['X', 'E']],
  );
  const CASE_G2 = proc(
    [node('T', 'userTask', 'A'), node('W', 'serviceTask'), node('BE', 'boundaryEvent', undefined, { attachedTo: 'W' }),
      node('K', 'userTask', 'B')],
    [['T', 'W'], ['BE', 'K']],
  );
  const CASE_H08 = proc([node('T', 'userTask', 'A'), node('X', 'scriptTask'), node('I', 'intermediateThrowEvent')], []);
  const CASE_TIE = proc(
    [node('T1', 'userTask', 'B'), node('T2', 'userTask', 'A'), node('X', 'serviceTask'), node('T3', 'userTask', 'C')],
    [['T1', 'X'], ['T2', 'X'], ['X', 'T3'], ['T3', 'T1']],
  );

  test('(a1) 7.2 (b): the automatic task moves, start and end stay in A; one H19', () => {
    const out = form(CASE_B, { lanes: LANE });
    expect(out.errors).toEqual([]);
    expect(members(out.lc)).toEqual({ A: ['S', 'T', 'E'], [AUTOMATIC]: ['X'] });
    expect(out.hints).toEqual([h19('X')]);
    expect(out.lc.lanes.map((l) => [l.id, l.name])).toEqual([['L.P.A', 'Rolle A'], ['L.P._automatic', '(automatisch)']]);
  });

  test('(a2) 7.2 (e): the end event keeps the placeholder it inherited through X', () => {
    const out = form(CASE_E, { lanes: LANE });
    expect(members(out.lc)).toEqual({ A: ['S'], [UNASSIGNED]: ['U', 'G', 'E'], [AUTOMATIC]: ['X'] });
    expect(codes(out.hints)).toEqual(['H02', 'H19']);
    expect(out.lc.lanes.map((l) => l._laneActor)).toEqual(['A', UNASSIGNED, AUTOMATIC]);
  });

  test('(a3) 7.2 (g2): the boundary event follows its moved host, without a hint of its own', () => {
    const out = form(CASE_G2, { lanes: LANE });
    expect(members(out.lc)).toEqual({ A: ['T'], [AUTOMATIC]: ['W', 'BE'], B: ['K'] });
    expect(out.hints).toEqual([h19('W')]);
  });

  test('(a4) an automatic task without a neighbour moves instead of falling back (no H08 for it)', () => {
    const off = form(CASE_H08);
    expect(members(off.lc)).toEqual({ A: ['T'], [UNASSIGNED]: ['X', 'I'] });
    expect(off.hints.map((h) => [h.code, h.elements])).toEqual([['H08', ['X']], ['H08', ['I']]]);
    const on = form(CASE_H08, { lanes: LANE });
    expect(members(on.lc)).toEqual({ A: ['T'], [AUTOMATIC]: ['X'], [UNASSIGNED]: ['I'] });
    expect(on.hints).toEqual([
      { code: 'H08', message: 'No neighbour with a lane: "I" (I) is in lane "(nicht zugeordnet)".', elements: ['I'] },
      h19('X'),
    ]);
  });

  test('(a5) the tie loop: X moves, the others keep their keys', () => {
    expect(members(form(CASE_TIE, { lanes: LANE }).lc)).toEqual({ B: ['T1'], A: ['T2'], [AUTOMATIC]: ['X'], C: ['T3'] });
  });

  test('(a6) only performer-less automatic tasks and their boundary events move; the placeholder is not inherited', () => {
    const keysOf = (container) => {
      const byLane = new Map(container.lanes.map((l) => [l.id, l._laneActor]));
      return new Map(container.nodes.filter((n) => n.lane !== undefined).map((n) => [n.id, byLane.get(n.lane)]));
    };
    const runs = [['role', LANE, ABC], ['unit', UNIT_LANE, ABC_U]];
    for (const model of [CASE_B, CASE_E, CASE_G2, CASE_H08, CASE_TIE]) {
      const byId = new Map(model.nodes.map((n) => [n.id, n]));
      const isMover = (n) => !n.assignments && AUTOMATIC_ACTIVITY_TYPES.has(n.type);
      const shouldMove = (n) => isMover(n) || (n.type === 'boundaryEvent' && isMover(byId.get(n.attachedTo)));
      for (const [offLanes, onLanes, catalog] of runs) {
        const off = keysOf(form(model, { catalog, lanes: offLanes }).lc);
        const on = keysOf(form(model, { catalog, lanes: onLanes }).lc);
        expect([...on.keys()]).toEqual([...off.keys()]);
        for (const n of model.nodes) {
          if (shouldMove(n)) expect([n.id, on.get(n.id)]).toEqual([n.id, AUTOMATIC]);
          else expect([n.id, on.get(n.id)]).toEqual([n.id, off.get(n.id)]);
        }
        expect([...off.values()]).not.toContain(AUTOMATIC);
        const inLane = [...on].filter(([, k]) => k === AUTOMATIC).map(([id]) => id);
        expect(inLane.length).toBeGreaterThan(0);
        expect(inLane.every((id) => shouldMove(byId.get(id)))).toBe(true);
      }
    }
  });

  test.each([...AUTOMATIC_ACTIVITY_TYPES])('(a7) a performer-less %s moves', (type) => {
    const out = form(proc(
      [node('S', 'startEvent'), node('X', type), node('T', 'userTask', 'A'), node('E', 'endEvent')],
      [['S', 'X'], ['X', 'T'], ['T', 'E']],
    ), { lanes: LANE });
    expect(members(out.lc)).toEqual({ A: ['S', 'T', 'E'], [AUTOMATIC]: ['X'] });
    expect(out.hints).toEqual([h19('X')]);
  });

  test('(a7) other activities without performer stay in the placeholder (H02); a performer wins; children form no lane', () => {
    for (const [type, extra] of [['userTask'], ['manualTask'], ['callActivity'], ['subProcess', { isExpanded: true, nodes: [], edges: [] }]]) {
      const out = form(proc(
        [node('S', 'startEvent'), node('X', type, undefined, extra), node('T', 'userTask', 'A'), node('E', 'endEvent')],
        [['S', 'X'], ['X', 'T'], ['T', 'E']],
      ), { lanes: LANE });
      expect(out.errors).toEqual([]);
      expect(members(out.lc)[UNASSIGNED]).toContain('X');
      expect(codes(out.hints)).toEqual(['H02']);
      expect(out.lc.lanes.map((l) => l._laneActor)).not.toContain(AUTOMATIC);
    }
    const performed = form(proc([node('T', 'userTask', 'A'), node('X', 'serviceTask', 'B')], [['T', 'X']]), { lanes: LANE });
    expect(members(performed.lc)).toEqual({ A: ['T'], B: ['X'] });
    expect(performed.hints).toEqual([]);
    const child = form(proc(
      [node('S', 'startEvent'), node('SP', 'subProcess', 'A', { isExpanded: true, nodes: [node('c1', 'serviceTask')], edges: [] }), node('E', 'endEvent')],
      [['S', 'SP'], ['SP', 'E']],
    ), { lanes: LANE });
    expect(child.errors).toEqual([]);
    expect(child.lc.lanes.map((l) => l.id)).toEqual(['L.P.A']);
    expect(child.hints).toEqual([]);
  });

  test('(a8) automatic "neighbour" is the default', () => {
    expect(form(CASE_B, { lanes: { by: 'role', automatic: 'neighbour' } })).toEqual(form(CASE_B, { lanes: 'role' }));
  });

  test('(a9) automaticName names the lane and the hint; the id stays', () => {
    const out = form(CASE_B, { lanes: { ...LANE, automaticName: '(maschinell)' } });
    expect(out.lc.lanes.map((l) => [l.id, l.name])).toEqual([['L.P.A', 'Rolle A'], ['L.P._automatic', '(maschinell)']]);
    expect(out.hints).toEqual([{ ...h19('X'), message: 'Automatic step "X" (X) has no performer: lane "(maschinell)".' }]);
  });

  test('a name of 25 code points that is 50 UTF-16 units long gives no H05', () => {
    const name = '\u{1F600}'.repeat(25);
    const out = form(CASE_B, { lanes: { ...LANE, automaticName: name } });
    expect(out.lc.lanes.find((l) => l._laneActor === AUTOMATIC).name).toBe(name);
    expect(codes(out.hints)).toEqual(['H19']);
  });

  test('a text annotation associated with the moved task follows it', () => {
    const model = proc(
      [node('S', 'startEvent'), node('X', 'serviceTask'), node('T', 'userTask', 'A'), node('E', 'endEvent'),
        { id: 'N', type: 'textAnnotation', name: 'Hinweis' }],
      [['S', 'X'], ['X', 'T'], ['T', 'E']],
      { associations: [{ id: 'as1', source: 'N', target: 'X' }] },
    );
    expect(form(model).lc.nodes.find((n) => n.id === 'N').lane).toBe('L.P.A');
    const on = form(model, { lanes: LANE });
    expect(on.errors).toEqual([]);
    expect(on.lc.nodes.find((n) => n.id === 'N').lane).toBe('L.P._automatic');
  });

  test('a configured automatic name over the limit gets H05 like the other placeholders', () => {
    const saved = CFG.laneFormation.automaticName;
    const long = 'x'.repeat(LANE_NAME_LIMIT + 1);
    CFG.laneFormation.automaticName = long;
    try {
      const out = form(CASE_B, { lanes: LANE });
      expect(out.hints.filter((h) => h.code === 'H05')).toEqual([{
        code: 'H05',
        message: `Lane name "${long}" is longer than 25 characters; shorten the catalogue name.`,
        elements: ['L.P._automatic', AUTOMATIC],
      }]);
      expect(codes(form(CASE_B, { lanes: { ...LANE, automaticName: '(maschinell)' } }).hints)).toEqual(['H19']);
    } finally {
      CFG.laneFormation.automaticName = saved;
    }
    expect(CFG.laneFormation.automaticName).toBe('(automatisch)');
  });

  test('(a10) a process whose only activity is a performer-less automatic task: no lanes, H06, also with the switch', () => {
    const model = proc([node('S', 'startEvent'), node('X', 'serviceTask'), node('E', 'endEvent')], [['S', 'X'], ['X', 'E']]);
    for (const lanes of ['role', LANE]) {
      const out = form(model, { lanes });
      expect(out.lc).not.toHaveProperty('lanes');
      expect(out.hints).toEqual([{ code: 'H06', message: 'No assignments in process "P": no lanes.', elements: ['P'] }]);
    }
  });

  test('(a11) two pools: one H19 per pool with its prefix and lane', () => {
    const out = form({
      $schemaVersion: '2.0',
      pools: [
        { id: 'p1', name: 'Pool Eins', nodes: [node('S', 'startEvent'), node('X', 'serviceTask'), node('T', 'userTask', 'A')], edges: flows([['S', 'X'], ['X', 'T']]) },
        { id: 'p2', nodes: [node('S2', 'startEvent'), node('Y', 'serviceTask'), node('T2', 'userTask', 'B')], edges: flows([['S2', 'Y'], ['Y', 'T2']]) },
      ],
    }, { lanes: LANE });
    expect(out.errors).toEqual([]);
    expect(out.hints).toEqual([h19('X', '[Pool Eins] ', 'p1'), h19('Y', '[p2] ', 'p2')]);
  });

  test('(a12) C10: an edge with the id of the automatic lane', () => {
    const model = copy(CASE_B);
    model.edges[1].id = 'L.P._automatic';
    const out = form(model, { lanes: LANE });
    expect(out.lc).toBeNull();
    expect(out.errors).toEqual(['[C10] lane id "L.P._automatic" (actor "_automatic") collides with "L.P._automatic"; rename the catalogue id']);
  });

  test('(a13) the system view never moves; the object form with by system is refused', () => {
    const model = sysProc(
      [sysNode('S', 'startEvent'), sysNode('X', 'serviceTask', 'A'), sysNode('Y', 'serviceTask'), sysNode('E', 'endEvent')],
      [['S', 'X'], ['X', 'Y'], ['Y', 'E']],
    );
    const out = formSys(model);
    expect(out.errors).toEqual([]);
    expect(members(out.lc)).toEqual({ A: ['S', 'X'], [SYSTEM_UNKNOWN]: ['Y', 'E'] });
    expect(out.hints).toEqual([h20('Y')]);
    expect(codes(out.hints)).not.toContain('H19');
    expect(codes(out.hints)).not.toContain('H03');
    expect(out.lc.lanes.some((l) => l.id.endsWith('._automatic'))).toBe(false);
    expect(() => form(model, { catalog: SYS, lanes: { by: 'system', automatic: 'lane' } })).toThrow(TypeError);
  });

  test('(a14) the arguments are unchanged', () => {
    const model = copy(MODEL_56);
    model.nodes.push({ id: 'x', type: 'serviceTask', name: 'Automatik' });
    model.edges.push({ source: 'rueck', target: 'x' }, { source: 'x', target: 'zahlen' });
    for (const lanes of [LANE, UNIT_LANE, { by: 'unit', nested: true, automatic: 'lane', automaticName: '(maschinell)' }]) {
      const { lc, resolved } = resolve(model, CATALOG_56);
      const option = copy(lanes);
      const snap = () => [JSON.stringify(lc), JSON.stringify(resolved.actors), JSON.stringify(resolved.scheme),
        JSON.stringify([...resolved.byId]), JSON.stringify([...resolved.order]), JSON.stringify(option)];
      const before = snap();
      const out = formLanes(lc, resolved, { lanes: option });
      expect(out.lc).not.toBe(lc);
      expect(codes(out.hints)).toContain('H19');
      expect(snap()).toEqual(before);
    }
  });
});
