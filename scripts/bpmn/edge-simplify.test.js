import { describe, test, expect } from '@jest/globals';
import { simplifyEdge, simplifyAllEdges, guardAgainstLegacy } from './edge-simplify.js';

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

  test('a 15 px stub reaches the gap a mid-corridor Z cannot (study case: a node right in front of the target)', () => {
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
