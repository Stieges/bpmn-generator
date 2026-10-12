/**
 * Reviewer Agent — Deterministic validation via rule engine.
 * Wraps validateLogicCore() and maps results to structured issues.
 * Only blocks on ERRORs (soundness). Warnings pass through.
 */

import { validateLogicCore } from '../bpmn/validate.js';
import { resolveRuleProfile } from '../bpmn/rules.js';

export async function reviewerAgent(state) {
  // The caller's profile and mode, as compliance and the layout pass apply them: a rule the profile
  // makes an ERROR is one the refinement loop must hear about.
  const profile = resolveRuleProfile(state.options?.ruleProfile ?? null, state.options?.mode);
  const { errors, warnings } = validateLogicCore(state.logicCore, profile);

  const issues = [
    ...errors.map(msg => ({ severity: 'ERROR', problem: msg })),
    ...warnings.map(msg => ({ severity: 'WARNING', problem: msg })),
  ];

  return {
    reviewIssues: issues,
    isValid: errors.length === 0,
    done: errors.length === 0,
  };
}
