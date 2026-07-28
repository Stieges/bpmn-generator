/**
 * BPMN DI Integrity Check — post-layout sanity pass on the produced geometry.
 *
 * The rule engine (rules.js) reasons about the Logic-Core graph: it can prove a
 * process is sound and still say nothing about whether the diagram is readable,
 * because it never sees a coordinate. A layout defect therefore passes
 * validation green and only shows up when a human opens the .bpmn.
 *
 * This pass closes that gap. It checks the finished coordinate map for the
 * defects that make a diagram unusable regardless of how correct the semantics
 * are: participants stacked on top of each other, pools overlapping, nodes
 * sitting outside the pool they belong to.
 *
 * Findings are diagnostics, not rule violations — they are reported under
 * `diagnostics` in the pipeline result, separate from `validation`.
 */

const DEFAULT_TOLERANCE = 1;

/**
 * @param coordMap  result of buildCoordinateMap ({ coords, laneCoords, poolCoords, ... })
 * @param lc        Logic-Core
 * @param opts.tolerance  overlap slack in px (default 1) — abutting edges are fine
 * @returns { ok, issues: [{ code, severity, message, elements }] }
 */
function checkDiagramIntegrity(coordMap, lc, opts = {}) {
  const tol = opts.tolerance ?? DEFAULT_TOLERANCE;
  const issues = [];
  const { coords = {}, poolCoords = {}, laneCoords = {} } = coordMap || {};

  const participants = Object.entries(poolCoords)
    .filter(([id]) => id !== '_singlePool')
    .map(([id, c]) => ({ id, ...c }))
    .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));

  // DI01 — two participants at identical coordinates.
  // The cheapest possible regression guard: this is what an id collision or a
  // dropped x-offset looks like in the output.
  for (let i = 0; i < participants.length; i++) {
    for (let j = i + 1; j < participants.length; j++) {
      const a = participants[i], b = participants[j];
      if (Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol) {
        issues.push({
          code: 'DI01',
          severity: 'ERROR',
          message: `Participants "${a.id}" and "${b.id}" share the same position (${a.x}, ${a.y}).`,
          elements: [a.id, b.id],
        });
      }
    }
  }

  // DI02 — participant shapes overlapping each other.
  for (let i = 0; i < participants.length; i++) {
    for (let j = i + 1; j < participants.length; j++) {
      const a = participants[i], b = participants[j];
      if (issues.some(x => x.code === 'DI01' && x.elements.includes(a.id) && x.elements.includes(b.id))) continue;
      const ov = overlapArea(a, b, tol);
      if (ov > 0) {
        issues.push({
          code: 'DI02',
          severity: 'ERROR',
          message: `Participants "${a.id}" and "${b.id}" overlap by ${Math.round(ov)} px².`,
          elements: [a.id, b.id],
        });
      }
    }
  }

  // DI03 — a node sitting outside the participant it belongs to.
  for (const proc of (lc.pools || [lc])) {
    // '_singlePool' is the key used when a laned process is laid out standalone
    const pc = poolCoords[proc.id] || poolCoords['_singlePool'];
    if (!pc || !Number.isFinite(pc.x)) continue;
    for (const node of flattenNodes(proc.nodes)) {
      const nc = coords[node.id];
      if (!nc || !Number.isFinite(nc.x)) continue;
      if (!contains(pc, nc, tol)) {
        issues.push({
          code: 'DI03',
          severity: 'ERROR',
          message: `Node "${node.id}" lies outside its participant "${proc.id}".`,
          elements: [node.id, proc.id],
        });
      }
    }
  }

  // DI04 — lane bands overlapping inside a participant.
  // The vertical axis is ours, not ELK's (coordinates.js §5.0a): if two bands
  // intersect, a node's lane can no longer be read off the diagram.
  for (const proc of (lc.pools || [lc])) {
    const bands = (proc.lanes || [])
      .map(l => ({ id: l.id, ...laneCoords[l.id] }))
      .filter(b => Number.isFinite(b.x) && Number.isFinite(b.y));
    for (let i = 0; i < bands.length; i++) {
      for (let j = i + 1; j < bands.length; j++) {
        if (overlapArea(bands[i], bands[j], tol) > 0) {
          issues.push({
            code: 'DI04',
            severity: 'ERROR',
            message: `Lanes "${bands[i].id}" and "${bands[j].id}" overlap in participant "${proc.id}".`,
            elements: [bands[i].id, bands[j].id],
          });
        }
      }
    }
  }

  return { ok: issues.length === 0, issues };
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

function flattenNodes(nodes) {
  const out = [];
  for (const n of nodes || []) {
    out.push(n);
    if (n.nodes) out.push(...flattenNodes(n.nodes));
  }
  return out;
}

export { checkDiagramIntegrity };
