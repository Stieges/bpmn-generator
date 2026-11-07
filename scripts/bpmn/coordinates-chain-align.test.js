/**
 * Fence for alignSameLaneChains — same-lane forward strips share a centerline Y;
 * rework / distant ranks stay on their own row; equal-cy succession seeds straight H.
 */
import { describe, test, expect } from '@jest/globals';
import { alignSameLaneChains } from './coordinates.js';

const P = (x, y) => ({ x, y });
const cyOf = (b) => b.y + b.h / 2;

describe('alignSameLaneChains', () => {
  test('staggered A→B→C snap to shared cy; distant branch D stays put', () => {
    const lc = {
      id: 'P',
      nodes: [
        { id: 'A', type: 'userTask', name: 'A', lane: 'L1' },
        { id: 'B', type: 'exclusiveGateway', name: '?', lane: 'L1' },
        { id: 'C', type: 'userTask', name: 'C', lane: 'L1' },
        { id: 'D', type: 'userTask', name: 'D', lane: 'L1' },
      ],
      lanes: [{ id: 'L1', name: 'Seller' }],
      edges: [
        { id: 'eAB', source: 'A', target: 'B' },
        { id: 'eBC', source: 'B', target: 'C' },
        { id: 'eAD', source: 'A', target: 'D' },
      ],
    };
    const cm = {
      coords: {
        A: { x: 100, y: 200, w: 100, h: 80 },
        B: { x: 300, y: 210, w: 50, h: 50 },   // cy 235 vs A cy 240 — near
        C: { x: 450, y: 195, w: 100, h: 80 },  // cy 235 — near
        D: { x: 300, y: 60, w: 100, h: 80 },   // cy 100 — distant branch
      },
      laneCoords: { L1: { x: 0, y: 40, w: 800, h: 300 } },
      edgeCoords: {
        eAB: [P(200, 240), P(200, 235), P(300, 235)],
        eBC: [P(350, 235), P(450, 235)],
        eAD: [P(150, 200), P(150, 100), P(300, 100)],
      },
    };
    const dCyBefore = cyOf(cm.coords.D);
    const { moved, seeded } = alignSameLaneChains(cm, lc);
    expect(moved.length).toBeGreaterThan(0);
    expect(Math.abs(cyOf(cm.coords.A) - cyOf(cm.coords.B))).toBeLessThanOrEqual(1);
    expect(Math.abs(cyOf(cm.coords.B) - cyOf(cm.coords.C))).toBeLessThanOrEqual(1);
    expect(Math.abs(cyOf(cm.coords.D) - dCyBefore)).toBeLessThanOrEqual(1);
    expect(Math.abs(cyOf(cm.coords.D) - cyOf(cm.coords.A))).toBeGreaterThan(40);
    expect(seeded).toEqual(expect.arrayContaining(['eAB', 'eBC']));
    const ab = cm.edgeCoords.eAB;
    expect(ab).toHaveLength(2);
    expect(Math.abs(ab[0].y - ab[1].y)).toBeLessThanOrEqual(1);
    expect(ab[0].x).toBe(cm.coords.A.x + cm.coords.A.w);
    expect(ab[1].x).toBe(cm.coords.B.x);
  });

  test('back-edge is not treated as a forward chain link', () => {
    const lc = {
      id: 'P',
      nodes: [
        { id: 'join', type: 'exclusiveGateway', name: '', lane: 'L1' },
        { id: 'rework', type: 'userTask', name: 'Rework', lane: 'L1' },
        { id: 'main', type: 'userTask', name: 'Main', lane: 'L1' },
      ],
      lanes: [{ id: 'L1', name: 'Seller' }],
      edges: [
        { id: 'eFwd', source: 'join', target: 'main' },
        { id: 'eBack', source: 'rework', target: 'join' },
      ],
    };
    const cm = {
      coords: {
        join: { x: 200, y: 200, w: 50, h: 50 },
        main: { x: 400, y: 205, w: 100, h: 80 },
        rework: { x: 500, y: 60, w: 100, h: 80 },
      },
      laneCoords: { L1: { x: 0, y: 40, w: 700, h: 300 } },
      edgeCoords: {
        eFwd: [P(250, 225), P(400, 245)],
        eBack: [P(500, 100), P(225, 100), P(225, 200)],
      },
    };
    alignSameLaneChains(cm, lc);
    expect(Math.abs(cyOf(cm.coords.join) - cyOf(cm.coords.main))).toBeLessThanOrEqual(1);
    // Rework stays on its own row (only linked by back-edge → not in join↔main component via forward).
    expect(Math.abs(cyOf(cm.coords.rework) - cyOf(cm.coords.main))).toBeGreaterThan(40);
  });

  test('named XOR pair on a short forward path shares cy', () => {
    const lc = {
      id: 'P',
      nodes: [
        { id: 'GW_BU', type: 'exclusiveGateway', name: 'BU Approval needed?', lane: 'L1' },
        { id: 'join', type: 'exclusiveGateway', name: '', lane: 'L1' },
        { id: 'T2', type: 'userTask', name: 'Submit', lane: 'L1' },
        { id: 'GW_BUOut', type: 'exclusiveGateway', name: 'BU approved?', lane: 'L1' },
        { id: 'T3', type: 'userTask', name: 'Mark', lane: 'L1' },
      ],
      lanes: [{ id: 'L1', name: 'Seller' }],
      edges: [
        { id: 'e03', source: 'GW_BU', target: 'join' },
        { id: 'eJoin', source: 'join', target: 'T2' },
        { id: 'e05', source: 'T2', target: 'GW_BUOut' },
        { id: 'e06', source: 'GW_BUOut', target: 'T3' },
      ],
    };
    const cm = {
      coords: {
        GW_BU: { x: 500, y: 213, w: 50, h: 50 },      // cy 238
        join: { x: 750, y: 112.5, w: 50, h: 50 },     // cy 137.5
        T2: { x: 900, y: 98, w: 100, h: 80 },          // cy 138
        GW_BUOut: { x: 1100, y: 112.5, w: 50, h: 50 }, // cy 137.5
        T3: { x: 1300, y: 198, w: 100, h: 80 },        // cy 238 — off the GW↔GW path
      },
      laneCoords: { L1: { x: 0, y: 40, w: 2000, h: 300 } },
      edgeCoords: {},
    };
    alignSameLaneChains(cm, lc, { maxGatewayPathHops: 4 });
    expect(Math.abs(cyOf(cm.coords.GW_BU) - cyOf(cm.coords.GW_BUOut))).toBeLessThanOrEqual(1);
    expect(Math.abs(cyOf(cm.coords.T2) - cyOf(cm.coords.GW_BU))).toBeLessThanOrEqual(1);
    // T3 is only after GW_BUOut — peer path ends at GW_BUOut; T3 may stay or follow e06 H seed.
    // At minimum the two named diamonds agree.
  });

  test('disabled via opts.enabled false is a no-op', () => {
    const lc = {
      id: 'P',
      nodes: [
        { id: 'A', type: 'userTask', name: 'A', lane: 'L1' },
        { id: 'B', type: 'userTask', name: 'B', lane: 'L1' },
      ],
      lanes: [{ id: 'L1', name: 'L' }],
      edges: [{ id: 'e', source: 'A', target: 'B' }],
    };
    const cm = {
      coords: {
        A: { x: 0, y: 100, w: 100, h: 80 },
        B: { x: 200, y: 120, w: 100, h: 80 },
      },
      laneCoords: { L1: { x: 0, y: 0, w: 400, h: 300 } },
      edgeCoords: { e: [P(100, 140), P(200, 160)] },
    };
    const before = structuredClone(cm.coords);
    const out = alignSameLaneChains(cm, lc, { enabled: false });
    expect(out.moved).toEqual([]);
    expect(cm.coords).toEqual(before);
  });
});
