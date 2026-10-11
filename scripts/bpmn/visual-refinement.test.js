/**
 * Visual Refinement — unit tests
 */
import { estimateTextWidth, estimateTextBBox, bboxOverlaps, repairEdgeLabels, compactLanes, resolveRefinement, REFINEMENT_PASSES, innerLaneLines } from './visual-refinement.js';
import { placeEdgeLabel } from './coordinates.js';

describe('estimateTextWidth', () => {
  test('returns 0 for empty string', () => {
    expect(estimateTextWidth('', 11)).toBe(0);
  });

  test('scales roughly with character count at fontSize 11', () => {
    const short = estimateTextWidth('abc', 11);
    const long  = estimateTextWidth('abcabcabc', 11);
    expect(long).toBeGreaterThan(short * 2.5);
    expect(long).toBeLessThan(short * 3.5);
  });

  test('scales with font size', () => {
    const w11 = estimateTextWidth('Hello World', 11);
    const w22 = estimateTextWidth('Hello World', 22);
    expect(w22).toBeGreaterThan(w11 * 1.8);
  });

  test('handles German compound words (no spaces)', () => {
    const w = estimateTextWidth('Prozessverantwortlicher', 11);
    expect(w).toBeGreaterThan(100); // ~120–150 px expected
    expect(w).toBeLessThan(200);
  });
});

describe('estimateTextBBox', () => {
  test('returns bbox centered on (x,y) for single-line text', () => {
    const bb = estimateTextBBox('Yes', 100, 100, 11);
    // text "Yes" at fontSize 11 has width ~3*11*0.6 = 19.8 + padding
    expect(bb.x).toBeLessThan(100);
    expect(bb.y).toBeLessThan(100);
    expect(bb.w).toBeGreaterThan(0);
    expect(bb.h).toBeGreaterThan(0);
    // Center of the bbox should roughly equal (100, 100)
    expect(bb.x + bb.w / 2).toBeCloseTo(100, 0);
    expect(bb.y + bb.h / 2).toBeCloseTo(100, 0);
  });

  test('wider text produces wider bbox', () => {
    const short = estimateTextBBox('Yes', 100, 100, 11);
    const long  = estimateTextBBox('This is a longer label', 100, 100, 11);
    expect(long.w).toBeGreaterThan(short.w);
  });

  test('uses default fontSize=11 when omitted', () => {
    const a = estimateTextBBox('Hello', 0, 0);
    const b = estimateTextBBox('Hello', 0, 0, 11);
    expect(a).toEqual(b);
  });

  test('handles empty text', () => {
    const bb = estimateTextBBox('', 50, 50, 11);
    expect(bb.w).toBeGreaterThan(0); // just the padding
    expect(bb.h).toBeGreaterThan(0);
  });
});

describe('bboxOverlaps', () => {
  test('returns true for overlapping bboxes', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 5, y: 5, w: 10, h: 10 };
    expect(bboxOverlaps(a, b)).toBe(true);
  });

  test('returns false for separated bboxes', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 20, y: 20, w: 10, h: 10 };
    expect(bboxOverlaps(a, b)).toBe(false);
  });

  test('returns false for adjacent (touching-only) bboxes', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 10, y: 0, w: 10, h: 10 };
    expect(bboxOverlaps(a, b)).toBe(false);
  });

  test('returns true for one bbox entirely inside another', () => {
    const outer = { x: 0, y: 0, w: 100, h: 100 };
    const inner = { x: 10, y: 10, w: 10, h: 10 };
    expect(bboxOverlaps(outer, inner)).toBe(true);
  });

  test('symmetric: overlaps(a,b) === overlaps(b,a)', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 5, y: 5, w: 10, h: 10 };
    expect(bboxOverlaps(a, b)).toBe(bboxOverlaps(b, a));
  });
});

describe('repairEdgeLabels', () => {
  test('leaves non-colliding labels untouched', () => {
    const cm = {
      coords: { 'n1': { x: 0, y: 0, w: 50, h: 50 } },
      poolCoords: {}, laneCoords: {},
      edgeCoords: { 'e1': [{x:100,y:100}, {x:200,y:100}] },
      edgeLabels: { 'e1': { text: 'OK', x: 150, y: 100 } }
    };
    repairEdgeLabels(cm);
    expect(cm.edgeLabels.e1.x).toBe(150);
    expect(cm.edgeLabels.e1.y).toBe(100);
  });

  test('nudges a label that collides with a node', () => {
    const cm = {
      // Node at (140, 90) size 30x30 → occupies (140..170, 90..120)
      coords: { 'n1': { x: 140, y: 90, w: 30, h: 30 } },
      poolCoords: {}, laneCoords: {},
      edgeCoords: { 'e1': [{x:100,y:105},{x:200,y:105}] },
      // Label bbox at (150,105) collides with n1
      edgeLabels: { 'e1': { text: 'Yes', x: 150, y: 105 } }
    };
    repairEdgeLabels(cm, { maxShift: 25 });
    const moved = cm.edgeLabels.e1.x !== 150 || cm.edgeLabels.e1.y !== 105;
    expect(moved).toBe(true);
  });

  test('nudges one of two colliding labels', () => {
    const cm = {
      coords: {}, poolCoords: {}, laneCoords: {},
      edgeCoords: {
        'e1': [{x:100,y:100},{x:200,y:100}],
        'e2': [{x:100,y:100},{x:200,y:100}],
      },
      edgeLabels: {
        'e1': { text: 'Option A', x: 150, y: 100 },
        'e2': { text: 'Option B', x: 150, y: 100 },  // exactly overlapping
      }
    };
    repairEdgeLabels(cm, { maxShift: 25 });
    // At least one of the two labels should have moved
    const moved1 = cm.edgeLabels.e1.x !== 150 || cm.edgeLabels.e1.y !== 100;
    const moved2 = cm.edgeLabels.e2.x !== 150 || cm.edgeLabels.e2.y !== 100;
    expect(moved1 || moved2).toBe(true);
  });

  test('gives up and leaves label in place if no free slot within maxShift', () => {
    // Label boxed in by nodes on all sides — no nudge can free it
    const cm = {
      coords: {
        'n1': { x:   0, y:  85, w: 140, h: 30 }, // left wall
        'n2': { x: 170, y:  85, w: 140, h: 30 }, // right wall
        'n3': { x: 140, y:   0, w:  30, h:  85 }, // top wall
        'n4': { x: 140, y: 115, w:  30, h: 200 }, // bottom wall
      },
      poolCoords: {}, laneCoords: {},
      edgeCoords: { 'e1': [{x:100,y:100},{x:200,y:100}] },
      edgeLabels: { 'e1': { text: 'Stuck', x: 150, y: 100 } }
    };
    const before = { ...cm.edgeLabels.e1 };
    repairEdgeLabels(cm, { maxShift: 10 });
    // Label should be unchanged — gracefully gives up
    expect(cm.edgeLabels.e1.x).toBe(before.x);
    expect(cm.edgeLabels.e1.y).toBe(before.y);
  });

  test('no-op when coordMap has no edgeLabels', () => {
    const cm = {
      coords: {}, poolCoords: {}, laneCoords: {}, edgeCoords: {}
    };
    expect(() => repairEdgeLabels(cm)).not.toThrow();
  });

  test('returns the coordMap for chaining', () => {
    const cm = {
      coords: {}, poolCoords: {}, laneCoords: {}, edgeCoords: {}, edgeLabels: {}
    };
    expect(repairEdgeLabels(cm)).toBe(cm);
  });
});

describe('compactLanes — basic shrink', () => {
  test('shrinks a sparsely-populated lane to its content + padding', () => {
    const cm = {
      coords: { n1: { x: 50, y: 20, w: 100, h: 80 } },
      poolCoords: { p1: { x: 0, y: 0, w: 300, h: 400, laneHeaderWidth: 40 } },
      laneCoords: {
        laneA: { x: 40, y:   0, w: 260, h: 200 },
        laneB: { x: 40, y: 200, w: 260, h: 200 }
      },
      edgeCoords: {}
    };
    const proc = { pools: [{
      id: 'p1',
      lanes: [{ id: 'laneA' }, { id: 'laneB' }],
      nodes: [{ id: 'n1', lane: 'laneA' }]
    }] };
    compactLanes(cm, proc, { minLaneHeight: 60 });
    // n1 at y=20 h=80 → content height 80; +2*20 padding = 120
    expect(cm.laneCoords.laneA.h).toBe(120);
  });

  test('shifts subsequent lanes upward by cumulative delta', () => {
    const cm = {
      coords: { n1: { x: 50, y: 20, w: 100, h: 80 } },
      poolCoords: { p1: { x: 0, y: 0, w: 300, h: 400, laneHeaderWidth: 40 } },
      laneCoords: {
        laneA: { x: 40, y:   0, w: 260, h: 200 },
        laneB: { x: 40, y: 200, w: 260, h: 200 }
      },
      edgeCoords: {}
    };
    const proc = { pools: [{
      id: 'p1',
      lanes: [{ id: 'laneA' }, { id: 'laneB' }],
      nodes: [{ id: 'n1', lane: 'laneA' }]
    }] };
    compactLanes(cm, proc, { minLaneHeight: 60 });
    // laneA shrinks from 200→120 (delta 80). laneB shifts up by 80.
    expect(cm.laneCoords.laneB.y).toBe(120);
    expect(cm.laneCoords.laneB.h).toBe(60); // empty → minLaneHeight
  });

  test('respects minLaneHeight for empty lanes', () => {
    const cm = {
      coords: {},
      poolCoords: { p1: { x: 0, y: 0, w: 300, h: 200, laneHeaderWidth: 40 } },
      laneCoords: { laneA: { x: 40, y: 0, w: 260, h: 200 } },
      edgeCoords: {}
    };
    const proc = { pools: [{ id: 'p1', lanes: [{ id: 'laneA' }] }], nodes: [] };
    compactLanes(cm, proc, { minLaneHeight: 60 });
    expect(cm.laneCoords.laneA.h).toBe(60);
  });

  test('shifts nodes in subsequent lanes up by the shrink delta', () => {
    const cm = {
      coords: {
        n1: { x: 50, y: 20,  w: 100, h: 80 },
        n2: { x: 50, y: 220, w: 100, h: 80 }  // lane B
      },
      poolCoords: { p1: { x: 0, y: 0, w: 300, h: 400, laneHeaderWidth: 40 } },
      laneCoords: {
        laneA: { x: 40, y:   0, w: 260, h: 200 },
        laneB: { x: 40, y: 200, w: 260, h: 200 }
      },
      edgeCoords: { e1: [{ x: 100, y: 60 }, { x: 100, y: 260 }] }
    };
    // NOTE: nodes go inside the pool per schema (see commit 66bad2d for context)
    const proc = { pools: [{
      id: 'p1',
      lanes: [{ id: 'laneA' }, { id: 'laneB' }],
      nodes: [{ id: 'n1', lane: 'laneA' }, { id: 'n2', lane: 'laneB' }]
    }] };
    compactLanes(cm, proc, { minLaneHeight: 60 });
    // laneA: content 80 + 2*20 = 120 → delta 80 from 200
    // n2 (in laneB) should be shifted up by 80
    expect(cm.coords.n2.y).toBe(140); // 220 - 80
    // The waypoint at y=260 (below laneA shrunk boundary) should also be shifted by 80
    expect(cm.edgeCoords.e1[1].y).toBe(180); // 260 - 80
    // The waypoint at y=60 (inside laneA) should NOT shift
    expect(cm.edgeCoords.e1[0].y).toBe(60);
  });

  test('is idempotent — running twice equals running once', () => {
    const cm = {
      coords: { n1: { x: 50, y: 20, w: 100, h: 80 } },
      poolCoords: { p1: { x: 0, y: 0, w: 300, h: 400, laneHeaderWidth: 40 } },
      laneCoords: {
        laneA: { x: 40, y:   0, w: 260, h: 200 },
        laneB: { x: 40, y: 200, w: 260, h: 200 }
      },
      edgeCoords: { e1: [{ x: 100, y: 60 }, { x: 100, y: 260 }] }
    };
    const proc = { pools: [{
      id: 'p1',
      lanes: [{ id: 'laneA' }, { id: 'laneB' }],
      nodes: [{ id: 'n1', lane: 'laneA' }]
    }] };
    compactLanes(cm, proc, { minLaneHeight: 60 });
    const snap1 = structuredClone({
      coords: cm.coords, laneCoords: cm.laneCoords, edgeCoords: cm.edgeCoords
    });
    compactLanes(cm, proc, { minLaneHeight: 60 });
    expect({
      coords: cm.coords, laneCoords: cm.laneCoords, edgeCoords: cm.edgeCoords
    }).toEqual(snap1);
  });
});

describe('compactLanes — no strip between lanes', () => {
  // laneB's content sits 60 px below its band top (coordinates.js §5.0: LANE_PADDING +
  // EXTERNAL_LABEL_H). Re-derived from content alone, laneB's band started 40 px below laneA's
  // new bottom — the empty band bpmn.io drew in 5 of 10 laned fixtures.
  function fixture() {
    return {
      cm: {
        coords: { n1: { x: 50, y: 20, w: 100, h: 80 }, n2: { x: 50, y: 260, w: 100, h: 80 } },
        poolCoords: { p1: { x: 0, y: 0, w: 300, h: 400, laneHeaderWidth: 40 } },
        laneCoords: {
          laneA: { x: 40, y: 0, w: 260, h: 200 },
          laneB: { x: 40, y: 200, w: 260, h: 200 },
        },
        edgeCoords: {},
      },
      proc: { pools: [{ id: 'p1', lanes: [{ id: 'laneA' }, { id: 'laneB' }],
        nodes: [{ id: 'n1', lane: 'laneA' }, { id: 'n2', lane: 'laneB' }] }] },
    };
  }

  test('the lower band starts exactly where the upper one ends', () => {
    const { cm, proc } = fixture();
    compactLanes(cm, proc, { minLaneHeight: 60 });
    expect(cm.laneCoords.laneA).toEqual({ x: 40, y: 0, w: 260, h: 120 });
    expect(cm.laneCoords.laneB).toEqual({ x: 40, y: 120, w: 260, h: 160 });
  });

  test('no content moves to close it: n2 sits where the cascade put it, 20 px above the band bottom', () => {
    const { cm, proc } = fixture();
    compactLanes(cm, proc, { minLaneHeight: 60 });
    expect(cm.coords.n2.y).toBe(180);
    expect(cm.laneCoords.laneB.y + cm.laneCoords.laneB.h - (cm.coords.n2.y + cm.coords.n2.h)).toBe(20);
    expect(cm.poolCoords.p1).toMatchObject({ y: 0, h: 280 });
  });

  test('idempotent with offset content', () => {
    const { cm, proc } = fixture();
    compactLanes(cm, proc, { minLaneHeight: 60 });
    const once = structuredClone({ coords: cm.coords, laneCoords: cm.laneCoords, poolCoords: cm.poolCoords });
    compactLanes(cm, proc, { minLaneHeight: 60 });
    expect({ coords: cm.coords, laneCoords: cm.laneCoords, poolCoords: cm.poolCoords }).toEqual(once);
  });
});

describe('compactLanes — multi-pool', () => {
  // Two pools stacked vertically (p2 below p1, POOL_GAP-style separation).
  // Compacting p1's only lane must move p2 as a rigid body: its box, its
  // lane, its node, and its own edge's waypoints — all by the same delta —
  // so p2's edge stays attached to p2's node. This is the exact defect: the
  // old code shifted every edgeCoords entry globally but only shifted nodes
  // within the pool being compacted, so p2's edge moved without p2's node.
  function twoPoolFixture() {
    return {
      cm: {
        coords: {
          n1: { x: 50, y: 20,  w: 100, h: 80 },   // p1 / laneA
          n2: { x: 50, y: 420, w: 100, h: 80 },   // p2 / laneC
        },
        poolCoords: {
          p1: { x: 0, y: 0,   w: 300, h: 200, laneHeaderWidth: 40 },
          p2: { x: 0, y: 260, w: 300, h: 200, laneHeaderWidth: 40 },
        },
        laneCoords: {
          laneA: { x: 40, y: 0,   w: 260, h: 200 },
          laneC: { x: 40, y: 260, w: 260, h: 200 },
        },
        edgeCoords: {
          e1: [{ x: 100, y: 60 }, { x: 100, y: 460 }], // owned by p2 (source n2)
        },
        edgeLabels: {
          e1: { text: 'go', x: 100, y: 460 },
        },
      },
      proc: {
        pools: [
          { id: 'p1', lanes: [{ id: 'laneA' }], nodes: [{ id: 'n1', lane: 'laneA' }] },
          { id: 'p2', lanes: [{ id: 'laneC' }], nodes: [{ id: 'n2', lane: 'laneC' }], edges: [{ id: 'e1', source: 'n2', target: 'n3' }] },
        ],
      },
    };
  }

  test('compacting p1 shifts p2 as a rigid body — box, lane, node, edge, label', () => {
    const { cm, proc } = twoPoolFixture();
    compactLanes(cm, proc, { minLaneHeight: 60 });

    // p1/laneA: content 80 + 2*20 = 120 → delta 80 from 200.
    expect(cm.laneCoords.laneA.h).toBe(120);
    const delta = 80;

    expect(cm.poolCoords.p2.y).toBe(260 - delta);
    expect(cm.laneCoords.laneC.y).toBe(260 - delta);
    expect(cm.coords.n2.y).toBe(420 - delta);
    // Both of e1's waypoints move by the same delta as n2 — the endpoint on
    // n2 stays attached to it.
    expect(cm.edgeCoords.e1[1].y).toBe(460 - delta);
    expect(cm.edgeLabels.e1.y).toBe(460 - delta);
  });

  test('an edge not owned by the compacted pool is left untouched', () => {
    const { cm, proc } = twoPoolFixture();
    // A stray entry with no owning pool at all (e.g. a message flow, not yet
    // routed at this point in the pipeline) must not be touched by either
    // pool's compaction.
    cm.edgeCoords.stray = [{ x: 900, y: 900 }, { x: 900, y: 950 }];
    const before = structuredClone(cm.edgeCoords.stray);
    compactLanes(cm, proc, { minLaneHeight: 60 });
    expect(cm.edgeCoords.stray).toEqual(before);
  });

  test('is idempotent across two pools', () => {
    const { cm, proc } = twoPoolFixture();
    compactLanes(cm, proc, { minLaneHeight: 60 });
    const snap1 = structuredClone({
      coords: cm.coords, laneCoords: cm.laneCoords, poolCoords: cm.poolCoords,
      edgeCoords: cm.edgeCoords, edgeLabels: cm.edgeLabels,
    });
    compactLanes(cm, proc, { minLaneHeight: 60 });
    expect({
      coords: cm.coords, laneCoords: cm.laneCoords, poolCoords: cm.poolCoords,
      edgeCoords: cm.edgeCoords, edgeLabels: cm.edgeLabels,
    }).toEqual(snap1);
  });

  test('a subprocess child moves with its parent when the lane above shrinks', () => {
    const cm = {
      coords: {
        n1:    { x: 50, y: 20,  w: 100, h: 80 },  // p1 / laneA
        sub:   { x: 50, y: 420, w: 200, h: 150 }, // p2 / laneC, expanded
        child: { x: 70, y: 450, w: 100, h: 80 },  // sub's child — must move with it
      },
      poolCoords: {
        p1: { x: 0, y: 0,   w: 300, h: 200, laneHeaderWidth: 40 },
        p2: { x: 0, y: 260, w: 300, h: 320, laneHeaderWidth: 40 },
      },
      laneCoords: {
        laneA: { x: 40, y: 0,   w: 260, h: 200 },
        laneC: { x: 40, y: 260, w: 260, h: 320 },
      },
      edgeCoords: {},
      edgeLabels: {},
    };
    const proc = {
      pools: [
        { id: 'p1', lanes: [{ id: 'laneA' }], nodes: [{ id: 'n1', lane: 'laneA' }] },
        {
          id: 'p2', lanes: [{ id: 'laneC' }],
          nodes: [{ id: 'sub', lane: 'laneC', nodes: [{ id: 'child' }] }],
        },
      ],
    };
    compactLanes(cm, proc, { minLaneHeight: 60 });
    const delta = 80; // same as the fixture above: 200 - 120
    expect(cm.coords.sub.y).toBe(420 - delta);
    expect(cm.coords.child.y).toBe(450 - delta);
  });
});

describe('resolveRefinement', () => {
  const defaults = { laneCompaction: false, edgeLabelCollisionRepair: true };
  test('undefined means the per-pass config defaults', () => {
    expect(resolveRefinement(undefined, defaults)).toEqual(defaults);
  });
  test('true and false switch every pass', () => {
    expect(resolveRefinement(true, defaults)).toEqual({ laneCompaction: true, edgeLabelCollisionRepair: true });
    expect(resolveRefinement(false, defaults)).toEqual({ laneCompaction: false, edgeLabelCollisionRepair: false });
  });
  test('an object overrides single passes over the defaults', () => {
    expect(resolveRefinement({ laneCompaction: true }, defaults)).toEqual({ ...defaults, laneCompaction: true });
  });
  test('unknown pass names and non-boolean values are refused', () => {
    expect(() => resolveRefinement({ laneCompactoin: true }, defaults)).toThrow(TypeError);
    expect(() => resolveRefinement({ laneCompaction: 'yes' }, defaults)).toThrow(TypeError);
    expect(() => resolveRefinement('all', defaults)).toThrow(TypeError);
  });
  test('the removed dynamicLaneHeader pass is an unknown pass', () => {
    expect(() => resolveRefinement({ dynamicLaneHeader: true }, defaults)).toThrow(/dynamicLaneHeader/);
    expect(() => resolveRefinement({ dynamicLaneHeader: true }, defaults)).toThrow(TypeError);
  });
  test('the pass list is exactly the two passes', () => {
    expect([...REFINEMENT_PASSES]).toEqual(['laneCompaction', 'edgeLabelCollisionRepair']);
  });
});

describe('innerLaneLines', () => {
  test('one line per band below the first, spanning the band', () => {
    const lc = { pools: [{ id: 'P', lanes: [{ id: 'B' }, { id: 'A' }] }] };
    const cm = { laneCoords: { A: { x: 30, y: 0, w: 500, h: 120 }, B: { x: 30, y: 120, w: 500, h: 90 } } };
    expect(innerLaneLines(cm, lc)).toEqual([{ y: 120, x0: 30, x1: 530 }]);
  });
});

describe('edge labels keep off lane separators', () => {
  const route = [{ x: 100, y: 60 }, { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 160 }];
  const line = [{ y: 90, x0: 30, x1: 530 }];
  test('placement: a label that would lie across a separator takes the other side of its segment', () => {
    const plain = placeEdgeLabel('Yes', route);
    expect(plain.side).toBe('above');
    const kept = placeEdgeLabel('Yes', route, { avoidLines: line });
    expect(kept.side).toBe('below');
    expect(kept.x).toBe(plain.x);
    expect(kept.y - kept.h / 2).toBeGreaterThan(100);
  });
  test('placement: a separator nowhere near the label changes nothing', () => {
    expect(placeEdgeLabel('Yes', route, { avoidLines: [{ y: 300, x0: 30, x1: 530 }] }))
      .toEqual(placeEdgeLabel('Yes', route));
  });
  const collidingMap = () => ({
    coords: { n: { x: 120, y: 80, w: 60, h: 15 } }, poolCoords: {}, laneCoords: {},
    edgeCoords: { e: [{ x: 100, y: 100 }, { x: 200, y: 100 }] },
    edgeLabels: { e: { text: 'Yes', x: 150, y: 80, w: 20, h: 14, side: 'above' } },
  });
  test('repair: a nudge that would put the label across a separator is refused', () => {
    const free = repairEdgeLabels(collidingMap(), { maxShift: 25 });
    expect(free.edgeLabels.e.y).toBe(65);
    const kept = repairEdgeLabels(collidingMap(), { maxShift: 25, laneLines: [{ y: 65, x0: 30, x1: 530 }] });
    expect(kept.edgeLabels.e.y).toBe(55);
  });
});

test('references/api-schema.json $defs/VisualRefinementOption equals VISUAL_REFINEMENT_OPTION_SCHEMA', async () => {
  const { readFileSync } = await import('node:fs');
  const api = JSON.parse(readFileSync(new URL('../../references/api-schema.json', import.meta.url), 'utf8'));
  const { VISUAL_REFINEMENT_OPTION_SCHEMA } = await import('./visual-refinement.js');
  const { description, ...def } = api.$defs.VisualRefinementOption;
  expect(def).toEqual(JSON.parse(JSON.stringify(VISUAL_REFINEMENT_OPTION_SCHEMA)));
});
