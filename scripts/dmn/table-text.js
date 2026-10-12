/**
 * Decision tables as text — two small, isolated formatters over the one table model of table.js.
 *
 *   formatTableMarkdown(model)  — a GitHub-flavoured pipe table for chat and the `--doc` Markdown:
 *       heading with the decision name, the hit policy spelled out, then one header row
 *       ("U" over the rule numbers, "When: <label> *(<values|type>)*", "And: …", "Then: …",
 *       "Annotation" only when a rule has one) and one row per rule, "–" for "any".
 *   formatTablePlainText(model) — the plain-text form for a BPMN `documentation` (plain text in
 *       bpmn.io and Camunda Modeler): one sentence per rule, "Rule 1: WHEN <label> <test> AND …
 *       THEN <output> = <value> (<annotation>)", inputs that match anything left out. Sentences,
 *       not an aligned table: Camunda's properties panel shows documentation in a proportional
 *       font, where column alignment falls apart (owner decision, 2026-10-12).
 *
 * Words only: what a column is called, what "any" reads as and how the hit policy is spelled out
 * all come from the model (table.js), which takes them from `config.json → dmn.labels`.
 */

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

/**
 * One sentence per rule: "Rule 1: WHEN <label> <test> AND … THEN <output> = <value> (<annotation>)".
 * An input test is written as the table has it, after its column label ("Claim amount < 1000",
 * "Customer segment \"premium\"") — no operator is inserted, so no word outside the label table
 * appears and the unary test is not reinterpreted.
 */
function sentences(model) {
  const { columns, rows, labels } = model;
  return rows.map((row) => {
    const conds = [];
    const results = [];
    const notes = [];
    row.cells.forEach((cell, i) => {
      const col = columns[i];
      if (col.role === 'input' && !cell.any) conds.push(`${oneLine(col.label)} ${oneLine(cell.text).trim()}`);
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
 * @returns {string[]} one sentence per rule, without the title (the caller writes its own)
 */
export function formatTablePlainText(model) {
  return sentences(model);
}
