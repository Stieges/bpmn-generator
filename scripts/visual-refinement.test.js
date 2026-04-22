/**
 * Visual Refinement — unit tests
 */
import { estimateTextWidth, computeDynamicLaneHeaders, estimateTextBBox, bboxOverlaps, repairEdgeLabels } from './visual-refinement.js';

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

describe('computeDynamicLaneHeaders', () => {
  const mkCoordMap = () => ({
    poolCoords: { 'pool1': { x: 0, y: 0, w: 500, h: 200, laneHeaderWidth: 40 } },
    laneCoords: {
      'lane1': { x: 40, y:   0, w: 460, h: 100 },
      'lane2': { x: 40, y: 100, w: 460, h: 100 },
    },
    coords: {}, edgeCoords: {}
  });

  const mkProcess = (laneNames) => ({
    pools: [{
      id: 'pool1',
      lanes: [
        { id: 'lane1', name: laneNames[0] },
        { id: 'lane2', name: laneNames[1] },
      ],
    }],
  });

  test('leaves short labels at min width', () => {
    const coords = mkCoordMap();
    const proc = mkProcess(['A', 'B']);
    const out = computeDynamicLaneHeaders(coords, proc, { minWidth: 30, maxWidth: 120 });
    expect(out.poolCoords.pool1.laneHeaderWidth).toBe(30);
  });

  test('widens header for long compound words', () => {
    const coords = mkCoordMap();
    const proc = mkProcess(['Kurz', 'Prozessverantwortlicher']);
    const out = computeDynamicLaneHeaders(coords, proc, { minWidth: 30, maxWidth: 120 });
    expect(out.poolCoords.pool1.laneHeaderWidth).toBeGreaterThan(30);
    expect(out.poolCoords.pool1.laneHeaderWidth).toBeLessThanOrEqual(120);
  });

  test('grows pool width to the left by delta', () => {
    const coords = mkCoordMap();
    const proc = mkProcess(['Kurz', 'Prozessverantwortlicher']);
    const origPoolX = coords.poolCoords.pool1.x;
    const origPoolW = coords.poolCoords.pool1.w;
    const origDefault = coords.poolCoords.pool1.laneHeaderWidth; // 40
    const out = computeDynamicLaneHeaders(coords, proc, { minWidth: 30, maxWidth: 120 });
    const delta = out.poolCoords.pool1.laneHeaderWidth - origDefault;
    expect(out.poolCoords.pool1.x).toBe(origPoolX - delta);
    expect(out.poolCoords.pool1.w).toBe(origPoolW + delta);
  });

  test('clamps to maxWidth when label is extremely long', () => {
    const coords = mkCoordMap();
    const longLabel = 'A'.repeat(100);
    const proc = mkProcess([longLabel, 'short']);
    const out = computeDynamicLaneHeaders(coords, proc, { minWidth: 30, maxWidth: 120 });
    expect(out.poolCoords.pool1.laneHeaderWidth).toBe(120);
  });

  test('handles single-pool via _singlePool key', () => {
    const coords = {
      poolCoords: { '_singlePool': { x: 0, y: 0, w: 500, h: 200, laneHeaderWidth: 40 } },
      laneCoords: { 'lane1': { x: 40, y: 0, w: 460, h: 100 } },
      coords: {}, edgeCoords: {}
    };
    const proc = { pools: [{ id: 'pool1', lanes: [{ id: 'lane1', name: 'Prozessverantwortlicher' }] }] };
    const out = computeDynamicLaneHeaders(coords, proc, { minWidth: 30, maxWidth: 120 });
    // Falls back to '_singlePool' if pool.id not found
    expect(out.poolCoords['_singlePool'].laneHeaderWidth).toBeGreaterThan(30);
  });

  test('no-op for pool with no lanes', () => {
    const coords = { poolCoords: { 'pool1': { x: 0, y: 0, w: 500, h: 200, laneHeaderWidth: 40 } }, laneCoords: {}, coords: {}, edgeCoords: {} };
    const proc = { pools: [{ id: 'pool1', lanes: [] }] };
    const out = computeDynamicLaneHeaders(coords, proc, { minWidth: 30, maxWidth: 120 });
    expect(out.poolCoords.pool1.laneHeaderWidth).toBe(40);
    expect(out.poolCoords.pool1.x).toBe(0);
    expect(out.poolCoords.pool1.w).toBe(500);
  });

  test('returns coordMap (same object) for chaining', () => {
    const coords = mkCoordMap();
    const proc = mkProcess(['A', 'B']);
    const out = computeDynamicLaneHeaders(coords, proc, {});
    expect(out).toBe(coords);
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
