# Config Endpoint + API Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `GET /api/v1/config` endpoint that tells the frontend whether a server-side LLM key is configured (and, in dev mode, which model), and write a single-source API reference documenting all 8 HTTP endpoints.

**Architecture:** Extract the env-LLM-config fallback (currently copy-pasted in `/orchestrate` and `/chat`) into one `resolveEnvLlmConfig()` helper, then build `/config` on top of it. The endpoint sits in the pre-auth GET block next to `/health` and gates the `model` field to dev mode (no `BPMN_API_KEY`) so production leaks only a harmless boolean. Documentation goes into a new `references/api-reference.md`, with the README table extended and linked.

**Tech Stack:** Node.js (ES Modules, `node:http`), Jest (`--experimental-vm-modules`). No new dependencies.

## Global Constraints

- ES Modules only (`import`/`export`) — the project is `"type": "module"`. No `require()`.
- No new runtime dependencies.
- Run tests from `scripts/` with `npm test` (Jest, `--experimental-vm-modules`). All tests must pass after every task.
- Never stage with `git add .` / `git add -A` — always stage specific paths.
- Constants that already live in `config.json` stay there; this plan introduces no hard-coded constants that belong in config.
- Spec: `docs/superpowers/specs/2026-07-07-config-endpoint-and-api-reference-design.md`.

---

### Task 1: Extract `resolveEnvLlmConfig()` helper

Pure refactor. The env-fallback object is copy-pasted at `scripts/http-server.js:272-276` (`/orchestrate`) and `scripts/http-server.js:328-332` (`/chat`). Extract it into one module-level helper so the `gpt-4o-mini` default has a single source of truth. Behavior must not change — the existing `/orchestrate` and `/chat` env-fallback tests must stay green with no assertion edits.

**Files:**
- Modify: `scripts/http-server.js` (add helper near the other module-level helpers around lines 40-135; update the two call sites at `:271-277` and `:327-333`)
- Test: `scripts/http-server.test.js` (add one focused unit test for the helper)

**Interfaces:**
- Produces: `export function resolveEnvLlmConfig()` → returns `{ baseUrl: string, apiKey: string, model: string }` when `process.env.OPENAI_API_KEY` is set, else `null`. Reads `process.env` on every call (not cached). `baseUrl` defaults to `'https://api.openai.com/v1'` (`OPENAI_BASE_URL` override), `model` defaults to `'gpt-4o-mini'` (`OPENAI_MODEL` override).

- [ ] **Step 1: Write the failing test**

Add to `scripts/http-server.test.js`, after the existing `import { server } from './http-server.js';` line change it to also import the helper:

```js
import { server, resolveEnvLlmConfig } from './http-server.js';
```

Then add this describe block at the end of the file:

```js
describe('resolveEnvLlmConfig', () => {
  test('returns null when OPENAI_API_KEY is unset', () => {
    expect(resolveEnvLlmConfig()).toBeNull();
  });

  test('returns defaults when only OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(resolveEnvLlmConfig()).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    });
  });

  test('honors OPENAI_BASE_URL and OPENAI_MODEL overrides', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_BASE_URL = 'http://localhost:1234/v1';
    process.env.OPENAI_MODEL = 'qwen2.5';
    expect(resolveEnvLlmConfig()).toEqual({
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'sk-test',
      model: 'qwen2.5',
    });
  });
});
```

The existing `afterEach` deletes `OPENAI_API_KEY` but not the two new vars. Update the `afterEach` (currently near the top of the file) to also clear them:

```js
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts && npm test -- --testPathPatterns=http-server`
Expected: FAIL — `resolveEnvLlmConfig is not a function` (import resolves to `undefined`).

- [ ] **Step 3: Implement the helper**

In `scripts/http-server.js`, add after the `json()` helper (around line 145, before `const server = createServer`):

```js
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
```

- [ ] **Step 4: Update the two call sites to use the helper**

Replace `scripts/http-server.js:271-277` (the `/orchestrate` fallback):

```js
      // Optional LLM provider for text→BPMN or review-fix loops
      if (!body.llmConfig) {
        const envCfg = resolveEnvLlmConfig();
        if (envCfg) body.llmConfig = envCfg;
      }
```

Replace `scripts/http-server.js:327-333` (the `/chat` fallback):

```js
      if (!body.llmConfig) {
        const envCfg = resolveEnvLlmConfig();
        if (envCfg) body.llmConfig = envCfg;
      }
```

- [ ] **Step 5: Run the full test suite to verify no behavior changed**

Run: `cd scripts && npm test`
Expected: PASS — all tests green (322 + 3 new = 325 passing, 1 skipped). The existing `/orchestrate` and `/chat` env-fallback tests must pass unchanged.

- [ ] **Step 6: Commit**

```bash
cd /Users/daniel.stiegler/Projects/bpmn-generator
git add scripts/http-server.js scripts/http-server.test.js
git commit -m "refactor(http): extract resolveEnvLlmConfig() helper to dedupe env fallback

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Add `GET /api/v1/config` endpoint

Add the endpoint in the pre-auth GET block next to `/health`. It returns `{ envKeyConfigured: boolean }` always, plus `model` only in dev mode (no `BPMN_API_KEY`). Reads `process.env.BPMN_API_KEY` fresh at request time (not the module-load `API_KEY` const) so tests can simulate production against the booted server.

**Files:**
- Modify: `scripts/http-server.js` (add route in the GET block after the `/health` handler at `:150-157`; add a startup-log line near `:352`)
- Test: `scripts/http-server.test.js` (add a `describe('GET /api/v1/config')` block)

**Interfaces:**
- Consumes: `resolveEnvLlmConfig()` from Task 1.
- Produces: HTTP route `GET /api/v1/config` → `200 { envKeyConfigured: boolean, model?: string|null }`. `model` present only when `process.env.BPMN_API_KEY` is falsy (dev mode).

- [ ] **Step 1: Write the failing tests**

Add to `scripts/http-server.test.js`. First extend the `afterEach` (from Task 1) to also clear `BPMN_API_KEY`:

```js
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL;
  delete process.env.BPMN_API_KEY;
});
```

Then add this describe block:

```js
describe('GET /api/v1/config', () => {
  test('dev mode, no env key → envKeyConfigured false, model null', async () => {
    const res = await realFetch(`${baseUrl}/api/v1/config`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ envKeyConfigured: false, model: null });
  });

  test('dev mode, OPENAI_API_KEY set, no OPENAI_MODEL → default model', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const res = await realFetch(`${baseUrl}/api/v1/config`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ envKeyConfigured: true, model: 'gpt-4o-mini' });
  });

  test('dev mode, explicit OPENAI_MODEL → echoes it', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_MODEL = 'qwen2.5';
    const res = await realFetch(`${baseUrl}/api/v1/config`);
    const data = await res.json();
    expect(data).toEqual({ envKeyConfigured: true, model: 'qwen2.5' });
  });

  test('production (BPMN_API_KEY set) → model omitted, only boolean', async () => {
    process.env.BPMN_API_KEY = 'server-secret';
    process.env.OPENAI_API_KEY = 'sk-test';
    const res = await realFetch(`${baseUrl}/api/v1/config`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ envKeyConfigured: true });
    expect(data).not.toHaveProperty('model');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts && npm test -- --testPathPatterns=http-server`
Expected: FAIL — the `/config` requests hit the `404 { error: 'Not Found' }` fallthrough (route not registered), so `res.status` is 404 not 200, and the JSON body doesn't match.

- [ ] **Step 3: Implement the route**

In `scripts/http-server.js`, add immediately after the `/health` handler (after line 157, before the `// Frontend static files` comment):

```js
  // Config (frontend bootstrap — reveals whether a server-side LLM key exists)
  if (method === 'GET' && url === '/api/v1/config') {
    const envCfg = resolveEnvLlmConfig();
    const devMode = !process.env.BPMN_API_KEY;
    const payload = { envKeyConfigured: Boolean(envCfg) };
    if (devMode) payload.model = envCfg ? envCfg.model : null;
    return json(res, 200, payload);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts && npm test -- --testPathPatterns=http-server`
Expected: PASS — all 4 new `/config` tests green.

- [ ] **Step 5: Add the startup-log line**

In `scripts/http-server.js`, in the `server.listen` callback, after the `/chat` log line (around line 352), add:

```js
    console.log(`  GET  /api/v1/config     — Frontend bootstrap (env-key status)`);
```

- [ ] **Step 6: Run the full suite + manual smoke test**

Run: `cd scripts && npm test`
Expected: PASS (329 passing, 1 skipped).

Then smoke-test the live server in both modes:

```bash
cd scripts && node http-server.js &
sleep 1
curl -s http://localhost:3000/api/v1/config; echo   # dev, no key
kill %1
OPENAI_API_KEY=sk-test node http-server.js &
sleep 1
curl -s http://localhost:3000/api/v1/config; echo   # dev, key set
kill %1
BPMN_API_KEY=secret OPENAI_API_KEY=sk-test node http-server.js &
sleep 1
curl -s http://localhost:3000/api/v1/config; echo   # production
kill %1
```
Expected, in order:
`{"envKeyConfigured":false,"model":null}`
`{"envKeyConfigured":true,"model":"gpt-4o-mini"}`
`{"envKeyConfigured":true}`

- [ ] **Step 7: Commit**

```bash
cd /Users/daniel.stiegler/Projects/bpmn-generator
git add scripts/http-server.js scripts/http-server.test.js
git commit -m "feat(http): add GET /api/v1/config for frontend bootstrap

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Write `references/api-reference.md` and update README

Documentation task. Create the single-source API reference covering all 8 endpoints, then extend the README table with the 3 missing rows and a link. No code, no tests — but every curl example must be verified against a running server before commit.

**Files:**
- Create: `references/api-reference.md`
- Modify: `README.md:362-368` (the HTTP API table)

**Interfaces:** None (docs only). Content is derived from the actual handlers in `scripts/http-server.js` — verify each request/response/error shape against the source, not from memory.

- [ ] **Step 1: Create `references/api-reference.md`**

Write the file with this structure. Fill each endpoint section from the actual handler code in `scripts/http-server.js` (verify field names and error shapes against the source lines noted).

````markdown
# HTTP API Reference

Complete reference for the BPMN Generator HTTP API. For a high-level overview see the README's "HTTP API" section.

## Conventions

- **Base URL:** `http://<host>:<PORT>` (default `PORT=3000`). Start with `PORT=3000 node scripts/http-server.js`.
- **Auth:** When `BPMN_API_KEY` is set on the server, all endpoints except `GET /health` and `GET /api/v1/config` require the header `X-API-Key: <key>`. In dev mode (no `BPMN_API_KEY`) no auth is required. Missing/wrong key → `401 { "error": "Invalid API key" }`.
- **Rate limit:** 30 requests/minute per IP (except `/health` and `/config`, which are checked before the limiter). Exceeding → `429 { "error": "Rate limit exceeded" }`.
- **Body size cap:** 10 MB. Larger → the request is destroyed and rejected `400 { "error": "Invalid JSON body" }`.
- **Content type:** POST endpoints expect `Content-Type: application/json`. Non-JSON body → `400 { "error": "Invalid JSON body" }`.
- **Correlation:** All POST endpoints accept optional `correlationId` (echoed back; generated if absent) and `clientId` (recorded in the audit log).
- **Method:** POST endpoints reject non-POST with `405 { "error": "Method Not Allowed" }`. Unknown paths → `404 { "error": "Not Found" }`.

---

## POST /api/v1/generate

Logic-Core JSON → BPMN 2.0 XML + SVG. Runs the full pipeline (no LLM).

**Request:**
```json
{
  "logicCore": { "nodes": [...], "edges": [...] },
  "clientId": "my-app",
  "correlationId": "uuid",
  "callbackUrl": "https://example.com/webhook"
}
```
- `logicCore` (required, object) — validated against `references/input-schema.json` via the ajv strict gate.
- `callbackUrl` (optional, string) — if present, the result is also POSTed there asynchronously; the URL is SSRF-validated (rejects internal/link-local hosts, DNS-resolves and re-checks).

**Response 200:**
```json
{
  "correlationId": "uuid",
  "status": "success",
  "bpmnXml": "<?xml ...",
  "svg": "<svg ...",
  "validation": { "errors": [], "warnings": [] },
  "callbackStatus": "not_requested"
}
```
`status` is `"validation_error"` when `validation.errors` is non-empty. `callbackStatus` is `"pending"` when a `callbackUrl` was accepted.

**Errors:**
- `400 { correlationId, status: "schema_error", errors: [...] }` — Logic-Core failed the schema gate.
- `400 { error: "callbackUrl ..." }` — invalid or internal callback URL.
- `500 { correlationId, status: "internal_error", error }` — pipeline threw.

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/generate \
  -H 'Content-Type: application/json' \
  -d '{"logicCore":{"nodes":[{"id":"s","type":"startEvent","name":"Start"},{"id":"e","type":"endEvent","name":"End"}],"edges":[{"id":"f1","source":"s","target":"e"}]}}'
```

---

## POST /api/v1/validate

Validate Logic-Core against the rule engine without generating output.

**Request:** `{ "logicCore": {...}, "correlationId": "uuid", "clientId": "my-app" }`

**Response 200:**
```json
{ "correlationId": "uuid", "status": "success", "validation": { "errors": [...], "warnings": [...] } }
```

**Errors:** `400 { correlationId, status: "schema_error", errors }` — schema gate rejected the input.

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/validate \
  -H 'Content-Type: application/json' \
  -d '{"logicCore":{"nodes":[{"id":"t","type":"task","name":"Do"}],"edges":[]}}'
```

---

## POST /api/v1/import

BPMN 2.0 XML → Logic-Core JSON (round-trip via the DOM parser).

**Request:** `{ "bpmnXml": "<?xml ...", "correlationId": "uuid", "clientId": "my-app" }`

**Response 200:** `{ "correlationId": "uuid", "status": "success", "logicCore": {...} }`

**Errors:** `500 { correlationId, status: "internal_error", error }` — parse failure.

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/import \
  -H 'Content-Type: application/json' \
  -d '{"bpmnXml":"<?xml version=\"1.0\"?>..."}'
```

---

## POST /api/v1/orchestrate

Multi-agent flow: (LLM extraction if `userText`) → reviewer → pipeline → compliance. Accepts either `userText` (needs an LLM) or a ready `logicCore`.

**Request:**
```json
{
  "userText": "Order processing with manager approval",
  "logicCore": { ... },
  "llmConfig": { "baseUrl": "https://api.openai.com/v1", "apiKey": "sk-...", "model": "gpt-4o-mini", "timeout": 120000 },
  "ruleProfile": "rules/strict-profile.json",
  "correlationId": "uuid",
  "clientId": "my-app"
}
```
- One of `userText` or `logicCore` is required.
- `llmConfig` is required when `userText` is given; if omitted, the server falls back to `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL` env vars when present.
- `timeout` optional, clamped to (0, 300000], default 120000.

**Response 200:**
```json
{
  "correlationId": "uuid",
  "status": "success",
  "logicCore": {...},
  "bpmnXml": "<?xml ...",
  "svg": "<svg ...",
  "validation": {...},
  "compliance": { "isCompliant": true, "errors": [], "warnings": [], "infos": [], "violations": [] },
  "history": [ { "agent": "modeler", "phase": "extract", ... } ],
  "iterations": 1
}
```

**Errors:**
- `400 { error: "Provide userText (string) or logicCore (object)" }` — neither given.
- `400 { error: "llmConfig requires baseUrl, apiKey, model" }` — incomplete `llmConfig`.
- `400 { correlationId, status: "schema_error", errors }` — provided `logicCore` failed the schema gate.
- `500 { correlationId, status: "internal_error", error }`.

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/orchestrate \
  -H 'Content-Type: application/json' \
  -d '{"userText":"Approval process","llmConfig":{"baseUrl":"https://api.openai.com/v1","apiKey":"sk-...","model":"gpt-4o-mini"}}'
```

---

## POST /api/v1/chat

Discovery conversation before generation. Multi-turn; the LLM decides when enough context is gathered and returns a `suggestedSummary` to feed into `/api/v1/orchestrate`.

**Request:**
```json
{
  "messages": [
    { "role": "user", "content": "I need an approval process" },
    { "role": "assistant", "content": "How many participants?" },
    { "role": "user", "content": "Two: customer and clerk" }
  ],
  "correlationId": "uuid",
  "llmConfig": { "baseUrl": "...", "apiKey": "...", "model": "..." }
}
```
- `messages` (required, non-empty array of `{role, content}`).
- `llmConfig` optional — falls back to `OPENAI_API_KEY` env vars when omitted.
- `correlationId` should be a client-generated UUID, persisted across the conversation and re-sent every turn.

**Response 200:**
```json
{
  "reply": "How many participants are involved?",
  "readyToGenerate": false,
  "suggestedSummary": null,
  "correlationId": "uuid"
}
```
When the LLM has enough context: `readyToGenerate: true` and `suggestedSummary` is a paragraph to pass as `userText` to `/orchestrate`.

**Errors:**
- `400 { error: "messages must be a non-empty array" }`.
- `400 { error: "llmConfig is required (or set OPENAI_API_KEY on the server)" }`.
- `400 { error: "llmConfig requires baseUrl, apiKey, model" }`.
- `500 { correlationId, status: "internal_error", error }` — LLM call or JSON parse failed.

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"I need an approval process"}],"llmConfig":{"baseUrl":"https://api.openai.com/v1","apiKey":"sk-...","model":"gpt-4o-mini"}}'
```

---

## POST /api/v1/telemetry

Best-effort frontend event log. No schema gate — loose by design. Appends one JSONL line to the audit log.

**Request:**
```json
{
  "event": "bpmn.edit",
  "correlationId": "uuid",
  "diagramId": "uuid",
  "details": { "commandType": "shape.move", "elementCount": 12 }
}
```

**Response 200:** `{ "status": "ok" }`

**Errors:** `400 { error }` — only on a genuinely malformed request.

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/telemetry \
  -H 'Content-Type: application/json' \
  -d '{"event":"session.start","correlationId":"abc","details":{}}'
```

---

## GET /api/v1/config

Frontend bootstrap: reports whether the server has an LLM key configured via env var, so the frontend can skip its API-key modal. Pre-auth, not rate-limited. Reveals no secret.

**Request:** none (no body, no auth).

**Response 200 (dev mode, no `BPMN_API_KEY`):**
```json
{ "envKeyConfigured": true, "model": "gpt-4o-mini" }
```
`model` is `null` when no `OPENAI_API_KEY` is set.

**Response 200 (production, `BPMN_API_KEY` set):**
```json
{ "envKeyConfigured": true }
```
The `model` field is omitted in production to minimize information disclosure.

**Example:**
```bash
curl http://localhost:3000/api/v1/config
```

---

## GET /health

Liveness probe. Pre-auth, not rate-limited.

**Response 200:** `{ "status": "ok", "uptime": 42, "version": "2.0.0" }` (`uptime` in seconds).

**Example:**
```bash
curl http://localhost:3000/health
```
````

- [ ] **Step 2: Verify every curl example against a running server**

```bash
cd scripts && node http-server.js &
sleep 1
curl -s http://localhost:3000/health; echo
curl -s http://localhost:3000/api/v1/config; echo
curl -s -X POST http://localhost:3000/api/v1/generate -H 'Content-Type: application/json' \
  -d '{"logicCore":{"nodes":[{"id":"s","type":"startEvent","name":"Start"},{"id":"e","type":"endEvent","name":"End"}],"edges":[{"id":"f1","source":"s","target":"e"}]}}' | head -c 200; echo
curl -s -X POST http://localhost:3000/api/v1/validate -H 'Content-Type: application/json' \
  -d '{"logicCore":{"nodes":[{"id":"t","type":"task","name":"Do"}],"edges":[]}}'; echo
curl -s -X POST http://localhost:3000/api/v1/telemetry -H 'Content-Type: application/json' \
  -d '{"event":"session.start","correlationId":"abc","details":{}}'; echo
kill %1
```
Expected: `/health` and `/config` return the documented shapes; `/generate` returns XML; `/validate` returns a `validation` object; `/telemetry` returns `{"status":"ok"}`. If any response shape differs from the doc, fix the doc to match the server (the server is the source of truth).

- [ ] **Step 3: Update the README table**

In `README.md`, replace the table at lines 362-368:

```markdown
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/generate` | Logic-Core JSON → BPMN 2.0 XML + SVG |
| `POST` | `/api/v1/validate` | Validate Logic-Core without generating output |
| `POST` | `/api/v1/import` | BPMN 2.0 XML → Logic-Core JSON |
| `POST` | `/api/v1/orchestrate` | Multi-agent review + generate + compliance |
| `POST` | `/api/v1/chat` | Discovery conversation (pre-generation) |
| `POST` | `/api/v1/telemetry` | Frontend event log (best-effort) |
| `GET` | `/api/v1/config` | Frontend bootstrap (env-key status) |
| `GET` | `/health` | Health check (uptime, version) |

See [references/api-reference.md](references/api-reference.md) for full request/response schemas and error codes.
```

- [ ] **Step 4: Commit**

```bash
cd /Users/daniel.stiegler/Projects/bpmn-generator
git add references/api-reference.md README.md
git commit -m "docs(api): add references/api-reference.md, extend README endpoint table

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** Task 1 = §2/§3.1a helper extraction; Task 2 = §3.1 config endpoint (dev/prod gating, request-time env read) + §6 tests; Task 3 = §3.2 api-reference.md + §3.3 README update. Out-of-scope items (frontend wiring, AGENTS.md rewrite, OpenAPI) correctly absent.
- **Type consistency:** `resolveEnvLlmConfig()` returns `{baseUrl, apiKey, model}|null` in Task 1 and is consumed with `envCfg ? envCfg.model : null` in Task 2 — consistent.
- **Test isolation:** `afterEach` clears `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `BPMN_API_KEY` so no env leaks between tests.
