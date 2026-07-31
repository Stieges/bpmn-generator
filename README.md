# BPMN Generator

[![CI](https://github.com/Stieges/bpmn-generator/actions/workflows/ci.yml/badge.svg)](https://github.com/Stieges/bpmn-generator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

BPMN 2.0 diagram generator — converts natural language process descriptions or structured JSON into OMG-compliant BPMN 2.0.2 XML files and SVG previews (ISO/IEC 19510:2013). Also generates DMN 1.3 decision models (opt-in, see [DMN Support](#dmn-support-opt-in)).

## Why this one

Three things you can verify in the repo, not just claim:

1. **Multi-pool collaborations with lanes and message flows render fully.** The closest open-source comparable (`bpmn-auto-layout@1.3.0`, used by [BPMN Assistant](https://github.com/jtlicardo/bpmn-assistant)) silently drops every participant after the first plus all inter-pool message flows ([data](EVALUATION.md#bpmn-auto-layout-comparison)). Our pipeline renders all participants and all message flows.
2. **Strict JSON Schema gate at every HTTP API entry.** LLM output cannot reach the layout engine with malformed Logic-Core — `ajv` draft-2020-12 rejects it at the boundary ([scripts/bpmn/schema-gate.js](scripts/bpmn/schema-gate.js)).
3. **Native Claude Code MCP server.** Exposed as a [Skill](SKILL.md) and via [`scripts/mcp-bpmn-server.js`](scripts/mcp-bpmn-server.js). The LLM never touches coordinates — it emits Logic-Core JSON, the pipeline handles layout deterministically.

Reproduce the comparison: `cd scripts && node bench/compare-bpmn-auto-layout.mjs` — produces [tests/bench/auto-layout-comparison.md](tests/bench/auto-layout-comparison.md) + side-by-side HTML.

See [EVALUATION.md](EVALUATION.md) for the full benchmark, the competitor matrix, and honest notes about where ProMoAI and BPMN Assistant are stronger.

### Visual examples

<table>
<tr>
<td width="50%"><a href="docs/screenshots/01-simple-approval.svg"><img src="docs/screenshots/01-simple-approval.svg" alt="simple approval workflow"></a><br><sub>Single-pool linear flow + exclusive gateway</sub></td>
<td width="50%"><a href="docs/screenshots/02-multi-pool-collaboration.svg"><img src="docs/screenshots/02-multi-pool-collaboration.svg" alt="multi-pool collaboration"></a><br><sub>Two pools, three lanes, message flows — what bpmn-auto-layout drops</sub></td>
</tr>
<tr>
<td><a href="docs/screenshots/03-multi-lane-pool.svg"><img src="docs/screenshots/03-multi-lane-pool.svg" alt="multi-lane single pool"></a><br><sub>One pool, four lanes (Frontend / Backend / Ops / QA)</sub></td>
<td><a href="docs/screenshots/04-expanded-subprocess.svg"><img src="docs/screenshots/04-expanded-subprocess.svg" alt="expanded subprocess"></a><br><sub>Expanded subprocess with inner activities</sub></td>
</tr>
</table>

Full gallery: [docs/screenshots/](docs/screenshots/). All SVGs regenerated from fixtures by the pipeline — they reflect current output, not stale marketing screenshots.

### How we compare (verified)

| Capability | This generator | ProMoAI | BPMN Assistant | BPMN-Chatbot |
|---|---|---|---|---|
| Multi-pool with lanes + message flows | **✅ verified** | ✅ | ❌ (bpmn-auto-layout limitation) | ? |
| Strict JSON Schema input gate (ajv) | **✅** | n/a | partial | partial |
| Soundness check | WF-Net (3 rules) | POWL by construction | none | none |
| Configurable rule engine | **34 rules, 5 layers, JSON profiles** | limited | none | none |
| MCP server | **✅** | ❌ | ❌ | ❌ |
| Stack | Node.js / ES Modules | Python / Streamlit | Python + Vue.js | React + OpenAI |
| License | MIT | GPL-3.0 | MIT-ish | unclear |
| Paper | none (engineering) | IJCAI-24, EMMSAD 2024 | arXiv 2509.24592 | CEUR-WS Vol-3758 |

Each ✅ on our row links back to a fixture, a benchmark, or a source file. See [EVALUATION.md](EVALUATION.md) for cell-by-cell evidence and honest notes on where competitors are stronger (ProMoAI's mathematical soundness guarantee, BPMN Assistant's web UI).

## What It Does

You describe a business process — either as free text or as a structured JSON (Logic-Core) — and the generator produces:

- A **BPMN 2.0 XML file** (.bpmn) that opens in [bpmn.io](https://bpmn.io), Camunda Modeler, or any standard-compliant tool
- An **SVG preview** with all BPMN symbols, lanes, pools, and edge routing
- A **validation report** covering structural correctness, naming conventions, and complexity metrics

The output is structurally valid and OMG-compliant. It handles pools, lanes, gateways, boundary events, sub-processes, message flows, and loop markers correctly — things that LLMs typically get wrong when generating BPMN XML directly.

### Realistic Expectations

This tool produces a **solid first draft**, not a finished diagram. Expect to refine:

- **Layout** — Auto-layout handles most cases well (happy-path alignment, orthogonal routing, lane partitioning), but complex processes with many cross-lane edges or feedback loops may need manual adjustment in a BPMN editor
- **Labels & naming** — The LLM generates reasonable names, but domain-specific terminology may need correction
- **Edge cases** — Unusual gateway patterns, deeply nested sub-processes, or very large diagrams (30+ activities) can produce suboptimal visual results
- **Business logic** — The generator models what you describe; it doesn't validate whether your process makes business sense

Think of it as going from **0% → 80%** in seconds. The remaining 20% is domain expertise that requires human judgment.

## Pipeline

```
User Text → [Phase 1] Intent Extraction (LLM → JSON Logic-Core)
          → [Phase 2] Validation (34 rules, 5 layers, deadlock detection)
          → [Phase 3] Auto-Layout (ElkJS Sugiyama layered algorithm)
          → [Phase 4] Serialization → BPMN 2.0 XML + SVG
```

The LLM **never** handles coordinates. Layout is 100% algorithmic.

## Quick Start

```bash
cd scripts/
npm install          # installs runtime + dev dependencies (Node >=20)

# Generate from JSON Logic-Core:
node bpmn/pipeline.js my-process.json my-process

# From stdin:
echo '{ ... }' | node bpmn/pipeline.js - output

# Import existing BPMN:
node bpmn/import.js existing.bpmn extracted.json

# DOT export (Graphviz):
node bpmn/pipeline.js my-process.json my-process --dot

# DOT import → Logic-Core JSON:
node bpmn/pipeline.js graph.dot output --import-dot

# Run tests:
npm test
```

**Output:** `output.bpmn` (BPMN 2.0 XML) + `output.svg` (vector preview)

## Usage as Claude Code Skill

### In a specific project

Copy `SKILL.md` to `.claude/skills/operative/bpmn-prozess-erstellen.md` and adjust the relative paths for `references/` and `scripts/` to match where you placed those directories.

### As a portable .skill file

`cd scripts && npm run build:skill` produces `bpmn-generator-v3.skill` at the repo root (gitignored
— rebuild on demand, not committed). The ZIP can be shared with other projects and contains
everything needed:
- `SKILL.md` — Skill definition
- `references/` — Schema, prompt templates, inline template
- `scripts/` — Pipeline modules, import.js, package.json

## Module Architecture

```
scripts/
├── bpmn/               Core BPMN pipeline (runs on every generate call)
│   ├── pipeline.js     Orchestrator + CLI (public API: runPipeline)
│   ├── validate.js     Validation wrapper → rules.js
│   ├── rules.js        Rule engine (34 rules, 5 layers, profile support) — see `references/fachliches-regelwerk.md`
│   ├── optimize.js     Optimization Advisory layer (O01-O04, opt-in via optimize/soll mode)
│   ├── topology.js     Gateway directions, topological sort, lane ordering
│   ├── layout.js       ELK graph construction + layout execution
│   ├── coordinates.js  Coordinate maps, edge clipping, pool equalization
│   ├── di-check.js     Post-layout diagram integrity pass (DI01-DI06)
│   ├── bpmn-xml.js     BPMN 2.0 XML generation (DI, top-level defs)
│   ├── svg.js          SVG rendering (pools, lanes, activities, events)
│   ├── icons.js        Event markers, task icons, bottom markers
│   ├── dot.js           DOT export (Logic-Core → Graphviz) + import
│   ├── types.js         Type predicates, BPMN XML tag mapping
│   ├── import.js         BPMN XML → Logic-Core (DOM parser)
│   ├── moddle-import.js  BPMN XML → Logic-Core (bpmn-moddle path)
│   └── redesign*.js      Deterministic redesign toolbox (5 transforms, CLI-driven, opt-in)
├── dmn/                DMN 1.3 pipeline (opt-in, not reached by runPipeline)
│   ├── pipeline.js      Orchestrator + CLI (public API: runDmnPipeline)
│   ├── schema-gate.js    ajv gate for Decision-Core input
│   ├── rules.js          DMN rule engine (17 rules, 3 layers, 2 modes)
│   ├── layout.js          DRD ELK layout (decisionCoreToElk, runDmnElkLayout)
│   ├── coordinates.js      DRD coordinate mapping (buildDmnDiagrams)
│   ├── di-check.js          Diagram integrity check (DD01-DD03)
│   └── dmn-xml.js            DMN 1.3 XML + DMNDI generation via dmn-moddle
├── shared/             Format-independent core, used by both bpmn/ and dmn/
│   ├── utils.js          Config loader, visual constants, helpers
│   ├── rule-profile.js    Profile machinery shared by both rule engines
│   ├── resource-paths.js  Where references/ lives in each layout
│   └── geometry.js        Straight-segment clip maths (clipStraight, clipToRect)
├── agents/             Multi-agent orchestration
│   ├── modeler.js       LLM-powered: text→JSON, refine, amend
│   ├── reviewer.js       Deterministic: validateLogicCore() wrapper
│   ├── layout.js          runPipeline() + optional vision review
│   ├── compliance.js       Deterministic: runRules() gate
│   └── llm-provider.js      OpenAI-compatible fetch abstraction (cloud + local)
├── orchestrator.js    Multi-agent state machine + CLI
├── prepare-training-data.js  Training data ETL (BPMN→LC, filter, JSONL)
├── evaluate-slm.js     SLM evaluation (pipeline-based metrics)
├── mcp-bpmn-server.js  MCP server (4 tools)
├── http-server.js      HTTP API (8 endpoints)
├── config.json         Externalized constants (shapes, colors, gaps)
└── package.json        Runtime deps: elkjs, bpmn-moddle, dmn-moddle, @modelcontextprotocol/sdk, ajv, ajv-formats
```

Run `cd scripts && npm test` for the current test count (Jest, ES Modules) — it changes often enough
that a number here would go stale immediately; CI enforces it stays green.

**Dependency graph** (acyclic; `dmn/` never imports `bpmn/`, and vice versa):
```
shared/utils.js, shared/resource-paths.js ← (no deps)
shared/rule-profile.js ← shared/utils
shared/geometry.js ← (no deps)
bpmn/types.js ← (no deps)
bpmn/rules.js ← bpmn/types, bpmn/workflow-net, shared/rule-profile
bpmn/workflow-net.js ← bpmn/types
bpmn/validate.js ← bpmn/rules
bpmn/topology.js ← bpmn/types
bpmn/layout.js ← bpmn/types, shared/utils, bpmn/topology, elkjs
bpmn/coordinates.js ← bpmn/types, shared/utils, bpmn/topology, shared/geometry
bpmn/icons.js ← shared/utils
bpmn/bpmn-xml.js ← bpmn/types, shared/utils, bpmn/topology, bpmn/icons
bpmn/svg.js ← bpmn/types, shared/utils, bpmn/icons
bpmn/dot.js ← bpmn/types
bpmn/pipeline.js ← all of the above bpmn/ modules
dmn/schema-gate.js ← shared/resource-paths
dmn/rules.js ← shared/rule-profile, shared/utils
dmn/layout.js ← dmn/constants, shared/utils, elkjs
dmn/coordinates.js ← dmn/constants, shared/geometry
dmn/dmn-xml.js ← shared/utils, dmn/coordinates, dmn-moddle
dmn/pipeline.js ← all of the above dmn/ modules
```

## Repo Structure

```
bpmn-generator/
├── README.md                             This file
├── LICENSE                               MIT License
├── CHANGELOG.md                          Version history
├── CONTRIBUTING.md                       Contribution guide
├── THIRD-PARTY-NOTICES.md                Dependency licenses
├── SKILL.md                              Claude Code skill definition
├── CLAUDE.md                             Project instructions for Claude Code
├── ROADMAP.md                            Development roadmap (K0-K8, M1-M6, L1-L6)
├── COMPATIBILITY.md                      bpmn.io compatibility report
├── bpmn-generator-v3.skill               Portable ZIP archive (generated, gitignored — `npm run build:skill`)
├── .github/workflows/ci.yml             GitHub Actions CI
├── references/
│   ├── logic-core-schema.md              JSON schema documentation (prose)
│   ├── input-schema.json                 Formal JSON Schema (draft 2020-12)
│   ├── decision-core-schema.json         Formal JSON Schema for DMN Decision-Core input
│   ├── prompt-template.md                LLM prompt templates + few-shot patterns
│   ├── inline-template.md                HTML template for browser-side ElkJS
│   ├── fachliches-regelwerk.md           Rule documentation (authoritative catalog — per-rule source citations)
│   ├── omg-compliance.md                 OMG BPMN 2.0.2 compliance mapping
│   └── review-set/                       Test fixtures for visual review
├── rules/
│   ├── default-profile.json              Default BPMN rule profile (all layers active)
│   ├── strict-profile.json               Strict BPMN profile (warnings → errors)
│   ├── dmn-default-profile.json          Default DMN profile (soundness + semantics)
│   └── dmn-best-practice-profile.json    Adds the opt-in DMN best_practice layer
├── scripts/                              Pipeline modules (see above)
└── tests/
    └── fixtures/                         Test input files (JSON Logic-Core, DMN Decision-Core)
```

## Rule Engine

34 rules across 5 layers with configurable severity via JSON profiles (2 are registered as placeholders). The authoritative catalog lives in [`references/fachliches-regelwerk.md`](references/fachliches-regelwerk.md); this README does not duplicate per-rule descriptions.

| Layer | Severity | Rules | Examples |
|-------|----------|-------|----------|
| Soundness | ERROR | S01-S12 | Start/End events, deadlocks, boundary events |
| Style | WARNING | M01-M11 (M05/M06 severity=OFF) | Naming conventions, gateway labels |
| Pragmatics | INFO | P01-P03 | Complexity metrics |
| Workflow-Net | ERROR/WARNING | WF01-WF03 | Liveness, boundedness, deadlock-freedom (opt-in) |
| Optimization | ADVISORY | O01-O04 | Redesign opportunities — `optimize`/`soll` mode only (opt-in); each names a transform in the redesign toolbox |

```bash
# Default profile (all layers active):
node bpmn/pipeline.js input.json output

# Strict profile (style warnings → errors):
# (programmatic: runPipeline(lc, { ruleProfile: 'rules/strict-profile.json' }))
```

See `references/fachliches-regelwerk.md` for full rule documentation.

## Programmatic API

```javascript
import { runPipeline } from './pipeline.js';

const logicCore = { nodes: [...], edges: [...] };
const result = await runPipeline(logicCore);

// result.bpmnXml    — BPMN 2.0 XML string (or null on validation error)
// result.svg        — SVG string
// result.coordMap   — coordinate map
// result.diagnostics — post-layout DI integrity ({ ok, issues }) — separate from validation,
//                       since the rule engine never sees a coordinate
// result.validation — { errors, warnings, advisories, metrics, xmlWarnings }
//                       xmlWarnings comes from re-parsing the generated XML through bpmn-moddle —
//                       it is what --strict's serialization check gates on
```

Individual modules can be imported directly:

```javascript
import { validateLogicCore } from './validate.js';
import { generateBpmnXml } from './bpmn-xml.js';
import { generateSvg } from './svg.js';
import { logicCoreToDot, dotToLogicCore } from './dot.js';
```

## Features

- **Multi-pool collaborations** with message flows
- **All BPMN 2.0 task types** (User, Service, Script, Send, Receive, Manual, Business Rule)
- **Call Activity, Sub-Process, Transaction** with correct rendering
- **Expanded sub-processes** with inline children
- **Boundary events** (timer, error, message, signal, escalation — interrupting/non-interrupting)
- **All gateway types** with correct `gatewayDirection` (Diverging/Converging/Mixed)
- **Loop/multi-instance markers** (standard loop, parallel MI, sequential MI)
- **Data objects**, data stores, text annotations, groups, associations
- **Collapsed pools** (black-box participants)
- **Round-tripping** (BPMN XML → Logic-Core JSON → BPMN XML)
- **DOT format** (Graphviz export + import for visualization)
- **Inline mode** (browser-side ElkJS rendering without Node.js)
- **Configurable rule engine** (34 rules, 5 layers, JSON profiles — 2 registered as placeholders)
- **Redesign toolbox** (5 deterministic process transforms with preview/apply, no LLM — see below)
- **OMG BPMN 2.0.2 compliant** XML output (ISO/IEC 19510:2013)
- **BPMN-in-Color** (bioc: namespace — per-node fill/stroke in XML + SVG)
- **Documentation View** (SVG tooltips + `--doc` Markdown companion)
- **Happy-Path Y-Leveling** (post-layout alignment, configurable)
- **Visual Refinement Pass** (opt-in post-layout polish — see below)
- **MCP Server** (generate, validate, import as MCP tools)
- **bpmn.io compatible** (verified with bpmn-js viewer)

### Visual Refinement (opt-in)

Post-layout coordinate transforms that polish BPMN diagrams without changing semantics. Default `enabled: false` — existing pipeline output stays byte-identical.

- **Pass 1** — Dynamic per-pool lane-header widths with multi-line wrapping (long lane/pool names no longer clip)
- **Pass 2** — `compactLanes`: reduces lane padding (~45px per non-empty lane on typical layouts, ~10–20% canvas shrink on multi-lane diagrams)
- **Pass 3** — Edge label collision repair via bbox-nudge
- **Pass 5** — ELK MULTI_EDGE wrapping for wide pipelines (>20 nodes)

**Enable via config:**

```json
{
  "visualRefinement": {
    "enabled": true,
    "minLaneHeight": 80
  }
}
```

**Or per-call:**

```javascript
const result = await runPipeline(logicCore, { visualRefinement: true });
```

Design spec: [`docs/superpowers/specs/2026-04-21-bpmn-visual-refinement-pass-design.md`](docs/superpowers/specs/2026-04-21-bpmn-visual-refinement-pass-design.md)

## Multi-Agent Orchestration

The orchestrator chains 4 agents in a feedback loop until the diagram is valid and compliant:

```
Modeler (LLM) → Reviewer → Layout/Pipeline → Compliance → Done
   ↑               │              │
   └───────────────┘              │  (Review loop: max 3)
   ↑                              │
   └──────────────────────────────┘  (Layout loop: max 2)
```

```bash
# Review-only (no LLM needed):
node scripts/orchestrator.js --input logic-core.json --output /tmp/result

# Full cycle with LLM (text → BPMN):
node scripts/orchestrator.js --text "Process description..." \
  --api-url https://api.example.com/v1 --api-key KEY --model gpt-4.1 \
  --output /tmp/result
```

```javascript
import { orchestrate } from './orchestrator.js';

// Without LLM — review + generate + compliance only:
const result = await orchestrate(logicCoreJson);

// With LLM — full text-to-BPMN cycle:
const result = await orchestrate('Process description...', { llmProvider });
```

## MCP Server

The BPMN Generator can be used as an MCP (Model Context Protocol) server, exposing four tools:

| Tool | Description |
|------|-------------|
| `generate_bpmn` | Logic-Core JSON → BPMN 2.0 XML + SVG |
| `validate_bpmn` | Validate Logic-Core without generating output |
| `import_bpmn` | BPMN 2.0 XML → Logic-Core JSON |
| `orchestrate_bpmn` | Multi-agent review + generate + compliance |

### Configuration

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bpmn-generator": {
      "command": "node",
      "args": ["/path/to/scripts/mcp-bpmn-server.js"]
    }
  }
}
```

## HTTP API

The BPMN Generator also provides an HTTP API for multi-user access (CI/CD pipelines, web apps, external systems):

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

### Start

```bash
PORT=3000 node scripts/http-server.js
```

### Request

```bash
curl -X POST http://localhost:3000/api/v1/generate \
  -H 'Content-Type: application/json' \
  -d '{"logicCore": {...}, "clientId": "my-app", "callbackUrl": "https://..."}'
```

Optional fields: `callbackUrl` (async delivery with retry), `clientId` (audit), `correlationId` (tracking).

### Observability

- **Audit log:** `audit/bpmn-generator.jsonl` (append-only JSON Lines, metadata only)
- **Dead letter:** `dead-letter/` (failed callback deliveries)

## DMN Support (opt-in)

Alongside the BPMN pipeline, `scripts/dmn/` generates DMN 1.3 decision models: JSON Decision-Core
→ schema gate → rule engine → ElkJS DRD (Decision Requirements Diagram) layout → coordinate
mapping → diagram integrity check → DMN 1.3 XML + DMNDI (via `dmn-moddle`). Output validates
against the normative `DMN13.xsd`.

This is a separate, sibling subsystem — `dmn/` never imports from `bpmn/` and isn't reached by
`runPipeline`. It has its own rule engine (17 rules, 3 layers — see the "DMN rule engine" section
of [`CLAUDE.md`](CLAUDE.md) for the layer breakdown), its own CLI, and its own test coverage.

```bash
# JSON Decision-Core → DMN 1.3 XML
node dmn/pipeline.js input.json output-basename

# Enable the opt-in best_practice rule layer
node dmn/pipeline.js input.json output --best-practice

# Abort (no files written) on any unresolved warning
node dmn/pipeline.js input.json output --strict
```

Currently covers Decision-Core validation, DRD layout, and DMN 1.3 serialization (Stages 1-4 of
the DMN integration). Round-trip import (DMN XML → Decision-Core) and SVG rendering are not yet
implemented — see `docs/superpowers/plans/2026-07-30-dmn-integration.md` for what's still open.

## OMG Compliance

See `references/omg-compliance.md` for a detailed mapping of OMG BPMN 2.0.2 specification sections to implementation code.

## Third-Party Libraries

| Library | License | Purpose |
|---|---|---|
| [ElkJS](https://github.com/kieler/elkjs) | EPL-2.0 | Sugiyama layered auto-layout (BPMN + DMN DRD) |
| [bpmn-moddle](https://github.com/bpmn-io/bpmn-moddle) | MIT | BPMN 2.0 meta-model (XML serialization) |
| [dmn-moddle](https://github.com/bpmn-io/dmn-moddle) | MIT | DMN 1.3 meta-model (XML serialization) |
| [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) | MIT | MCP server integration |
| [ajv](https://github.com/ajv-validator/ajv) | MIT | JSON Schema strict gate for untrusted input |
| [ajv-formats](https://github.com/ajv-validator/ajv-formats) | MIT | Format validators for the schema gate |

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for full license details and [SECURITY.md](SECURITY.md) for the dependency policy.

## References

- OMG BPMN 2.0.2 (formal/2013-12-09, ISO/IEC 19510:2013)
- Bruce Silver: "BPMN Method and Style, 2nd Edition"
- Soliman et al. (2025): "Size matters less: how fine-tuned small LLMs excel in BPMN generation"
- Domroes et al. (2023): "Model Order in Sugiyama Layouts" (ELK)

## License

[MIT](LICENSE) — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for dependency licenses.
