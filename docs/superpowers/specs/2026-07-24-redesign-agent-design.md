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
- `scripts/redesign.js` — deterministic transform library (pure functions, Logic-Core → Logic-Core)
- `scripts/redesign-math.js` — scoring/ordering math (knock-out order, antichains, critical path, MCDA)
- `scripts/agents/redesign.js` — the configurable agent (brief + policy → applied plan)
- Advisory enrichment in `scripts/optimize.js`: structured `targets` + `transform` per finding
- IST↔Soll snapshot handling + changelog
- CLI + programmatic entry; SKILL.md workflow section
- Tests: transform unit tests, math unit tests, agent-with-mock-LLM tests, IST→Soll golden

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

```
IST Logic-Core ──(frozen snapshot)──────────────────────────┐
      │                                                     │
      ▼                                                     │
optimize.js  ──▶ structured advisories                      │
   (Inc.1 detection + NEW targets/transform)                │
      │                                                     │
      ▼                                                     │
┌─────────────────────────────────────────────┐             │
│ agents/redesign.js  (CONFIGURABLE AGENT)    │             │
│  input: brief (free text) + policy (knobs)  │             │
│  decides: which advisories to apply, order, │             │
│           estimates missing numbers, judges │             │
│           semantics, resolves conflicts     │             │
└───────────────┬─────────────────────────────┘             │
                │ calls (never edits JSON by hand)          │
                ▼                                           │
      redesign.js transforms  +  redesign-math.js scoring    │
                │                                           │
                ▼                                           │
      validate (soundness/WF-net) ── fails ─▶ rollback step  │
                │ ok                                         │
                ▼                                            ▼
          Soll Logic-Core  ◀──── changelog ────▶  IST vs. Soll render
```

**Invariant:** the agent never hand-edits Logic-Core JSON. It selects and parameterizes transforms. Every
applied transform is validated; a step that breaks soundness is rolled back and reported, not kept.

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
  incomparable tasks (an **antichain**, Dilworth) is provably parallelizable → `parallelize` may be applied
  **mechanically**.
- **Tier 2 (no data objects — the common case):** the control-flow chain yields *candidates* only. The
  agent judges business independence from names/semantics; the result is a **proposal requiring
  confirmation**, marked `judgment: true`. No mathematical claim is made.

### 5.2 Knock-out ordering — correct rule, usually missing inputs

Order checks by **ascending `effort / rejectionProbability`** (least cost per rejection; Reijers/van der
Aalst). This minimizes expected processing cost for independent checks. **Logic-Core carries neither
number**, so in practice the agent estimates them → the result is always `estimated: true` and is a
proposal, never a mechanical application. Documented here so nobody mistakes the rule for something the
tool can currently compute unaided.

### 5.3 Always computable

- **Critical path / cycle time**: longest weighted path (CPM) — only when durations are supplied; used to
  quantify the effect of a parallelization.
- **Trade-off score (MCDA)**: weighted sum over the devil's quadrangle `(time, cost, quality, flexibility)`
  with the policy weights → ranks competing advisories. Reijers explicitly warns that improving one
  dimension can worsen another; the score surfaces that instead of hiding it.
- **Handoff count**: lane-crossing edges before/after a `relane` — a pure count, always computable (local
  greedy improvement only; no global partitioning in this increment).

## 6 Layer C — The agent (`scripts/agents/redesign.js`)

**Configured by both** a free-text brief and structured policy knobs:

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

### 6.1 What the agent actually sees

Not the raw Logic-Core JSON (unbounded tokens on large models). Per step it receives a **compact process
digest**: nodes as `id | type | name | lane`, edges as `source → target [label]`, the current advisory plan
(structured), the Lean metrics, and the brief/policy. Data objects and associations are included when
present, since they decide tier 1 vs tier 2.

### 6.2 Convergence — recompute after every applied step

After each successful transform the detection (`optimize.js`) **re-runs on the new Soll**, and the plan is
re-ranked. Rationale: one change invalidates or creates others (parallelizing a chain removes its own
handoff finding and can expose a new one). The loop ends when: the brief is satisfied, no applicable
advisory remains, `maxChanges` is hit, or `maxLlmCalls` is exhausted — whichever comes first. Every exit
reason is reported.

### 6.3 Cost control

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
| Advisory contract change breaks consumers | `advisories` become objects keeping a human-readable `message`; the field is one day old (PR #23) with no known consumers, so breaking now beats carrying two parallel structures forever. Documented as a contract change in api-reference |
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
- Full test suite green; `document` mode output byte-identical to before.

## 12 Phasing

1. **P1** — advisory enrichment (`targets` + `transform`) in optimize.js
2. **P2** — `redesign.js` transforms + `redesign-math.js` (deterministic, no LLM, fully tested)
3. **P3** — `agents/redesign.js` (brief + policy + autonomy) on top
4. **P4** — IST↔Soll rendering, changelog, CLI entry, SKILL.md workflow

P1+P2 are valuable on their own: even without the agent, the transforms are callable and testable.

## 13 References

- Reijers, H.A. & Limam Mansar, S. (2005): *Best practices in business process redesign*, **Omega** 33(4) —
  redesign heuristics, knock-out ordering, devil's quadrangle.
- BABOK v3 (2015) §10.34 Process Analysis — Lean waste categories, handoffs.
- Dilworth (1950) — antichain decomposition, used for parallelizable task sets.
- Increment 1: `scripts/optimize.js`, layer 5 in `references/fachliches-regelwerk.md`.

Only published sources are cited in this repository.
