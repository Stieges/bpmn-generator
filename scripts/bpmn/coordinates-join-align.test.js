/**
 * Fence for alignMultiInJoins — converging XOR snaps to mid-rank of incomings
 * (just right of the middle branch), not the lowest ELK parking spot.
 */
import { describe, test, expect } from '@jest/globals';
import { alignMultiInJoins } from './coordinates.js';

const cyOf = (b) => b.y + b.h / 2;

describe('alignMultiInJoins', () => {
  test('three-in join snaps to median incoming (Narrate mid between Blank and Lock)', () => {
    const lc = {
      id: 'P',
      nodes: [
        { id: 'blank', type: 'userTask', name: 'Blank', lane: 'L1' },
        { id: 'narrate', type: 'userTask', name: 'Narrate', lane: 'L1' },
        { id: 'lock', type: 'userTask', name: 'Lock', lane: 'L1' },
        { id: 'join', type: 'exclusiveGateway', name: '', lane: 'L1' },
        { id: 'next', type: 'userTask', name: 'Next', lane: 'L1' },
      ],
      lanes: [{ id: 'L1', name: 'Lane' }],
      edges: [
        { id: 'eBlank', source: 'blank', target: 'join' },
        { id: 'eNarrate', source: 'narrate', target: 'join' },
        { id: 'eLock', source: 'lock', target: 'join' },
        { id: 'eOut', source: 'join', target: 'next' },
      ],
    };
    const cm = {
      coords: {
        blank: { x: 100, y: 100, w: 100, h: 80 },     // cy 140
        narrate: { x: 100, y: 300, w: 100, h: 80 },   // cy 340 — mid
        lock: { x: 100, y: 500, w: 100, h: 80 },      // cy 540
        join: { x: 350, y: 515, w: 50, h: 50 },       // cy 540 — parked on Lock
        next: { x: 500, y: 300, w: 100, h: 80 },      // cy 340 — spine
      },
      laneCoords: { L1: { x: 0, y: 40, w: 800, h: 600 } },
      edgeCoords: {
        eBlank: [{ x: 200, y: 140 }, { x: 350, y: 540 }],
        eNarrate: [{ x: 200, y: 340 }, { x: 350, y: 540 }],
        eLock: [{ x: 200, y: 540 }, { x: 350, y: 540 }],
        eOut: [{ x: 400, y: 540 }, { x: 500, y: 340 }],
      },
    };
    const { moved } = alignMultiInJoins(cm, lc);
    expect(moved).toEqual(['join']);
    expect(Math.abs(cyOf(cm.coords.join) - cyOf(cm.coords.narrate))).toBeLessThanOrEqual(1);
    // Out near median → refine to next's cy (same as narrate here).
    expect(Math.abs(cyOf(cm.coords.join) - cyOf(cm.coords.next))).toBeLessThanOrEqual(1);
    expect(cm.edgeCoords.eBlank).toBeUndefined();
    expect(cm.edgeCoords.eOut).toBeUndefined();
  });

  test('disabled via opts.enabled false is a no-op', () => {
    const lc = {
      id: 'P',
      nodes: [
        { id: 'A', type: 'userTask', name: 'A', lane: 'L1' },
        { id: 'B', type: 'userTask', name: 'B', lane: 'L1' },
        { id: 'join', type: 'exclusiveGateway', name: '', lane: 'L1' },
        { id: 'C', type: 'userTask', name: 'C', lane: 'L1' },
      ],
      lanes: [{ id: 'L1', name: 'L' }],
      edges: [
        { id: 'eA', source: 'A', target: 'join' },
        { id: 'eB', source: 'B', target: 'join' },
        { id: 'eOut', source: 'join', target: 'C' },
      ],
    };
    const cm = {
      coords: {
        A: { x: 0, y: 100, w: 100, h: 80 },
        B: { x: 0, y: 300, w: 100, h: 80 },
        join: { x: 200, y: 300, w: 50, h: 50 },
        C: { x: 400, y: 100, w: 100, h: 80 },
      },
      laneCoords: { L1: { x: 0, y: 0, w: 600, h: 400 } },
      edgeCoords: {},
    };
    const before = structuredClone(cm.coords);
    const out = alignMultiInJoins(cm, lc, { enabled: false });
    expect(out.moved).toEqual([]);
    expect(cm.coords).toEqual(before);
  });
});
