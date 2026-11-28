/**
 * BPMN Validation — Thin wrapper around the Rule Engine.
 * Delegates all checks to rules.js, returns { errors, warnings }. `validateModel` is the one
 * judgement for both formats: a format 2.0 model is checked against its catalogue first.
 */

import { runRules, loadRuleProfile } from './rules.js';
import { resolveFields } from './model-v2.js';
import { modelFormat } from './schema-gate.js';
import { codeOf } from '../shared/message-codes.js';

/**
 * Validate a Logic-Core document.
 * @param {object} lc - Logic-Core JSON
 * @param {string|object|null} profileOrPath - Rule profile object, file path, or null for defaults
 * @param {{ withFindings?: boolean }} [options] - `withFindings`: pass runRules' `findings` through
 * @returns {{ errors: string[], warnings: string[], infos: string[], advisories: object[], metrics: object,
 *   findings?: Array<{code: string, severity: string, message: string}> }}
 */
function validateLogicCore(lc, profileOrPath = null, { withFindings = false } = {}) {
  let profile = null;
  if (typeof profileOrPath === 'string') {
    profile = loadRuleProfile(profileOrPath);
  } else if (profileOrPath && typeof profileOrPath === 'object') {
    profile = profileOrPath;
  }

  const result = runRules(lc, profile, undefined, { withFindings });
  // Pass advisories/infos/metrics through (additive; existing callers that only
  // read errors/warnings are unaffected). Advisories are populated only when the
  // opt-in optimization layer is enabled (via profileForMode / "optimize" mode).
  return {
    errors: result.errors,
    warnings: result.warnings,
    infos: result.infos,
    advisories: result.advisories,
    metrics: result.metrics,
    ...(withFindings ? { findings: result.findings } : {}),
  };
}

/**
 * The verdict on a model of either format, as `/validate`, `validate_bpmn`, the reviewer and
 * compliance give it. A 1.x model: `validateLogicCore(model, profile)`, unchanged. A format 2.0
 * model passes resolveFields (format schema, catalogue, assignments, systems and data access: C01–C07, C12–C17); its errors
 * are the verdict, else the rules judge the resolved model with `findings` of every severity.
 * No lanes are formed: C10 depends on the view, so only generate reports it.
 * @param {object} model - Logic-Core of format 1.x or 2.0
 * @param {string|object|null} profileOrPath - as validateLogicCore
 * @param {{ catalog?: object }} [options] - the actor catalogue object of a 2.0 model, as runPipeline
 *   takes it: a non-object, or a catalogue with a 1.x model, throws a TypeError
 */
function validateModel(model, profileOrPath = null, { catalog } = {}) {
  if (catalog != null && (typeof catalog !== 'object' || Array.isArray(catalog))) {
    throw new TypeError('catalog must be a catalogue object; read a file with loadCatalog');
  }
  if (modelFormat(model) !== '2') {
    if (catalog != null) throw new TypeError('catalog applies to format 2.0 models only');
    return validateLogicCore(model, profileOrPath);
  }
  const fields = resolveFields(model, { catalog: catalog ?? undefined });
  if (fields.errors.length) {
    return {
      errors: fields.errors, warnings: [], infos: [], advisories: [], metrics: {},
      findings: fields.errors.map((message) => ({ code: codeOf(message), severity: 'ERROR', message })),
    };
  }
  return validateLogicCore(fields.lc, profileOrPath, { withFindings: true });
}

export { validateLogicCore, validateModel };
