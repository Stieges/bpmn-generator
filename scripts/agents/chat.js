/**
 * Chat Agent — discovery conversation with the user before Logic-Core
 * extraction. Multi-turn; decides when enough context has been gathered
 * and produces a suggestedSummary to feed into the modeler agent.
 */

import { extractPromptSection } from './prompt-sections.js';

function extractJsonReply(text) {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  const jsonText = fenced ? fenced[1] : text.trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('Chat agent: could not parse LLM response as JSON');
  }
  if (!parsed || typeof parsed.reply !== 'string') {
    throw new Error('Chat agent: LLM response is missing a "reply" string');
  }

  return {
    reply: parsed.reply,
    readyToGenerate: Boolean(parsed.readyToGenerate),
    suggestedSummary: parsed.suggestedSummary ?? null,
  };
}

export async function chatAgent({ messages, llmProvider }) {
  if (!llmProvider) {
    throw new Error('Chat agent requires an llmProvider');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('Chat agent requires a non-empty messages array');
  }

  const systemPrompt = extractPromptSection('Chat Discovery Prompt');
  const fullMessages = [{ role: 'system', content: systemPrompt }, ...messages];

  const raw = await llmProvider(fullMessages, {
    responseFormat: { type: 'json_object' },
  });

  return extractJsonReply(raw);
}
