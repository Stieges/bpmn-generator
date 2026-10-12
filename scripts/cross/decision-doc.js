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

const BEGIN_RE = /^=== BEGIN generated: DMN decision\b.*$/m;
const END_RE = /^=== END generated: DMN decision\b.*$/m;

/**
 * `text` without its generated decision section(s), and without the blank lines that separated
 * them from the author's text. A BEGIN line without its END (hand-truncated) drops everything from
 * BEGIN on — the section is the generator's, and a half of it is still not the author's.
 */
export function stripDecisionSection(text) {
  let s = String(text ?? '');
  for (;;) {
    const begin = BEGIN_RE.exec(s);
    if (!begin) break;
    const rest = s.slice(begin.index);
    const end = END_RE.exec(rest);
    const stop = end ? begin.index + end.index + end[0].length : s.length;
    s = s.slice(0, begin.index).replace(/\s+$/, '') + (stop < s.length ? `\n\n${s.slice(stop).replace(/^\s+/, '')}` : '');
  }
  return s.replace(/\s+$/, '');
}

/**
 * The lines between the markers of the first generated section in `text`, joined; `null` when
 * there is none. For a reader that shows the section apart from the author's text (the `--doc`
 * Markdown of scripts/bpmn/pipeline.js).
 */
export function decisionSectionBody(text) {
  const s = String(text ?? '');
  const begin = BEGIN_RE.exec(s);
  if (!begin) return null;
  const after = s.slice(begin.index + begin[0].length);
  const end = END_RE.exec(after);
  return (end ? after.slice(0, end.index) : after).replace(/^\n/, '').replace(/\s+$/, '');
}

/** The section body for one bridge outcome (resolved / unresolved / ambiguous). */
function sectionLines(entry, locale) {
  const labels = dmnLabels(locale);
  const ref = entry.occurrence.decisionRef;
  if (entry.status === 'unresolved') return [`${labels.callsDecision}: ${ref} (${labels.tableNotSupplied})`];
  if (entry.status === 'ambiguous') {
    const where = [...new Set(entry.candidates.map((c) => c.decisionCoreId))].join(', ');
    return [`${labels.callsDecision}: ${ref} (${labels.ambiguous} ${where})`];
  }
  const d = entry.decision;
  const title = `${labels.decision}: ${d.decisionName} (${d.decisionId}) \u2014 ${labels.generatedFrom} ${d.decisionCoreId}`;
  if (!d.decisionTable) {
    // A literal expression (bridge entry from includeLiteralExpressions): its type and FEEL text.
    return [title, `${literalExpressionLine(d.typeRef, labels)}: ${String(d.expression).replace(/\s*[\r\n]+\s*/g, ' ')}`];
  }
  const node = { id: d.decisionId, name: d.decisionName, decisionTable: d.decisionTable };
  const model = layoutDecisionTable(node, { locale });
  return [title, model.hitPolicyText, ...formatTablePlainText(model)];
}

/** The complete generated section, marker lines included. */
export function decisionSection(entry, { locale } = {}) {
  return [DECISION_DOC_BEGIN, ...sectionLines(entry, locale), DECISION_DOC_END].join('\n');
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
    } else if (node.documentation && BEGIN_RE.test(node.documentation)) {
      const own = stripDecisionSection(node.documentation);
      if (own) node.documentation = own; else delete node.documentation;
    }
  };
  if (Array.isArray(out.pools)) for (const pool of out.pools) walk(pool.nodes, pool.id, visit);
  else walk(out.nodes, undefined, visit);
  return out;
}
