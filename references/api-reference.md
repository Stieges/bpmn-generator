# HTTP API Reference

Complete reference for the BPMN Generator HTTP API. For a high-level overview see the README's "HTTP API" section.

## Conventions

- **Base URL:** `http://<host>:<PORT>` (default `PORT=3000`). Start with `PORT=3000 node scripts/http-server.js`.
- **Auth:** When `BPMN_API_KEY` is set on the server, all endpoints except `GET /health` and `GET /api/v1/config` require the header `X-API-Key: <key>`. In dev mode (no `BPMN_API_KEY`) no auth is required. Missing/wrong key → `401 { "error": "Invalid API key" }`.
- **Rate limit:** 30 requests/minute per IP (except `/health` and `/config`, which are checked before the limiter). Exceeding → `429 { "error": "Rate limit exceeded" }`.
- **Body size cap:** 10 MB. Larger → the request is destroyed and rejected `400 { "error": "Invalid JSON body" }`.
- **Content type:** POST endpoints expect `Content-Type: application/json`. Non-JSON body → `400 { "error": "Invalid JSON body" }`.
- **Correlation:** All POST endpoints accept optional `correlationId` (echoed back; generated if absent) and `clientId` (recorded in the audit log).
- **Method:** A non-`POST` request to any API path (known or unknown) other than `GET /health` and `GET /api/v1/config` → `405 { "error": "Method Not Allowed" }`. A `POST` to a path that isn't one of the six POST endpoints below → `404 { "error": "Not Found" }`.

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
`status` is always `"success"` here (unlike `/generate`, it does not flip to an error status when `validation.errors` is non-empty — a non-empty `errors` array is itself the signal).

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
