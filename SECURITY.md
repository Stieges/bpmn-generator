# Security Policy

## Reporting a vulnerability

Email: **stieges99@gmail.com** with subject `[bpmn-generator security]`. Please do not file public issues for unpatched vulnerabilities.

Expect an initial response within 7 days. Confirmed issues: fix or coordinated disclosure within 30 days for most cases, longer for complex ones.

## Threat model

The BPMN Generator runs in four deployment shapes with different trust boundaries:

1. **Library** (Node module via `npm install`): caller is trusted. No special handling.
2. **CLI** (`node bpmn/pipeline.js ...`): local user is trusted. Same as library mode. (A rule
   profile path given here still goes through the same safe reader and schema gate as every
   other profile; only the soundness restriction of the HTTP API does not apply.)
3. **HTTP API**: network is untrusted. **This is the surface that needs hardening.**
4. **MCP server** (stdio, started by the local user's MCP client): a **trusted local user**, the
   same trust level as the CLI — it may relax any rule, the soundness layer included, because the
   user who runs it could run the CLI with any profile file anyway. What it does not get is
   filesystem reach: the tool arguments are written by an LLM, which a prompt injection in the
   modelled text can steer, so a profile is a *name* inside the repository's `rules/` directory,
   never a path, and every input still passes the same schema gates as over HTTP.

### HTTP API threats and mitigations

| Threat | Mitigation | Where |
|---|---|---|
| SSRF via `callbackUrl` | One validator for every outbound request to a client-supplied URL: http/https only, no credentials in the URL, `localhost`/`*.localhost` refused; the host is parsed by WHATWG `URL` and `node:net`, a name is DNS-resolved and **every** resolved address is checked against a denylist — IPv4 `0.0.0.0/8`, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4 (incl. broadcast); IPv6 `::`, `::1`, 100::/64, 2001:db8::/32, fc00::/7, fe80::/10, fec0::/10, ff00::/8, 64:ff9b:1::/48 — and IPv6 forms that embed an IPv4 address (mapped, compatible, translated, NAT64 64:ff9b::/96, 6to4, Teredo) are checked as the embedded address. Delivery connects only to the addresses that passed the check (the socket's lookup returns exactly those, so a second resolution cannot swap them; `Host`/SNI stay the original name) and **does not follow redirects** — a 3xx is a failed attempt | `scripts/shared/outbound-url.js` (wired in `http-server.js` — `validateCallbackUrl`/`validateCallbackUrlAsync` — and `delivery.js`) |
| SSRF via `llmConfig.baseUrl` | A client `baseUrl` is refused unless its origin is listed in the operator's `LLM_BASE_URL_ALLOWLIST` (comma-separated origins; empty by default, so clients may not set it at all). An allowlisted URL still passes the outbound-URL validator above and is called over the same pinned, redirect-free transport — so an allowlisted origin that resolves to a private address is still refused; an endpoint on the server's own network (a local Ollama, say) is configured by the operator through `OPENAI_BASE_URL` instead. Without `baseUrl`, the client's key and model go to the server-configured endpoint (`OPENAI_BASE_URL`, else the OpenAI default) — operator configuration, not validated. A provider's response body is never returned: failures are a generic `502 llm_error` with the correlation id; the detail is logged to stderr, truncated and escaped | `scripts/http-server.js` — `resolveClientLlmConfig`; `scripts/agents/llm-provider.js` — `LlmProviderError` |
| File write through dead-letter names | Dead-letter files are named by a server-generated UUID (the correlation id is stored inside the file), created exclusively (`wx`), and the resolved path must lie inside `DEAD_LETTER_PATH`. At the HTTP entry `correlationId` must match `^[A-Za-z0-9_-]{1,64}$` (else `400`) | `scripts/delivery.js`, `scripts/http-server.js` |
| Unauthorized access | API key required in production (`BPMN_API_KEY` env), fail-fast startup if missing while `NODE_ENV=production`; the key is compared in constant time (SHA-256 digests, `crypto.timingSafeEqual`) | `scripts/http-server.js` — `startupCheck`, `apiKeyMatches` |
| Resource exhaustion | Body size cap (10 MB); a JSON body that is not an object is refused at once; per-client rate limit (30 req/min) keyed on the socket address, or — with `TRUST_PROXY_HOPS=<n>` behind `n` reverse proxies — on the address the outermost trusted proxy recorded in `X-Forwarded-For` (counted from the right, so client-prepended entries are ignored; a shorter chain falls back to the socket address). Set `TRUST_PROXY_HOPS` only when the server is reachable exclusively through those proxies (bound to the proxy network or firewalled) — a client that connects directly controls `X-Forwarded-For` and with it its rate-limit key; expired buckets are evicted once per window | `scripts/http-server.js` — `rateLimitKey`, `rateLimitAllows` |
| Malformed input crashing the pipeline | Strict JSON Schema validation at `/api/v1/generate`, `/api/v1/validate`, and `/api/v1/orchestrate` (when `body.logicCore` is provided), and on the MCP tools `generate_bpmn`, `validate_bpmn` and `orchestrate_bpmn`, against `references/input-schema.json` | `scripts/bpmn/schema-gate.js` (wired in `http-server.js`, `mcp-bpmn-server.js`) |
| Rule profile as an attack vector (file read through a profile path, oversized or deeply keyed profiles, forged log lines) | **HTTP:** `ruleProfile` is an inline object only — a string is refused, no file a client names is ever read. **MCP:** `ruleProfile` is a profile *name* resolved inside the repository's `rules/` directory (located once, in `scripts/shared/resource-paths.js`, from the module's location — never the working directory, never `node_modules/rules`); paths, `..` and symlinks leaving `rules/` are refused. Named profiles need a repository checkout: `rules/` is not shipped in the npm package, so an installed package refuses every name ("named rule profiles need a repository checkout; pass none or use the CLI with a file"). **Every profile**, inline or from a file, passes `references/rule-profile-schema.json` after a size/depth bound (64 KiB, 4 levels) checked by a walk that stops at the limit. Files (MCP names, CLI paths) are opened non-blocking and must be regular files of at most 256 KiB. Messages quote client tokens JSON-escaped without control or Unicode format characters, list at most 20 warnings / 5 schema problems, never include file content, and name no server path for an HTTP or MCP caller; the audit line of a refusal is capped at 500 characters. Over HTTP a profile may not disable the soundness layer or set a soundness rule below its default severity (it may only raise one); MCP, a trusted local channel, may |  `scripts/shared/rule-profile.js` (wired in `http-server.js`, `mcp-bpmn-server.js`) |
| LLM output injection | LLM output flows through the same schema gate before reaching the pipeline; the LLM never writes to disk directly | `scripts/orchestrator.js` → schema-gate → `runPipeline` |
| Sensitive data in audit log | Audit log path is configurable via `AUDIT_LOG_PATH` for secure storage (encrypted volumes, append-only filesystems) | `scripts/audit.js` |
| Log forging and log flooding through client fields | Every client string written to the audit log or echoed in a response is length-bounded (128 characters for identifiers such as `clientId`, telemetry `event`/`diagramId`; 500 for messages) with control, line-separator and format characters escaped; schema-gate errors in a response are capped at 20 plus a count, their strings bounded to 200 characters; telemetry `details` above 8 KiB is a `400`, its keys and strings are bounded the same way | `scripts/shared/safe-text.js` (wired in `http-server.js`) |

### Out of scope

- Denial-of-service from clients with valid API keys (operate behind a gateway / WAF).
- Compromise of an LLM endpoint the operator configured (`OPENAI_BASE_URL`) or allowlisted (`LLM_BASE_URL_ALLOWLIST`) — the API forwards LLM calls there, with the server's key or a user-provided one. Reaching hosts the operator did not choose is in scope (see the `llmConfig.baseUrl` row above).
- Container / host hardening — running the service in a hardened container (read-only filesystem, dropped capabilities, non-root user) is the operator's responsibility.

## Dependencies and supply chain

The runtime dependency surface is deliberately small — `elkjs`, `bpmn-moddle`, `@modelcontextprotocol/sdk`, `ajv`, `ajv-formats`. Adding to it requires prior discussion (see `CLAUDE.md`); every one of the five was a deliberate choice. Supported Node is `>=20` (declared in `scripts/package.json`); CI tests 20 and 22.

### The gate

Every pull request, every push to `master`, and a weekly cron run execute `.github/scripts/dep-audit-gate.mjs`. It parses `npm audit` and **fails the build on any `high` or `critical` advisory not covered by a valid exception**. Moderate and low findings are reported without blocking.

| Exit code | Meaning |
|---|---|
| 0 | clean, or every failing-severity finding is validly exempted |
| 1 | policy violation |
| 2 | tooling error — audit unrunnable, policy malformed |

Exit 2 exists so that an audit which *could not run* never reads as an audit that *found nothing*. The gate has no dependencies of its own and audits from the lockfile, so it needs no `npm ci`.

Reproduce locally from the repository root:

```bash
node .github/scripts/dep-audit-gate.mjs      # the gate's verdict
cd scripts && npm audit                      # the raw report
```

A second job in the same workflow runs `npm audit signatures`, which answers a different question: not "is a known advisory open?" but "did these artifacts really come from the registry unmodified?". It is non-blocking at present.

**What the gate is not.** It guards against regression and inattention, not against a hostile pull request. On a fork PR the policy file, the lockfile *and the gate script itself* are checked out from the PR head, so a determined fork can simply rewrite the gate. This is inherent to every in-repo CI check; the actual controls there are human review and branch protection. The registry is pinned to `registry.npmjs.org` in the gate so that a project-level `.npmrc` cannot redirect the advisory lookup, but that closes one hole rather than making the gate a security boundary.

Two further caveats. GitHub disables scheduled workflows after 60 days of repository inactivity, so the weekly run is not a self-maintaining safety net. And the gate enforces what the lockfile resolves — it does not prevent someone from regenerating the lockfile and losing a pinned resolution; it only makes that regression visible on the next run.

### Adopting new versions

The Dependabot `cooldown` (7 days, 30 for majors) gives a freshly published version time to be found out before it is adopted — the 2026 npm compromises were published through legitimate maintainer accounts, so a valid signature is not by itself evidence of a benign release.

**A manual `npm update` bypasses that cooldown entirely.** When closing an advisory by hand this is a deliberate trade — the open vulnerability is a certainty, the compromised-release risk is a possibility — but make it consciously and check what you are adopting:

```bash
npm view <package>@<version> time    # how old is this release?
npm audit signatures                 # did it come from the registry unmodified?
```

Worth weighting the decision by reachability: a package this project never loads (the MCP SDK's HTTP-transport subtree, for instance) carries far less risk from a same-day adoption than one on the untrusted-input path such as `ajv`/`fast-uri`.

### Accepted risks

Exceptions live in `.github/dependency-policy.json`. Each requires `reason`, `whyNotFixed`, `reviewTrigger`, `opened` and `expires`; the gate refuses to run against a policy missing any of them. **`expires` is mandatory and capped at 180 days, and an expired entry fails the build** — an accepted risk that nobody re-examines is not an accepted risk, it is a forgotten one. Where an exception rests on a claim that some code path is never reached, `voidIf.importsFound` names the specifiers that would disprove it; the gate greps first-party product code for them on every run, so the claim is machine-checked rather than asserted in a comment.

There are currently **no accepted risks** — `exceptions` in the policy file is empty. The last two
were closed by in-range upgrades in October 2026: `brace-expansion` (high, dev-only) now resolves to
patched 1.x/2.x releases, and the `@hono/node-server` path-traversal advisory (moderate) no longer
matches the installed version, while `@modelcontextprotocol/sdk` 1.32 widened its range to admit
`@hono/node-server >= 2.0.5` — the review trigger the exception was waiting for.

What remains is non-blocking: a moderate `js-yaml` advisory deep in jest's coverage tooling
(dev-only). npm's only proposed remedy is a semver-major *downgrade* of jest, so it stays a warning
until jest's own tree moves.

To report a vulnerability in a dependency, use the same address and timeline as above.

## Recommended deployment

```bash
NODE_ENV=production
BPMN_API_KEY=<32-byte random string, e.g. `openssl rand -hex 32`>
AUDIT_LOG_PATH=/var/log/bpmn-generator/audit.jsonl
DEAD_LETTER_PATH=/var/lib/bpmn-generator/dead-letter
PORT=3000
# behind one reverse proxy that appends the client address to X-Forwarded-For —
# only when the server is reachable exclusively through that proxy:
TRUST_PROXY_HOPS=1
# only if clients must name their own LLM endpoint (comma-separated origins):
# LLM_BASE_URL_ALLOWLIST=https://llm.example.com
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
