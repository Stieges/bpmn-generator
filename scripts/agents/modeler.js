/**
 * Modeler Agent — LLM-powered Logic-Core extraction and correction.
 *
 * Three modes:
 *   extract  — First run: text description → Logic-Core JSON
 *   refine   — After reviewer issues: current JSON + issues → corrected JSON
 *   amend    — After layout feedback: current JSON + feedback → amended JSON
 */

import { extractPromptSection } from './prompt-sections.js';
import { languageTag, modelLanguage, namingFor, languageName } from '../bpmn/naming/index.js';

let _promptSections = null;

function loadPromptSections() {
  if (_promptSections) return _promptSections;
  _promptSections = {
    masterExtraction: extractPromptSection('Master Extraction Prompt'),
    refinement: extractPromptSection('Refinement / Correction Prompt'),
    amendment: extractPromptSection('Amendment Prompt'),
  };
  return _promptSections;
}

// One last line that keeps the declared language of a model. A NamingDataError of a broken
// BPMN_NAMING file is not caught here: it is the same defect the rules report.
function languageLine(logicCore) {
  const tag = languageTag(logicCore);
  if (tag === null) return '';
  const strategy = namingFor(modelLanguage(logicCore));
  const line = strategy
    ? `The labels of this model are in ${languageName(modelLanguage(logicCore))} (language "${tag}"): name tasks like "${strategy.examples.task}" and keep the "language" field unchanged.`
    : `The labels of this model are in the language "${tag}": keep them in that language and keep the "language" field unchanged.`;
  return `\n${line}`;
}

function detectMode(state) {
  if (state.layoutFeedback?.length > 0) return 'amend';
  if (state.reviewIssues?.length > 0 && state.logicCore) return 'refine';
  return 'extract';
}

export function buildPrompt(state) {
  const sections = loadPromptSections();
  const mode = detectMode(state);

  if (mode === 'extract') {
    const systemPrompt = sections.masterExtraction.replace('{{USER_TEXT}}', '');
    const userPrompt = state.userText;
    return { systemPrompt, userPrompt, mode };
  }

  if (mode === 'refine') {
    const issueText = state.reviewIssues
      .map(i => `[${i.severity}] ${i.problem}`)
      .join('\n');
    const systemPrompt = sections.refinement
      .replace('{{ISSUES}}', issueText)
      .replace('{{CURRENT_JSON}}', JSON.stringify(state.logicCore, null, 2));
    return { systemPrompt: systemPrompt + languageLine(state.logicCore), userPrompt: 'Fix the issues listed above.', mode };
  }

  // amend
  const feedbackText = state.layoutFeedback
    .map(f => `- ${f.issue}: ${f.suggestion}`)
    .join('\n');
  const systemPrompt = sections.amendment
    .replace('{{CURRENT_JSON}}', JSON.stringify(state.logicCore, null, 2))
    .replace('{{CHANGE_DESCRIPTION}}', feedbackText);
  return { systemPrompt: systemPrompt + languageLine(state.logicCore), userPrompt: 'Apply the layout improvements above.', mode };
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  let parsed;
  if (fenced) parsed = JSON.parse(fenced[1]);
  else {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) parsed = JSON.parse(trimmed);
    else throw new Error('Modeler: Could not extract JSON from LLM response');
  }
  return unwrapLogicCore(parsed);
}

// Tolerate common LLM wrappers (e.g. { process: {...} }, { data: {...} }).
// A Logic-Core root has nodes+edges OR pools. If not, peek one level deeper.
function unwrapLogicCore(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const isRoot = (o) => o && typeof o === 'object' && (Array.isArray(o.pools) || (Array.isArray(o.nodes) && Array.isArray(o.edges)));
  if (isRoot(obj)) return obj;
  for (const key of ['process', 'processes', 'data', 'result', 'bpmn', 'logicCore', 'logic_core']) {
    const inner = obj[key];
    if (isRoot(inner)) return inner;
    if (Array.isArray(inner) && inner.length === 1 && isRoot(inner[0])) return inner[0];
  }
  return obj;
}

export async function modelerAgent(state) {
  const llmProvider = state.options?.llmProvider;
  if (!llmProvider) {
    throw new Error('Modeler agent requires an llmProvider in options');
  }

  const { systemPrompt, userPrompt, mode } = buildPrompt(state);
  const raw = await llmProvider(systemPrompt, userPrompt, {
    responseFormat: { type: 'json_object' },
  });

  const logicCore = extractJson(raw);
  // The Modeler keeps the declared language of the model; a language it changed is judged downstream.
  if (mode !== 'extract') {
    const tag = languageTag(state.logicCore);
    if (tag !== null && logicCore && typeof logicCore === 'object' && !Array.isArray(logicCore)
      && !Object.hasOwn(logicCore, 'language')) logicCore.language = tag;
  }

  return { logicCore, mode };
}
