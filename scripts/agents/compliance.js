/**
 * Compliance Agent — Deterministic rule-based compliance gate.
 * Runs the full rule engine (optionally with a strict profile).
 * Never loops — always returns done: true.
 */

import { runRules, resolveRuleProfile } from '../bpmn/rules.js';

export async function complianceAgent(state) {
  // A path (CLI / library callers) is read through the safe loader; an object (the HTTP API, the
  // MCP server — both resolve or gate it before it gets here) is used as it is.
  // The mode applies here too (resolveRuleProfile), as in the reviewer and the layout pass.
  const profile = resolveRuleProfile(state.options?.ruleProfile ?? null, state.options?.mode);
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
