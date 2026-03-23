# CLAUDE.md — BPMN Generator

## Project Context

Enterprise BPMN 2.0 Generator: JSON Logic-Core → Validation → ElkJS Layout → BPMN 2.0 XML + SVG.
OMG BPMN 2.0.2 compliant (ISO/IEC 19510:2013). Compatible with bpmn.io / Camunda Modeler.

Used as a Claude Code Skill (SKILL.md) — the LLM extracts Logic-Core JSON from natural language, the pipeline handles layout and serialization. The LLM NEVER touches coordinates.

## Architecture

13 Core-Pipeline + 5 Agents + 5 Server/Tooling modules under `scripts/`, acyclic dependency graph:

```
pipeline.js (Orchestrator, ~180 LOC)
  ├── validate.js      ← rules.js
  ├── rules.js         ← types.js, workflow-net.js (26 rules (24 active, M05/M06 disabled), 4 layers, profiles)
  ├── topology.js      ← types.js
  ├── layout.js        ← types.js, utils.js, topology.js, elkjs
  ├── coordinates.js   ← types.js, utils.js
  ├── bpmn-xml.js      ← types.js, utils.js, topology.js, icons.js
  ├── svg.js           ← types.js, utils.js, icons.js
  ├── icons.js         ← utils.js
  ├── dot.js           ← types.js
  ├── types.js         (no deps)
  └── utils.js         (no deps, reads config.json)

import.js              BPMN XML → Logic-Core (standalone)
```

**Guiding principle:** Each pipeline step is independently replaceable, configurable, and testable.

## Key Files

| File | Purpose |
|------|---------|
| `scripts/pipeline.js` | Orchestrator + CLI + Public API (`runPipeline`) |
| `scripts/rules.js` | Rule Engine: 26 rules (24 active, M05/M06 disabled), 4 layers (Soundness/Style/Pragmatics/Workflow-Net) |
| `scripts/validate.js` | Thin wrapper around `runRules()` |
| `scripts/types.js` | `isEvent`, `isGateway`, `isArtifact`, `bpmnXmlTag` |
| `scripts/utils.js` | `loadConfig`, `CFG`, constants, `esc`, `wrapText` |
| `scripts/topology.js` | `inferGatewayDirections`, `sortNodesTopologically`, `orderLanesByFlow` |
| `scripts/layout.js` | `logicCoreToElk`, `runElkLayout` (ElkJS Sugiyama) |
| `scripts/coordinates.js` | `buildCoordinateMap`, `clipOrthogonal`, pool width balancing |
| `scripts/bpmn-xml.js` | `generateBpmnXml` — OMG-compliant BPMN 2.0 XML + DI |
| `scripts/svg.js` | `generateSvg` — SVG rendering of all BPMN elements |
| `scripts/icons.js` | Event markers, task icons, bottom markers (Loop, MI, Ad-Hoc) |
| `scripts/dot.js` | `logicCoreToDot` / `dotToLogicCore` — Graphviz DOT support |
| `scripts/import.js` | BPMN XML Parser → Logic-Core JSON |
| `scripts/config.json` | Externalized constants (shapes, colors, spacing) |
| `references/input-schema.json` | Formal JSON Schema for Logic-Core input |
| `references/logic-core-schema.md` | Schema documentation (prose + examples) |
| `references/prompt-template.md` | LLM prompts + 5 enterprise few-shot patterns |
| `references/fachliches-regelwerk.md` | Rule documentation (26 rules (24 active, M05/M06 disabled), sources, extension guide) |
| `references/omg-compliance.md` | OMG BPMN 2.0.2 → code mapping |
| `rules/default-profile.json` | Default rule profile (all layers active) |
| `rules/strict-profile.json` | Strict profile (style warnings → errors) |

## Development

```bash
cd scripts/
npm install
npm test                                          # 136 tests (Jest, ES Modules)
node pipeline.js tests/fixtures/simple-approval.json /tmp/test   # Smoke Test
```

After every change: `npm test` must pass.

### Adding a New Test

1. Place fixture in `tests/fixtures/` (JSON Logic-Core)
2. Add test in `pipeline.test.js` (Jest, `import { ... } from './pipeline.js'`)
3. For golden-file tests: place `.expected.bpmn` alongside the fixture

### Adding a New Rule

1. Insert rule object into `scripts/rules.js` → `RULES` array
2. Fields: `id`, `layer`, `defaultSeverity`, `description`, `ref`, `check(proc)`
3. `check` returns `{ pass: true }` or `{ pass: false, message: '...' }`
4. Update documentation in `references/fachliches-regelwerk.md`
5. Add tests in `pipeline.test.js`

### Adding a New BPMN Element

1. `types.js` — extend `bpmnXmlTag` map, add type predicate if needed
2. `layout.js` — `buildElkNode` for layout dimensions
3. `bpmn-xml.js` — XML serialization
4. `svg.js` — SVG rendering
5. `icons.js` — if icon/marker needed
6. `import.js` — BPMN XML → Logic-Core parsing
7. `references/omg-compliance.md` — update OMG mapping
8. `references/input-schema.json` — extend schema

## Rule Engine

4 layers with configurable severity:

| Layer | Default Severity | Rules | Focus |
|-------|-----------------|-------|-------|
| Soundness | ERROR | S01-S11 | Structural correctness (OMG compliance) |
| Style | WARNING | M01-M09 (M05/M06 disabled) | Readability (Bruce Silver Method & Style) |
| Pragmatics | INFO | P01-P03 | Complexity metrics |
| Workflow-Net | ERROR/WARNING | WF01-WF03 | Petri-Net soundness (opt-in) |

Profiles in `rules/*.json` override severities or disable layers.

## Conventions

- ES Modules (`import`/`export`) — no CommonJS
- No external deps except `elkjs` (+ `jest` dev)
- Config in `config.json`, not hardcoded
- Functions are pure (no global state except `CFG`)
- IDs in Logic-Core: `^[a-zA-Z_][a-zA-Z0-9_-]*$`
- XML escaping via `esc()` from `utils.js`
- Coordinates always as `{ x, y, width, height }` objects

## CLI

```bash
# Standard: JSON → BPMN + SVG
node pipeline.js input.json output-basename

# Stdin:
cat input.json | node pipeline.js - output

# With DOT export:
node pipeline.js input.json output --dot

# DOT → Logic-Core JSON:
node pipeline.js graph.dot output --import-dot

# BPMN → Logic-Core (Round-Trip):
node import.js existing.bpmn extracted.json

# With documentation export:
node pipeline.js input.json output --doc

# Start MCP server:
node mcp-bpmn-server.js
```

## Known Limitations

- Rule placeholders: M05-M06 (Style) are registered but not implemented (POS tagger problem)
- No Camunda extensions (`camunda:` namespace)
- Timer events have empty `<timerEventDefinition/>` (no duration/cycle)
- DOT import is a subset parser (only output from `logicCoreToDot` is guaranteed)
