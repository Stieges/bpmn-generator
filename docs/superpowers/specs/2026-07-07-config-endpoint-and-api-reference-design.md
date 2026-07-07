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

Handled in the same pre-auth block as `GET /health` in `scripts/http-server.js` (before `checkAuth`/`checkRateLimit`), since the frontend must be able to call it before any API key exists client-side. It reveals no secret — only whether a server-side env key is present and, if so, which model would be used.

```
GET /api/v1/config

200 OK
{
  "envKeyConfigured": true,
  "model": "gpt-4o-mini"
}
```

When no env key is configured:

```
200 OK
{
  "envKeyConfigured": false,
  "model": null
}
```

Logic:
```js
const envKeyConfigured = Boolean(process.env.OPENAI_API_KEY);
const model = envKeyConfigured ? (process.env.OPENAI_MODEL || 'gpt-4o-mini') : null;
```

This mirrors the existing env-fallback logic already duplicated in the `/orchestrate` and `/chat` handlers (`process.env.OPENAI_API_KEY`, `process.env.OPENAI_MODEL`) — no new environment variables introduced.

No request body. No auth. Not rate-limited (same treatment as `/health`).

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

## 5 Error Handling

`/config` has no error path of its own — it never reads the request body and never throws. The one thing to get right is placement: `http-server.js` rejects any non-POST request with 405 further down in the handler, so `/config`, like `/health`, must be registered in the earlier GET-only block, ahead of that guard.

## 6 Testing

- `scripts/http-server.test.js`: assert `GET /api/v1/config` returns 200 with `envKeyConfigured: false, model: null` when `OPENAI_API_KEY` is unset, and `envKeyConfigured: true, model: <value>` when it is set (both default and explicit `OPENAI_MODEL`).
- No tests needed for `references/api-reference.md` itself (documentation, not code) — but every curl example in it should be manually verified against the running server as part of writing it.
