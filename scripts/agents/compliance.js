/**
 * Compliance Agent — Deterministic rule-based compliance gate.
 * Runs the full rule engine (optionally with a strict profile).
 * Never loops — always returns done: true.
 */

import { runRules, loadRuleProfile } from '../bpmn/rules.js';

export async function complianceAgent(state) {
  // A path (CLI / library callers) is read through the safe loader; an object (the HTTP API, the
  // MCP server — both resolve or gate it before it gets here) is used as it is.
  const given = state.options?.ruleProfile ?? null;
  const profile = typeof given === 'string' ? loadRuleProfile(given) : given;
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
