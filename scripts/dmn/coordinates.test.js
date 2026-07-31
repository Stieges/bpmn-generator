import { describe, test, expect } from '@jest/globals';

import { buildDmnDiagrams } from './coordinates.js';

describe('buildDmnDiagrams — hand-computed clip maths', () => {
  test('a straight requirement between a 180×80 decision and a 125×45 input data clips to the exact intersection on both borders', () => {
    // Raw ELK positions (before buildDmnDiagrams anchors the canvas at (0,0)):
    //   dec_A (Decision, 180×80)   at (0, 0)       -> centre (90, 40)
    //   in_B  (InputData, 125×45)  at (57.5, -82.5) -> centre (120, -60)
    // Requirement: in_B (source, required) -> dec_A (target, requiring).
    //
    // Direction dec_A-centre -> in_B-centre: d = (30, -100). This is the exact
    // worked example in dmn-external-ground-truth.md §D.13(a):
    //   halfW=90, halfH=40, tx=90/30=3, ty=40/100=0.4, t=min(3,0.4)=0.4
    //   point = centre + d*t = (90+12, 40-40) = (102, 0)   <- on dec_A's TOP edge
    // Direction in_B-centre -> dec_A-centre: d = (-30, 100).
    //   halfW=62.5, halfH=22.5, tx=62.5/30≈2.083, ty=22.5/100=0.225, t=0.225
    //   point = centre + d*t = (120-6.75, -60+22.5) = (113.25, -37.5)  <- on in_B's BOTTOM edge
    // Both values independently confirmed by executing clipStraight/clipToRect
    // (scripts/shared/geometry.js) against these exact numbers.
    //
    // buildDmnDiagrams then anchors the canvas at (0,0):
    //   minX = min(0, 57.5) = 0        -> dx = margin - 0 = 20
    //   minY = min(0, -82.5) = -82.5   -> dy = margin - (-82.5) = 20 + 82.5 = 102.5
    // (margin = DRD_SPACING.margin = 20, scripts/dmn/constants.js — confirmed by
    // scripts/dmn/constants.test.js's own literal assertion.)
    // Every coordinate below — node positions and clipped edge points alike —
    // shifts by this same (dx, dy) = (20, 102.5); translation does not change
    // the direction between two shapes, only where the result lands.
    const dc = {
      id: 'Definitions_clip', name: 'Clip check', namespace: 'urn:test',
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
        { id: 'in_B', x: 57.5, y: -82.5, width: 125, height: 45 },
      ],
    };

    const diagrams = buildDmnDiagrams(dc, laidOutGraph);
    expect(diagrams).toHaveLength(1);
    const { coordMap, size } = diagrams[0];

    expect(coordMap.coords.dec_A).toEqual({ x: 20, y: 102.5, w: 180, h: 80 });
    expect(coordMap.coords.in_B).toEqual({ x: 77.5, y: 20, w: 125, h: 45 });

    expect(coordMap.edgeCoords.req_1).toEqual([
      { x: 133.25, y: 65 },    // 113.25+20, -37.5+102.5 — on in_B's border (source)
      { x: 122, y: 102.5 },    // 102+20, 0+102.5        — on dec_A's border (target)
    ]);

    // Bounding box: width = 182.5 - 0 = 182.5, height = 80 - (-82.5) = 162.5.
    // size = bbox + 2×margin on each axis = 182.5+40, 162.5+40.
    expect(size).toEqual({ w: 222.5, h: 202.5 });
    expect(coordMap).not.toHaveProperty('edgeLabels');
  });
});

describe('buildDmnDiagrams — degenerate inputs', () => {
  test('zero nodes: empty coords/edgeCoords, size is exactly 2×margin on each axis', () => {
    const dc = { id: 'Definitions_empty', name: 'Empty', namespace: 'urn:test', nodes: [] };
    const laidOutGraph = { id: 'root', children: [] };
    const diagrams = buildDmnDiagrams(dc, laidOutGraph);
    expect(diagrams).toHaveLength(1);
    expect(diagrams[0].coordMap.coords).toEqual({});
    expect(diagrams[0].coordMap.edgeCoords).toEqual({});
    expect(diagrams[0].size).toEqual({ w: 40, h: 40 });
  });

  test('a single node: no edges, size equals the node itself plus 2×margin on each axis', () => {
    const dc = {
      id: 'Definitions_solo', name: 'Solo', namespace: 'urn:test',
      nodes: [{ id: 'dec_solo', type: 'decision', name: 'Solo' }],
    };
    const laidOutGraph = { id: 'root', children: [{ id: 'dec_solo', x: 40, y: 25, width: 180, height: 80 }] };
    const diagrams = buildDmnDiagrams(dc, laidOutGraph);
    const { coordMap, size } = diagrams[0];
    expect(Object.keys(coordMap.coords)).toEqual(['dec_solo']);
    expect(coordMap.edgeCoords).toEqual({});
    // bbox = the node itself, 180×80. dx = 20-40 = -20, dy = 20-25 = -5.
    expect(coordMap.coords.dec_solo).toEqual({ x: 20, y: 20, w: 180, h: 80 });
    expect(size).toEqual({ w: 220, h: 120 });
  });

  test('an isolated node (no requirements touching it) still contributes to the bounding box and gets no edge', () => {
    const dc = {
      id: 'Definitions_isolated', name: 'Isolated', namespace: 'urn:test',
      nodes: [
        { id: 'dec_A', type: 'decision', name: 'A' },
        { id: 'in_B', type: 'inputData', name: 'B' },
        { id: 'ks_C', type: 'knowledgeSource', name: 'C (isolated)' },
      ],
      requirements: [
        { id: 'req_1', type: 'information', source: 'in_B', target: 'dec_A' },
        // ks_C has no requirement at all.
      ],
    };
    const laidOutGraph = {
      id: 'root',
      children: [
        { id: 'dec_A', x: 0, y: 0, width: 180, height: 80 },
        { id: 'in_B', x: 300, y: 0, width: 125, height: 45 },
        { id: 'ks_C', x: 600, y: 200, width: 100, height: 63 },
      ],
    };
    const diagrams = buildDmnDiagrams(dc, laidOutGraph);
    const { coordMap, size } = diagrams[0];
    expect(Object.keys(coordMap.coords).sort()).toEqual(['dec_A', 'in_B', 'ks_C']);
    expect(Object.keys(coordMap.edgeCoords)).toEqual(['req_1']);
    expect(coordMap.edgeCoords.req_1).toHaveLength(2);
    // ks_C alone pushes the bounding box out to maxX=700, maxY=263:
    // minX=0, minY=0, maxX=max(180,425,700)=700, maxY=max(80,45,263)=263.
    // dx = 20-0 = 20, dy = 20-0 = 20.
    expect(coordMap.coords.ks_C).toEqual({ x: 620, y: 220, w: 100, h: 63 });
    expect(size).toEqual({ w: 740, h: 303 });
  });

  test('a degenerate ELK child with NaN/undefined dimensions does not poison the canvas and does not throw', () => {
    const dc = {
      id: 'Definitions_nan', name: 'NaN guard', namespace: 'urn:test',
      nodes: [
        { id: 'dec_A', type: 'decision', name: 'A' },
        { id: 'dec_bad', type: 'decision', name: 'Bad' },
      ],
      requirements: [
        { id: 'req_1', type: 'information', source: 'dec_bad', target: 'dec_A' },
      ],
    };
    const laidOutGraph = {
      id: 'root',
      children: [
        { id: 'dec_A', x: 0, y: 0, width: 180, height: 80 },
        // A degenerate ELK layout: NaN x, undefined y/width/height.
        { id: 'dec_bad', x: NaN, y: undefined, width: NaN, height: undefined },
      ],
    };

    expect(() => buildDmnDiagrams(dc, laidOutGraph)).not.toThrow();
    const diagrams = buildDmnDiagrams(dc, laidOutGraph);
    const { coordMap } = diagrams[0];

    // Every non-finite dimension degrades to 0, never NaN.
    expect(coordMap.coords.dec_bad.x).not.toBeNaN();
    expect(coordMap.coords.dec_bad.y).not.toBeNaN();
    expect(coordMap.coords.dec_bad.w).toBe(0);
    expect(coordMap.coords.dec_bad.h).toBe(0);
    // The edge touching the degenerate shape also stays finite (clipStraight
    // works off already-guarded coords, so no NaN can flow into edgeCoords).
    for (const pt of coordMap.edgeCoords.req_1) {
      expect(pt.x).not.toBeNaN();
      expect(pt.y).not.toBeNaN();
    }
  });

  test('absent children (undefined, not even an empty array) does not throw and yields empty coords', () => {
    const dc = { id: 'Definitions_absent', name: 'Absent children', namespace: 'urn:test', nodes: [] };
    const laidOutGraph = { id: 'root' }; // no `children` key at all
    expect(() => buildDmnDiagrams(dc, laidOutGraph)).not.toThrow();
    const diagrams = buildDmnDiagrams(dc, laidOutGraph);
    expect(diagrams[0].coordMap.coords).toEqual({});
    expect(diagrams[0].coordMap.edgeCoords).toEqual({});
    expect(diagrams[0].size).toEqual({ w: 40, h: 40 });
  });
});

describe('buildDmnDiagrams — every node/requirement kind from the reference fixture', () => {
  test('all 5 node types and all 3 requirement types produce a coordinate for every node and an edge for every requirement', () => {
    // Mirrors tests/fixtures/dmn/discount-decision.json's node/requirement shape
    // (not the file itself — that fixture carries decisionTable content this
    // module never reads; only ids/types/requirements matter here). Positions
    // are a hand-placed grid, not run through ELK — Task 6's pipeline test is
    // where the real decisionCoreToElk/runDmnElkLayout wiring gets exercised.
    const dc = {
      id: 'Definitions_discount', name: 'Discount decision', namespace: 'urn:test',
      nodes: [
        { id: 'in_orderValue', type: 'inputData', name: 'Order value' },
        { id: 'in_customerSince', type: 'inputData', name: 'Customer since' },
        { id: 'ks_discountPolicy', type: 'knowledgeSource', name: 'Discount policy' },
        { id: 'bkm_loyaltyBonus', type: 'businessKnowledgeModel', name: 'Loyalty bonus' },
        { id: 'dec_discountLevel', type: 'decision', name: 'Discount level' },
        { id: 'dec_finalPercentage', type: 'decision', name: 'Final percentage' },
      ],
      requirements: [
        { id: 'ir_1', type: 'information', source: 'in_orderValue', target: 'dec_discountLevel' },
        { id: 'ir_2', type: 'information', source: 'dec_discountLevel', target: 'dec_finalPercentage' },
        { id: 'ir_3', type: 'information', source: 'in_customerSince', target: 'dec_finalPercentage' },
        { id: 'kr_1', type: 'knowledge', source: 'bkm_loyaltyBonus', target: 'dec_finalPercentage' },
        { id: 'ar_1', type: 'authority', source: 'ks_discountPolicy', target: 'dec_discountLevel' },
      ],
    };
    const laidOutGraph = {
      id: 'root',
      children: [
        { id: 'in_orderValue', x: 0, y: 400, width: 125, height: 45 },
        { id: 'in_customerSince', x: 200, y: 400, width: 125, height: 45 },
        { id: 'ks_discountPolicy', x: 400, y: 400, width: 100, height: 63 },
        { id: 'bkm_loyaltyBonus', x: 600, y: 400, width: 135, height: 46 },
        { id: 'dec_discountLevel', x: 0, y: 200, width: 180, height: 80 },
        { id: 'dec_finalPercentage', x: 300, y: 0, width: 180, height: 80 },
      ],
    };

    const diagrams = buildDmnDiagrams(dc, laidOutGraph);
    expect(diagrams).toHaveLength(1);
    const { coordMap } = diagrams[0];
    expect(Object.keys(coordMap.coords).sort()).toEqual(dc.nodes.map(n => n.id).sort());
    expect(Object.keys(coordMap.edgeCoords).sort()).toEqual(['ar_1', 'ir_1', 'ir_2', 'ir_3', 'kr_1']);
    for (const pts of Object.values(coordMap.edgeCoords)) {
      expect(pts).toHaveLength(2);
      for (const p of pts) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    }
    expect(coordMap).not.toHaveProperty('edgeLabels');
  });
});
