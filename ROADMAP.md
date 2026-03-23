# BPMN Generator Skill — Roadmap & Changelog

Version 3.1 | Last updated: March 2026 | adesso SE — Sovereign Knowledge Platform
Created by: Daniel (Senior Consultant) + Claude

## 1 Current State (v3.1)

The BPMN Generator Skill converts natural language into OMG-compliant BPMN 2.0.2 XML (ISO/IEC 19510:2013) and SVG preview via a 4-phase pipeline: Intent Extraction (LLM → JSON Logic-Core) → Validation (22 rules, 3 layers) → ElkJS Auto-Layout (Sugiyama) → BPMN XML + SVG Serialization.

### 1.1 Implemented Features

| Feature | Details | Status |
|---------|---------|--------|
| Pipeline Architecture | 4 phases: LLM→JSON→ELK→XML/SVG | Done |
| Modular Architecture | 13 ES modules, acyclic dependency graph | Done |
| Rule Engine | 25 rules in 4 layers (Soundness/Style/Pragmatics/Workflow-Net), configurable JSON profiles | Done |
| Flat Layout + Partitioning | Global Sugiyama layout, lanes as constraints | Done |
| Topological Sorting | Nodes in happy-path order, ELK Model Order | Done |
| Lane Ordering by Flow | Start lane on top, end lane at bottom | Done |
| Layer Constraints | StartEvent→FIRST, EndEvent→LAST | Done |
| Orthogonal Sequence Flows | 90-degree routing + edge clipping on shapes | Done |
| Multi-Pool Collaboration | Multiple participants + message flows | Done |
| Collapsed Pools (Black-Box) | Participant without processRef, 60px band | Done |
| Deadlock Detection | XOR-Split → AND-Join + Inclusive-GW detection | Done |
| OMG XML Compliance | LaneSet, gatewayDirection, conditionExpr, incoming/outgoing, top-level defs, DI Label Bounds | Done |
| Round-Tripping (import.js) | BPMN XML → Logic-Core JSON → BPMN XML | Done |
| Inline Mode (ElkJS CDN) | HTML artifact with browser-side layout | Done |
| Associations | Data Objects/Annotations via dotted lines | Done |
| Process Documentation | `<documentation>` on Process/Nodes | Done |
| Method & Style Rules | Bruce Silver conventions in reviewer prompt + rule engine | Done |
| Expanded Sub-Processes | Container with internal flow, hierarchical ELK graph | Done |
| Transaction Sub-Process | Double border, `<transaction>` tag, OMG §13.2.2 | Done |
| SVG Icon Fidelity | Real bpmn-js PathMap paths for all task types | Done |
| DOT Format | Graphviz export + import, CLI integration (--dot, --import-dot) | Done |
| Few-Shot Enterprise Patterns | 5 patterns: Four-Eyes, Escalation, Loops, Compensation, Event SubProcess | Done |
| Pool Width Equalization | Collapsed + expanded pools at equal width | Done |
| bpmn.io Compatibility | Verified, COMPATIBILITY.md documented | Done |
| OMG Compliance Mapping | Complete mapping OMG → code in omg-compliance.md | Done |
| JSON Schema | Formal JSON Schema (draft 2020-12) for Logic-Core input | Done |
| OMG 2.0.2 Execution Attributes | Timer, Script, MI/Loop details, Definitions, Conditional/Link Events, calledElement, implementation | Done |
| Round-Trip Fidelity | Import + export of all execution attributes (25 OMG examples + 13 unit tests) | Done |
| bpmn-moddle Import | Standards-compliant BPMN parser via bpmn-moddle (CMOF descriptors, all ~200 BPMN types) | Done |
| Nested Lane Export | childLaneSet correct in XML, recursive lane emission | Done |
| Extension Attribute Preservation | Unknown attributes (camunda:, zeebe:) survive round-trip via extensions.$attrs | Done |

### 1.2 Module Architecture

```
scripts/
├── pipeline.js        Orchestrator + CLI (~180 LOC)
│   ├── validate.js    Validation Wrapper → rules.js
│   ├── rules.js       Rule Engine (22 rules, 3 layers, profiles)
│   ├── topology.js    Gateway directions, topological sorting, lane ordering
│   ├── layout.js      ELK graph construction + layout execution
│   ├── coordinates.js Coordinate maps, edge clipping, pool equalization
│   ├── bpmn-xml.js    BPMN 2.0 XML generation (DI, top-level defs)
│   ├── svg.js         SVG rendering (pools, lanes, activities, events)
│   ├── icons.js       Event markers, task icons, bottom markers
│   ├── dot.js         DOT export/import (Graphviz)
│   ├── types.js       Type predicates, BPMN XML tag mapping
│   └── utils.js       Config loader, visual constants, utility functions
├── import.js          BPMN XML → Logic-Core JSON (async, delegates to moddle-import.js)
├── moddle-import.js   bpmn-moddle adapter: fromXML() → Logic-Core JSON (~200 LOC)
├── orchestrator.js    Multi-Agent State Machine + CLI
├── agents/
│   ├── modeler.js     LLM-based: Text→JSON, Refine, Amend
│   ├── reviewer.js    Deterministic: validateLogicCore() wrapper
│   ├── layout.js      runPipeline() + optional vision review
│   ├── compliance.js  Deterministic: runRules() gate
│   └── llm-provider.js OpenAI-compatible fetch abstraction
├── mcp-bpmn-server.js MCP Server (4 tools)
├── http-server.js     HTTP API (5 endpoints)
├── config.json        Externalized constants (shapes, colors, spacings)
├── workflow-net.js     Petri-Net Soundness Checker (WF01-WF03)
├── prepare-training-data.js  L1 Training Data ETL (BPMN→LC, filter, JSONL)
├── evaluate-slm.js    L1 SLM Evaluation (pipeline-based metrics)
├── pipeline.test.js   85 tests (Jest, ES Modules)
└── orchestrator.test.js 22 tests (Agents + State Machine)
```

---

## 2 Short-Term Improvements — DONE

All K0-K8 items are implemented.

| # | Measure | Status | Implemented in |
|---|---------|--------|----------------|
| K0a | Config externalization | Done | config.json, utils.js |
| K0b | ES Module exports | Done | All 13 modules with named exports |
| K0c | Unit tests (Jest) | Done | pipeline.test.js (30 tests) |
| K1 | SVG Icon Fidelity | Done | icons.js (real PathMap paths) |
| K2 | Edge-Label Placement | Done | coordinates.js |
| K3 | Expanded Sub-Processes | Done | layout.js, svg.js, bpmn-xml.js |
| K4 | Extend validation | Done | rules.js (22 rules, 3 layers) |
| K5 | Few-Shot Enterprise Patterns | Done | references/prompt-template.md |
| K6 | Transaction Sub-Process | Done | types.js, svg.js, bpmn-xml.js, import.js |
| K7 | Pool width fits content | Done | coordinates.js §5.0b |
| K8 | BPMN tool compatibility test | Done | COMPATIBILITY.md |

---

## 3 Mid-Term Improvements — Assessment

Last updated: March 2026. Each item with assessment, rationale, and recommendation.

### M2 — Happy-Path Leveling | DONE

Post-layout pass: identify happy-path nodes via `identifyHappyPathNodes()`, level Y-positions within their lane to a common median. Opt-in via `config.json` (`happyPathLeveling: true`).

**Files:** coordinates.js (§5.0c), topology.js, config.json

### M3 — Documentation View | DONE

SVG tooltips (`<title>` on nodes with `documentation`) + Markdown companion document via `generateProcessDoc()` + CLI `--doc` flag.

**Files:** svg.js (renderNode), pipeline.js (generateProcessDoc, --doc)

### M6 — BPMN-in-Color Extension | DONE

bioc:stroke/bioc:fill attributes on BPMNShape elements, per-node colors in SVG rendering, import of bioc attributes. Schema extended with `node.color: { stroke, fill }`.

**Files:** input-schema.json, bpmn-xml.js (biocAttrs + xmlns:bioc), svg.js (4 render functions), import.js (bioc parsing)

### M1 — Layout Feedback Loop | DROPPED

~~After ELK layout: pass SVG as image to a second LLM call acting as layout reviewer.~~

**Rationale:** M1 is a subset of L3 (Multi-Agent Orchestration). The layout reviewer is an agent in the multi-agent system. As a standalone feature, M1 would require a fragile Vision-API→coordinates hack (SVG→PNG→Vision→Parse→ELK-Constraints). In L3 the feedback loop runs in a structured way via JSON instead of screenshot analysis. Building M1 separately would be redundant work.

### M4 — Expanded SubProcess Drill-Down | DONE

`generateDiagramSet()` produces a parent diagram (SubProcesses collapsed) + one standalone diagram per SubProcess. CLI: `--drill-down` flag. MCP: `generate_bpmn` with `drillDown: true`. Navigation manifest with breadcrumbs. Recursive for nested SubProcesses.

**Files:** pipeline.js (+`generateDiagramSet`, `collapseSubProcesses`, `extractSubProcessAsLogicCore`), mcp-bpmn-server.js (+drillDown option), pipeline.test.js (+7 tests)

### M5 — Process Mining Integration | DROPPED

~~Event logs → Process Discovery → Logic-Core.~~

**Rationale:** Process Mining is a pre-processor (event log → variants → Logic-Core), not part of the BPMN Generator. The pipeline consumes finished Logic-Core JSON — where it comes from (LLM, Process Mining, manual) is not its scope. Belongs in iwf-knowledge or a separate tool.

---

## 4 Long-Term Improvements — Assessment

### L4 — A2A/MCP Integration | DONE

MCP server with 3 tools: `generate_bpmn`, `validate_bpmn`, `import_bpmn`. Uses `@modelcontextprotocol/sdk`. Configurable via `claude_desktop_config.json`.

**Files:** scripts/mcp-bpmn-server.js (new), package.json, README.md

### L6 — Description-to-DOT Alternative | DONE

~~DOT as intermediate representation instead of JSON.~~

**Rationale:** dot.js export + import exists in full. CLI integration (`--dot`, `--import-dot`) works. DOT-first extraction (LLM generates DOT instead of JSON) would be an optimization within L1 (Fine-tuned SLM), not a standalone item.

### L7 — Multi-User HTTP Service | DONE

HTTP API gateway (`http-server.js`) with 4 endpoints: generate, validate, import, health. Node.js native `http`, no new dependencies. Callback delivery with 3x retry + dead letter (`delivery.js`). Append-only audit log (`audit.js`, JSON Lines, metadata only). Runs in parallel with the MCP server (Stdio).

**Files:** scripts/http-server.js (new), scripts/delivery.js (new), scripts/audit.js (new), README.md

### L3 — Multi-Agent BPMN Orchestration | DONE

Lightweight custom orchestrator (no CrewAI — avoided polyglot break). 4 agents: Modeler (LLM) → Reviewer (deterministic) → Layout (Pipeline + optional vision review) → Compliance (deterministic). State machine with blackboard pattern, configurable iteration limits (Review: max 3, Layout: max 2). Dual mode: `orchestrate(text, {llmProvider})` for Text→BPMN or `orchestrate(logicCoreJson)` for review-only without LLM.

**Files:** scripts/orchestrator.js, scripts/agents/{modeler,reviewer,layout,compliance,llm-provider}.js, scripts/orchestrator.test.js (20 tests). Integration: MCP server (+orchestrate_bpmn tool), HTTP API (+/api/v1/orchestrate endpoint), CLI (--input/--text).

85 tests green (63 pipeline + 22 orchestrator).

### L1 — Training Data Pipeline for BPMN-SLM | DONE

Training data preparation for specialized BPMN-SLM: `prepare-training-data.js` converts 3734 BPMN files (research dataset EN/DE + IWF BPMNs) via import.js round-trip to Logic-Core JSON, filters by validation + compliance, and produces JSONL for instruction tuning. Eval script `evaluate-slm.js` validates SLM output through the pipeline (parse rate, schema, soundness, compliance, structural fidelity). LLM provider extended with local inference mode (Ollama, llama.cpp, vLLM).

**Result:** 1897 valid training samples (50.8% of the 3734 BPMNs pass validation + compliance). 80/10/10 split: 1517 train, 190 val, 190 test.

**Files:** scripts/prepare-training-data.js, scripts/evaluate-slm.js, scripts/agents/llm-provider.js (local inference)

### L2 — Workflow-Net Soundness Checker | DONE

Pure-JS Petri-Net verification (no Python bridge): BPMN → Place/Transition-Net conversion + BFS state-space exploration. Checks liveness (WF01), 1-boundedness (WF02), proper completion/deadlock freedom (WF03). Opt-in via `workflow_net` layer in rule profiles (strict-profile.json: active, default-profile.json: disabled). Handles implicit XOR merges (tasks with multiple incoming edges) and XOR splits (N choice transitions).

Scope: XOR + AND gateways formalized. OR gateways → info warning. Event-based gateways + timer/signal events → skipped (not modelable in classical WF-Nets).

**Files:** scripts/workflow-net.js (~300 LOC), scripts/rules.js (+WORKFLOW_NET_RULES, integration in runRules), rules/strict-profile.json, rules/default-profile.json, tests/fixtures/deadlock-process.json, pipeline.test.js (+7 WF tests)

### L5 — BPMN as AI Orchestration Language | DEFERRED

Ad-hoc subprocesses as containers for LLM decisions, deploy to Camunda Zeebe.

**Rationale:** Requires Camunda Zeebe infrastructure + IWF Agent Registry. Not a bpmn-generator feature but an IWF platform integration. Too early — only relevant once IWF agents are running in production.

---

## 5 Placeholder Rules — Assessment

6 registered placeholders in rules.js (`check: () => ({ pass: true })`):

### IMPLEMENT

| Rule | Layer | Description | Effort |
|------|-------|-------------|--------|
| **M07** | Style (WARNING) | Avoid OR gateways (inclusive) — Inclusive GW usage as warning | 10 LOC |
| **M08** | Style (WARNING) | Every XOR split has a default flow | 15 LOC |
| **P02** | Pragmatics (INFO) | Gateway nesting depth ≤ 3 (DFS with depth counter) | 30 LOC |
| **P03** | Pragmatics (INFO) | Control-flow complexity score (Cardoso metric: Σ XOR splits + 2^n AND splits) | 40 LOC |

### DEFERRED

| Rule | Layer | Description | Rationale |
|------|-------|-------------|-----------|
| **M05** | Style (WARNING) | Message flow labels: nouns only | Requires POS tagger for German language (no reliable npm package available). Questionable benefit since the LLM already generates labels according to prompt rules. |
| **M06** | Style (WARNING) | Event labels: participle/state | Same POS tagger issue as M05. German compounds and participle constructions cannot be reliably detected via regex. |

---

## 6 Implementation Plan — COMPLETED

All 5 phases are implemented (March 2026):

| Phase | Item | Status |
|-------|------|--------|
| 1 | Rules M07, M08, P02, P03 | DONE |
| 2 | M6 — BPMN-in-Color | DONE |
| 3 | M3 — Documentation View | DONE |
| 4 | M2 — Happy-Path Leveling | DONE |
| 5 | L4 — MCP Server | DONE |

30/30 tests green after all changes.

---

## 7 Known Limitations

| Limitation | Cause | Resolution in |
|------------|-------|---------------|
| Cross-lane backflows | Process-inherent backflows cannot be straightened. ELK optimizes, but the topology forces the backflow. | L3 Layout Agent (vision review opt-in) |
| Edge crossing on synthetic paths | Synthetic paths (not ELK-routed) have no crossing avoidance. | M2 (Leveling) |
| Inline mode without task icons | HTML inline template renders simplified shapes. For full fidelity: pipeline.js. | — (by design) |
| Formal soundness only for XOR/AND | WF-Net check covers XOR/AND gateways. OR gateways warning only, event-based GW skipped. | — (classical WF-Net limitation) |
| Language analysis rules (M05/M06) | German labels require POS tagger — no reliable npm package available. | — (deferred) |

---

## 8 Research References

- **Soliman et al. (2025):** "Size matters less: how fine-tuned small LLMs excel in BPMN generation". Springer JESIT. Description-to-DOT pipeline, Qwen2.5 14B Coder fine-tuning, MaD Dataset.
- **Nour Eldin et al. (2026):** "Do LLMs Speak BPMN?" Evaluation framework for LLM-based BPMN tools. 15 quality criteria, 5 tools evaluated. 0% pass rate for complementary elements (Pools/Lanes).
- **Kourani et al. (2024/25):** POWL → Workflow-Net → BPMN conversion. Van-der-Aalst group. Mathematically founded process correctness.
- **BPMN Assistant (2025):** JSON Logic-Core approach. Modification success rate JSON vs XML: 50% vs 8%. Our architecture basis.
- **Domroes et al. (2023):** "Model Order in Sugiyama Layouts". ELK research. Basis for our topological node sorting.
- **Kasperowski et al. (2024):** "The Eclipse Layout Kernel". GD 2024. 140+ layout options, partitioning, model order, constraint resolving.
- **Bruce Silver:** "BPMN Method and Style, 2nd Edition". Style rules for readable models. Basis for our naming conventions and reviewer prompts.
- **Cardoso (2005):** "How to Measure the Control-Flow Complexity of Web Processes and Workflows". Basis for CFC metric (P03).
