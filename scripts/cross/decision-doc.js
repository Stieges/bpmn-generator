/**
 * The decision table of a Business Rule Task, written into the task's `documentation`.
 *
 * BPMN draws no link to a DMN file, and bpmn.io / Camunda Modeler show a task's documentation as
 * plain text. So when the pipeline is given the decision models (`runPipeline(lc, { decisions })`,
 * CLI `--decisions`), every `businessRuleTask` with a `decisionRef` gets a generated section at the
 * end of its documentation:
 *
 *     <whatever the author wrote — kept, always before the section>
 *
 *     === BEGIN generated: DMN decision (bpmn-generator) — replaced on every run ===
 *     Decision: Approval level (dec_approvalLevel) — generated from Definitions_claimApproval
 *     Hit policy: UNIQUE (U) – exactly one rule can match
 *     Rule 1: WHEN Claim amount < 1000 THEN level = "auto"
 *     Rule 2: WHEN Claim amount in [1000..10000) AND Customer segment = "premium" THEN level = "clerk"
 *     …                                     (dmn/table-text.js formatTablePlainText)
 *     === END generated: DMN decision ===
 *
 * A decision decided by a literal expression gets its expression instead of a table:
 * "Literal expression (type: number): <FEEL text>".
 *
 * The two marker lines make the section findable again: both importers read documentation as text
 * and keep the section, and the next run REPLACES it (stripDecisionSection) instead of appending a
 * second one — import → regenerate is idempotent. A decisionRef no supplied model defines reads
 * "Calls decision: <ref> (table not supplied)"; one that more than one model defines names them.
 *
 * Which decision a task calls is decided by scripts/scenarios/bridge.js `resolveBridge` — the same
 * matching the scenario pipeline judges SC02/SC03 on, not a second copy of it — called with
 * `includeLiteralExpressions`, which the scenario pipeline leaves off, so its rules keep their
 * meaning while a task calling a literal-expression decision still gets that decision shown.
 *
 * Text, not geometry: nothing here touches a coordinate, so the geometry contract is untouched, and
 * without `decisions` the pipeline's output is byte-identical to before (the goldens and the
 * output-hash fence rely on that).
 */

import { resolveBridge, linkKey } from '../scenarios/bridge.js';
import { layoutDecisionTable, literalExpressionLine } from '../dmn/table.js';
import { formatTablePlainText } from '../dmn/table-text.js';
import { dmnLabels } from '../dmn/constants.js';
import { validateDecisionCoreSchema } from '../dmn/schema-gate.js';

export const DECISION_DOC_BEGIN = '=== BEGIN generated: DMN decision (bpmn-generator) — replaced on every run ===';
export const DECISION_DOC_END = '=== END generated: DMN decision ===';

/** A line of `text`, without the `\r` of a CRLF line ending. */
const bare = (line) => line.replace(/\r$/, '');

/**
 * Split `text` into author chunks and generated sections. A section starts at a line that IS the
 * BEGIN marker (whole-line equality — an author line that merely starts like it is author text) and
 * ends at the next line that IS the END marker. A BEGIN without its END (hand-truncated) ends at the
 * first blank line or the next BEGIN, whichever comes first — the generated section never contains a
 * blank line (decisionSection asserts it), so author text after a blank line is never eaten.
 *
 * @returns {{ chunks: string[][], sections: string[][] }} author chunks (lines) and section bodies
 *   (the lines between the markers)
 */
function splitSections(text) {
  const lines = String(text ?? '').split('\n');
  const chunks = [[]];
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    if (bare(lines[i]) !== DECISION_DOC_BEGIN) { chunks[chunks.length - 1].push(lines[i]); continue; }
    let j = i + 1;
    while (j < lines.length && bare(lines[j]) !== DECISION_DOC_END && bare(lines[j]) !== DECISION_DOC_BEGIN
      && bare(lines[j]).trim() !== '') j++;
    const closed = j < lines.length && bare(lines[j]) === DECISION_DOC_END;
    sections.push(lines.slice(i + 1, j).map(bare));
    i = closed ? j : j - 1;
    chunks.push([]);
  }
  return { chunks, sections };
}

/**
 * `text` without its generated decision section(s), and without the blank lines that separated
 * them from the author's text; the author's chunks around a section are joined by one blank line.
 */
export function stripDecisionSection(text) {
  return splitSections(text).chunks
    .map((c) => c.join('\n').replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, ''))
    .filter(Boolean)
    .join('\n\n');
}

/** Does `text` contain a generated section (a line that is exactly the BEGIN marker)? */
export function hasDecisionSection(text) {
  return splitSections(text).sections.length > 0;
}

/**
 * The lines between the markers of the first generated section in `text`, joined; `null` when
 * there is none. For a reader that shows the section apart from the author's text (the `--doc`
 * Markdown of scripts/bpmn/pipeline.js).
 */
export function decisionSectionBody(text) {
  const { sections } = splitSections(text);
  return sections.length ? sections[0].join('\n') : null;
}

/** One line: a line break and the blanks around it become one space. */
const oneLine = (v) => String(v ?? '').replace(/\s*[\r\n]+\s*/g, ' ');

/** The section body for one bridge outcome (resolved / unresolved / ambiguous). */
function sectionLines(entry, locale) {
  const labels = dmnLabels(locale);
  const ref = oneLine(entry.occurrence.decisionRef);
  if (entry.status === 'unresolved') return [`${labels.callsDecision}: ${ref} (${labels.tableNotSupplied})`];
  if (entry.status === 'ambiguous') {
    const where = [...new Set(entry.candidates.map((c) => oneLine(c.decisionCoreId)))].join(', ');
    return [`${labels.callsDecision}: ${ref} (${labels.ambiguous} ${where})`];
  }
  const d = entry.decision;
  // Every interpolated value on one line: a name carrying a line break (say, followed by the END
  // marker) would otherwise split the section and break replace-on-every-run.
  const title = `${labels.decision}: ${oneLine(d.decisionName)} (${oneLine(d.decisionId)}) \u2014 ${labels.generatedFrom} ${oneLine(d.decisionCoreId)}`;
  if (!d.decisionTable) {
    // A literal expression (bridge entry from includeLiteralExpressions): its type and FEEL text.
    return [title, `${oneLine(literalExpressionLine(d.typeRef, labels))}: ${oneLine(d.expression)}`];
  }
  const node = { id: d.decisionId, name: d.decisionName, decisionTable: d.decisionTable };
  const model = layoutDecisionTable(node, { locale });
  return [title, model.hitPolicyText, ...formatTablePlainText(model)];
}

/** The complete generated section, marker lines included. */
export function decisionSection(entry, { locale } = {}) {
  const body = sectionLines(entry, locale);
  // The invariant splitSections relies on: no blank line, no line break and no marker line inside.
  for (const line of body) {
    if (line.trim() === '' || /[\r\n]/.test(line) || line === DECISION_DOC_BEGIN || line === DECISION_DOC_END) {
      throw new Error(`decisionSection: a generated line would break the section markers: ${JSON.stringify(line)}`);
    }
  }
  return [DECISION_DOC_BEGIN, ...body, DECISION_DOC_END].join('\n');
}

/**
 * Every Decision-Core schema violation among `decisionCores`, as `[decisions #i] <path> <message>`
 * strings — empty when all pass. runPipeline blocks on a non-empty list, like a validation error.
 */
export function decisionCoreErrors(decisionCores) {
  return decisionCores.flatMap((dc, i) => {
    const gate = validateDecisionCoreSchema(dc);
    return gate.valid ? [] : gate.errors.map((e) => `[decisions #${i}] ${e.path} ${e.message}`);
  });
}

function withSection(documentation, section) {
  const own = stripDecisionSection(documentation);
  return own ? `${own}\n\n${section}` : section;
}

function walk(nodes, poolId, visit) {
  for (const node of nodes ?? []) {
    visit(node, poolId);
    if (Array.isArray(node.nodes)) walk(node.nodes, poolId, visit);
  }
}

/**
 * A copy of `lc` whose Business Rule Tasks carry their decision's table in `documentation`.
 * Every other node keeps its documentation, except that a generated section left over from an
 * earlier run (a task that lost its decisionRef) is removed. `lc` itself is never changed.
 *
 * @param {object} lc - Logic-Core
 * @param {object[]} decisionCores - Decision-Core documents (may be empty: every ref then reads
 *   "table not supplied")
 * @param {object} [opts]
 * @param {string} [opts.locale] - label locale, default `config.json → dmn.labels.locale`
 * @returns {object}
 */
export function applyDecisionDocumentation(lc, decisionCores, { locale } = {}) {
  // A JSON clone, like normalizeEdgeIds: Logic-Core is JSON, and structuredClone builds its objects
  // in another realm under Jest's VM modules, which changed the layout (measured) there.
  const out = JSON.parse(JSON.stringify(lc));
  dmnLabels(locale); // an unknown locale fails here, before anything is written
  const { byKey } = resolveBridge(out, decisionCores ?? [], { includeLiteralExpressions: true });
  const visit = (node, poolId) => {
    const occurrence = poolId !== undefined ? { poolId, nodeId: node.id } : { nodeId: node.id };
    const entry = byKey.get(linkKey(occurrence));
    if (node.type === 'businessRuleTask' && entry) {
      node.documentation = withSection(node.documentation, decisionSection(entry, { locale }));
    } else if (node.documentation && hasDecisionSection(node.documentation)) {
      const own = stripDecisionSection(node.documentation);
      if (own) node.documentation = own; else delete node.documentation;
    }
  };
  if (Array.isArray(out.pools)) for (const pool of out.pools) walk(pool.nodes, pool.id, visit);
  else walk(out.nodes, undefined, visit);
  return out;
}
