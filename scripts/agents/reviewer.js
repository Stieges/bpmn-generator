/**
 * Reviewer Agent — Deterministic validation via rule engine.
 * Wraps validateLogicCore() and maps results to structured issues.
 * Only blocks on ERRORs (soundness). Warnings pass through.
 */

import { validateLogicCore } from '../validate.js';

export async function reviewerAgent(state) {
  const { errors, warnings } = validateLogicCore(state.logicCore);

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
