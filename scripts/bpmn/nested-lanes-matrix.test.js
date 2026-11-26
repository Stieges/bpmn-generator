/**
 * Characterisation of how nested lanes of 1.x models are laid out today, as pinned tests.
 *
 * Nested lanes are written to the XML but not laid out: child lanes get no BPMNShape and no
 * `laneCoords` entry, and nodes of a child lane are drawn in the band of another lane. Every
 * "today:" pin below records that state and flips when nested lanes are laid out.
 *
 * `laneFindings` is the oracle: the DI checks see no node outside its own lane.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../../tests/fixtures/nested-lanes-role-system.json');

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
 * Lanes without a `laneCoords` entry or a BPMNShape, and flow nodes whose centre is not inside the
 * band (laneCoords rectangle) of their own lane. A node whose own lane has no band counts as outside.
 */
function laneFindings(result, lc) {
  const laneCoords = result.coordMap?.laneCoords || {};
  const coords = result.coordMap?.coords || {};
  const xml = result.bpmnXml || '';
  const missingShapes = [];
  walkLanes(lc.lanes, (l) => {
    const hasShape = new RegExp(`<bpmndi:BPMNShape\\b[^>]*\\bbpmnElement="${l.id}"`).test(xml);
    if (!laneCoords[l.id] || !hasShape) missingShapes.push(l.id);
  });
  const outside = [];
  for (const n of lc.nodes || []) {
    if (!n.lane) continue;
    const c = coords[n.id];
    if (!c) continue;
    const b = laneCoords[n.lane];
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    if (!b || cx < b.x || cx > b.x + b.w || cy < b.y || cy > b.y + b.h) outside.push(n.id);
  }
  return { missingShapes, outside };
}

const diCount = (r, code) => (r.diagnostics?.issues || []).filter((i) => i.code === code).length;
const diCodes = (r) => {
  const out = {};
  for (const i of r.diagnostics?.issues || []) out[i.code] = (out[i.code] || 0) + 1;
  return out;
};

/** Run one case and return the DI codes with counts and the lane findings. */
async function measure(lc) {
  const r = await runPipeline(lc);
  return { di: diCodes(r), findings: laneFindings(r, lc) };
}

// Every pin below is today's behaviour of a broken layout and flips when nested lanes are laid out.
describe('nested lanes of 1.x models, today', () => {
  const rows = [
    ['m1', 'flat lane, then a parent with two child lanes', [A, F('F1', 'F2')],
      { A: 's t1', F1: 't2 g', F2: 't3 t4 e' },
      { DI03: 1, DI07: 2 }, ['F1', 'F2'], ['t2', 'g', 't3', 't4', 'e']],
    ['m2', 'most nodes in the flat lane, one in each child lane', [A, F('F1', 'F2')],
      { A: 's t1 t2 g e', F1: 't3', F2: 't4' },
      { DI03: 1, DI07: 2 }, ['F1', 'F2'], ['t3', 't4']],
    ['m3', 'flat and child lanes interleaved along the flow', [A, F('F1', 'F2')],
      { A: 's t1 e', F1: 't2 t4', F2: 'g t3' },
      { DI03: 1, DI07: 2 }, ['F1', 'F2'], ['t2', 'g', 't3', 't4']],
    ['m4', 'a parent with a single child lane', [A, F('F1')],
      { A: 's t1 t4 e', F1: 't2 g t3' },
      {}, ['F1'], ['t2', 'g', 't3']],
    ['m5', 'only a parent with two child lanes', [F('F1', 'F2')],
      { F1: 's t1 t2 g', F2: 't3 t4 e' },
      { DI03: 7 }, ['F1', 'F2'], ['s', 't1', 't2', 'g', 't3', 't4', 'e']],
    ['m6', 'two parents with two child lanes each', [{ id: 'A', name: 'A', children: [{ id: 'A1', name: 'A1' }, { id: 'A2', name: 'A2' }] }, F('F1', 'F2')],
      { A1: 's t1', A2: 't2 g', F1: 't3', F2: 't4 e' },
      { DI03: 7 }, ['A1', 'A2', 'F1', 'F2'], ['s', 't1', 't2', 'g', 't3', 't4', 'e']],
    ['m7', 'flat lane around the child lanes', [A, F('F1', 'F2')],
      { A: 's g e', F1: 't1 t2', F2: 't3 t4' },
      { DI03: 1, DI07: 1 }, ['F1', 'F2'], ['t1', 't2', 't3', 't4']],
  ];

  test.each(rows)('today: %s, %s', async (_id, _what, lanes, spec, di, missingShapes, outside) => {
    const lc = model(lanes, place(spec));
    const m = await measure(lc);
    expect(m.di).toEqual(di);
    expect(m.findings).toEqual({ missingShapes, outside });
  });

  test('today: f0, the slice-0 fixture is DI-clean with its child lanes unshaped', async () => {
    const lc = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const m = await measure(lc);
    expect(m.di).toEqual({});
    expect(m.findings).toEqual({ missingShapes: ['lane_pruefung', 'lane_freigabe'], outside: ['pruefen', 'freigeben'] });
  });

  test('today: p1, a node placed directly in the parent lane lays out without error', async () => {
    // The parent has a band, so the node counts as inside it; only the child lane is unshaped.
    const lc = model([A, F('F1')], place({ A: 's t1 t2 g t4 e', F: 't3' }));
    const m = await measure(lc);
    expect(m.di).toEqual({});
    expect(m.findings).toEqual({ missingShapes: ['F1'], outside: [] });
  });
});
