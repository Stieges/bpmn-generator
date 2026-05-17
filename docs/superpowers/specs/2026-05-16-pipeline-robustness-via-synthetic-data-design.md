# Pipeline Robustness via Synthetic Data — Design

**Date:** 2026-05-16
**Status:** Draft (post-brainstorm, post-review)
**Owner:** Daniel Stiegler + Claude

## 1 Goal

A JS-only offline tool that uses a configured sovereign LLM endpoint to systematically stress the BPMN-Generator pipeline (Logic-Core JSON → Validate → ELK → BPMN-XML + SVG) with synthetic inputs, triages failures into three fixture buckets plus an audit log, and drives new regression fixtures plus targeted bug fixes — making the pipeline progressively more resilient to LLM-generated inputs.

The tool is inspired by Soliman et al. (2025), but the goal is inverted: where the paper trains an SLM to *produce* BPMN, this project uses an existing strong LLM to *probe* the pipeline that *consumes* BPMN-flavored inputs.

## 2 Scope

### In scope

- Synthetic input generation (description + Logic-Core JSON pairs) via a configurable sovereign LLM endpoint
- Stress-tester that runs each generated sample through the full pipeline plus a roundtrip check
- Triage model: three fixture buckets (`auto/`, `triage/`, `llm-signal/` gated) plus an audit log (`dismissed.log`)
- Markdown + JSON reports with drift detection across runs
- Graph-isomorphism roundtrip check (LC → BPMN-XML → LC' structural equivalence)
- MaD-dataset sanity check via a curated subset
- Both LC-JSON-target and DOT-target generation modes (configurable)
- Internal tests for the robustness tooling itself

### Out of scope

- SLM fine-tuning (separate project, ROADMAP item L1 already prepares data)
- Modeler frontend / web UI (deferred until pipeline robustness is established)
- CI auto-runs (manual triggering only; CI integration deferred to a follow-up spec)
- LLM-based auto-repair of failures (interesting future work, scope creep here)
- Any change to pipeline architecture (`pipeline.js`, `rules.js`, `layout.js`, `coordinates.js`, `bpmn-xml.js`, `svg.js`)
- Any change to `scripts/agents/llm-provider.js` (used as-is via existing `createLlmProvider` constructor)
- Replacement of existing tests in `scripts/pipeline.test.js`
- Visual-refinement work on `feature/visual-refinement` (orthogonal, continues separately)

## 3 Architecture

### 3.1 High-level diagram

```
seed-catalog ──▶ synthetic-generator ──▶ stress-tester ──▶ classifier ──▶ persister
       │                │                     │ │              │            │
       ▼                ▼                     │ ▼              ▼            ▼
   JSON-Config    llm-provider.js             │ pre-filter +  3 buckets    fixture-dirs
                  (used as-is via             │ runPipeline() + audit log   + report
                   createLlmProvider)         │ + roundtrip
                        │                     │
                        ▼                     │
                 sovereign LLM endpoint       │
                 (Qwen 3.5 122B,              │
                  EU-hosted)                  ▼
                                       runRules(), import.js,
                                       graph-isomorphism, bpmn-moddle
```

### 3.2 Directory layout

The project's existing convention is: all JS source and tests live under `scripts/` (which contains `package.json`); only fixture data lives under `tests/`. The robustness work follows this convention.

```
scripts/
├── agents/
│   └── llm-provider.js                   (UNCHANGED, used as-is)
├── robustness/                           (NEW, sidecar, all JS)
│   ├── seed-catalog.json
│   ├── synthetic-generator.js
│   ├── stress-tester.js
│   ├── failure-classifier.js
│   ├── fixture-persister.js
│   ├── report-generator.js
│   ├── mad-validator.js
│   ├── graph-isomorphism.js
│   ├── config.json
│   ├── cli.js
│   └── README.md
├── robustness.test.js                    (NEW, loads auto/ fixtures dynamically)
├── robustness-internal.test.js           (NEW, tests the tooling itself)
└── pipeline.test.js                      (unchanged, 136 tests stay)

tests/
├── fixtures/
│   ├── (existing fixtures)
│   ├── robustness/                       (NEW)
│   │   ├── auto/                         (auto-persisted regression fixtures)
│   │   ├── triage/                       (awaiting manual review)
│   │   ├── llm-signal/                   (built, flag-gated, default OFF — empty initially)
│   │   └── dismissed.log
│   └── mad-subset/                       (NEW, curated ~200 samples)
└── robustness-reports/                   (NEW, .md + .json run artifacts)
```

### 3.3 Coupling constraints

- **Zero changes** to `pipeline.js`, `rules.js`, `layout.js`, `coordinates.js`, `bpmn-xml.js`, `svg.js`
- **Zero changes** to `scripts/agents/llm-provider.js` — consumed via existing `createLlmProvider({ baseUrl, apiKey, model, timeout })` API; the AI-Hub endpoint speaks OpenAI-compatible Chat Completions, which is what the existing provider targets
- **Consumes only**: `runPipeline()`, `runRules()`, `validate.js`, `import.js`, `dot.js`, `bpmn-moddle`
- **Produces only**: new test fixtures (via glob auto-discovery) and reports

## 4 Components

### 4.1 LLM-provider integration (no code change)

The existing `scripts/agents/llm-provider.js` (from L1) exposes:

```js
import { createLlmProvider } from './agents/llm-provider.js';
const llm = createLlmProvider({ baseUrl, apiKey, model, timeout });
const response = await llm(systemPrompt, userPrompt, options);
```

The robustness CLI assembles the provider from environment variables (`AIHUB_URL`, `AIHUB_KEY`) with CLI-flag overrides, matching the project's existing pattern (see `scripts/evaluate-slm.js` and `scripts/http-server.js`):

```js
// in scripts/robustness/cli.js
const baseUrl = flag('--api-url') || process.env.AIHUB_URL || config.endpoint.url;
const apiKey  = flag('--api-key') || process.env.AIHUB_KEY || 'none';
const model   = flag('--model')   || config.model;
const llm = createLlmProvider({ baseUrl, apiKey, model, timeout: 120_000 });
```

**No dotenv dependency added** — the project uses `process.env` directly. Credentials are never logged or written to fixtures.

### 4.2 `seed-catalog.json` (configuration)

Defines the generation space.

```json
{
  "domains": ["procurement", "hr-onboarding", "claims", "incident-mgmt", "loan-approval", "order-fulfillment"],
  "complexity": {
    "simple":  { "minNodes": 5,  "maxNodes": 10, "gateways": 0 },
    "medium":  { "minNodes": 10, "maxNodes": 25, "gateways": 2 },
    "complex": { "minNodes": 25, "maxNodes": 50, "gateways": 5 }
  },
  "patterns": ["four-eyes", "escalation", "compensation", "event-subprocess", "pools-collaboration", "ad-hoc"],
  "stress_modes": ["normal", "deep-nesting", "wide-parallelism", "many-lanes", "edge-label-density"]
}
```

Cell count = 6 × 3 × 6 × 5 = 540. A typical run samples 100 cells uniformly. Catalog is hand-editable; cells can be weighted to focus a run.

### 4.3 `synthetic-generator.js` (~180 LOC)

Iterates the seed catalog, generates samples via two-step prompting.

```js
generateSamples({
  catalog,
  n,
  llm,                         // the callable from createLlmProvider
  strategy = 'uniform',        // 'uniform' | 'weighted' | 'targeted'
  target = 'lc-json',          // 'lc-json' | 'dot' | 'both'
}) => Promise<Array<Sample>>
```

**Two-step prompting** per sample:
1. *Description-gen prompt:* asks LLM for a 200–400 word German enterprise process description, parameterised by (domain, complexity, pattern, stress_mode)
2. *Structure-gen prompt:* takes the description plus the schema (Logic-Core JSON schema from `references/input-schema.json`, or DOT syntax cheat-sheet when `target='dot'`), asks LLM to produce structured output

**Why two steps:** one-shot prompts are less steerable; splitting lets us see whether failures stem from description quality or schema-mapping. Token cost is not a concern on a FREE-tier endpoint.

**DOT mode (`target='dot'`):** LLM emits DOT, then deterministic `dotToLogicCore()` from existing `dot.js` runs to produce Logic-Core JSON. If parsing fails, the failure category is `dot-parse-fail`.

**Sample ID format:** `{domain}__{complexity}__{pattern}__{stress}__{seq}` with double-underscore separator (so hyphenated domain names like `hr-onboarding` remain unambiguously parseable):
```
proc__medium__four-eyes__wide-parallelism__042
hr-onboarding__simple__escalation__normal__017
```

**Sample record:**
```js
{
  id: 'proc__medium__four-eyes__wide-parallelism__042',
  description: '...',
  lcJson: {...},
  rawDot: '...' | null,
  meta: { domain, complexity, pattern, stress_mode, target, model, generated_at, tokens }
}
```

### 4.4 `stress-tester.js` (~220 LOC, includes inline pre-filter)

Runs each sample through pre-filter, then the pipeline, then roundtrip check.

```js
runStressTest(samples, opts) => Promise<Array<Result>>

// Result shape:
// {
//   sample,
//   preFilter:    { passed, schemaErrors, ruleViolations },
//   pipelineResult: { bpmnXml, svg, coordMap, validation } | null,
//   roundtripResult: { equal, delta } | null,
//   durationMs,
//   failure: null | FailureRecord
// }
```

**Phase A — Pre-filter (inline helper, runs first):**
1. Schema validation against `references/input-schema.json` → on failure, classify as `schema-violation` and skip the pipeline (this sample goes to the `llm-signal/` bucket, gated by flag)
2. Rule engine `runRules(lc, defaultProfile)` → on ERROR-level violations, classify as `rule-violation` and skip the pipeline (also `llm-signal/`, gated)

If pre-filter passes (warnings are allowed; only errors short-circuit), the sample proceeds to Phase B.

**Phase B — Pipeline checks (five steps, short-circuit on first failure):**
1. ELK layout (`runElkLayout()` — may throw)
2. XML generation (`generateBpmnXml()`)
3. SVG generation (`generateSvg(coordMap, lcJson, opts)`)
4. Roundtrip: parse generated XML via `import.js` → compare via `graph-isomorphism.js`
5. OMG compliance: parse via `bpmn-moddle` (catches spec violations not caught above)

The full pipeline run is invoked via `runPipeline(lc, opts)` which returns `{ bpmnXml, svg, coordMap, validation: { errors, warnings, xmlWarnings } }`. The stress-tester checks `result.validation.errors` and the absence/presence of `bpmnXml`/`svg` to detect failure at each step.

### 4.5 `failure-classifier.js` (~120 LOC)

Maps each non-pass result to a category, fingerprint, and bucket.

| Category | Bucket | Trigger |
|---|---|---|
| `schema-violation` | `llm-signal/` (gated) | Pre-filter Step A1 failed — LLM did not follow schema |
| `rule-violation` | `llm-signal/` (gated) | Pre-filter Step A2 found ERROR-level rule violation — LLM produced semantically broken LC |
| `elk-error` | `auto/` | ELK threw or produced invalid coordinates on pre-filter-valid input |
| `xml-malform` | `auto/` | `bpmn-moddle` cannot parse the generated XML |
| `svg-render-issue` | `auto/` | `svg.js` threw on pre-filter-valid input |
| `overlap` | `auto/` | Layout produced overlapping shapes (detected via bounding-box overlap check on rendered coordinates — utility carried over from the visual-refinement work, Pass 5 wide-pipeline metrics) |
| `omg-compliance` | `auto/` | `bpmn-moddle` parses XML but reports spec violations |
| `timeout` | `auto/` | Pipeline took > `timeout_seconds` (default 30) |
| `roundtrip-break` | `auto/` | LC → XML → LC' not structurally equal per graph-isomorphism. Since pre-filter has already rejected invalid input, all roundtrip-breaks are real pipeline bugs |
| `dot-parse-fail` | `auto/` | `dotToLogicCore()` threw on LLM-generated DOT (DOT-target mode only) |
| `dot-roundtrip-break` | `auto/` | `logicCoreToDot()` → `dotToLogicCore()` is non-idempotent |

**Fingerprint:** stable hash over (category, canonicalised error message, top-level input structure signature like "5 nodes, 2 lanes, 1 XOR"). Enables dedup — if 12 generations trigger the same bug, only one fixture is persisted with `meta.seen: 12`.

### 4.6 `fixture-persister.js` (~120 LOC)

Persists classified failures with dedup, bucket-aware routing.

```js
persist(failureRecord, { persistLlmSignal: false }) => { wrote, bucket, fingerprint }
```

**Per-bucket behavior:**
- `auto/`: written automatically; loaded by `robustness.test.js`
- `triage/`: written automatically; not loaded; awaits manual review via `cli.js triage`
- `llm-signal/`: code present, **default OFF**; activated by config flag `persist_llm_signal: true` or `--persist-llm-signal` CLI flag. When active, stores `{description, raw_llm_output, schema_errors | rule_violations, model, generated_at}` for later use (e.g., SLM training data once that project starts)
- `dismissed.log`: append-only audit trail when human triages a `triage/` item with `dismiss`

**Fixture file format (`auto/elk-error-b14d77.json`):**
```json
{
  "_kind": "logicCore",
  "process": { ... }
}
```

**Meta file (`auto/elk-error-b14d77.meta.json`):**
```json
{
  "fingerprint": "b14d77",
  "category": "elk-error",
  "first_seen": "2026-05-16T14:32:11Z",
  "last_seen": "2026-05-16T14:32:11Z",
  "seen": 1,
  "description": "...",
  "model": "qwen-3.5-122b",
  "target": "lc-json",
  "evidence": { "error": "...", "stack": "..." }
}
```

### 4.7 `report-generator.js` (~170 LOC)

Aggregates run results to Markdown + JSON.

**Report sections:**
- Run summary (model, total samples, pass rate)
- Per-target breakdown (when `--target=both`)
- Failures by category with new-fixture counts
- Failures by domain × complexity matrix
- Top-10 most frequent fingerprints
- Drift vs. last run (regressed categories flagged with ⚠️)
- Triage queue length

**Files written:**
- `tests/robustness-reports/YYYY-MM-DD-{model}-{n}.md`
- `tests/robustness-reports/YYYY-MM-DD-{model}-{n}.json` (for programmatic diffing)

### 4.8 `graph-isomorphism.js` (~100 LOC)

Compares two Logic-Core JSON structures graph-theoretically, ignoring IDs and labels but enforcing topological equivalence.

```js
isStructurallyEqual(lcA, lcB) => {
  equal: boolean,
  delta: { missingNodes, extraEdges, missingLanes, ... }
}
```

**Approach:** convert both to adjacency lists; canonicalise by node-type sequence; compare. For typical sample sizes (max ~50 nodes) this is sufficient — no need for a full VF2 implementation. Limitation noted in risks section.

### 4.9 `mad-validator.js` (~80 LOC)

Loads MaD DOT samples, converts via `dot.js`, runs pipeline, measures pass rate.

```js
runMadCheck({ subsetSize = 200 }) => Promise<{ total, passed, failed, byCategory }>
```

**Data source:** MaD subset (~200 hand-curated samples) committed under `tests/fixtures/mad-subset/`. Full 30k MaD dataset remains external; obtaining it is part of Phase 6 (see below).

**Curation process (executed once during Phase 6):**
1. Acquire MaD dataset — request from paper corresponding author (Soliman et al. 2025) or check HuggingFace mirrors
2. Random sample 200 entries proportional to the 15 business domains (~13–14 per domain)
3. Automated filter: drop any sample where `dotToLogicCore()` already fails (the curation step cannot validate the parser if the parser breaks on the curation input itself)
4. Manual spot-check: 20 random samples reviewed by a human for "looks like reasonable BPMN process"
5. Output: commit `tests/fixtures/mad-subset/{domain}-{nnn}.dot` files plus an `index.json` listing all samples with metadata (domain, node count, source line in MaD)

**Output of `runMadCheck`:** additional section in the robustness report. Serves as external sanity check — if pipeline pass rate on MaD is significantly worse than on synthetic data, our synthetic generator may be biased toward easy inputs.

### 4.10 `cli.js` (~120 LOC)

CLI entry point. Resolves env vars + CLI flags, constructs LLM provider, dispatches to the right run mode.

```bash
node scripts/robustness/cli.js run --n=100 --model=qwen-3.5-122b
node scripts/robustness/cli.js run --n=20 --strategy=targeted --category=elk-error
node scripts/robustness/cli.js run --target=both --n=200
node scripts/robustness/cli.js triage                              # interactive review
node scripts/robustness/cli.js mad-check
node scripts/robustness/cli.js report --since=2026-05-01
```

CLI flags override `config.json` defaults; `config.json` overrides nothing — env vars are read directly via `process.env.AIHUB_URL` / `process.env.AIHUB_KEY` with CLI-flag-first precedence.

## 5 Data Flow (one concrete run)

Command: `node scripts/robustness/cli.js run --n=100 --target=lc-json`

1. **Bootstrap.** Load `seed-catalog.json` and `config.json`, resolve env vars, construct `createLlmProvider({ baseUrl, apiKey, model })`, ping endpoint, prepare output directories.
2. **Generate.** For each of 100 sampled cells, run two-step prompting → produce `{description, lcJson, meta}` records.
3. **Stress.** For each sample, run the inline pre-filter (schema + rules); pre-filter failures go to `llm-signal/` (skipped if flag is off). Survivors run the five-step pipeline + roundtrip + OMG-compliance check.
4. **Classify.** Each non-pass result → category + fingerprint + bucket via `failure-classifier.js`.
5. **Persist.** Dedup by fingerprint; write fixtures to appropriate bucket directories. Skip `llm-signal/` writes when flag is off.
6. **Report.** Write Markdown + JSON to `tests/robustness-reports/`; print summary to stdout.

**Expected timing:** sequential generation of 100 samples at ~2 LLM calls each = 200 calls. Conservative latency 3–5s per call → 10–15 minutes per run. Parallelisable (rate limits permitting, see R7) to ~3 minutes.

## 6 Triage Model — Bucket Behavior

The system has **three fixture buckets** plus an audit log:

| Bucket | Active by default | Persisted | Loaded by tests | Purpose |
|---|---|---|---|---|
| `auto/` | Yes | Yes | Yes (fail until fixed) | Regression protection for unambiguous pipeline bugs |
| `triage/` | Yes | Yes | No | Human review backlog; `cli.js triage` enables promote/dismiss/defer |
| `llm-signal/` | **No (gated)** | Only when flag on | No | Future SLM training corpus when L1 advances |
| `dismissed.log` | Yes (audit log, not a bucket) | Audit trail | No | Documents "not a bug" decisions made via `cli.js triage` |

**Initial state:** zero fixtures exist. Implementing this spec adds zero red tests. The first red test appears only after a real run finds a real bug.

**Triage CLI behavior (`cli.js triage`):**
```
$ node scripts/robustness/cli.js triage

Pending triage items: 7

[1] overlap-c8e1d4   (first seen 2026-05-16, seen 3x)
    description: "Im HR-Onboarding..."
    evidence:     "shape Task_5 overlaps Task_8 by 12px"
    actions:      promote | dismiss | defer | show | open

> promote 1
Moved tests/fixtures/robustness/triage/overlap-c8e1d4.* to auto/
Next run of `npm test` (from scripts/) will pick it up as a failing regression.
```

## 7 DOT-Target Path (configurable mode)

When `--target=dot`, the synthetic generator emits DOT instead of LC-JSON. Deterministic `dotToLogicCore()` from existing `dot.js` then converts to LC-JSON before the pre-filter. This exercises the existing DOT subset-parser (known limitation per CLAUDE.md: only guaranteed to round-trip `logicCoreToDot()` output) and produces a paper-aligned evaluation track.

**Expected effect:** higher rejection rate at the DOT-parse step initially (estimated 30–50% on first runs). This is the desired signal — every rejection points to a DOT pattern the parser cannot handle. If rejection exceeds 70%, prompt engineering must include an example DOT in the structure-gen prompt showing the parser-friendly format. If it still exceeds 70% after that, mark a follow-up to broaden `dot.js`.

**New categories enabled by DOT mode:**
- `dot-parse-fail` — LLM produced DOT that `dotToLogicCore()` cannot parse
- `dot-roundtrip-break` — `logicCoreToDot()` → `dotToLogicCore()` is non-idempotent

Both land in `auto/` (they expose code-level bugs in `dot.js`).

**When to use:** weekly or per-release runs to keep `dot.js` honest; not the default daily run.

## 8 Testing Strategy

### 8.1 Tests for the robustness tooling itself

New file: `scripts/robustness-internal.test.js`

| Subject | Approach |
|---|---|
| `synthetic-generator` | Mock the `llm` callable returning fixed JSON; assert correct catalog iteration and sample shape |
| `stress-tester` pre-filter | Inject invalid LC → expect classification as `schema-violation` and skip of pipeline |
| `failure-classifier` | Pure-function snapshot tests for fingerprint stability |
| `fixture-persister` dedup | tmpfs target; write same failure 3× → expect 1 fixture with `seen: 3` |
| `fixture-persister` LLM-signal gate | Default off: no files in `llm-signal/`; flag on: files appear |
| `graph-isomorphism` | Golden LC pairs (equal / not-equal / specific delta cases) |
| `mad-validator` | 10-sample fixture subset → expected pass rate |
| DOT-mode generator | Mocked LLM returns DOT; assert `dotToLogicCore` is called and downstream pipeline runs |
| CLI env-var resolution | Set `process.env.AIHUB_URL`, no flag → expect provider built with that URL |
| CLI flag precedence | Set env var AND pass `--api-url`; expect flag value wins |

Estimate: ~30 tests across the eight modules.

### 8.2 Tests for the generated regressions

New file: `scripts/robustness.test.js`

```js
import { glob } from 'glob';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import { runPipeline } from './pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const autoDir = resolve(__dirname, '../tests/fixtures/robustness/auto');

describe('Robustness Regression', () => {
  const autoFixtures = fs.existsSync(autoDir)
    ? glob.sync(`${autoDir}/*.json`).filter(f => !f.endsWith('.meta.json'))
    : [];

  if (autoFixtures.length === 0) {
    test.skip('No robustness fixtures yet — run `cli.js run` first', () => {});
    return;
  }

  autoFixtures.forEach(f => {
    test(`auto-fixture: ${path.basename(f)}`, async () => {
      const lc = JSON.parse(fs.readFileSync(f, 'utf8'));
      const result = await runPipeline(lc);
      expect(result.validation.errors).toEqual([]);
    });
  });
});
```

Note the correct `runPipeline` return shape: `{ bpmnXml, svg, coordMap, validation: { errors, warnings, xmlWarnings } }`. The test checks `result.validation.errors`.

`triage/` and `llm-signal/` fixtures are **not** loaded — they require explicit promote to enter the test suite.

### 8.3 Observability during a run

Structured stdout per sample:
```
[robustness] Sample 42/100 [proc__medium__four-eyes__wide-parallelism__042]
  target:      lc-json
  pre-filter:  PASS (schema + rules)
  pipeline:    FAIL (elk-error: cyclic dependency)
  category:    elk-error
  fingerprint: b14d77
  bucket:      auto/
  persist:     NEW (1st occurrence)
```

Drift detection in the report compares fingerprint sets across runs; categories that regressed (pass-rate dropped) are flagged prominently.

## 9 Configuration

New file: `scripts/robustness/config.json`

```json
{
  "model": "qwen-3.5-122b",
  "fallback_models": ["qwen-3.6-35b", "qwen3-coder-480b"],
  "default_n": 100,
  "default_target": "lc-json",
  "timeout_seconds": 30,
  "parallelism": 1,
  "persist_llm_signal": false,
  "report_dir": "tests/robustness-reports",
  "fixture_dir": "tests/fixtures/robustness",
  "endpoint": {
    "url_env": "AIHUB_URL",
    "key_env": "AIHUB_KEY",
    "url": null,
    "key": null
  }
}
```

**Precedence (highest to lowest):**
1. CLI flag (`--api-url`, `--api-key`, `--model`, etc.)
2. Environment variable named by `endpoint.url_env` / `endpoint.key_env`
3. Static value in `config.json` (`endpoint.url`, `endpoint.key` — typically null in committed config)

Credentials are never logged or written to fixtures, reports, or stdout traces.

## 10 Risks and Open Questions

| # | Risk | Mitigation |
|---|---|---|
| R1 | LLM-gateway rate limits unknown | Default `parallelism: 1`; observe first runs; raise cautiously |
| R2 | Two-step prompting takes 2 calls per sample (~10–15 min for n=100 sequentially) | Acceptable for manual triggering; parallelisation deferred to post-MVP (see R7) |
| R3 | Graph-isomorphism is approximate for >50-node graphs (canonical sort could give false positives) | Document as known limitation; sample sizes typically below threshold; upgrade path is full VF2 if needed |
| R4 | Triage CLI UX is minimal (text listing + line-based commands) | Sufficient for MVP; TUI/visual triage is future work |
| R5 | DOT-target mode may show >70% parse-fail rate, dwarfing other signals | Threshold trigger: if observed, add DOT-format example to prompt; if still failing, mark `dot.js` parser improvement as separate work |
| R6 | MaD dataset access requires paper-author request | Initial implementation works with the curated 200-sample manual subset; full dataset is nice-to-have |
| R7 | `parallelism > 1` introduces race conditions in fixture-persister (two workers persisting same fingerprint concurrently could double-write or corrupt meta) | While `parallelism: 1` (default), no risk. When raising parallelism, the persister must adopt atomic file operations (write to `*.tmp`, fsync, rename) and/or per-fingerprint locking. Out of MVP scope; documented as gate before increasing parallelism |

## 11 What This Spec Delivers (Acceptance)

- A working `node scripts/robustness/cli.js run --n=N` command
- Three fixture buckets exist, two active (`auto/`, `triage/`), one gated (`llm-signal/`), plus `dismissed.log` audit trail
- A first run produces a report and creates initial fixtures
- `scripts/robustness.test.js` exists and dynamically loads auto-fixtures (initially skipping when empty)
- `scripts/robustness-internal.test.js` has ~30 tests for the tooling modules
- All 136 existing tests in `scripts/pipeline.test.js` still pass
- DOT-target mode works end-to-end
- `scripts/robustness/README.md` documents the workflow

## 12 What This Spec Explicitly Excludes

- Auto-repair of failures via LLM
- CI auto-runs (separate follow-up spec)
- Modeler frontend (deferred)
- SLM fine-tuning (separate project, L1)
- Pipeline architecture changes
- Activation of `llm-signal/` persistence (built, default OFF)
- Parallelism > 1 (deferred; see R7)

## 13 References

- **Soliman et al. (2025).** "Size matters less: how fine-tuned small LLMs excel in BPMN generation." Journal of Electrical Systems and Information Technology. DOI: 10.1186/s43067-025-00288-9. Inspiration for using DOT and for the MaD dataset reference.
- **MaD dataset** — 30k description-DOT pairs across 15 business domains, cited in the above paper. Subset to be curated for `tests/fixtures/mad-subset/`.
- **Existing internal references:**
  - `ROADMAP.md` Section 8 (research references already established)
  - `references/input-schema.json` (Logic-Core JSON schema; consumed by pre-filter)
  - `scripts/dot.js` (DOT export/import; consumed by DOT-target mode)
  - `scripts/agents/llm-provider.js` (provider abstraction; consumed as-is)
  - `scripts/evaluate-slm.js` (L1 eval pattern; the env-var + CLI-flag resolution approach is mirrored)

## 14 Phased Implementation Hint (for the writing-plans skill)

A natural phase split for the implementation plan:

1. **Phase 1 — Foundation:** `config.json` + `cli.js` skeleton + env-var/flag resolution + smoke test that constructs `createLlmProvider` from AI-Hub endpoint and round-trips a trivial "say hello" prompt
2. **Phase 2 — Generation:** `seed-catalog.json` + `synthetic-generator.js` (LC-JSON mode only) + corresponding tests in `robustness-internal.test.js`
3. **Phase 3 — Stress + Classify:** `stress-tester.js` (inline pre-filter + 5-step pipeline checks) + `failure-classifier.js` (LC-JSON categories only) + `graph-isomorphism.js`
4. **Phase 4 — Persist + Report:** `fixture-persister.js` (auto + triage buckets active; `llm-signal/` code present but gated off) + `report-generator.js` + `robustness.test.js` skeleton (loads auto-fixtures, skips when empty)
5. **Phase 5 — DOT mode:** generator `target='dot'` + classifier `dot-parse-fail` / `dot-roundtrip-break` + tests
6. **Phase 6 — MaD sanity:** acquire dataset + execute curation process + `mad-validator.js` + report integration

Phases 1–4 deliver the MVP; phases 5–6 are extensions in the same spec scope. The plan can be executed by parallel subagents where dependencies allow.
