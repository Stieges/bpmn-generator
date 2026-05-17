# Pipeline Robustness Stack — Implementation Documentation

> **Branch:** `feature/robustness-stack`
> **Status:** Implementation complete (37 commits, 208 tests + 1 skipped fixture-loader)
> **Inspired by:** Soliman et al. (2025) "Size matters less: how fine-tuned small LLMs excel in BPMN generation" (DOI: 10.1186/s43067-025-00288-9) — inverted: where the paper trains an SLM to *produce* BPMN, this stack uses an existing strong LLM to *probe* the pipeline that *consumes* BPMN inputs.

---

## 1 What This Is

The Pipeline Robustness Stack is a **JS-only offline tool** that uses a configured sovereign or third-party LLM endpoint to stress-test the existing BPMN-Generator pipeline (`runPipeline()`) with synthetically generated inputs. Failures are triaged into buckets, deduplicated by fingerprint, persisted as regression fixtures, and aggregated into Markdown + JSON reports. The pipeline itself is **never modified**; the stack is a wrapper that feeds inputs and observes outputs.

### One-line summary

> Generate synthetic process descriptions and Logic-Core JSON via LLM, feed them through the existing pipeline, catch every way the pipeline breaks, and turn each failure into a persistent regression test.

### Why this exists

The existing pipeline has 145 tests built from hand-crafted fixtures. Hand-written tests cover what humans think to test, but they miss the edge cases LLMs naturally generate. Every BPMN diagram in production comes from an LLM (Claude in the SKILL, or any LLM via the orchestrator). So the production input distribution is shaped by LLM outputs — and a fuzzer that uses an LLM to generate inputs matches that distribution far better than any hand-curated suite.

Each failure the stack discovers becomes a permanent fixture under `tests/fixtures/robustness/auto/`. The regression test `scripts/robustness.test.js` loads all auto-fixtures dynamically. After a run, you fix the bugs the stack found, the tests turn green, and the stack has made the pipeline measurably more resilient.

---

## 2 High-level Architecture

```
┌────────────────────── EXISTING PIPELINE (UNCHANGED) ──────────────────────┐
│   Logic-Core JSON → Validate → ELK Layout → BPMN-XML + SVG                │
│                          ▲                                                │
└──────────────────────────┼────────────────────────────────────────────────┘
                           │ runPipeline(lc) called as-is
                           │
        ┌──────────────────┴──────────────────────────────────┐
        │       ROBUSTNESS STACK (NEW, scripts/robustness/)   │
        │                                                     │
        │  ┌─────────────────────────────────────────────┐    │
        │  │ 1. SEED CATALOG                             │    │
        │  │    540 cells (6 domains × 3 complexity ×    │    │
        │  │    6 patterns × 5 stress modes)             │    │
        │  └─────────────────────────────────────────────┘    │
        │                  │                                  │
        │  ┌───────────────▼─────────────────────────────┐    │
        │  │ 2. SYNTHETIC GENERATOR                      │    │
        │  │    LLM call A: description (German prose)   │    │
        │  │    LLM call B: structure (LC-JSON | DOT)    │    │
        │  └─────────────────────────────────────────────┘    │
        │                  │                                  │
        │  ┌───────────────▼─────────────────────────────┐    │
        │  │ 3. STRESS TESTER                            │    │
        │  │    Phase A: pre-filter (schema + rules)     │    │
        │  │    Phase B: runPipeline() + roundtrip       │    │
        │  └─────────────────────────────────────────────┘    │
        │                  │                                  │
        │  ┌───────────────▼─────────────────────────────┐    │
        │  │ 4. FAILURE CLASSIFIER                       │    │
        │  │    Category + bucket + SHA-256 fingerprint  │    │
        │  └─────────────────────────────────────────────┘    │
        │                  │                                  │
        │  ┌───────────────▼─────────────────────────────┐    │
        │  │ 5. FIXTURE PERSISTER                        │    │
        │  │    auto/  triage/  llm-signal/ (gated)      │    │
        │  │    dismissed.log audit trail                │    │
        │  └─────────────────────────────────────────────┘    │
        │                  │                                  │
        │  ┌───────────────▼─────────────────────────────┐    │
        │  │ 6. REPORT GENERATOR                         │    │
        │  │    Markdown + JSON, drift detection         │    │
        │  └─────────────────────────────────────────────┘    │
        └─────────────────────────────────────────────────────┘
```

### Coupling constraints (per spec)

- **Zero changes** to `pipeline.js`, `rules.js`, `layout.js`, `coordinates.js`, `bpmn-xml.js`, `svg.js`
- **Zero changes** to `agents/llm-provider.js` (consumed via existing `createLlmProvider({ baseUrl, apiKey, model, timeout })`)
- **Consumes only:** `runPipeline()`, `runRules()`, `validateLogicCore()`, `bpmnToLogicCore()`, `dotToLogicCore()`
- **Produces only:** new test fixtures (auto-discovered via glob) and reports under `tests/`

---

## 3 Directory Layout

```
scripts/
├── pipeline.js                          (unchanged)
├── rules.js                             (unchanged)
├── validate.js                          (unchanged)
├── import.js                            (unchanged)
├── dot.js                               (unchanged)
├── agents/
│   └── llm-provider.js                  (unchanged — consumed via createLlmProvider)
│
├── robustness/                          (NEW — the sidecar)
│   ├── README.md                        Workflow doc + quick start
│   ├── config.json                      Model, paths, flags, cost cap
│   ├── seed-catalog.json                540-cell generation matrix
│   ├── cli.js                           CLI entry (run | smoke-test | triage | mad-check | report)
│   ├── synthetic-generator.js           Two-step prompting, sample assembly
│   ├── stress-tester.js                 preFilter + runPipelineChecks + runRoundtripCheck + runStressTest
│   ├── failure-classifier.js            classify() + computeFingerprint() (SHA-256)
│   ├── fixture-persister.js             persistFailure() with bucket routing + dedup + llm-signal gate
│   ├── report-generator.js              generateReport() + computeDrift()
│   ├── graph-isomorphism.js             toAdjacencyList() (format-tolerant), canonicalSignature(), isStructurallyEqual()
│   ├── mad-validator.js                 runMadCheck() — external sanity against MaD subset
│   └── curate-mad.js                    One-shot script for initial MaD subset curation
│
├── robustness.test.js                   (NEW) Dynamic loader: each auto/ fixture = 1 regression test
├── robustness-internal.test.js          (NEW) ~45 unit + integration tests for the stack itself
└── pipeline.test.js                     (unchanged, 136 existing tests)

tests/
├── fixtures/                            (existing, unchanged)
│   ├── robustness/                      (NEW)
│   │   ├── auto/        → auto-persisted regression fixtures
│   │   │   └── .gitkeep
│   │   ├── triage/      → manual-review queue
│   │   │   └── .gitkeep
│   │   ├── llm-signal/  → gated bucket (default OFF)
│   │   │   └── .gitkeep
│   │   ├── README.md    Explains the buckets
│   │   └── dismissed.log (created on first dismiss)
│   ├── mad-subset/      → curated MaD subset (populated by curate-mad.js)
│   └── mad-subset-test/ → 2 hand-crafted .dot files for hermetic tests
└── robustness-reports/                  (NEW) Run artifacts (.md + .json)
    └── .gitkeep

docs/
├── superpowers/
│   ├── specs/
│   │   ├── 2026-05-16-pipeline-robustness-via-synthetic-data-design.md
│   │   └── 2026-05-16-layout-reviewer-agent-design.md (companion: M1 revival)
│   └── plans/
│       └── 2026-05-16-pipeline-robustness-via-synthetic-data.md (3364 lines, 35 tasks)
└── ROBUSTNESS-STACK.md (this document)
```

---

## 4 Module Reference

### 4.1 `seed-catalog.json`

Defines the generation space as a Cartesian product of four dimensions:

| Dimension | Values |
|---|---|
| Domains | procurement, hr-onboarding, claims, incident-mgmt, loan-approval, order-fulfillment (6) |
| Complexity | simple (5–10 nodes, 0 gateways), medium (10–25, 2), complex (25–50, 5) |
| Patterns | four-eyes, escalation, compensation, event-subprocess, pools-collaboration, ad-hoc (6) |
| Stress modes | normal, deep-nesting, wide-parallelism, many-lanes, edge-label-density (5) |

Total: **6 × 3 × 6 × 5 = 540 cells.** A typical run samples 100 cells uniformly.

### 4.2 `synthetic-generator.js`

Produces `Sample` records via **two-step prompting**:

1. **Description prompt** (`buildDescriptionPrompt`): Asks the LLM for a 200–400 word German enterprise process description parameterized by `(domain, complexity, pattern, stress_mode)`.
2. **Structure prompt** (`buildLcJsonPrompt` or `buildDotPrompt`): Takes the description plus either the Logic-Core JSON schema (`references/input-schema.json`) or a DOT cheat-sheet, asks the LLM for structured output.

Why two steps: one-shot prompts are less steerable. Splitting lets us see whether failures stem from description quality or schema-mapping. Token cost is irrelevant on FREE-tier sovereign endpoints.

**Key exports:** `enumerateCells`, `sampleCells` (Mulberry32 seeded PRNG, deterministic), `buildDescriptionPrompt`, `buildLcJsonPrompt`, `buildDotPrompt`, `extractJson` (three-strategy fallback parser), `extractDot`, `formatSampleId`, `buildSample`, `generateSamples` (orchestrator).

**Sample ID format:** `{domain}__{complexity}__{pattern}__{stress}__{seq}` with `__` separator (so hyphenated domain names like `hr-onboarding` remain unambiguously parseable). Example: `hr-onboarding__medium__four-eyes__wide-parallelism__042`.

### 4.3 `stress-tester.js`

Two-phase execution per sample.

**Phase A: `preFilter(lc)` — inline pre-filter**

| Step | API | On failure |
|---|---|---|
| Schema validation | `validateLogicCore(lc)` from `scripts/validate.js` | Stop, return `{passed: false, schemaErrors, …}` |
| Rule engine | `runRules(lc)` from `scripts/rules.js` (default profile) | Only ERROR-level fails; WARNING-level passes through |

Schema and rule errors mean the LLM produced garbage. These don't go to the pipeline at all — they're routed to `llm-signal/` (gated).

**Phase B: `runPipelineChecks(lc, opts)` — pipeline + 5 checks**

The pipeline is invoked once via `runPipeline(lc)` (with timeout via `Promise.race`), and the result inspected:

| Check | Failure category |
|---|---|
| Pipeline threw | `pipeline-throw` → category inferred (`elk-error` / `xml-malform` / `svg-render-issue`) |
| `validation.errors.length > 0` | `elk-or-xml` |
| `bpmnXml` missing | `xml` |
| `svg` missing | `svg` |
| `Promise.race` timeout | `timeout` |

**Roundtrip: `runRoundtripCheck(lc, bpmnXml)`**

Parses the generated XML back through `bpmnToLogicCore` (existing) and compares with `isStructurallyEqual` from `graph-isomorphism.js`. Format-tolerant comparison handles the real-world legacy/modern format mix in the existing codebase (see §6.3 below).

**Top-level: `runStressTest(samples, opts)`** orchestrates pre-filter → pipeline → roundtrip per sample, sequentially.

### 4.4 `failure-classifier.js`

Maps each non-pass result to `{ category, bucket, fingerprint, evidence }`.

| Category | Trigger | Bucket |
|---|---|---|
| `pass` | No failure | (none, no persist) |
| `schema-violation` | Pre-filter A.1 fail | `llm-signal/` (gated) |
| `rule-violation` | Pre-filter A.2 fail | `llm-signal/` (gated) |
| `elk-error` | Pipeline throw (or inferred from error message) | `auto/` |
| `xml-malform` | XML missing or unparseable | `auto/` |
| `svg-render-issue` | SVG missing or `svg.js` threw | `auto/` |
| `timeout` | Pipeline > timeout | `auto/` |
| `roundtrip-break` | Roundtrip not structurally equal | `auto/` |
| `unknown` | Unmatched fallback | `triage/` |

**Fingerprint:** `SHA-256(category | canonicalised-error | structural-signature)` truncated to 8 hex chars. Canonicalisation strips memory addresses (`0x...` → `0xADDR`) and line/col numbers (`:42:7` → `:LINE:COL`) so the same bug produces the same fingerprint regardless of stack trace details. Dedup key: same fingerprint → only one fixture persisted, but `meta.seen` incremented.

### 4.5 `fixture-persister.js`

Writes failure records to bucket directories with dedup.

```js
persistFailure(record, sample, { fixtureRoot, persistLlmSignal })
  → { wrote: 'new' | 'dedup' | 'skipped-gated' | 'skipped-no-bucket', bucket, fingerprint }
```

**Outputs per failure:**
- `tests/fixtures/robustness/{bucket}/{category}-{fingerprint}.json` — the Logic-Core JSON that triggered the bug
- `tests/fixtures/robustness/{bucket}/{category}-{fingerprint}.meta.json` — `{ fingerprint, category, first_seen, last_seen, seen, description, model, target, evidence }`

**`llm-signal/` gate:** default OFF. Activated by `--persist-llm-signal` CLI flag or `config.persist_llm_signal: true`. When OFF, `schema-violation` and `rule-violation` results are aggregated in the report but not written as fixtures — they're LLM-quality signal, not pipeline bugs.

### 4.6 `report-generator.js`

Aggregates run results into Markdown + JSON.

```js
generateReport(runMeta, classifiedResults)
  → { markdown, json: { runMeta, totals, byCategory, newFixturesByCategory, fingerprints, drift } }
```

**Markdown sections:**
- Header (model, target, duration, totals + pass rate)
- Per-target breakdown (only when `--target=both`)
- "Failures by Category" table with new-fixture counts
- "External Sanity Check (MaD subset)" (only when `--with-mad`)
- "Drift vs Previous Run" (only when prior report referenced)

**`computeDrift(previous, current)`** compares fingerprint sets:
- New fingerprints → regressions (⚠️)
- Closed fingerprints → fixes (✅)
- First run → short-circuit, no drift section

### 4.7 `graph-isomorphism.js`

Structural equality check for Logic-Core JSON. Approximate (no full VF2) — sufficient for ≤50 nodes.

**`toAdjacencyList(lc)`** is **format-tolerant** — handles three real formats found in the codebase:

| Format | Shape | Source |
|---|---|---|
| Modern pooled | `{ pools: [{ lanes: [{ nodes: [] }] }], flows }` | Some test fixtures |
| Project default | `{ pools: [{ nodes: [], lanes: [] }], flows }` | Real `Logic-Core` schema |
| Legacy flat | `{ id, nodes, edges, lanes }` (no `pools` key) | `bpmnToLogicCoreLegacy` fallback in `import.js` |

This format-tolerance was added in Task 3.5 after the implementer discovered `bpmnToLogicCore` returns the legacy flat format on some XMLs. The spec had documented a phantom "modern" format that doesn't actually exist consistently in the codebase. Rather than fix `import.js` (out of scope per failure-isolation principle), we made the adjacency builder accept all three.

**`canonicalSignature(lc)`** produces a deterministic string: `pools=N|lanes=N|edges=N|types=[sorted,csv]`. Same structure → same signature regardless of node ordering.

**`isStructurallyEqual(lcA, lcB)`** returns `{ equal: bool, delta: { a/b counts per dimension } | null }`.

### 4.8 `mad-validator.js`

External sanity check. Runs a curated MaD subset through the pipeline and reports pass rate by `failedStep`. Used to detect if the synthetic generator has drifted toward unrealistic-easy inputs (if MaD pass rate is much worse than synthetic pass rate, something's off).

```js
runMadCheck({ subsetDir = 'tests/fixtures/mad-subset', limit = Infinity })
  → { total, passed, failed, byCategory }
```

The MaD subset itself is curated by the one-shot `curate-mad.js` script, which requires the raw MaD dataset (request from Soliman et al. 2025 authors or check HF mirrors).

### 4.9 `cli.js`

CLI entry. Resolves env vars + flags, constructs LLM provider, dispatches commands.

**Resolution precedence:** CLI flag > env var (default name from config: `AIHUB_URL` / `AIHUB_KEY`) > static value in `config.json` > `'none'` (for local-mode LLMs).

**Subcommands:**

| Command | Purpose |
|---|---|
| `run --n=N --target=lc-json\|dot\|both [--with-mad] [--persist-llm-signal]` | Stress run with N samples |
| `smoke-test` | Single live LLM call to verify endpoint connectivity |
| `triage` | Interactive REPL (promote / dismiss / defer items in `triage/`) |
| `mad-check [--limit=N]` | Run MaD subset against pipeline |
| `report --since=DATE` | Aggregate previous run reports (placeholder) |

---

## 5 A Concrete Run — Step by Step

Command: `AIHUB_URL=... AIHUB_KEY=... node scripts/robustness/cli.js run --n=100 --target=lc-json`

### Step 1 — Bootstrap (instant)
- Load `seed-catalog.json` (540 cells) and `config.json`
- Resolve endpoint: `baseUrl=$AIHUB_URL, apiKey=$AIHUB_KEY, model=qwen-3.5-122b-sovereign`
- Construct `llm = createLlmProvider({ baseUrl, apiKey, model })`
- Create `tests/robustness-reports/` if missing

### Step 2 — Generation (~5–10 min on FREE sovereign, sequential)
For each of 100 sampled cells, two LLM calls:
- Description gen → ~300 tokens out, plausible German business prose
- Structure gen → ~1500 tokens out, Logic-Core JSON conforming to schema

Output: `[Sample]` of ~85–95 records (some dropped because LLM output unparseable).

### Step 3 — Stress test (~30–60 sec)
Per sample:
- Pre-filter (schema + rules) → pass/fail
- If fail → categorize as schema/rule violation, skip pipeline
- If pass → run pipeline, roundtrip, OMG compliance check
- Classify failures, compute fingerprint

### Step 4 — Persist
- `auto/` and `triage/` written immediately
- `llm-signal/` skipped (gated off by default)
- Dedup: existing fingerprint → only `meta.seen` incremented

### Step 5 — Report
Markdown + JSON written to `tests/robustness-reports/2026-05-17-qwen-3.5-122b-sovereign-n100.md`:

```markdown
# Robustness Run — 2026-05-17

Model: qwen-3.5-122b-sovereign  Target: lc-json  Duration: 423s
Total samples: 89  Pass: 67 (75%)  Fail: 22

## Failures by Category

| Category | Count | New Fixtures |
|---|---|---|
| roundtrip-break | 11 | 4 |
| elk-error | 6 | 3 |
| xml-malform | 3 | 2 |
| svg-render-issue | 2 | 1 |

## Drift vs Previous Run
- ⚠️ New fingerprints: a3f9c2, b14d77, c8e1d4
- ✅ Closed fingerprints: e7d291 (fixed by commit abc123)
```

### Step 6 — Iterate
- Read fixtures in `tests/fixtures/robustness/auto/`
- Fix the bug in the pipeline (the bug is real — the LLM produced a legitimate Logic-Core JSON and the pipeline failed)
- The corresponding test in `scripts/robustness.test.js` turns green
- Next run reports the fingerprint as ✅ closed

---

## 6 Key Design Decisions + Rationale

### 6.1 Why a sidecar, not a modification?

The existing pipeline has 145 tests and serves the CLI, MCP server, HTTP API, and Multi-Agent Orchestrator. Touching it risks regressions across all those surfaces. The robustness stack is an **observer** — it generates inputs, observes outputs, never mutates the pipeline. This means the stack can be developed, tested, deleted, or replaced without affecting any production code path.

### 6.2 Why two-step prompting (description, then structure)?

A one-shot "generate a BPMN diagram for procurement with four-eyes" gives the LLM too much latitude. Splitting forces it to commit to a description first, then translate to structure — closer to how humans model processes. Failures in step 1 (LLM doesn't follow the cell parameters) are visible as "weird descriptions"; failures in step 2 (LLM produces non-schema JSON) are visible as "schema-violation" entries. The 2× token cost is irrelevant on a FREE-tier sovereign endpoint.

### 6.3 Why the format-tolerant adjacency builder?

While building the stack, we discovered that `bpmnToLogicCore` (the existing XML importer) returns a **legacy flat format** in some cases — not the `{pools, flows}` format the spec assumed. Three formats coexist in the codebase. Per the failure-isolation principle, the robustness stack adapts to the existing reality rather than mutating `import.js`. The fix: `toAdjacencyList` detects format and flattens all three into a common structure. This kind of cross-format hazard is exactly what the stack should surface — and arguably already has, just not as an "auto-bucket" failure but as a design-doc clarification.

### 6.4 Why three buckets + audit log, not one?

The naive design was "every failure becomes a regression test". That fails for `schema-violation` and `rule-violation` — those mean the LLM produced garbage, not that the pipeline is broken. Routing them to `auto/` would mean every flaky LLM output becomes a permanent test, drowning real bugs in noise. The three-bucket model separates concerns:

- `auto/` — unambiguous pipeline bugs (LLM made sense, pipeline broke)
- `triage/` — ambiguous cases needing human judgment
- `llm-signal/` — LLM quality signal (off by default, valuable later when fine-tuning)
- `dismissed.log` — audit trail of `triage` items dismissed as "not a bug"

### 6.5 Why fingerprint dedup?

Without dedup, one underlying bug triggered by 12 different LLM-generated samples would produce 12 fixture files. The auto-loader would create 12 failing tests for the same bug, all fixed by the same patch — pure noise. Fingerprint = `SHA-256(category | canonicalised-error | structural-signature)`. Canonicalisation strips ephemeral parts (memory addresses, line numbers) so the same underlying issue under different stack traces collapses to one fingerprint. Dedup turns "100 raw failures" into "5 unique bugs to fix."

### 6.6 Why DOT mode is configurable, not default?

DOT mode was added in Phase 5 as an opt-in (`--target dot`). Reasons it's not the default:
- The existing `dot.js` parser is a **subset parser** (per CLAUDE.md known limitations) — only guaranteed to round-trip its own `logicCoreToDot` output. LLM-generated DOT will likely have a high parse-fail rate on first runs.
- LC-JSON mode tests the *real* pipeline path that production uses. DOT-via-`dotToLogicCore` is a different code path.
- Running both (`--target both`) is supported for paper-parity comparison runs.

### 6.7 Why provider-pluggable, not AI-Hub-only?

The stack consumes `createLlmProvider({ baseUrl, apiKey, model, timeout })` — the existing OpenAI-compatible abstraction. Pointing it at the AI Hub uses sovereign Qwen at FREE pricing. Pointing it at `https://api.openai.com/v1` uses GPT-4o at OpenAI prices. Pointing it at `http://localhost:11434/v1` uses local Ollama. The stack doesn't care. This matches the project's existing pattern in `evaluate-slm.js` and `http-server.js`.

### 6.8 Why max iterations / cost cap?

Two safety mechanisms in the spec, not in code yet:
- Sequential generation per sample is bounded (one for-loop, no recursion)
- A `timeout_seconds` config (default 30) caps any single pipeline call
- Cost cap is documented but not enforced — the stack runs on FREE-tier by default. Cap becomes important only when someone configures it against paid endpoints.

---

## 7 Phase-by-Phase Implementation History

The implementation followed a detailed plan in `docs/superpowers/plans/2026-05-16-pipeline-robustness-via-synthetic-data.md` (3364 lines, 35 tasks). Each task was implemented by a fresh subagent following TDD (write failing test, run it, implement, run it again, commit).

### Phase 1 — Foundation (5 tasks)

| Task | Result |
|---|---|
| 1.1 Scaffold directories + config + READMEs | Commit `45cd2a8` |
| 1.2 CLI arg-parsing skeleton | Commit `f9c336b` |
| 1.3 Tests for env/flag precedence | Commit `a27a23d` (8 tests) |
| 1.4 LLM provider smoke-test | Commit `f83c6e4` |
| 1.5 Verify existing 145 tests still pass | Confirmed |

### Phase 2 — Generation (6 tasks)

| Task | Result |
|---|---|
| 2.1 Seed catalog + `enumerateCells` | Commit `39f0a6b` |
| 2.2 `sampleCells` with Mulberry32 PRNG | Commit `05ccd6e` |
| 2.3 `buildDescriptionPrompt` | Commit `408d0ac` |
| 2.4 `buildLcJsonPrompt` + `extractJson` | Commit `08c70a9` |
| 2.5 `formatSampleId` + `buildSample` | Commit `e9ea85c` |
| 2.6 End-to-end `generateSamples` | Commit `0e396b2` |

### Phase 3 — Stress + Classify (8 tasks)

| Task | Result |
|---|---|
| 3.1 `toAdjacencyList` | Commit `cdf0ec4` |
| 3.2 `canonicalSignature` + `isStructurallyEqual` | Commit `475c93b` |
| 3.3 `preFilter` (schema + rules) | Commit `324e134` |
| 3.4 `runPipelineChecks` with timeout | Commit `8487896` |
| 3.5 `runRoundtripCheck` (unblocked by adding format-tolerance) | Commit `a975aa6` |
| 3.6 `runStressTest` orchestration | Commit `04a79b2` |
| 3.7 `classify` with category routing | Commit `c55743b` |
| 3.8 `computeFingerprint` (SHA-256) | Commit `6b51d1b` |

**Notable event:** Task 3.5 blocked on a real format mismatch (legacy vs modern Logic-Core in `import.js`). The implementer correctly stopped and reported BLOCKED rather than weakening the test. A follow-up dispatch added format-tolerance to `toAdjacencyList`, unblocking the task. This is the failure-isolation principle in action — discover the issue, document it, route around it, don't mutate the upstream module.

### Phase 4 — Persist + Report (8 tasks)

| Task | Result |
|---|---|
| 4.1 `persistFailure` with dedup | Commit `1c8e32d` |
| 4.2 LLM-signal gate tests | Commit `e4f5ac6` |
| 4.3 `generateReport` Markdown + JSON | Commit `9b17910` |
| 4.4 `computeDrift` + drift section | Commit `383f5a5` |
| 4.5 `robustness.test.js` auto-loader | Commit `bdac81f` |
| 4.6 `cli run` end-to-end wiring | Commit `1982a12` |
| 4.7 Full integration smoke test | Commit `749f851` |
| 4.8 `triage` interactive CLI | Commit `4b07bfd` |

### Phase 5 — DOT mode (3 tasks)

| Task | Result |
|---|---|
| 5.1 DOT prompt + `extractDot` | Commit `5a99a94` |
| 5.2 `generateSamples` DOT branch via `dotToLogicCore` | Commit `7eb246f` |
| 5.3 CLI `--target` flag (lc-json/dot/both) | Commit `210980f` |

### Phase 6 — MaD sanity (5 tasks)

| Task | Result |
|---|---|
| 6.1 `curate-mad.js` one-shot script | Commit `1456f9e` |
| 6.2 `mad-validator` + tiny hermetic fixture | Commit `e54f1a1` |
| 6.3 CLI `mad-check` subcommand | Commit `d8274db` |
| 6.4 MaD report section + `--with-mad` flag | Commit `56f6342` |
| 6.5 README MaD usage | Commit `55102d6` |

### Companion deliverable

| Spec | Result |
|---|---|
| Pipeline robustness design | Commit `d6fec3e` |
| Pipeline robustness plan | Commit `c60a059` |
| Layout Reviewer Agent (M1 revisited) design | Commit `399c657` |

The Layout Reviewer spec was brainstormed during this work but its implementation was deferred. It uses the same provider-pluggable pattern (`createLlmProvider` for text + `createVisionProvider` for vision-LLMs). When implemented, it will revive ROADMAP item M1 (Layout Feedback Loop) with deterministic action-mapping driven by a text-LLM SVG reviewer plus optional vision-LLM perceptual scoring.

---

## 8 How To Use

### One-time setup

```bash
# Export credentials for the LLM endpoint (any OpenAI-compatible provider)
export AIHUB_URL=https://...        # the chat-completions endpoint
export AIHUB_KEY=...                # API key (or 'none' for local Ollama)
```

### Verify connectivity

```bash
node scripts/robustness/cli.js smoke-test
# → "[smoke-test] reply: pong" (or whatever the LLM says)
```

### Run a stress pass

```bash
# Default: 100 samples, lc-json target, sovereign model
node scripts/robustness/cli.js run --n=100

# DOT target for paper-parity comparison
node scripts/robustness/cli.js run --n=50 --target=dot

# Both targets, 200 samples total, with MaD sanity check appended
node scripts/robustness/cli.js run --n=200 --target=both --with-mad

# Targeted run: only sample cells matching a predicate (programmatic)
node scripts/robustness/cli.js run --n=20 --strategy=targeted --category=elk-error

# Enable LLM-signal persistence for future SLM training data collection
node scripts/robustness/cli.js run --n=100 --persist-llm-signal
```

### Review the report

```bash
cat tests/robustness-reports/$(ls -t tests/robustness-reports/*.md | head -1)
```

### Triage ambiguous failures

```bash
node scripts/robustness/cli.js triage
# Interactive REPL:
# > promote 3    → moves to auto/, becomes a failing regression test
# > dismiss 5    → deletes + appends to dismissed.log
# > defer 7      → leaves for later
# > quit
```

### Fix bugs, watch tests turn green

```bash
# After implementing a fix:
cd scripts && npm test
# Robustness Regression test names become green one by one as you fix bugs.
```

### One-time MaD curation (when dataset is acquired)

```bash
node scripts/robustness/curate-mad.js --src ~/Downloads/mad-raw.jsonl --n 200
# → writes 200 .dot files + index.json to tests/fixtures/mad-subset/
# Then commit those fixtures.
```

---

## 9 Companion: Layout Reviewer Agent (Spec Only)

A separate spec was brainstormed and committed in this branch but not implemented: `docs/superpowers/specs/2026-05-16-layout-reviewer-agent-design.md`. It revives ROADMAP item M1 (Layout Feedback Loop) and complements the robustness stack:

- **Robustness stack:** detects pipeline failures (what the pipeline can't handle)
- **Layout Reviewer Agent:** improves pipeline outputs (makes valid outputs look better)

The Layout Reviewer would:
1. Read the SVG-as-text via a text-LLM and identify 5 issue types (overlap, edge-label-overlap, edge-crossings, lane-too-narrow, aspect-imbalance)
2. Apply deterministic action-mapping to ELK options
3. Re-run the pipeline (max 2 iterations)
4. Optionally request a vision-LLM perceptual score at the end

Implementation deferred. When picked up, expected ~120 new hermetic tests + 1 opt-in live smoke.

---

## 10 Limitations & Known Issues

1. **`bpmnToLogicCore` returns mixed formats.** The legacy/modern format split in `import.js` was discovered during Task 3.5. The robustness stack adapts (format-tolerant adjacency), but a future cleanup of `import.js` to consistently return the modern format would simplify the codebase.

2. **`dot.js` parser is a subset parser.** Only `logicCoreToDot` output is guaranteed to round-trip. LLM-generated DOT will have parse failures — expected and handled (`dot-parse-fail` category). High failure rates here flag dot.js as a candidate for hardening.

3. **Graph-isomorphism is approximate.** Canonical-sort-based comparison is sufficient for ≤50 nodes (typical sample size) but can produce false positives for very large structurally-different graphs that happen to have the same type histogram. Documented as risk R3 in the spec; upgrade path is full VF2.

4. **No parallelism by default.** `parallelism: 1` in config. Higher parallelism requires atomic fixture writes (currently not implemented) per spec risk R7. The stack handles this gracefully — never goes above 1 until the code is added.

5. **MaD dataset acquisition is manual.** `curate-mad.js` is ready, but requires the raw dataset from Soliman et al. 2025 authors or HF mirrors.

6. **Cost cap defined but not enforced.** `config.layoutReviewMaxCostCents` exists for the Layout Reviewer spec. The robustness stack itself relies on FREE-tier defaults; cost cap enforcement would be added when running against paid endpoints.

7. **Triage CLI is minimal.** Text-based REPL, no TUI. Sufficient for the expected volume; a richer UI is future work.

8. **No CI auto-runs.** The stack is manual-trigger only. CI integration (e.g., nightly run, results as PR comments) is deferred to a follow-up spec.

---

## 11 Test Inventory (Final)

```
$ cd scripts && npm test
```

| Suite | Tests | Notes |
|---|---|---|
| `pipeline.test.js` | 136 | Pre-existing, all unchanged, all passing |
| `orchestrator.test.js` | 22 | Pre-existing, all unchanged, all passing |
| `robustness-internal.test.js` | 50 | NEW — unit + integration tests for the stack |
| `robustness.test.js` | 1 (skipped) | NEW — dynamic loader; skips when no auto-fixtures present |
| **Total** | **209** | **208 passing + 1 skipped** |

The single skipped test is by design — it skips when the `auto/` directory is empty (initial state). After a real run finds and persists fixtures, the skip resolves and each fixture becomes a failing test until the underlying bug is fixed.

---

## 12 What's Next

Recommended sequence:

1. **Wire AI Hub credentials in `.env` or shell, run `smoke-test`** to verify the endpoint
2. **First real run: `node scripts/robustness/cli.js run --n=10`** for a quick smoke
3. **Review the report** under `tests/robustness-reports/`
4. **Triage the first batch of findings** — most early findings will be real bugs that escaped the hand-written test suite
5. **Fix the bugs**, watch `npm test` go from "1 skipped" to "X passed, 1 skipped" as fixtures resolve
6. **Larger run: `node scripts/robustness/cli.js run --n=100`** once the obvious bugs are fixed
7. **Implement the Layout Reviewer Agent** (separate spec, separate branch) once robustness is stable
8. **Acquire and curate the MaD subset** for external validation against published metrics
9. **CI integration** (follow-up spec) — nightly run, PR comments, automated triage

The stack is built to be re-run repeatedly. Each run finds fewer new failures as the pipeline matures. This is the intended trajectory.

---

## 13 References

- **Soliman, G.; Wars, N. A.; Hesham, H. (2025).** "Size matters less: how fine-tuned small LLMs excel in BPMN generation." *Journal of Electrical Systems and Information Technology* 12:95. DOI: [10.1186/s43067-025-00288-9](https://doi.org/10.1186/s43067-025-00288-9). Inspiration for the synthetic-data approach and the MaD dataset reference.
- **MaD dataset** — 30k description-DOT pairs across 15 business domains, cited in Soliman et al. 2025. Subset to be curated for `tests/fixtures/mad-subset/`.
- **Internal:**
  - `ROADMAP.md` Section 8 — established research references
  - `references/input-schema.json` — Logic-Core JSON schema consumed by pre-filter and structure-gen prompt
  - `references/omg-compliance.md` — OMG BPMN 2.0.2 compliance reference
  - `CLAUDE.md` — project context
  - Spec: `docs/superpowers/specs/2026-05-16-pipeline-robustness-via-synthetic-data-design.md`
  - Plan: `docs/superpowers/plans/2026-05-16-pipeline-robustness-via-synthetic-data.md`
  - Companion spec: `docs/superpowers/specs/2026-05-16-layout-reviewer-agent-design.md`
