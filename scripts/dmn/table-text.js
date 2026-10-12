/**
 * Decision tables as text — two small, isolated formatters over the one table model of table.js.
 *
 *   formatTableMarkdown(model)  — a GitHub-flavoured pipe table for chat and the `--doc` Markdown:
 *       heading with the decision name, the hit policy spelled out, then one header row
 *       ("U" over the rule numbers, "When: <label> *(<values|type>)*", "And: …", "Then: …",
 *       "Annotation" only when a rule has one) and one row per rule, "–" for "any".
 *   formatTablePlainText(model) — the plain-text form for a BPMN `documentation` (plain text in
 *       bpmn.io and Camunda Modeler): an aligned table with a group line "WHEN … || THEN …" and
 *       "||" between inputs and outputs; when that is wider than `dmn.table.plainTextMaxWidth`
 *       characters, one sentence per rule instead ("Rule 1: WHEN … AND … THEN … = …").
 *
 * Words only: what a column is called, what "any" reads as and how the hit policy is spelled out
 * all come from the model (table.js), which takes them from `config.json → dmn.labels`.
 */

import { DMN_TABLE_STYLE } from './constants.js';
import { oneLine } from './table.js';

// ── Markdown ─────────────────────────────────────────────────────────────────────────────────

/**
 * Escape a text for a Markdown table cell: a line break becomes a space, and the characters that
 * would end the cell or start emphasis, code or an HTML tag are backslash-escaped.
 */
export function escapeMarkdownCell(text) {
  return oneLine(text)
    .replace(/[\\`*_|]/g, (c) => `\\${c}`)
    .replace(/<(?=[A-Za-z/!?])/g, '\\<');
}

function markdownHeader(col) {
  if (col.role === 'index') return escapeMarkdownCell(col.label);
  const label = escapeMarkdownCell(col.label);
  const head = col.clause ? `${escapeMarkdownCell(col.clause)}: ${label}` : label;
  return col.detail ? `${head} *(${escapeMarkdownCell(col.detail)})*` : head;
}

/**
 * @param {object} model - layoutDecisionTable's result
 * @param {object} [opts]
 * @param {number} [opts.headingLevel=3] - Markdown heading level of the decision name; 0 for none
 * @returns {string}
 */
export function formatTableMarkdown(model, { headingLevel = 3 } = {}) {
  const { columns, rows, labels, hitPolicy } = model;
  const out = [];
  if (headingLevel > 0) out.push(`${'#'.repeat(headingLevel)} ${escapeMarkdownCell(model.name)}`, '');
  const meaning = hitPolicy.orderMatters ? `${hitPolicy.meaning} (${labels.orderMatters})` : hitPolicy.meaning;
  // The aggregation indicator (C+, C#, C<, C>) in backticks — its symbol would otherwise read as
  // Markdown or as an operator.
  const code = hitPolicy.aggregation ? `\`${hitPolicy.code}\`` : hitPolicy.code;
  out.push(`${labels.hitPolicy}: **${hitPolicy.policy} (${code})** – ${meaning}`, '');
  out.push(`| ${columns.map(markdownHeader).join(' | ')} |`);
  out.push(`|${columns.map((c) => (c.role === 'index' ? '--:' : ':--')).join('|')}|`);
  for (const row of rows) {
    out.push(`| ${row.cells.map((c) => escapeMarkdownCell(c.text)).join(' | ')} |`);
  }
  return out.join('\n');
}

// ── Plain text ───────────────────────────────────────────────────────────────────────────────

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].length));

/** The aligned table, line by line; `null` when one of its lines is wider than `maxWidth`. */
function alignedTable(model, maxWidth) {
  const { columns, rows, labels } = model;
  const firstInput = columns.findIndex((c) => c.role === 'input');
  const firstOutput = columns.findIndex((c) => c.role === 'output');
  const group = columns.map((c, i) => (i === firstInput ? labels.whenGroup : i === firstOutput ? labels.thenGroup : ''));
  const head = columns.map((c) => oneLine(c.label));
  const detail = columns.map((c) => oneLine(c.detail));
  const body = rows.map((r) => r.cells.map((c) => oneLine(c.text)));
  const all = [group, head, detail, ...body];
  const widths = columns.map((_, i) => Math.max(...all.map((line) => [...line[i]].length)));

  // Trailing empty cells are dropped with their separators, so no line ends in a bare '|'.
  const join = (cells) => {
    let last = cells.length - 1;
    while (last > 0 && !cells[last]) last--;
    return cells.slice(0, last + 1).map((cell, i) => {
      const sep = i === 0 ? '' : (i === firstOutput ? ' || ' : ' | ');
      return sep + pad(cell, widths[i]);
    }).join('').trimEnd();
  };
  const rule = columns.map((_, i) => {
    const sep = i === 0 ? '' : (i === firstOutput ? '-++-' : '-+-');
    return sep + '-'.repeat(widths[i]);
  }).join('');

  const lines = [join(group), join(head)];
  if (detail.some(Boolean)) lines.push(join(detail));
  lines.push(rule, ...body.map(join));
  return lines.some((l) => [...l].length > maxWidth) ? null : lines;
}

/** "Claim amount < 1000", "Segment = \"premium\"", "Amount in [1000..10000)". */
function condition(label, test) {
  const t = oneLine(test).trim();
  if (/^(<=|>=|<|>|=|!=)/.test(t)) return `${label} ${t}`;
  if (/^[[(\]]/.test(t) || /,/.test(t) || /^not\s*\(/.test(t)) return `${label} in ${t}`;
  return `${label} = ${t}`;
}

function sentences(model) {
  const { columns, rows, labels } = model;
  return rows.map((row) => {
    const conds = [];
    const results = [];
    const notes = [];
    row.cells.forEach((cell, i) => {
      const col = columns[i];
      if (col.role === 'input' && !cell.any) conds.push(condition(oneLine(col.label), cell.text));
      if (col.role === 'output') results.push(col.label ? `${oneLine(col.label)} = ${oneLine(cell.text)}` : oneLine(cell.text));
      if (col.role === 'annotation' && cell.text.trim()) notes.push(oneLine(cell.text));
    });
    const when = conds.length ? `${labels.whenGroup} ${conds.join(` ${labels.andGroup} `)} ` : '';
    const note = notes.length ? ` (${notes.join('; ')})` : '';
    return `${labels.rule} ${row.index}: ${when}${labels.thenGroup} ${results.join(` ${labels.andGroup} `)}${note}`;
  });
}

/**
 * @param {object} model - layoutDecisionTable's result
 * @param {object} [opts]
 * @param {number} [opts.maxWidth] - default `config.json → dmn.table.plainTextMaxWidth`
 * @returns {string[]} lines, without the title (the caller writes its own)
 */
export function formatTablePlainText(model, { maxWidth = DMN_TABLE_STYLE.plainTextMaxWidth } = {}) {
  return alignedTable(model, maxWidth) ?? sentences(model);
}

