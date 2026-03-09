/**
 * Modeler Agent — LLM-powered Logic-Core extraction and correction.
 *
 * Three modes:
 *   extract  — First run: text description → Logic-Core JSON
 *   refine   — After reviewer issues: current JSON + issues → corrected JSON
 *   amend    — After layout feedback: current JSON + feedback → amended JSON
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptPath = join(__dirname, '..', '..', 'references', 'prompt-template.md');

let _promptSections = null;

function loadPromptSections() {
  if (_promptSections) return _promptSections;
  const raw = readFileSync(promptPath, 'utf8');

  // Extract code blocks after each section header
  const extract = (header) => {
    const re = new RegExp(`## ${header}[\\s\\S]*?\`\`\`\\n([\\s\\S]*?)\`\`\``, 'i');
    const m = raw.match(re);
    return m ? m[1].trim() : '';
  };

  _promptSections = {
    masterExtraction: extract('Master Extraction Prompt'),
    refinement: extract('Refinement / Correction Prompt'),
    amendment: extract('Amendment Prompt'),
  };
  return _promptSections;
}

function detectMode(state) {
  if (state.layoutFeedback?.length > 0) return 'amend';
  if (state.reviewIssues?.length > 0 && state.logicCore) return 'refine';
  return 'extract';
}

function buildPrompt(state) {
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
    return { systemPrompt, userPrompt: 'Fix the issues listed above.', mode };
  }

  // amend
  const feedbackText = state.layoutFeedback
    .map(f => `- ${f.issue}: ${f.suggestion}`)
    .join('\n');
  const systemPrompt = sections.amendment
    .replace('{{CURRENT_JSON}}', JSON.stringify(state.logicCore, null, 2))
    .replace('{{CHANGE_DESCRIPTION}}', feedbackText);
  return { systemPrompt, userPrompt: 'Apply the layout improvements above.', mode };
}

function extractJson(text) {
  // Try fenced code block first
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenced) return JSON.parse(fenced[1]);

  // Try raw JSON (starts with { or [)
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }

  throw new Error('Modeler: Could not extract JSON from LLM response');
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

  return { logicCore, mode };
}
