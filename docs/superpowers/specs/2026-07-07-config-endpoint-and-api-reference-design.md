# Config Endpoint + API Reference Documentation — Design

**Date:** 2026-07-07
**Status:** Draft (post-brainstorm)
**Owner:** Daniel Stiegler + Claude

## 1 Goal

Close two gaps left over from the v3.5d Bootstrap-Polish backlog:

1. The frontend needs a way to know, before the user types anything, whether the backend already has an LLM API key configured via environment variable — so it can skip the "paste your API key" Settings modal. No such endpoint exists today; `AGENTS.md` already claims this behavior, which is currently false.
2. The HTTP API has grown to 8 endpoints (`/generate`, `/validate`, `/import`, `/orchestrate`, `/chat`, `/telemetry`, `/health`, and the new `/config`) with no single place documenting request/response shapes and error cases. `README.md` has a 5-row table with descriptions only — no schemas, no error codes, no examples. Anyone integrating against this API (or reviewing it) has to read `http-server.js` source to find out what a 400 looks like.

## 2 Scope

### In scope

- New `GET /api/v1/config` endpoint in `scripts/http-server.js`
- Extract the duplicated env-LLM-config resolution (currently copy-pasted in `/orchestrate` and `/chat`) into a small `resolveEnvLlmConfig()` helper, reused by all three handlers
- New `references/api-reference.md` — full reference for all 8 HTTP endpoints
- `README.md` HTTP API table updated with the 3 missing rows (`/chat`, `/telemetry`, `/config`) and a link to the new reference doc
- Tests for the new endpoint in `scripts/http-server.test.js` (existing file from the `/chat` work)

### Out of scope

- Frontend changes (hiding the Settings button, calling `/config` on load) — per existing delegation split, frontend work happens in a separate opencode-desktop session, not here. This plan only makes the backend contract real.
- Rewriting `AGENTS.md`'s existing claim — a one-line follow-up once the frontend side also ships; not blocking this plan.
- OpenAPI/Swagger spec (considered, rejected — see §4).
- Any change to auth, rate-limiting, or audit-log behavior beyond what's needed for `/config`.

## 3 Architecture

### 3.1 `GET /api/v1/config`

Handled in the same pre-auth block as `GET /health` in `scripts/http-server.js` (before `checkAuth`/`checkRateLimit`), since the frontend must be able to call it before any API key exists client-side. It reveals no secret — only whether a server-side env key is present and, in dev mode, which model would be used.

**Security posture — model name is dev-only.** The endpoint is unauthenticated by necessity (the frontend calls it pre-key). To minimize information disclosure in production (where `BPMN_API_KEY` is set and all other endpoints require auth), the `model` name — the more identifying field — is only returned in dev mode (no `BPMN_API_KEY`). In production the response carries only the `envKeyConfigured` boolean, which is essentially harmless: it does not reveal the key, only that one exists, comparable to `/health` already exposing `version` unauthenticated. This establishes a forward-looking principle for any future `/config` fields: operational/configuration detail is dev-only; production stays minimal.

The endpoint reads `process.env` **at request time**, not at server startup — so a key set/unset after boot is reflected immediately (and so tests can toggle the env var per-case).

Dev mode (no `BPMN_API_KEY`), env key present:
```
GET /api/v1/config

200 OK
{
  "envKeyConfigured": true,
  "model": "gpt-4o-mini"
}
```

Dev mode, no env key:
```
200 OK
{
  "envKeyConfigured": false,
  "model": null
}
```

Production (`BPMN_API_KEY` set) — `model` omitted regardless of env-key state:
```
200 OK
{
  "envKeyConfigured": true
}
```

Logic (uses the shared helper from §3.1a so the `gpt-4o-mini` default has one source of truth):
```js
const envCfg = resolveEnvLlmConfig();          // null when OPENAI_API_KEY unset
const devMode = !process.env.BPMN_API_KEY;      // read fresh at request time
const payload = { envKeyConfigured: Boolean(envCfg) };
if (devMode) {
  payload.model = envCfg?.model ?? null;
}
```

No request body. No auth. Not rate-limited (same treatment as `/health`). No new environment variables introduced — reuses `OPENAI_API_KEY`, `OPENAI_MODEL`, and `BPMN_API_KEY`.

### 3.1a `resolveEnvLlmConfig()` helper

The env-LLM-config resolution is currently copy-pasted in `/orchestrate` and `/chat`:
```js
{
  baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
}
```
Extract into a single module-level helper `resolveEnvLlmConfig()` that returns this object (or `null` when `OPENAI_API_KEY` is unset). `/orchestrate` and `/chat` call it as their fallback; `/config` reuses the same `gpt-4o-mini` default via this helper (reading `.model` from it) so the default cannot drift between the three sites. Pure refactor — no behavior change for existing endpoints, guarded by the existing `/orchestrate` tests plus the new `/chat` and `/config` tests.

### 3.2 `references/api-reference.md`

One file, one `##` section per endpoint, following the existing single-file-per-topic convention in `references/` (e.g. `logic-core-schema.md`, `omg-compliance.md`). Per endpoint:

- Method + path, one-line purpose
- Auth requirement (API key via `X-API-Key` header when `BPMN_API_KEY` is set; none otherwise)
- Request body schema (fields, types, required/optional)
- Success response schema
- Error responses (status code + shape), enumerated from what `http-server.js` actually returns today (400 validation, 400 schema_error, 401, 404, 405, 429, 500) — not aspirational
- One curl example per endpoint

Order: `/generate`, `/validate`, `/import`, `/orchestrate`, `/chat`, `/telemetry`, `/config`, `/health` — matches the order they appear in `http-server.js`.

A short intro section at the top covers cross-cutting concerns once instead of repeating them per endpoint: base URL, auth header, rate limit (30 req/min/IP), body size cap (10 MB), the `correlationId`/`clientId` convention.

### 3.3 `README.md` update

Add the 3 missing rows to the existing table, add a `See references/api-reference.md for full request/response schemas and error codes.` line directly under the table. No other README restructuring.

## 4 Alternatives considered

- **Fold `envKeyConfigured` into `/health`** instead of a new endpoint — rejected: conflates liveness (health) with configuration state (config); the original Bootstrap-Polish note explicitly called for a dedicated endpoint, and future config fields (if any) would awkwardly live under "health" otherwise.
- **OpenAPI/Swagger spec** instead of a hand-written markdown reference — rejected for now: no existing tooling in the repo consumes it (no Swagger UI, no codegen), and it's a new format/maintenance burden for a project whose `references/` docs are otherwise all markdown. Revisit if a UI/client-generation need appears later.
- **`/config` behavior for the `model` field** — three options weighed: (a) always return `model`, (b) return `model` only in dev mode, (c) never return `model`. Chose (b). Option (a) is an unnecessary unauthenticated info leak in production; option (c) is marginally more secure but drops the feature the frontend needs (showing which model is pre-configured). Option (b) gives the frontend the model name exactly where it runs (local dev, no `BPMN_API_KEY`) while keeping production responses minimal.

## 5 Error Handling

`/config` has no error path of its own — it never reads the request body and never throws. The one thing to get right is placement: `http-server.js` rejects any non-POST request with 405 further down in the handler, so `/config`, like `/health`, must be registered in the earlier GET-only block, ahead of that guard.

## 6 Testing

`scripts/http-server.test.js` (server already boots on an ephemeral port there; `afterEach` already deletes `OPENAI_API_KEY`). Add for `/config`:

- Dev mode, no env key → `200 { envKeyConfigured: false, model: null }`.
- Dev mode, `OPENAI_API_KEY` set, no `OPENAI_MODEL` → `200 { envKeyConfigured: true, model: 'gpt-4o-mini' }`.
- Dev mode, `OPENAI_API_KEY` + explicit `OPENAI_MODEL` set → `model` echoes the explicit value.
- Production simulation, `BPMN_API_KEY` set + `OPENAI_API_KEY` set → response has `envKeyConfigured: true` and **no** `model` key. This works against the already-booted server because the `/config` handler reads `process.env.BPMN_API_KEY` **fresh at request time** for the dev/prod gate — deliberately not the module-load `API_KEY` const that `checkAuth` uses. The test sets `process.env.BPMN_API_KEY` before the request and clears it in `afterEach` alongside the existing `OPENAI_API_KEY` cleanup. (The module-load `API_KEY` used by `checkAuth` is irrelevant here: `/config` is pre-auth, so `checkAuth` never runs for it.)

The `resolveEnvLlmConfig()` refactor is covered transitively by the existing `/orchestrate` env-fallback test and the `/chat` env-fallback test — both must stay green with no assertion changes, proving the extraction preserved behavior.

No tests for `references/api-reference.md` itself (documentation, not code) — but every curl example in it must be manually verified against the running server while writing it.
