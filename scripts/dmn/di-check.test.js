import { describe, test, expect } from '@jest/globals';

import { checkDmnDiagramIntegrity } from './di-check.js';
import { buildDmnDiagrams } from './coordinates.js';

describe('checkDmnDiagramIntegrity — ok semantics', () => {
  test('no diagrams: ok true, no issues', () => {
    expect(checkDmnDiagramIntegrity([])).toEqual({ ok: true, issues: [] });
  });

  test('a clean single-shape diagram: ok true, no issues', () => {
    const diagrams = [{
      id: 'DMNDiagram_1', name: '', size: { w: 300, h: 200 },
      coordMap: { coords: { dec_A: { x: 60, y: 60, w: 180, h: 80 } }, edgeCoords: {} },
    }];
    expect(checkDmnDiagramIntegrity(diagrams)).toEqual({ ok: true, issues: [] });
  });
});

describe('checkDmnDiagramIntegrity — one firing test per code', () => {
  test('DD01: two shapes that overlap', () => {
    const diagrams = [{
      id: 'DMNDiagram_1', name: '', size: { w: 300, h: 200 },
      coordMap: {
        coords: {
          a: { x: 0, y: 0, w: 100, h: 50 },
          b: { x: 50, y: 0, w: 100, h: 50 },
        },
        edgeCoords: {},
      },
    }];
    const result = checkDmnDiagramIntegrity(diagrams);
    expect(result.ok).toBe(false);
    // Overlap: w = min(100,150)-max(0,50)-1 = 49; h = min(50,50)-max(0,0)-1 = 49 -> 49*49 = 2401 px².
    expect(result.issues).toEqual([{
      code: 'DD01', severity: 'ERROR',
      message: "Shapes \"a\" and \"b\" overlap by 2401 px² in diagram \"DMNDiagram_1\".",
      elementId: 'a,b',
    }]);
  });

  test("DD02: a shape outside the diagram's declared bounds", () => {
    const diagrams = [{
      id: 'DMNDiagram_1', name: '', size: { w: 100, h: 100 },
      coordMap: {
        coords: { far: { x: 150, y: 10, w: 50, h: 50 } },
        edgeCoords: {},
      },
    }];
    const result = checkDmnDiagramIntegrity(diagrams);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([{
      code: 'DD02', severity: 'ERROR',
      message: "Shape \"far\" lies outside diagram \"DMNDiagram_1\"'s bounds (100×100).",
      elementId: 'far',
    }]);
  });

  test("DD03: an edge endpoint that does not sit on any shape's boundary", () => {
    const diagrams = [{
      id: 'DMNDiagram_1', name: '', size: { w: 300, h: 300 },
      coordMap: {
        coords: { dec_T: { x: 0, y: 0, w: 180, h: 80 } },
        // point 0 sits exactly on dec_T's left edge (x=0, within its y-range);
        // point 1 floats in space, touching nothing.
        edgeCoords: { req_x: [{ x: 0, y: 40 }, { x: 200, y: 200 }] },
      },
    }];
    const result = checkDmnDiagramIntegrity(diagrams);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([{
      code: 'DD03', severity: 'ERROR',
      message: "Requirement \"req_x\" has an endpoint that does not sit on any shape's boundary in diagram \"DMNDiagram_1\".",
      elementId: 'req_x',
    }]);
  });
});

describe('checkDmnDiagramIntegrity — a fourth code was deliberately dropped', () => {
  test('only DD01, DD02, DD03 ever appear — no DD04', () => {
    // Guards against a code silently reappearing; see the design spec's
    // "Three codes, not four" decision. Two identical, fully overlapping,
    // oversized shapes trip both remaining shape-level codes at once.
    const diagrams = [{
      id: 'DMNDiagram_1', name: '', size: { w: 10, h: 10 },
      coordMap: {
        coords: { a: { x: 0, y: 0, w: 20, h: 20 }, b: { x: 0, y: 0, w: 20, h: 20 } },
        edgeCoords: {},
      },
    }];
    const result = checkDmnDiagramIntegrity(diagrams);
    expect(result.issues.length).toBeGreaterThan(0);
    for (const issue of result.issues) {
      expect(['DD01', 'DD02', 'DD03']).toContain(issue.code);
    }
  });
});

describe('checkDmnDiagramIntegrity — multi-diagram generality', () => {
  test("two hand-built diagrams: each is checked against its own bounds, not the other's", () => {
    // The schema has no multi-view input yet (DMNDiagram is maxOccurs="unbounded"
    // in the DMNDI XSD, but nothing produces more than one today) — built by
    // hand to prove the per-diagram loop actually scopes correctly, not just
    // that it runs once.
    const diagrams = [
      {
        id: 'D1', name: 'First', size: { w: 300, h: 300 },
        coordMap: { coords: { a: { x: 10, y: 10, w: 50, h: 50 } }, edgeCoords: {} },
      },
      {
        id: 'D2', name: 'Second', size: { w: 300, h: 300 },
        coordMap: { coords: { b: { x: 400, y: 10, w: 50, h: 50 } }, edgeCoords: {} },
      },
    ];
    const result = checkDmnDiagramIntegrity(diagrams);
    expect(result.ok).toBe(false);
    // Only D2's shape is out of bounds; D1's shape must not be flagged, and
    // D2's shape must not be checked against D1's (larger) bounds either.
    expect(result.issues).toEqual([{
      code: 'DD02', severity: 'ERROR',
      message: "Shape \"b\" lies outside diagram \"D2\"'s bounds (300×300).",
      elementId: 'b',
    }]);
  });
});

describe('checkDmnDiagramIntegrity — wired to buildDmnDiagrams', () => {
  test('a well-formed diagram built by buildDmnDiagrams reports no diagnostics', () => {
    const dc = {
      id: 'Definitions_wired', name: 'Wired', namespace: 'urn:test',
      nodes: [
        { id: 'dec_A', type: 'decision', name: 'A' },
        { id: 'in_B', type: 'inputData', name: 'B' },
      ],
      requirements: [
        { id: 'req_1', type: 'information', source: 'in_B', target: 'dec_A' },
      ],
    };
    const laidOutGraph = {
      id: 'root',
      children: [
        { id: 'dec_A', x: 0, y: 0, width: 180, height: 80 },
        { id: 'in_B', x: 300, y: 0, width: 125, height: 45 },
      ],
    };
    const diagrams = buildDmnDiagrams(dc, laidOutGraph);
    expect(checkDmnDiagramIntegrity(diagrams)).toEqual({ ok: true, issues: [] });
  });
});
