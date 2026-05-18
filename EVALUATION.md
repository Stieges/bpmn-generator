# Evaluation

Reproducible metrics for the BPMN Generator. No marketing claims that aren't backed by a command you can run.

- **Stieges-Bench v1** — pipeline metrics over 9 hand-crafted Logic-Core fixtures. No LLM, no network.
- **bpmn-auto-layout comparison** — head-to-head against npm `bpmn-auto-layout@1.3.0` on Pools/Lanes-heavy fixtures.
- **Competitor matrix** — feature-by-feature comparison with ProMoAI, BPMN Assistant, and BPMN-Chatbot. Stieges column verified; competitor columns sourced from their public repos and papers.

Last regenerated: 2026-05-18.

## How to reproduce

```bash
cd scripts
npm install                                  # one-time
node bench/run-stieges-bench-v1.mjs          # → tests/bench/stieges-bench-v1.{json,md}
node bench/compare-bpmn-auto-layout.mjs      # → tests/bench/auto-layout-comparison.md + .bpmn pairs
node bench/render-comparison.mjs             # → tests/bench/comparison-*.html (side-by-side)
```

All three are deterministic. Re-running on a clean checkout reproduces the numbers below.

---

## Stieges-Bench v1

Pipeline metrics over every fixture in `tests/fixtures/*.json`. See [tests/bench/stieges-bench-v1.md](tests/bench/stieges-bench-v1.md) for the full per-fixture table; summary here.

| Metric | Value |
|---|---|
| Fixtures | 9 |
| Parse success (runPipeline doesn't throw) | **9 / 9** |
| Serialize success (non-empty BPMN+SVG) | **8 / 9** |
| Schema-valid inputs (ajv draft-2020-12) | **9 / 9** |
| Total nodes | 102 |
| Total edges | 114 |
| Total soundness errors | 1 (deadlock-process, by design) |
| Total soundness warnings | 11 (style layer) |
| Total edge crossings (CCW intersection scan) | 20 |
| Cumulative wall-clock (cold start) | 374 ms |

### What the numbers mean

- **9/9 parses, 8/9 serialize**: the one fixture that doesn't serialize (`deadlock-process`) intentionally fails Soundness (rule WF03 detects the deadlock). The pipeline aborts serialization rather than emit an unsound model — this is the correct behavior. The other 8 fixtures (single-pool, multi-pool, sub-process, dense edges, sparse lanes, wide pipeline, deeply nested labels) all serialize cleanly.
- **9/9 schema-valid**: every fixture passes `validateLogicCoreSchema()` (ajv against `references/input-schema.json`). The strict-gate at the HTTP API entry is consistent with what the bench accepts.
- **20 edge crossings** across 9 fixtures with 114 total edges. The CCW scan includes shared-endpoint touches (e.g., at gateways), so this is an upper bound; visual crossings are fewer.

### Caveats

- Wall-clock is single-run, no warmup. First call to `bpmn-generator-pipeline` (the largest fixture, 22 nodes / 31 edges) takes ~230 ms; the rest take 10-30 ms. ELK first-call cost dominates.
- The benchmark covers structural correctness on curated inputs. It does not measure: LLM extraction quality (no LLM here), visual aesthetics, layout-quality vs handcrafted reference (no human-rated reference set).

---

## bpmn-auto-layout comparison

Three multi-pool / lane-heavy fixtures, both pipelines processing the same semantic BPMN. See [tests/bench/auto-layout-comparison.md](tests/bench/auto-layout-comparison.md) for the raw report; [tests/bench/comparison-*.html](tests/bench/) for visual side-by-sides.

### Method

For each fixture: our pipeline produces BPMN with DI. We then strip the `<bpmndi:BPMNDiagram>` section and feed the semantic-only XML to `bpmn-auto-layout.layoutProcess()`. The two outputs are compared on (a) semantic element preservation and (b) DI element coverage.

### Result: DI Output

Counts of `<bpmndi:*>` elements — what the layout engine actually draws.

| Fixture | Pool shapes (ours / theirs) | Lane shapes (ours / theirs) | MsgFlow edges (ours / theirs) | SeqFlow edges (ours / theirs) |
|---|---|---|---|---|
| simple-approval | **1 / 0** ⚠ | **1 / 0** ⚠ | 0 / 0 | 6 / 6 |
| multi-pool-collaboration | **2 / 0** ⚠ | **3 / 0** ⚠ | **2 / 0** ⚠ | **10 / 3** ⚠ |
| sparse-lanes | **1 / 0** ⚠ | **4 / 0** ⚠ | 0 / 0 | 13 / 13 |

### Result: Semantic Preservation

`<bpmn:*>` element counts match in both. Neither tool deletes semantic elements; the divergence is purely in what gets drawn (DI).

### Findings

1. **`bpmn-auto-layout` renders zero pool shapes and zero lane shapes** in all three fixtures — including a single-pool sanity check. The swimlane structure isn't drawn. Opening the file in `bpmn.io` shows nodes floating without their containing pool/lane borders.

2. **In multi-pool collaborations, only the first participant is laid out.** The second pool's 4 nodes, its lane, and the 2 inter-pool message flows are silently omitted from the DI. This matches the upstream README's explicit warning:

   > Given a collaboration only the first participant's process will be laid out

3. **No errors thrown.** All three runs succeeded cleanly with valid XML. The failure mode is silent rendering omission, which is the worst kind: a user feeding our output into `bpmn-auto-layout` gets a file that "validates" but visually loses half the model.

### Stieges advantage (verified)

- Renders all participants in a collaboration.
- Renders lane borders for every lane.
- Renders inter-pool message flows.
- Result is loadable in `bpmn.io` and Camunda Modeler with all swimlane structure intact.

### Known polish gap (open for v3.5)

When our BPMN is loaded in `bpmn.io`, lane labels appear inside the lane near the first activity, which can collide with the activity's own label (e.g., "Customer" + "Need identified" overlap as "Custeed identified"). This is a label-positioning issue, not a structural one — pools, lanes, and flows all render correctly. Tracked for the v3.5 Visual-Polish pass.

---

## Competitor matrix

Stieges column verified against this repo. Competitor columns sourced from their respective public repositories, papers, and documentation as of 2026-05.

| Capability | Stieges | ProMoAI | BPMN Assistant | BPMN-Chatbot |
|---|---|---|---|---|
| Text → BPMN via LLM | Yes (orchestrator + modeler agent) | Yes (POWL) | Yes (JSON intermediate) | Yes (JSON intermediate) |
| **Multi-pool collaboration + message flows** | **Yes** ([multi-pool-collaboration.expected.bpmn](tests/fixtures/multi-pool-collaboration.expected.bpmn)) | Yes (POWL-based) | **No** (BPMN Auto Layout limitation, paper §6) | Unclear (no public repo) |
| **Lane support** | **Yes, multi-lane per pool** ([sparse-lanes.expected.bpmn](tests/fixtures/sparse-lanes.expected.bpmn) — 4 lanes) | Yes (paper) | Limited | Unclear |
| Soundness check | Workflow-Net (WF01–WF03), 3 rules | POWL-by-construction (mathematical guarantee) | None documented | None documented |
| Configurable rule engine | **Yes** (27 rules, 4 layers, JSON profiles) | Limited | None | None |
| Schema-strict input gate | **Yes** (ajv draft-2020-12, [schema-gate.js](scripts/schema-gate.js)) | N/A | Loose | Loose |
| Stack | Node.js / ES Modules | Python / Streamlit | Python + Vue.js | React + OpenAI |
| License | MIT | GPL-3.0 | MIT-ish | Unclear |
| MCP server | **Yes** ([mcp-bpmn-server.js](scripts/mcp-bpmn-server.js)) | No | No | No |
| Live demo | Pending (v3.5) | streamlit.app | onrender.com | None |
| Paper | None (engineering project) | IJCAI-24, EMMSAD 2024 (Kourani et al.) | arXiv 2509.24592 (2025) | CEUR-WS Vol-3758 |
| Last commit (2026-05) | This repo | Active | Active | Inactive / unknown |

### Stieges differentiation, in one sentence

The only BPMN-from-LLM generator that (a) renders multi-pool collaborations with lane structure and inter-pool message flows out of the box, (b) ships a strict JSON-Schema gate so LLM output can't sneak malformed Logic-Core into the pipeline, and (c) exposes itself as a Claude Code MCP server.

### Where competitors are stronger

- **ProMoAI** offers Soundness as a sprachlich-by-construction guarantee (POWL), which is mathematically cleaner than our after-the-fact rule engine. Their academic provenance is also stronger (Kourani et al., peer-reviewed). If you're publishing a paper, they're the better fit.
- **BPMN Assistant** has a polished web UI and is the easier first-touch product if you just want to try generating diagrams. Our UI is library / API / MCP — no live web demo yet.

### What this matrix does NOT claim

- That Stieges outperforms ProMoAI on extraction accuracy (we haven't benchmarked against ProMoAI's eval set — that's deferred to a future evaluation).
- That `bpmn-auto-layout` is broken — the upstream README is explicit about its scope. We benchmarked it because BPMN Assistant uses it; the limitation matters there, not in bpmn-auto-layout itself.
- That every BPMN file we produce renders perfectly. Known issues are tracked (currently: label overlap, deferred to v3.5).
