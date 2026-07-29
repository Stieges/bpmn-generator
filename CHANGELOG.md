# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Text annotations and groups lost their label in the generated XML.** Per OMG Semantic.xsd an
  Artifact extends BaseElement, which declares only `id` — `name` is illegal on `TextAnnotation`
  and `Group`, and bpmn-moddle accepted it silently instead of rejecting it. Annotations rendered
  as empty boxes in every BPMN tool. The label is now emitted where each class keeps it: a
  `<bpmn:text>` child for annotations, a referenced `CategoryValue` for groups. Logic-Core is
  unchanged — `name` remains the single caption field on input.
- Artifacts were serialised into `<bpmn:flowElements>`; `tProcess` is an `xsd:sequence`
  (`laneSet*, flowElement*, artifact*`), so they now go to `<bpmn:artifacts>`. Association endpoint
  resolution widened to match, so associations onto an annotation are no longer dropped.
- `Lane/flowNodeRef` listed text annotations, groups and data references. It is typed `FlowNode`
  and none of those qualify.
- The bpmn-moddle importer walked only `flowElements`, where artifacts never appear — every
  annotation and group was dropped on import, leaving associations pointing at ids that no longer
  existed. Both importers now read the current form and fall back to the pre-fix `name`, so
  existing files still load.

### Changed
- The CLI now prints BPMN serialisation warnings (the bpmn-moddle round trip over the generated
  XML) as their own section, and `--strict` aborts on them — consistent with how it already treats
  rule warnings and diagram diagnostics. The field (`validation.xmlWarnings`) already existed and
  already fired; nothing read it, so invalid output reported success and exited 0. No behaviour
  change without the flag beyond the added output.

## [3.6.0] — 2026-07-29

> **Gap notice.** No entries were recorded here between `[3.3.0]` and `[3.6.0]`, although
> six releases and several feature merges shipped in that time: v3.4 (#15), v3.5 (#16),
> v3.5b (#17), v3.5c/v3.5d (#18), plus PRs #19, #21, #23, #24, #25 and #27. Those
> entries are not reconstructed retroactively — the pull requests are the record for
> that period. The docs gate added below exists to stop this recurring.

### Added
- **DI integrity check** (`scripts/di-check.js`) — a post-layout pass over the produced
  geometry, reported under `result.diagnostics` (separate from `validation`, which never
  sees a coordinate). Codes DI01 (identical participant positions), DI02 (overlapping
  participants), DI03 (node outside its participant), DI04 (overlapping lane bands),
  DI06 (child outside its expanded subprocess) — all ERROR; DI05 (message flow crossing
  an uninvolved participant) — WARNING, because a communication cycle across three or
  more participants cannot always be laid out without one.
- **`poolOrder` option** (`runPipeline`, `/api/v1/generate`, MCP `generate_bpmn`) —
  `"auto"` (default) stacks collaboration participants so the ones exchanging messages
  sit next to each other; `"declared"` keeps the input order.
- **Rule S13** — a boundary event must reference an existing activity (OMG §10.4.3).
- **Geometry for artifacts and associations** — text annotations, data objects/stores
  and their associations now get placed coordinates and reach the DI as shapes/edges,
  not just as XML semantics.
- **MCP `include` and `ruleProfile` parameters** on `generate_bpmn` — `include` selects
  which of `xml`/`svg`/`validation`/`diagnostics` to return (default: all four);
  `ruleProfile` loads a rule profile JSON, e.g. `rules/strict-profile.json`.
- **Message flow routing** — flows now get a real route in `coordMap` (through the gap
  between the two participants involved, fanning out when several flows share a
  corridor) instead of being improvised independently by each renderer.
- Fixtures `tests/fixtures/realistic-collaboration.json` (six participants, boundary
  event, black box, message flows) and `tests/fixtures/all-element-classes.json`.
- **Docs gate** (`.github/scripts/docs-gate.mjs`, CI) — validates the HTTP response
  contract (`references/api-schema.json`), rule/script counts, DI codes, and npm package
  integrity against the running code instead of trusting the prose; see `CLAUDE.md` →
  Docs gate.

### Fixed
- Participant id collision when a collaboration had more than one laned pool (all
  shared the ELK id `'pool'`).
- Participant stacking collapsing onto identical positions from four participants on.
- Boundary events aborting the pipeline (`JsonImportException`) instead of being laid
  out on their host's border.
- Lane ordering: `elk.partitioning` was misused for lane bands (it groups layers along
  the flow direction, not horizontal bands), which could push a mid-process lane's
  outgoing flow backwards.
- Lane compaction (`visual-refinement.js`) shrinking a band without moving its top edge,
  dropping the lowest nodes out of the pool.
- Expanded-subprocess children not moving with their parent when a lane band shifted
  (only reproducible with more than one lane, so the single-lane fixture missed it).
- Text annotations, data objects/stores and associations were semantically present in
  the XML but had no DI shape/route, making them invisible in every BPMN tool.
- Message flows: the SVG drew a dog-leg while the DI carried a diagonal, and the
  diagonal's horizontal leg could land inside the neighbouring pool.
- A boundary event with a dangling `attachedTo` produced a `boundaryEvent` without the
  mandatory `attachedToRef` and an edge with zero waypoints, while validation reported
  green — now caught by rule S13.
- `validate_bpmn` (MCP) silently dropped `infos` and `metrics` from the validation
  result; `generate_bpmn`/`validate_bpmn` (MCP) had no schema gate (only
  `orchestrate_bpmn` did); `generate_bpmn`'s `drillDown` ignored `mode`, so
  drill-down plus `optimize` returned no advisories.
- `/api/v1/orchestrate` dropped `diagnostics` from its response even though the
    orchestrator computed it and the MCP `orchestrate_bpmn` tool already returned it.
  - Published npm package threw on first import — `schema-gate.js` and
    `agents/prompt-sections.js` each read a file from `references/`, outside the package
    root, and `package.json`'s `files` cannot reach outside it. Fixed with a `prepack` copy
    step plus a dual-path runtime fallback.

  ### Changed
  - `diagnostics.ok` means "no ERROR-severity finding" — WARNING-severity findings (DI05)
    are reported but do not fail the gate.
  - The CLI now aborts and writes no files when an ERROR-severity geometry finding is
    present, alongside the existing validation-error abort.
  - Laned pools now get their frame drawn in the SVG at all (a missing `poolCoords`
    entry meant it was silently skipped before); the lane header band sits inside the
    lane, matching the emitted DI and bpmn.io.

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
