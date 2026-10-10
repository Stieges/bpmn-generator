/**
 * Rule profiles — loading them, and deciding what a profile means for one rule.
 *
 * Shared by the BPMN rule engine (`rules.js`) and the DMN one (`dmn/rules.js`).
 * Nothing here knows what a process or a decision is: a profile is applied to a
 * rule object and that is the whole contract. Only the *runner* — which rule list
 * to walk, and what to hand each `check` — is format-specific, and that stays in
 * each engine.
 *
 * Lifted out rather than copied. The same three functions written twice is how
 * this codebase acquired its most expensive defects (geometry computed in two
 * renderers, per-node fields enriched on two paths, reference paths resolved in
 * two modules), and a severity override silently applying to one engine but not
 * the other would be exactly that shape again.
 *
 * Profile format:
 *   { layers:    { <layer>: { enabled: false } },
 *     overrides: { <ruleId>: { severity: <a severity of references/ontology.jsonld> } } }
 *
 * This module never prints. What a profile says that its rule set cannot honour is computed by
 * `auditProfile` and REPORTED by the runner that owns the rule set.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A profile that is refused: a file that cannot be read or parsed, an unknown severity, or a
 * severity that would drop findings. A caller that takes a profile from a client (the HTTP API)
 * maps this to a client error instead of an internal one.
 */
export class ProfileRejectedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProfileRejectedError';
    this.code = 'PROFILE_REJECTED';
  }
}

/**
 * Read a profile from disk.
 *  - The file does not exist: `{ $source, $missing: true }`, which behaves exactly like no profile
 *    (every rule at its ontology default) but lets the runner warn that it was not found.
 *  - It exists but cannot be read or is not JSON: throws, naming the file and the parser's
 *    position. It used to return null here as well, which silently ran the defaults.
 *  - Otherwise the parsed profile plus `$source` (the resolved path), so a warning can name it.
 * A leading UTF-8 BOM (Windows editors write one; JSON.parse rejects it) is stripped first.
 */
export function loadRuleProfile(profilePath) {
  const path = resolve(profilePath);
  if (!existsSync(path)) return { $source: path, $missing: true };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ProfileRejectedError(`rule profile ${path} cannot be read: ${err.message}`);
  }
  const json = text.replace(/^\uFEFF/, '');
  let profile;
  try {
    profile = JSON.parse(json);
  } catch (err) {
    throw new ProfileRejectedError(`rule profile ${path} is not valid JSON at ${jsonErrorLocation(json, err)}: ${err.message}`);
  }
  return { ...profile, $source: path };
}

/** "line L, column C" of a JSON.parse failure; the end of the text when the parser names no position. */
function jsonErrorLocation(text, err) {
  const m = /position (\d+)/.exec(err.message);
  const pos = m ? Number(m[1]) : text.length;
  const before = text.slice(0, pos);
  return `line ${before.split('\n').length}, column ${pos - before.lastIndexOf('\n')}`;
}

/**
 * What a profile names that its rule set cannot honour. Pure; the runner prints `warnings` and
 * throws on `errors`.
 *
 * @param {object|null} profile
 * @param {{ ruleSet: string, ruleIds: Set<string>, layers: Set<string>, severities: Set<string>,
 *           scenarioRuleIds: Set<string>, ruleLayer: Map<string, string>,
 *           severityOnlyFor?: Record<string, Set<string>> }} context - see profileContext() in
 *   rule-catalog.js; `severityOnlyFor` maps a severity to the only layers that can report it.
 * @returns {{ warnings: string[], errors: string[] }}
 */
export function auditProfile(profile, context) {
  const warnings = [];
  const errors = [];
  if (!profile) return { warnings, errors };
  const name = profile.$source ?? (profile.profile ? `"${profile.profile}"` : '(inline profile)');
  if (profile.$missing) {
    warnings.push(`rule profile ${profile.$source} not found — every ${context.ruleSet} rule runs at its default severity`);
  }
  for (const layer of Object.keys(profile.layers ?? {})) {
    if (!context.layers.has(layer)) {
      warnings.push(`rule profile ${name} names layer "${layer}", which the ${context.ruleSet} rule set does not have — ignored`);
    }
  }
  for (const [id, override] of Object.entries(profile.overrides ?? {})) {
    const severity = override?.severity;
    if (severity !== undefined && !context.severities.has(severity)) {
      errors.push(`rule profile ${name}: unknown severity ${severity} (${id})`);
    } else if (context.scenarioRuleIds.has(id)) {
      warnings.push(`rule profile ${name} overrides ${id}, which runs in the scenario pipeline and is not profile-switchable in this release — ignored`);
    } else if (!context.ruleIds.has(id)) {
      warnings.push(`rule profile ${name} names rule ${id}, which the ${context.ruleSet} rule set does not have — ignored`);
    } else {
      const only = context.severityOnlyFor?.[severity];
      if (only && !only.has(context.ruleLayer.get(id))) {
        errors.push(`rule profile ${name}: ${id} is a ${context.ruleLayer.get(id)} rule, and severity ${severity} is reported for the ${[...only].join('/')} layer only — its findings would be dropped`);
      }
    }
  }
  return { warnings, errors };
}

/** Is this rule switched on under this profile? */
export function isRuleEnabled(rule, profile) {
  if (!profile) return true;
  const layerConfig = profile.layers?.[rule.layer];
  if (layerConfig && layerConfig.enabled === false) return false;
  const override = profile.overrides?.[rule.id];
  if (override?.severity === 'OFF') return false;
  return true;
}

/** Severity to report this rule at, honouring any override. */
export function getEffectiveSeverity(rule, profile) {
  const override = profile?.overrides?.[rule.id];
  return override?.severity || rule.defaultSeverity;
}
