# Security Policy

## Reporting a vulnerability

Email: **stieges99@gmail.com** with subject `[bpmn-generator security]`. Please do not file public issues for unpatched vulnerabilities.

Expect an initial response within 7 days. Confirmed issues: fix or coordinated disclosure within 30 days for most cases, longer for complex ones.

## Threat model

The BPMN Generator runs in three deployment shapes with different trust boundaries:

1. **Library** (Node module via `npm install`): caller is trusted. No special handling.
2. **CLI** (`node pipeline.js ...`): local user is trusted. Same as library mode.
3. **HTTP API / MCP server**: network is untrusted. **This is the surface that needs hardening.**

### HTTP API threats and mitigations

| Threat | Mitigation | Where |
|---|---|---|
| SSRF via `callbackUrl` | Protocol allowlist (http/https), denylist for IPv4 private ranges (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x), IPv6 (::1, fc00::/7, fe80::/10), DNS-resolve hostname and re-check resolved IPs | `scripts/http-server.js` — `validateCallbackUrl` + `validateCallbackUrlAsync` |
| Unauthorized access | API key required in production (`BPMN_API_KEY` env), fail-fast startup if missing while `NODE_ENV=production` | `scripts/http-server.js` — `startupCheck` |
| Resource exhaustion | Body size cap (10 MB), per-IP rate limit (30 req/min) | `scripts/http-server.js` |
| Malformed input crashing the pipeline | Strict JSON Schema validation at `/api/v1/generate`, `/api/v1/validate`, and `/api/v1/orchestrate` (when `body.logicCore` is provided), against `references/input-schema.json` | `scripts/schema-gate.js` (wired in `http-server.js`) |
| LLM output injection | LLM output flows through the same schema gate before reaching the pipeline; the LLM never writes to disk directly | `scripts/orchestrator.js` → schema-gate → `runPipeline` |
| Sensitive data in audit log | Audit log path is configurable via `AUDIT_LOG_PATH` for secure storage (encrypted volumes, append-only filesystems) | `scripts/audit.js` |

### Out of scope

- Denial-of-service from clients with valid API keys (operate behind a gateway / WAF).
- Compromise of the LLM endpoint configured via `body.llmConfig.baseUrl` — the API forwards LLM calls to user-provided endpoints with user-provided keys.
- Container / host hardening — running the service in a hardened container (read-only filesystem, dropped capabilities, non-root user) is the operator's responsibility.

## Recommended deployment

```bash
NODE_ENV=production
BPMN_API_KEY=<32-byte random string, e.g. `openssl rand -hex 32`>
AUDIT_LOG_PATH=/var/log/bpmn-generator/audit.jsonl
DEAD_LETTER_PATH=/var/lib/bpmn-generator/dead-letter
PORT=3000
```

Place the service behind a reverse proxy (nginx, Caddy, or a load balancer) that handles TLS termination, IP filtering if needed, and a second layer of rate limiting.

### Quick check the gate works

```bash
# 1. Production refuses to start without a key
NODE_ENV=production node scripts/http-server.js
#  → exits non-zero with "Refusing to start in production without BPMN_API_KEY"

# 2. SSRF is blocked (run server in another shell first)
curl -X POST http://localhost:3000/api/v1/generate \
  -H 'content-type: application/json' \
  -d '{"logicCore":{"nodes":[{"id":"a","type":"startEvent"}],"edges":[]},"callbackUrl":"http://169.254.169.254/"}'
#  → 400 { "error": "callbackUrl must not target internal networks" }

# 3. Schema-gate rejects malformed input
curl -X POST http://localhost:3000/api/v1/generate \
  -H 'content-type: application/json' \
  -d '{"logicCore":{"banana":"phone"}}'
#  → 400 { "status": "schema_error", "errors": [...] }
```

## Versions covered

Security fixes are issued for the latest released minor version (currently 3.x). Older versions may receive fixes for critical vulnerabilities at maintainer discretion.
