# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.3.0] — 2026-05-18

### Added
- **SSRF complete coverage** — `callbackUrl` validation now blocks IPv4 link-local (169.254.x, including AWS metadata endpoint), IPv6 unique-local (fc00::/7), and IPv6 link-local (fe80::/10). Hostnames are DNS-resolved and the resolved IPs are re-checked against the same denylist, closing the `evil.com → 127.0.0.1` bypass.
- **Production auth gate** — `BPMN_API_KEY` env var becomes mandatory when `NODE_ENV=production`. Server `startupCheck()` throws and refuses to bind. Dev mode (default) prints a prominent warning.
- **JSON Schema strict-gate** — `scripts/schema-gate.js` validates every `body.logicCore` at the HTTP API entry (`/generate`, `/validate`, `/orchestrate` when logicCore is provided) using ajv draft-2020-12. LLM-generated Logic-Core from `orchestrator.js` is also gated before reaching the layout phase.
- **`AUDIT_LOG_PATH` and `DEAD_LETTER_PATH` env vars** — runtime paths configurable for Docker / read-only filesystem deployments. Default: `os.tmpdir()/bpmn-generator/{audit,dead-letter}/`.
- **`$schemaVersion` field** in `references/input-schema.json` — optional, `const: "1.0"`, backward-compatible (absent value still accepted).
- **`lane.nodeIds`** added to the schema — was supported by code (`topology.js`, `coordinates.js`, rule WF-L1) but missing from the JSON schema. Schema now declares it.
- **SECURITY.md** at repo root — threat model, deployment guidance, vulnerability reporting.
- **`ajv` + `ajv-formats`** as direct runtime dependencies (were already transitively present via bpmn-moddle — zero `node_modules` size delta).

### Changed
- **`server.listen()` is now guarded** by `isEntryPoint` so importing `http-server.js` no longer binds the port (fixes EADDRINUSE under Jest workers).
- CLAUDE.md: new "Security defaults" subsection; Do-NOT rule about new deps updated to list `ajv` + `ajv-formats`.

### Breaking
- **Default audit/dead-letter paths moved** from `<repo>/audit/` and `<repo>/dead-letter/` to `<os.tmpdir>/bpmn-generator/{audit,dead-letter}/`. Set `AUDIT_LOG_PATH` and `DEAD_LETTER_PATH` env vars to restore the old behavior or pin a deployment-specific location.
- **HTTP error response shape** for malformed input shifts from `500 internal_error` to `400 schema_error` with an `errors` array (ajv error objects). Clients relying on `500` for bad input will see `400`.
- **`NODE_ENV=production` without `BPMN_API_KEY`** now exits non-zero at startup. CI / deployment scripts that set NODE_ENV=production without providing a key will fail.

## [3.2.0] — 2026-05-18

### Changed
- **Documentation honesty pass** — eliminated drift between CLAUDE.md / README.md / ROADMAP.md and the code. Concrete fixes: rule count corrected to 27 (was claimed 26), CLAUDE.md module inventory expanded from 13 to the actual 37 .js files (23 root + 5 `agents/` + 9 `robustness/`), dependency convention now lists all 3 runtime deps (was claimed only `elkjs`), false "Timer events have empty `<timerEventDefinition/>`" Known Limitation removed (the feature is implemented).
- **CLAUDE.md restructured** with new Glossary (12 terms), Common Tasks (7 workflows), and Do-NOT (8 anti-patterns) sections.
- **`bpmn-generator-v3.skill` removed from git** — replaced by `npm run build:skill` (on-demand bundler at `scripts/build-skill.mjs`).
- README + ROADMAP point to `references/fachliches-regelwerk.md` as the authoritative rule catalog (single source of truth).

## [3.1.0] — 2026-03-23

### Added
- **bpmn-moddle integration** — CMOF-based XML serialization via `bpmn-moddle`, replacing the legacy string-builder. Full OMG BPMN 2.0.2 type system.
- **Round-trip XML validation** — `validateBpmnXml()` parses generated XML back through `moddle.fromXML()` to verify 0 warnings.
- **Cross-lane edge deconfliction** — Post-processing phase (§5.0f) nudges overlapping horizontal edge segments.
- **Golden-file regression tests** — Deterministic SVG/BPMN comparison against `.expected.*` files.
- **Pipeline self-diagram** — The generator produces its own BPMN diagram ([docs/bpmn-generator-pipeline.bpmn](docs/bpmn-generator-pipeline.bpmn)).
- **ELK layout optimization** — Happy-path edge priorities, `GREEDY_MODEL_ORDER` cycle breaking, high-degree node treatment, post-compaction, `favorStraightEdges`.

### Changed
- Port constraints reverted from `FIXED_SIDE` to `FREE` for better cross-lane routing.
- Pipeline self-diagram consolidated from 6 lanes to 4 lanes for cleaner layout.

### Fixed
- `triggeredByEvent` TypeError on SubProcess elements (eventDefinitions guard).
- Edge routing improvements for multi-pool diagrams.

## [3.0.0] — 2026-03-20

### Added
- **Multi-agent orchestration** — 4-agent pipeline: Modeler (LLM) → Reviewer → Layout → Compliance. Configurable iteration limits.
- **HTTP API** — 5 endpoints: generate, validate, import, orchestrate, health. Callback delivery with retry + dead letter queue.
- **MCP Server** — 4 tools: `generate_bpmn`, `validate_bpmn`, `import_bpmn`, `orchestrate_bpmn`.
- **Workflow-Net soundness checker** — Petri-Net verification (liveness, boundedness, deadlock-freedom). Rules WF01-WF03.
- **Training data pipeline** — `prepare-training-data.js` for BPMN-SLM fine-tuning. 1897 validated samples from 3734 BPMNs.
- **SLM evaluation** — `evaluate-slm.js` with pipeline-based metrics.

## [2.0.0] — 2026-03-15

### Added
- **Modular architecture** — 13 ES Modules with acyclic dependency graph. Each pipeline step independently replaceable.
- **Rule engine** — 25 rules across 4 layers (Soundness, Style, Pragmatics, Workflow-Net). Configurable JSON profiles.
- **BPMN-in-Color** — `bioc:stroke`/`bioc:fill` attributes on shapes. Per-node colors in XML + SVG.
- **Documentation view** — SVG tooltips + `--doc` Markdown companion.
- **Happy-path Y-leveling** — Post-layout alignment of happy-path nodes.
- **DOT format** — Graphviz export + import via `dot.js`.
- **Expanded sub-processes** — Container nodes with inline children, hierarchical ELK graph.
- **Transaction sub-process** — Double border, `<transaction>` tag (OMG §13.2.2).
- **Few-shot enterprise patterns** — 5 patterns: four-eyes, escalation, loops, compensation, event subprocess.
- **bpmn.io compatibility** — Verified with bpmn-js viewer.

## [1.0.0] — 2026-03-01

### Added
- Initial release: JSON Logic-Core → ElkJS Sugiyama layout → BPMN 2.0 XML + SVG.
- Multi-pool collaborations with message flows.
- All BPMN 2.0 task types, gateway types, event types.
- Boundary events (interrupting/non-interrupting).
- Lanes, collapsed pools, data objects, text annotations.
- Round-tripping via `import.js`.
- 30 tests (Jest, ES Modules).
