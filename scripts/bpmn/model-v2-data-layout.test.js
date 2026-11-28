/**
 * Layout of the data references a format 2.1 step's `dataAccess` derives (private `_dataRef`):
 * they take no part in the lane order, sit in one row below their step, keep clear of each other,
 * of flow nodes and of the lines of their neighbours, draw read plus write of one item as two
 * parallel lines, stay inside an expanded subprocess and a lane-less participant, and are written
 * but not drawn when their step lies inside a collapsed subprocess.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './pipeline.js';
import { resolveFields, formLanes } from './model-v2.js';
import { sortNodesTopologically, orderLanesByFlow } from './topology.js';
import { loadNamedView } from '../shared/view.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const PIPELINE = join(ROOT, 'scripts', 'bpmn', 'pipeline.js');
// sha256 of tests/bench/default-output-hashes.json at the branch base: data changes nothing there.
const SNAPSHOT_SHA = '09b5f79e6e70c741569ae428908d0bc48894b880c0206d61b0d4ad27e7f01131';
const copy = (v) => JSON.parse(JSON.stringify(v));
const fixture = (name) => JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures-v2', name), 'utf8'));

// ─── models ─────────────────────────────────────────────────────────────────────────────────────

/** The quick start of docs/roles-and-systems.md, read from its marked snippets. */
const snippets = Object.fromEntries(
  [...readFileSync(join(ROOT, 'docs', 'roles-and-systems.md'), 'utf8')
    .matchAll(/<!-- quickstart: ([\w.-]+) -->\n```(?:jsonc|bash)\n([\s\S]*?)```/g)].map((m) => [m[1], m[2]]),
);
const QS_DATA = [
  { id: 'd_order', name: 'Order', kind: 'object', layer: 'business' },
  { id: 'd_invoice', name: 'Invoice', kind: 'object' },
  { id: 'd_register', name: 'Order register', kind: 'store', layer: 'technical' },
];
const QS_ACCESS = {
  check: [{ data: 'd_order', access: 'read' }, { data: 'd_register', access: 'write' }],
  pay: [{ data: 'd_invoice', access: 'read' }, { data: 'd_order' }],
};
const qsCatalog = () => ({ ...JSON.parse(snippets['catalog.json']), data: QS_DATA });
const qsModel = (withData = true) => {
  const m = JSON.parse(snippets['quickstart.json']);
  if (withData) for (const n of m.pools[0].nodes) if (QS_ACCESS[n.id]) n.dataAccess = QS_ACCESS[n.id];
  return m;
};

const B_DATA = [
  { id: 'd_bestellung', name: 'Bestellung', kind: 'object', layer: 'business' },
  { id: 'd_rechnungen', name: 'Rechnungen', kind: 'object', isCollection: true },
  { id: 'd_register', name: 'Bestellregister', kind: 'store', layer: 'technical' },
];
const bCatalog = () => ({ ...fixture('bestellung-catalog.json'), data: B_DATA });
const B_ACCESS = {
  pruefen: [{ data: 'd_bestellung', access: 'read' }, { data: 'd_register', access: 'write' }],
  rueck: [{ data: 'd_bestellung' }],
  zahlen: [{ data: 'd_bestellung', access: 'read' }, { data: 'd_rechnungen', access: 'read' }, { data: 'd_rechnungen', access: 'write' }],
};
/** bestellung.json as "2.1", with `access` (node id → dataAccess) applied. */
const bModel = (access = B_ACCESS) => {
  const m = { ...fixture('bestellung.json'), $schemaVersion: '2.1' };
  delete m.catalog;
  for (const n of m.nodes) if (access[n.id]) n.dataAccess = access[n.id];
  return m;
};

/** A neutral order-handling catalogue: one role, three data items. */
const CAT = {
  scheme: 'demi',
  actors: [{ id: 'r_clerk', name: 'Clerk', kind: 'role' }],
  data: [
    { id: 'd_order', name: 'Order', kind: 'object' },
    { id: 'd_invoice', name: 'Invoice', kind: 'object' },
    { id: 'd_register', name: 'Order register', kind: 'store' },
  ],
};
const D = [{ type: 'D', actor: 'r_clerk' }];
const R = (data) => ({ data, access: 'read' });
const W = (data) => ({ data, access: 'write' });

/** start → a → b → end in one lane; a and b with the given data access. */
const linear = (aAccess, bAccess) => ({
  $schemaVersion: '2.1', language: 'en', id: 'Process_Order', name: 'Order handling',
  nodes: [
    { id: 'start', type: 'startEvent', name: 'Order received', assignments: D },
    { id: 'a', type: 'userTask', name: 'Check order', assignments: D, dataAccess: aAccess },
    { id: 'b', type: 'userTask', name: 'Book order', assignments: D, ...(bAccess ? { dataAccess: bAccess } : {}) },
    { id: 'end', type: 'endEvent', name: 'Order booked', assignments: D },
  ],
  edges: [{ source: 'start', target: 'a' }, { source: 'a', target: 'b' }, { source: 'b', target: 'end' }],
});
const THREE = linear([R('d_order'), W('d_invoice'), R('d_register')]);
const ADJACENT_32 = linear([R('d_order'), W('d_invoice'), R('d_register')], [R('d_order'), W('d_register')]);
const ADJACENT_33 = linear([R('d_order'), W('d_invoice'), R('d_register')], [W('d_order'), R('d_invoice'), W('d_register')]);
const READ_WRITE = linear([R('d_order'), W('d_order')]);

/** Two roles; a catalogue of six data items for long chains. */
const CAT2 = {
  scheme: 'demi',
  actors: [{ id: 'r_clerk', name: 'Clerk', kind: 'role' }, { id: 'r_lead', name: 'Team lead', kind: 'role' }],
  data: Array.from({ length: 6 }, (_, i) => ({ id: `d_${i}`, name: `Order item ${i}`, kind: i % 3 === 2 ? 'store' : 'object' })),
};
const LEAD = [{ type: 'D', actor: 'r_lead' }];

/** start → t0 … t(n-1) → end, three references per step; with `twoLanes` every fourth step and the end are the lead's. */
function chain(n, twoLanes) {
  const nodes = [{ id: 'start', type: 'startEvent', name: 'Order received', assignments: D }];
  const edges = [];
  let prev = 'start';
  for (let i = 0; i < n; i++) {
    const id = `t${i}`;
    nodes.push({
      id, type: 'userTask', name: `Check order ${i}`, assignments: twoLanes && i % 4 === 3 ? LEAD : D,
      dataAccess: [0, 1, 2].map((k) => ({ data: `d_${(i + k) % 6}`, access: k % 2 ? 'write' : 'read' })),
    });
    edges.push({ source: prev, target: id });
    prev = id;
  }
  nodes.push({ id: 'end', type: 'endEvent', name: 'Order done', assignments: twoLanes ? LEAD : D });
  edges.push({ source: prev, target: 'end' });
  return { $schemaVersion: '2.1', language: 'en', id: 'Process_Order', name: 'Order handling', nodes, edges };
}

/** The lead's step y with three references and a timer on its bottom border, after a gateway in the clerk's lane. */
const BOUNDARY = {
  $schemaVersion: '2.1', language: 'en', id: 'Process_Order', name: 'Order handling',
  nodes: [
    { id: 's', type: 'startEvent', name: 'Order received', assignments: D },
    { id: 'x', type: 'userTask', name: 'Check order', assignments: D },
    { id: 'gw', type: 'exclusiveGateway', name: 'Order valid?', assignments: D },
    { id: 'y', type: 'userTask', name: 'Approve order', assignments: LEAD, dataAccess: [R('d_0'), W('d_1'), R('d_2')] },
    { id: 'bt', type: 'boundaryEvent', attachedTo: 'y', marker: 'timer', name: 'Two days passed', cancelActivity: false },
    { id: 'h', type: 'userTask', name: 'Remind lead', assignments: LEAD },
    { id: 'he', type: 'endEvent', name: 'Lead reminded', assignments: LEAD },
    { id: 'rej', type: 'endEvent', name: 'Order rejected', assignments: D },
    { id: 'e', type: 'endEvent', name: 'Order done', assignments: LEAD },
  ],
  edges: [
    { id: 'f1', source: 's', target: 'x' }, { id: 'f2', source: 'x', target: 'gw' },
    { id: 'f3', source: 'gw', target: 'y', label: 'yes' }, { id: 'f4', source: 'gw', target: 'rej', label: 'no' },
    { id: 'f5', source: 'y', target: 'e' }, { id: 'f6', source: 'bt', target: 'h' }, { id: 'f7', source: 'h', target: 'he' },
  ],
};

/** Two lanes: the clerk's a (three references) and b (two) side by side, then the lead's c. */
const TWO_LANES = {
  $schemaVersion: '2.1', language: 'en', id: 'Process_Order', name: 'Order handling',
  nodes: [
    { id: 'start', type: 'startEvent', name: 'Order received', assignments: D },
    { id: 'a', type: 'userTask', name: 'Check order', assignments: D, dataAccess: [R('d_0'), W('d_1'), R('d_2')] },
    { id: 'b', type: 'userTask', name: 'Book order', assignments: D, dataAccess: [R('d_1'), W('d_2')] },
    { id: 'c', type: 'userTask', name: 'Approve order', assignments: LEAD },
    { id: 'end', type: 'endEvent', name: 'Order approved', assignments: LEAD },
  ],
  edges: [{ source: 'start', target: 'a' }, { source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'c', target: 'end' }],
};

/** A subprocess with one inner step that reads the order. */
const withSubprocess = (isExpanded) => ({
  $schemaVersion: '2.1', language: 'en', id: 'Process_Order', name: 'Order handling',
  nodes: [
    { id: 'start', type: 'startEvent', name: 'Order received', assignments: D },
    {
      id: 'sp', type: 'subProcess', name: 'Handle order', isExpanded, assignments: D,
      nodes: [
        { id: 'in_s', type: 'startEvent', name: 'Handling started' },
        { id: 'inner', type: 'userTask', name: 'Check order', assignments: D, dataAccess: [R('d_order'), W('d_register')] },
        { id: 'in_e', type: 'endEvent', name: 'Handling done' },
      ],
      edges: [{ id: 'i1', source: 'in_s', target: 'inner' }, { id: 'i2', source: 'inner', target: 'in_e' }],
    },
    { id: 'end', type: 'endEvent', name: 'Order done', assignments: D },
  ],
  edges: [{ id: 'f1', source: 'start', target: 'sp' }, { id: 'f2', source: 'sp', target: 'end' }],
});

/** Two participants without lanes (no assignments), joined by a message flow. */
const LANELESS = {
  $schemaVersion: '2.1', language: 'en',
  pools: [
    {
      id: 'P_shop', name: 'Shop',
      nodes: [
        { id: 's', type: 'startEvent', name: 'Order received' },
        { id: 't', type: 'userTask', name: 'Check order', dataAccess: [R('d_order'), W('d_register')] },
        { id: 'snd', type: 'sendTask', name: 'Send invoice', dataAccess: [W('d_invoice')] },
        { id: 'e', type: 'endEvent', name: 'Order done' },
      ],
      edges: [{ id: 'f1', source: 's', target: 't' }, { id: 'f2', source: 't', target: 'snd' }, { id: 'f3', source: 'snd', target: 'e' }],
    },
    {
      id: 'P_cust', name: 'Customer',
      nodes: [
        { id: 'cs', type: 'startEvent', name: 'Invoice received', marker: 'message' },
        { id: 'ct', type: 'userTask', name: 'Pay invoice', dataAccess: [R('d_invoice'), { data: 'd_order' }] },
        { id: 'ce', type: 'endEvent', name: 'Invoice paid' },
      ],
      edges: [{ id: 'g1', source: 'cs', target: 'ct' }, { id: 'g2', source: 'ct', target: 'ce' }],
    },
  ],
  messageFlows: [{ id: 'm1', source: 'snd', target: 'cs', name: 'Invoice' }],
};

// ─── helpers ────────────────────────────────────────────────────────────────────────────────────

async function generate(model, catalog = CAT, view = 'rollen') {
  const r = await runPipeline(copy(model), { catalog: copy(catalog), view: loadNamedView(view) });
  expect(r.validation.errors).toEqual([]);
  return r;
}

/** Lane name → its flowNodeRefs, in document order. */
function lanesOf(xml) {
  return [...xml.matchAll(/<bpmn:lane id="[^"]*" name="([^"]*)">([\s\S]*?)<\/bpmn:lane>/g)]
    .map((m) => [m[1], [...m[2].matchAll(/<bpmn:flowNodeRef>([^<]*)<\/bpmn:flowNodeRef>/g)].map((x) => x[1])]);
}

const refIds = (coordMap) => Object.keys(coordMap.coords).filter((id) => /__/.test(id));
const isRef = (id) => /^[^_].*__d_/.test(id);
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a, b) => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.w <= b.x + b.w + 0.5 && a.y + a.h <= b.y + b.h + 0.5;

/** Does segment p→q cross the inside of rectangle r (Liang–Barsky, shrunk by 1 px)? */
function segmentHitsRect(p, q, r0) {
  const r = { x: r0.x + 1, y: r0.y + 1, w: r0.w - 2, h: r0.h - 2 };
  let t0 = 0; let t1 = 1;
  const dx = q.x - p.x; const dy = q.y - p.y;
  for (const [pp, qq] of [[-dx, p.x - r.x], [dx, r.x + r.w - p.x], [-dy, p.y - r.y], [dy, r.y + r.h - p.y]]) {
    if (pp === 0) { if (qq < 0) return false; continue; }
    const t = qq / pp;
    if (pp < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t0 < t1;
}
const routeHitsRect = (pts, r) => pts.slice(1).some((q, i) => segmentHitsRect(pts[i], q, r));

/** The derived links of the run, id → { source, target }. */
const linksOf = (r) => Object.fromEntries(Object.keys(r.coordMap.edgeCoords)
  .filter((id) => /__(read|write|link)$/.test(id)).map((id) => [id, id.replace(/__(read|write|link)$/, '')]));

/** The lane box holding the centre of node `id`. */
function laneOf(coordMap, id) {
  const c = coordMap.coords[id];
  const cx = c.x + c.w / 2; const cy = c.y + c.h / 2;
  return Object.values(coordMap.laneCoords).find((l) => cx >= l.x && cx <= l.x + l.w && cy >= l.y && cy <= l.y + l.h);
}

/** Run the CLI with --strict; returns { status, out, dir }. */
function cli(model, catalog = CAT, view = 'rollen') {
  const dir = mkdtempSync(join(tmpdir(), 'data-layout-'));
  writeFileSync(join(dir, 'model.json'), JSON.stringify(model));
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify(catalog));
  const run = spawnSync(process.execPath, [PIPELINE, join(dir, 'model.json'), join(dir, 'out'), `--catalog=${join(dir, 'catalog.json')}`, `--view=${view}`, '--strict'],
    { cwd: join(ROOT, 'scripts'), encoding: 'utf8' });
  return { status: run.status, out: run.stdout + run.stderr, dir };
}

// ─── tests ──────────────────────────────────────────────────────────────────────────────────────

describe('derived data references take no part in the lane order (review focus 1, M4)', () => {
  test('without the guard the quick-start lanes would reorder (sanity check)', () => {
    const fields = resolveFields(qsModel(), { catalog: qsCatalog(), viewName: 'rollen' });
    expect(fields.errors).toEqual([]);
    const formed = formLanes(fields.lc, fields.resolved, { lanes: 'role' });
    expect(formed.errors).toEqual([]);
    const proc = copy(formed.lc.pools[0]);
    sortNodesTopologically(proc);
    const guarded = copy(proc);
    orderLanesByFlow(guarded);
    // The same nodes with the carrier removed: what an unguarded orderLanesByFlow would count.
    const unguarded = copy(proc);
    for (const n of unguarded.nodes) delete n._dataRef;
    orderLanesByFlow(unguarded);
    expect(guarded.lanes.map((l) => l.name)).toEqual(['Case worker', 'Team lead', 'Accountant', '(nicht zugeordnet)']);
    expect(unguarded.lanes.map((l) => l.name)).toEqual(['Case worker', 'Team lead', '(nicht zugeordnet)', 'Accountant']);
  });

  test.each(['rollen', 'einheiten', 'organigramm', 'systeme'])('quick start × %s: lanes, their order and every flowNodeRef equal the model without dataAccess', async (view) => {
    const bare = await generate(qsModel(false), qsCatalog(), view);
    const data = await generate(qsModel(), qsCatalog(), view);
    expect(data.bpmnXml).toContain('<bpmn:dataInputAssociation');
    expect(lanesOf(data.bpmnXml)).toEqual(lanesOf(bare.bpmnXml));
  });

  test.each(['rollen', 'einheiten'])('bestellung × %s: lanes, their order and every flowNodeRef equal the model without dataAccess', async (view) => {
    const bare = await generate(bModel({}), bCatalog(), view);
    const data = await generate(bModel(), bCatalog(), view);
    expect(lanesOf(data.bpmnXml)).toEqual(lanesOf(bare.bpmnXml));
  });
});

describe('derived data references in a row below their step', () => {
  test('three references under one step: below it, inside its lane band, no line through another reference', async () => {
    const r = await generate(THREE);
    const { coords, nodeLabels } = r.coordMap;
    const refs = ['a__d_order', 'a__d_invoice', 'a__d_register'];
    const step = coords.a;
    const lane = laneOf(r.coordMap, 'a');
    // one row: the same top edge for the two data objects, left to right
    expect(coords.a__d_order.y).toBe(coords.a__d_invoice.y);
    for (const id of refs) {
      expect(coords[id].y).toBeGreaterThanOrEqual(step.y + step.h);
      expect(inside(coords[id], lane)).toBe(true);
      expect(inside(nodeLabels[id], lane)).toBe(true);
    }
    const links = linksOf(r);
    expect(Object.keys(links)).toHaveLength(3);
    for (const [link, ref] of Object.entries(links)) {
      for (const other of refs.filter((x) => x !== ref)) {
        expect(routeHitsRect(r.coordMap.edgeCoords[link], coords[other])).toBe(false);
        expect(routeHitsRect(r.coordMap.edgeCoords[link], nodeLabels[other])).toBe(false);
      }
      expect(routeHitsRect(r.coordMap.edgeCoords[link], nodeLabels[ref])).toBe(false);
    }
  });

  test.each([['two and three', ADJACENT_32], ['three and three', ADJACENT_33]])('adjacent steps with %s references: no reference box overlaps another or a flow node', async (_, model) => {
    const r = await generate(model);
    const { coords, nodeLabels, edgeCoords } = r.coordMap;
    const refs = refIds(r.coordMap).filter(isRef);
    expect(refs.length).toBeGreaterThanOrEqual(5);
    const boxes = refs.flatMap((id) => [[id, coords[id]], [id, nodeLabels[id]]]);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (boxes[i][0] === boxes[j][0]) continue;
        expect([boxes[i][0], boxes[j][0], overlap(boxes[i][1], boxes[j][1])]).toEqual([boxes[i][0], boxes[j][0], false]);
      }
    }
    const flowNodes = ['start', 'a', 'b', 'end'];
    for (const [id, box] of boxes) {
      for (const n of flowNodes) {
        expect([id, n, overlap(box, coords[n])]).toEqual([id, n, false]);
        if (nodeLabels[n]) expect([id, n, overlap(box, nodeLabels[n])]).toEqual([id, n, false]);
      }
    }
    // no derived link runs through another step's references
    for (const [link, ref] of Object.entries(linksOf(r))) {
      for (const [id, box] of boxes) {
        if (id === ref) continue;
        expect([link, id, routeHitsRect(edgeCoords[link], box)]).toEqual([link, id, false]);
      }
    }
  });

  test('read and write of one item: two distinct waypoint lists, 8 px apart and parallel', async () => {
    const r = await generate(READ_WRITE);
    const read = r.coordMap.edgeCoords['a__d_order__read'];
    const write = r.coordMap.edgeCoords['a__d_order__write'];
    expect(read).toHaveLength(2);
    expect(write).toHaveLength(2);
    expect(read).not.toEqual(write);
    expect(read).not.toEqual([...write].reverse());
    const dir = (pts) => { const dx = pts[1].x - pts[0].x; const dy = pts[1].y - pts[0].y; const l = Math.hypot(dx, dy); return { x: dx / l, y: dy / l }; };
    const u = dir(read); const v = dir(write);
    expect(Math.abs(u.x * v.y - u.y * v.x)).toBeLessThan(1e-6);
    // perpendicular distance of the write line's start from the read line
    const d = Math.abs((write[0].x - read[0].x) * u.y - (write[0].y - read[0].y) * u.x);
    expect(d).toBeCloseTo(8, 5);
    // the read line first: on the left of a reference below its step
    expect(read[0].x + read[1].x).toBeLessThan(write[0].x + write[1].x);
    // each clipped to both shapes: its ends lie on the borders of the step and the reference
    const onBorder = (p, c) => p.x >= c.x - 0.01 && p.x <= c.x + c.w + 0.01 && p.y >= c.y - 0.01 && p.y <= c.y + c.h + 0.01
      && (Math.abs(p.x - c.x) < 0.01 || Math.abs(p.x - c.x - c.w) < 0.01 || Math.abs(p.y - c.y) < 0.01 || Math.abs(p.y - c.y - c.h) < 0.01);
    const { coords } = r.coordMap;
    expect(onBorder(read[0], coords.a__d_order) && onBorder(read[1], coords.a)).toBe(true);
    expect(onBorder(write[0], coords.a) && onBorder(write[1], coords.a__d_order)).toBe(true);
    // the XML carries the same two routes
    expect(r.bpmnXml).toMatch(/<bpmndi:BPMNEdge id="a__d_order__read_di"/);
    expect(r.bpmnXml).toMatch(/<bpmndi:BPMNEdge id="a__d_order__write_di"/);
  });

  test('a reference of a step in an expanded subprocess lies inside the subprocess (no DI06)', async () => {
    const r = await generate(withSubprocess(true));
    const { coords, nodeLabels } = r.coordMap;
    for (const id of ['inner__d_order', 'inner__d_register']) {
      expect(inside(coords[id], coords.sp)).toBe(true);
      expect(inside(nodeLabels[id], coords.sp)).toBe(true);
    }
    expect(r.diagnostics.issues.map((i) => i.code)).not.toContain('DI06');
  });

  test('a step inside a collapsed subprocess: its references are written, not drawn', async () => {
    const r = await generate(withSubprocess(false));
    for (const id of ['inner__d_order', 'inner__d_register']) {
      expect(r.bpmnXml).toMatch(new RegExp(`<bpmn:data(Object|Store)Reference id="${id}"`));
      expect(r.bpmnXml).not.toContain(`bpmnElement="${id}"`);
      expect(r.coordMap.coords[id]).toBeUndefined();
      expect(r.svg).not.toContain(id);
    }
    for (const link of ['inner__d_order__read', 'inner__d_register__write']) {
      expect(r.bpmnXml).toContain(`id="${link}"`);
      expect(r.bpmnXml).not.toContain(`bpmnElement="${link}"`);
    }
    expect(r.diagnostics.issues).toEqual([]);
  });

  test('a lane-less participant holds the shape and label of each of its references', async () => {
    const r = await generate(LANELESS);
    const { coords, nodeLabels, poolCoords } = r.coordMap;
    const owner = { t: 'P_shop', snd: 'P_shop', ct: 'P_cust' };
    const refs = refIds(r.coordMap).filter(isRef);
    expect(refs).toHaveLength(5);
    for (const id of refs) {
      const pool = poolCoords[owner[id.split('__')[0]]];
      expect([id, inside(coords[id], pool)]).toEqual([id, true]);
      expect([id, inside(nodeLabels[id], pool)]).toEqual([id, true]);
    }
    expect(r.diagnostics.issues).toEqual([]);
  });
});

describe('derived data references: lanes, chains and diagonal pairs', () => {
  /** Every reference box (shape, label) against every other one and every flow node box (shape, label). */
  function assertNoOverlap(r) {
    const { coords, nodeLabels } = r.coordMap;
    const refs = refIds(r.coordMap).filter(isRef);
    const flow = Object.keys(coords).filter((id) => !refs.includes(id) && !/^Process|^P_/.test(id));
    const refBoxes = refs.flatMap((id) => [[id, coords[id]], [id, nodeLabels[id]]]);
    const flowBoxes = flow.flatMap((id) => [[id, coords[id]], ...(nodeLabels[id] ? [[id, nodeLabels[id]]] : [])]);
    const hits = [];
    for (let i = 0; i < refBoxes.length; i++) {
      for (let j = i + 1; j < refBoxes.length; j++) {
        if (refBoxes[i][0] !== refBoxes[j][0] && overlap(refBoxes[i][1], refBoxes[j][1])) hits.push(`${refBoxes[i][0]}/${refBoxes[j][0]}`);
      }
      for (const [id, box] of flowBoxes) if (overlap(refBoxes[i][1], box)) hits.push(`${refBoxes[i][0]}/${id}`);
    }
    expect(hits).toEqual([]);
    return refs;
  }

  test('two lanes: each reference lies in its step\'s lane band and overlaps no node of the other lane', async () => {
    const r = await generate(TWO_LANES, CAT2);
    const { coords, nodeLabels } = r.coordMap;
    const refs = assertNoOverlap(r);
    expect(refs).toHaveLength(5);
    const clerk = laneOf(r.coordMap, 'a');
    expect(laneOf(r.coordMap, 'c')).not.toBe(clerk);
    for (const id of refs) {
      expect([id, inside(coords[id], clerk), inside(nodeLabels[id], clerk)]).toEqual([id, true, true]);
      for (const other of ['c', 'end']) expect([id, other, overlap(coords[id], coords[other])]).toEqual([id, other, false]);
    }
    expect(r.diagnostics.issues).toEqual([]);
  });

  test.each([[3, false], [12, false], [3, true], [12, true], [20, true]])('a chain of %i steps with three references each (two lanes: %s): no overlap, no DI finding', async (n, twoLanes) => {
    const r = await generate(chain(n, twoLanes), CAT2);
    expect(r.diagnostics.issues).toEqual([]);
    expect(assertNoOverlap(r)).toHaveLength(3 * n);
    for (let i = 0; i < n; i++) {
      for (const id of refIds(r.coordMap).filter((x) => x.startsWith(`t${i}__`))) {
        expect([id, inside(r.coordMap.coords[id], laneOf(r.coordMap, `t${i}`))]).toEqual([id, true]);
      }
    }
  });

  test('a step with a boundary event on its bottom border: no derived link crosses the event or its label', async () => {
    const r = await generate(BOUNDARY, CAT2);
    const { coords, nodeLabels, edgeCoords } = r.coordMap;
    // the timer sits on the bottom border of its step
    expect(coords.bt.y + coords.bt.h / 2).toBeCloseTo(coords.y.y + coords.y.h, 0);
    const links = Object.keys(linksOf(r)).filter((id) => id.startsWith('y__'));
    expect(links).toHaveLength(3);
    for (const link of links) {
      expect([link, routeHitsRect(edgeCoords[link], coords.bt), routeHitsRect(edgeCoords[link], nodeLabels.bt)]).toEqual([link, false, false]);
    }
    assertNoOverlap(r);
    expect(r.diagnostics.issues).toEqual([]);
  });

  test('a diagonal read and write pair (bestellung, zahlen and Rechnungen): the read line first, 8 px apart', async () => {
    const r = await generate(bModel(), bCatalog());
    const read = r.coordMap.edgeCoords['zahlen__d_rechnungen__read'];
    const write = r.coordMap.edgeCoords['zahlen__d_rechnungen__write'];
    // diagonal: neither horizontal nor vertical
    expect(Math.abs(read[1].x - read[0].x)).toBeGreaterThan(1);
    expect(Math.abs(read[1].y - read[0].y)).toBeGreaterThan(1);
    const u = { x: read[1].x - read[0].x, y: read[1].y - read[0].y };
    const len = Math.hypot(u.x, u.y);
    const v = { x: write[1].x - write[0].x, y: write[1].y - write[0].y };
    expect(Math.abs(u.x * v.y - u.y * v.x) / (len * Math.hypot(v.x, v.y))).toBeLessThan(1e-6);
    expect(Math.abs((write[0].x - read[0].x) * u.y - (write[0].y - read[0].y) * u.x) / len).toBeCloseTo(8, 5);
    expect(read[0].x + read[1].x).toBeLessThan(write[0].x + write[1].x);
  });
});

describe('generate --strict exits 0', () => {
  test.each([
    ['three references', THREE, CAT], ['adjacent 2 + 3', ADJACENT_32, CAT], ['adjacent 3 + 3', ADJACENT_33, CAT],
    ['read and write', READ_WRITE, CAT], ['expanded subprocess', withSubprocess(true), CAT],
    ['collapsed subprocess', withSubprocess(false), CAT], ['lane-less participants', LANELESS, CAT],
    ['quick start', qsModel(), qsCatalog()], ['bestellung', bModel(), bCatalog()],
    ['two lanes', TWO_LANES, CAT2], ['boundary event', BOUNDARY, CAT2], ['chain of 3, one lane', chain(3, false), CAT2], ['chain of 12, two lanes', chain(12, true), CAT2],
  ])('%s', (_, model, catalog) => {
    const { status, out, dir } = cli(model, catalog);
    try {
      expect(out).not.toMatch(/Error|DI0\d/);
      expect(status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a model without data keeps its output', () => {
  test('the default-output hash snapshot is the committed one (108 entries)', () => {
    const text = readFileSync(join(ROOT, 'tests', 'bench', 'default-output-hashes.json'), 'utf8');
    expect(Object.keys(JSON.parse(text))).toHaveLength(108);
    expect(createHash('sha256').update(text).digest('hex')).toBe(SNAPSHOT_SHA);
  });
});
