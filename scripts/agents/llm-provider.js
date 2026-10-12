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
 *
 * Retry (config.json → llm.retry, per instance `retry`): a transport error or timeout, or a status
 * in `statuses` (by default 408, 429, 500, 502, 503, 504), is tried again up to `retries` times —
 * after the endpoint's Retry-After (seconds or an HTTP date) capped at `retryAfterMaxMs`, else after
 * `baseDelayMs · 2^n` capped at `maxDelayMs`, with jitter. Any other failure is final at once: a
 * wrong key, model or request does not get better by asking again. Retry rides out a short outage
 * or a burst of rate limiting, not an endpoint that has no capacity for minutes.
 */

import { CFG } from '../shared/utils.js';

const DETAIL_MAX = 500;
const RETRY_DEFAULTS = { retries: 0, baseDelayMs: 1000, maxDelayMs: 30_000, retryAfterMaxMs: 60_000, statuses: [] };

export class LlmProviderError extends Error {
  constructor(message, { status = null, detail = '', attempts = 1 } = {}) {
    super(message);
    this.name = 'LlmProviderError';
    this.code = 'LLM_ERROR';
    this.status = status;
    this.detail = String(detail).slice(0, DETAIL_MAX);
    this.attempts = attempts;
  }
}

// The default transport: global fetch, looked up per call (tests replace it). It never follows a
// redirect — a 3xx from the endpoint is a provider error, not a hop to wherever it points. A
// caller that targets a client-supplied URL passes a pinned transport instead
// (shared/outbound-url.js), which does not follow redirects either.
const fetchRequest = (url, { method, headers, body, timeoutMs }) =>
  fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry-After as milliseconds (delta-seconds or an HTTP date), or null. */
function retryAfterMs(res, now = Date.now()) {
  const v = res?.headers?.get?.('retry-after');
  if (v === null || v === undefined || v === '') return null;
  if (/^\d+(\.\d+)?$/.test(String(v).trim())) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * @param {object} o
 * @param {object} [o.retry] - overrides config.json → llm.retry for this instance (`{ retries: 0 }`: one attempt)
 * @param {object} [o.extraBody] - extra request fields for this endpoint, e.g.
 *   `{ chat_template_kwargs: { enable_thinking: false } }`; cannot replace model, messages,
 *   response_format or temperature
 * @param {function} [o.onRetry] - called before each wait with `{ attempt, retries, status, delayMs }`
 * @param {function} [o.sleep] / [o.random] - injected in tests
 */
export function createLlmProvider({ baseUrl, apiKey, model, timeout = 120_000, request = fetchRequest,
  retry = {}, extraBody = null, onRetry = null, sleep = realSleep, random = Math.random }) {
  const normalizedBase = baseUrl.replace(/\/$/, '');
  const isLocal = !apiKey || apiKey === 'none' || apiKey === 'local';
  const policy = { ...RETRY_DEFAULTS, ...(CFG.llm?.retry ?? {}), ...retry };
  const retryable = new Set(policy.statuses);

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
    const body = JSON.stringify({
      ...(extraBody && typeof extraBody === 'object' ? extraBody : {}),
      model,
      messages,
      ...(options.responseFormat && { response_format: options.responseFormat }),
      temperature: options.temperature ?? 0.2,
    });

    let res;
    for (let attempt = 0; ; attempt++) {
      const attempts = attempt + 1;
      let failure = null;
      try {
        res = await request(`${normalizedBase}/chat/completions`, { method: 'POST', headers, body, timeoutMs: timeout });
        if (res.ok) break;
        if (!retryable.has(res.status)) failure = 'final';
        else failure = 'status';
      } catch (err) {
        res = null;
        failure = { transport: err };
      }
      if (failure === 'final' || attempt >= policy.retries) {
        if (res === null) {
          throw new LlmProviderError(`LLM endpoint unreachable${attempts > 1 ? ` (${attempts} attempts)` : ''}`,
            { detail: failure.transport?.message ?? '', attempts });
        }
        const text = await res.text().catch(() => '');
        throw new LlmProviderError(`LLM endpoint returned ${res.status}${attempts > 1 ? ` (${attempts} attempts)` : ''}`,
          { status: res.status, detail: text, attempts });
      }
      const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt) * (0.5 + random() / 2);
      const asked = res ? retryAfterMs(res) : null;
      const delayMs = Math.round(asked !== null ? Math.min(asked, policy.retryAfterMaxMs) : backoff);
      onRetry?.({ attempt: attempt + 1, retries: policy.retries, status: res?.status ?? null, delayMs });
      await sleep(delayMs);
    }

    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw new LlmProviderError('LLM endpoint returned invalid JSON', { status: res.status, detail: err.message });
    }
    const message = data.choices?.[0]?.message;
    if (!message?.content && message?.reasoning_content) {
      // A thinking model that spent its answer on reasoning: the reasoning is not the answer.
      throw new LlmProviderError('LLM returned only reasoning content — disable thinking via extraBody '
        + '(chat_template_kwargs.enable_thinking: false) or raise the token limit', { status: res.status });
    }
    if (!data.choices?.length || !message?.content) {
      throw new LlmProviderError(`LLM returned empty response (choices: ${data.choices?.length ?? 0})`, { status: res.status });
    }
    return message.content;
  };
}
