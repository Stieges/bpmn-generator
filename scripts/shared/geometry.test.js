import { describe, test, expect } from '@jest/globals';
import { clipStraight, clipToRect } from './geometry.js';

describe('clipToRect', () => {
  const rect = { x: 0, y: 0, w: 100, h: 50 };
  const center = { x: 50, y: 25 };

  test('horizontal ray lands on the right edge midpoint', () => {
    expect(clipToRect(center, { x: 250, y: 25 }, rect)).toEqual({ x: 100, y: 25 });
  });

  test('vertical ray lands on the bottom edge midpoint', () => {
    expect(clipToRect(center, { x: 50, y: 225 }, rect)).toEqual({ x: 50, y: 50 });
  });

  test('degenerate case (towards === from) returns from unchanged', () => {
    expect(clipToRect(center, center, rect)).toEqual({ x: 50, y: 25 });
  });
});

describe('clipStraight', () => {
  test('two same-height rectangles 300px apart clip to their facing edges', () => {
    const a = { x: 0, y: 0, w: 100, h: 50 };
    const b = { x: 300, y: 0, w: 100, h: 50 };
    expect(clipStraight(a, b)).toEqual([
      { x: 100, y: 25 },
      { x: 300, y: 25 },
    ]);
  });
});
