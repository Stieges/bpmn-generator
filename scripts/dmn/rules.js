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
import { CFG } from '../utils.js';

/**
 * DMN 1.3 Table 2, "Requirements connection rules", verbatim minus the two
 * DecisionService rows (that element is out of scope for now).
 *
 * Keyed `from -> to`. The value is the requirement type, and there is exactly
 * one: the spec states that "the type of the requirement is uniquely determined
 * by the types of the two elements connected" (§6.2.3). That sentence is why
 * this is a pair table and not two independent endpoint lists — checking the
 * ends separately accepts combinations the table forbids. `decision -> decision`
 * would pass an endpoint check for `authority` (a decision may be the source of
 * one, a decision may be the target of one), while Table 2 says that pair is
 * unambiguously `information`.
 *
 * The table also answers a question by omission: no row has Input Data as the
 * target, and §6.2.3 spells it out — "no requirements may be drawn terminating
 * in Input Data".
 */
const CONNECTION_RULES = new Map(Object.entries({
  'decision -> decision':                                 'information',
  'inputData -> decision':                                'information',
  'decision -> knowledgeSource':                          'authority',
  'inputData -> knowledgeSource':                         'authority',
  'knowledgeSource -> decision':                          'authority',
  'knowledgeSource -> businessKnowledgeModel':            'authority',
  'knowledgeSource -> knowledgeSource':                   'authority',
  'businessKnowledgeModel -> decision':                   'knowledge',
  'businessKnowledgeModel -> businessKnowledgeModel':     'knowledge',
}));

/** Hit policies whose priorities come from the ordered list of output values. */
const PRIORITY_DRIVEN = new Set(['PRIORITY', 'OUTPUT ORDER']);

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
    description: 'Requirements connect element types DMN permits, with the type the pair implies',
    ref: { omg: 'DMN 1.3 §6.2.3, Table 2 "Requirements connection rules"' },
    check: (dc) => {
      const nodes = byId(dc);
      const msgs = [];
      for (const r of requirementsOf(dc)) {
        const src = nodes.get(r.source), tgt = nodes.get(r.target);
        if (!src || !tgt) continue;                // D01 reports this
        const label = r.id ? `"${r.id}"` : `${r.source} -> ${r.target}`;
        const implied = CONNECTION_RULES.get(`${src.type} -> ${tgt.type}`);
        if (!implied) {
          msgs.push(
            `Requirement ${label} connects a ${src.type} to a ${tgt.type}; DMN permits no requirement between those` +
            `${tgt.type === 'inputData' ? ' — nothing may require input data' : ''}.`);
        } else if (implied !== r.type) {
          // Not a matter of taste: §6.2.3 says the pair determines the type, so a
          // mislabelled requirement is a different requirement, not a variant.
          msgs.push(`Requirement ${label} is declared "${r.type}", but a ${src.type} -> ${tgt.type} requirement is always "${implied}".`);
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
    id: 'D09', layer: 'soundness', defaultSeverity: 'ERROR',
    description: 'A Collect operator needs a single output — it is undefined over compound outputs',
    ref: { omg: 'DMN 1.3 §8.2.11', quote: 'compound outputs support ... Collect without operator, because the collect operator is undefined over multiple outputs' },
    check: (dc) => {
      const offenders = (dc.nodes ?? [])
        .filter(n => n.decisionTable?.aggregation && (n.decisionTable.outputs?.length ?? 0) > 1)
        .map(n => `"${n.id}" (${n.decisionTable.aggregation} over ${n.decisionTable.outputs.length} outputs)`);
      return offenders.length === 0
        ? { pass: true }
        : { pass: false, message: `Collect operator on a table with more than one output clause: ${offenders.join(', ')}. The operator has no defined meaning there — drop it or reduce the table to one output.` };
    },
  },
  {
    id: 'D10', layer: 'soundness', defaultSeverity: 'ERROR',
    description: 'PRIORITY and OUTPUT ORDER need output values — that is where the priority comes from',
    ref: { omg: 'DMN 1.3 §8.2.11', quote: 'Output priorities are specified in the ordered list of output values, in decreasing order of priority' },
    check: (dc) => {
      const msgs = [];
      for (const n of dc.nodes ?? []) {
        const t = n.decisionTable;
        if (!t || !PRIORITY_DRIVEN.has(t.hitPolicy)) continue;
        const missing = (t.outputs ?? []).filter(o => !o.allowedValues);
        if (missing.length) {
          // Without the ordered list there is nothing to rank by, so the table
          // has no defined result — an error rather than a hint.
          msgs.push(`Table "${n.id}" uses hit policy ${t.hitPolicy} but ${missing.length} of its ${t.outputs.length} output clause(s) declare no output values, so there is no priority order to apply.`);
        }
      }
      return msgs.length === 0 ? { pass: true } : { pass: false, message: msgs.join(' ') };
    },
  },
  {
    id: 'D11', layer: 'soundness', defaultSeverity: 'ERROR',
    description: 'A CrossTable is always UNIQUE',
    ref: { omg: 'DMN 1.3 §8.1', quote: 'Crosstab tables are always Unique and need no indicator' },
    check: (dc) => {
      const offenders = (dc.nodes ?? [])
        .filter(n => n.decisionTable?.preferredOrientation === 'CrossTable'
                  && (n.decisionTable.hitPolicy ?? 'UNIQUE') !== 'UNIQUE')
        .map(n => `"${n.id}" (${n.decisionTable.hitPolicy})`);
      return offenders.length === 0
        ? { pass: true }
        : { pass: false, message: `Crosstab table with a hit policy other than UNIQUE: ${offenders.join(', ')}.` };
    },
  },
  {
    id: 'D06', layer: 'semantics', defaultSeverity: 'WARNING',
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
    id: 'D07', layer: 'semantics', defaultSeverity: 'WARNING',
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
    id: 'D08', layer: 'semantics', defaultSeverity: 'WARNING',
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

  // ═══════════════════════════════════════════════════════════════════════
  // Layer: best_practice — OFF by default, enabled by mode 'best-practice'
  //
  // Readability and method, not conformance. Everything here produces a file
  // that is valid DMN and that every engine will happily evaluate; what it
  // will not do is stay comprehensible. Off by default on purpose: a model
  // being documented as-is should not be nagged about how it ought to look.
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: 'B01', layer: 'best_practice', defaultSeverity: 'WARNING',
    description: 'Avoid the FIRST hit policy',
    // The specification itself takes this position, which is why it is here
    // rather than in a style guide of our own invention.
    ref: { omg: 'DMN 1.3 §8.2.11', quote: 'first hit tables are not considered good practice because they do not offer a clear overview of the decision logic' },
    check: (dc) => {
      const offenders = (dc.nodes ?? [])
        .filter(n => n.decisionTable?.hitPolicy === 'FIRST')
        .map(n => `"${n.name || n.id}"`);
      return offenders.length === 0
        ? { pass: true }
        : { pass: false, message: `FIRST hit policy in ${offenders.join(', ')}. The meaning depends on rule order, which makes the table hard to validate by hand; UNIQUE or PRIORITY states the intent instead.` };
    },
  },
  {
    id: 'B02', layer: 'best_practice', defaultSeverity: 'WARNING',
    description: 'A decision table should stay small enough to read',
    ref: { note: 'Threshold in config.json → dmn.maxRulesPerTable (default 20)' },
    check: (dc, cfg) => {
      const limit = cfg?.maxRulesPerTable ?? 20;
      const offenders = (dc.nodes ?? [])
        .filter(n => (n.decisionTable?.rules?.length ?? 0) > limit)
        .map(n => `"${n.name || n.id}" (${n.decisionTable.rules.length})`);
      return offenders.length === 0
        ? { pass: true }
        : { pass: false, message: `Decision table with more than ${limit} rules: ${offenders.join(', ')}. Consider splitting it into decisions that each answer one question.` };
    },
  },
  {
    id: 'B03', layer: 'best_practice', defaultSeverity: 'WARNING',
    description: 'A decision should state the question it answers',
    // DMN models `question` and `allowedAnswers` as first-class properties
    // precisely so a decision is self-describing without reading its logic.
    ref: { omg: 'DMN 1.3 §6.3.6, Table 11 (Decision attributes)' },
    check: (dc) => {
      const offenders = (dc.nodes ?? [])
        .filter(n => n.type === 'decision' && !n.question)
        .map(n => `"${n.name || n.id}"`);
      return offenders.length === 0
        ? { pass: true }
        : { pass: false, message: `Decision without a question: ${offenders.join(', ')}. The name says what it is called, the question says what it decides.` };
    },
  },
  {
    id: 'B04', layer: 'best_practice', defaultSeverity: 'WARNING',
    description: 'Input data should declare its type',
    ref: { note: 'Untyped input makes the unary tests in every table that uses it unverifiable' },
    check: (dc) => {
      const offenders = (dc.nodes ?? [])
        .filter(n => n.type === 'inputData' && !n.typeRef)
        .map(n => `"${n.name || n.id}"`);
      return offenders.length === 0
        ? { pass: true }
        : { pass: false, message: `Input data without a typeRef: ${offenders.join(', ')}. Without it, "< 100" cannot be checked against anything.` };
    },
  },
  {
    id: 'B05', layer: 'best_practice', defaultSeverity: 'WARNING',
    description: 'A knowledge source should say what it is and where it lives',
    ref: { omg: 'DMN 1.3 §6.3.12, Table 19 (KnowledgeSource attributes)' },
    check: (dc) => {
      const offenders = (dc.nodes ?? [])
        .filter(n => n.type === 'knowledgeSource' && !n.sourceType && !n.locationURI)
        .map(n => `"${n.name || n.id}"`);
      return offenders.length === 0
        ? { pass: true }
        : { pass: false, message: `Knowledge source with neither sourceType nor locationURI: ${offenders.join(', ')}. It names an authority nobody can look up.` };
    },
  },
  {
    id: 'B06', layer: 'best_practice', defaultSeverity: 'WARNING',
    description: 'The requirement chain should not run too deep',
    ref: { note: 'Threshold in config.json → dmn.maxDrgDepth (default 5)' },
    check: (dc, cfg) => {
      const limit = cfg?.maxDrgDepth ?? 5;
      const nodes = byId(dc);
      const incoming = new Map([...nodes.keys()].map(id => [id, []]));
      for (const r of requirementsOf(dc)) {
        if (nodes.has(r.source) && nodes.has(r.target)) incoming.get(r.target).push(r.source);
      }
      // Longest path to each node, memoised. Safe against cycles because D02
      // reports those and the seen-set stops the walk either way.
      const depthOf = (id, seen = new Set()) => {
        if (seen.has(id)) return 0;
        seen.add(id);
        const parents = incoming.get(id) ?? [];
        return parents.length === 0 ? 1 : 1 + Math.max(...parents.map(p => depthOf(p, new Set(seen))));
      };
      const deepest = [...nodes.keys()].map(id => ({ id, d: depthOf(id) })).filter(x => x.d > limit);
      return deepest.length === 0
        ? { pass: true }
        : { pass: false, message: `Requirement chain deeper than ${limit}: ${deepest.map(x => `"${nodes.get(x.id).name || x.id}" (${x.d})`).join(', ')}. Intermediate decisions that only pass values through can usually be collapsed.` };
    },
  },
];

/** The layers a mode turns on, beyond what the base profile already says. */
const MODES = {
  // Does the model hold together? Graph, table shape, spec conformance, plus the
  // semantic warnings that point at something actually wrong.
  semantic: { soundness: true, semantics: true, best_practice: false },
  // Everything above, plus readability and method.
  'best-practice': { soundness: true, semantics: true, best_practice: true },
};

export const DMN_MODES = Object.keys(MODES);

/**
 * Derive a profile for a mode, mirroring `profileForMode` on the BPMN side.
 *
 * The mode sets layer enablement; an explicit profile still wins, because a
 * profile is the more specific statement. So `--mode best-practice` with a
 * profile that disables `best_practice` leaves it disabled — the caller said
 * something precise and the mode is the blunter instrument.
 *
 * @param {object|null} baseProfile
 * @param {string} [mode='semantic']
 * @returns {object|null}
 */
export function dmnProfileForMode(baseProfile, mode = 'semantic') {
  const layers = MODES[mode];
  if (!layers) {
    throw new Error(`Unknown DMN mode "${mode}". Known modes: ${DMN_MODES.join(', ')}.`);
  }
  const p = baseProfile ? JSON.parse(JSON.stringify(baseProfile)) : {};
  p.layers = p.layers || {};
  for (const [layer, enabled] of Object.entries(layers)) {
    // Only fill in what the profile is silent about.
    if (p.layers[layer]?.enabled === undefined) {
      p.layers[layer] = { ...(p.layers[layer] || {}), enabled };
    }
  }
  return p;
}

/**
 * Run every enabled DMN rule against a Decision-Core document.
 *
 * Deliberately its own runner rather than a parameter to the BPMN one: the rule
 * list and the shape handed to `check` are the format-specific part. Everything
 * a profile means is shared (rule-profile.js).
 *
 * @param {object} dc - Decision-Core JSON
 * @param {object} [opts={}]
 * @param {object|null} [opts.profile] - Rule profile (or a path, via loadRuleProfile)
 * @param {string} [opts.mode='semantic'] - 'semantic' (default) or 'best-practice'
 * @param {object} [opts.config] - Thresholds; defaults come from config.json → dmn
 * @returns {{ errors: string[], warnings: string[], infos: string[], mode: string }}
 */
export function runDmnRules(dc, opts = {}) {
  const { profile: rawProfile = null, mode = 'semantic', config = CFG.dmn } = opts;
  const profile = dmnProfileForMode(rawProfile, mode);
  const errors = [], warnings = [], infos = [];
  for (const rule of DMN_RULES) {
    if (!isRuleEnabled(rule, profile)) continue;
    const severity = getEffectiveSeverity(rule, profile);
    if (severity === 'OFF') continue;
    const result = rule.check(dc, config);
    if (result.pass) continue;
    const line = `[${rule.id}] ${result.message}`;
    if (severity === 'ERROR') errors.push(line);
    else if (severity === 'WARNING') warnings.push(line);
    else infos.push(line);
  }
  return { errors, warnings, infos, mode };
}

export { loadRuleProfile };
