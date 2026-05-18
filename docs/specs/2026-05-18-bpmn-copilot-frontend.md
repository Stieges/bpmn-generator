# BPMN Copilot Frontend — Implementation Brief

> **For the implementing LLM session:** This document is self-contained. You don't need to read the rest of the repo to build this, but you should reference the files listed under "Existing assets" to understand the data shapes you'll be working with. The repo this lives in already implements the backend (`scripts/http-server.js`, `scripts/orchestrator.js`, `scripts/schema-gate.js`) — your job is the frontend that consumes it.

**Date:** 2026-05-18
**Status:** Spec only — no implementation has started
**Phase:** v3.5b Showcase + Demo / Phase 1 (BPMN). DMN is explicitly Phase 2 and out of scope here.

---

## 1. Context & Goal

The BPMN Generator backend ([Stieges/bpmn-generator](https://github.com/Stieges/bpmn-generator)) converts natural-language process descriptions into OMG-compliant BPMN 2.0.2 XML via a Node.js pipeline. It already exposes an HTTP API and an MCP server.

**This spec describes a frontend** — a local-running BPMN editor with an LLM-powered text-to-diagram chat. It is meant for **internal company demos**, distributed via **opencode desktop**: a colleague installs opencode, clones the repo, opens it in opencode, and runs the demo locally on their own machine with their own API key.

**Core user flow:**
1. Clone repo
2. Open in [opencode desktop](https://opencode.ai/download)
3. opencode reads `AGENTS.md`, sees the demo command, runs `npm run demo`
4. Backend (existing Node `http-server.js`) starts and serves the frontend at `localhost:3000`
5. Browser opens automatically
6. User clicks a pre-loaded example → BPMN renders immediately
7. (Optional) User clicks "Custom Text" tab → modal: *"Paste your OpenAI API key"* → paste → save (localStorage)
8. User types "Order processing workflow with approval gateway" → LLM generates Logic-Core → pipeline produces BPMN → renders in the editor
9. User can edit nodes/edges in the bpmn-js modeler; edits are tracked via telemetry to `audit.jsonl`
10. User downloads the `.bpmn` file

**Maximally simple** is a hard requirement: minimize setup steps, minimize cognitive load.

---

## 2. Tech Stack Recommendation

**Default: Vanilla HTML + ES Modules + bpmn-js from CDN, served by the existing Node `http-server.js`. Zero build step.**

Rationale:
- No `npm run build` required — colleagues don't need to wait for bundling
- Backend (Node) already runs and can serve the frontend on the same port (no CORS concerns, same-origin)
- bpmn-js is the official `bpmn.io` library; it works in any environment and provides both the viewer and the full modeler
- Telemetry state is a flat append-only event log — vanilla JS handles this fine
- React/Vite is acceptable if you have a strong reason (e.g., you find the state management painful), but you must keep the user-visible setup to one command. If you go React+Vite, the build output must be served by the Node backend, not a separate Vite dev-server in production.

**Allowed deps (vanilla path):**
- `bpmn-js` (CDN: `https://unpkg.com/bpmn-js@latest/dist/`) — full Modeler for editing
- `mermaid` (CDN: `https://cdn.jsdelivr.net/npm/mermaid@latest/dist/mermaid.esm.min.mjs`) — for fast previews (see §7.5)
- Nothing else. No jQuery, no Tailwind CDN unless you really need it.

**Allowed deps (React+Vite path, if you choose):**
- `react`, `react-dom`, `vite`, `bpmn-js`, `bpmn-js/lib/Modeler`. Add Tailwind if you want fast styling. Avoid heavy state libraries — Zustand or React-Query are fine if needed.

---

## 3. Repo Structure (where to put files)

```
bpmn-generator/                       (existing repo root)
├── frontend/                         ← NEW, your domain
│   ├── index.html                    Single-page entry
│   ├── app.js                        Main JS (ES Modules)
│   ├── styles.css                    Or inline; keep small
│   ├── examples/                     Pre-loaded fixtures (copied from tests/fixtures at build time, OR symlinked)
│   │   ├── simple-approval.json
│   │   ├── multi-pool-collaboration.json
│   │   ├── sparse-lanes.json
│   │   └── expanded-subprocess.json
│   └── README.md                     Brief: how to dev-cycle this
├── scripts/
│   ├── http-server.js                EXISTS — extend with `GET /` route serving frontend/index.html (see §5)
│   ├── orchestrator.js               EXISTS — frontend calls /api/v1/orchestrate which uses this
│   ├── schema-gate.js                EXISTS
│   ├── audit.js                      EXISTS — extend with frontend-edit events (see §8)
│   └── ...
└── package.json                      Add `"demo": "node scripts/http-server.js"` if not present
```

**Do not** create a separate Node project under `frontend/`. The frontend is static files served by the existing Node backend. One `package.json`, one process.

---

## 4. Setup & Commands

### What opencode will see in `AGENTS.md` (you should add this to the existing `AGENTS.md` if it exists, or create one):

```markdown
## Demo

Run the BPMN Copilot demo:

```bash
cd scripts
npm install   # one-time, ~30s
npm run demo
```

This starts the HTTP server on `http://localhost:3000` and serves the frontend.
Open your browser to that URL.

### API key

For the LLM chat to work, you need an OpenAI-compatible API key. The frontend will
prompt you for it when you first click "Custom Text". The key is stored in
`localStorage` (browser only — never sent to disk on the server side).

If you prefer to pre-configure the key, set `OPENAI_API_KEY` in your shell before
running `npm run demo`. The frontend will detect this and skip the modal.

### Pre-loaded examples

Click any of the four example cards on the start screen — no key needed. The
BPMN is pre-generated and rendered instantly.
```

### What `npm run demo` actually does

Add to `scripts/package.json` if not present:

```json
"scripts": {
  "demo": "node http-server.js",
  ...
}
```

The existing `http-server.js` runs on PORT 3000 by default. You'll extend it (see §5) to also serve static files from `frontend/`.

---

## 5. Backend Changes Required

You will need to make **three small backend changes** to `scripts/http-server.js`:

### 5.1. Serve static frontend files

Add a `GET /` route and a `GET /static/*` route that serves files from `frontend/`. Pattern:

```javascript
import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendDir = join(__dirname, '..', 'frontend');

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

// In the createServer handler, BEFORE the API routes:
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
```

### 5.2. Add a `/api/v1/telemetry` endpoint

Append to `audit.jsonl` via the existing `auditLog` helper. Body shape:

```json
{
  "event": "modeler.shape.added | modeler.shape.changed | modeler.shape.removed | modeler.connection.added | modeler.label.changed | session.start | session.end | llm.generated",
  "correlationId": "<uuid generated by frontend on app load>",
  "diagramId": "<uuid per loaded/created diagram>",
  "details": { ... event-specific ... }
}
```

Backend route:

```javascript
if (url === '/api/v1/telemetry' && method === 'POST') {
  try {
    const body = await parseBody(req);
    auditLog({ event: 'frontend_event', ...body, ts: new Date().toISOString() });
    return json(res, 200, { status: 'ok' });
  } catch (err) {
    return json(res, 400, { error: err.message });
  }
}
```

No schema gate for this endpoint (loose by design — telemetry is best-effort).

### 5.3. Optional fallback: read `OPENAI_API_KEY` for users who set it

In `/api/v1/orchestrate`, if `body.llmConfig` is missing AND `process.env.OPENAI_API_KEY` is set, construct a default `llmConfig`:

```javascript
if (!body.llmConfig && process.env.OPENAI_API_KEY) {
  body.llmConfig = {
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  };
}
```

This lets power-users skip the UI modal entirely.

---

## 6. Frontend Feature List

### 6.1. Start screen

Four cards, one per pre-loaded example:

| Card | Source | Description |
|---|---|---|
| Simple Approval | `examples/simple-approval.json` | Linear flow + exclusive gateway |
| Multi-Pool Collaboration | `examples/multi-pool-collaboration.json` | Two pools, message flows — the differentiator |
| Multi-Lane Pool | `examples/sparse-lanes.json` | One pool, four lanes |
| Expanded SubProcess | `examples/expanded-subprocess.json` | Nested process |

Each card clickable → loads the example into the editor (see §6.3). No LLM call required.

Below the cards: a "Custom Text" button or a textarea (your choice) for the LLM flow.

### 6.2. Custom Text flow

1. User clicks "Custom Text" or types in a textarea
2. If `localStorage.openai_api_key` is missing AND backend didn't pre-fill via env, show modal:
   ```
   ┌──────────────────────────────────────────┐
   │ OpenAI-compatible API key                │
   │                                          │
   │ Paste your key. It's stored only in your │
   │ browser (localStorage) and sent to your  │
   │ local backend on each generate call.     │
   │                                          │
   │ [ sk-...                          ]      │
   │                                          │
   │ Base URL (optional, default OpenAI):     │
   │ [ https://api.openai.com/v1       ]      │
   │                                          │
   │ Model: [ gpt-4o-mini              ]      │
   │                                          │
   │      [ Cancel ]      [ Save & Use ]      │
   └──────────────────────────────────────────┘
   ```
3. User clicks Save → write to localStorage → close modal
4. Frontend POSTs `/api/v1/orchestrate` with body:
   ```json
   {
     "userText": "<user input>",
     "llmConfig": {
       "baseUrl": "<from localStorage or default>",
       "apiKey": "<from localStorage>",
       "model": "<from localStorage or 'gpt-4o-mini'>"
     }
   }
   ```
5. Show loading state (spinner with "Generating diagram...")
6. On response: load the returned `bpmnXml` into the modeler (see §6.3)
7. On schema_error / 4xx / 5xx: show error toast with the response message

### 6.3. BPMN Modeler view

Use `bpmn-js/lib/Modeler` (the full editor, NOT the viewer). Documentation: https://github.com/bpmn-io/bpmn-js-examples

Required features:
- Modeler attached to a `<div id="canvas">`
- Imports BPMN XML via `await modeler.importXML(xml)`
- Provides built-in palette (left side), context-pad (on shape select), property-panel — all default bpmn-js behavior. Don't customize.
- "Download .bpmn" button — calls `await modeler.saveXML({ format: true })` and triggers browser download
- "Download .svg" button — calls `await modeler.saveSVG()` and triggers browser download

Edit detection (for telemetry, see §7):
```javascript
const eventBus = modeler.get('eventBus');
eventBus.on('commandStack.shape.create.postExecuted', (e) => sendTelemetry('modeler.shape.added', { shapeType: e.context.shape.type, id: e.context.shape.id }));
eventBus.on('commandStack.shape.move.postExecuted', (e) => sendTelemetry('modeler.shape.moved', { id: e.context.shape.id }));
eventBus.on('commandStack.connection.create.postExecuted', (e) => sendTelemetry('modeler.connection.added', { source: e.context.source.id, target: e.context.target.id }));
eventBus.on('commandStack.element.updateLabel.postExecuted', (e) => sendTelemetry('modeler.label.changed', { id: e.context.element.id }));
```

`sendTelemetry()` POSTs to `/api/v1/telemetry` with the event payload plus `correlationId` and `diagramId`.

---

## 7. Backend API Contract (existing — your reference)

### `POST /api/v1/orchestrate`

**Body** (one of `userText` or `logicCore` is required):

```json
{
  "userText": "Order processing with manager approval",
  "logicCore": { ... },                              // optional, schema in references/input-schema.json
  "llmConfig": {                                     // required when userText is given, ignored when only logicCore
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "model": "gpt-4o-mini",
    "timeout": 120000                                // optional, default 120s, max 300s
  },
  "ruleProfile": "rules/strict-profile.json",        // optional
  "maxReviewIterations": 3,                          // optional, default 3
  "maxLayoutIterations": 2,                          // optional, default 2
  "correlationId": "<uuid>",                         // optional, generated by server if missing
  "clientId": "demo-frontend"                        // optional, recorded in audit
}
```

**Response (200)**:

```json
{
  "correlationId": "uuid",
  "status": "success",
  "logicCore": { ... },
  "bpmnXml": "<?xml...",                             // ← what you load into bpmn-js
  "svg": "<svg...",                                  // ← what you can use for the start-screen example previews
  "validation": { "errors": [], "warnings": [...] },
  "compliance": { "isCompliant": true, ... },
  "history": [ { "agent": "modeler", "phase": "extract", ... } ],
  "iterations": 1
}
```

**Error responses**:
- `400 { "status": "schema_error", "errors": [...] }` — schema-strict gate rejected the Logic-Core
- `400 { "error": "..." }` — generic validation error (e.g., missing llmConfig)
- `429 { "error": "Rate limit exceeded" }` — 30 req/min per IP (existing limit)
- `500 { "status": "internal_error", "error": "..." }` — orchestrator threw

### `POST /api/v1/telemetry` (you will add)

See §5.2. Returns `200 { "status": "ok" }`. Loose schema.

### Existing endpoints you should know but not need

- `POST /api/v1/generate` — Logic-Core JSON → BPMN. Lower-level than orchestrate.
- `POST /api/v1/validate` — Run only the rule engine.
- `POST /api/v1/import` — BPMN XML → Logic-Core.
- `GET /health` — liveness probe.

---

## 7.5. Preview Strategy — Mermaid for fast preview, bpmn-js for editor

User has explicitly requested **Mermaid as the preview mechanism** because it's fast to render and lightweight (single small JS library, no XML parsing).

Two places Mermaid is used:

### 7.5.1 Start-screen example cards
Each card shows a Mermaid `flowchart LR` rendering of the example's logical structure. Hand-write the Mermaid string once per example (4 strings total). Do NOT try to derive it from Logic-Core JSON at render time — that's wasted complexity for static cards. Example:

```javascript
// frontend/examples/previews.js
export const PREVIEWS = {
  'simple-approval': `flowchart LR
    A((Start)) --> B[Submit]
    B --> C{Approved?}
    C -->|Yes| D[Process]
    C -->|No| E[Reject]
    D --> F((End))
    E --> F`,
  'multi-pool-collaboration': `...`,
  ...
};
```

Render with `mermaid.render(id, str).then(({svg}) => container.innerHTML = svg)`.

### 7.5.2 Live preview during LLM generation (optional, recommended)

When user submits Custom Text:
1. Show a Mermaid preview area, initially empty
2. POST to `/api/v1/orchestrate` 
3. While waiting (the orchestrate call can take 5-30 seconds), show a Mermaid skeleton or "thinking..." placeholder
4. On 200 response: parse `result.logicCore` → derive Mermaid flowchart → render in preview area (fast)
5. Then load `result.bpmnXml` into bpmn-js Modeler (slower, full editor)

The Mermaid preview gives the user visual feedback as fast as possible after the LLM responds, while bpmn-js takes its time to set up. The Mermaid preview can fade out or be replaced once the bpmn-js Modeler is ready.

To convert Logic-Core → Mermaid: walk nodes (events as `((id))`, gateways as `{id}`, tasks as `[id]`) and edges as `-->`. ~30 lines of code, can be hand-written or you can ask the implementing LLM session to write this converter as a 5-minute side task. Don't add a dependency for it.

If the implementing LLM finds this too much for v1, they can skip the live preview and just go straight to bpmn-js loading. The example cards (7.5.1) are the must-have; live preview is the should-have.

### 7.5.3 Mermaid dependency

CDN: `https://cdn.jsdelivr.net/npm/mermaid@latest/dist/mermaid.esm.min.mjs` — load as ES Module. Initialize once at app start: `mermaid.initialize({ startOnLoad: false, theme: 'default' })`.

---

## 8. Telemetry Specification

### Event types

| Event | When | Details |
|---|---|---|
| `session.start` | App loads, after correlationId is generated | `{ userAgent, viewport: {w, h} }` |
| `example.loaded` | User clicks a pre-loaded example | `{ exampleId: "simple-approval" }` |
| `llm.requested` | User clicks Generate on Custom Text | `{ userTextLength, model }` (do NOT log full text — privacy) |
| `llm.generated` | Orchestrate returned 200 | `{ durationMs, nodeCount, edgeCount, iterations }` |
| `llm.failed` | Orchestrate returned non-2xx | `{ status, errorClass }` (omit message body) |
| `modeler.shape.added` | User adds a node via palette | `{ shapeType, id }` |
| `modeler.shape.moved` | User drags a shape | `{ id }` (no coords; we want intent, not pixels) |
| `modeler.shape.removed` | User deletes | `{ id, shapeType }` |
| `modeler.connection.added` | User draws an edge | `{ source, target }` |
| `modeler.connection.removed` | User deletes an edge | `{ source, target }` |
| `modeler.label.changed` | User edits a label | `{ id }` (no label text — privacy) |
| `download.bpmn` | User clicks "Download .bpmn" | `{}` |
| `download.svg` | User clicks "Download .svg" | `{}` |
| `session.end` | `beforeunload` event | `{ durationMs }` |

### Storage

Backend appends each event as a JSONL line to `<os.tmpdir>/bpmn-generator/audit/bpmn-generator.jsonl` (existing path). The `frontend_event` wrapper makes it filterable.

To share telemetry data with the project maintainer, the user manually attaches the file. No auto-upload.

### Privacy notes

- Never log user text content (LLM prompts).
- Never log label text from edits.
- API keys: never logged (they're not in the telemetry body).
- IDs are bpmn-js internal IDs (e.g., `Activity_0abc123`); not personal data.

### 8.x. Long-term: data must flow back to the maintainer

This is **strategically critical** per the user: *"Long-term, the edits AFTER generation of the model must be tracked and flow back to us so we can learn from it."*

The whole point of Phase 1 telemetry is to capture **how users iterate on LLM output**: which generated nodes they delete, which ones they re-label, which connections they add, which moves they make. This is the feedback signal for tuning the LLM and the prompt template. Without this, the demo is just a demo — with it, it's a training-data collection pipeline.

**Phase 1 (this PR):** local-only audit.jsonl. User shares the file manually if asked. Establishes the event schema.

**Phase 1b (next iteration, separate PR):**
- "Share telemetry" button in the Settings modal
- Clicking it: POST audit.jsonl content to a configurable remote endpoint (`process.env.TELEMETRY_UPLOAD_URL`) — default `null` (no upload)
- The remote endpoint is the maintainer's responsibility to set up (GitHub Issue webhook, dedicated server, S3 presigned upload — TBD)
- The button shows the upload size beforehand so the user can verify before sending
- Anonymization happens client-side before upload: strip the diagramId-to-content mapping, keep only the event sequence

**Phase 2 (production-grade):**
- Automated periodic upload (with user opt-in at first launch)
- Server-side aggregation pipeline
- Dashboard for the maintainer showing edit patterns
- Integration with the existing `evaluate-slm.js` to track which prompts produce diagrams users barely edit (= good) vs heavily edit (= room for improvement)

**For the implementing LLM session:**
- Design the event schema (§8 above) to be append-only and stable. Future Phase 1b will literally POST the same JSONL up; don't change field names later.
- Make the audit-log path accessible via `/api/v1/telemetry/export` (read-only GET that returns the current `audit.jsonl` content). This unblocks Phase 1b without needing further backend changes.
- Include a `version: "1.0"` field in the telemetry envelope so future schema migrations are detectable.

---

## 9. UI Sketch

```
┌──────────────────────────────────────────────────────────────┐
│ BPMN Copilot    [Stieges/bpmn-generator]    [Settings ⚙]    │  ← Top bar
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Quick start:                                                │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ │
│  │ Simple     │ │ Multi-Pool │ │ Multi-Lane │ │ SubProcess │ │  ← Example cards
│  │ Approval   │ │ Collab.    │ │ Pool       │ │            │ │
│  │  [SVG]     │ │  [SVG]     │ │  [SVG]     │ │  [SVG]     │ │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘ │
│                                                              │
│  Custom:                                                     │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Describe your process... (text area, 3-4 rows)         │  │
│  │                                                        │  │
│  └────────────────────────────────────────────────────────┘  │
│       [ Generate diagram → ]                                 │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

After a diagram loads:

```
┌──────────────────────────────────────────────────────────────┐
│ ← Back   |   Simple Approval        [Download .bpmn] [.svg]  │
├──────────────────────────────────────────────────────────────┤
│ [bpmn-js Modeler canvas — left palette, context pad, etc.]   │
│                                                              │
│  ╔════════════════════════════════════════════════╗          │
│  ║   [Customer Pool]                              ║          │
│  ║   ( ) → [Submit] → [Wait] → ( )                ║          │
│  ╚════════════════════════════════════════════════╝          │
│  ╔════════════════════════════════════════════════╗          │
│  ║   [Service Department]                         ║          │
│  ║   ...                                          ║          │
│  ╚════════════════════════════════════════════════╝          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

Settings cog opens the API key modal at any time (also resettable from there).

---

## 10. Acceptance Criteria

A reviewer who has never seen this project should be able to:

1. Install opencode desktop from https://opencode.ai/download
2. `git clone` the repo
3. Open the repo folder in opencode desktop
4. Type "start the demo" → opencode runs `cd scripts && npm install && npm run demo`
5. See the browser open at `http://localhost:3000`
6. Click "Multi-Pool Collaboration" example → see a rendered BPMN with two pools, three lanes, message flows
7. Click "Custom Text" tab → paste API key → save
8. Type "Order processing with manager approval and email notification" → click Generate
9. See a generated BPMN appear in the editor (under 15 seconds for a small process)
10. Drag a node around → see the edit reflected in `<os.tmpdir>/bpmn-generator/audit/bpmn-generator.jsonl`
11. Click Download .bpmn → file appears in browser downloads

**Performance budget:**
- App load to first paint: < 1s on a modern laptop
- Pre-loaded example render: < 200ms after click
- LLM generate: bound by user's API provider (no frontend optimization needed beyond a loading state)

**Test coverage requirement:** at minimum, a Playwright (or similar) smoke test that does steps 6 + 9 + 11. Place in `frontend/test/`.

---

## 11. Out of Scope (Phase 2 or later)

- **DMN support** — separate backend work (dmn-core JSON schema, dmn-js integration, FEEL expression handling). The user has explicitly deferred this. Do not add `dmn-js` imports or DMN routes in Phase 1.
- **User accounts / login** — single-user local demo. No auth, no sessions, no databases beyond the existing `audit.jsonl`.
- **Hosted deployment** — Vercel / Cloudflare / cloud hosting are NOT in scope. The demo only runs locally via opencode desktop.
- **Custom themes / dark mode** — keep visuals neutral (light theme, bpmn.io defaults). Polish later.
- **Multi-language i18n** — English UI is enough. The LLM backend already handles German prompts internally.
- **Persistent diagram storage** — the user can download `.bpmn`/`.svg`; we don't need to save in-app.
- **Real-time collaboration** — not relevant for local demos.

---

## 12. Open Decisions for the Implementer

These were not pinned down in this spec — make a defensible call and document why in your `frontend/README.md`:

1. **Vanilla vs React** — default is vanilla; switch to React if you find the editor state management or settings modal painful. If you switch, ensure `npm run demo` still works without an explicit dev-server (build into `frontend/dist/` and serve from there).
2. **Settings modal styling** — your call. Either system-native `<dialog>` element or a custom div with backdrop. No third-party modal library.
3. **Toast/notification library** — not allowed. Use a single `<div>` with conditional rendering.
4. **Pre-loaded example previews** — option A: load the static SVG (`docs/screenshots/01-simple-approval.svg` from the repo); option B: load the `.bpmn` into a mini bpmn-js Viewer per card. Option A is simpler and faster; recommended unless you want the cards to be interactive.
5. **`generate diagram` button vs `Enter to submit`** — your call. Many users expect both.

---

## 13. Existing Assets You'll Use

- **`tests/fixtures/*.json`** — Logic-Core input JSON. Copy 4 (simple-approval, multi-pool-collaboration, sparse-lanes, expanded-subprocess) into `frontend/examples/`.
- **`tests/fixtures/*.expected.bpmn`** — Pre-generated BPMN XML. You can use these as fallback if the user clicks an example without waiting for the backend to re-generate.
- **`tests/fixtures/*.expected.svg`** — Pre-rendered SVG previews for the example cards (option A in §12.4).
- **`docs/screenshots/`** — Same SVGs, named differently. Either location works.
- **`references/input-schema.json`** — Logic-Core JSON Schema (you don't need to use this directly; the backend validates, but useful for understanding the data shape).
- **`scripts/orchestrator.js`** — read for understanding what the backend does with `userText`. You don't modify this.
- **`SECURITY.md`** — security defaults of the existing backend. Worth a glance.

---

## 14. Suggested Implementation Sequence

If you're doing this in a single session, suggested order to minimize rework:

1. Add `GET /` route to `http-server.js` (serves `frontend/index.html`)
2. Create `frontend/index.html` with a single "Hello BPMN" placeholder, verify `localhost:3000` shows it
3. Add `GET /static/*` route and load bpmn-js Modeler from a static JS file
4. Implement the start screen (4 example cards) — clicking loads the `.bpmn` directly from `examples/`
5. Implement the Custom Text path — settings modal, localStorage, POST to `/api/v1/orchestrate`
6. Add `/api/v1/telemetry` endpoint and wire the modeler event listeners
7. Add Download .bpmn / .svg buttons
8. Write the Playwright smoke test
9. Update `AGENTS.md` with the demo instructions
10. Update the existing `README.md` to point at this demo

---

**End of brief.** If anything in this spec is ambiguous or contradicts what you discover in the existing code, raise it before improvising. The user's preference is "ask, don't guess."
