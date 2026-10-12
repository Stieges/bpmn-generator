/**
 * BPMN SVG Generation — OMG BPMN 2.0 compliant visual rendering
 * Produces standalone SVG diagrams from coordinate maps.
 */

import { assignEdgeIds, resolveFlowSemantics } from './topology.js';
import { isEvent, isGateway, isActivity, isDataArtifact, nodeFieldSpec } from './types.js';
import { CLR, SW, SHAPE, LANE_HEADER_W, LANE_PADDING, TASK_RX, INNER_OUTER_GAP, EXTERNAL_LABEL_H } from './constants.js';
import { esc, rn, wrapText } from '../shared/utils.js';
import { edgeLabelBox, edgeLabelTextStyle, textAnnotationTextStyle } from './coordinates.js';

import {
  renderEventMarker, inferEventMarker, renderTaskIcon, renderPentagon,
  renderLoopMarker, renderMIParallelMarker, renderMISequentialMarker,
  renderSubProcessMarker, renderAdHocMarker, renderCompensationMarker,
} from './icons.js';

/**
 * Return the effective lane-header strip width for a pool, preferring
 * any dynamic value computed by visual-refinement over the default.
 * Falls back to '_singlePool' if the requested key isn't in poolCoords,
 * mirroring the lookup pattern in visual-refinement.js.
 */
function laneHeaderW(poolCoords, poolKey) {
  return poolCoords?.[poolKey]?.laneHeaderWidth
      ?? poolCoords?.['_singlePool']?.laneHeaderWidth
      ?? LANE_HEADER_W;
}

/**
 * Public entry: fills MISSING edge ids on the caller's object (in place, idempotent, deterministic via
 * `assignEdgeIds`); `runPipeline` instead works on a copy.
 */
function generateSvg(lc, coordMap) {
  // Public entry: complete any id-less edge so geometry, XML and SVG all key on the same id (#64).
  assignEdgeIds(lc);
  const { coords, laneCoords, poolCoords, edgeCoords, edgeLabels } = coordMap;
  const nodeLabels = coordMap.nodeLabels ?? {};
  const processes = lc.pools ? lc.pools : [lc];
  const allNodes  = processes.flatMap(p => p.nodes || []);
  const allLanes  = processes.flatMap(p => p.lanes || []);

  // Build lane-id → pool-key lookup for laneHeaderW resolution
  const laneToPoolKey = {};
  if (lc.pools) {
    for (const proc of lc.pools) {
      for (const lane of (proc.lanes || [])) laneToPoolKey[lane.id] = proc.id;
    }
  } else {
    for (const lane of allLanes) laneToPoolKey[lane.id] = '_singlePool';
  }

  // §7.1  Compute canvas bounds
  const PADDING = 50;
  const LABEL_CLEARANCE = 30; // Space for external labels below nodes
  const allPts = [
    ...Object.values(coords).flatMap(c => [
      { x: c.x, y: c.y },
      { x: c.x + c.w, y: c.y + c.h + LABEL_CLEARANCE },
    ]),
    ...Object.entries(laneCoords).flatMap(([lid, l]) => [
      { x: l.x - laneHeaderW(poolCoords, laneToPoolKey[lid]), y: l.y },
      { x: l.x + l.w, y: l.y + l.h },
    ]),
    ...Object.values(poolCoords).flatMap(p => [
      { x: p.x, y: p.y },
      { x: p.x + p.w, y: p.y + p.h },
    ]),
    ...Object.values(edgeCoords).flatMap(pts => pts),
    // A node label that moved off its default spot (nodeLabelsAvoidFlows) can lie beyond the shapes.
    ...Object.values(nodeLabels).flatMap(b => [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }]),
  ];
  if (!allPts.length)
    return `<svg xmlns="http://www.w3.org/2000/svg"><text y="20">No elements</text></svg>`;

  const minX = Math.min(...allPts.map(p => p.x)) - PADDING;
  const minY = Math.min(...allPts.map(p => p.y)) - PADDING;
  const maxX = Math.max(...allPts.map(p => p.x)) + PADDING;
  const maxY = Math.max(...allPts.map(p => p.y)) + PADDING;
  const W = maxX - minX;
  const H = maxY - minY;
  const tx = v => rn(v - minX);
  const ty = v => rn(v - minY);

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${rn(W)}" height="${rn(H)}" viewBox="0 0 ${rn(W)} ${rn(H)}" font-family="Arial, sans-serif">`);

  // The two source-end markers below have the geometry of bpmn-js 18.6.2's
  // 'conditional-default-flow-marker' (path M 6 4 L 10 16, ref 0/10) and 'conditional-flow-marker'
  // (path M 0 10 L 8 6 L 16 10 L 8 14 Z, ref -1/10), stroke 2, 10 units wide on a 2-wide line. A
  // marker scales with its line's stroke width, so ours gets the box that gives the same absolute
  // size on our line. The old slash had refX 6 — it sat on the source point, inside the gateway's
  // outline, and was barely visible (#85).
  const SRC_MARKER_BOX = rn(10 * 2 / SW.connection);

  // §7.2  SVG Defs — markers for all connection types
  out.push(`<defs>
  <!-- Sequence flow: filled triangle (OMG spec Fig 10.43) -->
  <marker id="seq-end" viewBox="0 0 20 20" refX="11" refY="10"
    markerWidth="10" markerHeight="10" orient="auto">
    <path d="M 1 5 L 11 10 L 1 15 Z" fill="${CLR.stroke}" stroke="${CLR.stroke}" stroke-width="1"/>
  </marker>
  <!-- Default flow: diagonal slash at source (OMG spec Fig 10.47) -->
  <marker id="seq-default-src" viewBox="0 0 20 20" refX="0" refY="10"
    markerWidth="${SRC_MARKER_BOX}" markerHeight="${SRC_MARKER_BOX}" orient="auto">
    <path d="M 6 4 L 10 16" fill="none" stroke="${CLR.stroke}" stroke-width="2" stroke-linecap="round"/>
  </marker>
  <!-- Conditional flow: open diamond at source (OMG spec Fig 10.48) -->
  <marker id="seq-conditional-src" viewBox="0 0 20 20" refX="-1" refY="10"
    markerWidth="${SRC_MARKER_BOX}" markerHeight="${SRC_MARKER_BOX}" orient="auto">
    <path d="M 0 10 L 8 6 L 16 10 L 8 14 Z" fill="${CLR.fill}" stroke="${CLR.stroke}" stroke-width="2" stroke-linejoin="round"/>
  </marker>
  <!-- Message flow: open circle at source (OMG spec Fig 9.5) -->
  <marker id="msg-start" viewBox="0 0 20 20" refX="6" refY="6"
    markerWidth="20" markerHeight="20" orient="auto">
    <circle cx="6" cy="6" r="3.5" fill="${CLR.fill}" stroke="${CLR.stroke}" stroke-width="1"/>
  </marker>
  <!-- Message flow: open arrowhead at target -->
  <marker id="msg-end" viewBox="0 0 20 20" refX="8.5" refY="5"
    markerWidth="20" markerHeight="20" orient="auto">
    <path d="m 1 5 l 0 -3 l 7 3 l -7 3 z" fill="${CLR.fill}" stroke="${CLR.stroke}" stroke-width="1" stroke-linecap="butt"/>
  </marker>
  <!-- Association: open chevron -->
  <marker id="assoc-end" viewBox="0 0 20 20" refX="11" refY="10"
    markerWidth="10" markerHeight="10" orient="auto">
    <path d="M 1 5 L 11 10 L 1 15" fill="none" stroke="${CLR.stroke}" stroke-width="1.5"/>
  </marker>
</defs>`);

  // §7.3  Canvas background
  out.push(`<rect width="${rn(W)}" height="${rn(H)}" fill="${CLR.canvasBg}"/>`);

  // §7.4  Pool outlines + headers (multi-pool)
  const isMultiPool = lc.pools && lc.pools.length > 0;
  const collapsedPools = lc.collapsedPools || [];

  if (isMultiPool) {
    for (const proc of lc.pools) {
      const pc = poolCoords[proc.id];
      if (!pc) continue;
      renderPoolSvg(out, proc, pc, laneCoords, poolCoords, tx, ty);
    }
  } else if (allLanes.length > 0) {
    // Single pool with lanes
    const allLc = allLanes.map(l => laneCoords[l.id]).filter(Boolean);
    if (allLc.length) {
      const spLhw = laneHeaderW(poolCoords, '_singlePool');
      const px = Math.min(...allLc.map(l => l.x)) - spLhw;
      const py = Math.min(...allLc.map(l => l.y));
      const pw = Math.max(...allLc.map(l => l.x + l.w)) - px;
      const ph = Math.max(...allLc.map(l => l.y + l.h)) - py;

      out.push(`<rect x="${tx(px)}" y="${ty(py)}" width="${pw}" height="${ph}" fill="${CLR.fill}" stroke="${CLR.stroke}" stroke-width="${SW.pool}"/>`);
      out.push(`<rect x="${tx(px)}" y="${ty(py)}" width="${spLhw}" height="${ph}" fill="${CLR.poolHeader}" stroke="${CLR.stroke}" stroke-width="${SW.pool}"/>`);
      const plcx = tx(px) + spLhw / 2;
      const plcy = ty(py) + ph / 2;
      out.push(`<text x="${plcx}" y="${plcy}" text-anchor="middle" dominant-baseline="middle" font-size="12" font-weight="bold" fill="${CLR.label}" transform="rotate(-90,${plcx},${plcy})">${esc(lc.name || 'Process')}</text>`);
    }
  }

  // §7.4b  Collapsed pools (black-box bands, bpmn-js 600×60)
  for (const cp of collapsedPools) {
    const pc = poolCoords[cp.id];
    if (!pc) continue;
    out.push(`<rect x="${tx(pc.x)}" y="${ty(pc.y)}" width="${pc.w}" height="${pc.h}" fill="${CLR.fill}" stroke="${CLR.stroke}" stroke-width="${SW.pool}"/>`);
    const cx = tx(pc.x) + pc.w / 2;
    const cy = ty(pc.y) + pc.h / 2;
    out.push(`<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" font-size="12" font-weight="bold" fill="${CLR.label}">${esc(cp.name || cp.id)}</text>`);
  }

  // §7.5  Lane bodies
  for (const lane of allLanes) {
    const lcc = laneCoords[lane.id];
    if (!lcc) continue;
    out.push(`<rect x="${tx(lcc.x)}" y="${ty(lcc.y)}" width="${lcc.w}" height="${lcc.h}" fill="${CLR.fill}" fill-opacity="0.25" stroke="${CLR.stroke}" stroke-width="${SW.lane}"/>`);
    // Lane header band — INSIDE the lane shape, matching the emitted DI and
    // bpmn.io: the strip left of the lane belongs to the pool's own header.
    // Drawing it outside would put it on top of the pool header band.
    const lhw = laneHeaderW(poolCoords, laneToPoolKey[lane.id]);
    out.push(`<rect x="${tx(lcc.x)}" y="${ty(lcc.y)}" width="${lhw}" height="${lcc.h}" fill="${CLR.laneHeader}" stroke="${CLR.stroke}" stroke-width="${SW.lane}"/>`);
    const lcx = tx(lcc.x) + lhw / 2;
    const lcy = ty(lcc.y) + lcc.h / 2;
    out.push(`<text x="${lcx}" y="${lcy}" text-anchor="middle" dominant-baseline="middle" font-size="11" fill="${CLR.label}" transform="rotate(-90,${lcx},${lcy})">${esc(lane.name || lane.id)}</text>`);
  }

  // §7.6  Sequence flows. The source-end marker follows what the XML carries, never a field of its
  // own: `resolveFlowSemantics` is the function `bpmn-xml.js` serialises `default` and
  // `conditionExpression` from (#84, #85).
  for (const proc of processes) {
    const nodeById = new Map((proc.nodes || []).map(n => [n.id, n]));
    const semantics = resolveFlowSemantics(proc.nodes || [], proc.edges || []);
    for (const edge of (proc.edges || [])) {
      const pts = edgeCoords[edge.id] || [];
      const marker = sequenceFlowSourceMarker(edge, nodeById.get(edge.source), semantics);
      renderSequenceFlow(out, edge, pts, coords, tx, ty, edgeLabels, marker);
    }
  }

  // §7.7  Message flows (dashed, orthogonal routing, OMG spec Fig 9.5)
  if (lc.messageFlows) {
    for (const mf of lc.messageFlows) {
      // Route comes from coordinates.js §5.4 — the same waypoints the DI gets.
      // This used to be computed here a second time, which is how the SVG ended
      // up orthogonal while the .bpmn stayed diagonal.
      const mfKey = mf.id || `mf_${mf.source}_${mf.target}`;
      const pts = edgeCoords?.[mfKey];
      if (!pts || pts.length < 2) continue;

      const pathD = `M ${tx(pts[0].x)} ${ty(pts[0].y)} ` +
                    pts.slice(1).map(p => `L ${tx(p.x)} ${ty(p.y)}`).join(' ');

      out.push(`<path data-element-id="${esc(mfKey)}" d="${pathD}" stroke="${CLR.stroke}" stroke-width="${SW.connection}" fill="none" stroke-dasharray="10,12" marker-start="url(#msg-start)" marker-end="url(#msg-end)"/>`);
      const L = mf.name ? edgeLabels?.[mfKey] : null;
      if (L) renderEdgeLabel(out, L, tx, ty);
    }
  }

  // §7.8  Associations (dotted lines, OMG spec §7.2)
  const allAssociations = lc.associations || [];
  for (const assoc of allAssociations) {
    // Route from coordinates.js §5.4 — the same waypoints the DI gets.
    const pts = edgeCoords?.[assoc.id];
    if (!pts || pts.length < 2) continue;
    const pathD = `M ${tx(pts[0].x)} ${ty(pts[0].y)} ` +
                  pts.slice(1).map(p => `L ${tx(p.x)} ${ty(p.y)}`).join(' ');
    const markerEnd = assoc.directed ? ` marker-end="url(#assoc-end)"` : '';
    out.push(`<path data-element-id="${esc(assoc.id)}" d="${pathD}" stroke="${CLR.stroke}" stroke-width="1.5" fill="none" stroke-dasharray="0.5,5"${markerEnd}/>`);
  }

  // §7.9  Nodes
  // Expanded SubProcess: its child nodes, then — for every child that is itself expanded — that
  // child's contents, then its own edges. Recursive because the DI is: a grandchild of two nested
  // expanded subprocesses has its BPMNShape, and drawing one level only left it out of the SVG.
  const renderContents = (node) => {
    const childById = new Map(node.nodes.map(n => [n.id, n]));
    const semantics = resolveFlowSemantics(node.nodes, node.edges || []);
    for (const child of node.nodes) {
      const cc = coords[child.id];
      if (!cc) continue;
      out.push(renderNode(child, cc, tx, ty, nodeLabels[child.id]));
      if (child.isExpanded && child.nodes) renderContents(child);
    }
    // Internal sequence flows, their source-end marker decided exactly as at process level —
    // `bpmn-xml.js` writes a nested flow's condition and its container's default from the same call.
    for (const subEdge of (node.edges || [])) {
      const pts = edgeCoords[subEdge.id] || [];
      const marker = sequenceFlowSourceMarker(subEdge, childById.get(subEdge.source), semantics);
      renderSequenceFlow(out, subEdge, pts, coords, tx, ty, edgeLabels, marker);
    }
  };
  for (const node of allNodes) {
    const c = coords[node.id];
    if (!c) continue;
    out.push(renderNode(node, c, tx, ty, nodeLabels[node.id]));
    if (node.isExpanded && node.nodes) renderContents(node);
  }

  out.push(`</svg>`);
  return out.join('\n');
}

function renderPoolSvg(out, proc, pc, laneCoords, poolCoords, tx, ty) {
  const lanes = proc.lanes || [];
  let px = pc.x, py = pc.y, pw = pc.w, ph = pc.h;
  const lhw = laneHeaderW(poolCoords, proc.id);

  if (lanes.length > 0) {
    const lcs = lanes.map(l => laneCoords[l.id]).filter(Boolean);
    if (lcs.length) {
      px = Math.min(...lcs.map(l => l.x)) - lhw;
      py = Math.min(...lcs.map(l => l.y));
      pw = Math.max(...lcs.map(l => l.x + l.w)) - px;
      ph = Math.max(...lcs.map(l => l.y + l.h)) - py;
    }
  }

  out.push(`<rect x="${tx(px)}" y="${ty(py)}" width="${pw}" height="${ph}" fill="${CLR.fill}" stroke="${CLR.stroke}" stroke-width="${SW.pool}"/>`);
  out.push(`<rect x="${tx(px)}" y="${ty(py)}" width="${lhw}" height="${ph}" fill="${CLR.poolHeader}" stroke="${CLR.stroke}" stroke-width="${SW.pool}"/>`);
  const plcx = tx(px) + lhw / 2;
  const plcy = ty(py) + ph / 2;
  out.push(`<text x="${plcx}" y="${plcy}" text-anchor="middle" dominant-baseline="middle" font-size="12" font-weight="bold" fill="${CLR.label}" transform="rotate(-90,${plcx},${plcy})">${esc(proc.name || 'Process')}</text>`);
}

/**
 * Which source-end marker a top-level sequence flow gets: `'default'`, `'conditional'` or `null` —
 * bpmn-js 18.6.2's rule (`BpmnRenderer`, handler `'bpmn:SequenceFlow'`) applied to what the XML
 * carries: the conditional diamond only for a flow with a conditionExpression leaving an Activity,
 * the default slash for the flow its Gateway or Activity source names as `default`; the slash wins
 * when both apply. `isConditional` and `isDefault` are not consulted directly — the XML decides.
 */
function sequenceFlowSourceMarker(edge, source, { defaultBySource, conditionById }) {
  if (!source) return null;
  if (defaultBySource.get(edge.source) === edge.id && (isGateway(source.type) || isActivity(source.type))) return 'default';
  if (conditionById.has(edge.id) && isActivity(source.type)) return 'conditional';
  return null;
}

function renderSequenceFlow(out, edge, pts, coords, tx, ty, edgeLabels, sourceMarker) {
  let pathD;
  if (pts.length >= 2) {
    pathD = `M ${tx(pts[0].x)} ${ty(pts[0].y)} ` +
            pts.slice(1).map(p => `L ${tx(p.x)} ${ty(p.y)}`).join(' ');
  } else {
    const s = coords[edge.source], t = coords[edge.target];
    if (!s || !t) return;
    pathD = `M ${tx(s.x + s.w/2)} ${ty(s.y + s.h/2)} L ${tx(t.x + t.w/2)} ${ty(t.y + t.h/2)}`;
  }

  const markerEnd = `marker-end="url(#seq-end)"`;
  const markerStart = sourceMarker === 'default'     ? `marker-start="url(#seq-default-src)"`
                    : sourceMarker === 'conditional' ? `marker-start="url(#seq-conditional-src)"`
                    : '';

  out.push(`<path data-element-id="${esc(edge.id)}" d="${pathD}" stroke="${CLR.stroke}" stroke-width="${SW.connection}" fill="none" ${markerStart} ${markerEnd}/>`);

  // Edge label — its box comes from coordMap.edgeLabels (coordinates.js placeEdgeLabel)
  const L = edge.label ? edgeLabels?.[edge.id] : null;
  if (L) renderEdgeLabel(out, L, tx, ty);
}

/**
 * Draw an edge label into its coordMap box the way bpmn-js draws the same BPMNLabel: Arial (the
 * root's font-family),
 * centred on the box, first baseline 3/4 of a line below the box top, no backdrop. Line breaks
 * and size come from coordMap (`lines`, placeEdgeLabel); nothing is measured here.
 */
function renderEdgeLabel(out, label, tx, ty) {
  const b = edgeLabelBox(label);
  drawLabelLines(out, b.x + b.w / 2, b.y, label.lines ?? [label.text], tx, ty);
}

/** `lines` centred on `centreX`, first baseline 3/4 of a line below `top` (coordMap coordinates). */
function drawLabelLines(out, centreX, top, lines, tx, ty) {
  const { fontSize, lineHeight } = edgeLabelTextStyle();
  const lineH = fontSize * lineHeight;
  const cx = rn(tx(centreX));
  const tspans = lines.map((line, i) =>
    `<tspan x="${cx}" y="${rn(ty(top) + lineH * (0.75 + i))}">${esc(line)}</tspan>`).join('');
  out.push(`<text text-anchor="middle" font-size="${fontSize}" fill="${CLR.label}">${tspans}</text>`);
}

// ─────────────────────────────────────────────────────────────────────
// NODE RENDERERS
// ─────────────────────────────────────────────────────────────────────
function renderNode(node, c, tx, ty, label) {
  const type = node.type || 'task';
  let svg;
  if (isEvent(type))         svg = renderEvent(node, c, tx, ty, label);
  else if (isGateway(type))  svg = renderGateway(node, c, tx, ty, label);
  else if (isDataArtifact(type)) svg = renderDataArtifact(node, c, tx, ty, label);
  else                       svg = renderActivity(node, c, tx, ty);
  // One group per element, keyed like bpmn-js's `data-element-id`, so a consumer (and
  // symbol-fidelity.test.js) can find an element's markup without re-deriving its geometry.
  const title = node.documentation ? `<title>${esc(node.documentation)}</title>\n` : '';
  return `<g data-element-id="${esc(node.id)}">\n${title}${svg}\n</g>`;
}

// ── Events (OMG spec §10.4) ─────────────────────────────────────────
function renderEvent(node, c, tx, ty, label) {
  const type   = node.type;
  const cx     = tx(c.x + c.w / 2);
  const cy     = ty(c.y + c.h / 2);
  const r      = c.w / 2;
  const o      = [];
  const fill   = node.color?.fill || CLR.fill;
  const stroke = node.color?.stroke || CLR.stroke;

  const isStart = type === 'startEvent';
  const isEnd   = type === 'endEvent';
  const isInter = type.includes('intermediate') || type === 'boundaryEvent';
  const isThrow = type === 'intermediateThrowEvent';
  // Dashed only where the XML says so: `isInterrupting="false"` is written on a startEvent and
  // `cancelActivity="false"` on a boundaryEvent, each under its row's class guard (types.js) — the
  // same guard here, so a field on a class that cannot carry it is not drawn either (#83).
  const isNonInterrupting =
    (node.isInterrupting === false && nodeFieldSpec('isInterrupting').allowed.has(type)) ||
    (node.cancelActivity === false && nodeFieldSpec('cancelActivity').allowed.has(type));

  const sw = isEnd ? SW.endEvent : isStart ? SW.startEvent : SW.intermediate;
  const dash = isNonInterrupting ? ` stroke-dasharray="5,3"` : '';

  // Outer circle
  o.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" fill-opacity="0.95" stroke="${stroke}" stroke-width="${sw}"${dash}/>`);

  // Intermediate/boundary: inner ring (3px gap, OMG spec Table 10.87)
  if (isInter) {
    const ri = r - INNER_OUTER_GAP;
    o.push(`<circle cx="${cx}" cy="${cy}" r="${ri}" fill="none" stroke="${stroke}" stroke-width="${SW.intermediate}"${dash}/>`);
  }

  // Marker icon inside
  const marker = node.marker || inferEventMarker(node.name || '');
  if (marker && marker !== 'terminate') {
    o.push(renderEventMarker(marker, cx, cy, r, isThrow || isEnd));
  }
  if (isEnd && marker === 'terminate') {
    o.push(`<circle cx="${cx}" cy="${cy}" r="${rn(r * 0.55)}" fill="${CLR.stroke}"/>`);
  }

  // External label — its box from coordMap.nodeLabels
  o.push(renderNodeLabel(label, tx, ty));

  return o.join('\n');
}

// ── Gateways (OMG spec §10.5) ───────────────────────────────────────
function renderGateway(node, c, tx, ty, label) {
  const type = node.type;
  const x = tx(c.x), y = ty(c.y), w = c.w, h = c.h;
  const cx = x + w/2, cy = y + h/2;
  const o = [];
  const fill   = node.color?.fill || CLR.fill;
  const stroke = node.color?.stroke || CLR.stroke;

  // Diamond shape
  o.push(`<polygon points="${cx},${y} ${x+w},${cy} ${cx},${y+h} ${x},${cy}" fill="${fill}" fill-opacity="0.95" stroke="${stroke}" stroke-width="${SW.gateway}"/>`);

  // Internal marker
  const d = 9;
  if (type === 'exclusiveGateway') {
    // X mark (OMG spec Fig 10.59)
    o.push(`<line x1="${cx-d}" y1="${cy-d}" x2="${cx+d}" y2="${cy+d}" stroke="${stroke}" stroke-width="3" stroke-linecap="round"/>`);
    o.push(`<line x1="${cx+d}" y1="${cy-d}" x2="${cx-d}" y2="${cy+d}" stroke="${stroke}" stroke-width="3" stroke-linecap="round"/>`);
  } else if (type === 'parallelGateway') {
    // + mark (OMG spec Fig 10.69)
    o.push(`<line x1="${cx}" y1="${cy-d}" x2="${cx}" y2="${cy+d}" stroke="${stroke}" stroke-width="3.5" stroke-linecap="round"/>`);
    o.push(`<line x1="${cx-d}" y1="${cy}" x2="${cx+d}" y2="${cy}" stroke="${stroke}" stroke-width="3.5" stroke-linecap="round"/>`);
  } else if (type === 'inclusiveGateway') {
    // Bold circle (OMG spec Fig 10.64)
    o.push(`<circle cx="${cx}" cy="${cy}" r="${rn(h * 0.24)}" fill="none" stroke="${stroke}" stroke-width="2.5"/>`);
  } else if (type === 'eventBasedGateway') {
    // OMG spec Fig 10.73-10.75; structure and ring radii from bpmn-js 18.6.2 ('bpmn:EventBasedGateway'):
    // one ring always; `Parallel` adds an outlined plus and no pentagon; `Exclusive` (the default)
    // adds the pentagon, and a second ring inside the first unless the gateway instantiates (#85).
    // Reads the two fields the XML carries — both written by the generic field loop (types.js).
    const ringR = (offset) => Math.round((w + h) / 4 - offset);
    o.push(`<circle cx="${cx}" cy="${cy}" r="${ringR(h * 0.20)}" fill="none" stroke="${stroke}" stroke-width="1"/>`);
    if (node.eventGatewayType === 'Parallel') {
      o.push(`<path d="${eventGatewayParallelPath(x, y, w, h)}" fill="none" stroke="${stroke}" stroke-width="1"/>`);
    } else {
      if (node.instantiate !== true) {
        o.push(`<circle cx="${cx}" cy="${cy}" r="${ringR(h * 0.26)}" fill="none" stroke="${stroke}" stroke-width="1"/>`);
      }
      o.push(renderPentagon(cx, cy, h * 0.14, stroke));
    }
  } else if (type === 'complexGateway') {
    // Asterisk (OMG spec Fig 10.67)
    for (const a of [0, 45, 90, 135]) {
      const rad = a * Math.PI / 180;
      const ddx = Math.cos(rad) * d, ddy = Math.sin(rad) * d;
      o.push(`<line x1="${rn(cx-ddx)}" y1="${rn(cy-ddy)}" x2="${rn(cx+ddx)}" y2="${rn(cy+ddy)}" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round"/>`);
    }
  }

  // External label — its box from coordMap.nodeLabels
  o.push(renderNodeLabel(label, tx, ty));

  return o.join('\n');
}

/**
 * The outlined plus of a parallel event-based gateway: bpmn-js 18.6.2's PathMap `GATEWAY_PARALLEL`
 * (30×30, elements 5 / 12.5), scaled by 0.4 of the shape and started at (0.474 w, 0.296 h) — the
 * parameters its 'bpmn:EventBasedGateway' handler passes to `getScaledPath`.
 */
function eventGatewayParallelPath(x, y, w, h) {
  const xr = (w / 30) * 0.4, yr = (h / 30) * 0.4;
  const x0 = rn(5 * xr), x1 = rn(12.5 * xr), y0 = rn(5 * yr), y1 = rn(12.5 * yr);
  const mx = rn(x + w * 0.474), my = rn(y + h * 0.296);
  return `m ${mx},${my} 0,${y1} -${x1},0 0,${y0} ${x1},0 0,${y1} ${x0},0 0,-${y1} ${x1},0 0,-${y0} -${x1},0 0,-${y1} -${x0},0 z`;
}

// ── Activities (OMG spec §10.2) ─────────────────────────────────────
function renderActivity(node, c, tx, ty) {
  const type = node.type || 'task';
  const x = tx(c.x), y = ty(c.y), w = c.w, h = c.h;
  const cx = x + w/2;
  const o = [];
  const fill   = node.color?.fill || CLR.fill;
  const stroke = node.color?.stroke || CLR.stroke;

  const sw = type === 'callActivity' ? SW.callActivity : SW.task;
  const dash = node.isEventSubProcess ? ` stroke-dasharray="7,3"` : '';
  const isTransaction = type === 'transaction';

  // Main rectangle (rx=10 per bpmn-js)
  o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${TASK_RX}" ry="${TASK_RX}" fill="${fill}" fill-opacity="0.95" stroke="${stroke}" stroke-width="${sw}"${dash}/>`);

  // Transaction: inner rectangle (double border, OMG spec §13.2.2)
  if (isTransaction) {
    const gap = 3;
    o.push(`<rect x="${x+gap}" y="${y+gap}" width="${w-2*gap}" height="${h-2*gap}" rx="${TASK_RX-1}" ry="${TASK_RX-1}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`);
  }

  // Expanded SubProcess: render title bar + internal flow, no [+] marker, no icon
  if (node.isExpanded && node.nodes && node.nodes.length > 0) {
    // SubProcess name as title (top-left, bold)
    o.push(`<text x="${x + 10}" y="${rn(y + 18)}" text-anchor="start" font-size="12" font-weight="bold" fill="${CLR.label}">${esc(node.name || '')}</text>`);
    // Internal nodes and edges rendered by the main generateSvg loop (coords are absolute)
    return o.join('\n');
  }

  // Type icon top-left (bpmn-js PathMap glyphs)
  const icon = renderTaskIcon(type, x, y, node);
  if (icon) o.push(icon);

  // Bottom-center markers (loop, MI, subprocess)
  const markers = renderBottomMarkers(node, cx, y + h, x, w);
  if (markers) o.push(markers);

  // Label centered inside
  const hasIcon    = icon !== null;
  const topPad     = hasIcon ? 18 : 0;
  const bottomPad  = markers ? 16 : 0;
  const usableH    = h - topPad - bottomPad;
  const maxChars   = Math.floor(w / 6.5);
  const lines      = wrapText(node.name || '', maxChars);
  const lineH      = 14;
  const textAreaCy = y + topPad + usableH / 2;
  const startY     = textAreaCy - ((lines.length - 1) * lineH) / 2;

  for (let i = 0; i < lines.length; i++) {
    o.push(`<text x="${cx}" y="${rn(startY + i * lineH)}" text-anchor="middle" dominant-baseline="middle" font-size="12" fill="${CLR.label}">${esc(lines[i])}</text>`);
  }

  return o.join('\n');
}

// §7.9  Bottom markers (loop, multi-instance, collapsed subprocess, ad-hoc, compensation)
function renderBottomMarkers(node, cx, bottomY, actX, actW) {
  const markers = [];

  // Loop marker (OMG spec Fig 10.20)
  if (node.loopType === 'standard') {
    markers.push(renderLoopMarker(0, 0));
  }
  // Multi-instance parallel ⫴ (OMG spec Fig 10.22)
  if (node.multiInstance === 'parallel') {
    markers.push(renderMIParallelMarker(0, 0));
  }
  // Multi-instance sequential ≡ (OMG spec Fig 10.23)
  if (node.multiInstance === 'sequential') {
    markers.push(renderMISequentialMarker(0, 0));
  }
  // Collapsed subprocess [+] (OMG spec Fig 10.17) — a Transaction is a SubProcess, and bpmn-js
  // draws the marker on a collapsed one too (#85)
  if (node.type === 'subProcess' || node.type === 'transaction' || node.type === 'callActivity') {
    markers.push(renderSubProcessMarker(0, 0));
  }
  // Ad-hoc ~
  if (node.isAdHoc) {
    markers.push(renderAdHocMarker(0, 0));
  }
  // Compensation ◁◁
  if (node.isCompensation) {
    markers.push(renderCompensationMarker(0, 0));
  }

  if (markers.length === 0) return null;

  // Position markers side by side at bottom center
  const totalW = markers.length * 16;
  const startX = cx - totalW / 2;
  const my     = bottomY - 18;

  const parts = markers.map((m, i) =>
    `<g transform="translate(${rn(startX + i * 16)},${rn(my)})">${m}</g>`
  );

  return parts.join('\n');
}

// ── Data Objects & Artifacts (OMG spec §10.6) ───────────────────────
function renderDataArtifact(node, c, tx, ty, label) {
  const type = node.type;
  const x = tx(c.x), y = ty(c.y), w = c.w, h = c.h;
  const cx = x + w/2;
  const o = [];
  const fill   = node.color?.fill || CLR.fill;
  const stroke = node.color?.stroke || CLR.stroke;

  if (type === 'dataObjectReference') {
    // Data object: rectangle with folded corner (OMG spec Fig 10.82)
    const fold = 10;
    o.push(`<path d="M ${x},${y} L ${x+w-fold},${y} L ${x+w},${y+fold} L ${x+w},${y+h} L ${x},${y+h} Z" fill="${fill}" stroke="${stroke}" stroke-width="${SW.dataObject}"/>`);
    o.push(`<path d="M ${x+w-fold},${y} L ${x+w-fold},${y+fold} L ${x+w},${y+fold}" fill="none" stroke="${stroke}" stroke-width="${SW.dataObject}"/>`);
    // Collection marker (three vertical lines)
    if (node.isCollection) {
      const bx = cx - 6, by = y + h - 12;
      o.push(`<line x1="${bx}" y1="${by}" x2="${bx}" y2="${by+8}" stroke="${stroke}" stroke-width="1.5"/>`);
      o.push(`<line x1="${bx+6}" y1="${by}" x2="${bx+6}" y2="${by+8}" stroke="${stroke}" stroke-width="1.5"/>`);
      o.push(`<line x1="${bx+12}" y1="${by}" x2="${bx+12}" y2="${by+8}" stroke="${stroke}" stroke-width="1.5"/>`);
    }
    // Label below — its box from coordMap.nodeLabels
    o.push(renderNodeLabel(label, tx, ty));
  } else if (type === 'dataStoreReference') {
    // Data store: cylinder (OMG spec Fig 10.85)
    const ry = 6;
    o.push(`<ellipse cx="${cx}" cy="${y+ry}" rx="${w/2}" ry="${ry}" fill="${fill}" stroke="${stroke}" stroke-width="${SW.dataObject}"/>`);
    o.push(`<path d="M ${x},${y+ry} L ${x},${y+h-ry}" stroke="${stroke}" stroke-width="${SW.dataObject}" fill="none"/>`);
    o.push(`<path d="M ${x+w},${y+ry} L ${x+w},${y+h-ry}" stroke="${stroke}" stroke-width="${SW.dataObject}" fill="none"/>`);
    o.push(`<ellipse cx="${cx}" cy="${y+h-ry}" rx="${w/2}" ry="${ry}" fill="${fill}" stroke="${stroke}" stroke-width="${SW.dataObject}"/>`);
    o.push(renderNodeLabel(label, tx, ty));
  } else if (type === 'textAnnotation') {
    // Open bracket [ shape (OMG spec Fig 10.86)
    o.push(`<path d="M ${x+15},${y} L ${x},${y} L ${x},${y+h} L ${x+15},${y+h}" fill="none" stroke="${stroke}" stroke-width="${SW.annotation}"/>`);
    // The text as coordinates.js laid it out (artifactSize): `lines` sized the box, so they are
    // drawn, never re-wrapped here. One line sits where it always did; several are centred as a block.
    const lines = c.lines ?? [node.name || ''];
    const lineH = textAnnotationTextStyle().fontSize * textAnnotationTextStyle().lineHeight;
    lines.forEach((line, i) => o.push(`<text x="${x+20}" y="${rn(y + h / 2 + 4 + (i - (lines.length - 1) / 2) * lineH)}" font-size="11" fill="${CLR.label}">${esc(line)}</text>`));
  } else if (type === 'group') {
    // Dashed rounded rectangle (OMG spec Fig 10.88)
    o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" ry="10" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-dasharray="8,4,2,4"/>`);
    o.push(`<text x="${cx}" y="${rn(y-5)}" text-anchor="middle" font-size="12" font-weight="bold" fill="${CLR.label}">${esc(node.name || '')}</text>`);
  }

  return o.join('\n');
}

/**
 * Draw an external node label into its coordMap.nodeLabels box (coordinates.js placeNodeLabels) the
 * way bpmn-js draws the same BPMNLabel — the rule renderEdgeLabel follows. Nothing is positioned
 * or measured here.
 */
function renderNodeLabel(label, tx, ty) {
  if (!label) return '';
  const out = [];
  drawLabelLines(out, label.x + label.w / 2, label.y, label.lines, tx, ty);
  return out.join('');
}

export { generateSvg };
