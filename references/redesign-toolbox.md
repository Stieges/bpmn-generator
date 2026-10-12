# Redesign toolbox

Load this when the user wants an optimisation advisory applied, or a process restructured
mechanically (parallelise a chain, merge tasks, move a node to another lane, reorder knock-out
checks, turn an exception branch into a boundary event). For *finding* such opportunities, run the
pipeline with `--optimize` first (`SKILL.md`, "Modes").

## Contents

- [From advisory to transform](#from-advisory-to-transform)
- [The five transforms](#the-five-transforms)
- [Guarantees](#guarantees)
- [Running it](#running-it)

## From advisory to transform

In `optimize` mode the pipeline returns non-blocking **advisories** — review suggestions with
trade-off tags (time/cost/quality/flexibility). They are heuristics (Reijers 2005 + BABOK Lean
metrics), not proofs: present them as options, never apply them silently. Each advisory is an
object `{ id, transform, targets, message, tradeoff, ref, judgment }` (see
`references/api-reference.md`); `message` is the human-readable line, and `transform` names the
matching intervention below.

Detected automatically by `scripts/bpmn/optimize.js`: O01 → `isolateException`,
O02 → `reorderKnockouts`, O03 → `relane`, O04 → `parallelize`. `mergeTasks` has no detector and is
reachable only by direct invocation.

## The five transforms

The transforms live in `scripts/bpmn/redesign.js`; each has a `preview*` function (is it feasible,
and why not) and an `apply*` function that performs it.

- `parallelize` — puts a linear, same-lane task chain into a parallel-gateway split/join. **Tasks
  only:** a chain containing a subprocess, a call activity, an intermediate event or a gateway is
  refused, because parallelising a scope or a branch changes the process logic rather than the
  order of its steps. This is also why **O04 never nominates a subprocess chain** — the detector is
  scoped to the same leaf-task set as the transform, so it cannot advise something the toolbox is
  guaranteed to refuse.
- `mergeTasks` — folds a linear task chain into one task; **requires an explicit `name`** — naming
  the result is a judgment call the toolbox refuses to make for you.
- `relane` — moves one node to a different lane.
- `reorderKnockouts` — reorders a chain of exclusive-gateway "knock-out" checks; **requires an
  explicit `order`** — it is never computed.
- `isolateException` — turns an inline exception branch into a boundary event on the owning task;
  **requires explicit `marker` and `cancelActivity`**, and, when the exception end has more than one
  incoming edge, an **explicit `edgeIds`** naming which ones belong to this task — it refuses rather
  than guess.

## Guarantees

**No language model.** The toolbox is purely deterministic: `scripts/bpmn/redesign-core.js` may not
import `agents/llm-provider.js`, directly or transitively — no LLM call, no API key.

**Rollback.** Every `apply*` re-checks its result against a fixed, **profile-independent** soundness
gate (soundness + workflow-net layers, always on — `SOUNDNESS_GATE` in
`scripts/bpmn/redesign-core.js`) and rolls back (throws, writes nothing) on structural errors.
Style warnings never block; they come back in the result's `warnings` array.

**It does not decide for you.** The toolbox never decides *whether* an intervention should happen —
that is the caller's call. Where a transform lacks the information to act safely (no proven
data-independence between two tasks, no supplied ordering, no supplied marker/`cancelActivity`, an
ambiguous set of incoming edges) it refuses with a specific reason instead of guessing.

**Protection lists** (`policy.protectNodes` / `policy.protectLanes`) match a node or lane by id
**and** by display name, and resolve lane membership whether the model expresses it via `node.lane`
or via `Lane.nodeIds`. Transforms also **maintain** both representations: a transform that deletes
a node removes it from any `Lane.nodeIds`, and one that creates a node adds it. Purely `node.lane`
models are left untouched (no `nodeIds` arrays are introduced).

**Change record.** Every `apply*` returns a `change` record with three arrays — `added`, `removed`,
`modified` — that together name every element (node, edge or lane) that differs between input and
result.

## Running it

Run from `scripts/`. Preview is the default; nothing is written without `--apply`; a refusal exits
non-zero and writes nothing.

```bash
node bpmn/redesign-cli.js <input.json> <parallelize|mergeTasks|relane|reorderKnockouts|isolateException> \
  [--nodes a,b,c] [--node n] [--name "..."] [--lane X] [--order g2,g1] [--end xend] [--attach-to task] \
  [--marker timer] [--cancel-activity true|false] [--edges j2,j5] [--policy '{"protectNodes":[...]}'] \
  [--apply] [-o out.json]
```

After an `--apply`, run the result through the pre-delivery gate in `SKILL.md`
(`node bpmn/pipeline.js out.json out --strict`) before showing it.
