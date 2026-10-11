/**
 * Fence for bend-rule.js. Three parts:
 *  - the rule on hand-built geometry: what it changes, what it leaves alone;
 *  - one test per limit, each on a minimal coordMap the rule WITHOUT that limit breaks — the test
 *    shows the unguarded result first, so a scenario that no longer reaches its guard fails loudly
 *    instead of passing for the wrong reason;
 *  - the pass in the pipeline: on keeps DI07–DI10 clean and is idempotent (off is byte-identical:
 *    bench/output-hashes.test.js).
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyBendRule, bendMetrics, bendCount, entrySide, exitSide, bendRuleLimits } from './bend-rule.js';
import { runPipeline } from './pipeline.js';
import { normalizeEdgeIds } from './topology.js';
import { CFG } from '../shared/utils.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const FIXTURES = readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort();
const load = (name) => JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'));

/** The edges a call changed, as { id: points }. */
function changes(cm, lc, opts) {
  const out = applyBendRule(cm, lc, opts);
  return Object.fromEntries(Object.entries(out).filter(([id, pts]) => pts !== cm.edgeCoords[id]));
}
const P = (x, y) => ({ x, y });
const segmentsOf = (pts) => pts.slice(1).map((b, i) => [pts[i], b]);
const hitsBox = (pts, b) => segmentsOf(pts).some(([a, z]) =>
  Math.max(a.x, z.x) > b.x && Math.min(a.x, z.x) < b.x + b.w && Math.max(a.y, z.y) > b.y && Math.min(a.y, z.y) < b.y + b.h);

// A gateway with a task below and to the right of it; the current route is a Z (two bends).
const gatewayToTask = () => ({
  lc: { id: 'P', nodes: [{ id: 'g', type: 'exclusiveGateway', name: 'Ok?' }, { id: 't', type: 'task' }],
    edges: [{ id: 'e', source: 'g', target: 't' }] },
  cm: { coords: { g: { x: 0, y: 0, w: 50, h: 50 }, t: { x: 100, y: 150, w: 100, h: 80 } },
    edgeCoords: { e: [P(50, 25), P(75, 25), P(75, 190), P(100, 190)] } },
});

describe('bendCount / entrySide / exitSide', () => {
  test('direction changes, repeated points ignored', () => {
    expect(bendCount([P(0, 0), P(10, 0), P(10, 0), P(20, 0)])).toBe(0);
    expect(bendCount([P(0, 0), P(10, 0), P(10, 10), P(20, 10)])).toBe(2);
  });
  test('sides read from the end segments\' directions', () => {
    const pts = [P(25, 50), P(25, 190), P(100, 190)];
    expect(exitSide(pts)).toBe('bottom');
    expect(entrySide(pts)).toBe('left');
  });
});

describe('applyBendRule — the rule', () => {
  test('a Z becomes an L: the gateway is left at its bottom vertex, the task entered from the left', () => {
    const { lc, cm } = gatewayToTask();
    expect(changes(cm, lc)).toEqual({ e: [P(25, 50), P(25, 190), P(100, 190)] });
  });

  test('same bends, but an activity entered from the left wins over one entered from the top', () => {
    const { lc, cm } = gatewayToTask();
    cm.edgeCoords.e = [P(50, 25), P(150, 25), P(150, 150)];
    expect(changes(cm, lc)).toEqual({ e: [P(25, 50), P(25, 190), P(100, 190)] });
  });

  test('nothing better: the same edgeCoords object comes back, every route its own array', () => {
    const { lc, cm } = gatewayToTask();
    cm.edgeCoords.e = [P(25, 50), P(25, 190), P(100, 190)];
    expect(applyBendRule(cm, lc)).toBe(cm.edgeCoords);
  });

  test("a boundary event's endpoint never moves", () => {
    const lc = { id: 'P', nodes: [{ id: 'h', type: 'task' }, { id: 'b', type: 'boundaryEvent', attachedTo: 'h' },
      { id: 't', type: 'task' }], edges: [{ id: 'e', source: 'b', target: 't' }] };
    const cm = { coords: { h: { x: 0, y: 0, w: 100, h: 80 }, b: { x: 32, y: 62, w: 36, h: 36 }, t: { x: 200, y: 150, w: 100, h: 80 } },
      edgeCoords: { e: [P(50, 98), P(50, 120), P(150, 120), P(150, 190), P(200, 190)] } };
    const out = changes(cm, lc);
    expect(out.e).toBeDefined();
    expect(out.e[0]).toEqual(P(50, 98));
  });

  test('a self-loop and an edge without both shapes are left alone', () => {
    const lc = { id: 'P', nodes: [{ id: 'a', type: 'task' }], edges: [{ id: 'loop', source: 'a', target: 'a' }, { id: 'x', source: 'a', target: 'gone' }] };
    const cm = { coords: { a: { x: 0, y: 0, w: 100, h: 80 } },
      edgeCoords: { loop: [P(100, 40), P(120, 40), P(120, 100), P(50, 100), P(50, 80)], x: [P(100, 40), P(150, 40), P(150, 200)] } };
    expect(applyBendRule(cm, lc)).toBe(cm.edgeCoords);
  });

  test('skipIds: an edge in it is neither changed nor counted', () => {
    const { lc, cm } = gatewayToTask();
    expect(applyBendRule(cm, lc, { skipIds: new Set(['e']) })).toBe(cm.edgeCoords);
  });

  test('idempotent: a second run over the first run\'s result changes nothing', () => {
    const { lc, cm } = gatewayToTask();
    const once = applyBendRule(cm, lc);
    expect(applyBendRule({ ...cm, edgeCoords: once }, lc)).toBe(once);
  });

  test('the limits come from config.json → layout.bendRuleLimits', () => {
    expect(bendRuleLimits()).toEqual(CFG.layout.bendRuleLimits);
    expect(bendRuleLimits({ regionInset: 3 }).regionInset).toBe(3);
  });
});

describe('applyBendRule — every limit, on a scenario the unguarded rule breaks', () => {
  test('node label: the new route does not run through the gateway\'s external label', () => {
    const { lc, cm } = gatewayToTask();
    const label = { x: 5, y: 60, w: 40, h: 14 };
    cm.nodeLabels = { g: label };
    const unguarded = changes(cm, lc, { guards: { nodeLabels: false } });
    expect(hitsBox(unguarded.e, label)).toBe(true);
    const guarded = changes(cm, lc);
    expect(guarded.e).toEqual([P(50, 25), P(150, 25), P(150, 150)]);
    expect(hitsBox(guarded.e, label)).toBe(false);
  });

  test('message flow: no new port on top or bottom of a node a message flow docks at', () => {
    const lc = { pools: [
      { id: 'P', nodes: [{ id: 's', type: 'task' }, { id: 't', type: 'task' }], edges: [{ id: 'e', source: 's', target: 't' }] },
      { id: 'Q', nodes: [{ id: 'x', type: 'task' }], edges: [] }],
      messageFlows: [{ id: 'm', source: 's', target: 'x' }] };
    const cm = { coords: { s: { x: 0, y: 0, w: 100, h: 80 }, t: { x: 200, y: 150, w: 200, h: 80 }, x: { x: 0, y: -500, w: 100, h: 80 } },
      edgeCoords: { e: [P(100, 40), P(150, 40), P(150, 190), P(200, 190)] } };
    expect(changes(cm, lc, { guards: { messageFlowPorts: false } }).e[0]).toEqual(P(50, 80)); // s's bottom: the message flow's port
    expect(changes(cm, lc)).toEqual({});
  });

  test('side conflict: no entry on the side a flow leaves the target through', () => {
    const lc = { id: 'P', nodes: [{ id: 'a', type: 'task' }, { id: 't', type: 'task' }, { id: 'x', type: 'task' }],
      edges: [{ id: 'e', source: 'a', target: 't' }, { id: 'back', source: 't', target: 'x' }] };
    const cm = { coords: { a: { x: 0, y: 150, w: 100, h: 80 }, t: { x: 300, y: 0, w: 100, h: 80 }, x: { x: 160, y: -200, w: 100, h: 80 } },
      edgeCoords: { e: [P(50, 150), P(50, 120), P(350, 120), P(350, 80)], back: [P(300, 15), P(210, 15), P(210, -120)] } };
    expect(entrySide(changes(cm, lc, { guards: { sideConflicts: false } }).e)).toBe('left'); // where `back` leaves t
    expect(changes(cm, lc)).toEqual({ e: [P(100, 190), P(350, 190), P(350, 80)] });
  });

  test('detour: a route with fewer bends but far longer is not taken', () => {
    const lc = { id: 'P', nodes: [{ id: 's', type: 'task' }, { id: 't', type: 'task' }, { id: 'o', type: 'task' }],
      edges: [{ id: 'e', source: 's', target: 't' }] };
    const cm = { coords: { s: { x: 0, y: 0, w: 100, h: 80 }, t: { x: 200, y: 200, w: 400, h: 80 }, o: { x: 20, y: 140, w: 60, h: 40 } },
      edgeCoords: { e: [P(100, 40), P(150, 40), P(150, 240), P(200, 240)] } };
    expect(changes(cm, lc, { guards: { length: false } })).toEqual({ e: [P(100, 40), P(400, 40), P(400, 200)] }); // 460 px for 300
    expect(changes(cm, lc)).toEqual({});
  });

  test('region: no route within regionInset of the pool outline', () => {
    const lc = { id: 'P', nodes: [{ id: 's', type: 'task' }, { id: 't', type: 'task' }, { id: 'o', type: 'task' }],
      edges: [{ id: 'e', source: 's', target: 't' }] };
    const cm = { coords: { s: { x: 300, y: 20, w: 100, h: 80 }, t: { x: 60, y: 20, w: 100, h: 80 }, o: { x: 200, y: 20, w: 40, h: 80 } },
      poolCoords: { _singlePool: { x: 0, y: 0, w: 500, h: 120, laneHeaderWidth: 30 } },
      edgeCoords: { e: [P(400, 60), P(420, 60), P(420, 110), P(45, 110), P(45, 60), P(60, 60)] } };
    const unguarded = changes(cm, lc, { guards: { region: false } }).e;
    expect(Math.min(...unguarded.map((p) => p.y))).toBeLessThan(0 + bendRuleLimits().regionInset); // a U along the pool's top
    expect(changes(cm, lc)).toEqual({});
  });

  test('crowding: no new leg closer than crowdingPx alongside another flow', () => {
    const lc = { id: 'P', nodes: ['g', 't', 'p', 'q', 'z'].map((id) => ({ id, type: id === 'g' ? 'exclusiveGateway' : 'task' })),
      edges: [{ id: 'e', source: 'g', target: 't' }, { id: 'o', source: 'p', target: 'q' }] };
    const cm = { coords: { g: { x: 0, y: 0, w: 50, h: 50 }, t: { x: 100, y: 150, w: 100, h: 80 },
      p: { x: 300, y: 40, w: 40, h: 40 }, q: { x: 300, y: 120, w: 40, h: 40 }, z: { x: 290, y: 90, w: 60, h: 20 } },
    edgeCoords: { e: [P(50, 25), P(75, 25), P(75, 190), P(100, 190)], o: [P(300, 60), P(30, 60), P(30, 140), P(300, 140)] } };
    expect(changes(cm, lc, { guards: { crowding: false } }).e).toEqual([P(25, 50), P(25, 190), P(100, 190)]); // 5 px beside o
    expect(changes(cm, lc)).toEqual({ e: [P(50, 25), P(150, 25), P(150, 150)] });
  });

  // Conditions 3, 4 and 6 have no guards switch: each shows the rule with the limit relaxed (or the
  // other flow absent), then with it in force. The L the rule prefers on gatewayToTask() is
  // (25,50) → (25,190) → (100,190).
  const L = [P(25, 50), P(25, 190), P(100, 190)];
  const far = { fx: { x: 2000, y: 2000, w: 40, h: 40 } };
  /** gatewayToTask() plus a second flow whose route is hand-placed: a self-loop, which the pass never moves. */
  const withOther = (route) => {
    const { lc, cm } = gatewayToTask();
    lc.nodes.push({ id: 'fx', type: 'task' });
    lc.edges.push({ id: 'o', source: 'fx', target: 'fx' });
    Object.assign(cm.coords, far);
    if (route) cm.edgeCoords.o = route;
    return { lc, cm };
  };

  test('end stubs (condition 3): no last leg shorter than endStubPx', () => {
    const { lc, cm } = gatewayToTask();
    cm.coords.t = { x: 35, y: 150, w: 100, h: 80 };
    cm.edgeCoords.e = [P(50, 25), P(200, 25), P(200, 190), P(135, 190)];
    const stub = CFG.layout.endStubPx;
    const lastLeg = (pts) => Math.hypot(pts.at(-1).x - pts.at(-2).x, pts.at(-1).y - pts.at(-2).y);
    CFG.layout.endStubPx = 0;
    let unguarded;
    try { unguarded = changes(cm, lc).e; } finally { CFG.layout.endStubPx = stub; }
    expect(lastLeg(unguarded)).toBeLessThan(stub); // the 10 px left of t
    const guarded = changes(cm, lc).e;
    expect(guarded === undefined || lastLeg(guarded) >= stub).toBe(true);
    expect(guarded).not.toEqual(unguarded);
  });

  test('shape clearance (condition 4): no new leg within shapeClearance of a foreign shape', () => {
    const { lc, cm } = gatewayToTask();
    lc.nodes.push({ id: 'o', type: 'task' });
    cm.coords.o = { x: 30, y: 100, w: 40, h: 30 }; // 5 px beside the L's vertical leg
    expect(bendRuleLimits().shapeClearance).toBeGreaterThan(5);
    expect(changes(cm, lc, { limits: { shapeClearance: 0 } }).e).toEqual(L);
    expect(changes(cm, lc).e).not.toEqual(L);
  });

  test('crossings (condition 6): the new route crosses no flow the current one does not', () => {
    const crossing = [P(-50, 120), P(40, 120)]; // meets the L's vertical leg, not the Z's
    expect(changes(withOther().cm, withOther().lc).e).toEqual(L); // absent: the L is taken
    const { lc, cm } = withOther(crossing);
    expect(changes(cm, lc).e).not.toEqual(L);
  });

  test('collinear overlap (condition 6): the new route does not run over another flow', () => {
    const along = [P(25, 100), P(25, 140)]; // lies on the L's vertical leg
    const { lc, cm } = withOther(along);
    expect(changes(cm, lc).e).not.toEqual(L);
    delete cm.edgeCoords.o;
    expect(changes(cm, lc).e).toEqual(L);
  });

  test('lane-line hug (condition 6): no more run along a lane separator than the current route has', () => {
    const { lc, cm } = gatewayToTask();
    lc.lanes = [{ id: 'L1' }, { id: 'L2' }];
    cm.laneCoords = { L1: { x: -100, y: -100, w: 500, h: 290 }, L2: { x: -100, y: 190, w: 500, h: 200 } }; // separator at y = 190
    cm.poolCoords = { _singlePool: { x: -130, y: -100, w: 530, h: 490, laneHeaderWidth: 30 } };
    expect(changes(cm, lc, { limits: { laneLineHugPx: -1 } }).e).toEqual(L); // the L's last leg lies on the separator
    expect(changes(cm, lc).e).not.toEqual(L);
  });
});

describe('bendMetrics', () => {
  test('a Z with an admissible L: one avoidable bend; entered from the left, so not against the flow', () => {
    const { lc, cm } = gatewayToTask();
    const m = bendMetrics(cm, lc);
    expect(m).toMatchObject({ scope: 1, avoidableBends: 1, avoidableEdges: 1, againstFlowEntries: 0 });
    expect(m.perEdge.e).toEqual({ bends: 2, minBends: 1, entry: 'left', againstFlow: false });
  });
  test('entered from the top although a left entry with no more bends exists: against the flow', () => {
    const { lc, cm } = gatewayToTask();
    cm.edgeCoords.e = [P(50, 25), P(150, 25), P(150, 150)];
    expect(bendMetrics(cm, lc)).toMatchObject({ avoidableBends: 0, againstFlowEntries: 1 });
  });
  test('after the rule, the measure finds nothing — they share one search', () => {
    const { lc, cm } = gatewayToTask();
    cm.edgeCoords.e = [P(50, 25), P(150, 25), P(150, 150)];
    const after = { ...cm, edgeCoords: applyBendRule(cm, lc) };
    expect(bendMetrics(after, lc)).toMatchObject({ avoidableBends: 0, againstFlowEntries: 0 });
  });
});

// `--refine` is not a mode of its own here: with config.json's visualRefinement defaults every pass
// already runs, so it lays out exactly like `default`.
const MODES = { default: {}, 'no-refine': { visualRefinement: false }, 'refine+wrap': { visualRefinement: true, elkWrapping: 'auto' } };

describe('the pass in the pipeline', () => {
  test('layout.bendRule defaults to off', () => {
    expect(CFG.layout.bendRule).toBe(false);
  });

  // "off => byte-identical" is fenced where it can fail: bench/output-hashes.test.js compares the
  // default output against hashes generated before the switches existed.

  for (const [mode, opts] of Object.entries(MODES)) {
    test(`on (${mode}): no DI07–DI10 finding, no XML warning, and a second run of the pass changes nothing`, async () => {
      const bad = [];
      for (const name of FIXTURES) {
        const lc = load(name);
        const r = await runPipeline(lc, { ...opts, bendRule: true });
        if (!r.coordMap) continue; // blocked on purpose (deadlock-process)
        for (const i of r.diagnostics.issues) if (['DI07', 'DI08', 'DI09', 'DI10'].includes(i.code)) bad.push(`${name} ${i.code}`);
        if (r.validation.xmlWarnings?.length) bad.push(`${name} xmlWarnings`);
        // The Logic-Core the pipeline laid out: ids assigned to id-less edges, or the rule would see no route.
        if (applyBendRule(r.coordMap, normalizeEdgeIds(lc)) !== r.coordMap.edgeCoords) bad.push(`${name} not idempotent`);
      }
      expect(bad).toEqual([]);
    }, 60000);
  }

  test('an id-less edge: the pipeline gives it an id, and the measure and the pass see its route', async () => {
    const lc = load('simple-approval.json');
    delete lc.pools[0].edges[0].id;
    const r = await runPipeline(lc, { bendRule: true });
    const normalised = normalizeEdgeIds(lc);
    const n = lc.pools[0].edges.length;
    expect(normalised.pools[0].edges[0].id).toBeDefined();
    expect(bendMetrics(r.coordMap, normalised).scope).toBe(n);
    // fed the raw Logic-Core the same call is silently vacuous — the reason the tests normalise
    expect(bendMetrics(r.coordMap, lc).scope).toBe(n - 1);
    expect(applyBendRule(r.coordMap, normalised)).toBe(r.coordMap.edgeCoords);
  });
});
