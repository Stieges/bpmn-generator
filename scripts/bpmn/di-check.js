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
 * sitting outside the pool they belong to, a sequence-flow arrow that no
 * longer starts or ends on the shape it's attached to, a sequence flow
 * whose first or last segment lies on its own endpoint's outline, and a
 * message flow running through a shape that is not one of its endpoints.
 *
 * Findings are diagnostics, not rule violations — they are reported under
 * `diagnostics` in the pipeline result, separate from `validation`.
 */

const DEFAULT_TOLERANCE = 1;
const ALONG_MIN_PX = 5; // bpmn-js arrowhead length — see DI08

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

  // DI06 — a child of an expanded subprocess outside its parent's box.
  // DI03 only knows participants, so a subprocess whose children stayed behind
  // when the parent moved passed the check while rendering a lane band away.
  for (const proc of (lc.pools || [lc])) {
    for (const parent of flattenNodes(proc.nodes)) {
      if (!parent.isExpanded || !parent.nodes?.length) continue;
      const pc = coords[parent.id];
      if (!pc || !Number.isFinite(pc.x)) continue;
      for (const child of flattenNodes(parent.nodes)) {
        const cc = coords[child.id];
        if (!cc || !Number.isFinite(cc.x)) continue;
        if (!contains(pc, cc, tol)) {
          issues.push({
            code: 'DI06',
            severity: 'ERROR',
            message: `Node "${child.id}" lies outside its expanded subprocess "${parent.id}".`,
            elements: [child.id, parent.id],
          });
        }
      }
    }
  }

  // DI07 — a sequence-flow endpoint not sitting on its own node's shape.
  // This is the invariant a geometry pass has to preserve and the one that
  // slipped: a pass that moves a node without moving the edge attached to it
  // (or the reverse) leaves an arrow that visibly starts or ends in mid-air.
  // Sequence flows only — message flows and associations live outside
  // proc.edges and are covered by DI05 / the geometry-contract tests instead.
  for (const proc of (lc.pools || [lc])) {
    for (const edge of flattenEdges(proc)) {
      const pts = (coordMap.edgeCoords || {})[edge.id];
      if (!pts || pts.length < 2) continue;
      const srcC = coords[edge.source];
      const tgtC = coords[edge.target];
      if (srcC && Number.isFinite(srcC.x) && !touchesShape(srcC, pts[0], tol)) {
        issues.push({
          code: 'DI07',
          severity: 'ERROR',
          message: `Sequence flow "${edge.id}" does not start on its source "${edge.source}".`,
          elements: [edge.id, edge.source],
        });
      }
      const last = pts[pts.length - 1];
      if (tgtC && Number.isFinite(tgtC.x) && !touchesShape(tgtC, last, tol)) {
        issues.push({
          code: 'DI07',
          severity: 'ERROR',
          message: `Sequence flow "${edge.id}" does not end on its target "${edge.target}".`,
          elements: [edge.id, edge.target],
        });
      }
    }
  }

  // DI08 — a sequence flow's first or last segment lies on its own endpoint's outline (#52).
  // WARNING: the edge is attached (DI07 holds) and the model is fine, but the line covers the
  // shape's border and the arrowhead sits on it. Counted only beyond 5 px — bpmn-js's arrowhead
  // length (marker 'M 1 5 L 11 10 L 1 15 Z' at scale 0.5), shorter overlap hides under it — with
  // ±tol collinearity, the same definition as scripts/bench/layout-metrics.mjs's
  // edgeEndsAlongBorder, restated because this pass is dependency-free by design. For a circle or
  // a diamond the side is a tangent of its bounds; the line still visibly misses the shape.
  for (const proc of (lc.pools || [lc])) {
    for (const edge of flattenEdges(proc)) {
      const segs = nonZeroSegments((coordMap.edgeCoords || {})[edge.id] || []);
      if (!segs.length) continue;
      const ends = [['starts', segs[0], edge.source], ['ends', segs[segs.length - 1], edge.target]];
      for (const [verb, seg, nodeId] of ends) {
        const box = coords[nodeId];
        if (!box || !Number.isFinite(box.x)) continue;
        const { side, length } = alongSide(seg, box, tol);
        if (length > ALONG_MIN_PX) {
          issues.push({
            code: 'DI08',
            severity: 'WARNING',
            message: `Sequence flow "${edge.id}" ${verb} along the ${side} side of "${nodeId}" for ${Math.round(length)} px.`,
            elements: [edge.id, nodeId],
          });
        }
      }
    }
  }

  // DI09 — a sequence flow running through its own source or target shape (owner decision 3).
  // Every other check exempts an edge's own endpoints; this one is about exactly them. WARNING:
  // the flow is attached, but it visibly starts or ends somewhere else. The shape is the drawn
  // one — a circle for an event, a rhombus for a gateway (type-name suffix: this pass is
  // dependency-free by design), the box for everything else; 1 px inset.
  // Axis-parallel segments only: segmentEntersShape's nearest-point maths holds for those alone (a
  // diagonal would be judged by its bounding box). The pipeline routes every sequence flow
  // orthogonally; a diagonal one is hand-made or detached, and the detached case is DI07's.
  const typeOfNode = {};
  for (const proc of (lc.pools || [lc])) for (const n of flattenNodes(proc.nodes)) typeOfNode[n.id] = n.type;
  const shapeOfNode = (id) => (/Event$/.test(typeOfNode[id] || '') ? 'circle'
    : /Gateway$/.test(typeOfNode[id] || '') ? 'diamond' : 'rect');
  for (const proc of (lc.pools || [lc])) {
    for (const edge of flattenEdges(proc)) {
      const segs = nonZeroSegments((coordMap.edgeCoords || {})[edge.id] || [])
        .filter(([a, z]) => Math.abs(a.x - z.x) < 1e-6 || Math.abs(a.y - z.y) < 1e-6);
      if (!segs.length) continue;
      for (const [role, nodeId] of [['source', edge.source], ['target', edge.target]]) {
        const box = coords[nodeId];
        if (!box || !Number.isFinite(box.x)) continue;
        if (!segs.some(s => segmentEntersShape(s, box, shapeOfNode(nodeId)))) continue;
        issues.push({
          code: 'DI09',
          severity: 'WARNING',
          message: `Sequence flow "${edge.id}" runs through its own ${role} "${nodeId}".`,
          elements: [edge.id, nodeId],
        });
      }
    }
  }

  // DI05 — a message flow crossing a participant it does not involve.
  // WARNING, not ERROR: with a communication cycle across three or more
  // participants a linear stack cannot avoid it, so this reports rather than
  // blocks. It is the metric that shows whether the participant ordering
  // (topology.js) did its job.
  const participantOf = {};
  for (const proc of (lc.pools || [])) {
    for (const n of (proc.nodes || [])) participantOf[n.id] = proc.id;
  }
  for (const p of participants) participantOf[p.id] ??= p.id;

  for (const mf of (lc.messageFlows || [])) {
    const pts = (coordMap.edgeCoords || {})[mf.id || `mf_${mf.source}_${mf.target}`];
    if (!pts || pts.length < 2) continue;
    const involved = new Set([participantOf[mf.source], participantOf[mf.target]]);
    const ys = pts.map(p => p.y);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const crossed = participants
      .filter(p => !involved.has(p.id) && p.y > lo + tol && p.y + p.h < hi - tol)
      .map(p => p.id);
    if (crossed.length) {
      issues.push({
        code: 'DI05',
        severity: 'WARNING',
        message: `Message flow "${mf.id}" crosses uninvolved participant(s): ${crossed.join(', ')}.`,
        elements: [mf.id, ...crossed],
      });
    }
  }

  // DI10 — a message flow running through a shape that is not one of its endpoints.
  // WARNING: the flow is attached and the model is fine, but the line reads as touching a task it
  // has nothing to do with. Not counted: a group (drawn to be overlapped) and a box containing an
  // endpoint (the expanded subprocess a flow starts or ends in — unavoidable). Interior hits only,
  // 1 px inset, the definition of scripts/bench/layout-metrics.mjs's messageFlowThroughNodes.
  for (const mf of (lc.messageFlows || [])) {
    const id = mf.id || `mf_${mf.source}_${mf.target}`;
    const segs = nonZeroSegments((coordMap.edgeCoords || {})[id] || []);
    if (!segs.length) continue;
    const src = coords[mf.source], tgt = coords[mf.target];
    for (const [nodeId, b] of Object.entries(coords)) {
      if (nodeId === mf.source || nodeId === mf.target || typeOfNode[nodeId] === 'group') continue;
      if ((src && contains(b, src, 0)) || (tgt && contains(b, tgt, 0))) continue;
      const hit = segs.some(([a, z]) => Math.max(a.x, z.x) > b.x + 1 && Math.min(a.x, z.x) < b.x + b.w - 1
        && Math.max(a.y, z.y) > b.y + 1 && Math.min(a.y, z.y) < b.y + b.h - 1);
      if (hit) {
        issues.push({ code: 'DI10', severity: 'WARNING',
          message: `Message flow "${id}" runs through "${nodeId}".`, elements: [id, nodeId] });
      }
    }
  }

  // `ok` means "no blocking geometry defect" — warnings are reported but do not
  // fail the gate.
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

function flattenNodes(nodes) {
  const out = [];
  for (const n of nodes || []) {
    out.push(n);
    if (n.nodes) out.push(...flattenNodes(n.nodes));
  }
  return out;
}

// Sequence flows, including ones nested inside an expanded subprocess.
// Deliberately local rather than imported from coordinates.js — di-check.js
// is a dependency-free post-layout sanity pass by design.
function flattenEdges(proc) {
  const out = [...(proc.edges || [])];
  for (const n of flattenNodes(proc.nodes)) {
    if (n.edges) out.push(...n.edges);
  }
  return out;
}

function touchesShape(box, pt, tol) {
  return contains(box, { x: pt.x, y: pt.y, w: 0, h: 0 }, tol);
}

function nonZeroSegments(pts) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) continue;
    out.push([a, b]);
  }
  return out;
}

function overlap1d(a0, a1, b0, b1) {
  return Math.max(0, Math.min(Math.max(a0, a1), b1) - Math.max(Math.min(a0, a1), b0));
}

/** Longest stretch a segment runs collinear (±tol) with one side of `box`, and which side. */
function alongSide([a, b], box, tol) {
  let best = { side: null, length: 0 };
  const consider = (side, length) => { if (length > best.length) best = { side, length }; };
  if (Math.abs(a.x - b.x) <= tol) {
    if (Math.abs(a.x - box.x) <= tol) consider('left', overlap1d(a.y, b.y, box.y, box.y + box.h));
    if (Math.abs(a.x - (box.x + box.w)) <= tol) consider('right', overlap1d(a.y, b.y, box.y, box.y + box.h));
  }
  if (Math.abs(a.y - b.y) <= tol) {
    if (Math.abs(a.y - box.y) <= tol) consider('top', overlap1d(a.x, b.x, box.x, box.x + box.w));
    if (Math.abs(a.y - (box.y + box.h)) <= tol) consider('bottom', overlap1d(a.x, b.x, box.x, box.x + box.w));
  }
  return best;
}

/** Does an axis-parallel segment enter the drawn shape's interior? Same maths as
 *  scripts/bench/layout-metrics.mjs's segmentEntersShape. */
function segmentEntersShape([a, z], box, shape) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const nx = Math.max(Math.min(a.x, z.x), Math.min(Math.max(a.x, z.x), cx));
  const ny = Math.max(Math.min(a.y, z.y), Math.min(Math.max(a.y, z.y), cy));
  if (shape === 'circle') return Math.hypot(nx - cx, ny - cy) < box.w / 2 - 1;
  if (shape === 'diamond') return Math.abs(nx - cx) / (box.w / 2) + Math.abs(ny - cy) / (box.h / 2) < 1 - 2 / Math.min(box.w, box.h);
  return Math.max(a.x, z.x) > box.x + 1 && Math.min(a.x, z.x) < box.x + box.w - 1
      && Math.max(a.y, z.y) > box.y + 1 && Math.min(a.y, z.y) < box.y + box.h - 1;
}

export { checkDiagramIntegrity };

