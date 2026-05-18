# CLAUDE.md — BPMN Generator

## Project Context

Enterprise BPMN 2.0 Generator: JSON Logic-Core → Validation → ElkJS Layout → BPMN 2.0 XML + SVG.
OMG BPMN 2.0.2 compliant (ISO/IEC 19510:2013). Compatible with bpmn.io / Camunda Modeler.

Used as a Claude Code Skill (SKILL.md) — the LLM extracts Logic-Core JSON from natural language, the pipeline handles layout and serialization. The LLM NEVER touches coordinates.

## Glossary

- **Logic-Core**: the JSON intermediate format between LLM and pipeline. Schema in `references/input-schema.json`, prose in `references/logic-core-schema.md`. Example: `tests/fixtures/simple-approval.json`.
- **BPMN 2.0.2**: OMG standard (ISO/IEC 19510:2013) for business process notation. We emit XML compatible with bpmn.io and Camunda Modeler.
- **BPMNDI**: BPMN Diagram Interchange — the `<bpmndi:*>` namespace that carries graphical layout (coordinates, waypoints) alongside the semantic XML.
- **Pool / Lane**: a Pool is a participant in a collaboration (its own process boundary); Lanes partition a Pool into roles/actors. Pools communicate via Message Flows.
- **WF-Net**: Workflow-Net — a restricted Petri-Net with one source and one sink. Used for soundness analysis (WF01–WF03 rules).
- **Soundness**: a process is sound if every case can reach the end state, no dead activities, no proper deadlocks. Petri-Net property.
- **Sugiyama**: layered graph drawing algorithm (Sugiyama et al., 1981). ElkJS implements a variant; we use it via the `org.eclipse.elk.layered` algorithm.
- **ElkJS Layered**: JavaScript port of the Eclipse Layout Kernel's layered algorithm. Our auto-layout engine — see `scripts/layout.js`.
- **Bruce Silver Method & Style**: industry-recognized style conventions for BPMN diagrams. Most M-layer rules (M01–M10) derive from this work.
- **MCP**: Model Context Protocol — the protocol Claude Code uses to talk to external tools. We expose the generator via `scripts/mcp-bpmn-server.js`.
- **MaD**: Model-and-Data sanity check used by the robustness subsystem to validate synthetic fixtures.
- **Golden file**: an `.expected.bpmn` (or `.expected.svg`) committed alongside a fixture; tests fail if output diverges.

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

## Common Tasks

Workflows that come up repeatedly in this codebase. Each lists the file(s) to open first and the verification command.

### Debug a wrong layout

1. Reproduce: `cd scripts && node pipeline.js tests/fixtures/<fixture>.json /tmp/dbg`
2. Inspect `/tmp/dbg.svg` (browser) and `/tmp/dbg.bpmn` (text editor).
3. Open in order: `layout.js` (Elk node/edge build), `coordinates.js` (post-processing), `topology.js` (node/lane ordering).
4. For pool/lane width issues, suspect `coordinates.js` first (pool width balancing + lane-compaction logic) and `visual-refinement.js` (compaction passes).
5. For edge routing issues, suspect `coordinates.js` (`clipOrthogonal`) and `bpmn-xml.js` (waypoint emission).

### React to a golden-file failure

1. **Never blind-regenerate.** First inspect the diff:
   - `diff -u tests/fixtures/<name>.expected.bpmn /tmp/output.bpmn`
2. Decide: is the change intended (then the golden is stale and must be regenerated) or unintended (then the code is broken)?
3. Only after the diff is reviewed: regenerate via the fixture's documented procedure (typically `node pipeline.js <fixture> <out>` and then `cp <out>.bpmn <fixture>.expected.bpmn`).
4. Commit golden updates in their own commit, separate from code changes.

### Extend the rule engine

1. Insert the rule object into the `RULES` array in `scripts/rules.js`.
2. Fields: `id`, `layer`, `defaultSeverity`, `description`, `ref`, `check(proc) → { pass: true } | { pass: false, message }`.
3. Document the rule in `references/fachliches-regelwerk.md` with source citation.
4. Add a positive and a negative fixture under `tests/fixtures/` and assertions in `pipeline.test.js`.
5. Verify: `npm test -- --testPathPatterns=pipeline`.

### Choose a test fixture

- Simple sequential approval flow → `tests/fixtures/simple-approval.json`
- Multi-pool collaboration with message flows → `tests/fixtures/multi-pool-collaboration.json`
- Subprocess (expanded) → `tests/fixtures/expanded-subprocess.json`
- Sparse lanes (tests visual-refinement compaction) → `tests/fixtures/sparse-lanes.json`
- Full list: `ls tests/fixtures/`.

### Change a prompt template

1. Edit `references/prompt-template.md`. The LLM consumes this verbatim.
2. **Re-validate downstream**: any change must still produce valid Logic-Core per `references/input-schema.json`. Run a sample text through the orchestrator (`scripts/agents/modeler.js`) and check the schema-validation step passes.
3. Update the few-shot examples in the same file if the format changes — examples must be consistent with the new rules.

### Run a visual-refinement pass

1. Default: `visualRefinement: false`. Opt in per call: `runPipeline(lc, { visualRefinement: true })`.
2. Sub-flags live in `scripts/config.json` under `CFG.visualRefinement`: `dynamicLaneHeader`, `laneCompaction`, `edgeLabelCollisionRepair` (all on by default when `visualRefinement: true`). See `scripts/visual-refinement.js` for the pass implementations.
3. Verify against goldens: `cd scripts && npm test -- --testPathPatterns=visual-refinement`.

### Run a robustness benchmark

1. Synthetic-data run: `cd scripts/robustness && node cli.js run --target=lc-json`.
2. Multi-target run: `node cli.js run --target=both` (LC-JSON + DOT paths through the LLM).
3. MaD subset validation: `node cli.js mad-check`.
4. Reports land in `tests/robustness-reports/` (gitignored — share by attaching).

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

## Do NOT

Anti-patterns that have caused real problems in this codebase. Each rule has a reason; understand it before deciding the rule does not apply.

- **No `require()` or CommonJS.** This is an ES-Modules project (`"type": "module"`). A single `require()` breaks everything downstream. If a CommonJS-only dep is unavoidable, use dynamic `import()` with explicit interop wrapping.
- **No new runtime dependencies without prior discussion.** Current deps: `elkjs`, `bpmn-moddle`, `@modelcontextprotocol/sdk`. Each was a deliberate choice. Adding a fourth widens the threat surface and the supply-chain risk — propose it before installing.
- **No blind golden-file regeneration.** When a `.expected.bpmn` or `.expected.svg` test fails, inspect the diff first. The test is the alarm — silencing it without understanding is how real regressions enter master.
- **No LLM output downstream without schema validation.** Any path that lets `references/input-schema.json` be bypassed is a bug. The pipeline assumes well-formed Logic-Core; an LLM that emits malformed JSON should be caught at the gate, not crash at `layout.js`.
- **No hard-coded constants where `config.json` applies.** Shapes, colors, spacing, font metrics all live in `scripts/config.json` and are loaded via `utils.js → CFG`. Hard-coding bypasses profile customization and tests.
- **No `git add .` or `git add -A`.** Always stage specific paths. The repo has `audit/`, `dead-letter/`, `tests/robustness-reports/` that produce artifacts which must not be committed.
- **No amending of published commits.** Once a commit is pushed (especially to `master`), amend rewrites history that others may have pulled. Make a new commit; the history stays honest.
- **No skipping pre-commit hooks (`--no-verify`).** Hooks exist for a reason. If a hook fails, fix the underlying issue. The exception is when the user explicitly asks for `--no-verify` for a specific commit.

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
