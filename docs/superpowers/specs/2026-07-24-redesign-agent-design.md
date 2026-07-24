# Configurable Redesign Agent (Optimization Increment 2) — Design

**Date:** 2026-07-24
**Status:** Draft (post-brainstorm)
**Owner:** Daniel Stiegler + Claude

## 1 Goal

Turn the read-only advisories from Increment 1 into an **actual Soll-process**. A configurable
**Redesign Agent** takes an IST Logic-Core plus a mission (free-text brief + structured policy), applies
redesign transforms as far as it safely can, and returns a Soll Logic-Core next to the frozen IST — with a
changelog of what changed and why.

**Guiding split (the core idea of this increment):** everything that can be *computed* is a deterministic
function or a mathematical rule; the agent only does what genuinely cannot be — judgment, semantics,
goal trade-offs, and estimating numbers the model doesn't carry.

| Concern | Owner |
|---|---|
| Detect opportunities, transform the graph, check soundness, score trade-offs, order knock-outs, find parallelizable sets | **Deterministic code / math** |
| Is this change *businesslike*? Which goal wins? What is the effort/probability if unknown? Which contradicting heuristic applies? | **Agent (LLM)** |

## 2 Scope

### In scope

**Deterministic core — no LLM, no API key:**
- `scripts/redesign.js` — transform library (pure functions, Logic-Core → Logic-Core)
- `scripts/redesign-math.js` — scoring/ordering math (knock-out order, antichains, critical path, MCDA)
- Advisory enrichment in `scripts/optimize.js`: structured `targets` + `transform` per finding
- IST↔Soll snapshot handling + changelog; CLI entry

**Consumer A — Claude Code skill (primary, still key-free):**
- `.claude/agents/redesign.md` — the *freely definable* subagent definition (mission, limits, allowed tools)
- SKILL.md workflow section driving the loop

**Consumer B — headless (last phase, needs a key):**
- `scripts/agents/redesign.js` — same policy surface, driven by an `llmProvider` for HTTP/CI use
- Key hygiene, audit, server-side cost cap (§9)

**Tests:** transform units, math units, subagent-workflow check, agent-with-mock-LLM, IST→Soll golden

### Out of scope
- Greenfield Soll from a goal without an IST → **Increment 3**
- New HTTP endpoint / frontend wiring (the agent is reachable programmatically + via the skill; the
  existing `/orchestrate` may pass it through later)
- Auto-merging redesigns into the user's file without confirmation
- Process mining / event-log analysis (no event data in Logic-Core)
- Changing Increment 1's detection heuristics themselves
- **Cross-pool restructuring.** Transforms operate *within* one process/pool. Moving work between
  participants changes the collaboration contract (message flows) and needs its own design.

## 3 Architecture

**One deterministic core, two interchangeable judgment consumers.** The judgment layer is a *plug*, not the
engine — which is what keeps the primary path free of API keys.

```
        CONSUMER A (primary)              CONSUMER B (last phase)
   Claude Code subagent, key-free      agents/redesign.js + llmProvider
   .claude/agents/redesign.md          (HTTP/CI, headless, needs a key)
                    └──────────┬──────────┘
                               │ brief + policy; selects & parameterizes
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ DETERMINISTIC CORE — no LLM, no key, fully testable          │
│                                                              │
│  IST Logic-Core ──(frozen)───────────────────────────┐       │
│        │                                             │       │
│        ▼                                             │       │
│  optimize.js ──▶ structured advisories               │       │
│        │         (Inc.1 detection + targets/transform)│      │
│        ▼                                             │       │
│  redesign.js transforms + redesign-math.js scoring   │       │
│        │                                             │       │
│        ▼                                             │       │
│  validate (soundness/WF-net) ── fails ─▶ rollback    │       │
│        │ ok                                          ▼       │
│        ▼                                                     │
│  Soll Logic-Core ◀── changelog ──▶ IST vs. Soll render       │
└──────────────────────────────────────────────────────────────┘
                               │
                        re-detect (§6.2) ──▶ next step
```

**Invariants:**
1. The judgment layer never hand-edits Logic-Core JSON — it selects and parameterizes transforms.
2. Every applied transform is validated; a step that breaks soundness is rolled back and reported.
3. **The core never imports an LLM provider.** Swapping or removing the judgment layer must not break it.

## 4 Layer A — Deterministic transforms (`scripts/redesign.js`)

Pure functions, `(lc, params) → { lc, change }`. No LLM, no I/O, fully testable.

| Transform | Signature | Graph operation | Applicability |
|---|---|---|---|
| `parallelize` | `(lc, {nodeIds})` | Replace a linear chain with AND-split → branches → AND-join | **Mechanical** *only* when data-object dependencies prove independence — otherwise judgment (§5.1) |
| `isolateException` | `(lc, {endId})` | Move an inline exception path onto a boundary event / event-subprocess | **Judgment always** (§4.1) |
| `reorderKnockouts` | `(lc, {gatewayIds, order})` | Re-sequence knock-out checks (order supplied by math) | Judgment (needs estimated numbers, §5.2) |
| `mergeTasks` | `(lc, {nodeIds})` | Compose consecutive same-lane micro-tasks into one | Judgment |
| `relane` | `(lc, {nodeId, lane})` | Move a task to another lane to cut handoffs | Judgment |

Rules for all transforms: preserve existing IDs where the node survives; generate schema-conform IDs for
new nodes; never silently drop edges; enforce `protectLanes`/`protectNodes` (reject the call, don't warn);
return a structured `change` record for the changelog.

### 4.1 Why `isolateException` can never be mechanical

Two constructs look similar but mean different things:
- **Inline branch** — `Task → XOR "Fehler?" → Ja → End`: *we checked and decided to reject.*
- **Boundary event** — attached to the task: *something interrupted the task while it was running.*

Converting the first into the second turns a business decision into a fault. Real example from a production
process: `"Frist überschritten (5 Werktage)"` genuinely is an interruption (boundary event correct), while
`"Antrag ablehnen (kein Vertragsabschluss)"` is a decision (boundary event wrong). Both are "exception
paths" to the detector. Only naming/semantics separates them — that is the agent's job, not the code's.

## 5 Layer B — The math (`scripts/redesign-math.js`)

Where a published result exists **and the data to apply it exists**, use it instead of guessing. Where the
data is missing, say so — never dress an estimate as a computation.

### 5.1 Parallelizability — two-tier, because control flow ≠ dependency

The detector finds *sequential* tasks. Sequence in the drawing does **not** imply dependence:
`Adresse prüfen → Telefon prüfen → E-Mail prüfen` is parallelizable; `Partnerdaten erfassen →
Sanktionsprüfung → Schwebesatz anlegen` is not. **They look identical in the model.**

Note the common trap: in a drawn chain `A→B→C` the tasks are *totally ordered* by control flow, so the
control-flow graph contains **no antichain at all**. Independence can only be read off a **dependency**
graph — in Logic-Core, that means modelled data objects (`associations` / `dataObjectReference`).

- **Tier 1 (data objects present):** build the data-dependency DAG from associations; a set of pairwise
  incomparable tasks (an **antichain**) may be applied **mechanically**.
  > ⚠️ **Unverified:** whether the BPM literature actually uses the antichain/Dilworth framing for this —
  > or something else entirely — was **not** source-checked. Do not present it as an established method.
  > Note also that `Association` carries only `source`/`target`/`directed`: **undirected** associations
  > carry no read/write semantics, so independence cannot be proven from them → refuse.
- **Tier 2 (no data objects — the common case):** the control-flow chain yields *candidates* only. The
  agent judges business independence from names/semantics; the result is a **proposal requiring
  confirmation**, marked `judgment: true`. No mathematical claim is made.

### 5.2 Knock-out ordering — correct rule, usually missing inputs

The commonly cited rule is to order checks by **ascending `effort / rejectionProbability`** (least cost
per rejection).

> ⚠️ **Unverified — treat as unchecked.** A source check for this rule (its exact published form, its
> optimality claim and that claim's assumptions) was **started and deliberately abandoned**; the earlier
> attribution to "Reijers/van der Aalst" had **no matching reference** in §13. Until someone verifies it
> against the primary literature, this repository must **not** assert it as optimal or proven.

Practical consequence, independent of the open question: **Logic-Core carries neither number**, so the
tool cannot compute an order at all. It therefore **applies an order that is handed to it** and refuses
when none is given — no invented figures, no optimality claim.

### 5.3 Always computable

- **Critical path / cycle time**: longest weighted path (CPM) — only when durations are supplied; used to
  quantify the effect of a parallelization.
- **Trade-off score (MCDA)**: weighted sum over the devil's quadrangle `(time, cost, quality, flexibility)`
  with the policy weights → ranks competing advisories. Reijers explicitly warns that improving one
  dimension can worsen another; the score surfaces that instead of hiding it.
- **Handoff count**: lane-crossing edges before/after a `relane` — a pure count, always computable (local
  greedy improvement only; no global partitioning in this increment).

## 6 Layer C — The judgment layer (two consumers)

### 6.1 Consumer A — the Claude Code subagent (primary, key-free)

In the skill path **Claude in the session is the judgment layer** — there is no `llmProvider` and no API
key. The "freely definable agent" is therefore not custom runner code but a **subagent definition** the
user can edit:

```markdown
<!-- .claude/agents/redesign.md -->
---
name: redesign
description: Use when a Soll/to-be process should be derived from an existing IST BPMN model.
tools: Bash, Read          # deliberately no Edit/Write — it may only call the transforms
model: inherit
---
Mission, default weights, hard limits, how to call the transforms, when to stop.
```

Why this shape:
- **Free definability without code** — redefining the agent means editing this file, not shipping a runner.
- **Least privilege** — restricted to `Bash, Read`, it *cannot* edit arbitrary files; all model changes go
  through the validated transforms.
- **Context economy** — the recompute-per-step loop (§6.2) runs many iterations; encapsulated in a
  subagent, only the changelog returns to the main conversation.
- **Zero key surface** — the CLI/pipeline stay 100% deterministic, which matters for regulated deployments.

Brief and policy are passed as invocation arguments; the definition file supplies the defaults.

### 6.2 Consumer B — headless (`scripts/agents/redesign.js`, last phase)

Same policy surface for HTTP/CI use, driven by an `llmProvider`. This is the only path that needs a key —
see §8.1 for key hygiene and cost caps. It must produce the same result shape as consumer A.

```js
redesignAgent({
  logicCore,                       // IST
  brief: "Durchlaufzeit und Übergaben senken, aber Vier-Augen-Prinzip erhalten.",
  policy: {
    weights:      { time: 0.5, cost: 0.2, quality: 0.2, flexibility: 0.1 },
    enable:       ['O01','O02','O03','O04'],   // heuristics in play
    protectLanes: ['Compliance'],              // never touched
    protectNodes: ['task_vier_augen'],
    maxChanges:   5,
    autonomy:     'safe',   // 'propose' | 'safe' (default) | 'full'
    maxLlmCalls:  12,
  },
  llmProvider,
})
```

**Autonomy levels** — the "as far as it can" dial:
- `propose` — nothing applied; returns the ranked, parameterized plan only.
- `safe` (default) — applies only transforms that are **provably** applicable from the model: today that is
  `parallelize` **in tier 1 only** (data-object-proven independence, §5.1). Everything else — including
  `isolateException` — comes back as a proposal.
- `full` — also applies judgment-dependent transforms (`isolateException`, `mergeTasks`,
  `reorderKnockouts`, `relane`), each still soundness-validated and logged with its rationale.

Consequence to accept knowingly: on models without data objects, `safe` applies **nothing** and behaves
like `propose`. That is intended — silence beats a confidently wrong redesign.

### 6.3 What the agent actually sees

Not the raw Logic-Core JSON (unbounded tokens on large models). Per step it receives a **compact process
digest**: nodes as `id | type | name | lane`, edges as `source → target [label]`, the current advisory plan
(structured), the Lean metrics, and the brief/policy. Data objects and associations are included when
present, since they decide tier 1 vs tier 2.

### 6.4 Convergence — recompute after every applied step

After each successful transform the detection (`optimize.js`) **re-runs on the new Soll**, and the plan is
re-ranked. Rationale: one change invalidates or creates others (parallelizing a chain removes its own
handoff finding and can expose a new one). The loop ends when: the brief is satisfied, no applicable
advisory remains, `maxChanges` is hit, or `maxLlmCalls` is exhausted — whichever comes first. Every exit
reason is reported.

### 6.5 Cost control

`maxLlmCalls` (default 12) caps total agent calls across all iterations; the digest keeps per-call payload
bounded. On exhaustion the run stops cleanly and returns the Soll reached so far plus the remaining
proposals — never a partially-applied, unvalidated state.

**What the agent contributes (the non-computable part):**
1. Reads the brief → maps it to weights/goals, overriding defaults where the text is explicit.
2. **Semantic veto**: rejects structurally-valid but businesslike-wrong changes ("these two tasks must stay
   separate — different legal responsibility"). This is the main reason a human-level judgment is needed.
3. **Estimates missing numbers** (effort, rejection probability) so §5's math can run — each estimate is
   flagged `estimated: true` in the changelog, never presented as measured.
4. Resolves contradicting heuristics (e.g. *control addition* vs *task elimination*) against the brief.
5. Stops when the brief is satisfied or `maxChanges` is reached.

## 7 IST ↔ Soll + changelog

- IST Logic-Core is **deep-frozen** at entry; all work happens on a clone.
- Output: `{ ist, soll, changelog, advisories: {applied, proposed, rejected}, metricsBefore, metricsAfter }`.
- Each changelog entry: `{ transform, targets, advisoryId, rationale, estimated?, tradeoff, sound: true }`.
- Rendering: `<base>_ist.bpmn/.svg` and `<base>_soll.bpmn/.svg`, plus the Lean metrics of both so the
  improvement is visible (e.g. handoffs 7 → 4).

## 8 Safety invariants

1. Every transform is followed by `validateLogicCore`; **errors ⇒ rollback that step** (Soll never ships
   unsound).
2. `protectLanes` / `protectNodes` are enforced **in the transform layer**, not just the prompt — a
   protected element cannot be modified even if the agent asks.
3. `maxChanges` caps the blast radius; the loop terminates deterministically.
4. Nothing overwrites the user's input file; IST stays intact.
5. Estimated numbers are always marked as estimates.
6. **The deterministic core stays key-free.** `redesign.js` / `redesign-math.js` / `optimize.js` must not
   import `llm-provider.js`. The CLI redesign entry runs without any API key; only consumer B needs one.

### 8.1 Key & cost safety (consumer B only)

The headless agent is the first component that turns *one* request into *many* paid LLM calls. That needs
explicit limits — today's HTTP rate limit (30 req/min) counts requests, not model calls.

1. **Server-side hard cap.** `maxLlmCalls` from a client request is clamped to a server maximum
   (env-configurable). A caller cannot raise its own budget.
2. **No key leakage.** The API key never appears in the changelog, the Soll artifacts, error messages, or
   the audit log — errors from `llm-provider.js` are redacted before they reach a response.
3. **Audit.** Each redesign run writes an audit entry (run id, model, calls used, transforms applied,
   exit reason) — LLM calls are currently unaudited, and an autonomous, mutating agent is exactly the
   thing that should not be.
4. **Sovereign/local operation.** `createLlmProvider` already supports keyless local models
   (`apiKey: 'none' | 'local'`); the redesign agent must work in that setup, since regulated deployments
   may not send process models to an external provider.
5. **Fail closed.** No provider configured ⇒ the agent returns proposals (`propose` behaviour) instead of
   erroring the whole pipeline.

## 9 Testing strategy

- **Transforms** (no LLM): per transform, a before/after Logic-Core assertion + "result is still sound" +
  "IDs preserved" + "protected elements untouched".
- **Math**: knock-out ordering against a hand-computed optimal order; antichain detection on a known
  data-dependency DAG (**and** the negative case: a plain control-flow chain yields no antichain);
  MCDA ranking monotonic in the weights.
- **Tiering**: identical chain with and without data objects → tier 1 mechanical vs tier 2 proposal.
- **Agent** with a mock `llmProvider` (pattern already used in `orchestrator.test.js`): honors `autonomy`,
  respects `maxChanges` and `maxLlmCalls`, applies the semantic veto, marks estimates.
- **Convergence**: advisories are recomputed after each step; a finding removed by a transform does not
  reappear; the loop terminates and reports its exit reason.
- **Rollback**: a transform forced to produce an unsound graph must be rolled back and reported.
- **Golden IST→Soll**: one fixture through the full run; Soll renders and stays OMG-valid.
- **Regression**: full suite green; document mode and existing goldens untouched.

## 10 Risks

| Risk | Mitigation |
|---|---|
| Agent invents plausible but wrong estimates | Flag `estimated: true`; `safe` autonomy excludes estimate-driven transforms |
| Transform produces a subtly wrong graph | Soundness re-validation + rollback; per-transform unit tests |
| Over-optimization destroys intent | Brief + protect lists + `maxChanges`; IST always preserved |
| Advisory contract change breaks consumers | **Corrected after review:** the earlier claim "no known consumers" was **wrong** — six exist in-repo (`pipeline.js:388` CLI print, five assertions in `pipeline.test.js`, `mcp-bpmn-server.js:110`, `api-reference.md`, `SKILL.md`, `http-server.test.js`). `advisories` still become objects, but a `message` field is **mandatory** so the CLI stays human-readable, the five tests must be migrated, and the MCP/HTTP response shape must be re-documented. The field is hours old (PR #23 merged 2026-07-24 20:14), not a day |
| Parallelization applied to genuinely dependent tasks | Tier 1/tier 2 split (§5.1): mechanical only on data-object-proven independence; otherwise confirmation required |
| Recompute-per-step makes runs expensive | `maxLlmCalls` budget + compact digest (§6.1, §6.3) |

## 11 Acceptance

- A chain with data-object-proven independence is parallelized end-to-end, Soll is sound, metrics improve,
  and the changelog names the advisory + rationale.
- The **same chain without data objects** is *not* applied under `safe` — it comes back as a proposal
  marked `judgment: true`.
- `autonomy: 'propose'` changes nothing; `full` also applies judgment transforms.
- A protected lane is never modified, even when the agent proposes it (enforced in the transform layer).
- After an applied transform, advisories are recomputed; a finding invalidated by the change is gone.
- **A full redesign runs end-to-end without any API key** (consumer A); `grep -r llm-provider` finds no
  import in the core modules.
- Consumer B produces the same result shape as consumer A, clamps `maxLlmCalls` server-side, leaks no key,
  and works against a local/keyless model.
- Full test suite green; `document` mode output byte-identical to before.

## 12 Phasing

Skill path first — it delivers the whole feature without ever needing a key; the headless agent lands last.

1. **P1** — advisory enrichment (`targets` + `transform`) in optimize.js
2. **P2** — `redesign.js` transforms + `redesign-math.js` (deterministic, no LLM, fully tested)
3. **P3** — IST↔Soll rendering, changelog, CLI entry
4. **P4** — consumer A: `.claude/agents/redesign.md` + SKILL.md workflow → **feature complete, key-free**
5. **P5** — consumer B: `agents/redesign.js` headless + §8.1 key hygiene, audit, server cost cap

P1–P3 are valuable on their own: the transforms are callable and testable with no judgment layer at all.

## 13 References

- Reijers, H.A. & Limam Mansar, S. (2005): *Best practices in business process redesign*, **Omega** 33(4) —
  redesign heuristics, knock-out ordering, devil's quadrangle.
- BABOK v3 (2015) §10.34 Process Analysis — Lean waste categories, handoffs.
- Dilworth (1950) — antichain decomposition, used for parallelizable task sets.
- Increment 1: `scripts/optimize.js`, layer 5 in `references/fachliches-regelwerk.md`.

Only published sources are cited in this repository.
