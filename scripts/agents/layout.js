/**
 * Layout Agent — Runs the BPMN pipeline (ELK layout → XML + SVG).
 * Optionally reviews the SVG via a vision-capable LLM.
 *
 * Without enableLayoutReview: just generates and returns done: true.
 * With enableLayoutReview: sends SVG to vision LLM for feedback.
 */

import { runPipeline } from '../pipeline.js';

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

async function reviewLayout(llmProvider, svg) {
  try {
    const raw = await llmProvider(
      LAYOUT_REVIEW_PROMPT,
      `SVG diagram (${svg.length} chars):\n${svg.slice(0, 50_000)}`,
      { responseFormat: { type: 'json_object' } },
    );

    const parsed = JSON.parse(raw.trim().startsWith('{') ? raw : raw.match(/```json\s*\n([\s\S]*?)\n```/)?.[1] || '{"feedback":[]}');
    return parsed.feedback || [];
  } catch {
    return []; // Vision review failed — proceed without feedback
  }
}

export async function layoutAgent(state) {
  const result = await runPipeline(state.logicCore);

  const update = {
    bpmnXml: result.bpmnXml,
    svg: result.svg,
    coordMap: result.coordMap,
    validation: result.validation,
    layoutFeedback: [],
    done: true,
  };

  // Optional vision-based layout review
  if (state.options?.enableLayoutReview && state.options?.llmProvider) {
    const feedback = await reviewLayout(state.options.llmProvider, result.svg);
    update.layoutFeedback = feedback;
    const structural = feedback.filter(f => f.requiresLogicCoreChange);
    update.done = structural.length === 0;
  }

  return update;
}
