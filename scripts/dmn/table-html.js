/**
 * Decision tables as HTML — a translation of table.js's layout into `<table>` elements with inline
 * styles only (no stylesheet, no script), so the markup survives being pasted into a wiki page
 * such as Confluence. Same content and look as table-svg.js: title and hit policy above the table,
 * three-line head cells ("When"/"And"/"Then", label, allowed values or type), the hit-policy
 * indicator over the rule numbers, a double line between inputs and outputs, input columns blue,
 * output columns green, the rule-number column grey.
 *
 * Column widths come from the model's geometry (`<col style="width:…px">`); the browser lays out
 * the text itself, which is what HTML is for. Colours and sizes: `config.json → dmn.table`. Every
 * text through esc().
 *
 * Signature: generateTablesHtml(stack, { title }) -> string, `stack` = layoutDecisionTables(dc).
 */

import { esc } from '../shared/utils.js';
import { DMN_TABLE_STYLE as S } from './constants.js';

const fill = (role, head) => esc(
  role === 'input' ? (head ? S.inputHeadFill : S.inputCellFill)
    : role === 'output' ? (head ? S.outputHeadFill : S.outputCellFill)
      : role === 'index' ? S.indexFill : S.annotationFill);

function cellStyle(col, head, isDivider) {
  const left = isDivider ? `${S.doubleLineGap}px double ${esc(S.border)}` : `1px solid ${esc(S.border)}`;
  const bottom = head ? `${S.doubleLineGap}px double ${esc(S.headBorder)}` : `1px solid ${esc(S.border)}`;
  const align = col.role === 'index' ? 'center' : 'left';
  return `background:${fill(col.role, head)};border-left:${left};border-bottom:${bottom};padding:${S.cellPadding}px;`
    + `vertical-align:top;text-align:${align};font-size:${S.cell.fontSize}px;`;
}

function headCell(col, isDivider) {
  if (col.role === 'index') {
    return `<th style="${cellStyle(col, true, false)}font-weight:bold;vertical-align:middle;">${esc(col.label)}</th>`;
  }
  const parts = [];
  if (col.clause) parts.push(`<div style="font-size:${S.clause.fontSize}px;color:${esc(S.subtleColor)};text-align:left;font-weight:normal;">${esc(col.clause)}</div>`);
  parts.push(`<div style="font-size:${S.head.fontSize}px;text-align:center;font-weight:normal;">${esc(col.label)}</div>`);
  if (col.detail) parts.push(`<div style="font-size:${S.type.fontSize}px;color:${esc(S.subtleColor)};text-align:right;font-weight:normal;">${esc(col.detail)}</div>`);
  return `<th style="${cellStyle(col, true, isDivider)}">${parts.join('')}</th>`;
}

function renderTable(model) {
  const { columns, rows, geometry: g } = model;
  const dividerIndex = columns.findIndex((c) => c.x === g.ioDividerX);
  const out = [];
  out.push(`<div style="margin:0 0 ${S.stackGap}px 0;">`);
  out.push(`<div style="border:1px solid ${esc(S.border)};border-bottom:none;padding:${S.title.padding}px;width:${g.w}px;box-sizing:border-box;background:${esc(S.background)};">`);
  out.push(`<div style="font-size:${S.title.fontSize}px;">${esc(model.name)}</div>`);
  out.push(`<div style="font-size:${S.hitPolicy.fontSize}px;color:${esc(S.subtleColor)};">${esc(model.hitPolicyText)}</div>`);
  out.push('</div>');
  out.push(`<table style="border-collapse:collapse;table-layout:fixed;width:${g.w}px;border:1px solid ${esc(S.border)};color:${esc(S.color)};font-family:${esc(S.fontFamily)};">`);
  out.push(`<colgroup>${columns.map((c) => `<col style="width:${c.w}px;">`).join('')}</colgroup>`);
  out.push(`<thead><tr>${columns.map((c, i) => headCell(c, i === dividerIndex)).join('')}</tr></thead>`);
  out.push('<tbody>');
  for (const row of rows) {
    const cells = row.cells.map((cell, i) => {
      const color = cell.any ? `color:${esc(S.subtleColor)};` : '';
      return `<td style="${cellStyle(columns[i], false, i === dividerIndex)}${color}">${esc(cell.text)}</td>`;
    });
    out.push(`<tr>${cells.join('')}</tr>`);
  }
  out.push('</tbody></table></div>');
  return out.join('\n');
}

/**
 * @param {{ tables: object[] }} stack - layoutDecisionTables' result
 * @param {object} [opts]
 * @param {string} [opts.title] - the document title (the Decision-Core's name)
 * @returns {string} a complete HTML document
 */
export function generateTablesHtml(stack, { title = '' } = {}) {
  return [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8">',
    `<title>${esc(title)}</title>`,
    '</head>',
    `<body style="margin:${S.margin}px;font-family:${esc(S.fontFamily)};color:${esc(S.color)};background:${esc(S.background)};">`,
    ...stack.tables.map(renderTable),
    '</body></html>',
    '',
  ].join('\n');
}
