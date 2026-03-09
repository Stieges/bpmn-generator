import { createServer } from 'node:http';
import crypto from 'node:crypto';
import { runPipeline, validateLogicCore } from './pipeline.js';
import { bpmnToLogicCore } from './import.js';
import { orchestrate } from './orchestrator.js';
import { createLlmProvider } from './agents/llm-provider.js';
import { deliver } from './delivery.js';
import { auditLog } from './audit.js';

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.BPMN_API_KEY || null; // null = no auth (dev mode)
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
const RATE_LIMIT = { windowMs: 60_000, max: 30 };
const rateBuckets = new Map();
const startTime = Date.now();

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
  const host = u.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
      host.startsWith('10.') || host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return 'callbackUrl must not target internal networks';
  }
  return null; // valid
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
        try {
          const urlError = validateCallbackUrl(body.callbackUrl);
          if (urlError) return json(res, 400, { error: urlError });
        } catch {
          return json(res, 400, { error: 'callbackUrl is not a valid URL' });
        }
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

    return json(res, 404, { error: 'Not Found' });
  } catch (err) {
    auditLog({ event: 'error', correlationId, error: err.message });
    return json(res, 500, { correlationId, status: 'internal_error', error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`BPMN Generator HTTP API listening on port ${PORT}`);
  console.log(`  POST /api/v1/generate   — Logic-Core → BPMN + SVG`);
  console.log(`  POST /api/v1/validate   — Logic-Core → Validation`);
  console.log(`  POST /api/v1/import     — BPMN XML → Logic-Core`);
  console.log(`  POST /api/v1/orchestrate — Multi-agent review + generate + compliance`);
  console.log(`  GET  /health            — Health check`);
});
