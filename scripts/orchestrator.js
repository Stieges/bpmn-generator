/**
 * BPMN Multi-Agent Orchestrator — State machine that chains
 * Modeler → Reviewer → Layout → Compliance agents.
 *
 * Usage:
 *   import { orchestrate } from './orchestrator.js';
 *
 *   // With LLM (full cycle: text → BPMN)
 *   const result = await orchestrate('Process description...', { llmProvider });
 *
 *   // Without LLM (review + generate + compliance only)
 *   const result = await orchestrate(logicCoreJson);
 *
 * CLI:
 *   node orchestrator.js --input logic-core.json --output /tmp/result
 *   node orchestrator.js --text "..." --api-url URL --api-key KEY --model MODEL --output /tmp/result
 *   (--timeout <seconds>: LLM request timeout, default 120; --retries <n>: attempts after the first
 *   on a transport error or 408/429/5xx, default config.json → llm.retry; --extra-body '<json>':
 *   extra request fields, e.g. '{"chat_template_kwargs":{"enable_thinking":false}}')
 */

import { modelerAgent } from './agents/modeler.js';
import { reviewerAgent } from './agents/reviewer.js';
import { layoutAgent } from './agents/layout.js';
import { complianceAgent } from './agents/compliance.js';
import { validateLogicCoreSchema, formatSchemaErrors } from './bpmn/schema-gate.js';
import { ProfileRejectedError } from './shared/rule-profile.js';
import { isMainModule } from './shared/entry-point.js';

const ts = () => new Date().toISOString();

/**
 * One Modeler call whose output passes the schema gate — the rule "no LLM output downstream without
 * schema validation" holds for extract, refine and amend alike, not only for the first extraction.
 * A rejected output gets up to `options.maxSchemaRepairs` (default 1) repair attempts: the gate's
 * errors become the issues of the refinement prompt, with the rejected JSON as the current one —
 * the same prompt the reviewer loop uses, so no second prompt has to agree with the schema. Every
 * rejection is in `state.history` (`agent: 'schema-gate'`). Returns the valid Logic-Core; throws
 * when none came back, with `state.logicCore`, `reviewIssues` and `layoutFeedback` as before the
 * call, so a caller in a loop can go on with the last valid model.
 */
async function gatedModelerCall(state, phase) {
  const repairs = state.options.maxSchemaRepairs ?? 1;
  const saved = { logicCore: state.logicCore, reviewIssues: state.reviewIssues, layoutFeedback: state.layoutFeedback };
  const restore = () => Object.assign(state, saved);
  try {
    let { logicCore } = await modelerAgent(state);
    for (let attempt = 0; ; attempt++) {
      const check = validateLogicCoreSchema(logicCore);
      if (check.valid) {
        Object.assign(state, { reviewIssues: saved.reviewIssues, layoutFeedback: saved.layoutFeedback });
        return logicCore;
      }
      state.history.push({ agent: 'schema-gate', phase, attempt, errorCount: check.errors.length,
        errors: formatSchemaErrors(check.errors, 5), ts: ts() });
      if (attempt >= repairs) throw new Error(`Logic-Core failed schema validation:\n${formatSchemaErrors(check.errors)}`);
      // The refinement prompt (modeler.js detectMode: issues and a current model, no layout feedback).
      Object.assign(state, {
        logicCore,
        reviewIssues: check.errors.map((e) => ({ severity: 'ERROR', problem: `Schema: ${formatSchemaErrors([e])}` })),
        layoutFeedback: [],
      });
      ({ logicCore } = await modelerAgent(state));
      state.history.push({ agent: 'modeler', phase: 'schema-repair', of: phase, attempt: attempt + 1, ts: ts() });
    }
  } catch (err) {
    restore();
    throw err;
  }
}

/**
 * @param {string|object} input - process description (needs `options.llmProvider`) or Logic-Core
 * @param {object} [options] - besides the loop bounds (`maxReviewIterations`, `maxLayoutIterations`,
 *   `maxSchemaRepairs` — repair attempts for a Modeler output the schema gate rejects, default 1),
 *   `llmProvider`, `ruleProfile` and `mode`, the
 *   per-call layout options `visualRefinement`, `bendRule`, `nodeLabelsAvoidFlows` and
 *   `foreignShapeRepair`, which the layout agent forwards to runPipeline unchanged. Callers on a client surface gate them first
 *   (`validateLayoutOptions` in bpmn/schema-gate.js).
 */
export async function orchestrate(input, options = {}) {
  const maxReviewIterations = options.maxReviewIterations ?? 3;
  const maxLayoutIterations = options.maxLayoutIterations ?? 2;

  const state = {
    userText: typeof input === 'string' ? input : null,
    logicCore: typeof input === 'object' ? input : null,
    options,
    reviewIssues: [],
    layoutFeedback: [],
    bpmnXml: null,
    svg: null,
    coordMap: null,
    validation: null,
    diagnostics: null,
    compliance: null,
    history: [],
    iteration: 0,
  };

  // Phase 1: Modeler (only when text input + LLM available)
  if (state.userText && options.llmProvider) {
    try {
      state.logicCore = await gatedModelerCall(state, 'extract');
      state.history.push({ agent: 'modeler', phase: 'extract', ts: new Date().toISOString() });
    } catch (err) {
      state.history.push({ agent: 'modeler', phase: 'extract', error: err.message, ts: new Date().toISOString() });
      throw new Error(`Modeler agent failed: ${err.message}`, { cause: err });
    }
  }

  if (!state.logicCore) {
    throw new Error('No logicCore — provide text + llmProvider, or a logicCore object');
  }

  // Schema-strict gate for a Logic-Core passed in directly (a Modeler output has passed it in
  // gatedModelerCall already): caught at the boundary, before reviewer and layout; not repaired —
  // there is no LLM to ask, and the caller's input is the caller's to fix.
  const schemaCheck = validateLogicCoreSchema(state.logicCore);
  if (!schemaCheck.valid) {
    state.history.push({ agent: 'schema-gate', phase: 'reject', errors: schemaCheck.errors, ts: new Date().toISOString() });
    throw new Error(`Logic-Core failed schema validation:\n${formatSchemaErrors(schemaCheck.errors)}`);
  }

  // Phase 2: Review loop
  for (let i = 0; i < maxReviewIterations; i++) {
    state.iteration = i;
    try {
      const review = await reviewerAgent(state);
      state.reviewIssues = review.reviewIssues;
      state.history.push({
        agent: 'reviewer', iteration: i,
        isValid: review.isValid,
        issueCount: review.reviewIssues.length,
        ts: new Date().toISOString(),
      });

      if (review.isValid) break;
    } catch (err) {
      state.history.push({ agent: 'reviewer', iteration: i, error: err.message, ts: new Date().toISOString() });
      throw new Error(`Reviewer agent failed (iteration ${i}): ${err.message}`, { cause: err });
    }

    // Last iteration — don't try to fix, just proceed with what we have
    if (i === maxReviewIterations - 1) break;

    // Try to fix issues via Modeler (requires LLM)
    if (options.llmProvider) {
      try {
        state.logicCore = await gatedModelerCall(state, 'refine');
        state.history.push({ agent: 'modeler', phase: 'refine', iteration: i, ts: new Date().toISOString() });
      } catch (err) {
        state.history.push({ agent: 'modeler', phase: 'refine', iteration: i, error: err.message, ts: new Date().toISOString() });
        break; // Cannot fix, proceed with current logicCore
      }
    } else {
      break; // Without LLM we cannot fix issues
    }
  }

  // Phase 3: Pipeline + Layout
  for (let i = 0; i < maxLayoutIterations; i++) {
    try {
      const layout = await layoutAgent(state);
      state.bpmnXml = layout.bpmnXml;
      state.svg = layout.svg;
      state.coordMap = layout.coordMap;
      state.validation = layout.validation;
      state.diagnostics = layout.diagnostics;
      state.layoutFeedback = layout.layoutFeedback || [];
      state.history.push({
        agent: 'layout', iteration: i,
        feedbackCount: state.layoutFeedback.length,
        ...(layout.layoutReviewError && { reviewError: layout.layoutReviewError }),
        ts: new Date().toISOString(),
      });

      if (layout.done) break;
    } catch (err) {
      state.history.push({ agent: 'layout', iteration: i, error: err.message, ts: new Date().toISOString() });
      throw new Error(`Layout agent failed (iteration ${i}): ${err.message}`, { cause: err });
    }

    // Structural layout feedback → amend via Modeler
    const structural = state.layoutFeedback.filter(f => f.requiresLogicCoreChange);
    if (structural.length === 0) break;
    // An amendment is only worth making when a layout pass follows it: after the last one it would
    // return a logicCore that is not the model in bpmnXml, and compliance would judge a model
    // nobody laid out.
    if (i === maxLayoutIterations - 1) break;

    if (options.llmProvider) {
      try {
        state.layoutFeedback = structural;
        const amended = await gatedModelerCall(state, 'amend');
        state.layoutFeedback = []; // Reset after amendment
        // The amended model passes the reviewer, as the first one did: an amendment that breaks
        // soundness is dropped, and the run keeps the model and the layout it already has.
        const review = await reviewerAgent({ ...state, logicCore: amended });
        state.history.push({
          agent: 'reviewer', phase: 'amend', iteration: i,
          isValid: review.isValid, issueCount: review.reviewIssues.length, ts: new Date().toISOString(),
        });
        if (!review.isValid) {
          state.history.push({ agent: 'modeler', phase: 'amend', iteration: i,
            error: 'amendment dropped: the reviewer found errors in it', ts: new Date().toISOString() });
          break;
        }
        state.logicCore = amended;
        state.reviewIssues = review.reviewIssues;
        state.history.push({ agent: 'modeler', phase: 'amend', iteration: i, ts: new Date().toISOString() });
      } catch (err) {
        state.layoutFeedback = [];
        state.history.push({ agent: 'modeler', phase: 'amend', iteration: i, error: err.message, ts: new Date().toISOString() });
        break; // Cannot amend, proceed with current layout
      }
    } else {
      break;
    }
  }

  // Phase 4: Compliance gate
  try {
    const comp = await complianceAgent(state);
    state.compliance = comp.compliance;
    state.history.push({
      agent: 'compliance',
      isCompliant: comp.compliance.isCompliant,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    // A refused rule profile is the caller's input, not a compliance verdict on the model.
    if (err instanceof ProfileRejectedError) throw err;
    state.history.push({ agent: 'compliance', error: err.message, ts: new Date().toISOString() });
    state.compliance = { isCompliant: false, errors: [`Compliance check failed: ${err.message}`], warnings: [] };
  }

  return {
    logicCore: state.logicCore,
    bpmnXml: state.bpmnXml,
    svg: state.svg,
    validation: state.validation,
    diagnostics: state.diagnostics,
    compliance: state.compliance,
    history: state.history,
    iterations: state.iteration + 1,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────
const isMain = isMainModule(import.meta.url, process.argv[1]);

if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

  const inputPath = flag('--input');
  const textInput = flag('--text');
  const outputBase = flag('--output') || '/tmp/orchestrated';
  const apiUrl = flag('--api-url');
  const apiKey = flag('--api-key');
  const model = flag('--model');
  const enableLayoutReview = args.includes('--layout-review');
  const timeoutArg = flag('--timeout');
  const timeoutSec = timeoutArg === null ? null : Number(timeoutArg);
  if (timeoutArg !== null && !(Number.isFinite(timeoutSec) && timeoutSec > 0)) {
    console.error(`--timeout takes a positive number of seconds, got: ${timeoutArg}`);
    process.exit(1);
  }
  const retriesArg = flag('--retries');
  const retries = retriesArg === null ? null : Number(retriesArg);
  if (retriesArg !== null && !(Number.isInteger(retries) && retries >= 0)) {
    console.error(`--retries takes a whole number ≥ 0, got: ${retriesArg}`);
    process.exit(1);
  }
  const extraBodyArg = flag('--extra-body');
  let extraBody = null;
  if (extraBodyArg !== null) {
    try { extraBody = JSON.parse(extraBodyArg); } catch { extraBody = null; }
    if (!extraBody || typeof extraBody !== 'object' || Array.isArray(extraBody)) {
      console.error(`--extra-body takes a JSON object, got: ${extraBodyArg}`);
      process.exit(1);
    }
  }

  if (!inputPath && !textInput) {
    console.error('Usage: node orchestrator.js --input <logic-core.json> [--output <base>]');
    console.error('       node orchestrator.js --text "..." --api-url URL --api-key KEY --model MODEL [--timeout <seconds>] [--retries <n>] [--extra-body <json>]');
    process.exit(1);
  }

  const options = { enableLayoutReview };

  let input;
  if (inputPath) {
    const { readFileSync } = await import('node:fs');
    input = JSON.parse(readFileSync(inputPath, 'utf8'));
  } else {
    input = textInput;
    if (!apiUrl || !apiKey || !model) {
      console.error('Text mode requires --api-url, --api-key, and --model');
      process.exit(1);
    }
    const { createLlmProvider } = await import('./agents/llm-provider.js');
    // A thinking model or a slow endpoint can need more than the provider's default (120 s).
    options.llmProvider = createLlmProvider({ baseUrl: apiUrl, apiKey, model,
      ...(timeoutSec !== null && { timeout: Math.round(timeoutSec * 1000) }),
      ...(retries !== null && { retry: { retries } }),
      ...(extraBody && { extraBody }),
      onRetry: ({ attempt, retries: n, status, delayMs }) => console.error(
        `\u21bb LLM ${status ?? 'unreachable'}, retry ${attempt}/${n} in ${(delayMs / 1000).toFixed(1)} s`),
    });
  }

  try {
    const result = await orchestrate(input, options);
    const { writeFileSync } = await import('node:fs');

    if (result.bpmnXml) writeFileSync(`${outputBase}.bpmn`, result.bpmnXml, 'utf8');
    if (result.svg) writeFileSync(`${outputBase}.svg`, result.svg, 'utf8');
    writeFileSync(`${outputBase}.orchestration.json`, JSON.stringify({
      compliance: result.compliance,
      history: result.history,
      iterations: result.iterations,
    }, null, 2), 'utf8');

    const ok = result.compliance?.isCompliant ? 'COMPLIANT' : 'NON-COMPLIANT';
    console.log(`\u2713 Orchestration complete (${result.iterations} iteration${result.iterations > 1 ? 's' : ''}) — ${ok}`);
    if (result.bpmnXml) console.log(`  BPMN \u2192 ${outputBase}.bpmn`);
    if (result.svg) console.log(`  SVG  \u2192 ${outputBase}.svg`);
    console.log(`  Log  \u2192 ${outputBase}.orchestration.json`);

    if (!result.compliance?.isCompliant) {
      console.log(`\n  ${result.compliance.errors.length} error(s), ${result.compliance.warnings.length} warning(s)`);
      for (const e of result.compliance.errors) console.log(`  \u2717 ${e}`);
    }
  } catch (err) {
    console.error(`Orchestration failed: ${err.message}`);
    process.exit(1);
  }
}
