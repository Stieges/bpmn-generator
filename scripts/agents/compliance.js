/**
 * Compliance Agent — Deterministic rule-based compliance gate.
 * Runs the full rule engine (optionally with a strict profile).
 * Never loops — always returns done: true.
 */

import { runRules, loadRuleProfile } from '../rules.js';

export async function complianceAgent(state) {
  const profilePath = state.options?.ruleProfile || null;
  const profile = profilePath ? loadRuleProfile(profilePath) : null;
  const result = runRules(state.logicCore, profile);

  return {
    compliance: {
      errors: result.errors,
      warnings: result.warnings,
      infos: result.infos || [],
      violations: [...result.errors, ...result.warnings],
      isCompliant: result.errors.length === 0,
    },
    done: true,
  };
}
