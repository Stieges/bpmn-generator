/**
 * LLM Provider — OpenAI-compatible fetch abstraction.
 * Supports cloud APIs (OpenAI, Azure) and local inference
 * (Ollama, llama.cpp, vLLM, text-generation-inference).
 *
 * Zero dependencies, uses native fetch.
 *
 * A failed call throws `LlmProviderError`. Its message names only the failure class and the HTTP
 * status; the upstream response body is kept in `detail` (truncated) for server-side logging and
 * must never be sent to a client — an endpoint's error page can carry anything.
 */

const DETAIL_MAX = 500;

export class LlmProviderError extends Error {
  constructor(message, { status = null, detail = '' } = {}) {
    super(message);
    this.name = 'LlmProviderError';
    this.code = 'LLM_ERROR';
    this.status = status;
    this.detail = String(detail).slice(0, DETAIL_MAX);
  }
}

// The default transport: global fetch, looked up per call (tests replace it). It never follows a
// redirect — a 3xx from the endpoint is a provider error, not a hop to wherever it points. A
// caller that targets a client-supplied URL passes a pinned transport instead
// (shared/outbound-url.js), which does not follow redirects either.
const fetchRequest = (url, { method, headers, body, timeoutMs }) =>
  fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });

export function createLlmProvider({ baseUrl, apiKey, model, timeout = 120_000, request = fetchRequest }) {
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

    let res;
    try {
      res = await request(`${normalizedBase}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages,
          ...(options.responseFormat && { response_format: options.responseFormat }),
          temperature: options.temperature ?? 0.2,
        }),
        timeoutMs: timeout,
      });
    } catch (err) {
      throw new LlmProviderError('LLM endpoint unreachable', { detail: err.message });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new LlmProviderError(`LLM endpoint returned ${res.status}`, { status: res.status, detail: body });
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw new LlmProviderError('LLM endpoint returned invalid JSON', { status: res.status, detail: err.message });
    }
    if (!data.choices?.length || !data.choices[0].message?.content) {
      throw new LlmProviderError(`LLM returned empty response (choices: ${data.choices?.length ?? 0})`, { status: res.status });
    }
    return data.choices[0].message.content;
  };
}
