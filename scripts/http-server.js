import { createServer } from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendDir = join(__dirname, '..', 'frontend');

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

import { runPipeline, validateLogicCore } from './bpmn/pipeline.js';
import { profileForMode, checkRuleProfile } from './bpmn/rules.js';
import { ProfileRejectedError, assertLayerNotWeakened } from './shared/rule-profile.js';
import { profileContext } from './shared/rule-catalog.js';
import { bpmnToLogicCore } from './bpmn/import.js';
import { orchestrate } from './orchestrator.js';
import { chatAgent } from './agents/chat.js';
import { createLlmProvider, LlmProviderError } from './agents/llm-provider.js';
import { deliver } from './delivery.js';
import { auditLog } from './audit.js';
import { validateLogicCoreSchema, boundSchemaErrors } from './bpmn/schema-gate.js';
import { checkUrlShape, resolveOutboundUrl, pinnedRequest, _setResolver } from './shared/outbound-url.js';
import { isMainModule } from './shared/entry-point.js';
import { quoteForMessage, boundText } from './shared/safe-text.js';

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.BPMN_API_KEY || null; // null = no auth (dev mode)
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
const RATE_LIMIT = { windowMs: 60_000, max: 30 };
const rateBuckets = new Map();
const startTime = Date.now();

export function startupCheck(env, logger = console.warn) {
  if (env.NODE_ENV === 'production' && !env.BPMN_API_KEY) {
    throw new Error(
      'Refusing to start in production without BPMN_API_KEY. ' +
      'Set BPMN_API_KEY=<secret> or unset NODE_ENV for dev mode.'
    );
  }
  if (!env.BPMN_API_KEY) {
    logger('⚠️  Starting with no API key — dev mode only. Set BPMN_API_KEY for production.');
  }
}

export function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        return reject(new Error(`Request body exceeds ${MAX_BODY_SIZE} bytes`));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/**
 * Synchronous part of the callback check (scheme, credentials, IP literals, `localhost` names);
 * returns an error message or null. Throws on a string that is not a URL. The single validator
 * lives in `shared/outbound-url.js`; `deliver` re-runs the full check and connects only to the
 * addresses it validated.
 */
export function validateCallbackUrl(url) {
  return checkUrlShape(url, 'callbackUrl').error || null;
}

/** Full callback check including DNS: every resolved address must be public. */
export async function validateCallbackUrlAsync(url) {
  const check = await resolveOutboundUrl(url, { label: 'callbackUrl' });
  return check.ok ? null : check.error;
}

/** Test hook: stub DNS resolution for every outbound URL check. `null` restores the default. */
export function _setDnsLookup(fn) { _setResolver(fn); }

/**
 * Constant-time API key comparison: both sides are hashed to equal-length SHA-256 digests first,
 * so neither the content nor the length of the configured key leaks through response timing.
 */
export function apiKeyMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !given) return false;
  const digest = (v) => crypto.createHash('sha256').update(v, 'utf8').digest();
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

function checkAuth(req, res) {
  if (!API_KEY) return true;
  if (!apiKeyMatches(req.headers['x-api-key'], API_KEY)) {
    json(res, 401, { error: 'Invalid API key' });
    return false;
  }
  return true;
}

let lastSweep = 0;

// Test hook: forget every rate-limit bucket (the suite sends more than one window's worth).
export function _resetRateLimit() { rateBuckets.clear(); lastSweep = 0; }
/** Test hook: how many rate-limit buckets are held. */
export function _rateBucketCount() { return rateBuckets.size; }

/**
 * The rate-limit key of a request: the socket's peer address. Behind reverse proxies the operator
 * sets `TRUST_PROXY_HOPS` to the number of proxies in front of the server; the key is then the
 * address the outermost trusted proxy recorded in `X-Forwarded-For` — counted from the right, so
 * entries a client prepends itself are never used. Only safe when the server is reachable
 * exclusively through those proxies: a client connecting directly controls the whole header.
 */
export function rateLimitKey(req, env = process.env) {
  const peer = req.socket?.remoteAddress || 'unknown';
  const hops = Number.parseInt(env.TRUST_PROXY_HOPS, 10);
  if (!Number.isInteger(hops) || hops < 1) return peer;
  const header = req.headers?.['x-forwarded-for'];
  if (typeof header !== 'string' || !header.trim()) return peer;
  const chain = header.split(',').map((h) => h.trim()).filter(Boolean);
  // Fewer entries than trusted proxies: the request did not pass through all of them, so no
  // entry in the chain is trustworthy.
  if (chain.length < hops) return peer;
  return chain[chain.length - hops];
}

/**
 * Counts one request for `key` at `now`; false once the window's budget is spent. Expired buckets
 * are swept at most once per window, so the table holds only the sources of the current window.
 */
export function rateLimitAllows(key, now = Date.now()) {
  if (now - lastSweep > RATE_LIMIT.windowMs) {
    for (const [k, b] of rateBuckets) if (now - b.start > RATE_LIMIT.windowMs) rateBuckets.delete(k);
    lastSweep = now;
  }
  const bucket = rateBuckets.get(key) || { count: 0, start: now };
  if (now - bucket.start > RATE_LIMIT.windowMs) {
    bucket.count = 0; bucket.start = now;
  }
  bucket.count++;
  rateBuckets.set(key, bucket);
  return bucket.count <= RATE_LIMIT.max;
}

function checkRateLimit(req, res) {
  if (!rateLimitAllows(rateLimitKey(req))) {
    json(res, 429, { error: 'Rate limit exceeded' });
    return false;
  }
  return true;
}

const CORRELATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CORRELATION_ID_ERROR = 'correlationId must be 1-64 characters from A-Z, a-z, 0-9, "_" and "-"';

/** A client correlation id is accepted only as a short identifier. */
export function isValidCorrelationId(value) {
  return typeof value === 'string' && CORRELATION_ID.test(value);
}

const BPMN_PROFILE_CONTEXT = profileContext('BPMN');
const AUDIT_MESSAGE_MAX = 500;

/**
 * The rule profile a client sent, or null. Over HTTP a profile is an inline object only — a string
 * would name a file on the server, so it is refused rather than read — and it passes the profile
 * schema gate before anything else sees it. It may raise a soundness rule but not switch the layer
 * off or set a rule below its default severity, so a remote client can never demote a soundness
 * error into a "success". (MCP, a trusted local channel, has no such restriction.)
 * Throws ProfileRejectedError (→ 400 profile_error).
 */
export function clientRuleProfile(body) {
  const profile = body.ruleProfile;
  if (profile === undefined || profile === null) return null;
  if (typeof profile !== 'object' || Array.isArray(profile)) {
    throw new ProfileRejectedError('ruleProfile must be an inline JSON object; profile names and file paths are not accepted over HTTP');
  }
  checkRuleProfile(profile);
  assertLayerNotWeakened(profile, 'soundness', BPMN_PROFILE_CONTEXT);
  return profile;
}

const AUDIT_ID_MAX = 128;
const TELEMETRY_DETAILS_MAX = 8 * 1024;
const TELEMETRY_DEPTH_MAX = 6;

/** A client message on its way into the audit log or a response: bounded, controls escaped. */
function truncateForAudit(message) {
  return boundText(message, AUDIT_MESSAGE_MAX);
}

/** A client identifier-like field (clientId, telemetry event, diagramId): a bounded string. */
function boundField(value) {
  if (typeof value === 'string') return boundText(value, AUDIT_ID_MAX);
  // Not a structure in the log: a non-string is logged as its (bounded) JSON text.
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  return boundText(text ?? String(value), AUDIT_ID_MAX);
}

/** Telemetry `details`, every key and string bounded and escaped, nesting cut at a fixed depth. */
function sanitizeDetails(value, depth = 0) {
  if (typeof value === 'string') return boundText(value, AUDIT_MESSAGE_MAX);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= TELEMETRY_DEPTH_MAX) return '[nested too deep]';
  if (Array.isArray(value)) return value.map((v) => sanitizeDetails(v, depth + 1));
  return Object.fromEntries(Object.entries(value)
    .map(([k, v]) => [boundText(k, AUDIT_ID_MAX), sanitizeDetails(v, depth + 1)]));
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Resolves an LLM config from environment variables, or null if no key is set.
// Reads process.env on every call so key/model changes are picked up at request time.
export function resolveEnvLlmConfig() {
  if (!process.env.OPENAI_API_KEY) return null;
  return {
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  };
}

const DEFAULT_LLM_BASE_URL = 'https://api.openai.com/v1';
const LLM_TIMEOUT_DEFAULT = 120_000;
const LLM_TIMEOUT_MAX = 300_000;

/** The origins an operator lets clients name as `llmConfig.baseUrl` (comma-separated env var). */
function llmBaseUrlAllowlist(env) {
  return String(env.LLM_BASE_URL_ALLOWLIST || '').split(',').map((entry) => entry.trim()).filter(Boolean)
    .flatMap((entry) => { try { return [new URL(entry).origin]; } catch { return []; } });
}

/**
 * Turns a client's `llmConfig` into provider options, or `{ error }` (→ 400).
 *
 * Without `baseUrl` the client's key and model go to the operator's endpoint
 * (`OPENAI_BASE_URL`, else the OpenAI default). A client `baseUrl` is an outbound request to a
 * client-chosen host, so it is refused unless its origin is on the operator's
 * `LLM_BASE_URL_ALLOWLIST` (empty by default = never), and even then it must pass the same
 * outbound-URL check as a callback; the request is then made over the pinned transport, which
 * connects only to the checked addresses and follows no redirect.
 */
export async function resolveClientLlmConfig(llmConfig, env = process.env) {
  if (typeof llmConfig !== 'object' || llmConfig === null || Array.isArray(llmConfig)) {
    return { error: 'llmConfig must be an object with apiKey and model' };
  }
  const { baseUrl, apiKey, model, timeout } = llmConfig;
  if (typeof apiKey !== 'string' || !apiKey || typeof model !== 'string' || !model) {
    return { error: 'llmConfig requires apiKey and model' };
  }
  const safeTimeout = typeof timeout === 'number' && timeout > 0 && timeout <= LLM_TIMEOUT_MAX ? timeout : LLM_TIMEOUT_DEFAULT;
  if (baseUrl === undefined || baseUrl === null || baseUrl === '') {
    return { config: { baseUrl: env.OPENAI_BASE_URL || DEFAULT_LLM_BASE_URL, apiKey, model, timeout: safeTimeout } };
  }
  let origin;
  try { origin = new URL(String(baseUrl)).origin; } catch { return { error: 'llmConfig.baseUrl is not a valid URL' }; }
  if (!llmBaseUrlAllowlist(env).includes(origin)) {
    return { error: 'llmConfig.baseUrl is not accepted from a client unless the server allowlists its origin; omit it to use the server-configured endpoint' };
  }
  const check = await resolveOutboundUrl(String(baseUrl), { label: 'llmConfig.baseUrl' });
  if (!check.ok) return { error: check.error };
  const request = (url, opts) => pinnedRequest(url, { ...opts, label: 'llmConfig.baseUrl' });
  return { config: { baseUrl: String(baseUrl), apiKey, model, timeout: safeTimeout, request } };
}

/** The LlmProviderError behind an error, following `cause` (the orchestrator wraps agent errors). */
function llmFailureOf(err) {
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (e instanceof LlmProviderError) return e;
  }
  return null;
}

const server = createServer(async (req, res) => {
  const { method, url } = req;

  // Health
  if (method === 'GET' && url === '/health') {
    return json(res, 200, {
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      version: '2.0.0',
    });
  }

  // Config (frontend bootstrap — reveals whether a server-side LLM key exists)
  if (method === 'GET' && url === '/api/v1/config') {
    const envCfg = resolveEnvLlmConfig();
    // Read BPMN_API_KEY fresh here (not the module-load API_KEY const that
    // checkAuth uses): keeps the dev/prod model-gating decision at request
    // time so tests can simulate production against the booted server.
    const devMode = !process.env.BPMN_API_KEY;
    const payload = { envKeyConfigured: Boolean(envCfg) };
    if (devMode) payload.model = envCfg ? envCfg.model : null;
    return json(res, 200, payload);
  }

  // Frontend static files
  if (method === 'GET' && (url === '/' || url === '/index.html')) {
    const body = readFileSync(join(frontendDir, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(body);
  }
  if (method === 'GET' && url.startsWith('/static/')) {
    const file = url.replace('/static/', '');
    const path = join(frontendDir, file);
    if (!path.startsWith(frontendDir)) return res.writeHead(403).end(); // path traversal guard
    try {
      const body = readFileSync(path);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      return res.end(body);
    } catch { return res.writeHead(404).end(); }
  }
  if (method === 'GET' && url.startsWith('/examples/')) {
    const file = url.replace('/examples/', '');
    const path = join(frontendDir, 'examples', file);
    if (!path.startsWith(join(frontendDir, 'examples'))) return res.writeHead(403).end();
    try {
      const body = readFileSync(path);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      return res.end(body);
    } catch { return res.writeHead(404).end(); }
  }

  // Auth + rate limiting (skip for health check)
  if (!checkAuth(req, res)) return;
  if (!checkRateLimit(req, res)) return;

  // Only POST for API endpoints
  if (method !== 'POST') return json(res, 405, { error: 'Method Not Allowed' });

  let body;
  try { body = await parseBody(req); }
  catch { return json(res, 400, { error: 'Invalid JSON body' }); }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json(res, 400, { error: 'Request body must be a JSON object' });
  }

  // The correlation id is echoed, logged and was once part of a file name: accept it only as a
  // short identifier, never as a path or an arbitrary value.
  if (body.correlationId !== undefined && body.correlationId !== null && !isValidCorrelationId(body.correlationId)) {
    return json(res, 400, { error: CORRELATION_ID_ERROR });
  }
  const correlationId = body.correlationId || crypto.randomUUID();
  const clientId = body.clientId === undefined || body.clientId === null || body.clientId === ''
    ? 'anonymous' : boundField(body.clientId);
  const t0 = Date.now();

  try {
    // Generate
    if (url === '/api/v1/generate') {
      auditLog({ event: 'request', correlationId, clientId, endpoint: '/generate' });
      const schemaCheck = validateLogicCoreSchema(body.logicCore);
      if (!schemaCheck.valid) {
        auditLog({ event: 'schema_rejected', correlationId, clientId, endpoint: '/generate', errorCount: schemaCheck.errors.length });
        return json(res, 400, { correlationId, status: 'schema_error', errors: boundSchemaErrors(schemaCheck.errors) });
      }
      const mode = (body.mode === 'optimize' || body.mode === 'soll') ? 'optimize' : 'document';
      const poolOrder = body.poolOrder === 'declared' ? 'declared' : 'auto';
      const ruleProfile = clientRuleProfile(body);
      const result = await runPipeline(body.logicCore, { mode, poolOrder, ruleProfile });
      const durationMs = Date.now() - t0;
      const hasErrors = result.validation.errors.length > 0;
      // A green validation says nothing about the layout — the rule engine never
      // sees a coordinate. A caller that only reads `validation` would ship a
      // structurally broken diagram as a success.
      const diBroken = result.diagnostics ? !result.diagnostics.ok : false;
      auditLog({ event: 'completed', correlationId, durationMs, hasErrors, diBroken });

      const payload = {
        correlationId,
        status: hasErrors ? 'validation_error' : (diBroken ? 'diagram_error' : 'success'),
        bpmnXml: result.bpmnXml,
        svg: result.svg,
        validation: result.validation,
        diagnostics: result.diagnostics,
      };

      let callbackStatus = 'not_requested';
      if (body.callbackUrl) {
        let urlError;
        try {
          urlError = await validateCallbackUrlAsync(body.callbackUrl);
        } catch {
          return json(res, 400, { error: 'callbackUrl is not a valid URL' });
        }
        if (urlError) return json(res, 400, { error: urlError });
        deliver(body.callbackUrl, payload).catch(err => {
          auditLog({ event: 'delivery_failed', correlationId, error: truncateForAudit(err.message) });
        });
        callbackStatus = 'pending';
      }

      return json(res, 200, { ...payload, callbackStatus });
    }

    // Validate
    if (url === '/api/v1/validate') {
      auditLog({ event: 'request', correlationId, clientId, endpoint: '/validate' });
      const schemaCheck = validateLogicCoreSchema(body.logicCore);
      if (!schemaCheck.valid) {
        auditLog({ event: 'schema_rejected', correlationId, clientId, endpoint: '/validate', errorCount: schemaCheck.errors.length });
        return json(res, 400, { correlationId, status: 'schema_error', errors: boundSchemaErrors(schemaCheck.errors) });
      }
      const mode = (body.mode === 'optimize' || body.mode === 'soll') ? 'optimize' : 'document';
      const ruleProfile = clientRuleProfile(body);
      const validation = validateLogicCore(body.logicCore, profileForMode(ruleProfile, mode));
      const durationMs = Date.now() - t0;
      auditLog({ event: 'completed', correlationId, durationMs, hasErrors: validation.errors.length > 0 });
      return json(res, 200, { correlationId, status: 'success', validation });
    }

    // Import
    if (url === '/api/v1/import') {
      auditLog({ event: 'request', correlationId, clientId, endpoint: '/import' });
      const logicCore = await bpmnToLogicCore(body.bpmnXml);
      const durationMs = Date.now() - t0;
      auditLog({ event: 'completed', correlationId, durationMs });
      return json(res, 200, { correlationId, status: 'success', logicCore });
    }

    // Orchestrate
    if (url === '/api/v1/orchestrate') {
      auditLog({ event: 'request', correlationId, clientId, endpoint: '/orchestrate' });

      const options = {
        ruleProfile: clientRuleProfile(body),
        mode: (body.mode === 'optimize' || body.mode === 'soll') ? 'optimize' : 'document',
      };

      // Optional LLM provider for text→BPMN or review-fix loops
      let envLlmConfig = null;
      if (!body.llmConfig) {
        envLlmConfig = resolveEnvLlmConfig();
        if (envLlmConfig) body.llmConfig = envLlmConfig;
      }

      if (body.llmConfig) {
        // The server's own env config is operator-trusted; a client's goes through the check.
        const resolved = body.llmConfig === envLlmConfig ? { config: envLlmConfig } : await resolveClientLlmConfig(body.llmConfig);
        if (resolved.error) return json(res, 400, { error: resolved.error });
        options.llmProvider = createLlmProvider(resolved.config);
      }

      const input = body.userText || body.logicCore;
      if (!input) {
        return json(res, 400, { error: 'Provide userText (string) or logicCore (object)' });
      }

      if (body.logicCore) {
        const schemaCheck = validateLogicCoreSchema(body.logicCore);
        if (!schemaCheck.valid) {
          auditLog({ event: 'schema_rejected', correlationId, clientId, endpoint: '/orchestrate', errorCount: schemaCheck.errors.length });
          return json(res, 400, { correlationId, status: 'schema_error', errors: boundSchemaErrors(schemaCheck.errors) });
        }
      }

      const result = await orchestrate(input, options);
      const durationMs = Date.now() - t0;
      auditLog({ event: 'completed', correlationId, durationMs, isCompliant: result.compliance?.isCompliant });

      return json(res, 200, {
        correlationId,
        status: 'success',
        logicCore: result.logicCore,
        bpmnXml: result.bpmnXml,
        svg: result.svg,
        validation: result.validation,
        diagnostics: result.diagnostics,
        compliance: result.compliance,
        history: result.history,
        iterations: result.iterations,
      });
    }

    // Chat (discovery conversation, pre-generation)
    if (url === '/api/v1/chat') {
      auditLog({ event: 'request', correlationId, clientId, endpoint: '/chat' });

      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return json(res, 400, { error: 'messages must be a non-empty array' });
      }

      let envLlmConfig = null;
      if (!body.llmConfig) {
        envLlmConfig = resolveEnvLlmConfig();
        if (envLlmConfig) body.llmConfig = envLlmConfig;
      }
      if (!body.llmConfig) {
        return json(res, 400, { error: 'llmConfig is required (or set OPENAI_API_KEY on the server)' });
      }
      const resolved = body.llmConfig === envLlmConfig ? { config: envLlmConfig } : await resolveClientLlmConfig(body.llmConfig);
      if (resolved.error) return json(res, 400, { error: resolved.error });
      const llmProvider = createLlmProvider(resolved.config);

      const result = await chatAgent({ messages: body.messages, llmProvider });
      const durationMs = Date.now() - t0;
      auditLog({ event: 'completed', correlationId, durationMs, readyToGenerate: result.readyToGenerate });

      return json(res, 200, { ...result, correlationId });
    }

    // Telemetry
    if (url === '/api/v1/telemetry') {
      let detailsText;
      try { detailsText = JSON.stringify(body.details ?? null); } catch { detailsText = null; }
      if (detailsText === null || detailsText.length > TELEMETRY_DETAILS_MAX) {
        return json(res, 400, { error: `details must be JSON of at most ${TELEMETRY_DETAILS_MAX} bytes` });
      }
      auditLog({
        ts: new Date().toISOString(),
        event: 'frontend_event',
        frontendEvent: body.event === undefined ? undefined : boundField(body.event),
        diagramId: body.diagramId === undefined ? undefined : boundField(body.diagramId),
        correlationId: body.correlationId,
        details: sanitizeDetails(body.details),
      });
      return json(res, 200, { status: 'ok' });
    }

    return json(res, 404, { error: 'Not Found' });
  } catch (err) {
    // A refused rule profile is the caller's input, not a server fault.
    if (err instanceof ProfileRejectedError) {
      auditLog({ event: 'profile_rejected', correlationId, error: truncateForAudit(err.message) });
      return json(res, 400, { correlationId, status: 'profile_error', error: err.message });
    }
    // An LLM endpoint's answer can carry anything: log the detail here, return only the class.
    const llmFailure = llmFailureOf(err);
    if (llmFailure) {
      console.error(`LLM provider failure (correlationId ${correlationId}): ${quoteForMessage(llmFailure.message)} ${quoteForMessage(llmFailure.detail, AUDIT_MESSAGE_MAX)}`);
      auditLog({ event: 'llm_error', correlationId, upstreamStatus: llmFailure.status });
      return json(res, 502, { correlationId, status: 'llm_error', error: 'LLM provider request failed' });
    }
    const message = truncateForAudit(err.message);
    auditLog({ event: 'error', correlationId, error: message });
    return json(res, 500, { correlationId, status: 'internal_error', error: message });
  }
});

// Only listen when this module is the entry point. When imported by tests
// (or other modules) it stays inert — prevents EADDRINUSE under Jest workers.
const isEntryPoint = isMainModule(import.meta.url, process.argv[1]);
if (isEntryPoint) {
  startupCheck(process.env);
  server.listen(PORT, () => {
    console.log(`BPMN Generator HTTP API listening on port ${PORT}`);
    console.log(`  POST /api/v1/generate   — Logic-Core → BPMN + SVG`);
    console.log(`  POST /api/v1/validate   — Logic-Core → Validation`);
    console.log(`  POST /api/v1/import     — BPMN XML → Logic-Core`);
    console.log(`  POST /api/v1/orchestrate — Multi-agent review + generate + compliance`);
    console.log(`  POST /api/v1/chat       — Discovery conversation (pre-generation)`);
    console.log(`  GET  /health            — Health check`);
    console.log(`  GET  /api/v1/config     — Frontend bootstrap (env-key status)`);
  });
}

export { server };
