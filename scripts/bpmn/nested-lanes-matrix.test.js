/**
 * Nested lanes of 1.x models: every lane of the tree is laid out. Leaf lanes are the bands, stacked
 * depth-first; a parent band is the union of its children, one header strip further left; the
 * direct nodes of a parent lane form an implicit first band inside it.
 *
 * `laneFindings` is the oracle: the DI checks see no node outside its own lane.
 */
import { describe, test, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bpmnXsdStatus, xsdDir } from '../../.github/scripts/fetch-bpmn-xsd.mjs';
import { runPipeline } from './pipeline.js';
import { resolveLaneId } from './topology.js';
import { LANE_HEADER_W } from './constants.js';
import { FIXTURES, MODES, OFF } from '../bench/output-hashes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, '../../tests/fixtures');
const FIXTURE = join(FIXTURES_DIR, 'nested-lanes-role-system.json');

const NODE_DEFS = [
  ['s', 'startEvent'], ['t1', 'userTask'], ['t2', 'userTask'], ['g', 'exclusiveGateway'],
  ['t3', 'userTask'], ['t4', 'userTask'], ['e', 'endEvent'],
];
const EDGES = [['s', 't1'], ['t1', 't2'], ['t2', 'g'], ['g', 't3'], ['g', 't4'], ['t3', 'e'], ['t4', 'e']];

/** Logic-Core of the matrix: `placement` maps node id to lane id. */
function model(lanes, placement) {
  return {
    id: 'Process_Matrix', name: 'Matrix',
    lanes,
    nodes: NODE_DEFS.map(([id, type]) => ({ id, type, name: id, lane: placement[id] })),
    edges: EDGES.map(([source, target]) => ({ source, target })),
  };
}
const place = (spec) => Object.fromEntries(
  Object.entries(spec).flatMap(([lane, ids]) => ids.split(' ').map((id) => [id, lane])));

const A = { id: 'A', name: 'A' };
const F = (...kids) => ({ id: 'F', name: 'F', children: kids.map((id) => ({ id, name: id })) });

const walkLanes = (lanes, fn) => { for (const l of lanes || []) { fn(l); walkLanes(l.children, fn); } };

/**
 * The band a node of `lane` must lie in. A leaf lane: its `laneCoords` rectangle. A parent lane
 * (its direct nodes): the implicit first band, i.e. the part of the parent's rectangle above its
 * topmost child band and right of the children's header strip. The parent's whole rectangle would
 * prove nothing, since it encloses its children. `null` when a rectangle is missing.
 */
function bandOf(lane, laneCoords) {
  const own = laneCoords[lane.id];
  if (!own) return null;
  if (!lane.children?.length) return own;
  const kids = lane.children.map((c) => laneCoords[c.id]);
  if (kids.some((k) => !k)) return null;
  const top = Math.min(...kids.map((k) => k.y));
  return { x: own.x + LANE_HEADER_W, y: own.y, w: own.w - LANE_HEADER_W, h: top - own.y };
}

/**
 * Lanes without a `laneCoords` entry or a BPMNShape (`missingShapes`), flow nodes of a lane that
 * have no coordinates (`unplaced`), and flow nodes whose centre is not inside the band of their
 * own lane (`outside`, see `bandOf`). A node whose own lane has no band counts as outside.
 */
function laneFindings(result, lc) {
  const laneCoords = result.coordMap?.laneCoords || {};
  const coords = result.coordMap?.coords || {};
  const xml = result.bpmnXml || '';
  const missingShapes = [];
  const unplaced = [];
  const outside = [];
  for (const proc of lc.pools || [lc]) {
    const laneById = {};
    walkLanes(proc.lanes, (l) => {
      laneById[l.id] = l;
      const hasShape = new RegExp(`<bpmndi:BPMNShape\\b[^>]*\\bbpmnElement="${l.id}"`).test(xml);
      if (!laneCoords[l.id] || !hasShape) missingShapes.push(l.id);
    });
    for (const n of proc.nodes || []) {
      const laneId = resolveLaneId(proc, n);
      if (!laneId) continue;
      const c = coords[n.id];
      if (!c) { unplaced.push(n.id); continue; }
      const b = laneById[laneId] ? bandOf(laneById[laneId], laneCoords) : null;
      const cx = c.x + c.w / 2;
      const cy = c.y + c.h / 2;
      if (!b || cx < b.x || cx > b.x + b.w || cy < b.y || cy > b.y + b.h) outside.push(n.id);
    }
  }
  return { missingShapes, unplaced, outside };
}
const CLEAN = { missingShapes: [], unplaced: [], outside: [] };

const diCodes = (r) => {
  const out = {};
  for (const i of r.diagnostics?.issues || []) out[i.code] = (out[i.code] || 0) + 1;
  return out;
};

const laneShapeCount = (xml, id) => (xml.match(new RegExp(`<bpmndi:BPMNShape\\b[^>]*\\bbpmnElement="${id}"`, 'g')) || []).length;

const ROWS = [
  ['m1', 'flat lane, then a parent with two child lanes', [A, F('F1', 'F2')],
    { A: 's t1', F1: 't2 g', F2: 't3 t4 e' }],
  ['m2', 'most nodes in the flat lane, one in each child lane', [A, F('F1', 'F2')],
    { A: 's t1 t2 g e', F1: 't3', F2: 't4' }],
  ['m3', 'flat and child lanes interleaved along the flow', [A, F('F1', 'F2')],
    { A: 's t1 e', F1: 't2 t4', F2: 'g t3' }],
  ['m4', 'a parent with a single child lane', [A, F('F1')],
    { A: 's t1 t4 e', F1: 't2 g t3' }],
  ['m5', 'only a parent with two child lanes', [F('F1', 'F2')],
    { F1: 's t1 t2 g', F2: 't3 t4 e' }],
  ['m6', 'two parents with two child lanes each', [F('F1', 'F2'), { id: 'A', name: 'A', children: [{ id: 'A1', name: 'A1' }, { id: 'A2', name: 'A2' }] }],
    { A1: 's t1', A2: 't2 g', F1: 't3', F2: 't4 e' }],
  ['m7', 'flat lane around the child lanes', [A, F('F1', 'F2')],
    { A: 's g e', F1: 't1 t2', F2: 't3 t4' }],
];
const P1 = () => model([A, F('F1')], place({ A: 's t1 t2 g t4 e', F: 't3' }));
const F0 = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));

describe('nested lanes of 1.x models', () => {
  test.each(ROWS)('%s, %s: every lane has a band and a shape, every node lies in its band', async (_id, _what, lanes, spec) => {
    const lc = model(lanes, place(spec));
    const r = await runPipeline(lc);
    expect(diCodes(r)).toEqual({});
    expect(laneFindings(r, lc)).toEqual(CLEAN);
    walkLanes(lc.lanes, (l) => expect([l.id, laneShapeCount(r.bpmnXml, l.id)]).toEqual([l.id, 1]));
  });

  test('m5, the parent is the one top-level band and its child with the start event comes first', async () => {
    const [, , lanes, spec] = ROWS.find(([id]) => id === 'm5');
    const { coordMap: { laneCoords } } = await runPipeline(model(lanes, place(spec)));
    expect(laneCoords.F1.y).toBeLessThan(laneCoords.F2.y);
    expect(laneCoords.F.y).toBe(laneCoords.F1.y);
    expect(laneCoords.F.y + laneCoords.F.h).toBe(laneCoords.F2.y + laneCoords.F2.h);
  });

  test('m6, the parent holding the start event is stacked first although it is declared second', async () => {
    const [, , lanes, spec] = ROWS.find(([id]) => id === 'm6');
    const { coordMap: { laneCoords } } = await runPipeline(model(lanes, place(spec)));
    expect(laneCoords.A.y).toBeLessThan(laneCoords.F.y);
    expect(laneCoords.A1.y).toBeLessThan(laneCoords.A2.y);
    expect(laneCoords.F.y).toBe(laneCoords.A.y + laneCoords.A.h);
  });

  test('a parent band is the union of its child bands, one header strip further left', async () => {
    const [, , lanes, spec] = ROWS.find(([id]) => id === 'm1');
    const { coordMap: { laneCoords } } = await runPipeline(model(lanes, place(spec)));
    const { A: a, F: f, F1: f1, F2: f2 } = laneCoords;
    expect(f.x).toBe(a.x);
    expect(f.w).toBe(a.w);
    for (const child of [f1, f2]) {
      expect(child.x).toBe(f.x + LANE_HEADER_W);
      expect(child.w).toBe(f.w - LANE_HEADER_W);
    }
    expect(f1.y).toBe(f.y);
    expect(f2.y).toBe(f1.y + f1.h);
    expect(f2.y + f2.h).toBe(f.y + f.h);
  });

  test('f0, the slice-0 fixture: every lane has a band and a shape, every node lies in its band', async () => {
    const lc = F0();
    const r = await runPipeline(lc);
    expect(diCodes(r)).toEqual({});
    expect(laneFindings(r, lc)).toEqual(CLEAN);
  });

  test('p1, a node placed directly in a parent lane lies in an implicit first band of that parent', async () => {
    const lc = P1();
    const r = await runPipeline(lc);
    expect(diCodes(r)).toEqual({});
    expect(laneFindings(r, lc)).toEqual(CLEAN);
    const { F: f, F1: f1 } = r.coordMap.laneCoords;
    // The implicit band has a height of its own and no lane element in the XML.
    expect(f1.y).toBeGreaterThan(f.y);
    expect(f1.y + f1.h).toBe(f.y + f.h);
    expect((r.bpmnXml.match(/<bpmn:lane\b/g) || []).length).toBe(3);
  });

  const xsd = bpmnXsdStatus();
  (xsd.available ? test : test.skip)('every case validates against BPMN20.xsd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nested-lanes-xsd-'));
    try {
      const cases = [...ROWS.map(([id, , lanes, spec]) => [id, model(lanes, place(spec))]), ['f0', F0()], ['p1', P1()]];
      const files = [];
      for (const [id, lc] of cases) {
        const file = join(dir, `${id}.bpmn`);
        writeFileSync(file, (await runPipeline(lc)).bpmnXml);
        files.push(file);
      }
      // Throws with xmllint's message when a file fails to validate.
      execFileSync('xmllint', ['--noout', '--schema', join(xsdDir(), 'BPMN20.xsd'), ...files], { encoding: 'utf8', stdio: 'pipe' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Shapes beyond the matrix: deeper trees, the `nodeIds` lane format, an empty child lane, a
// boundary event and an expanded subprocess in child lanes, and collaborations.
describe('nested lanes of 1.x models, further shapes', () => {
  const N = (id, type, lane, extra = {}) => ({ id, type, name: id, ...(lane ? { lane } : {}), ...extra });
  const chain = (ids) => ids.slice(1).map((target, i) => ({ source: ids[i], target }));
  const FF = [A, F('F1', 'F2')];
  // Three levels; F and F1 hold a node of their own each.
  const deep = () => ({
    id: 'Process_Deep', name: 'Deep',
    lanes: [A, { id: 'F', name: 'F', children: [{ id: 'F1', name: 'F1', children: [{ id: 'F1a', name: 'F1a' }, { id: 'F1b', name: 'F1b' }] }, { id: 'F2', name: 'F2' }] }],
    nodes: [N('s', 'startEvent', 'A'), N('t1', 'userTask', 'F1a'), N('t2', 'userTask', 'F1b'), N('t3', 'userTask', 'F2'),
      N('t4', 'userTask', 'F1'), N('t5', 'userTask', 'F'), N('e', 'endEvent', 'A')],
    edges: chain(['s', 't1', 't2', 't3', 't4', 't5', 'e']),
  });
  const flatPool = (p) => ({
    id: p, name: p, lanes: [{ id: `${p}L1`, name: 'L1' }, { id: `${p}L2`, name: 'L2' }],
    nodes: [N(`${p}s`, 'startEvent', `${p}L1`), N(`${p}t`, 'userTask', `${p}L2`), N(`${p}e`, 'endEvent', `${p}L1`)],
    edges: chain([`${p}s`, `${p}t`, `${p}e`]),
  });
  const lanelessPool = (p) => ({
    id: p, name: p,
    nodes: [N(`${p}s`, 'startEvent'), N(`${p}t`, 'userTask'), N(`${p}e`, 'endEvent')],
    edges: chain([`${p}s`, `${p}t`, `${p}e`]),
  });
  const CASES = {
    'three levels, parents with nodes of their own': deep,
    'lane membership as nodeIds on child lanes': () => ({
      id: 'Process_B', name: 'B',
      lanes: [{ ...A, nodeIds: ['s', 'e'] }, { id: 'F', name: 'F', children: [{ id: 'F1', name: 'F1', nodeIds: ['t1'] }, { id: 'F2', name: 'F2', nodeIds: ['t2'] }] }],
      nodes: [N('s', 'startEvent'), N('t1', 'userTask'), N('t2', 'userTask'), N('e', 'endEvent')],
      edges: chain(['s', 't1', 't2', 'e']),
    }),
    'an empty child lane': () => ({
      id: 'Process_E', name: 'E', lanes: FF,
      nodes: [N('s', 'startEvent', 'A'), N('t1', 'userTask', 'F2'), N('e', 'endEvent', 'A')],
      edges: chain(['s', 't1', 'e']),
    }),
    'a boundary event and an expanded subprocess in child lanes': () => ({
      id: 'Process_S', name: 'S', lanes: FF,
      nodes: [N('s', 'startEvent', 'A'), N('t1', 'userTask', 'F1'), N('b', 'boundaryEvent', null, { attachedTo: 't1', marker: 'timer' }),
        N('t2', 'userTask', 'F2'), N('t3', 'userTask', 'A'), N('e', 'endEvent', 'A'), N('e2', 'endEvent', 'A'),
        N('sp', 'subProcess', 'F2', { isExpanded: true, nodes: [N('is', 'startEvent'), N('it', 'userTask'), N('ie', 'endEvent')], edges: chain(['is', 'it', 'ie']) })],
      edges: [...chain(['s', 't1', 't2', 'sp', 'e']), { source: 'b', target: 't3' }, { source: 't3', target: 'e2' }],
    }),
    'a collaboration, the nested pool first': () => ({
      pools: [{ ...deep(), id: 'N', name: 'N' }, flatPool('X')],
      messageFlows: [{ id: 'mf1', source: 't3', target: 'Xt', name: 'hello' }],
    }),
    'a collaboration, the nested pool below a pool whose lanes are compacted': () => ({
      pools: [flatPool('X'), { ...deep(), id: 'N', name: 'N' }],
      messageFlows: [{ id: 'mf1', source: 'Xt', target: 't3', name: 'hello' }],
    }),
    'a collaboration with pools without lanes and a black-box participant': () => ({
      pools: [lanelessPool('X'), { ...deep(), id: 'N', name: 'N' }, lanelessPool('Y')],
      collapsedPools: [{ id: 'BB', name: 'BB' }],
      messageFlows: [{ id: 'mf1', source: 'Xt', target: 't3', name: 'hello' }, { id: 'mf2', source: 't5', target: 'BB' }],
    }),
  };

  test.each(Object.keys(CASES))('%s: clean in every hash mode, layout switches off and on', async (name) => {
    const ON = Object.fromEntries(Object.keys(OFF).map((k) => [k, true]));
    for (const [mode, opts] of Object.entries(MODES)) {
      for (const [label, switches] of [['off', OFF], ['on', ON]]) {
        const lc = CASES[name]();
        const r = await runPipeline(lc, { ...opts, ...switches });
        expect([mode, label, diCodes(r), laneFindings(r, lc), r.validation.xmlWarnings]).toEqual([mode, label, {}, CLEAN, []]);
      }
    }
  });

  test('three levels: each level is one header strip further in, a parent with own nodes starts above its first child', async () => {
    const { coordMap: { laneCoords: b } } = await runPipeline(deep());
    expect([b.F.x, b.F1.x, b.F1a.x, b.F1b.x, b.F2.x].map((x) => x - b.A.x)).toEqual([0, 1, 2, 2, 1].map((n) => n * LANE_HEADER_W));
    expect([b.F.w, b.F1.w, b.F1a.w, b.F1b.w, b.F2.w].map((w) => b.A.w - w)).toEqual([0, 1, 2, 2, 1].map((n) => n * LANE_HEADER_W));
    // Stacked without a strip: A, F's own band, F1's own band, F1a, F1b, F2.
    expect(b.F.y).toBe(b.A.y + b.A.h);
    expect(b.F1.y).toBeGreaterThan(b.F.y);
    expect(b.F1a.y).toBeGreaterThan(b.F1.y);
    expect(b.F1b.y).toBe(b.F1a.y + b.F1a.h);
    expect(b.F1.y + b.F1.h).toBe(b.F1b.y + b.F1b.h);
    expect(b.F2.y).toBe(b.F1.y + b.F1.h);
    expect(b.F.y + b.F.h).toBe(b.F2.y + b.F2.h);
  });

  test('a boundary event in a child lane faces a target in a band above', async () => {
    const r = await runPipeline(CASES['a boundary event and an expanded subprocess in child lanes']());
    const { b, t1 } = r.coordMap.coords;
    expect(b.y + b.h / 2).toBe(t1.y);
  });
});

// Flat processes too: the nested-lane rules must not move a node of a flat process out of its lane.
describe('every fixture, every hash mode: no lane without a band, no node outside its lane', () => {
  // Pre-existing flat findings, pinned: `<fixture> × <mode>` -> the expected findings.
  const KNOWN = {};

  test.each(FIXTURES)('%s', async (name) => {
    const raw = readFileSync(join(FIXTURES_DIR, name), 'utf8');
    for (const [mode, opts] of Object.entries(MODES)) {
      const lc = JSON.parse(raw);
      const r = await runPipeline(lc, { ...opts, ...OFF });
      if (!r.coordMap) continue; // blocked on purpose (deadlock-process)
      expect([`${name} × ${mode}`, laneFindings(r, lc)]).toEqual([`${name} × ${mode}`, KNOWN[`${name} × ${mode}`] ?? CLEAN]);
    }
  });
});
