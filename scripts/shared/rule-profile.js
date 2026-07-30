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
 *     overrides: { <ruleId>: { severity: 'ERROR' | 'WARNING' | 'INFO' | 'OFF' } } }
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Read a profile from disk. Returns null when it cannot be read or parsed —
 * a missing profile means "use the defaults", not "fail the run".
 */
export function loadRuleProfile(profilePath) {
  try {
    return JSON.parse(readFileSync(resolve(profilePath), 'utf8'));
  } catch {
    return null;
  }
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
