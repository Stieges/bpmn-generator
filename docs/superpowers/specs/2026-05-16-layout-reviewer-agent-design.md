# Layout Reviewer Agent (M1 revisited) — Design

**Date:** 2026-05-16
**Status:** Draft (post-brainstorm)
**Owner:** Daniel Stiegler + Claude

## 1 Goal

An iterative layout-review agent that takes ELK-generated BPMN SVG diagrams, asks a text-LLM to identify structural quality issues (overlap, edge-crossings, lane-too-narrow, aspect-imbalance, edge-label-overlap), deterministically maps each issue type to ELK option deltas, re-runs the pipeline up to a configurable max-iter (default 2), and produces an optional perceptual-quality score via a vision-LLM at the end. The agent activates only when `enableLayoutReview` is set; existing pipeline consumers see no behavior change.

This revives the previously-dropped ROADMAP item M1 ("Layout Feedback Loop"), now feasible because (a) the L3 orchestrator already has the `enableLayoutReview` hook and (b) sovereign and provider-pluggable vision-LLMs are available.

## 2 Scope

### In scope

- New `agents/layout-reviewer.js` orchestrating the review loop
- New `agents/svg-renderer.js` (sharp-based SVG → PNG)
- New `agents/vision-provider.js` (OpenAI + Anthropic multimodal-format compatible)
- Extension of existing `agents/layout.js` to call the reviewer when `enableLayoutReview` is true
- 5 structural issue types with deterministic ELK-option mapping
- Optional perceptual score via vision-LLM (caller-provided)
- Unified cost cap covering both text and vision calls
- ~105 hermetic tests (unit + E2E + stress + quality) plus one opt-in live smoke

### Out of scope

- Changes to `pipeline.js`, `rules.js`, `layout.js` core engine, `coordinates.js`, `bpmn-xml.js`, `svg.js`
- Changes to `agents/llm-provider.js` (consumed as-is)
- Self-improving prompts (the system prompt for the reviewer is static)
- Vision-LLM-driven layout edits (only deterministic mapping from a fixed issue catalog)
- Anthropic Claude vision via official Anthropic API in MVP — **actually in scope** (see below) via format adapter
- New CLI command — the agent is consumed via existing orchestrator or pipeline opts

## 3 Architecture

### 3.1 High-level flow

```
Logic-Core JSON
      │
      ▼
┌────────────────────────────────────────────────────┐
│        runPipeline() (UNCHANGED)                   │
│  Validate ──▶ ELK Layout ──▶ BPMN-XML + SVG       │
└──────────────────────┬─────────────────────────────┘
                       │
                       ▼   if opts.enableLayoutReview === true
┌────────────────────────────────────────────────────┐
│   LAYOUT-REVIEWER-AGENT (NEW)                      │
│                                                    │
│   ┌─ Iteration N (max 2) ─────────────────────┐    │
│   │                                            │    │
│   │  Text-LLM reviewSvgStructural()           │    │
│   │    SVG-text + LC-JSON ▶ structured issues │    │
│   │            │                              │    │
│   │            ▼                              │    │
│   │  mapIssuesToElkOpts() (deterministic)     │    │
│   │    issues ▶ ELK-option delta              │    │
│   │            │                              │    │
│   │            ▼                              │    │
│   │  re-runPipeline(lc, mergedOpts)           │    │
│   │            │                              │    │
│   │            ▼                              │    │
│   │  if issues=[] OR maxIter OR deepEqual     │    │
│   │     ▶ break                                │    │
│   └────────────────────────────────────────────┘    │
│                                                    │
│   Vision-LLM (optional) — single final call        │
│     SVG → sharp → PNG ▶ score(1-10) + comment      │
│                                                    │
└──────────────────┬─────────────────────────────────┘
                   │
                   ▼
{ bpmnXml, svg, coordMap, validation,
  layoutReview: { iterations, fixedIssues, perceptual, costCents } }
```

### 3.2 Activation points

| Entry | How |
|---|---|
| L3 Orchestrator | Existing `enableLayoutReview` flag in `layoutAgent` is no longer a no-op hook |
| Direct pipeline call | `runPipeline(lc, { enableLayoutReview: true, llmProvider, visionProvider })` |
| Robustness Stack (future, optional) | After successful pipeline, can invoke layout-reviewer for `triage/aspect-imbalance` failures |

### 3.3 New module layout

```
scripts/agents/
├── layout.js                      (EXISTS, +~20 LOC)
├── layout-reviewer.js             (NEW, ~250 LOC)
├── svg-renderer.js                (NEW, ~50 LOC)
├── vision-provider.js             (NEW, ~80 LOC — includes Anthropic adapter)
├── layout-reviewer.test.js        (NEW)
├── svg-renderer.test.js           (NEW)
├── vision-provider.test.js        (NEW)
├── layout-reviewer-e2e.test.js    (NEW)
├── layout-reviewer-convergence.test.js (NEW)
├── layout-reviewer-quality.test.js (NEW)
└── layout-reviewer-smoke.js       (NEW, opt-in CLI for live test)

tests/fixtures/layout-bad/         (NEW)
├── bad-overlap-dense.json
├── bad-narrow-lanes.json
├── bad-wide-aspect.json
└── bad-edge-labels-dense.json
```

### 3.4 New dependencies

| Dep | Size | Purpose |
|---|---|---|
| `sharp` | ~30 MB native | SVG → PNG rendering |

Only one new dep. No puppeteer.

## 4 Components

### 4.1 `agents/layout-reviewer.js` (~250 LOC)

Four exported functions.

```js
// Text-LLM call: reads SVG + LC-JSON, returns structured issue list
reviewSvgStructural(svg, lcJson, textLlm)
  → Promise<{ issues: Issue[], tokensUsed: number }>

// Pure: maps issues to ELK option delta
mapIssuesToElkOpts(issues, currentOpts)
  → opts (merged)

// Vision-LLM call: 1× perceptual score at the end
runPerceptualScore(svg, visionProvider, svgRenderer)
  → Promise<{ score: 1-10, comment: string, tokensUsed: number }>

// Top-level: orchestrates the loop
improveLayout({ lcJson, initialResult, opts, textLlm, visionProvider, maxIter=2, maxCostCents=100 })
  → Promise<{
      finalResult,        // never worse than initialResult
      iterations,         // 0..maxIter
      fixedIssues,        // accumulated, with resolvedIn
      perceptual,         // null | { score, comment }
      costCents,          // accumulated cost estimate
      error               // null | string
    }>
```

### 4.2 `agents/svg-renderer.js` (~50 LOC)

```js
import sharp from 'sharp';
svgToPng(svgString, { width = 1200 } = {}) → Promise<Buffer>
```

Width-limit prevents memory spikes on large diagrams.

### 4.3 `agents/vision-provider.js` (~80 LOC)

```js
createVisionProvider({
  baseUrl,                          // ANY OpenAI-compat or Anthropic endpoint
  apiKey,
  model,
  format = autoDetect(baseUrl),     // 'openai' | 'anthropic'
  timeout = 60_000
}) → async (systemPrompt, userPrompt, imageBuffer) → text response

function autoDetect(url) {
  if (url.includes('anthropic.com')) return 'anthropic';
  return 'openai';
}
```

**OpenAI-format request:**
```js
{
  role: 'user',
  content: [
    { type: 'text', text: userPrompt },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }
  ]
}
```

**Anthropic-format request:**
```js
{
  role: 'user',
  content: [
    { type: 'text', text: userPrompt },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }
  ]
}
```

Supported providers via this single interface:
- AI-Hub gateway (Gemini, Claude, GPT-4o, any vision model)
- OpenAI API direct (`https://api.openai.com/v1`)
- Anthropic API direct (`https://api.anthropic.com/v1`) — via format adapter
- Local Ollama (e.g., llava) via `http://localhost:11434/v1`
- Together / Replicate / Anyscale (all OpenAI-compat)

### 4.4 `agents/layout.js` (EXISTING, +~20 LOC)

The existing `enableLayoutReview` hook gets filled in:

```js
async function layoutAgent({ logicCore, options }) {
  const result = await runPipeline(logicCore, options);

  if (options.enableLayoutReview && options.llmProvider) {
    const { improveLayout } = await import('./layout-reviewer.js');
    const improved = await improveLayout({
      lcJson: logicCore,
      initialResult: result,
      opts: options,
      textLlm: options.llmProvider,
      visionProvider: options.visionProvider || null,
      maxIter: options.layoutReviewMaxIter ?? 2,
      maxCostCents: options.layoutReviewMaxCostCents ?? 100,
    });
    return {
      ...improved.finalResult,
      layoutReview: {
        iterations: improved.iterations,
        fixedIssues: improved.fixedIssues,
        perceptual: improved.perceptual,
        costCents: improved.costCents,
        error: improved.error
      },
      done: true,
    };
  }

  return { ...result, done: true };
}
```

Existing tests with `enableLayoutReview: false` or absent: unchanged behavior. Backward-compat guaranteed.

### 4.5 Issue schema (the LLM ↔ mapper contract)

```ts
type IssueType =
  | 'overlap'
  | 'edge-label-overlap'
  | 'edge-crossings'
  | 'lane-too-narrow'
  | 'aspect-imbalance';

type Issue = {
  type: IssueType,
  severity: 1 | 2 | 3 | 4 | 5,
  details: string,
  hint?: string  // optional LLM suggestion, ignored by mapper, logged only
};
```

5 fixed types. LLM-output with unknown `type` is silently dropped by the mapper (no error, no action).

### 4.6 Action-mapping table (`mapIssuesToElkOpts`)

| IssueType | Deterministic action |
|---|---|
| `overlap` | `elkOptions['elk.layered.spacing.nodeNode']` += 10, `elk.layered.spacing.nodeNodeBetweenLayers` += 20 |
| `edge-label-overlap` | `opts.repairEdgeLabels = true`, `opts.edgeLabelPadding` += 4 |
| `edge-crossings` | toggle `elk.layered.crossingMinimization.strategy` (LAYER_SWEEP ↔ INTERACTIVE) |
| `lane-too-narrow` | `opts.dynamicLaneHeaders.minWidth` += 50 |
| `aspect-imbalance` | toggle `elk.layered.wrapping.strategy` (OFF ↔ MULTI_EDGE) |

Idempotent within an iteration: 5 overlap issues → mapper applies the increase **once**, not 5×.

## 5 Data Flow (one concrete run)

User calls `orchestrate(text, { llmProvider, visionProvider, enableLayoutReview: true })`.

1. **Existing L3 flow**: modelerAgent → reviewerAgent → layoutAgent (this is where the new code activates)
2. **Initial pipeline run**: `runPipeline(lc, opts)` produces `{ bpmnXml, svg, validation, ... }`
3. **Iteration 1**: text-LLM `reviewSvgStructural()` reads the SVG-as-text and LC-JSON, outputs e.g. `{issues: [{type:'overlap',...}, {type:'aspect-imbalance',...}]}`
4. **Action mapper**: `mapIssuesToElkOpts()` produces new opts (`nodeNode` spacing +10, wrapping toggled)
5. **Re-pipeline**: `runPipeline(lc, opts2)` with merged options
6. **Iteration 2**: review again. If `issues=[]` (converged) → break. If still issues → apply mapping, re-pipeline. If options unchanged after mapping → break.
7. **Perceptual score** (only if `visionProvider` provided): `svgToPng(finalSvg)` → vision LLM → `{score, comment}`
8. **Return** unified object: pipeline result + `layoutReview` metadata

### Typical timing

| Step | Cost | Latency |
|---|---|---|
| Initial layout | – | 0.3–1.5s |
| Text-review (iter 1) | ~3000 tokens, FREE on sovereign | 2–4s |
| Map + re-layout | – | 0.3–1.5s |
| Text-review (iter 2) | ~3000 tokens, FREE | 2–4s |
| Vision score | ~1500 input tokens × Gemini Flash | ~0.0005€ |
| **Total** | **~0.0005€** | **~6–15s** |

## 6 Loop Control + Termination

### Algorithm

```js
let currentResult = initialResult;
let currentOpts = opts;
const fixedIssues = [];
let iterations = 0;
let costCents = 0;

for (let i = 0; i < maxIter; i++) {
  if (costCents > maxCostCents) { /* break with warning */ break; }
  iterations = i + 1;

  const { issues, tokensUsed } = await reviewSvgStructural(...);
  costCents += estimateCostCents(textModel, tokensUsed);

  if (issues.length === 0) break;  // converged

  const newOpts = mapIssuesToElkOpts(issues, currentOpts);
  if (deepEqual(newOpts, currentOpts)) break;  // no actionable

  currentOpts = newOpts;
  fixedIssues.push(...issues.map(i => ({ ...i, resolvedIn: iterations })));

  try {
    currentResult = await runPipeline(lcJson, currentOpts);
  } catch (e) {
    iterations--; break;  // revert and stop
  }
}

let perceptual = null;
if (visionProvider && costCents <= maxCostCents) {
  try {
    const png = await svgToPng(currentResult.svg);
    const { score, comment, tokensUsed } = await runPerceptualScore(png, visionProvider);
    costCents += estimateCostCents(visionModel, tokensUsed);
    perceptual = { score, comment };
  } catch (e) {
    perceptual = { score: null, comment: `vision failed: ${e.message}` };
  }
}

return { finalResult: currentResult, iterations, fixedIssues, perceptual, costCents };
```

### Termination conditions

| Condition | Outcome |
|---|---|
| `issues.length === 0` | Converged ✅ |
| `iterations === maxIter` | Bounded — at most maxIter LLM-calls |
| `deepEqual(newOpts, currentOpts)` | No actionable issues — break |
| Text-LLM throws | Stop loop, return current state |
| Re-pipeline throws | Revert + break |
| Cost cap reached | Break with warning |

### Failure isolation principle

**The layout-reviewer never makes the pipeline output worse.** If anything breaks mid-loop, the latest known-good `currentResult` (or `initialResult` if iter 0) is returned. Caller always receives valid BPMN + SVG.

## 7 Cost Model

### Per-run estimate

| Component | Tokens | €/run |
|---|---|---|
| Text-LLM iter 1 (Qwen FREE) | ~3000 in + ~500 out | 0,00 € |
| Text-LLM iter 2 (Qwen FREE) | ~3000 in + ~500 out | 0,00 € |
| Vision-LLM final (Gemini Flash) | ~1500 in (with image) + ~100 out | ~0,0005 € |
| **Total** | | **~0,0005 €** |

### Monthly cost scaling

| Volume | €/month |
|---|---|
| 100 runs | ~0,05 € |
| 1.000 runs | ~0,50 € |
| 10.000 runs | ~5 € |

### Unified cost cap

`layoutReviewMaxCostCents` (default 100 = 1 €) counts text + vision tokens. Tracked via `estimateCostCents(model, tokensUsed)` lookup table. Unknown model → 0 cents (treated as FREE).

## 8 Error Handling

| Failure | Response |
|---|---|
| Text-LLM unreachable | Stop loop, return initial. `layoutReview.error = 'text-llm unreachable'` |
| Text-LLM returns invalid JSON | `extractJson` fallback (same as Robustness stack); if still unparseable → no-op iter, log warning, continue |
| Action mapper finds no action | break (deepEqual check), `layoutReview.note = 'no actionable issues'` |
| Re-pipeline throws | Revert to previous result, break, `layoutReview.error = 're-layout failed: ...'` |
| Vision-LLM unreachable | Skip perceptual, `perceptual.score = null` with comment |
| `sharp` SVG → PNG fails | Skip perceptual, log warning |

## 9 Testing Strategy

### 9.1 Unit tests (~35 tests total)

- `layout-reviewer.test.js`: ~25 — covers reviewSvgStructural, mapIssuesToElkOpts (all 5 types, idempotency, unknown), improveLayout (happy, max-iter, deepEqual-stop, throws, with/without vision, cost-cap)
- `svg-renderer.test.js`: ~3 — PNG magic bytes, width, invalid-svg throws
- `vision-provider.test.js`: ~6 — callable return type, OpenAI body, Anthropic body, auto-detect, explicit override
- `orchestrator.test.js` extension: ~5 — backward compat (no enableLayoutReview), with enableLayoutReview, with vision, throws, full E2E mock

### 9.2 E2E with gold fixtures (~10 tests)

`scripts/layout-reviewer-e2e.test.js` + fixtures under `tests/fixtures/layout-bad/`:

| Fixture | Known problem | Expected post-reviewer property |
|---|---|---|
| `bad-overlap-dense.json` | 20 tasks in 1 lane → guaranteed overlap | no overlapping bounding boxes |
| `bad-narrow-lanes.json` | Long lane names, default-width too small | all labels visible (width ≥ measured-text-width) |
| `bad-wide-aspect.json` | 30 tasks linear → 5:1 W/H | wrapping enabled, ≤3:1 |
| `bad-edge-labels-dense.json` | 5 labels in tight area | no label overlaps an edge |

Tests use **deterministic mock-LLM** that always reports the relevant issue type. Asserts property of resulting layout — not pixel-exact golden comparison (too fragile for ELK output).

### 9.3 Convergence stress test (~60 tests)

`scripts/layout-reviewer-convergence.test.js` — property-based:

```js
for (const fixture of STRESS_FIXTURES) {   // 20 programmatically-generated LCs
  for (const mockType of ['alwaysIssues', 'alwaysEmpty', 'randomIssues']) {
    test(`terminates for ${fixture.id} with ${mockType}`, async () => {
      const result = await improveLayout({...});
      expect(result.iterations).toBeLessThanOrEqual(2);
      expect(result.finalResult.svg).toMatch(/<svg/);
    });
  }
}
```

20 × 3 = 60 tests. Verifies: bounded iteration count, always-valid output, no infinite loops.

### 9.4 Quality regression test (~10 tests)

`scripts/layout-reviewer-quality.test.js` — with curated "good" fixtures (simple-approval.json, etc.) and **deterministic mock-vision** returning predictable score:

```js
for (const fname of ['simple-approval.json', 'four-eyes-approval.json', ...]) {
  test(`${fname} → score >= 7`, async () => {
    const result = await improveLayout({ visionProvider: MOCK_VISION_GOOD });
    expect(result.perceptual.score).toBeGreaterThanOrEqual(7);
  });
}
```

In MVP this is trivial (mock returns whatever we tell it). The real value emerges when live vision-LLM is wired in a follow-up — these tests then catch perceptual regressions.

### 9.5 Live-LLM smoke test (opt-in, NOT in CI)

`scripts/agents/layout-reviewer-smoke.js` — manual CLI:

```bash
node scripts/agents/layout-reviewer-smoke.js \
  --logic-core tests/fixtures/simple-approval.json \
  --llm-url=$AIHUB_URL --llm-key=$AIHUB_KEY --llm-model=qwen-3.5-122b \
  --vision-url=$AIHUB_URL --vision-key=$AIHUB_KEY --vision-model=gemini-2.5-flash
```

Outputs iterations, fixed issues, perceptual score, cost, duration. Diagnostic only — failures are info, not CI errors.

### 9.6 Test totals

- ~35 unit + ~10 E2E + ~60 stress + ~10 quality + ~5 orchestrator integration = **~120 new tests**
- All hermetic, < 5s additional run-time
- Plus 1 opt-in CLI for live diagnostics

### 9.7 Explicitly not tested

- Actual LLM output quality (mocked in tests; manual smoke for real)
- Real Vision-LLM-bias on real diagrams (emerges only with live runs)
- Pixel-exact SVG comparison (ELK output too sensitive to library version)

## 10 Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Text-LLM hallucinates issue types that aren't in the fixed catalog | Mapper silently ignores unknown types; logged as warning |
| R2 | Action mapping makes layout worse | maxIter=2 bounds damage; failure-isolation returns initialResult on degradation |
| R3 | Vision-LLM-provider format incompatibility (e.g., new provider with different multimodal API) | Adapter is extensible; OpenAI + Anthropic cover ~95% of providers today |
| R4 | `sharp` native dependency complicates install on some CI platforms | Optional dep — perceptual score gracefully skipped if `sharp` unavailable |
| R5 | Cost cap defaults to 1 € — could surprise low-budget users | Documented; configurable; tracked in `costCents` field for transparency |
| R6 | LLM-suggested action doesn't actually help; loop hits maxIter without improvement | Fine — current result still ≥ initial result quality |
| R7 | Vision-LLM scores fluctuate run-to-run on same input | Documented; quality regression test uses mocks for stability, real-world variance accepted |

## 11 Acceptance

- `improveLayout()` orchestrates a max-iter-2 loop with deterministic action mapping
- Backward-compat: existing tests in `orchestrator.test.js` pass unchanged
- 5 issue types end-to-end-testable via gold fixtures
- Vision-LLM is pluggable across OpenAI, Anthropic, and OpenAI-compatible providers
- ~120 new tests pass, no live LLM required for CI
- Opt-in smoke test verifies live integration manually
- README updated with usage example for `enableLayoutReview`

## 12 Out of scope

- Multi-pass perceptual scoring (single final call only)
- Vision-LLM-driven layout edits (only deterministic mapping)
- New CLI command (consumed via orchestrator/pipeline opts)
- Auto-tuning of action-mapping constants (e.g., `+10` spacing is hardcoded — could become adaptive in a future iteration)
- Caching of LLM responses for repeat-input scenarios

## 13 References

- ROADMAP.md Section 4 — L3 Multi-Agent Orchestration (already has `enableLayoutReview` hook, until now a no-op)
- ROADMAP.md M1 "Layout Feedback Loop" — previously dropped, revived by this spec with provider-pluggable vision
- `scripts/agents/layout.js` (existing) — host for the new branch
- `scripts/agents/llm-provider.js` (existing, unchanged) — pattern reused for vision-provider
- Companion spec: `docs/superpowers/specs/2026-05-16-pipeline-robustness-via-synthetic-data-design.md` (robustness stack — both consume the same pipeline, complementary not overlapping)

## 14 Phased implementation hint

1. **Phase 1 — Vision-provider + svg-renderer:** stand-alone modules + tests, no integration yet
2. **Phase 2 — Layout-reviewer core:** reviewSvgStructural + mapIssuesToElkOpts + tests for 5 issue types
3. **Phase 3 — improveLayout loop:** orchestration, termination, error handling + unit tests
4. **Phase 4 — Integration into layoutAgent:** wire `enableLayoutReview` hook + orchestrator tests
5. **Phase 5 — Gold-fixture E2E + convergence stress:** the 4 bad-fixtures + 60-test stress
6. **Phase 6 — Quality regression + live smoke CLI:** mocked quality tests + opt-in live smoke

Phases 1–4 deliver functional MVP. Phases 5–6 are confidence-boosters but same spec scope.
