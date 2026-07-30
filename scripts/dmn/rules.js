/**
 * DMN Rule Engine — structural checks on a Decision-Core document.
 *
 * Same rule-object shape as the BPMN engine (`{ id, layer, defaultSeverity,
 * description, ref, check }`) and the same profile machinery (`rule-profile.js`),
 * because the frame is format-independent. The rules themselves are not: a
 * decision model is not "sound" in the workflow sense — it has no start, no end
 * and no token. Its questions are different, and so are these.
 *
 * Scope of this first set, deliberately: everything here is answerable by looking
 * at the graph and the table shape. Completeness ("does every input combination
 * hit a rule?") and overlap ("does UNIQUE actually hold?") need interval algebra
 * over the input domains and are their own piece of work — see the plan, fork G7.
 *
 * References are to OMG DMN 1.3 (formal/21-01-01) and its normative DMN13.xsd,
 * kept locally under references/omg-spec/normative/dmn/.
 */

import { loadRuleProfile, isRuleEnabled, getEffectiveSeverity } from '../rule-profile.js';

/** Which node types may sit at each end of each requirement kind (DMN13.xsd). */
const REQUIREMENT_ENDPOINTS = {
  // tInformationRequirement: requiredDecision | requiredInput, held BY a decision
  information: { from: ['decision', 'inputData'], to: ['decision'] },
  // tKnowledgeRequirement: requiredKnowledge (an invocable), held BY a decision or a BKM
  knowledge: { from: ['businessKnowledgeModel'], to: ['decision', 'businessKnowledgeModel'] },
  // tAuthorityRequirement: requiredDecision | requiredInput | requiredAuthority,
  // held BY a knowledgeSource or a decision
  authority: {
    from: ['decision', 'inputData', 'knowledgeSource'],
    to: ['knowledgeSource', 'decision'],
  },
};

const byId = (dc) => new Map((dc.nodes ?? []).map(n => [n.id, n]));
const requirementsOf = (dc) => dc.requirements ?? [];
const logicOf = (node) => node.decisionTable ?? (node.expression != null ? { _literal: true } : null);

export const DMN_RULES = [
  {
    id: 'D01', layer: 'soundness', defaultSeverity: 'ERROR',
    description: 'Every requirement connects two declared nodes',
    ref: { omg: 'DMN 1.3 §6.3.2', xsd: 'tDMNElementReference/@href' },
    check: (dc) => {
      const nodes = byId(dc);
      const msgs = [];
      for (const r of requirementsOf(dc)) {
        const label = r.id ? `"${r.id}"` : `${r.source} -> ${r.target}`;
        if (!nodes.has(r.source)) msgs.push(`Requirement ${label} has source "${r.source}", which is not a declared node.`);
        if (!nodes.has(r.target)) msgs.push(`Requirement ${label} has target "${r.target}", which is not a declared node.`);
      }
      return msgs.length === 0 ? { pass: true } : { pass: false, message: msgs.join(' ') };
    },
  },
  {
    id: 'D02', layer: 'soundness', defaultSeverity: 'ERROR',
    description: 'The decision requirement graph is acyclic',
    ref: { omg: 'DMN 1.3 §6.1.2', note: 'A DRG is a directed ACYCLIC graph; a cycle cannot be evaluated' },
    check: (dc) => {
      const nodes = byId(dc);
      const out = new Map([...nodes.keys()].map(id => [id, []]));
      for (const r of requirementsOf(dc)) {
        if (nodes.has(r.source) && nodes.has(r.target)) out.get(r.source).push(r.target);
      }
      // Iterative DFS with colouring; recursion would blow up on a deep chain and
      // the cycle path is what makes the message useful.
      const WHITE = 0, GREY = 1, BLACK = 2;
      const colour = new Map([...nodes.keys()].map(id => [id, WHITE]));
      const cycles = [];
      for (const start of nodes.keys()) {
        if (colour.get(start) !== WHITE) continue;
        const stack = [{ id: start, next: 0, path: [start] }];
        colour.set(start, GREY);
        while (stack.length) {
          const frame = stack[stack.length - 1];
          const neighbours = out.get(frame.id);
          if (frame.next >= neighbours.length) {
            colour.set(frame.id, BLACK);
            stack.pop();
            continue;
          }
          const next = neighbours[frame.next++];
          if (colour.get(next) === GREY) {
            const from = frame.path.indexOf(next);
            cycles.push([...frame.path.slice(from >= 0 ? from : 0), next].join(' -> '));
            continue;
          }
          if (colour.get(next) === WHITE) {
            colour.set(next, GREY);
            stack.push({ id: next, next: 0, path: [...frame.path, next] });
          }
        }
      }
      return cycles.length === 0
        ? { pass: true }
        : { pass: false, message: `The requirement graph has a cycle: ${[...new Set(cycles)].join('; ')}.` };
    },
  },
  {
    id: 'D03', layer: 'soundness', defaultSeverity: 'ERROR',
    description: 'Each requirement kind connects the element types DMN allows for it',
    ref: { xsd: 'tInformationRequirement / tKnowledgeRequirement / tAuthorityRequirement' },
    check: (dc) => {
      const nodes = byId(dc);
      const msgs = [];
      for (const r of requirementsOf(dc)) {
        const spec = REQUIREMENT_ENDPOINTS[r.type];
        if (!spec) continue;                       // schema already constrains the enum
        const src = nodes.get(r.source), tgt = nodes.get(r.target);
        if (!src || !tgt) continue;                // D01 reports this
        const label = r.id ? `"${r.id}"` : `${r.source} -> ${r.target}`;
        if (!spec.from.includes(src.type)) {
          msgs.push(`${r.type} requirement ${label} starts at a ${src.type}; allowed: ${spec.from.join(', ')}.`);
        }
        if (!spec.to.includes(tgt.type)) {
          msgs.push(`${r.type} requirement ${label} ends at a ${tgt.type}; allowed: ${spec.to.join(', ')}.`);
        }
      }
      return msgs.length === 0 ? { pass: true } : { pass: false, message: msgs.join(' ') };
    },
  },
  {
    id: 'D04', layer: 'soundness', defaultSeverity: 'ERROR',
    description: 'A decision table has at least one output clause',
    ref: { xsd: 'tDecisionTable/output — no minOccurs, so it defaults to 1' },
    check: (dc) => {
      const offenders = (dc.nodes ?? [])
        .filter(n => n.decisionTable && !(n.decisionTable.outputs?.length))
        .map(n => `"${n.id}"`);
      return offenders.length === 0
        ? { pass: true }
        : { pass: false, message: `Decision table without an output clause: ${offenders.join(', ')}. At least one is mandatory.` };
    },
  },
  {
    id: 'D05', layer: 'soundness', defaultSeverity: 'ERROR',
    description: 'Every rule has one entry per input, output and annotation column',
    ref: { omg: 'DMN 1.3 §8.2', note: 'Entries are positional — a short row silently shifts meaning' },
    check: (dc) => {
      const msgs = [];
      for (const n of dc.nodes ?? []) {
        const t = n.decisionTable;
        if (!t) continue;
        const nIn = t.inputs?.length ?? 0;
        const nOut = t.outputs?.length ?? 0;
        const nAnn = t.annotations?.length ?? 0;
        (t.rules ?? []).forEach((rule, i) => {
          const label = rule.id ? `"${rule.id}"` : `#${i + 1}`;
          const when = rule.when?.length ?? 0;
          const then = rule.then?.length ?? 0;
          const ann = rule.annotations?.length ?? 0;
          if (when !== nIn)  msgs.push(`Table "${n.id}" rule ${label} has ${when} input entr${when === 1 ? 'y' : 'ies'} for ${nIn} input column${nIn === 1 ? '' : 's'}.`);
          if (then !== nOut) msgs.push(`Table "${n.id}" rule ${label} has ${then} output entr${then === 1 ? 'y' : 'ies'} for ${nOut} output column${nOut === 1 ? '' : 's'}.`);
          if (ann && ann !== nAnn) msgs.push(`Table "${n.id}" rule ${label} has ${ann} annotation entr${ann === 1 ? 'y' : 'ies'} for ${nAnn} annotation column${nAnn === 1 ? '' : 's'}.`);
        });
      }
      return msgs.length === 0 ? { pass: true } : { pass: false, message: msgs.join(' ') };
    },
  },
  {
    id: 'D06', layer: 'style', defaultSeverity: 'WARNING',
    description: 'A decision should carry decision logic',
    ref: { omg: 'DMN 1.3 §6.3.1', note: 'Legal without — the DRD then documents intent only, which is often deliberate early on' },
    check: (dc) => {
      const offenders = (dc.nodes ?? [])
        .filter(n => n.type === 'decision' && !logicOf(n))
        .map(n => `"${n.name || n.id}"`);
      return offenders.length === 0
        ? { pass: true }
        : { pass: false, message: `Decision without logic (no decision table, no expression): ${offenders.join(', ')}.` };
    },
  },
  {
    id: 'D07', layer: 'style', defaultSeverity: 'WARNING',
    description: 'Every input data element feeds something',
    ref: { note: 'An input nothing requires is either dead or a missing requirement' },
    check: (dc) => {
      const used = new Set(requirementsOf(dc).map(r => r.source));
      const offenders = (dc.nodes ?? [])
        .filter(n => n.type === 'inputData' && !used.has(n.id))
        .map(n => `"${n.name || n.id}"`);
      return offenders.length === 0
        ? { pass: true }
        : { pass: false, message: `Input data required by nothing: ${offenders.join(', ')}.` };
    },
  },
  {
    id: 'D08', layer: 'style', defaultSeverity: 'WARNING',
    description: 'aggregation only means something with hit policy COLLECT',
    ref: { xsd: 'tDecisionTable/@aggregation : tBuiltinAggregator', omg: 'DMN 1.3 §8.2.11' },
    check: (dc) => {
      const offenders = (dc.nodes ?? [])
        .filter(n => n.decisionTable?.aggregation && (n.decisionTable.hitPolicy ?? 'UNIQUE') !== 'COLLECT')
        .map(n => `"${n.id}" (${n.decisionTable.hitPolicy ?? 'UNIQUE'})`);
      return offenders.length === 0
        ? { pass: true }
        : { pass: false, message: `aggregation set on a table whose hit policy is not COLLECT: ${offenders.join(', ')}. It will be ignored.` };
    },
  },
];

/**
 * Run every enabled DMN rule against a Decision-Core document.
 *
 * Deliberately its own runner rather than a parameter to the BPMN one: the rule
 * list and the shape handed to `check` are the format-specific part. Everything
 * a profile means is shared (rule-profile.js).
 *
 * @param {object} dc - Decision-Core JSON
 * @param {object|null} profile
 * @returns {{ errors: string[], warnings: string[], infos: string[] }}
 */
export function runDmnRules(dc, profile = null) {
  const errors = [], warnings = [], infos = [];
  for (const rule of DMN_RULES) {
    if (!isRuleEnabled(rule, profile)) continue;
    const severity = getEffectiveSeverity(rule, profile);
    if (severity === 'OFF') continue;
    const result = rule.check(dc);
    if (result.pass) continue;
    const line = `[${rule.id}] ${result.message}`;
    if (severity === 'ERROR') errors.push(line);
    else if (severity === 'WARNING') warnings.push(line);
    else infos.push(line);
  }
  return { errors, warnings, infos };
}

export { loadRuleProfile };
