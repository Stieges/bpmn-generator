/**
 * Layout Agent — Runs the BPMN pipeline (ELK layout → XML + SVG) with the caller's rule profile and
 * mode, the ones the reviewer and compliance apply.
 * Optionally reviews the diagram via an LLM: the SVG markup goes as text (the first 50 000
 * characters), not as an image.
 *
 * Without enableLayoutReview: just generates and returns done: true.
 * With enableLayoutReview: asks the LLM for feedback. Its answer is checked: `feedback` must be an
 * array, an item needs a string `issue` and `suggestion`, and only `requiresLogicCoreChange === true`
 * counts as structural. A review that fails — the call, the JSON, the shape — leaves no feedback and
 * says why in `layoutReviewError`; it never fails the run.
 */

import { runPipeline } from '../bpmn/pipeline.js';

const LAYOUT_REVIEW_PROMPT = `You are a BPMN diagram layout reviewer.
Analyze this SVG diagram and identify layout issues:

1. Overlapping labels or elements
2. Unnecessarily long edges that could be shortened
3. Poor alignment of parallel paths
4. Crossed edges that could be avoided
5. Elements too close together or too far apart

For each issue, respond with:
- issue: short description
- suggestion: what to change
- requiresLogicCoreChange: true if the fix needs structural changes (splitting tasks, adding subprocess), false if purely cosmetic

Respond as JSON: { "feedback": [...] }
If the layout looks good, respond: { "feedback": [] }`;

/** `{ feedback, error }` — feedback items that hold their shape; error says why there are none. */
async function reviewLayout(llmProvider, svg) {
  let raw;
  try {
    raw = await llmProvider(
      LAYOUT_REVIEW_PROMPT,
      `SVG diagram (${svg.length} chars):\n${svg.slice(0, 50_000)}`,
      { responseFormat: { type: 'json_object' } },
    );
  } catch (err) {
    return { feedback: [], error: `layout review call failed: ${err.message}` };
  }
  const text = String(raw ?? '');
  const json = text.trim().startsWith('{') ? text : text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)?.[1];
  if (!json) return { feedback: [], error: 'layout review answer is not JSON' };
  let parsed;
  try { parsed = JSON.parse(json); } catch { return { feedback: [], error: 'layout review answer is not valid JSON' }; }
  if (!Array.isArray(parsed?.feedback)) return { feedback: [], error: 'layout review answer has no feedback array' };
  const feedback = parsed.feedback
    .filter((f) => f && typeof f.issue === 'string' && typeof f.suggestion === 'string')
    .map((f) => ({ issue: f.issue, suggestion: f.suggestion, requiresLogicCoreChange: f.requiresLogicCoreChange === true }));
  const dropped = parsed.feedback.length - feedback.length;
  return { feedback, error: dropped ? `${dropped} layout review item(s) without a string issue and suggestion dropped` : null };
}

export async function layoutAgent(state) {
  const result = await runPipeline(state.logicCore, {
    mode: state.options?.mode,
    ruleProfile: state.options?.ruleProfile,
    visualRefinement: state.options?.visualRefinement,
    bendRule: state.options?.bendRule,
    nodeLabelsAvoidFlows: state.options?.nodeLabelsAvoidFlows,
    foreignShapeRepair: state.options?.foreignShapeRepair,
  });

  const update = {
    bpmnXml: result.bpmnXml,
    svg: result.svg,
    coordMap: result.coordMap,
    validation: result.validation,
    // Deterministic geometry findings. Passed through, NOT fed back into the
    // iteration: DI01–DI04 and DI06 are generator defects, and re-running with
    // the same Logic-Core would produce the same broken geometry. They belong
    // in the report so a human sees them, not in a retry loop.
    diagnostics: result.diagnostics,
    layoutFeedback: [],
    done: true,
  };

  // Optional vision-based layout review
  if (state.options?.enableLayoutReview && state.options?.llmProvider) {
    const { feedback, error } = await reviewLayout(state.options.llmProvider, result.svg);
    update.layoutFeedback = feedback;
    update.layoutReviewError = error;
    const structural = feedback.filter(f => f.requiresLogicCoreChange);
    update.done = structural.length === 0;
  }

  return update;
}
