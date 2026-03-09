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
 */

import { modelerAgent } from './agents/modeler.js';
import { reviewerAgent } from './agents/reviewer.js';
import { layoutAgent } from './agents/layout.js';
import { complianceAgent } from './agents/compliance.js';

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
    compliance: null,
    history: [],
    iteration: 0,
  };

  // Phase 1: Modeler (only when text input + LLM available)
  if (state.userText && options.llmProvider) {
    try {
      const result = await modelerAgent(state);
      state.logicCore = result.logicCore;
      state.history.push({ agent: 'modeler', phase: 'extract', ts: new Date().toISOString() });
    } catch (err) {
      state.history.push({ agent: 'modeler', phase: 'extract', error: err.message, ts: new Date().toISOString() });
      throw new Error(`Modeler agent failed: ${err.message}`);
    }
  }

  if (!state.logicCore) {
    throw new Error('No logicCore — provide text + llmProvider, or a logicCore object');
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
      throw new Error(`Reviewer agent failed (iteration ${i}): ${err.message}`);
    }

    // Last iteration — don't try to fix, just proceed with what we have
    if (i === maxReviewIterations - 1) break;

    // Try to fix issues via Modeler (requires LLM)
    if (options.llmProvider) {
      try {
        const fix = await modelerAgent(state);
        state.logicCore = fix.logicCore;
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
      state.layoutFeedback = layout.layoutFeedback || [];
      state.history.push({
        agent: 'layout', iteration: i,
        feedbackCount: state.layoutFeedback.length,
        ts: new Date().toISOString(),
      });

      if (layout.done) break;
    } catch (err) {
      state.history.push({ agent: 'layout', iteration: i, error: err.message, ts: new Date().toISOString() });
      throw new Error(`Layout agent failed (iteration ${i}): ${err.message}`);
    }

    // Structural layout feedback → amend via Modeler
    const structural = state.layoutFeedback.filter(f => f.requiresLogicCoreChange);
    if (structural.length === 0) break;

    if (options.llmProvider) {
      try {
        state.layoutFeedback = structural;
        const amend = await modelerAgent(state);
        state.logicCore = amend.logicCore;
        state.layoutFeedback = []; // Reset after amendment
        state.history.push({ agent: 'modeler', phase: 'amend', iteration: i, ts: new Date().toISOString() });
      } catch (err) {
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
    state.history.push({ agent: 'compliance', error: err.message, ts: new Date().toISOString() });
    state.compliance = { isCompliant: false, errors: [`Compliance check failed: ${err.message}`], warnings: [] };
  }

  return {
    logicCore: state.logicCore,
    bpmnXml: state.bpmnXml,
    svg: state.svg,
    validation: state.validation,
    compliance: state.compliance,
    history: state.history,
    iterations: state.iteration + 1,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

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

  if (!inputPath && !textInput) {
    console.error('Usage: node orchestrator.js --input <logic-core.json> [--output <base>]');
    console.error('       node orchestrator.js --text "..." --api-url URL --api-key KEY --model MODEL');
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
    options.llmProvider = createLlmProvider({ baseUrl: apiUrl, apiKey, model });
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
