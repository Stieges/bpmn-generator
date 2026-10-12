/**
 * Decision tables as SVG — a translation of table.js's layout, drawn the way dmn-js 17.12.3's
 * decision table view looks: a title box (decision name, hit policy spelled out), a head row whose
 * cells carry the clause word ("When"/"And"/"Then"), the label and, small, the allowed values or
 * the type, the hit-policy indicator over the rule numbers, a double line between the last input
 * and the first output and under the head, and one row per rule.
 *
 * Every box comes from the model's geometry; this module places text inside a box (first baseline
 * ¾ of a line below the top, as diagram-js's Text.js does) and chooses nothing else. Colours and
 * sizes: `config.json → dmn.table`. Every text through esc().
 *
 * Signature: generateTablesSvg(stack) -> string, `stack` = layoutDecisionTables(dc).
 */

import { esc, rn } from '../shared/utils.js';
import { DMN_TABLE_STYLE as S } from './constants.js';

const FIRST_BASELINE = 0.75;
const C = new Proxy({}, { get: (_, k) => esc(S[k]) });

function textBlock(lines, key, x, top, anchor, fill, extra = '') {
  const { fontSize } = S[key];
  const lh = fontSize * (S[key].lineHeight ?? 1.2);
  return lines.map((line, i) =>
    `<text x="${rn(x)}" y="${rn(top + FIRST_BASELINE * lh + i * lh)}" font-size="${fontSize}" text-anchor="${anchor}" fill="${fill}"${extra}>${esc(line)}</text>`);
}

const lh = (key) => S[key].fontSize * (S[key].lineHeight ?? 1.2);

function headFill(role) {
  return role === 'input' ? C.inputHeadFill : role === 'output' ? C.outputHeadFill : role === 'index' ? C.indexFill : C.annotationFill;
}
function cellFill(role) {
  return role === 'input' ? C.inputCellFill : role === 'output' ? C.outputCellFill : role === 'index' ? C.indexFill : C.annotationFill;
}

function line(x1, y1, x2, y2, stroke, width = 1) {
  return `<line x1="${rn(x1)}" y1="${rn(y1)}" x2="${rn(x2)}" y2="${rn(y2)}" stroke="${stroke}" stroke-width="${width}"/>`;
}

/** Two parallel 1 px lines `doubleLineGap` apart — CSS `3px double`. */
function doubleLine(x1, y1, x2, y2, stroke) {
  const g = S.doubleLineGap / 2;
  return x1 === x2
    ? [line(x1 - g, y1, x2 - g, y2, stroke), line(x1 + g, y1, x2 + g, y2, stroke)]
    : [line(x1, y1 - g, x2, y2 - g, stroke), line(x1, y1 + g, x2, y2 + g, stroke)];
}

function renderTable(model) {
  const { geometry: g, columns, rows } = model;
  const pad = S.cellPadding;
  const out = [`<g class="dmn-decision-table" data-element-id="${esc(model.decisionId)}">`];

  // Title box
  const t = g.title;
  out.push(`<rect x="${rn(t.x)}" y="${rn(t.y)}" width="${rn(t.w)}" height="${rn(t.h)}" fill="${C.background}" stroke="${C.border}"/>`);
  out.push(...textBlock(t.nameLines, 'title', t.x + t.padding, t.y + t.padding, 'start', C.color));
  out.push(...textBlock(t.policyLines, 'hitPolicy', t.x + t.padding, t.y + t.padding + t.nameLines.length * lh('title'), 'start', C.subtleColor));

  // Head cells
  for (const col of columns) {
    const h = col.head;
    out.push(`<rect class="dmn-head ${col.role}" x="${rn(h.x)}" y="${rn(h.y)}" width="${rn(h.w)}" height="${rn(h.h)}" fill="${headFill(col.role)}"/>`);
    if (col.role === 'index') {
      out.push(...textBlock(col.labelLines, 'hitPolicy', h.x + h.w / 2, h.y + (h.h - lh('hitPolicy')) / 2, 'middle', C.color, ' font-weight="bold"'));
      continue;
    }
    let top = h.y + pad;
    out.push(...textBlock(col.clauseLines, 'clause', h.x + pad, top, 'start', C.subtleColor));
    top += col.clauseLines.length * lh('clause');
    out.push(...textBlock(col.labelLines, 'head', h.x + h.w / 2, top, 'middle', C.color));
    top += col.labelLines.length * lh('head');
    out.push(...textBlock(col.detailLines, 'type', h.x + h.w - pad, top, 'end', C.subtleColor));
  }

  // Body cells
  rows.forEach((row) => {
    for (const cell of row.cells) {
      out.push(`<rect class="dmn-cell ${cell.role}" x="${rn(cell.x)}" y="${rn(cell.y)}" width="${rn(cell.w)}" height="${rn(cell.h)}" fill="${cellFill(cell.role)}"/>`);
      const centred = cell.role === 'index';
      out.push(...textBlock(cell.lines, 'cell', centred ? cell.x + cell.w / 2 : cell.x + pad, cell.y + pad,
        centred ? 'middle' : 'start', cell.any ? C.subtleColor : C.color));
    }
  });

  // Grid: column and row separators, then the two double lines, then the frame.
  const top = g.head.y;
  const bottom = g.y + g.h;
  for (const col of columns.slice(1)) {
    if (col.x !== g.ioDividerX) out.push(line(col.x, top, col.x, bottom, C.border));
  }
  for (const row of rows.slice(1)) out.push(line(g.x, row.y, g.x + g.w, row.y, C.border));
  if (g.ioDividerX != null) out.push(...doubleLine(g.ioDividerX, top, g.ioDividerX, bottom, C.border));
  if (rows.length) out.push(...doubleLine(g.x, top + g.head.h, g.x + g.w, top + g.head.h, C.headBorder));
  out.push(`<rect x="${rn(g.x)}" y="${rn(top)}" width="${rn(g.w)}" height="${rn(bottom - top)}" fill="none" stroke="${C.border}"/>`);
  out.push('</g>');
  return out.join('\n');
}

/**
 * @param {{ size: {w:number,h:number}, tables: object[] }} stack - layoutDecisionTables' result
 * @returns {string} SVG document
 */
export function generateTablesSvg(stack) {
  const W = rn(stack.size.w);
  const H = rn(stack.size.h);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${C.fontFamily}">`,
    `<rect width="${W}" height="${H}" fill="${C.background}"/>`,
    ...stack.tables.map(renderTable),
    '</svg>',
  ].join('\n');
}
