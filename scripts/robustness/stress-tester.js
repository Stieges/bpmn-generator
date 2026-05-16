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
import { runPipeline } from '../pipeline.js';

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

export async function runPipelineChecks(lc, { timeoutMs = 30_000 } = {}) {
  const start = Date.now();
  const result = {
    bpmnXml: null,
    svg: null,
    coordMap: null,
    validation: null,
    failedStep: null,
    error: null,
    durationMs: 0,
  };

  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), timeoutMs)
    );
    const pipelinePromise = runPipeline(lc);
    const r = await Promise.race([pipelinePromise, timeoutPromise]);

    result.bpmnXml = r.bpmnXml;
    result.svg = r.svg;
    result.coordMap = r.coordMap;
    result.validation = r.validation;
    result.durationMs = Date.now() - start;

    if (r.validation && r.validation.errors && r.validation.errors.length > 0) {
      result.failedStep = 'elk-or-xml';
      result.error = r.validation.errors[0];
    } else if (!r.bpmnXml) {
      result.failedStep = 'xml';
    } else if (!r.svg) {
      result.failedStep = 'svg';
    }
  } catch (e) {
    result.durationMs = Date.now() - start;
    result.failedStep = e.message === 'timeout' ? 'timeout' : 'pipeline-throw';
    result.error = e.message;
  }

  return result;
}
