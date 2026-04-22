/**
 * Visual Refinement — unit tests
 */
import { estimateTextWidth } from './visual-refinement.js';
import { computeDynamicLaneHeaders } from './visual-refinement.js';

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
