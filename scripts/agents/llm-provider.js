/**
 * LLM Provider — OpenAI-compatible fetch abstraction.
 * Supports cloud APIs (OpenAI, Azure) and local inference
 * (Ollama, llama.cpp, vLLM, text-generation-inference).
 *
 * Zero dependencies, uses native fetch.
 */

export function createLlmProvider({ baseUrl, apiKey, model, timeout = 120_000 }) {
  const normalizedBase = baseUrl.replace(/\/$/, '');
  const isLocal = !apiKey || apiKey === 'none' || apiKey === 'local';

  return async function callLlm(systemOrMessages, userPromptOrOptions, maybeOptions) {
    // Two call shapes:
    //   (systemPrompt, userPrompt, options?)     — legacy 2-message
    //   (messages[], options?)                   — multi-turn (chat)
    let messages;
    let options;
    if (Array.isArray(systemOrMessages)) {
      messages = systemOrMessages;
      options = userPromptOrOptions || {};
    } else {
      messages = [
        { role: 'system', content: systemOrMessages },
        { role: 'user', content: userPromptOrOptions },
      ];
      options = maybeOptions || {};
    }

    const headers = { 'Content-Type': 'application/json' };
    if (!isLocal) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const res = await fetch(`${normalizedBase}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages,
        ...(options.responseFormat && { response_format: options.responseFormat }),
        temperature: options.temperature ?? 0.2,
      }),
      signal: AbortSignal.timeout(timeout),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM API ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    if (!data.choices?.length || !data.choices[0].message?.content) {
      throw new Error(`LLM returned empty response (choices: ${data.choices?.length ?? 0})`);
    }
    return data.choices[0].message.content;
  };
}
