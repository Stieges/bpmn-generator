/**
 * Stress-tester — runs samples through pre-filter, then full pipeline + roundtrip.
 * See spec Section 4.4.
 *
 * API verified against actual scripts/validate.js and scripts/rules.js:
 * - validateLogicCore(lc) → sync, returns { errors: string[], warnings: string[] }
 * - runRules(lc, profile=null) → returns { errors: string[], warnings: string[], infos: string[], metrics: {} }
 */

import { validateLogicCore } from '../validate.js';
import { runRules } from '../rules.js';

export async function preFilter(lc) {
  // Phase A.1: schema validation
  const schemaResult = validateLogicCore(lc);
  if (schemaResult.errors && schemaResult.errors.length > 0) {
    return {
      passed: false,
      schemaErrors: schemaResult.errors,
      ruleErrors: [],
      schemaWarnings: schemaResult.warnings || [],
      ruleWarnings: [],
    };
  }

  // Phase A.2: rule engine
  let ruleResult;
  try {
    ruleResult = runRules(lc);
  } catch (e) {
    return {
      passed: false,
      schemaErrors: [],
      ruleErrors: [`runRules threw: ${e.message}`],
      schemaWarnings: schemaResult.warnings || [],
      ruleWarnings: [],
    };
  }

  const ruleErrors = ruleResult.errors || [];
  const ruleWarnings = ruleResult.warnings || [];

  return {
    passed: ruleErrors.length === 0,
    schemaErrors: [],
    ruleErrors,
    schemaWarnings: schemaResult.warnings || [],
    ruleWarnings,
  };
}
