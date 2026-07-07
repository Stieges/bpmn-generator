import { createServer } from 'node:http';
import crypto from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendDir = join(__dirname, '..', 'frontend');

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

import { runPipeline, validateLogicCore } from './pipeline.js';
import { bpmnToLogicCore } from './import.js';
import { orchestrate } from './orchestrator.js';
import { chatAgent } from './agents/chat.js';
import { createLlmProvider } from './agents/llm-provider.js';
import { deliver } from './delivery.js';
import { auditLog } from './audit.js';
import { validateLogicCoreSchema } from './schema-gate.js';

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

export function validateCallbackUrl(url) {
  const u = new URL(url); // throws on invalid URL
  if (!['http:', 'https:'].includes(u.protocol)) {
    return 'callbackUrl must use http or https';
  }
  if (isInternalHost(u.hostname)) {
    return 'callbackUrl must not target internal networks';
  }
  return null; // valid
}

export function isInternalHost(host) {
  // IPv4
  if (host === 'localhost' || host === '127.0.0.1') return true;
  if (host.startsWith('10.') || host.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true; // link-local + AWS metadata
  // IPv6
  if (host === '::1') return true;
  // Strip brackets if URL passed them through (e.g., [fc00::1] → fc00::1)
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1') return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true;  // fc00::/7 (ULA)
  if (/^fe[89ab][0-9a-f]?:/.test(h)) return true;   // fe80::/10 (link-local)
  return false;
}

// Swappable DNS lookup (overridable in tests via _setDnsLookup).
let _lookup = dnsLookup;
export function _setDnsLookup(fn) { _lookup = fn || dnsLookup; }

export async function validateCallbackUrlAsync(url) {
  const sync = validateCallbackUrl(url);
  if (sync) return sync;
  const { hostname } = new URL(url);
  // Strip brackets for IPv6 hostnames
  const h = hostname.replace(/^\[|\]$/g, '');
  // If hostname is already an IP, the sync check already covered it.
  if (/^[\d.]+$/.test(h) || /:/.test(h)) return null;
  try {
    const addrs = await _lookup(hostname, { all: true });
    for (const { address } of addrs) {
      if (isInternalHost(address)) {
        return 'callbackUrl resolves to internal network';
      }
    }
  } catch (err) {
    return `callbackUrl DNS lookup failed: ${err.code || err.message}`;
  }
  return null;
}

function checkAuth(req, res) {
  if (!API_KEY) return true;
  if (req.headers['x-api-key'] !== API_KEY) {
    json(res, 401, { error: 'Invalid API key' });
    return false;
  }
  return true;
}

function checkRateLimit(req, res) {
  const ip = req.socket.remoteAddress;
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || { count: 0, start: now };
  if (now - bucket.start > RATE_LIMIT.windowMs) {
    bucket.count = 0; bucket.start = now;
  }
  bucket.count++;
  rateBuckets.set(ip, bucket);
  if (bucket.count > RATE_LIMIT.max) {
    json(res, 429, { error: 'Rate limit exceeded' });
    return false;
  }
  return true;
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

  const correlationId = body.correlationId || crypto.randomUUID();
  const clientId = body.clientId || 'anonymous';
  const t0 = Date.now();

  try {
    // Generate
    if (url === '/api/v1/generate') {
      auditLog({ event: 'request', correlationId, clientId, endpoint: '/generate' });
      const schemaCheck = validateLogicCoreSchema(body.logicCore);
      if (!schemaCheck.valid) {
        auditLog({ event: 'schema_rejected', correlationId, clientId, endpoint: '/generate', errorCount: schemaCheck.errors.length });
        return json(res, 400, { correlationId, status: 'schema_error', errors: schemaCheck.errors });
      }
      const result = await runPipeline(body.logicCore);
      const durationMs = Date.now() - t0;
      const hasErrors = result.validation.errors.length > 0;
      auditLog({ event: 'completed', correlationId, durationMs, hasErrors });

      const payload = {
        correlationId,
        status: hasErrors ? 'validation_error' : 'success',
        bpmnXml: result.bpmnXml,
        svg: result.svg,
        validation: result.validation,
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
          auditLog({ event: 'delivery_failed', correlationId, error: err.message });
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
        return json(res, 400, { correlationId, status: 'schema_error', errors: schemaCheck.errors });
      }
      const validation = validateLogicCore(body.logicCore);
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

      const options = { ruleProfile: body.ruleProfile || null };

      // Optional LLM provider for text→BPMN or review-fix loops
      if (!body.llmConfig) {
        const envCfg = resolveEnvLlmConfig();
        if (envCfg) body.llmConfig = envCfg;
      }

      if (body.llmConfig) {
        const { baseUrl, apiKey, model, timeout } = body.llmConfig;
        if (!baseUrl || !apiKey || !model) {
          return json(res, 400, { error: 'llmConfig requires baseUrl, apiKey, model' });
        }
        const safeTimeout = typeof timeout === 'number' && timeout > 0 && timeout <= 300_000
          ? timeout : 120_000;
        options.llmProvider = createLlmProvider({ baseUrl, apiKey, model, timeout: safeTimeout });
      }

      const input = body.userText || body.logicCore;
      if (!input) {
        return json(res, 400, { error: 'Provide userText (string) or logicCore (object)' });
      }

      if (body.logicCore) {
        const schemaCheck = validateLogicCoreSchema(body.logicCore);
        if (!schemaCheck.valid) {
          auditLog({ event: 'schema_rejected', correlationId, clientId, endpoint: '/orchestrate', errorCount: schemaCheck.errors.length });
          return json(res, 400, { correlationId, status: 'schema_error', errors: schemaCheck.errors });
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

      if (!body.llmConfig) {
        const envCfg = resolveEnvLlmConfig();
        if (envCfg) body.llmConfig = envCfg;
      }
      if (!body.llmConfig) {
        return json(res, 400, { error: 'llmConfig is required (or set OPENAI_API_KEY on the server)' });
      }
      const { baseUrl, apiKey, model, timeout } = body.llmConfig;
      if (!baseUrl || !apiKey || !model) {
        return json(res, 400, { error: 'llmConfig requires baseUrl, apiKey, model' });
      }
      const safeTimeout = typeof timeout === 'number' && timeout > 0 && timeout <= 300_000
        ? timeout : 120_000;
      const llmProvider = createLlmProvider({ baseUrl, apiKey, model, timeout: safeTimeout });

      const result = await chatAgent({ messages: body.messages, llmProvider });
      const durationMs = Date.now() - t0;
      auditLog({ event: 'completed', correlationId, durationMs, readyToGenerate: result.readyToGenerate });

      return json(res, 200, { ...result, correlationId });
    }

    // Telemetry
    if (url === '/api/v1/telemetry') {
      try {
        auditLog({
          ts: new Date().toISOString(),
          event: 'frontend_event',
          frontendEvent: body.event,
          diagramId: body.diagramId,
          correlationId: body.correlationId,
          details: body.details,
        });
        return json(res, 200, { status: 'ok' });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    return json(res, 404, { error: 'Not Found' });
  } catch (err) {
    auditLog({ event: 'error', correlationId, error: err.message });
    return json(res, 500, { correlationId, status: 'internal_error', error: err.message });
  }
});

// Only listen when this module is the entry point. When imported by tests
// (or other modules) it stays inert — prevents EADDRINUSE under Jest workers.
const isEntryPoint = import.meta.url === `file://${process.argv[1]}`;
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
