import { describe, test, expect } from '@jest/globals';
import { assertStubClearsPad, simplifyEdge, simplifyAllEdges, guardAgainstLegacy, reclipStuckEnds, reclipOptionsFor } from './edge-simplify.js';

describe('simplifyEdge — an L never ends along its endpoint\'s outline (#52)', () => {
  test("Flow_8: the L that runs down the target's left side is replaced by the one arriving horizontally", () => {
    const boxes = { J: { x: 256, y: 94.5, w: 50, h: 50 }, T: { x: 386, y: 131, w: 100, h: 80 } };
    const elk = [{ x: 293.5, y: 132 }, { x: 356, y: 132 }, { x: 356, y: 171 }, { x: 386, y: 171 }];
    expect(simplifyEdge(elk, boxes, 'J', 'T')).toEqual(
      [{ x: 293.5, y: 132 }, { x: 293.5, y: 171 }, { x: 386, y: 171 }]);
  });

  test('a start on the upper half of a circle never gets a first segment pointing down through it', () => {
    // E's centre is (118,118); (130,105) lies on its outline above the centre. The vertical-first L
    // would run down through the event; the horizontal-first L would end along T's left side.
    const boxes = { E: { x: 100, y: 100, w: 36, h: 36 }, T: { x: 300, y: 200, w: 100, h: 80 } };
    const elk = [{ x: 130, y: 105 }, { x: 200, y: 105 }, { x: 200, y: 240 }, { x: 300, y: 240 }];
    expect(simplifyEdge(elk, boxes, 'E', 'T')).toEqual(
      [{ x: 130, y: 105 }, { x: 215, y: 105 }, { x: 215, y: 240 }, { x: 300, y: 240 }]);
  });

  test('legacy: true returns the L this pass took before #52 (what the crossing guard reverts to)', () => {
    const boxes = { E: { x: 100, y: 100, w: 36, h: 36 }, T: { x: 300, y: 200, w: 100, h: 80 } };
    const elk = [{ x: 130, y: 105 }, { x: 200, y: 105 }, { x: 200, y: 240 }, { x: 300, y: 240 }];
    expect(simplifyEdge(elk, boxes, 'E', 'T', { legacy: true })).toEqual(
      [{ x: 130, y: 105 }, { x: 300, y: 105 }, { x: 300, y: 240 }]);
  });

  test('a 15 px stub reaches the gap a mid-corridor Z cannot (a node right in front of the target)', () => {
    // Both L's lie on an outline; O blocks every candidateRoutes corridor (y 140, 180, 100); the
    // stub route turns 15 px above T's top, in the strip O leaves free.
    const boxes = {
      S: { x: 0, y: 0, w: 100, h: 80 },
      T: { x: 200, y: 200, w: 100, h: 80 },
      O: { x: 70, y: 100, w: 160, h: 80 },
    };
    const elk = [{ x: 50, y: 80 }, { x: 50, y: 140 }, { x: 250, y: 140 }, { x: 250, y: 200 }];
    expect(simplifyEdge(elk, boxes, 'S', 'T')).toEqual(
      [{ x: 50, y: 80 }, { x: 50, y: 185 }, { x: 250, y: 185 }, { x: 250, y: 200 }]);
  });

  // S exits right at (100,40), T is entered on its left at (300,240); O blocks every corridor.
  const blocked = {
    S: { x: 0, y: 0, w: 100, h: 80 },
    T: { x: 300, y: 200, w: 100, h: 80 },
    O: { x: 110, y: 60, w: 180, h: 170 },
  };

  test('no admissible route and an obstructed original: the old L (an outline beats a shape)', () => {
    const throughO = [{ x: 100, y: 40 }, { x: 200, y: 40 }, { x: 200, y: 240 }, { x: 300, y: 240 }];
    expect(simplifyEdge(throughO, blocked, 'S', 'T')).toEqual(
      [{ x: 100, y: 40 }, { x: 300, y: 40 }, { x: 300, y: 240 }]);
  });

  test('no admissible route and a clear original: the original, same reference', () => {
    const aroundO = [{ x: 100, y: 40 }, { x: 296, y: 40 }, { x: 296, y: 240 }, { x: 300, y: 240 }];
    expect(simplifyEdge(aroundO, blocked, 'S', 'T')).toBe(aroundO);
  });

  test('an edge inside an expanded subprocess is never simplified (its parent box is an obstacle)', () => {
    const boxes = {
      P: { x: 0, y: 0, w: 600, h: 400 },
      a: { x: 50, y: 50, w: 100, h: 80 },
      b: { x: 300, y: 200, w: 100, h: 80 },
    };
    const elk = [{ x: 150, y: 90 }, { x: 225, y: 90 }, { x: 225, y: 240 }, { x: 300, y: 240 }];
    expect(simplifyEdge(elk, boxes, 'a', 'b')).toBe(elk);
  });
});

describe('simplifyAllEdges — no host exception any more', () => {
  test('an edge at a boundary-event host is simplified like any other', () => {
    const coords = { E: { x: 100, y: 100, w: 36, h: 36 }, T: { x: 300, y: 200, w: 100, h: 80 } };
    const edges = [{ id: 'e', source: 'E', target: 'T' }];
    const route = { e: [{ x: 130, y: 105 }, { x: 200, y: 105 }, { x: 200, y: 240 }, { x: 300, y: 240 }] };
    expect(simplifyAllEdges(route, coords, edges).e)
      .toEqual([{ x: 130, y: 105 }, { x: 215, y: 105 }, { x: 215, y: 240 }, { x: 300, y: 240 }]);
  });
});

describe('guardAgainstLegacy — per-edge crossing guard', () => {
  const coords = {
    a: { x: 0, y: 0, w: 60, h: 40 }, b: { x: 300, y: 200, w: 60, h: 40 },
    c: { x: 0, y: 300, w: 60, h: 40 }, d: { x: 300, y: 400, w: 60, h: 40 },
  };
  const edges = [{ id: 'e1', source: 'a', target: 'b' }, { id: 'e2', source: 'c', target: 'd' }];
  const e2 = [{ x: 60, y: 320 }, { x: 300, y: 320 }, { x: 300, y: 400 }];
  const legacy = { e1: [{ x: 60, y: 20 }, { x: 300, y: 20 }, { x: 300, y: 200 }], e2 };
  // maxPasses: 0 makes repairCrossings a no-op, so the test sees the guard alone.
  const noRepair = { maxPasses: 0 };

  test('reverts the one edge whose new route leaves more crossings, and nothing else', () => {
    const routes = { e1: [{ x: 60, y: 20 }, { x: 100, y: 20 }, { x: 100, y: 350 }, { x: 250, y: 350 },
      { x: 250, y: 200 }, { x: 300, y: 200 }], e2 };
    const g = guardAgainstLegacy(routes, legacy, coords, edges, new Set(), noRepair);
    expect(g.reverted).toEqual(['e1']);
    expect(g.routes.e1).toBe(legacy.e1);
    expect(g.routes.e2).toBe(e2);
  });

  test('no more crossings than the old routes: the input comes back untouched', () => {
    const g = guardAgainstLegacy(legacy, legacy, coords, edges, new Set(), noRepair);
    expect(g.reverted).toEqual([]);
    expect(g.routes).toBe(legacy);
  });
});

describe('reclipStuckEnds — an end may move to another side when it is stuck', () => {
  // S's flow leaves its right side and runs back through S, then down the left tangent of G.
  const coords = { S: { x: 100, y: 0, w: 100, h: 80 }, G: { x: 100, y: 200, w: 50, h: 50 } };
  const edges = [{ id: 'e', source: 'S', target: 'G' }];
  const shapeOf = (id) => (id === 'G' ? 'diamond' : 'rect');
  const stuck = () => ({ e: [{ x: 200, y: 27 }, { x: 100.5, y: 27 }, { x: 100.5, y: 225 }] });

  test('re-clips to side midpoints and routes with 15 px stubs, clear of both shapes', () => {
    const out = reclipStuckEnds(stuck(), coords, edges, new Set(), { shapeOf }).e;
    expect(out).toEqual([{ x: 150, y: 80 }, { x: 150, y: 95 }, { x: 125, y: 95 }, { x: 125, y: 200 }]);
  });

  test('an endpoint listed as fixed never moves — here nothing admissible is left, so nothing changes', () => {
    const ec = stuck();
    expect(reclipStuckEnds(ec, coords, edges, new Set(), { shapeOf, fixedEndpoints: new Set(['S']) })).toBe(ec);
  });

  test('a clean edge is left alone (same map back)', () => {
    const clean = { e: [{ x: 150, y: 80 }, { x: 150, y: 140 }, { x: 125, y: 140 }, { x: 125, y: 200 }] };
    expect(reclipStuckEnds(clean, coords, edges, new Set(), { shapeOf })).toBe(clean);
  });

  test('a re-route may not cross another route more often than the stuck route did', () => {
    // w walls S and G in; the stuck route crosses it once (at (100.5, 90)). The best admissible
    // re-route keeps S's endpoint, goes round on the right, crosses w once, and enters G at its
    // right point — one moved endpoint beats two.
    const wallCoords = { ...coords, A: { x: 400, y: 0, w: 40, h: 40 }, B: { x: 400, y: 400, w: 40, h: 40 } };
    const wallEdges = [...edges, { id: 'w', source: 'A', target: 'B' }];
    const ec = { ...stuck(), w: [{ x: 420, y: 40 }, { x: 420, y: 90 }, { x: 60, y: 90 }, { x: 60, y: 300 },
      { x: 420, y: 300 }, { x: 420, y: 400 }] };
    const out = reclipStuckEnds(ec, wallCoords, wallEdges, new Set(), { shapeOf });
    expect(out.e).toEqual([{ x: 200, y: 27 }, { x: 388, y: 27 }, { x: 388, y: 225 }, { x: 150, y: 225 }]);
    expect(out.w).toBe(ec.w);
  });
});

describe('reclipStuckEnds — a boundary event\'s endpoint stays where placeBoundaryEvents put it', () => {
  // f starts on E's bottom point and runs back up through E. w is laid so that the cheapest fix
  // moves f's start to E's top (over Z, no crossing); keeping the start costs one crossing with w.
  const coords = { E: { x: 100, y: 100, w: 36, h: 36 }, T: { x: 300, y: 0, w: 100, h: 80 },
    A: { x: 40, y: 130, w: 20, h: 30 }, Z: { x: 240, y: -90, w: 40, h: 40 } };
  const edges = [{ id: 'f', source: 'E', target: 'T' }, { id: 'w', source: 'A', target: 'Z' }];
  const shapeOf = (id) => (id === 'E' ? 'circle' : 'rect');
  const stuck = () => ({ f: [{ x: 118, y: 136 }, { x: 118, y: 40 }, { x: 300, y: 40 }],
    w: [{ x: 60, y: 145 }, { x: 260, y: 145 }, { x: 260, y: -50 }] });

  test('free, the start would move — that is what makes the fixed case a real test', () => {
    expect(reclipStuckEnds(stuck(), coords, edges, new Set(), { shapeOf }).f[0]).toEqual({ x: 118, y: 100 });
  });
  test('fixed, the start stays on the bottom point and the route pays the crossing instead', () => {
    const out = reclipStuckEnds(stuck(), coords, edges, new Set(), { shapeOf, fixedEndpoints: new Set(['E']) }).f;
    expect(out).toEqual([{ x: 118, y: 136 }, { x: 118, y: 172 }, { x: 350, y: 172 }, { x: 350, y: 80 }]);
  });
});

describe('reclipOptionsFor — what the pipeline hands reclipStuckEnds', () => {
  const nodes = [
    { id: 'task', type: 'userTask' },
    { id: 'timer', type: 'boundaryEvent', attachedTo: 'task' },
    { id: 'end', type: 'endEvent' },
    { id: 'gw', type: 'exclusiveGateway' },
  ];
  test('every boundary event is a fixed endpoint, nothing else is', () => {
    expect([...reclipOptionsFor(nodes).fixedEndpoints]).toEqual(['timer']);
  });
  test('shapes: event → circle, gateway → diamond, anything else → rect', () => {
    const { shapeOf } = reclipOptionsFor(nodes);
    expect(['task', 'timer', 'end', 'gw', 'unknown'].map(shapeOf)).toEqual(['rect', 'circle', 'circle', 'diamond', 'rect']);
  });
});

describe('assertStubClearsPad', () => {
  test('rejects a stub length that does not exceed the router padding, accepts a larger one', () => {
    expect(() => assertStubClearsPad(12, 12)).toThrow(/endStubPx/);
    expect(() => assertStubClearsPad(8, 12)).toThrow(/greater than/);
    expect(() => assertStubClearsPad(15, 12)).not.toThrow();
  });
  test('the configured stub clears the real router padding', async () => {
    const { ROUTER_PAD } = await import('./orthogonal-router.js');
    const { CFG } = await import('../shared/utils.js');
    expect(() => assertStubClearsPad(CFG.layout?.endStubPx ?? 15, ROUTER_PAD)).not.toThrow();
  });
});
