/**
 * DMN decision table layout — computed ONCE, translated by every table renderer.
 *
 * `layoutDecisionTable(node, opts)` turns one Decision-Core decision with a `decisionTable` into a
 * table model: the hit policy (DMN 1.3 letter, aggregation, spelled-out name and one-line meaning),
 * the columns (rule number, inputs, outputs, annotations) with their three-line headers as dmn-js
 * 17.12.3 draws them (`DecisionTableHead`: clause word "When"/"And"/"Then", the label — or the
 * expression when there is no label — and, small, the allowed values or else the type), the rows,
 * and the geometry of every box: column widths from text metrics (../shared/text-layout.js, the
 * same Arial measurement and diagram-js line breaking the DRD and BPMN renderers use), row heights
 * from the wrapped lines.
 *
 * The renderers only translate this model, the same contract as a diagram's coordMap:
 *   - table-text.js  — Markdown (pipe table) and plain text (BPMN documentation) — words only;
 *   - table-svg.js   — the decision tables as SVG, every box from `geometry`;
 *   - table-html.js  — the decision tables as an HTML <table>, widths from `geometry`.
 * None of them measures text, chooses a width or decides what a column is called.
 *
 * Every word comes from `config.json → dmn.labels[locale]` (dmnLabels), every size and colour from
 * `config.json → dmn.table`.
 */

import { layoutText, lineWidth } from '../shared/text-layout.js';
import {
  DMN_TABLE_STYLE, HIT_POLICY_CODE, AGGREGATION_CODE, ORDER_SENSITIVE_HIT_POLICIES, dmnLabels,
} from './constants.js';

/** An input entry that does not constrain its input (DMN 1.3: `-`, or an empty unary test). */
export function isAnyEntry(text) {
  const t = String(text ?? '').trim();
  return t === '' || t === '-';
}

/** One-line text: every run of whitespace containing a line break becomes a single space. */
export function oneLine(text) {
  return String(text ?? '').replace(/\s*[\r\n]+\s*/g, ' ');
}

/**
 * The hit policy of a table, spelled out: `{ policy, aggregation, code, name, meaning, orderMatters }`.
 * `code` is the DMN 1.3 indicator — a letter, plus `+ # < >` for an aggregated COLLECT.
 */
export function describeHitPolicy(table, labels = dmnLabels()) {
  const policy = table.hitPolicy ?? 'UNIQUE';
  const aggregation = policy === 'COLLECT' && table.aggregation ? table.aggregation : null;
  const code = HIT_POLICY_CODE[policy] + (aggregation ? AGGREGATION_CODE[aggregation] : '');
  const words = labels.hitPolicies[policy];
  const meaning = aggregation ? labels.aggregations[aggregation] : words.meaning;
  return { policy, aggregation, code, name: words.name, meaning, orderMatters: ORDER_SENSITIVE_HIT_POLICIES.has(policy) };
}

/** "Hit policy: UNIQUE (U) – exactly one rule can match" — the line under a table's title. */
export function hitPolicyLine(hp, labels = dmnLabels(), { strong = (s) => s, code = (s) => s } = {}) {
  const meaning = hp.orderMatters ? `${hp.meaning} (${labels.orderMatters})` : hp.meaning;
  return `${labels.hitPolicy}: ${strong(`${hp.policy} (${code(hp.code)})`)} – ${meaning}`;
}

function styleOf(key) {
  const s = DMN_TABLE_STYLE[key];
  return { fontSize: s.fontSize, lineHeight: s.lineHeight ?? 1.2 };
}

/** Lines of `text` wrapped into `width` px (no wrapping when width is Infinity). */
function wrap(text, key, width) {
  const { fontSize, lineHeight } = styleOf(key);
  return layoutText(oneLine(text), { fontSize, lineHeight, wrapWidth: width }).lines;
}

const natural = (text, key) => lineWidth(oneLine(text), DMN_TABLE_STYLE[key].fontSize);
const lineH = (key) => { const s = styleOf(key); return s.fontSize * s.lineHeight; };

/**
 * The columns of a table, without geometry: role, header words and every body text.
 */
function tableColumns(table, hp, labels) {
  const inputs = table.inputs ?? [];
  const outputs = table.outputs ?? [];
  const rules = table.rules ?? [];
  const annotationClauses = table.annotations ?? [];
  const anyAnnotation = rules.some((r) => (r.annotations ?? []).some((a) => String(a ?? '').trim() !== ''));

  const columns = [{
    role: 'index', clause: '', label: hp.code, detail: '',
    cells: rules.map((_, i) => String(i + 1)),
  }];
  inputs.forEach((input, i) => columns.push({
    role: 'input',
    clause: i === 0 ? labels.whenClause : labels.andClause,
    label: input.label || input.expression || '',
    detail: input.allowedValues || input.typeRef || '',
    cells: rules.map((r) => (isAnyEntry(r.when?.[i]) ? labels.any : String(r.when[i]))),
    any: rules.map((r) => isAnyEntry(r.when?.[i])),
  }));
  outputs.forEach((output, i) => columns.push({
    role: 'output',
    clause: i === 0 ? labels.thenClause : labels.andClause,
    // An output without a name is the table's only output (the schema requires names on more
    // than one); dmn-js then shows the table's outputLabel, else nothing.
    label: output.name || table.outputLabel || '',
    detail: output.allowedValues || output.typeRef || '',
    cells: rules.map((r) => String(r.then?.[i] ?? '')),
  }));
  if (anyAnnotation) {
    const count = Math.max(1, annotationClauses.length);
    for (let i = 0; i < count; i++) {
      const name = annotationClauses[i]?.name;
      columns.push({
        role: 'annotation', clause: '',
        label: count === 1 ? labels.annotation : (name || labels.annotation),
        detail: '',
        cells: rules.map((r) => String(r.annotations?.[i] ?? '')),
      });
    }
  }
  return columns;
}

/**
 * Lay out one decision table.
 *
 * @param {object} node - a Decision-Core `decision` node carrying `decisionTable`
 * @param {object} [opts]
 * @param {number} [opts.x=0], [opts.y=0] - top-left corner of the table's title box
 * @param {string} [opts.locale] - label locale, default `config.json → dmn.labels.locale`
 * @returns {object} the table model (see the module doc)
 */
export function layoutDecisionTable(node, { x = 0, y = 0, locale } = {}) {
  const table = node.decisionTable;
  if (!table) throw new Error(`layoutDecisionTable: decision "${node.id}" has no decisionTable`);
  const labels = dmnLabels(locale);
  const S = DMN_TABLE_STYLE;
  const pad = S.cellPadding;
  const hp = describeHitPolicy(table, labels);
  const columns = tableColumns(table, hp, labels);
  const ruleCount = (table.rules ?? []).length;

  // ── Column widths: the widest text the column holds, clamped ──────────────────────────────
  for (const col of columns) {
    if (col.role === 'index') { col.w = S.indexWidth; continue; }
    const want = Math.max(
      natural(col.clause, 'clause'),
      natural(col.label, 'head'),
      natural(col.detail, 'type'),
      ...col.cells.map((t) => natural(t, 'cell')),
    ) + 2 * pad + 2; // +2: the measureSlack bpmn/coordinates.js keeps for Text.js's strict `<`
    col.w = Math.ceil(Math.min(S.maxColumnWidth, Math.max(S.minColumnWidth, want)));
  }
  let cx = x;
  for (const col of columns) { col.x = cx; cx += col.w; }
  const tableW = cx - x;

  // ── Title box: decision name, then the hit policy spelled out ─────────────────────────────
  const tPad = S.title.padding;
  const titleLines = wrap(node.name ?? node.id, 'title', Math.max(tableW - 2 * tPad, 1));
  const policyText = hitPolicyLine(hp, labels);
  const policyLines = wrap(policyText, 'hitPolicy', Math.max(tableW - 2 * tPad, 1));
  const titleH = Math.max(S.title.height,
    Math.ceil(2 * tPad + titleLines.length * lineH('title') + policyLines.length * lineH('hitPolicy')));
  const title = { x, y, w: tableW, h: titleH, nameLines: titleLines, policyLines, padding: tPad };

  // ── Head: clause word, label (at most head.maxLines lines), detail ────────────────────────
  for (const col of columns) {
    const inner = col.w - 2 * pad;
    col.clauseLines = col.clause ? wrap(col.clause, 'clause', inner) : [];
    const labelLines = wrap(col.label, 'head', inner);
    // dmn-js clamps a header label to three lines (`-webkit-line-clamp: 3`) with an ellipsis.
    col.labelLines = labelLines.length > S.head.maxLines
      ? [...labelLines.slice(0, S.head.maxLines - 1), `${labelLines[S.head.maxLines - 1]}…`]
      : labelLines;
    col.detailLines = col.detail ? wrap(col.detail, 'type', inner) : [];
  }
  const headInner = Math.max(...columns.map((c) =>
    c.clauseLines.length * lineH('clause') + c.labelLines.length * lineH('head') + c.detailLines.length * lineH('type')));
  const headY = y + titleH;
  const headH = Math.ceil(headInner + 2 * pad);
  for (const col of columns) col.head = { x: col.x, y: headY, w: col.w, h: headH };

  // ── Rows ──────────────────────────────────────────────────────────────────────────────────
  const rows = [];
  let ry = headY + headH;
  for (let r = 0; r < ruleCount; r++) {
    const cells = columns.map((col) => ({
      role: col.role, text: col.cells[r], any: col.any?.[r] ?? false,
      lines: wrap(col.cells[r], 'cell', col.w - 2 * pad),
    }));
    const h = Math.ceil(Math.max(...cells.map((c) => c.lines.length)) * lineH('cell') + 2 * pad);
    cells.forEach((c, i) => Object.assign(c, { x: columns[i].x, y: ry, w: columns[i].w, h }));
    rows.push({ index: r + 1, y: ry, h, cells, documentation: table.rules[r].documentation ?? null });
    ry += h;
  }

  const firstOutput = columns.findIndex((c) => c.role === 'output');
  return {
    decisionId: node.id,
    name: node.name ?? node.id,
    question: node.question ?? null,
    hitPolicy: hp,
    hitPolicyText: policyText,
    labels,
    columns,
    rows,
    geometry: {
      x, y, w: tableW, h: ry - y,
      title,
      head: { y: headY, h: headH },
      // x of the double line between the last input and the first output (dmn-js: 3px double).
      ioDividerX: firstOutput > 0 ? columns[firstOutput].x : null,
    },
  };
}

/** Every decision of a Decision-Core that carries a decision table, in document order. */
export function decisionsWithTables(dc) {
  return (dc.nodes ?? []).filter((n) => n.type === 'decision' && n.decisionTable);
}

/**
 * All decision tables of a Decision-Core stacked top to bottom, `dmn.table.stackGap` apart, inside
 * a `dmn.table.margin` frame: `{ size: { w, h }, tables: [model…] }`. Each model's geometry is
 * already absolute on that canvas.
 */
export function layoutDecisionTables(dc, { locale } = {}) {
  const S = DMN_TABLE_STYLE;
  const tables = [];
  let y = S.margin;
  for (const node of decisionsWithTables(dc)) {
    const model = layoutDecisionTable(node, { x: S.margin, y, locale });
    tables.push(model);
    y += model.geometry.h + S.stackGap;
  }
  const w = Math.max(0, ...tables.map((t) => t.geometry.w)) + 2 * S.margin;
  const h = tables.length ? y - S.stackGap + S.margin : 2 * S.margin;
  return { size: { w, h }, tables };
}
