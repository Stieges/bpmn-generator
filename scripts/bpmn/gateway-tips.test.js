import { describe, test, expect } from '@jest/globals';
import { snapGatewayTips, isOnGatewayTip } from './edge-simplify.js';
import { runPipeline } from './pipeline.js';
import { isGateway } from './types.js';
import { flattenProcessEdges, flattenProcessNodes } from './coordinates.js';

// snapGatewayTips (edge-simplify.js): every sequence flow of a gateway on a vertex of the diamond,
// one flow per vertex. The geometry below is what ELK and clipOrthogonal hand the pass: two flows of
// one side 12.5 px either side of the centre, clipped onto the facets.

const P = (x, y) => ({ x, y });
const shapeOf = (id) => (id.startsWith('g') ? 'diamond' : 'rect');
// The gateway: centre (125, 125); vertices right (150, 125), left (100, 125), top (125, 100), bottom (125, 150).
const G = { x: 100, y: 100, w: 50, h: 50 };
const TIP = { right: P(150, 125), left: P(100, 125), top: P(125, 100), bottom: P(125, 150) };
const UP_RIGHT = P(137.5, 112.5), DOWN_RIGHT = P(137.5, 137.5);

const run = (coords, routes) => {
  const edges = Object.keys(routes).map((id) => ({ id, source: routes[id].s, target: routes[id].t }));
  const edgeCoords = Object.fromEntries(Object.entries(routes).map(([id, r]) => [id, r.pts]));
  return { out: snapGatewayTips(edgeCoords, coords, edges, new Set(), { shapeOf }), edgeCoords };
};
const sideOfStart = (pts) => Object.keys(TIP).find((s) => isOnGatewayTip(pts[0], G, s)) ?? null;
const sideOfEnd = (pts) => Object.keys(TIP).find((s) => isOnGatewayTip(pts[pts.length - 1], G, s)) ?? null;
const orthogonal = (pts) => pts.every((p, i) => i === 0 || p.x === pts[i - 1].x || p.y === pts[i - 1].y);
// Bends of an orthogonal route without collinear waypoints: every waypoint between the ends.
const bends = (pts) => pts.filter((p, i) => i > 0 && i < pts.length - 1
  && !((p.x === pts[i - 1].x && p.x === pts[i + 1].x) || (p.y === pts[i - 1].y && p.y === pts[i + 1].y))).length;

describe('snapGatewayTips — one, two and three flows on one side', () => {
  test('one flow half a pixel off the centre: the end moves onto the vertex, the target end follows on its side', () => {
    const coords = { g: G, a: { x: 300, y: 85, w: 100, h: 80 } };
    const { out } = run(coords, { f: { s: 'g', t: 'a', pts: [P(149.5, 125.5), P(300, 125.5)] } });
    expect(out.f).toEqual([TIP.right, P(300, 125)]);
  });

  test('a flow already on its vertex is left alone (same object back)', () => {
    const coords = { g: G, a: { x: 300, y: 85, w: 100, h: 80 } };
    const { out, edgeCoords } = run(coords, { f: { s: 'g', t: 'a', pts: [TIP.right, P(300, 125)] } });
    expect(out).toBe(edgeCoords);
  });

  test('two flows on the right (split): the one level with the gateway keeps the right vertex, the other leaves the bottom towards its target', () => {
    const coords = { g: G, a: { x: 300, y: 85, w: 100, h: 80 }, b: { x: 300, y: 250, w: 100, h: 80 } };
    const { out } = run(coords, {
      fa: { s: 'g', t: 'a', pts: [UP_RIGHT, P(300, 112.5)] },
      fb: { s: 'g', t: 'b', pts: [DOWN_RIGHT, P(220, 137.5), P(220, 290), P(300, 290)] },
    });
    expect(out.fa).toEqual([TIP.right, P(300, 125)]);
    expect(out.fb[0]).toEqual(TIP.bottom);
    expect(out.fb[1].x).toBe(125);                        // leaves straight down
    expect(out.fb[out.fb.length - 1]).toEqual(P(300, 290)); // the target end stays
    expect(orthogonal(out.fb)).toBe(true);
  });

  test('three flows on the right: right, top and bottom vertex, each towards its target', () => {
    const coords = {
      g: G, a: { x: 300, y: 85, w: 100, h: 80 }, b: { x: 300, y: 250, w: 100, h: 80 }, c: { x: 300, y: -100, w: 100, h: 80 },
    };
    const { out } = run(coords, {
      fa: { s: 'g', t: 'a', pts: [UP_RIGHT, P(300, 112.5)] },
      fb: { s: 'g', t: 'b', pts: [DOWN_RIGHT, P(220, 137.5), P(220, 290), P(300, 290)] },
      fc: { s: 'g', t: 'c', pts: [TIP.right, P(200, 125), P(200, -60), P(300, -60)] },
    });
    expect([sideOfStart(out.fa), sideOfStart(out.fb), sideOfStart(out.fc)]).toEqual(['right', 'bottom', 'top']);
    for (const id of ['fa', 'fb', 'fc']) expect(orthogonal(out[id])).toBe(true);
  });

  test('join: two flows entering on the left — the level one takes the left vertex, the other enters from below', () => {
    const coords = { g: G, a: { x: -200, y: 85, w: 100, h: 80 }, b: { x: -200, y: 250, w: 100, h: 80 } };
    const { out } = run(coords, {
      fa: { s: 'a', t: 'g', pts: [P(-100, 112.5), P(112.5, 112.5)] },
      fb: { s: 'b', t: 'g', pts: [P(-100, 290), P(30, 290), P(30, 137.5), P(112.5, 137.5)] },
    });
    expect(out.fa).toEqual([P(-100, 125), TIP.left]);
    expect(sideOfEnd(out.fb)).toBe('bottom');
    expect(out.fb[out.fb.length - 2].x).toBe(125);        // arrives straight up
    expect(out.fb[0]).toEqual(P(-100, 290));
  });

  test('a vertex an incoming flow already uses is not free for an outgoing one', () => {
    const coords = { g: G, a: { x: 300, y: 85, w: 100, h: 80 }, b: { x: 300, y: 250, w: 100, h: 80 }, s: { x: 75, y: 300, w: 100, h: 80 } };
    const { out } = run(coords, {
      fin: { s: 's', t: 'g', pts: [P(125, 300), TIP.bottom] },
      fa: { s: 'g', t: 'a', pts: [UP_RIGHT, P(300, 112.5)] },
      fb: { s: 'g', t: 'b', pts: [DOWN_RIGHT, P(220, 137.5), P(220, 290), P(300, 290)] },
    });
    expect(out.fin).toEqual([P(125, 300), TIP.bottom]);
    expect(sideOfStart(out.fa)).toBe('right');
    expect(out.fb[0]).toEqual(DOWN_RIGHT);                 // no free vertex towards b: stays on the facet
  });
});

describe('snapGatewayTips — at most one bend more per snapped end', () => {
  test('a straight flow whose far end cannot follow to the vertex level: no Z for the tip, the end keeps its facet dock', () => {
    // The target spans y 40..120, so the far end cannot slide down to the right vertex's level
    // (y 125); reaching the vertex would need a Z, two bends more than the straight route.
    const coords = { g: G, a: { x: 300, y: 40, w: 100, h: 80 } };
    const { out, edgeCoords } = run(coords, { f: { s: 'g', t: 'a', pts: [UP_RIGHT, P(300, 112.5)] } });
    expect(out).toBe(edgeCoords);
  });

  test('one bend more is fine: a flow moved to the bottom vertex turns once towards its target', () => {
    // fb leaves the lower facet to the right and turns down into the top of b (one bend); from the
    // bottom vertex it goes down, across and down again (two bends).
    const coords = { g: G, a: { x: 300, y: 85, w: 100, h: 80 }, b: { x: 170, y: 250, w: 100, h: 80 } };
    const { out } = run(coords, {
      fa: { s: 'g', t: 'a', pts: [UP_RIGHT, P(300, 112.5)] },
      fb: { s: 'g', t: 'b', pts: [DOWN_RIGHT, P(220, 137.5), P(220, 250)] },
    });
    expect(sideOfStart(out.fa)).toBe('right');
    expect(sideOfStart(out.fb)).toBe('bottom');
    expect(out.fb[out.fb.length - 1]).toEqual(P(220, 250));
    expect(bends(out.fb)).toBe(2);
    expect(orthogonal(out.fb)).toBe(true);
  });
});

describe('snapGatewayTips — two flows of one gateway do not cross each other', () => {
  // Proper crossings (interior of both segments) between two routes.
  const crossings = (a, b) => {
    let n = 0;
    for (let i = 0; i + 1 < a.length; i++) for (let j = 0; j + 1 < b.length; j++) {
      const [p, q, r, s] = [a[i], a[i + 1], b[j], b[j + 1]];
      const h = p.y === q.y ? [p, q] : [r, s], v = p.y === q.y ? [r, s] : [p, q];
      if (h[0].y !== h[1].y || v[0].x !== v[1].x) continue;
      const x = v[0].x, y = h[0].y;
      if (x > Math.min(h[0].x, h[1].x) && x < Math.max(h[0].x, h[1].x) && y > Math.min(v[0].y, v[1].y) && y < Math.max(v[0].y, v[1].y)) n++;
    }
    return n;
  };

  test('join from below: the flow handed to the left vertex goes round the one that keeps the bottom, not across it', () => {
    // multi-pool-collaboration's merge, reduced: "low" already enters the bottom vertex, "up" the
    // lower left facet; "up" is better aligned and ranks first for the bottom. Sending "low" to the
    // left vertex would cross "up" on its way; sending "up" there does not.
    const coords = { g: G, low: { x: -100, y: 360, w: 100, h: 80 }, up: { x: -50, y: 200, w: 100, h: 80 } };
    const { out } = run(coords, {
      fLow: { s: 'low', t: 'g', pts: [P(0, 400), P(125, 400), TIP.bottom] },
      fUp: { s: 'up', t: 'g', pts: [P(50, 240), P(112.5, 240), P(112.5, 137.5)] },
    });
    expect(crossings(out.fLow, out.fUp)).toBe(0);
    expect([sideOfEnd(out.fLow), sideOfEnd(out.fUp)]).toEqual(['bottom', 'left']);
  });
});

describe('snapGatewayTips — no jog on a long back edge', () => {
  // Segments between two bends shorter than 30 px: the jogs of a route.
  const jogs = (pts) => pts.slice(1, -2).filter((p, i) => Math.hypot(pts[i + 2].x - p.x, pts[i + 2].y - p.y) < 30).length;

  test('a loop-back entering the right facet keeps its detour rather than cut it short with a 10 px step', () => {
    // The loop-back comes from "s" 800 px to the right, runs over an element (not modelled: only the
    // route matters here), drops to y 135 and enters the upper right facet at y 112.5. Joining its
    // last leg from the right vertex (y 125) would save two bends but leave a 10 px step at x 500.
    const coords = { g: G, s: { x: 900, y: 95, w: 100, h: 80 } };
    const pts = [P(900, 135), P(500, 135), P(500, 40), P(200, 40), P(200, 112.5), UP_RIGHT];
    const { out } = run(coords, { back: { s: 's', t: 'g', pts } });
    expect(sideOfEnd(out.back)).toBe('right');
    expect(jogs(out.back)).toBe(0);
    expect(out.back).toEqual([P(900, 135), P(500, 135), P(500, 40), P(200, 40), P(200, 125), TIP.right]);
  });
});

describe('snapGatewayTips — more flows on a side than free vertices', () => {
  test('five flows out of the right: three vertices taken, the two left over keep their dock, no vertex holds two', () => {
    const ys = [-200, -60, 125, 290, 450];
    const coords = { g: G };
    const routes = {};
    // ELK's spread over the right side: from the upper facet to the lower one
    const starts = [P(131.25, 106.25), UP_RIGHT, P(149, 124), DOWN_RIGHT, P(131.25, 143.75)];
    ys.forEach((y, i) => {
      coords[`t${i}`] = { x: 400, y: y - 40, w: 100, h: 80 };
      const s = starts[i];
      const corridor = 200 + 20 * i;
      routes[`f${i}`] = { s: 'g', t: `t${i}`, pts: y === s.y ? [s, P(400, y)] : [s, P(corridor, s.y), P(corridor, y), P(400, y)] };
    });
    const { out } = run(coords, routes);
    const sides = ys.map((_, i) => sideOfStart(out[`f${i}`]));
    expect(sides.filter(Boolean).sort()).toEqual(['bottom', 'right', 'top']);
    expect(sides[2]).toBe('right');                          // the level flow keeps the flow direction
    ys.forEach((_, i) => {
      if (!sides[i]) expect(out[`f${i}`]).toEqual(routes[`f${i}`].pts); // a left-over flow is untouched
      expect(orthogonal(out[`f${i}`])).toBe(true);
    });
  });
});

describe('snapGatewayTips in the pipeline — an order-handling model with a default flow', () => {
  // Neutral domain: a split on stock, a default branch, a parallel split/join with three branches.
  const model = () => ({
    pools: [{
      id: 'Process_Orders', name: 'Order handling',
      lanes: [{ id: 'l1', name: 'Warehouse' }],
      nodes: [
        { id: 'start', type: 'startEvent', name: 'Order received', lane: 'l1' },
        { id: 'check', type: 'userTask', name: 'Check stock', lane: 'l1' },
        { id: 'gStock', type: 'exclusiveGateway', name: 'Item in stock?', lane: 'l1' },
        { id: 'reorder', type: 'userTask', name: 'Reorder item', lane: 'l1' },
        { id: 'split', type: 'parallelGateway', name: '', lane: 'l1' },
        { id: 'pack', type: 'userTask', name: 'Pack order', lane: 'l1' },
        { id: 'invoice', type: 'serviceTask', name: 'Create invoice', lane: 'l1' },
        { id: 'label', type: 'serviceTask', name: 'Print label', lane: 'l1' },
        { id: 'join', type: 'parallelGateway', name: '', lane: 'l1' },
        { id: 'ship', type: 'userTask', name: 'Ship order', lane: 'l1' },
        { id: 'end', type: 'endEvent', name: 'Order shipped', lane: 'l1' },
      ],
      edges: [
        { id: 'f1', source: 'start', target: 'check' },
        { id: 'f2', source: 'check', target: 'gStock' },
        { id: 'f3', source: 'gStock', target: 'split', label: 'Yes' },
        { id: 'f4', source: 'gStock', target: 'reorder', label: 'No', isDefault: true },
        { id: 'f5', source: 'reorder', target: 'check' },
        { id: 'f6', source: 'split', target: 'pack' },
        { id: 'f7', source: 'split', target: 'invoice' },
        { id: 'f8', source: 'split', target: 'label' },
        { id: 'f9', source: 'pack', target: 'join' },
        { id: 'f10', source: 'invoice', target: 'join' },
        { id: 'f11', source: 'label', target: 'join' },
        { id: 'f12', source: 'join', target: 'ship' },
        { id: 'f13', source: 'ship', target: 'end' },
      ],
    }],
  });

  test.each([['default', {}], ['bend rule off', { bendRule: false }], ['refine + wrap', { visualRefinement: true, elkWrapping: 'auto' }]])(
    '%s: every gateway end exactly on a vertex, one flow per vertex, the default slash on a full first segment', async (_, opts) => {
      const lc = model();
      const r = await runPipeline(lc, opts);
      const proc = lc.pools[0];
      const gateways = new Set(flattenProcessNodes(proc.nodes).filter((n) => isGateway(n.type)).map((n) => n.id));
      const used = new Map();
      for (const e of flattenProcessEdges(proc)) {
        const pts = r.coordMap.edgeCoords[e.id];
        expect(orthogonal(pts)).toBe(true);
        for (const [node, p] of [[e.source, pts[0]], [e.target, pts[pts.length - 1]]]) {
          if (!gateways.has(node)) continue;
          const side = ['left', 'right', 'top', 'bottom'].find((s) => isOnGatewayTip(p, r.coordMap.coords[node], s));
          expect(`${e.id} at ${node}: ${side ?? 'off a vertex'}`).not.toMatch(/off a vertex/);
          const key = `${node}:${side}`;
          expect(`${key} ${used.get(key) ?? ''}`.trim()).toBe(key);
          used.set(key, e.id);
        }
      }
      // the default slash sits on the first segment: long enough to carry it clear of the diamond
      const f4 = r.coordMap.edgeCoords.f4;
      expect(Math.hypot(f4[1].x - f4[0].x, f4[1].y - f4[0].y)).toBeGreaterThanOrEqual(15);
      expect(r.diagnostics.issues.filter((i) => /^DI0[7-9]|^DI1[01]/.test(i.code))).toEqual([]);
    }, 60_000);
});
