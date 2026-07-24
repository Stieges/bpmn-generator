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

| Transform | Signature | Graph operation |
|---|---|---|
| `parallelize` | `(lc, {nodeIds})` | Replace a linear chain with AND-split → branches → AND-join |
| `isolateException` | `(lc, {endId})` | Move an inline exception path onto a boundary event / event-subprocess |
| `reorderKnockouts` | `(lc, {gatewayIds, order})` | Re-sequence knock-out checks (order supplied by math) |
| `mergeTasks` | `(lc, {nodeIds})` | Compose consecutive same-lane micro-tasks into one |
| `relane` | `(lc, {nodeId, lane})` | Move a task to another lane to cut handoffs |

Rules for all transforms: preserve existing IDs where the node survives; generate schema-conform IDs for
new nodes; never silently drop edges; return a structured `change` record for the changelog.

## 5 Layer B — The math (`scripts/redesign-math.js`)

Where a published result exists, use it instead of heuristic guessing.

- **Knock-out ordering** (Reijers/van der Aalst): order checks by **ascending `effort / rejectionProbability`**
  — the least-cost-per-rejection rule. Optimal for expected processing cost under independent checks.
  *Needs numbers* (see §6 fallback).
- **Parallelizable sets**: tasks that are mutually unreachable in the dependency DAG form an **antichain**
  (Dilworth). Computed from the transitive closure — a candidate set for `parallelize`.
- **Critical path / cycle time**: longest weighted path (CPM) when durations are known; used to show the
  time effect of a parallelization.
- **Trade-off score (MCDA)**: weighted sum over the devil's quadrangle `(time, cost, quality, flexibility)`
  using the policy weights → ranks competing advisories. Reijers explicitly warns that improving one
  dimension can worsen another; the score makes that explicit rather than hiding it.
- **Handoff minimization**: lane reassignment scored by the count of lane-crossing edges (local greedy
  improvement; no global partitioning in this increment).

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
  },
  llmProvider,
})
```

**Autonomy levels** — the "as far as it can" dial:
- `propose` — nothing applied; returns the ranked, parameterized plan only.
- `safe` (default) — applies only **mechanical** transforms whose preconditions are fully decidable from
  the graph (`parallelize` on a verified antichain, `isolateException`); everything judgment-dependent is
  returned as a proposal.
- `full` — also applies judgment-dependent transforms (`mergeTasks`, `reorderKnockouts`, `relane`), each
  still soundness-validated and logged with its rationale.

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
- **Math**: knock-out ordering against a hand-computed optimal order; antichain detection on a known DAG;
  MCDA ranking monotonic in the weights.
- **Agent** with a mock `llmProvider` (pattern already used in `orchestrator.test.js`): honors `autonomy`,
  respects `maxChanges`, applies the semantic veto, marks estimates.
- **Rollback**: a transform forced to produce an unsound graph must be rolled back and reported.
- **Golden IST→Soll**: one fixture through the full run; Soll renders and stays OMG-valid.
- **Regression**: full suite green; document mode and existing goldens untouched.

## 10 Risks

| Risk | Mitigation |
|---|---|
| Agent invents plausible but wrong estimates | Flag `estimated: true`; `safe` autonomy excludes estimate-driven transforms |
| Transform produces a subtly wrong graph | Soundness re-validation + rollback; per-transform unit tests |
| Over-optimization destroys intent | Brief + protect lists + `maxChanges`; IST always preserved |
| Advisory contract change breaks consumers | `advisories` become objects but keep a human-readable `message`; documented in api-reference |

## 11 Acceptance

- A linear same-lane chain is parallelized end-to-end, Soll is sound, handoff/cycle metrics improve, and the
  changelog names the advisory + rationale.
- `autonomy: 'propose'` changes nothing; `safe` applies only mechanical transforms; `full` applies more.
- A protected lane is never modified, even when the agent proposes it.
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
