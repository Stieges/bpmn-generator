/**
 * BPMN Validation — Thin wrapper around the Rule Engine.
 * Delegates all checks to rules.js, returns { errors, warnings }.
 */

import { runRules, loadRuleProfile } from './rules.js';

/**
 * Validate a Logic-Core document.
 * @param {object} lc - Logic-Core JSON
 * @param {string|object|null} profileOrPath - Rule profile object, file path, or null for defaults
 * @returns {{ errors: string[], warnings: string[], infos: string[], advisories: string[], metrics: object }}
 */
function validateLogicCore(lc, profileOrPath = null) {
  let profile = null;
  if (typeof profileOrPath === 'string') {
    profile = loadRuleProfile(profileOrPath);
  } else if (profileOrPath && typeof profileOrPath === 'object') {
    profile = profileOrPath;
  }

  const result = runRules(lc, profile);
  // Pass advisories/infos/metrics through (additive; existing callers that only
  // read errors/warnings are unaffected). Advisories are populated only when the
  // opt-in optimization layer is enabled (via profileForMode / "optimize" mode).
  return {
    errors: result.errors,
    warnings: result.warnings,
    infos: result.infos,
    advisories: result.advisories,
    metrics: result.metrics,
  };
}

export { validateLogicCore };
