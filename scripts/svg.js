/**
 * BPMN SVG Generation — OMG BPMN 2.0 compliant visual rendering
 * Produces standalone SVG diagrams from coordinate maps.
 */

import { isEvent, isGateway, isDataArtifact } from './types.js';
import { CLR, SW, SHAPE, LANE_HEADER_W, LANE_PADDING, LABEL_DISTANCE, TASK_RX, INNER_OUTER_GAP, EXTERNAL_LABEL_H, esc, rn, wrapText } from './utils.js';
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

function generateSvg(lc, coordMap) {
  const { coords, laneCoords, poolCoords, edgeCoords } = coordMap;
  const processes = lc.pools ? lc.pools : [lc];
  const allNodes  = processes.flatMap(p => p.nodes || []);
  const allEdges  = processes.flatMap(p => p.edges || []);
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

  // §7.2  SVG Defs — markers for all connection types
  out.push(`<defs>
  <!-- Sequence flow: filled triangle (OMG spec Fig 10.43) -->
  <marker id="seq-end" viewBox="0 0 20 20" refX="11" refY="10"
    markerWidth="10" markerHeight="10" orient="auto">
    <path d="M 1 5 L 11 10 L 1 15 Z" fill="${CLR.stroke}" stroke="${CLR.stroke}" stroke-width="1"/>
  </marker>
  <!-- Default flow: diagonal slash at source (OMG spec Fig 10.47) -->
  <marker id="seq-default-src" viewBox="0 0 20 20" refX="6" refY="10"
    markerWidth="10" markerHeight="10" orient="auto">
    <path d="M 6 3 L 10 17" stroke="${CLR.stroke}" stroke-width="1.5"/>
  </marker>
  <!-- Conditional flow: open diamond at source (OMG spec Fig 10.48) -->
  <marker id="seq-conditional-src" viewBox="0 0 20 20" refX="1" refY="10"
    markerWidth="12" markerHeight="12" orient="auto">
    <path d="M 1 10 L 8 6 L 15 10 L 8 14 Z" fill="${CLR.fill}" stroke="${CLR.stroke}" stroke-width="1"/>
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
    // Lane header band
    const lhw = laneHeaderW(poolCoords, laneToPoolKey[lane.id]);
    out.push(`<rect x="${tx(lcc.x - lhw)}" y="${ty(lcc.y)}" width="${lhw}" height="${lcc.h}" fill="${CLR.laneHeader}" stroke="${CLR.stroke}" stroke-width="${SW.lane}"/>`);
    const lcx = tx(lcc.x - lhw) + lhw / 2;
    const lcy = ty(lcc.y) + lcc.h / 2;
    const rendered = lane._renderedLines;
    if (!rendered || rendered.length <= 1) {
      // Single-line (backwards compatible — refinement off or short label)
      out.push(`<text x="${lcx}" y="${lcy}" text-anchor="middle" dominant-baseline="middle" font-size="11" fill="${CLR.label}" transform="rotate(-90,${lcx},${lcy})">${esc(lane.name || lane.id)}</text>`);
    } else {
      // Multi-line (refinement on, label wrapped)
      const LINE_H = 14; // FONT_SIZE (11) + LINE_GAP (3), matches visual-refinement.js
      const N = rendered.length;
      for (let i = 0; i < N; i++) {
        const yOffset = (i - (N - 1) / 2) * LINE_H;
        out.push(`<text x="${lcx}" y="${lcy + yOffset}" text-anchor="middle" dominant-baseline="middle" font-size="11" fill="${CLR.label}" transform="rotate(-90,${lcx},${lcy})">${esc(rendered[i])}</text>`);
      }
    }
  }

  // §7.6  Sequence flows
  for (const edge of allEdges) {
    const eid = edge.id || `flow_${edge.source}_${edge.target}`;
    const pts = edgeCoords[eid] || [];
    renderSequenceFlow(out, edge, pts, coords, tx, ty);
  }

  // §7.7  Message flows (dashed, orthogonal routing, OMG spec Fig 9.5)
  if (lc.messageFlows) {
    for (const mf of lc.messageFlows) {
      const srcCoord = coords[mf.source] || poolCoords[mf.source];
      const tgtCoord = coords[mf.target] || poolCoords[mf.target];
      if (!srcCoord || !tgtCoord) continue;

      // Source: bottom-center of shape; Target: top-center of shape
      const sx = tx((srcCoord.x || 0) + (srcCoord.w || 0) / 2);
      const sy = ty((srcCoord.y || 0) + (srcCoord.h || 0));
      const ex = tx((tgtCoord.x || 0) + (tgtCoord.w || 0) / 2);
      const ey = ty(tgtCoord.y || 0);

      // Determine if source is above or below target
      const goingDown = sy < ey;
      let pathD;

      if (Math.abs(sx - ex) < 2) {
        // Vertically aligned — straight line
        pathD = `M ${sx} ${sy} L ${ex} ${ey}`;
      } else {
        // Dog-leg: vertical → horizontal → vertical
        const midY = rn((sy + ey) / 2);
        pathD = `M ${sx} ${sy} L ${sx} ${midY} L ${ex} ${midY} L ${ex} ${ey}`;
      }

      out.push(`<path d="${pathD}" stroke="${CLR.stroke}" stroke-width="${SW.connection}" fill="none" stroke-dasharray="10,12" marker-start="url(#msg-start)" marker-end="url(#msg-end)"/>`);
      if (mf.name) {
        const mx = rn((sx + ex) / 2), my = rn((sy + ey) / 2);
        renderEdgeLabel(out, mf.name, mx, my);
      }
    }
  }

  // §7.8  Associations (dotted lines, OMG spec §7.2)
  const allAssociations = lc.associations || [];
  for (const assoc of allAssociations) {
    const srcC = coords[assoc.source];
    const tgtC = coords[assoc.target];
    if (!srcC || !tgtC) continue;
    const sx = tx(srcC.x + srcC.w / 2), sy = ty(srcC.y + srcC.h / 2);
    const ex = tx(tgtC.x + tgtC.w / 2), ey = ty(tgtC.y + tgtC.h / 2);
    const markerEnd = assoc.directed ? ` marker-end="url(#assoc-end)"` : '';
    out.push(`<path d="M ${sx} ${sy} L ${ex} ${ey}" stroke="${CLR.stroke}" stroke-width="1.5" fill="none" stroke-dasharray="0.5,5"${markerEnd}/>`);
  }

  // §7.9  Nodes
  for (const node of allNodes) {
    const c = coords[node.id];
    if (!c) continue;
    out.push(renderNode(node, c, tx, ty));

    // Expanded SubProcess: render child nodes + edges inside
    if (node.isExpanded && node.nodes) {
      for (const child of node.nodes) {
        const cc = coords[child.id];
        if (!cc) continue;
        out.push(renderNode(child, cc, tx, ty));
      }
      // Render internal sequence flows
      for (const subEdge of (node.edges || [])) {
        const seid = subEdge.id || `flow_${subEdge.source}_${subEdge.target}`;
        const pts = edgeCoords[seid] || [];
        renderSequenceFlow(out, subEdge, pts, coords, tx, ty);
      }
    }
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

function renderSequenceFlow(out, edge, pts, coords, tx, ty) {
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
  const markerStart = edge.isDefault     ? `marker-start="url(#seq-default-src)"`
                    : edge.isConditional ? `marker-start="url(#seq-conditional-src)"`
                    : '';

  out.push(`<path d="${pathD}" stroke="${CLR.stroke}" stroke-width="${SW.connection}" fill="none" ${markerStart} ${markerEnd}/>`);

  // Edge label — position on first horizontal segment, 5px above edge
  if (edge.label) {
    let labelX, labelY;
    if (pts.length >= 2) {
      // Find first horizontal segment (dy ≈ 0)
      let placed = false;
      for (let i = 0; i < pts.length - 1; i++) {
        const dy = Math.abs(pts[i + 1].y - pts[i].y);
        if (dy < 1) {
          // Horizontal segment found — place at midpoint, 5px above
          labelX = tx((pts[i].x + pts[i + 1].x) / 2);
          labelY = ty(pts[i].y) - 5;
          placed = true;
          break;
        }
      }
      if (!placed) {
        // No horizontal segment: place at 30% from source, 5px above
        const p0 = pts[0], p1 = pts[pts.length - 1];
        labelX = tx(p0.x + (p1.x - p0.x) * 0.3);
        labelY = ty(p0.y + (p1.y - p0.y) * 0.3) - 5;
      }
    } else {
      const s = coords[edge.source], t = coords[edge.target];
      if (s && t) {
        labelX = tx((s.x + s.w/2 + t.x + t.w/2) / 2);
        labelY = ty((s.y + s.h/2 + t.y + t.h/2) / 2) - 5;
      }
    }
    if (labelX != null) renderEdgeLabel(out, edge.label, labelX, labelY);
  }
}

function renderEdgeLabel(out, label, midX, midY) {
  const w = label.length * 6.5 + 8;
  out.push(`<rect x="${rn(midX - w/2)}" y="${rn(midY - 8)}" width="${rn(w)}" height="16" rx="2" fill="white" fill-opacity="0.9"/>`);
  out.push(`<text x="${rn(midX)}" y="${rn(midY + 4)}" text-anchor="middle" font-size="10" fill="${CLR.label}">${esc(label)}</text>`);
}

// ─────────────────────────────────────────────────────────────────────
// NODE RENDERERS
// ─────────────────────────────────────────────────────────────────────
function renderNode(node, c, tx, ty) {
  const type = node.type || 'task';
  let svg;
  if (isEvent(type))         svg = renderEvent(node, c, tx, ty);
  else if (isGateway(type))  svg = renderGateway(node, c, tx, ty);
  else if (isDataArtifact(type)) svg = renderDataArtifact(node, c, tx, ty);
  else                       svg = renderActivity(node, c, tx, ty);
  if (node.documentation) {
    svg = `<g><title>${esc(node.documentation)}</title>\n${svg}\n</g>`;
  }
  return svg;
}

// ── Events (OMG spec §10.4) ─────────────────────────────────────────
function renderEvent(node, c, tx, ty) {
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
  const isNonInterrupting = node.isInterrupting === false || node.cancelActivity === false;

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

  // External label below shape
  const labelY = ty(c.y + c.h) + LABEL_DISTANCE;
  o.push(renderExternalLabel(node.name || '', cx, labelY, 90));

  return o.join('\n');
}

// ── Gateways (OMG spec §10.5) ───────────────────────────────────────
function renderGateway(node, c, tx, ty) {
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
    // Circle + pentagon (OMG spec Fig 10.73)
    o.push(`<circle cx="${cx}" cy="${cy}" r="${rn(h * 0.22)}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`);
    o.push(renderPentagon(cx, cy, h * 0.14, stroke));
  } else if (type === 'complexGateway') {
    // Asterisk (OMG spec Fig 10.67)
    for (const a of [0, 45, 90, 135]) {
      const rad = a * Math.PI / 180;
      const ddx = Math.cos(rad) * d, ddy = Math.sin(rad) * d;
      o.push(`<line x1="${rn(cx-ddx)}" y1="${rn(cy-ddy)}" x2="${rn(cx+ddx)}" y2="${rn(cy+ddy)}" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round"/>`);
    }
  }

  // External label below diamond
  const labelY = ty(c.y + c.h) + LABEL_DISTANCE;
  o.push(renderExternalLabel(node.name || '', cx, labelY, 90));

  return o.join('\n');
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
  const icon = renderTaskIcon(type, x, y);
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
  // Collapsed subprocess [+] (OMG spec Fig 10.17)
  if (node.type === 'subProcess' || node.type === 'callActivity') {
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
function renderDataArtifact(node, c, tx, ty) {
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
    // Label below
    o.push(renderExternalLabel(node.name || '', cx, ty(c.y + c.h) + 5, 70));
  } else if (type === 'dataStoreReference') {
    // Data store: cylinder (OMG spec Fig 10.85)
    const ry = 6;
    o.push(`<ellipse cx="${cx}" cy="${y+ry}" rx="${w/2}" ry="${ry}" fill="${fill}" stroke="${stroke}" stroke-width="${SW.dataObject}"/>`);
    o.push(`<path d="M ${x},${y+ry} L ${x},${y+h-ry}" stroke="${stroke}" stroke-width="${SW.dataObject}" fill="none"/>`);
    o.push(`<path d="M ${x+w},${y+ry} L ${x+w},${y+h-ry}" stroke="${stroke}" stroke-width="${SW.dataObject}" fill="none"/>`);
    o.push(`<ellipse cx="${cx}" cy="${y+h-ry}" rx="${w/2}" ry="${ry}" fill="${fill}" stroke="${stroke}" stroke-width="${SW.dataObject}"/>`);
    o.push(renderExternalLabel(node.name || '', cx, ty(c.y + c.h) + 5, 70));
  } else if (type === 'textAnnotation') {
    // Open bracket [ shape (OMG spec Fig 10.86)
    o.push(`<path d="M ${x+15},${y} L ${x},${y} L ${x},${y+h} L ${x+15},${y+h}" fill="none" stroke="${stroke}" stroke-width="${SW.annotation}"/>`);
    o.push(`<text x="${x+20}" y="${rn(y+h/2+4)}" font-size="11" fill="${CLR.label}">${esc(node.name || '')}</text>`);
  } else if (type === 'group') {
    // Dashed rounded rectangle (OMG spec Fig 10.88)
    o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" ry="10" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-dasharray="8,4,2,4"/>`);
    o.push(`<text x="${cx}" y="${rn(y-5)}" text-anchor="middle" font-size="12" font-weight="bold" fill="${CLR.label}">${esc(node.name || '')}</text>`);
  }

  return o.join('\n');
}

function renderExternalLabel(text, cx, y, maxW) {
  if (!text) return '';
  const lines = wrapText(text, Math.floor(maxW / 6));
  return lines.map((line, i) =>
    `<text x="${cx}" y="${rn(y + i*13 + 10)}" text-anchor="middle" font-size="11" fill="${CLR.label}">${esc(line)}</text>`
  ).join('\n');
}

export { generateSvg };
