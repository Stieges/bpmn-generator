/**
 * BPMN SVG Generation — OMG BPMN 2.0 compliant visual rendering
 * Produces standalone SVG diagrams from coordinate maps.
 */

import { assignEdgeIds, resolveFlowSemantics } from './topology.js';
import { isEvent, isGateway, isActivity, isDataArtifact, nodeFieldSpec, writesIsInterrupting, CONTAINER_TYPES } from './types.js';
import { CLR, SW, SYM, LANE_HEADER_W, TASK_RX, INNER_OUTER_GAP } from './constants.js';
import { esc, rn } from '../shared/utils.js';
import { edgeLabelBox, edgeLabelTextStyle, edgeLabelLayout, textAnnotationTextStyle } from './coordinates.js';

import {
  renderEventMarker, inferEventMarker, renderTaskIcon, renderTaskMarkers, renderGatewaySymbol,
  renderDataObjectShape, renderDataStoreShape, renderTextAnnotationShape,
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
    <path d="M 1 5 L 11 10 L 1 15 Z" fill="${CLR.stroke}" stroke="${CLR.stroke}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
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
    <circle cx="6" cy="6" r="3.5" fill="${CLR.fill}" stroke="${CLR.stroke}" stroke-width="1" stroke-dasharray="10000, 1"/>
  </marker>
  <!-- Message flow: open arrowhead at target -->
  <marker id="msg-end" viewBox="0 0 20 20" refX="8.5" refY="5"
    markerWidth="20" markerHeight="20" orient="auto">
    <path d="m 1 5 l 0 -3 l 7 3 l -7 3 z" fill="${CLR.fill}" stroke="${CLR.stroke}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="10000, 1"/>
  </marker>
  <!-- Association: open chevron -->
  <marker id="assoc-end" viewBox="0 0 20 20" refX="11" refY="10"
    markerWidth="10" markerHeight="10" orient="auto">
    <path d="M 1 5 L 11 10 L 1 15" fill="none" stroke="${CLR.stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="10000, 1"/>
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

      drawParticipant(out, lc.name || 'Process', tx(px), ty(py), pw, ph, spLhw);
    }
  }

  // §7.4b  Collapsed pools (black-box bands, bpmn-js 600×60)
  for (const cp of collapsedPools) {
    const pc = poolCoords[cp.id];
    if (!pc) continue;
    // 'bpmn:Participant', collapsed: the band, its name centred in it (`center-middle`)
    out.push(`<rect x="${tx(pc.x)}" y="${ty(pc.y)}" width="${pc.w}" height="${pc.h}" fill="${CLR.fill}" fill-opacity="${SYM.fillOpacity}" stroke="${CLR.stroke}" stroke-width="${SW.pool}"/>`);
    out.push(...centredText(cp.name || cp.id, tx(pc.x), ty(pc.y), pc.w, pc.h, SYM.participantLabel, CLR.label));
  }

  // §7.5  Lane bodies
  for (const lane of allLanes) {
    const lcc = laneCoords[lane.id];
    if (!lcc) continue;
    // 'bpmn:Lane': the band, and its name rotated in the band's first strip (`renderLaneLabel`) —
    // the strip INSIDE the lane, matching the DI and bpmn.io. bpmn-js draws no line closing it; the
    // header fill (config.json → color.laneHeader) is white like bpmn.io unless configured.
    out.push(`<rect x="${tx(lcc.x)}" y="${ty(lcc.y)}" width="${lcc.w}" height="${lcc.h}" fill="${CLR.fill}" fill-opacity="${SYM.laneFillOpacity}" stroke="${CLR.stroke}" stroke-width="${SW.lane}"/>`);
    const lhw = laneHeaderW(poolCoords, laneToPoolKey[lane.id]);
    if (CLR.laneHeader !== CLR.fill) {
      out.push(`<rect x="${tx(lcc.x)}" y="${ty(lcc.y)}" width="${lhw}" height="${lcc.h}" fill="${CLR.laneHeader}" stroke="none"/>`);
    }
    out.push(...stripLabel(lane.name || lane.id, tx(lcc.x), ty(lcc.y), lhw, lcc.h, SYM.participantLabel, CLR.label));
  }

  // §7.6  Nodes — before every connection: bpmn.io draws connections above shapes, so a message
  // flow's start circle and a data association stay visible over the shape they touch.
  const nestedFlows = [];
  // Expanded SubProcess: its child nodes, then — for every child that is itself expanded — that
  // child's contents, then its own edges. Recursive because the DI is: a grandchild of two nested
  // expanded subprocesses has its BPMNShape, and drawing one level only left it out of the SVG.
  const renderContents = (node) => {
    const childById = new Map(node.nodes.map(n => [n.id, n]));
    const semantics = resolveFlowSemantics(node.nodes, node.edges || []);
    for (const child of node.nodes) {
      const cc = coords[child.id];
      if (!cc) continue;
      out.push(renderNode(child, cc, tx, ty, nodeLabels[child.id], node));
      if (child.isExpanded && child.nodes) renderContents(child);
    }
    // Internal sequence flows, their source-end marker decided exactly as at process level —
    // `bpmn-xml.js` writes a nested flow's condition and its container's default from the same call.
    // Deferred: drawn with the other connections, above every shape.
    for (const subEdge of (node.edges || [])) {
      const pts = edgeCoords[subEdge.id] || [];
      const marker = sequenceFlowSourceMarker(subEdge, childById.get(subEdge.source), semantics);
      nestedFlows.push(() => renderSequenceFlow(out, subEdge, pts, coords, tx, ty, edgeLabels, marker));
    }
  };
  for (const node of allNodes) {
    const c = coords[node.id];
    if (!c) continue;
    out.push(renderNode(node, c, tx, ty, nodeLabels[node.id]));
    if (node.isExpanded && node.nodes) renderContents(node);
  }

  // §7.7  Sequence flows. The source-end marker follows what the XML carries, never a field of its
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

  for (const draw of nestedFlows) draw();

  // §7.8  Message flows (dashed, orthogonal routing, OMG spec Fig 9.5)
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

      out.push(`<path data-element-id="${esc(mfKey)}" d="${pathD}" stroke="${CLR.stroke}" stroke-width="${SW.messageFlow}" fill="none" stroke-dasharray="${SYM.dash.messageFlow}" stroke-linecap="round" stroke-linejoin="round" marker-start="url(#msg-start)" marker-end="url(#msg-end)"/>`);
      const L = mf.name ? edgeLabels?.[mfKey] : null;
      if (L) renderEdgeLabel(out, L, tx, ty);
    }
  }

  // §7.9  Associations (dotted lines, OMG spec §7.2)
  const allAssociations = lc.associations || [];
  for (const assoc of allAssociations) {
    // Route from coordinates.js §5.4 — the same waypoints the DI gets.
    const pts = edgeCoords?.[assoc.id];
    if (!pts || pts.length < 2) continue;
    const pathD = `M ${tx(pts[0].x)} ${ty(pts[0].y)} ` +
                  pts.slice(1).map(p => `L ${tx(p.x)} ${ty(p.y)}`).join(' ');
    const markerEnd = assoc.directed ? ` marker-end="url(#assoc-end)"` : '';
    out.push(`<path data-element-id="${esc(assoc.id)}" d="${pathD}" stroke="${CLR.stroke}" stroke-width="${SW.association}" fill="none" stroke-dasharray="${SYM.dash.association}" stroke-linecap="round" stroke-linejoin="round"${markerEnd}/>`);
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

  drawParticipant(out, proc.name || 'Process', tx(px), ty(py), pw, ph, lhw);
}

/**
 * 'bpmn:Participant', expanded: the box, the line closing its header strip, and its name rotated
 * in the strip (`renderLaneLabel`). bpmn-js fills the strip white; `color.poolHeader` can tint it.
 */
function drawParticipant(out, name, x, y, w, h, strip) {
  out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${CLR.fill}" fill-opacity="${SYM.fillOpacity}" stroke="${CLR.stroke}" stroke-width="${SW.pool}"/>`);
  if (CLR.poolHeader !== CLR.fill) {
    out.push(`<rect x="${x}" y="${y}" width="${strip}" height="${h}" fill="${CLR.poolHeader}" stroke="none"/>`);
  }
  out.push(`<path d="M ${rn(x + strip)} ${y} L ${rn(x + strip)} ${rn(y + h)}" stroke="${CLR.stroke}" stroke-width="${SW.pool}" fill="none"/>`);
  out.push(...stripLabel(name, x, y, strip, h, SYM.participantLabel, CLR.label));
}

// ─────────────────────────────────────────────────────────────────────
// TEXT — diagram-js Text.js `layoutText`, line breaks from coordinates.js `edgeLabelLayout`
// ─────────────────────────────────────────────────────────────────────

/** The lines `text` breaks into in a box `width` wide with `padding` on each side. */
function boxLines(text, style, width, padding = 0) {
  if (!text) return [];
  return edgeLabelLayout(text, { fontSize: style.fontSize, lineHeight: style.lineHeight, wrapWidth: width - 2 * padding }).lines;
}

/**
 * One `<text>` per line, centred on `cx`, the first baseline at `baseline` — separate elements
 * rather than tspans, because an external label's tspans are what the geometry fence reads.
 */
function textLines(lines, cx, baseline, style, fill, extra = '') {
  const lh = style.fontSize * style.lineHeight;
  return lines.map((line, i) => `<text x="${rn(cx)}" y="${rn(baseline + lh * i)}" text-anchor="middle" font-size="${style.fontSize}" fill="${fill}"${extra}>${esc(line)}</text>`);
}

/** Text.js `center-middle` in a box: the block centred vertically, first baseline ¾ line below its top. */
function centredText(text, x, y, w, h, style, fill, padding = 0) {
  const lines = boxLines(text, style, w, padding);
  const lh = style.fontSize * style.lineHeight;
  return textLines(lines, x + w / 2, y + (h - lines.length * lh) / 2 + 0.75 * lh, style, fill);
}

/**
 * `renderLaneLabel`: the name laid out in a box as long as the band and `strip` wide, centred, and
 * turned by 270° — one rotated `<text>` per line, each about its own baseline point.
 */
function stripLabel(text, x, y, strip, h, style, fill) {
  const lines = boxLines(text, style, h);
  const lh = style.fontSize * style.lineHeight;
  const cy = rn(y + h / 2);
  return lines.map((line, i) => {
    const bx = rn(x + (strip - lines.length * lh) / 2 + lh * (0.75 + i));
    return `<text x="${bx}" y="${cy}" text-anchor="middle" font-size="${style.fontSize}" fill="${fill}" transform="rotate(-90,${bx},${cy})">${esc(line)}</text>`;
  });
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

  out.push(`<path data-element-id="${esc(edge.id)}" d="${pathD}" stroke="${CLR.stroke}" stroke-width="${SW.connection}" fill="none" stroke-linecap="round" stroke-linejoin="round" ${markerStart} ${markerEnd}/>`);

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
function renderNode(node, c, tx, ty, label, parent = null) {
  const type = node.type || 'task';
  let svg;
  if (isEvent(type))         svg = renderEvent(node, c, tx, ty, label, parent);
  else if (isGateway(type))  svg = renderGateway(node, c, tx, ty, label);
  else if (isDataArtifact(type)) svg = renderDataArtifact(node, c, tx, ty, label);
  else                       svg = renderActivity(node, c, tx, ty);
  // One group per element, keyed like bpmn-js's `data-element-id`, so a consumer (and
  // symbol-fidelity.test.js) can find an element's markup without re-deriving its geometry.
  const title = node.documentation ? `<title>${esc(node.documentation)}</title>\n` : '';
  return `<g data-element-id="${esc(node.id)}">\n${title}${svg}\n</g>`;
}

// ── Events (OMG spec §10.4) — 'bpmn:StartEvent', 'bpmn:IntermediateEvent', 'bpmn:BoundaryEvent',
// 'bpmn:EndEvent' ─────────────────────────────────────────────────────────────────────────────────
function renderEvent(node, c, tx, ty, label, parent = null) {
  const type   = node.type;
  const x = tx(c.x), y = ty(c.y), w = c.w, h = c.h;
  const o      = [];
  const fill   = node.color?.fill || CLR.fill;
  const stroke = node.color?.stroke || CLR.stroke;

  const isStart = type === 'startEvent';
  const isEnd   = type === 'endEvent';
  const isBoundary = type === 'boundaryEvent';
  const isInter = type.includes('intermediate') || isBoundary;
  const isThrow = type === 'intermediateThrowEvent' || isEnd;   // bpmn-js `isThrowEvent`
  // Dashed only where the XML says so: `isInterrupting="false"` on the start event of an event
  // subprocess (`writesIsInterrupting`) and `cancelActivity="false"` on a boundaryEvent under its
  // row's class guard (types.js) — the same decisions the writer makes (#83).
  const isNonInterrupting =
    writesIsInterrupting(node, parent) ||
    (node.cancelActivity === false && nodeFieldSpec('cancelActivity').allowed.has(type));

  const sw = isEnd ? SW.endEvent : isStart ? SW.startEvent : SW.intermediate;
  const dash = isNonInterrupting ? ` stroke-dasharray="${SYM.dash.nonInterrupting}"` : '';
  const cx = rn(x + w / 2), cy = rn(y + h / 2);
  const r = Math.round((w + h) / 4);

  // Outer circle — a boundary event is fully opaque over its host's border
  o.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" fill-opacity="${isBoundary ? 1 : SYM.fillOpacity}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`);

  // Intermediate/boundary: inner ring (OMG spec Table 10.87; bpmn-js INNER_OUTER_DIST)
  if (isInter) {
    o.push(`<circle cx="${cx}" cy="${cy}" r="${Math.round((w + h) / 4 - INNER_OUTER_GAP)}" fill="none" stroke="${stroke}" stroke-width="${SW.intermediate}"${isBoundary ? dash : ''}/>`);
  }

  // Icon, element-relative
  const marker = node.marker || inferEventMarker(node.name || '');
  if (marker && (marker !== 'terminate' || isEnd)) {
    o.push(`<g transform="translate(${x},${y})">${renderEventMarker(marker, w, h, isThrow, node.color)}</g>`);
  }

  // External label — its box from coordMap.nodeLabels
  o.push(renderNodeLabel(label, tx, ty));

  return o.join('\n');
}

// ── Gateways (OMG spec §10.5) — the gateway handlers ───────────────
function renderGateway(node, c, tx, ty, label) {
  const x = tx(c.x), y = ty(c.y), w = c.w, h = c.h;
  const cx = rn(x + w / 2), cy = rn(y + h / 2);
  const o = [];
  const fill   = node.color?.fill || CLR.fill;
  const stroke = node.color?.stroke || CLR.stroke;

  o.push(`<polygon points="${cx},${y} ${rn(x + w)},${cy} ${cx},${rn(y + h)} ${x},${cy}" fill="${fill}" fill-opacity="${SYM.fillOpacity}" stroke="${stroke}" stroke-width="${SW.gateway}" stroke-linejoin="round"/>`);
  // `isMarkerVisible` is written on every exclusive gateway's DI (bpmn-xml.js buildNodeShapeDI).
  const symbol = renderGatewaySymbol(node.type, w, h, node, { markerVisible: true }, node.color);
  if (symbol) o.push(`<g transform="translate(${x},${y})">${symbol}</g>`);

  o.push(renderNodeLabel(label, tx, ty));
  return o.join('\n');
}

// ── Activities (OMG spec §10.2) — `renderTask`, `renderSubProcess`, 'bpmn:Transaction',
// 'bpmn:CallActivity' ─────────────────────────────────────────────────────────────────────────────
// A collapsed container or call activity gets the [+] (`renderSubProcess`, also behind 'bpmn:CallActivity').
const isCollapsedContainerType = (type) => CONTAINER_TYPES.has(type) || type === 'callActivity';

function renderActivity(node, c, tx, ty) {
  const type = node.type || 'task';
  const x = tx(c.x), y = ty(c.y), w = c.w, h = c.h;
  const o = [];
  const fill   = node.color?.fill || CLR.fill;
  const stroke = node.color?.stroke || CLR.stroke;
  const isTransaction = type === 'transaction';
  const isEventSub = !!node.isEventSubProcess;

  const sw = type === 'callActivity' ? SW.callActivity
    : isEventSub ? SW.eventSubProcess
    : isTransaction ? SW.transaction : SW.task;
  // An event subprocess's frame is dotted: a zero-length dash with round caps.
  const dash = isEventSub ? ` stroke-dasharray="${SYM.dash.eventSubProcess}" stroke-linecap="round"` : '';

  o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${TASK_RX}" ry="${TASK_RX}" fill="${fill}" fill-opacity="${SYM.fillOpacity}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`);

  // Transaction: inner border, INNER_OUTER_DIST inside, radius reduced by the same (OMG spec §13.2.2)
  if (isTransaction) {
    const g = INNER_OUTER_GAP;
    o.push(`<rect x="${rn(x + g)}" y="${rn(y + g)}" width="${rn(w - 2 * g)}" height="${rn(h - 2 * g)}" rx="${TASK_RX - g}" ry="${TASK_RX - g}" fill="none" stroke="${stroke}" stroke-width="${SW.transaction}"/>`);
  }

  const expanded = !!(node.isExpanded && node.nodes && node.nodes.length > 0);
  if (expanded) {
    // Title `center-top` (padding 7), regular weight, as bpmn-js's `renderEmbeddedLabel`
    const st = SYM.containerTitle;
    const lines = boxLines(node.name || '', st, w, st.padding);
    o.push(...textLines(lines, x + w / 2, y + st.padding + 0.75 * st.fontSize * st.lineHeight, st, CLR.label));
    const markers = renderTaskMarkers(node, w, h, { collapsed: false }, node.color);
    if (markers) o.push(`<g transform="translate(${x},${y})">${markers}</g>`);
    // Internal nodes and edges are rendered by the main generateSvg loop (coords are absolute)
    return o.join('\n');
  }

  // Label `center-middle` (padding 7) — bpmn-js does not move it for the type icon
  const st = SYM.embeddedText;
  o.push(...centredText(node.name || '', x, y, w, h, st, CLR.label, st.padding));

  const icon = renderTaskIcon(type, node, node.color) ?? '';
  const markers = renderTaskMarkers(node, w, h, { collapsed: isCollapsedContainerType(type) }, node.color);
  if (icon || markers) o.push(`<g transform="translate(${x},${y})">${icon}${markers}</g>`);

  return o.join('\n');
}

// ── Data Objects & Artifacts (OMG spec §10.6) ───────────────────────
function renderDataArtifact(node, c, tx, ty, label) {
  const type = node.type;
  const x = tx(c.x), y = ty(c.y), w = c.w, h = c.h;
  const o = [];
  const stroke = node.color?.stroke || CLR.stroke;

  if (type === 'dataObjectReference') {
    // 'bpmn:DataObject' — folded page; a collection adds three bars
    o.push(`<g transform="translate(${x},${y})">${renderDataObjectShape(w, h, { collection: !!node.isCollection, fillOpacity: SYM.fillOpacity }, node.color)}</g>`);
    o.push(renderNodeLabel(label, tx, ty));
  } else if (type === 'dataStoreReference') {
    // 'bpmn:DataStoreReference' — cylinder with stacked rims
    o.push(`<g transform="translate(${x},${y})">${renderDataStoreShape(w, h, { fillOpacity: SYM.fillOpacity }, node.color)}</g>`);
    o.push(renderNodeLabel(label, tx, ty));
  } else if (type === 'textAnnotation') {
    // 'bpmn:TextAnnotation' — open bracket, text `left-top` with padding 7. The lines are the ones
    // coordinates.js sized the box from (artifactSize), never re-wrapped here.
    o.push(`<g transform="translate(${x},${y})">${renderTextAnnotationShape(w, h, { sw: SW.annotation }, node.color)}</g>`);
    const st = textAnnotationTextStyle();
    const lh = st.fontSize * st.lineHeight;
    const lines = c.lines ?? [node.name || ''];
    lines.forEach((line, i) => o.push(`<text x="${rn(x + st.padding)}" y="${rn(y + st.padding + lh * (0.75 + i))}" font-size="${st.fontSize}" fill="${CLR.label}">${esc(line)}</text>`));
  } else if (type === 'group') {
    // 'bpmn:Group' — dashed rounded frame; its name is an external label centred on the top edge
    // (bpmn-js `getExternalLabelMid` for a Group), first baseline ¾ of a line below the frame top.
    o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${TASK_RX}" ry="${TASK_RX}" fill="none" stroke="${stroke}" stroke-width="${SW.group}" stroke-dasharray="${SYM.dash.group}" stroke-linecap="round" stroke-linejoin="round"/>`);
    const st = SYM.externalText;
    const lines = edgeLabelLayout(node.name || '').lines.filter(Boolean);
    o.push(...textLines(lines, x + w / 2, y + 0.75 * st.fontSize * st.lineHeight, st, CLR.label));
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
