# CLAUDE.md — BPMN Generator

## Project Context

Enterprise BPMN 2.0 Generator: JSON Logic-Core → Validation → ElkJS Layout → BPMN 2.0 XML + SVG.
OMG BPMN 2.0.2 compliant (ISO/IEC 19510:2013). Compatible with bpmn.io / Camunda Modeler.

Used as a Claude Code Skill (SKILL.md) — the LLM extracts Logic-Core JSON from natural language, the pipeline handles layout and serialization. The LLM NEVER touches coordinates.

## Architecture

23 core-pipeline + 5 agent + 9 robustness modules under `scripts/`. Verify current inventory with `find scripts -name '*.js' -not -path '*/node_modules/*' -not -name '*.test.js' | wc -l`.

```
Core Pipeline (run on every generate call)
  pipeline.js (Orchestrator, public API runPipeline)
    ├── validate.js          ← rules.js
    ├── rules.js             ← types.js, workflow-net.js
    ├── workflow-net.js      ← types.js
    ├── topology.js          ← types.js
    ├── layout.js            ← types.js, utils.js, topology.js, elkjs
    ├── coordinates.js       ← types.js, utils.js
    ├── visual-refinement.js ← coordinates.js (opt-in compaction passes)
    ├── bpmn-xml.js          ← types.js, utils.js, topology.js, icons.js
    ├── svg.js               ← types.js, utils.js, icons.js
    ├── icons.js             ← utils.js
    ├── dot.js               ← types.js
    ├── types.js             (no deps)
    └── utils.js             (reads config.json)

Standalone tooling
  import.js                  BPMN XML → Logic-Core (DOM parser)
  moddle-import.js           BPMN XML → Logic-Core (bpmn-moddle path)
  http-server.js             HTTP API (/api/v1/generate, /orchestrate)
  mcp-bpmn-server.js         MCP server entry point
  evaluate-slm.js            Pipeline evaluation runner
  prepare-training-data.js   Training-data prep script
  audit.js                   Append-only JSONL audit log
  delivery.js                Webhook delivery + dead-letter
  orchestrator.js            Multi-agent orchestration

Agent subsystem (scripts/agents/)
  compliance.js, layout.js, llm-provider.js, modeler.js, reviewer.js

Robustness subsystem (scripts/robustness/)
  cli.js, curate-mad.js, failure-classifier.js, fixture-persister.js,
  graph-isomorphism.js, mad-validator.js, report-generator.js,
  stress-tester.js, synthetic-generator.js
  (+ seed-catalog.json, config.json, README.md)
```

**Guiding principle:** Each pipeline step is independently replaceable, configurable, and testable.

## Key Files

| File | Purpose |
|------|---------|
| `scripts/pipeline.js` | Orchestrator + CLI + Public API (`runPipeline`) |
| `scripts/rules.js` | Rule Engine: 27 rules, 4 layers (Soundness/Style/Pragmatics/Workflow-Net); M05/M06 severity=OFF. Verify count: `grep -c '^\s*id:' scripts/rules.js` |
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
| `scripts/workflow-net.js` | WF-Net soundness checks (used by WF01–WF03 rules) |
| `scripts/visual-refinement.js` | Optional compaction/refinement passes P1–P7.1 (off by default) |
| `scripts/moddle-import.js` | BPMN XML → Logic-Core via bpmn-moddle (parallel to import.js) |
| `scripts/http-server.js` | HTTP API server (`/api/v1/generate`, `/orchestrate`) |
| `scripts/mcp-bpmn-server.js` | MCP server entry point |
| `scripts/orchestrator.js` | Multi-agent orchestration (modeler → layout → reviewer → compliance) |
| `scripts/audit.js` | Append-only audit log (JSONL) |
| `scripts/delivery.js` | Webhook delivery + dead-letter queue |
| `scripts/evaluate-slm.js` | Evaluation runner against fixture sets |
| `scripts/prepare-training-data.js` | Training-data prep for SLM eval |
| `scripts/agents/` | 5 agent modules: compliance, layout, llm-provider, modeler, reviewer |
| `scripts/robustness/` | Synthetic-data + benchmarking subsystem (9 modules + config; see `scripts/robustness/README.md`) |
| `scripts/import.js` | BPMN XML Parser → Logic-Core JSON |
| `scripts/config.json` | Externalized constants (shapes, colors, spacing) |
| `references/input-schema.json` | Formal JSON Schema for Logic-Core input |
| `references/logic-core-schema.md` | Schema documentation (prose + examples) |
| `references/prompt-template.md` | LLM prompts + 5 enterprise few-shot patterns |
| `references/fachliches-regelwerk.md` | Rule documentation (per-rule sources, extension guide). Authoritative catalog — see this file, not duplicated counts. |
| `references/omg-compliance.md` | OMG BPMN 2.0.2 → code mapping |
| `rules/default-profile.json` | Default rule profile (all layers active) |
| `rules/strict-profile.json` | Strict profile (style warnings → errors) |

## Development

```bash
cd scripts/
npm install
npm test                                          # Jest, ES Modules; verify count with `npm test 2>&1 | tail -5`
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
| Style | WARNING | M01-M10 (M05/M06 severity=OFF) | Readability (Bruce Silver Method & Style) |
| Pragmatics | INFO | P01-P03 | Complexity metrics |
| Workflow-Net | ERROR/WARNING | WF01-WF03 | Petri-Net soundness (opt-in) |

Profiles in `rules/*.json` override severities or disable layers.

## Conventions

- ES Modules (`import`/`export`) — no CommonJS
- Runtime deps (3): `elkjs`, `bpmn-moddle`, `@modelcontextprotocol/sdk`. Dev deps: `jest`, `@jest/globals`. No new deps without prior discussion.
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

- Rule placeholders: M05-M06 (Style) registered with severity=OFF (POS tagger problem; tracked in ROADMAP)
- No Camunda extensions (`camunda:` namespace)
- DOT import is a subset parser (only output from `logicCoreToDot` is guaranteed round-trip)
- Round-trip fidelity (BPMN→Logic-Core→BPMN) verified for ~25 OMG examples + 13 unit tests; not exhaustive across all BPMN element types
