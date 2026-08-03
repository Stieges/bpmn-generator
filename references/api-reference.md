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
- `mode` (optional, string) — `"document"` (default, faithful IST) or `"optimize"`/`"soll"`. In optimize mode the response `validation` gains `advisories` (redesign suggestions) and `metrics.optimization` (Lean metrics). Advisories are heuristic, non-blocking, never auto-applied.
- `poolOrder` (optional, string) — `"auto"` (default) or `"declared"`. With `"auto"` the participants of a collaboration are stacked so that the ones exchanging messages sit next to each other; a message flow spanning N positions has to cross N-1 uninvolved pools, which reads as a participation that does not exist. With `"declared"` the input order is kept instead — routing stays orthogonal, there are simply more crossings, and `diagnostics` reports them as DI05.

`validation.advisories` is a list of objects: `{ id, transform, targets, message, tradeoff, ref, judgment, pool? }`.
- `id` — advisory rule id (`O01`–`O04`, see `references/fachliches-regelwerk.md`)
- `transform` — the matching deterministic intervention in the redesign toolbox (`scripts/bpmn/redesign.js`): `isolateException` (O01), `reorderKnockouts` (O02), `relane` (O03), `parallelize` (O04). Not every toolbox transform has a detector — `mergeTasks` never appears here, it's reachable only by calling `scripts/bpmn/redesign.js`/`redesign-cli.js` directly.
- `targets` — ids of the affected nodes/gateways
- `message` — the human-readable line (what the CLI and this response print)
- `tradeoff` — devil's-quadrangle tag, e.g. `{ "time": "−" }` or `{ "quality": "+" }`
- `ref` — source citation, e.g. `{ "reijers": "parallelism" }` or `{ "reijers": "task-composition", "babok": "§10.34" }`
- `judgment` — `true` means: needs human confirmation, not mechanically applicable on its own (currently always `true` — no advisory is auto-applicable)
- `pool` — present only for multi-pool Logic-Core, names the owning pool

None of this is applied automatically; turning an advisory into an actual model change means calling the named `transform` in the redesign toolbox yourself (see `SKILL.md` → "Redesign Toolbox").
- `callbackUrl` (optional, string) — if present, the result is also POSTed there asynchronously; the URL is SSRF-validated (rejects internal/link-local hosts, DNS-resolves and re-checks).

**Response 200:**
```json
{
  "correlationId": "uuid",
  "status": "success",
  "bpmnXml": "<?xml ...",
  "svg": "<svg ...",
  "validation": { "errors": [], "warnings": [], "advisories": [], "metrics": {}, "xmlWarnings": [] },
  "diagnostics": { "ok": true, "issues": [] },
  "callbackStatus": "not_requested"
}
```
`status` is `"validation_error"` when `validation.errors` is non-empty, or `"diagram_error"` when `validation.errors` is empty but `diagnostics.ok` is `false` (validation takes priority — a request is never both at once). `callbackStatus` is `"pending"` when a `callbackUrl` was accepted. `validation.advisories` is populated only in `mode: "optimize"`. `validation.xmlWarnings` comes from re-parsing the generated XML through bpmn-moddle (a round-trip check on the generator's own output, distinct from the rule engine) — present here and on `/orchestrate`, absent on `/validate`, which never generates XML. See "validation vs. diagnostics" below.

**Errors:**
- `400 { correlationId, status: "schema_error", errors: [...] }` — Logic-Core failed the schema gate.
- `400 { error: "callbackUrl ..." }` — invalid or internal callback URL.
- `500 { correlationId, status: "internal_error", error }` — pipeline threw.

### validation vs. diagnostics

They answer different questions, and neither substitutes for the other.

`validation` comes from the rule engine, which reasons about the Logic-Core graph and
**never sees a coordinate**. A process can be structurally sound — every rule green —
and still produce an unusable diagram; that combination is what motivated the DI check.

`diagnostics` inspects the geometry actually produced for this request.
`diagnostics.ok` means "no ERROR-severity finding"; WARNING-severity findings are
reported but do not flip `status` to `"diagram_error"`.

| Code | Severity | Meaning |
|------|----------|---------|
| DI01 | ERROR | Two participants at identical coordinates |
| DI02 | ERROR | Participant shapes overlapping |
| DI03 | ERROR | A node outside the participant it belongs to |
| DI04 | ERROR | Lane bands overlapping inside a participant |
| DI05 | WARNING | A message flow crossing a participant it does not involve |
| DI06 | ERROR | A child outside its expanded subprocess |

DI05 is a warning rather than an error because a communication cycle across three or
more participants cannot be linearised into a single vertical stack — some crossings
are unavoidable; `poolOrder: "auto"` (see above) minimises them but cannot always reach
zero.

**Example:**
```bash
curl -X POST http://localhost:3000/api/v1/generate \
  -H 'Content-Type: application/json' \
  -d '{"logicCore":{"nodes":[{"id":"s","type":"startEvent","name":"Start"},{"id":"e","type":"endEvent","name":"End"}],"edges":[{"id":"f1","source":"s","target":"e"}]}}'
```

---

## DMN diagnostics (DD01–DD03)

`scripts/dmn/di-check.js`'s `checkDmnDiagramIntegrity` plays the same role for a DRD that
`di-check.js` plays for a BPMN diagram — its own code namespace so the two can appear side by side.
Not yet reachable over HTTP or MCP (Stage 7 of `docs/superpowers/plans/2026-07-30-dmn-integration.md`
adds the tool surface); today it is `runDmnPipeline(dc).diagnostics`, called directly or via the CLI
(`node dmn/pipeline.js`).

| Code | Severity | Meaning |
|------|----------|---------|
| DD01 | ERROR | Two DRD shapes overlapping |
| DD02 | ERROR | A shape outside the diagram's declared bounds |
| DD03 | ERROR | A requirement-connection endpoint that does not sit on its shape's boundary |

`diagnostics.ok` means "no ERROR-severity finding" — the same convention as BPMN's DI01–DI06 above.

---

## Petri-net integrity diagnostics (NC01–NC06)

`scripts/bpmn/net-check.js`'s `checkNetIntegrity` plays the same role for the Petri net
`bpmnToPN` (`scripts/bpmn/workflow-net.js`) produces that `di-check.js` plays for layout geometry:
it checks the *translation*, not the *model*. `checkSoundness` (used by rules WF01–WF03) reasons
about markings in whatever net it is handed and never sees the Logic-Core the net came from — a
translation defect (a dropped container, an edge that silently failed to produce a place) yields a
well-formed verdict about the wrong graph. `checkNetIntegrity` closes that gap by checking the net
itself: does every Logic-Core node have a transition, does every place get produced and consumed,
are ids unique. A process that is legitimately unsound (a real deadlock, a real dead end) is
expected to come out of this check clean — that judgment stays `checkSoundness`/WF01–WF03's job.

It runs on **every** `runPipeline` call and lands on `result.netDiagnostics` — same shape as
`diagnostics` (`{ ok, issues }`, `ok` meaning "no ERROR"), `null` on the early-return path where
validation blocked and no net was built. One call per process, with each finding prefixed
`[pool] ` and carrying `process`: NC messages name a node id and nothing else, and two
participants may legally reuse one, so an unprefixed collaboration finding would be
unattributable. It is computed **before layout**, not next to `checkDiagramIntegrity`, because
`preprocessLogicCore` rebuilds `proc.nodes` from an id-keyed map in place — two nodes sharing an
id collapse into one before ELK, and a later check would be judging a graph the defect had already
left.

It is a **separate key** from `diagnostics` rather than merged into it: `DiagnosticIssue.code` in
`references/api-schema.json` is a closed `DI01`–`DI06` enum with `additionalProperties: false`.
For the same reason `netDiagnostics` is **not surfaced over HTTP or MCP** — `/generate`,
`/orchestrate` and `generate_bpmn` assemble their payloads key by key and none of them carries it.
The CLI gates on it much as it gates on DI: an NC ERROR is fatal with no files written, an NC
WARNING is printed and fatal only under `--strict`. **INFO is printed and never fatal** — one
deliberate difference from the DI block, which has no INFO codes so the question never arose
there. NC05 is the case: its own message says multiple start events sharing one source place are
standard WF-net/OMG normalisation and *not* a defect (OMG §10.4.2 treats them as alternative
instantiations), and a gate that refuses to write files while quoting that sentence would be
telling the caller something false.

Both CLI gates — DI and NC — are on the ordinary generate path only. `--drill-down` takes an
earlier branch (`generateDiagramSet`) that checks `validation.errors` and writes its diagrams, so
it bypasses the NC gate exactly as it already bypasses the DI one. That is pre-existing behaviour
and unchanged; it does mean `--drill-down` will still write a file the ordinary path refuses.

It is additionally fenced over every Logic-Core fixture at the top level of `tests/fixtures/` by
`scripts/bpmn/net-check.test.js`, so a new fixture is covered the day it lands without anyone
having to remember to add it. `tests/fixtures/negative/` is exempt from that scan by construction
(the fence reads one directory level) and is where a fixture that exists to be dirty belongs —
`tests/fixtures/negative/duplicate-ids-across-containers.json` is the NC06 case.

| Code | Severity | Meaning |
|------|----------|---------|
| NC01 | ERROR | A control-flow node produced no transition in the net |
| NC02 | ERROR | A transition has no incoming place although the Logic-Core gives its node an input — the translation dropped an arc |
| NC02b | ERROR | A transition has no outgoing place although the Logic-Core gives its node an output — the translation dropped an arc |
| NC03a | ERROR | A place is never produced by any transition |
| NC03b | ERROR | A place is never consumed by any transition |
| NC04 | ERROR | Two distinct edges were assigned the same place — an invariant assertion on `namePlaces` |
| NC05 | INFO | The source place has more than one consuming transition |
| NC06 | ERROR | Two distinct Logic-Core **nodes** share an id, or an edge-derived place id collides with the reserved source/sink place. Duplicate **edge** ids are out of scope — see below |

NC01 is the exact shape of the container-blindness defect this guard exists for: a translation
step silently drops a node instead of translating it, and the resulting net is still well-formed —
just not the model's net. NC02b, NC03a, NC03b and NC06 are the same class of drop applied to
places, arcs and ids respectively: each leaves a structurally impossible net (a transition that
destroys a token without producing one, a place nothing ever fills or drains, two elements sharing
one id) that no reachability search would ever flag as broken, because the search only sees the net
it was handed.

NC02 became ERROR once boundary events got a Petri-net translation. It had exactly one legitimate
cause — a boundary event, whose trigger is the host it attaches to rather than a sequence flow, so
it used to reach the net with a transition and no incoming arc, unfireable in every marking and
silently deleting its whole escalation path from every analysis. `wireBoundaryEvents`
(`scripts/bpmn/workflow-net.js`) now gives such an event exactly the input places its host
consumes, and a boundary event whose host cannot be found gets no transition at all (it is
disclosed on `skipped` instead). With the cause gone the code says what it always meant.

**NC02 and NC02b are scoped to translation defects, and the promotion to ERROR is what forced the
distinction.** "This transition can never fire" is true of two entirely different things: a
translation that dropped an arc, and a model that routes nothing into the node — a
`parallelGateway` nothing leads to, a subprocess with no incoming flow. The second is a faithful
translation of a defective model, so reporting it here would be the category error this pass's
whole contract forbids; the layer that owns it is WF01 (`checkSoundness` — a node the flow never
reaches is a dead transition), plus S04 in the rule engine for the missing-incoming half and S07
for the missing-outgoing half. A node with an outgoing flow but no incoming one — a stranded
`parallelGateway` — used to be caught by neither S04 nor S07 and reported only by the opt-in WF01;
S04 now asks about incoming flows only and names it too, so the always-on rule layer covers it.
WF01 remains the exhaustive form of the same question (no path from the start event, rather than
no incoming edge). Both codes therefore fire only when
the Logic-Core actually gives the node an input (resp. an output) that the net does not have.
Measured over 4000 random rule-engine-clean processes, the unscoped codes produced 6601 NC02 and
6612 NC02b ERRORs across 3380 of 3983 nets — while NC01, NC03a, NC03b, NC04 and NC06 never fired
once, which is what identifies these two as the whole of the model-judging.

Three input sources count, not one, and the third is the one worth stating: an incoming sequence
flow; a start event's own scope source place (`p_source`, or a container's `p_C#source`); and **a
boundary event's host**. A boundary event has no incoming sequence flow by definition (OMG
§10.4.4), so a naive "no incoming flow ⇒ not a finding" rule would exempt every boundary event and
blind NC02 to precisely the defect it was promoted to ERROR for. `net-check.test.js` carries the
regression test that fails if that clause is ever dropped.

NC04 became ERROR the same way, and for the same kind of reason. Its one legitimate cause was the
place-id scheme itself: a place used to be keyed on the node pair (`p_<src>_<tgt>`), so two flows
between the same two nodes — legal BPMN, and the everyday shape of a gateway with two conditions
leading to one consequence — collapsed onto a single place. The second flow's label overwrote the
first's, and the enumerated scenarios reported a decision the trace did not support. `namePlaces`
(`scripts/bpmn/workflow-net.js`) now gives each flow a place of its own, suffixing `#<k>` only
where the base id would otherwise recur, and publishes the edge→place map as `pn.placeOfEdge`.

**What NC04 checks after that change is narrower than the other codes, and worth being precise
about.** It reads `pn.placeOfEdge` and asks whether two distinct edges were assigned the same
place — it does not, and must not, re-derive the id from `source`/`target`, because re-deriving
would report every legal parallel pair as a collision. But that makes it an assertion of
`namePlaces`' own invariant ("distinct edges never share a place id") against `namePlaces`' own
output, rather than a comparison of the net against the Logic-Core the way NC01, NC03a and NC03b
are. Under
the current naming rule it therefore cannot fire on a net `bpmnToPN` produced — by construction,
which is the point. It is a regression fence on the invariant, kept at ERROR because any future
naming rule that breaks the invariant must fail loudly rather than degrade a diagram quietly, and
its value lives entirely in the vacuity test in `scripts/bpmn/net-check.test.js` that forces a
collision into the map and requires the code to fire. NC06's edge-derived shape (b) is a fence of
the same kind and was already one before this change.

**NC06 covers duplicate NODE ids, not duplicate edge ids, and that boundary is deliberate.** A
duplicate node id really is a translation defect: `transitions` is keyed `t_<node.id>` and
`buildContainer` mints one `p_<C>#source`/`p_<C>#sink` pair per container id, so the second node
overwrites the first and the net ends up with one transition where the model has two nodes —
NC06's message, "the net can only represent one of them", is literally true. A duplicate *edge* id
is a different thing: `namePlaces` keys places `p_<src>_<tgt>[#k]` and `pn.placeOfEdge` is keyed by
edge **object identity**, so two edges sharing an id get two places and two sets of arcs. Nothing
is overwritten, the net is a correct model of the Logic-Core, and NC06's message would be false.
Reporting it here would be exactly the category error the NC02/NC02b scoping above was performed
to remove — a Petri-net guard making a claim about XML serialisation.

Duplicate edge ids are nonetheless invalid BPMN (`xsd:ID` is document-wide unique), and the layer
that owns them detects them precisely: re-parsing the generated XML through bpmn-moddle reports
`duplicate ID <…>` in `validation.xmlWarnings`. **That one class of serialisation warning is
unconditionally fatal on the CLI's generate path** — no files written, exit 1, `--strict` or not —
because a document-wide-unique violation does not degrade the file, it makes it unloadable. The
rest of the `xmlWarnings` channel (`unknown attribute <…>` and friends) stays non-fatal outside
`--strict`. So both halves of the class block: node ids via NC06, flow ids via this gate, each in
the layer that can actually make a true statement about them.

`runPipeline` itself is unaffected — it is a library function and still returns the XML plus the
warning. The gate is the CLI's.

NC05 is disclosure, not a defect: van der Aalst's WF-nets require a single source, and OMG BPMN
2.0.2 §10.4.2 treats multiple start events as alternative instantiations of the same process, so
normalising them onto one source place with several consumers is standard, not a translation bug.
It stays INFO on purpose — a reader should be told, not warned.

`ok` means "no ERROR-severity finding" — the same convention as BPMN's DI01–DI06 and DMN's
DD01–DD03 above.

---

## POST /api/v1/validate

Validate Logic-Core against the rule engine without generating output.

**Request:** `{ "logicCore": {...}, "mode": "optimize", "correlationId": "uuid", "clientId": "my-app" }`

`mode` (optional) — `"document"` (default) or `"optimize"`; in optimize mode `validation` gains `advisories` + `metrics.optimization`. `advisories` object shape: see `/api/v1/generate` above.

**Response 200:**
```json
{ "correlationId": "uuid", "status": "success", "validation": { "errors": [...], "warnings": [...], "advisories": [...], "metrics": {} } }
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
  "mode": "optimize",
  "correlationId": "uuid",
  "clientId": "my-app"
}
```
- One of `userText` or `logicCore` is required.
- `mode` (optional) — `"document"` (default) or `"optimize"`/`"soll"`; optimize mode adds `validation.advisories` + `metrics.optimization` to the response.
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
  "diagnostics": { "ok": true, "issues": [] },
  "compliance": { "isCompliant": true, "errors": [], "warnings": [], "infos": [], "violations": [] },
  "history": [ { "agent": "modeler", "phase": "extract", ... } ],
  "iterations": 1
}
```
`diagnostics` is populated once layout has run; see "validation vs. diagnostics" under `/api/v1/generate` above — this endpoint's `status` does not currently flip to `"diagram_error"`, so a caller that only checks `status` should also check `diagnostics.ok`.

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
