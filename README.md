# BPMN Generator

[![CI](https://github.com/Stieges/bpmn-generator/actions/workflows/ci.yml/badge.svg)](https://github.com/Stieges/bpmn-generator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

BPMN 2.0 diagram generator — converts natural language process descriptions or structured JSON into OMG-compliant BPMN 2.0.2 XML files and SVG previews (ISO/IEC 19510:2013).

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
          → [Phase 2] Validation (26 rules, 4 layers, deadlock detection)
          → [Phase 3] Auto-Layout (ElkJS Sugiyama layered algorithm)
          → [Phase 4] Serialization → BPMN 2.0 XML + SVG
```

The LLM **never** handles coordinates. Layout is 100% algorithmic.

## Quick Start

```bash
cd scripts/
npm install          # installs elkjs + jest

# Generate from JSON Logic-Core:
node pipeline.js my-process.json my-process

# From stdin:
echo '{ ... }' | node pipeline.js - output

# Import existing BPMN:
node import.js existing.bpmn extracted.json

# DOT export (Graphviz):
node pipeline.js my-process.json my-process --dot

# DOT import → Logic-Core JSON:
node pipeline.js graph.dot output --import-dot

# Run tests:
npm test
```

**Output:** `output.bpmn` (BPMN 2.0 XML) + `output.svg` (vector preview)

## Usage as Claude Code Skill

### In a specific project

Copy `SKILL.md` to `.claude/skills/operative/bpmn-prozess-erstellen.md` and adjust the relative paths for `references/` and `scripts/` to match where you placed those directories.

### As a portable .skill file

The `bpmn-generator-v3.skill` ZIP archive can be shared with other projects. It contains everything needed:
- `SKILL.md` — Skill definition
- `references/` — Schema, prompt templates, inline template
- `scripts/` — Pipeline modules, import.js, package.json

## Module Architecture

```
scripts/
├── pipeline.js        Orchestrator + CLI (~180 LOC)
│   ├── validate.js    Validation wrapper → rules.js
│   ├── rules.js       Rule engine (26 rules, 4 layers, profile support)
│   ├── topology.js    Gateway directions, topological sort, lane ordering
│   ├── layout.js      ELK graph construction + layout execution
│   ├── coordinates.js Coordinate maps, edge clipping, pool equalization
│   ├── bpmn-xml.js    BPMN 2.0 XML generation (DI, top-level defs)
│   ├── svg.js         SVG rendering (pools, lanes, activities, events)
│   ├── icons.js       Event markers, task icons, bottom markers
│   ├── dot.js         DOT export (Logic-Core → Graphviz) + import
│   ├── types.js       Type predicates, BPMN XML tag mapping
│   └── utils.js       Config loader, visual constants, helpers
├── import.js          BPMN XML → Logic-Core JSON round-trip importer
├── orchestrator.js    Multi-agent state machine + CLI
├── agents/
│   ├── modeler.js     LLM-powered: text→JSON, refine, amend
│   ├── reviewer.js    Deterministic: validateLogicCore() wrapper
│   ├── layout.js      runPipeline() + optional vision review
│   ├── compliance.js  Deterministic: runRules() gate
│   └── llm-provider.js OpenAI-compatible fetch abstraction (cloud + local)
├── workflow-net.js    Petri-Net soundness checker (WF01-WF03)
├── prepare-training-data.js  Training data ETL (BPMN→LC, filter, JSONL)
├── evaluate-slm.js    SLM evaluation (pipeline-based metrics)
├── mcp-bpmn-server.js MCP server (4 tools)
├── http-server.js     HTTP API (5 endpoints)
├── config.json        Externalized constants (shapes, colors, gaps)
├── package.json       Dependencies (elkjs, jest)
├── pipeline.test.js   114 tests (Jest, ES Modules)
└── orchestrator.test.js 22 tests (agents + state machine)
```

**Dependency graph** (acyclic):
```
types.js ← (no deps)
utils.js ← (no deps, reads config.json)
rules.js ← types, workflow-net
workflow-net.js ← types
validate.js ← rules
topology.js ← types
layout.js ← types, utils, topology, elkjs
coordinates.js ← types, utils
icons.js ← utils
bpmn-xml.js ← types, utils, topology, icons
svg.js ← types, utils, icons
dot.js ← types
pipeline.js ← all of the above
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
├── bpmn-generator-v3.skill               Portable ZIP archive
├── .github/workflows/ci.yml             GitHub Actions CI
├── references/
│   ├── logic-core-schema.md              JSON schema documentation (prose)
│   ├── input-schema.json                 Formal JSON Schema (draft 2020-12)
│   ├── prompt-template.md                LLM prompt templates + few-shot patterns
│   ├── inline-template.md                HTML template for browser-side ElkJS
│   ├── fachliches-regelwerk.md           Rule documentation (26 rules, 4 layers)
│   ├── omg-compliance.md                 OMG BPMN 2.0.2 compliance mapping
│   └── review-set/                       Test fixtures for visual review
├── rules/
│   ├── default-profile.json              Default rule profile (all layers active)
│   └── strict-profile.json               Strict profile (warnings → errors)
├── scripts/                              Pipeline modules (see above)
└── tests/
    └── fixtures/                         Test input files (JSON Logic-Core)
```

## Rule Engine

26 rules across 4 layers with configurable severity via JSON profiles:

| Layer | Severity | Rules | Examples |
|-------|----------|-------|----------|
| Soundness | ERROR | S01-S11 | Start/End events, deadlocks, boundary events |
| Style | WARNING | M01-M09 (M05/M06 disabled) | Naming conventions, gateway labels |
| Pragmatics | INFO | P01-P03 | Complexity metrics |
| Workflow-Net | ERROR/WARNING | WF01-WF03 | Liveness, boundedness, deadlock-freedom (opt-in) |

```bash
# Default profile (all layers active):
node pipeline.js input.json output

# Strict profile (style warnings → errors):
# (programmatic: runPipeline(lc, { ruleProfile: 'rules/strict-profile.json' }))
```

See `references/fachliches-regelwerk.md` for full rule documentation.

## Programmatic API

```javascript
import { runPipeline } from './pipeline.js';

const logicCore = { nodes: [...], edges: [...] };
const result = await runPipeline(logicCore);

// result.bpmnXml   — BPMN 2.0 XML string (or null on validation error)
// result.svg       — SVG string
// result.coordMap  — coordinate map
// result.validation — { errors: [], warnings: [] }
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
- **Configurable rule engine** (26 rules, 4 layers, JSON profiles)
- **OMG BPMN 2.0.2 compliant** XML output (ISO/IEC 19510:2013)
- **BPMN-in-Color** (bioc: namespace — per-node fill/stroke in XML + SVG)
- **Documentation View** (SVG tooltips + `--doc` Markdown companion)
- **Happy-Path Y-Leveling** (post-layout alignment, configurable)
- **MCP Server** (generate, validate, import as MCP tools)
- **bpmn.io compatible** (verified with bpmn-js viewer)

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
| `GET` | `/health` | Health check (uptime, version) |

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

## OMG Compliance

See `references/omg-compliance.md` for a detailed mapping of OMG BPMN 2.0.2 specification sections to implementation code.

## Third-Party Libraries

| Library | License | Purpose |
|---|---|---|
| [ElkJS](https://github.com/kieler/elkjs) | EPL-2.0 | Sugiyama layered auto-layout |
| [bpmn-moddle](https://github.com/bpmn-io/bpmn-moddle) | MIT | BPMN 2.0 meta-model (XML serialization) |
| [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) | MIT | MCP server integration |

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for full license details.

## References

- OMG BPMN 2.0.2 (formal/2013-12-09, ISO/IEC 19510:2013)
- Bruce Silver: "BPMN Method and Style, 2nd Edition"
- Soliman et al. (2025): "Size matters less: how fine-tuned small LLMs excel in BPMN generation"
- Domroes et al. (2023): "Model Order in Sugiyama Layouts" (ELK)

## License

[MIT](LICENSE) — see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for dependency licenses.
