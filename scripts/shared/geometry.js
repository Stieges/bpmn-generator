/**
 * Straight-line shape clipping — shared between notations.
 *
 * Lives in shared/, not bpmn/, because a second notation (DMN's DRD) now needs it too: DMN
 * requirement connections (information/knowledge/authority) are, like a BPMN Association, unstyled
 * straight lines between two shape borders — no orthogonal routing. shared/ takes what a second
 * notation demonstrably imports, not everything that could be phrased format-independently; see
 * docs/superpowers/specs/2026-07-31-dmn-drd-and-serialisation-design.md, "Where the boundary
 * actually runs, and why it leaves pure code behind", for the full argument. The three
 * orthogonal-routing helpers (clipOrthogonal and its BPMN-shape-specific siblings) stay in
 * scripts/bpmn/coordinates.js — see the comment there for why they did not travel with these two.
 *
 * Moved verbatim from scripts/bpmn/coordinates.js (lines 777-795), where they were private. Pure
 * functions, no config, no notation knowledge — every coordinate here is `{x,y,w,h}` or `{x,y}`,
 * never `{x,y,width,height}` (that shape is DI-only; see CLAUDE.md's Conventions section).
 */

/**
 * Straight connection between two shapes, clipped to both borders.
 * Associations are drawn as straight lines in BPMN, so this is a plain
 * centre-to-centre segment cut back to where it meets each rectangle.
 */
export function clipStraight(a, b) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  return [clipToRect(ac, bc, a), clipToRect(bc, ac, b)];
}

/** Move `from` (a shape centre) onto the border of `rect`, along from→towards. */
export function clipToRect(from, towards, rect) {
  const dx = towards.x - from.x;
  const dy = towards.y - from.y;
  if (dx === 0 && dy === 0) return { x: from.x, y: from.y };
  const halfW = rect.w / 2;
  const halfH = rect.h / 2;
  const scale = Math.min(
    dx === 0 ? Infinity : halfW / Math.abs(dx),
    dy === 0 ? Infinity : halfH / Math.abs(dy),
  );
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}
