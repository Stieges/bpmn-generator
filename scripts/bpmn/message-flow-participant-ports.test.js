/**
 * Fence for `layout.alignParticipantPorts` (routeMessageFlows / planMessageFlow, coordinates.js): a
 * message flow between a shape and a participant (a black-box pool, or an expanded pool named as an
 * endpoint) docks on the participant level with the shape — straight down or up — instead of at the
 * middle of the participant's band, where every such flow used to converge. Two parts:
 *  - the pipeline on tests/fixtures/message-flow-participant-ports.json: straight flows with the
 *    switch on, today's centre docking with it off (the default), DI not worse on any fixture;
 *  - routeMessageFlows on hand-built geometry: clamping to the band, a shape in the way, the port
 *    following a shifted source column, two flows to one participant, pool to pool.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeMessageFlows } from './coordinates.js';
import { runPipeline } from './pipeline.js';
import { CFG } from '../shared/utils.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const load = (name) => JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'));
const FIXTURE = 'message-flow-participant-ports.json';
const { portInset, columnStep } = { portInset: 10, columnStep: 10, ...CFG.layout.messageFlowAvoidance };
const centreX = (b) => b.x + b.w / 2;
const ON = { alignParticipantPorts: true };

/** True when the polyline enters box b (strictly inside, its outline excluded). */
const crosses = (pts, b) => pts.slice(1).some((p, i) => {
  const a = pts[i];
  const [x0, x1] = [Math.min(a.x, p.x), Math.max(a.x, p.x)];
  const [y0, y1] = [Math.min(a.y, p.y), Math.max(a.y, p.y)];
  return x0 < b.x + b.w && x1 > b.x && y0 < b.y + b.h && y1 > b.y;
});

describe('alignParticipantPorts in the pipeline', () => {
  test('the switch is off by default', () => {
    expect(CFG.layout.alignParticipantPorts).toBe(false);
  });

  test('downward into a black-box pool: one vertical segment at the task\'s centre', async () => {
    const { coordMap } = await runPipeline(load(FIXTURE), ON);
    for (const [key, task] of [['mf_ack', 't_ack'], ['mf_inv', 't_invoice']]) {
      const pts = coordMap.edgeCoords[key];
      expect(pts).toHaveLength(2);
      expect(pts[0].x).toBeCloseTo(centreX(coordMap.coords[task]), 6);
      expect(pts[1].x).toBeCloseTo(pts[0].x, 6);
    }
  });

  test('upward from a black-box pool into an event: one vertical segment at the event\'s centre', async () => {
    const { coordMap } = await runPipeline(load(FIXTURE), ON);
    const pts = coordMap.edgeCoords.mf_in;
    expect(pts).toHaveLength(2);
    expect(pts[1].x).toBeCloseTo(centreX(coordMap.coords.start), 6);
    expect(pts[0].x).toBeCloseTo(pts[1].x, 6);
  });

  test('off (the default): every flow still docks at the band centre, as before', async () => {
    const { coordMap } = await runPipeline(load(FIXTURE));
    const mid = centreX(coordMap.poolCoords.Pool_Customer);
    expect(coordMap.edgeCoords.mf_in[0].x).toBeCloseTo(mid, 6);
    expect(coordMap.edgeCoords.mf_ack.at(-1).x).toBeCloseTo(mid, 6);
    expect(coordMap.edgeCoords.mf_inv.at(-1).x).toBeCloseTo(mid, 6);
    expect(coordMap.edgeCoords.mf_ack).toHaveLength(4);
  });

  // Every top-level fixture with a black-box participant: no DI code gets more findings.
  const withCollapsed = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort()
    .filter((f) => (load(f).collapsedPools || []).length > 0);
  test.each(withCollapsed)('%s: DI findings per code do not increase', async (f) => {
    const count = (r) => r.diagnostics.issues.reduce((m, i) => ({ ...m, [i.code]: (m[i.code] ?? 0) + 1 }), {});
    const off = count(await runPipeline(load(f)));
    const on = count(await runPipeline(load(f), ON));
    for (const [code, n] of Object.entries(on)) expect(`${code}: ${n}`).toBe(`${code}: ${Math.min(n, off[code] ?? 0)}`);
  }, 60000);
});

// ─── Hand-built geometry ──────────────────────────────────────────────────────
// Pool A on top (a1 a task), optionally pool B below it, black-box participant P at the bottom,
// 1600 px wide so that its centre (800) is far from every shape.
const build = ({ a1 = { x: 300, y: 20, w: 100, h: 80 }, extraA = {}, b = null, pBand = { x: 0, w: 1600 }, flows }) => {
  const coords = { a1, ...extraA };
  const poolCoords = { A: { x: 0, y: 0, w: 1600, h: 120 }, P: { x: pBand.x, y: 320, w: pBand.w, h: 60 } };
  const pools = [{ id: 'A', name: 'A', nodes: [{ id: 'a1', type: 'task', name: 'a1' },
    ...Object.keys(extraA).map((id) => ({ id, type: 'task', name: id }))], edges: [] }];
  if (b) {
    coords.b1 = b;
    poolCoords.B = { x: 0, y: 160, w: 1600, h: 120 };
    pools.push({ id: 'B', name: 'B', nodes: [{ id: 'b1', type: 'task', name: 'b1' }], edges: [] });
  }
  const lc = { pools, collapsedPools: [{ id: 'P', name: 'P' }], messageFlows: flows };
  const cm = { coords, poolCoords, laneCoords: {}, edgeCoords: {}, edgeLabels: {}, nodeLabels: {} };
  return { lc, cm };
};
const one = [{ id: 'm', source: 'a1', target: 'P' }];

describe('alignParticipantPorts on hand-built geometry', () => {
  test('premise: off, the flow docks at the band centre', () => {
    const { lc, cm } = build({ flows: one });
    routeMessageFlows(cm, lc, { alignParticipantPorts: false });
    expect(cm.edgeCoords.m.at(-1).x).toBe(800);
  });

  test('a shape of a participant in between blocks the column: the flow keeps clear of it and docks near the source, not at the centre', () => {
    // b1 is wider than a1, so no column of a1 runs straight past it.
    const b = { x: 250, y: 180, w: 200, h: 80 };
    const { lc, cm } = build({ b, flows: one });
    routeMessageFlows(cm, lc, ON);
    const pts = cm.edgeCoords.m;
    expect(crosses(pts, b)).toBe(false);
    expect(Math.abs(pts.at(-1).x - 350)).toBeLessThan(Math.abs(800 - 350) / 2);
  });

  test('a shape below the source shifts its column: the participant port follows it, no bend', () => {
    // a3 sits between a1 and the bottom of pool A, under a1's centre: a1's port moves left.
    const a3 = { x: 320, y: 104, w: 100, h: 10 };
    const { lc, cm } = build({ extraA: { a3 }, flows: one });
    routeMessageFlows(cm, lc, ON);
    const pts = cm.edgeCoords.m;
    expect(pts).toHaveLength(2);
    expect(pts[0].x).not.toBe(350);
    expect(pts[1].x).toBe(pts[0].x);
    expect(crosses(pts, a3)).toBe(false);
  });

  test('a shape left of the band: the port is clamped to the band, portInset inside its edge', () => {
    const { lc, cm } = build({ a1: { x: 0, y: 20, w: 100, h: 80 }, pBand: { x: 200, w: 1400 }, flows: one });
    routeMessageFlows(cm, lc, ON);
    expect(cm.edgeCoords.m.at(-1).x).toBe(200 + portInset);
  });

  test('two flows from one task to one participant get distinct ports, columnStep apart, stable', () => {
    const flows = [{ id: 'm1', source: 'a1', target: 'P' }, { id: 'm2', source: 'a1', target: 'P' }];
    const run = () => {
      const { lc, cm } = build({ flows });
      routeMessageFlows(cm, lc, ON);
      return [cm.edgeCoords.m1.at(-1).x, cm.edgeCoords.m2.at(-1).x];
    };
    const [x1, x2] = run();
    expect(x1).toBe(350);
    expect(Math.abs(x2 - x1)).toBe(columnStep);
    expect(run()).toEqual([x1, x2]);
  });

  test('pool to pool: both ends at their band centres, as with the switch off', () => {
    const flows = [{ id: 'pp', source: 'A', target: 'P' }];
    const routes = [false, true].map((alignParticipantPorts) => {
      const { lc, cm } = build({ pBand: { x: 400, w: 600 }, flows });
      routeMessageFlows(cm, lc, { alignParticipantPorts });
      return cm.edgeCoords.pp;
    });
    expect(routes[1]).toEqual(routes[0]);
    expect(routes[1][0].x).toBe(800);
    expect(routes[1].at(-1).x).toBe(700);
  });
});
