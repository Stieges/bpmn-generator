/**
 * DMN DRD Integrity Check — post-layout geometry pass, mirroring
 * scripts/bpmn/di-check.js's role and result shape for a DRD instead of a
 * BPMN diagram. Own code namespace (DD01-DD03) so the two can appear side by
 * side in one API response.
 *
 * Three codes, not four: a fourth ("two shapes at an identical position",
 * BPMN's DI01) was drafted and dropped — no DRD layout observed so far
 * produces that specific defect without also tripping DD01 (overlap), so a
 * code nobody can name a trigger for was not added. Do not reintroduce one.
 *
 * Deliberately does NOT import from scripts/bpmn/di-check.js: dmn/ importing
 * from bpmn/ would reintroduce exactly the asymmetry the modular restructure
 * removed. overlapArea/contains below are format-agnostic and could in
 * principle live in shared/, but shared/ takes what a second notation
 * demonstrably imports, not everything that could be phrased that way — so
 * they stay local until a third notation actually needs them (the same rule
 * scripts/shared/geometry.js's header comment states for clipStraight/clipToRect).
 *
 * Findings are diagnostics, not rule violations: they belong in
 * result.diagnostics, never in result.validation (Task 6 wires this up).
 */

const DEFAULT_TOLERANCE = 1;

/**
 * @param {Array<{ id: string, name: string, size: {w:number,h:number}, coordMap: { coords: object, edgeCoords: object } }>} diagrams
 * @returns {{ ok: boolean, issues: Array<{ code: string, severity: string, message: string, elementId: string }> }}
 */
export function checkDmnDiagramIntegrity(diagrams) {
  const list = diagrams || [];
  const issues = [];

  for (const diagram of list) {
    const { coords = {}, edgeCoords = {} } = diagram.coordMap || {};
    const shapes = Object.entries(coords).map(([id, c]) => ({ id, ...c }));

    // DD01 — overlapping shapes.
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        const a = shapes[i], b = shapes[j];
        const ov = overlapArea(a, b, DEFAULT_TOLERANCE);
        if (ov > 0) {
          issues.push({
            code: 'DD01',
            severity: 'ERROR',
            message: `Shapes "${a.id}" and "${b.id}" overlap by ${Math.round(ov)} px² in diagram "${diagram.id}".`,
            elementId: `${a.id},${b.id}`,
          });
        }
      }
    }

    // DD02 — a shape outside the diagram's declared canvas. `size` (a
    // dc:Dimension: width/height only, no x/y) anchors the canvas at (0,0);
    // buildDmnDiagrams shifts every shape to make that true for its own
    // output — this check does not assume that, it independently verifies it.
    const bounds = { x: 0, y: 0, w: diagram.size?.w ?? 0, h: diagram.size?.h ?? 0 };
    for (const s of shapes) {
      if (!contains(bounds, s, DEFAULT_TOLERANCE)) {
        issues.push({
          code: 'DD02',
          severity: 'ERROR',
          message: `Shape "${s.id}" lies outside diagram "${diagram.id}"'s bounds (${bounds.w}×${bounds.h}).`,
          elementId: s.id,
        });
      }
    }

    // DD03 — an edge endpoint that does not sit on any shape's boundary.
    // checkDmnDiagramIntegrity only receives the diagram, not the
    // Decision-Core, so it cannot know which shape is a given requirement's
    // source/target specifically — it checks the weaker but still sound
    // invariant that both of a straight edge's endpoints touch *some*
    // shape's border, which is exactly what a correct clip must produce.
    for (const [reqId, pts] of Object.entries(edgeCoords)) {
      if (!Array.isArray(pts) || pts.length < 2) continue;
      const endpoints = [pts[0], pts[pts.length - 1]];
      const allOnSomeShape = endpoints.every(p => shapes.some(s => onBoundary(s, p, DEFAULT_TOLERANCE)));
      if (!allOnSomeShape) {
        issues.push({
          code: 'DD03',
          severity: 'ERROR',
          message: `Requirement "${reqId}" has an endpoint that does not sit on any shape's boundary in diagram "${diagram.id}".`,
          elementId: reqId,
        });
      }
    }
  }

  return { ok: !issues.some(i => i.severity === 'ERROR'), issues };
}

function overlapArea(a, b, tol) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) - tol;
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) - tol;
  return w > 0 && h > 0 ? w * h : 0;
}

function contains(outer, inner, tol) {
  return inner.x >= outer.x - tol
      && inner.y >= outer.y - tol
      && inner.x + inner.w <= outer.x + outer.w + tol
      && inner.y + inner.h <= outer.y + outer.h + tol;
}

function onBoundary(shape, p, tol) {
  const withinX = p.x >= shape.x - tol && p.x <= shape.x + shape.w + tol;
  const withinY = p.y >= shape.y - tol && p.y <= shape.y + shape.h + tol;
  if (!withinX || !withinY) return false;
  const onVerticalEdge = Math.abs(p.x - shape.x) <= tol || Math.abs(p.x - (shape.x + shape.w)) <= tol;
  const onHorizontalEdge = Math.abs(p.y - shape.y) <= tol || Math.abs(p.y - (shape.y + shape.h)) <= tol;
  return onVerticalEdge || onHorizontalEdge;
}
