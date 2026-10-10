/**
 * Rule catalogs — joining a module's rule logic (code) with the rule's metadata (ontology).
 *
 * references/ontology.jsonld says which rules exist and, for each, its rule set (notation, or
 * cross-notation), layer, default severity and run location (`main` = runRules/runDmnRules,
 * `scenario` = scripts/scenarios/pipeline.js). The code says only how a rule checks. Each rule
 * module declares a REGISTER — its own path, the partition (rule set + run location) that path
 * stands for, and its entries `{ id, description, ref?, scope?, check }` — and builds its catalog
 * here when it is imported.
 *
 * A gap in either direction (a rule only in code, a rule only in the ontology), a rule in the wrong
 * module, or an entry still carrying its own metadata literal aborts the build of THAT module only
 * (decisions F5, F26): bpmn/ never imports dmn/, so a DMN gap can never break the BPMN pipeline.
 * The ontology loader knows nothing of this module (no import cycle).
 */
import { VOCABULARY, CROSS_NOTATION } from './ontology.js';

/** Metadata the ontology owns. A rule entry in code must not carry any of these (record M10). */
export const RULE_METADATA_FIELDS = Object.freeze(['layer', 'defaultSeverity', 'notation', 'notations', 'kind', 'runsIn', 'ruleSet']);

/**
 * The partition a rule-module path stands for (decision F11): `bpmn/` ⇒ BPMN, `dmn/` ⇒ DMN,
 * `cross/` ⇒ cross-notation; `scenario-rules.js` and `cross/rules.js` ⇒ runs in `scenario`,
 * `rules.js` in bpmn/ or dmn/ ⇒ runs in `main`.
 * @param {string} module repo-relative path, e.g. 'scripts/bpmn/rules.js'
 * @returns {{ ruleSet: string, runsIn: 'main'|'scenario' }}
 */
export function partitionForModule(module) {
  const m = /^scripts\/(bpmn|dmn|cross)\/(rules|scenario-rules)\.js$/.exec(module);
  if (!m) throw new Error(`${module} is not a rule-module path (scripts/{bpmn,dmn,cross}/{rules,scenario-rules}.js)`);
  const ruleSet = m[1] === 'cross' ? CROSS_NOTATION : m[1].toUpperCase();
  const runsIn = m[1] === 'cross' || m[2] === 'scenario-rules' ? 'scenario' : 'main';
  return { ruleSet, runsIn };
}

const describe = (p) => `rule set ${p.ruleSet}, runs in ${p.runsIn}`;

/**
 * Ontology rules a module with this partition must implement. Rules of an announced notation
 * (ArchiMate) are never expected in code (decision F6).
 */
export function rulesExpectedIn(partition, vocabulary = VOCABULARY) {
  const status = new Map(vocabulary.notations.map((n) => [n.name, n.status]));
  return vocabulary.rules.filter((r) => r.ruleSet === partition.ruleSet && r.runsIn === partition.runsIn
    && r.notations.every((n) => status.get(n) === 'supported'));
}

/**
 * Everything wrong with a register against the ontology, as messages; `[]` when it matches.
 * Pure — the parity tests call it with synthetic registers and vocabularies.
 * @param {{ module: string, partition: { ruleSet: string, runsIn: string }, entries: Array<{ id: string }> }} register
 */
export function registerFindings(register, vocabulary = VOCABULARY) {
  const { module, partition, entries } = register;
  const out = [];
  const fromPath = partitionForModule(module);
  if (partition.ruleSet !== fromPath.ruleSet || partition.runsIn !== fromPath.runsIn) {
    out.push(`declares ${describe(partition)}, but its path stands for ${describe(fromPath)}`);
  }
  const byId = new Map(vocabulary.rules.map((r) => [r.id, r]));
  const ids = entries.map((e) => e.id);
  ids.forEach((id, i) => { if (ids.indexOf(id) !== i) out.push(`${id}: registered twice`); });
  for (const e of entries) {
    const rule = byId.get(e.id);
    if (!rule) out.push(`${e.id}: only in code — the ontology has no rule ${e.id}`);
    else if (rule.ruleSet !== fromPath.ruleSet || rule.runsIn !== fromPath.runsIn) {
      out.push(`${e.id}: lies in ${module} (${describe(fromPath)}), but the ontology puts it in ${describe(rule)}`);
    }
    for (const field of RULE_METADATA_FIELDS) {
      if (Object.hasOwn(e, field)) out.push(`${e.id}: carries its own ${field} literal — that belongs to references/ontology.jsonld`);
    }
  }
  for (const r of rulesExpectedIn(fromPath, vocabulary)) {
    if (!ids.includes(r.id)) out.push(`${r.id}: only in the ontology — ${module} registers no check for it`);
  }
  return out;
}

/**
 * The catalog a runner walks: the register's entries in register order, each completed with
 * `layer` and `defaultSeverity` from the ontology. Throws, naming the module and every finding,
 * when the register does not match — there is no fallback to metadata embedded in code.
 */
export function buildRuleCatalog(register, vocabulary = VOCABULARY) {
  const findings = registerFindings(register, vocabulary);
  if (findings.length) {
    throw new Error(`${register.module}: the rule catalog does not match references/ontology.jsonld — ${findings.join('; ')}`);
  }
  const byId = new Map(vocabulary.rules.map((r) => [r.id, r]));
  return register.entries.map((e) => ({ ...e, layer: byId.get(e.id).layer, defaultSeverity: byId.get(e.id).defaultSeverity }));
}

/**
 * What a profile may name for one rule set, for auditProfile (scripts/shared/rule-profile.js): the
 * rule set's `main` rules (the only ones a runner can switch), its layers, every severity, the
 * scenario rules (named, so a profile touching one gets a precise warning), and each rule's layer.
 */
export function profileContext(ruleSet, vocabulary = VOCABULARY) {
  const own = vocabulary.rules.filter((r) => r.ruleSet === ruleSet);
  return {
    ruleSet,
    ruleIds: new Set(own.filter((r) => r.runsIn === 'main').map((r) => r.id)),
    layers: new Set(vocabulary.layers.filter((l) => l.ruleSet === ruleSet).map((l) => l.name)),
    severities: new Set(vocabulary.severities.map((s) => s.name)),
    scenarioRuleIds: new Set(vocabulary.rules.filter((r) => r.runsIn === 'scenario').map((r) => r.id)),
    ruleLayer: new Map(own.map((r) => [r.id, r.layer])),
  };
}
