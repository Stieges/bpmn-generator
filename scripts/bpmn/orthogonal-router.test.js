/**
 * orthogonal-router.js — unit tests
 */

import { describe, test, expect } from '@jest/globals';
import { routeAroundObstacles } from './orthogonal-router.js';

describe('routeAroundObstacles', () => {
  test('an open path finds the direct route', () => {
    const start = { x: 0, y: 0 };
    const end = { x: 100, y: 0 };
    const route = routeAroundObstacles(start, 'right', end, 'right', []);
    expect(route).toEqual([start, end]);
  });

  test('a single wall forces and finds a detour', () => {
    const start = { x: 0, y: 0 };
    const end = { x: 100, y: 0 };
    const wall = { x: 40, y: -20, w: 20, h: 40 };
    const route = routeAroundObstacles(start, 'right', end, 'right', [wall]);
    expect(route).not.toBeNull();
    expect(route[0]).toEqual(start);
    expect(route[route.length - 1]).toEqual(end);
    // Every segment must clear the wall's padded box.
    for (let i = 0; i < route.length - 1; i++) {
      const a = route[i], b = route[i + 1];
      const clearsX = Math.max(a.x, b.x) <= wall.x || Math.min(a.x, b.x) >= wall.x + wall.w;
      const clearsY = Math.max(a.y, b.y) <= wall.y || Math.min(a.y, b.y) >= wall.y + wall.h;
      expect(clearsX || clearsY).toBe(true);
    }
  });

  test('a gap in a ring of obstacles is found', () => {
    const start = { x: 0, y: -100 };
    const end = { x: 0, y: 100 };
    // Walls on three sides of a box around the direct path, open at the right.
    const obstacles = [
      { x: -60, y: -50, w: 20, h: 100 },  // left wall
      { x: -60, y: -50, w: 100, h: 20 },  // top wall
      { x: -60, y: 30, w: 100, h: 20 },   // bottom wall
      // right side deliberately left open
    ];
    const route = routeAroundObstacles(start, 'down', end, 'down', obstacles, { margins: [200] });
    expect(route).not.toBeNull();
    expect(route[0]).toEqual(start);
    expect(route[route.length - 1]).toEqual(end);
  });

  test('a genuinely unreachable target returns null, not a crash or a hang', () => {
    const start = { x: 5, y: 5 };
    const end = { x: 100, y: 100 };
    // A single obstacle enclosing the start point on every side within the
    // search margin — no grid point outside it is reachable.
    const enclosure = { x: -1000, y: -1000, w: 2000, h: 2000 };
    const route = routeAroundObstacles(start, 'right', end, 'left', [enclosure], { margins: [50] });
    expect(route).toBeNull();
  });

  test('deterministic: the same input produces a byte-identical route', () => {
    const start = { x: 0, y: 0 };
    const end = { x: 200, y: 150 };
    const obstacles = [
      { x: 60, y: -10, w: 30, h: 60 },
      { x: 120, y: 80, w: 40, h: 40 },
    ];
    const soft = [[{ x: 0, y: 100 }, { x: 200, y: 100 }]];
    const a = routeAroundObstacles(start, 'right', end, 'down', obstacles, { softObstacles: soft });
    const b = routeAroundObstacles(start, 'right', end, 'down', obstacles, { softObstacles: soft });
    expect(a).toEqual(b);
  });

  test('respects the maxGridPoints cap by giving up rather than growing unbounded', () => {
    const start = { x: 0, y: 0 };
    const end = { x: 1000, y: 1000 };
    const obstacles = [];
    for (let i = 0; i < 60; i++) {
      obstacles.push({ x: i * 20, y: i * 20, w: 5, h: 5 });
    }
    const route = routeAroundObstacles(start, 'right', end, 'down', obstacles, { maxGridPoints: 10, margins: [900] });
    expect(route).toBeNull();
  });
});
