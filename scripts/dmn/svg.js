/*
 * The marker shapes and the per-shape path parameters follow dmn-js-drd 17.12.3
 * (lib/draw/DrdRenderer.js). Copyright (c) 2014-present Camunda Services GmbH, bpmn.io license
 * (MIT-based) — see THIRD_PARTY_NOTICES.md. The path data itself is in ./pathmap.js.
 */

/**
 * DMN SVG — the decision requirements diagram (DRD) as a standalone SVG.
 *
 * Signature: generateDmnSvg(dc, diagrams) -> string
 *
 * A renderer in the sense of CLAUDE.md's geometry contract: it TRANSLATES the diagram's coordMap
 * (`{ coords, edgeCoords }`, built by coordinates.js) and computes no coordinate of its own. The
 * diagram canvas is already anchored at (0,0) with its `size` (coordinates.js), so the SVG uses the
 * coordMap unchanged — not even an offset; dmn-xml.js writes the very same numbers into DMNDI, and
 * svg.test.js fences that the two agree.
 *
 * What it draws, the way dmn-js draws it from the same bounds:
 *   - decision: a rectangle; input data: a rectangle with 22 px corner radius (dmn-js's stadium);
 *     knowledge source: the wavy-bottom path; business knowledge model: the clipped-corner path
 *     (both from ./pathmap.js, at DrdRenderer's scale and start position);
 *   - the name centred in the shape, broken by diagram-js's Text.js rule (../shared/text-layout.js)
 *     at 12 px with 5 px padding — text layout, not geometry, exactly as bpmn/svg.js lays out a
 *     task name;
 *   - information requirement: solid line, filled arrow head; knowledge requirement: dashed line,
 *     open chevron; authority requirement: dashed line, filled circle — line and marker styles from
 *     `config.json → dmn.edge` (DrdRenderer's createMarker values).
 *
 * The first diagram only: Decision-Core produces exactly one today (coordinates.js); a second view
 * would be a second SVG, not a second layer of this one.
 */

import { esc, rn } from '../shared/utils.js';
import { layoutText } from '../shared/text-layout.js';
import { DRD_EDGE, DRD_RENDER } from './constants.js';
import { DRD_GLYPH, DRD_CORNER_RADIUS, drdScaledPath } from './pathmap.js';
import { requirementKey, orderedRequirements } from './requirement-order.js';

/** diagram-js Text.js: the first baseline sits ¾ of a line height below the text block's top. */
const FIRST_BASELINE = 0.75;

function markerDef(kind) {
  const { marker } = DRD_EDGE[kind];
  const stroke = esc(DRD_EDGE[kind].line.stroke);
  const size = rn(20 * marker.scale);
  // dmn-js's addMarker: a marker element without a dash pattern gets 10000,1 (a browser bug fix
  // for markers inheriting the line's dash) — the same here, so a dashed line has a solid head.
  const solid = 'stroke-dasharray="10000, 1"';
  let el;
  if (marker.shape === 'circle') {
    el = `<circle cx="${marker.cx}" cy="${marker.cy}" r="${marker.r}" fill="${stroke}" stroke="none" ${solid}/>`;
  } else if (marker.filled) {
    el = `<path d="${esc(marker.path)}" fill="${stroke}" stroke="none" ${solid}/>`;
  } else {
    el = `<path d="${esc(marker.path)}" fill="none" stroke="${stroke}" stroke-width="${marker.strokeWidth ?? 1}" stroke-linecap="round" ${solid}/>`;
  }
  return `<marker id="dmn-${kind}-end" viewBox="0 0 20 20" refX="${marker.refX}" refY="${marker.refY}" markerWidth="${size}" markerHeight="${size}" orient="auto">${el}</marker>`;
}

/** The name of a DRG element, centred in its box (Text.js `center-middle`, padding 5). */
function shapeLabel(name, c) {
  const { fontSize, lineHeight, padding } = DRD_RENDER.label;
  const { lines } = layoutText(name ?? '', { fontSize, lineHeight, wrapWidth: c.w - 2 * padding });
  const lh = fontSize * lineHeight;
  const top = c.y + (c.h - lines.length * lh) / 2 + FIRST_BASELINE * lh;
  return lines.map((line, i) =>
    `<text x="${rn(c.x + c.w / 2)}" y="${rn(top + i * lh)}" text-anchor="middle" font-size="${fontSize}" fill="${esc(DRD_RENDER.stroke)}">${esc(line)}</text>`);
}

function shape(node, c) {
  const stroke = esc(DRD_RENDER.stroke);
  const fill = esc(DRD_RENDER.fill);
  const sw = DRD_RENDER.shapeStrokeWidth;
  const out = [`<g class="dmn-shape" data-element-id="${esc(node.id)}" data-type="${esc(node.type)}">`];
  if (node.documentation) out.push(`<title>${esc(node.documentation)}</title>`);
  const glyph = DRD_GLYPH[node.type];
  if (glyph) {
    const d = drdScaledPath(glyph.path, { ...glyph, containerWidth: c.w, containerHeight: c.h });
    out.push(`<path transform="translate(${rn(c.x)}, ${rn(c.y)})" d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);
  } else {
    const r = DRD_CORNER_RADIUS[node.type] ?? 0;
    out.push(`<rect x="${rn(c.x)}" y="${rn(c.y)}" width="${rn(c.w)}" height="${rn(c.h)}" rx="${r}" ry="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);
  }
  out.push(...shapeLabel(node.name, c));
  out.push('</g>');
  return out.join('\n');
}

function connection(req, pts) {
  const { line } = DRD_EDGE[req.type];
  const dash = line.dasharray ? ` stroke-dasharray="${esc(line.dasharray)}"` : '';
  const points = pts.map((p) => `${rn(p.x)},${rn(p.y)}`).join(' ');
  return `<polyline class="dmn-requirement" data-element-id="${esc(requirementKey(req))}" data-type="${esc(req.type)}" points="${points}" fill="none" stroke="${esc(line.stroke)}" stroke-width="${line.strokeWidth}"${dash} stroke-linecap="${esc(line.linecap)}" stroke-linejoin="${esc(line.linejoin)}" marker-end="url(#dmn-${req.type}-end)"/>`;
}

/**
 * @param {object} dc - Decision-Core JSON (node types, names and requirement kinds are read)
 * @param {Array<{ size: {w:number,h:number}, coordMap: { coords: object, edgeCoords: object } }>} diagrams
 *   - the result of coordinates.js buildDmnDiagrams
 * @returns {string} SVG document
 */
export function generateDmnSvg(dc, diagrams) {
  const diagram = diagrams?.[0];
  if (!diagram) throw new Error('generateDmnSvg: no diagram to render');
  const { coords, edgeCoords } = diagram.coordMap;
  const W = rn(diagram.size.w);
  const H = rn(diagram.size.h);

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${esc(DRD_RENDER.fontFamily)}">`);
  out.push(`<defs>\n${Object.keys(DRD_EDGE).map(markerDef).join('\n')}\n</defs>`);
  out.push(`<rect width="${W}" height="${H}" fill="${esc(DRD_RENDER.canvasBg)}"/>`);

  // Shapes first, connections on top — dmn-js's layer order, so an arrow head is never hidden
  // under the shape it points at.
  for (const node of dc.nodes ?? []) {
    const c = coords[node.id];
    if (c) out.push(shape(node, c));
  }
  for (const req of orderedRequirements(dc)) {
    const pts = edgeCoords[requirementKey(req)];
    if (pts?.length >= 2 && DRD_EDGE[req.type]) out.push(connection(req, pts));
  }
  out.push('</svg>');
  return out.join('\n');
}
