/**
 * DMN documentation as Markdown — the `--doc` companion of a `.dmn` file, mirroring
 * scripts/bpmn/pipeline.js's generateProcessDoc.
 *
 * One section per decision, in document order: heading, the question it answers, its inputs and
 * outputs, and the decision table (table-text.js formatTableMarkdown over the model table.js laid
 * out — the same model the table SVG and HTML translate) or, for a decision decided by a literal
 * expression, that expression.
 *
 * Signature: generateDmnMarkdown(dc, stack) -> string, `stack` = layoutDecisionTables(dc).
 */

import { dmnLabels } from './constants.js';
import { escapeMarkdownCell, formatTableMarkdown } from './table-text.js';
import { literalExpressionLine } from './table.js';

const code = (s) => `\`${String(s).replace(/`/g, 'ˋ')}\``;

function clauseList(items, nameOf) {
  return items.map((it) => {
    const name = nameOf(it);
    const extra = [it.typeRef, it.allowedValues].filter(Boolean).map(escapeMarkdownCell).join(', ');
    return `${escapeMarkdownCell(name)}${extra ? ` (${extra})` : ''}`;
  }).join('; ');
}

/**
 * @param {object} dc - Decision-Core JSON
 * @param {{ tables: object[] }} stack - layoutDecisionTables(dc)
 * @param {object} [opts]
 * @param {string} [opts.locale]
 * @returns {string}
 */
export function generateDmnMarkdown(dc, stack, { locale } = {}) {
  const labels = dmnLabels(locale);
  const modelById = new Map(stack.tables.map((m) => [m.decisionId, m]));
  const out = [`# ${escapeMarkdownCell(dc.name || dc.id || 'Decision model')}`];
  if (dc.documentation) out.push('', dc.documentation);

  for (const node of (dc.nodes ?? []).filter((n) => n.type === 'decision')) {
    out.push('', `## ${labels.decision}: ${escapeMarkdownCell(node.name)}`, '');
    if (node.question) out.push(`**${labels.question}:** ${escapeMarkdownCell(node.question)}`, '');
    if (node.documentation) out.push(node.documentation, '');
    const t = node.decisionTable;
    const model = modelById.get(node.id);
    if (t && model) {
      const inputs = t.inputs ?? [];
      if (inputs.length) out.push(`- **${labels.inputs}:** ${clauseList(inputs, (i) => i.label ? `${i.label} = ${i.expression}` : i.expression)}`);
      out.push(`- **${labels.outputs}:** ${clauseList(t.outputs ?? [], (o) => o.name || t.outputLabel || node.name)}`, '');
      out.push(formatTableMarkdown(model, { headingLevel: 0 }));
    } else if (node.expression != null) {
      out.push(`**${escapeMarkdownCell(literalExpressionLine(node.typeRef, labels))}:** ${code(node.expression)}`);
    }
  }
  return `${out.join('\n')}\n`;
}
