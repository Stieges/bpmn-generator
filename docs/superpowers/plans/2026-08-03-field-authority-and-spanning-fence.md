# Root fix: one authority for BPMN field knowledge, and the fence that spans all four places

## Context — the root, measured

Two phases on `fix/container-aware-petri-net` fixed ~20 defects that all had one shape: something
asserts one thing and does another. The root-cause investigation measured why the class keeps
reproducing:

**BPMN semantic knowledge — which class carries which field, and how Logic-Core maps to OMG — has
no single machine-readable statement in the project.** It exists as ~30 hand-written restatements:
`$defs.Node` declares all 31 fields flat on every type (zero conditional keywords in the schema);
both importers carry a full copy of the NodeType enum and import nothing from `types.js`;
`bpmn-xml.js` has 6 inline class guards beside the 6-row table; `bpmnXmlTag` is a 24-entry identity
map whose `|| 'task'` fallback silently turns any unknown type into a task — and the field table is
deliberately bent around that defect.

The field-fidelity matrix over all 31 Node properties: **5 silent round-trip losses** (including one
our own final-review fix `e263551` introduced: write side widened for `transaction`+
`isEventSubProcess`, `moddle-import.js:285` and `import.js:383` still say `type === 'subProcess'`);
**3 fields the SVG renders but nothing serialises** (`isAdHoc`, `isInterrupting`,
`edge.isConditional` — right in our preview, wrong in every real tool); **3 unguarded writes** that
moddle drops silently (`loopType`, `multiInstance`, `decisionRef`); **1 schema-valid crash**
(`nodes` on a non-container → TypeError after a green rule engine); and the serialiser
**fabricates** edge semantics (copies `label` into `conditionExpression` at `bpmn-xml.js:485`,
makes the last outgoing XOR/OR edge `default` at `:594-600` — LC→XML→LC is not idempotent).

Secondary root: the guards built so far check restatements against each other or against our own
schema. Three fences were simultaneously green over the live `isCollection` defect because an
internally consistent table is consistent with itself regardless of what it claims about the world.
The external oracles exist — bpmn-moddle's metamodel (60 KB JSON, already a runtime dep, resolver
already written at `types.test.js:140-152`) and the real round trip — but cover 6 of 31 fields and
never the importers.

**Trust boundary for the metamodel, verified:** it derives 5 of 6 `allowed` sets exactly and would
scope ~12 fields (immediately flagging `instantiate` — OMG grants it to `receiveTask` too — and
`edge.isDefault` as under-scoped today). But it puts `InteractionNode` on SubProcess/CallActivity,
contradicting the normative CMOF — deriving *class relations* from it would invert rule S14. So:
metamodel = authority for **attribute scoping**; the CMOF-cited hand statements in `types.js` stay
authoritative for class relations.

## Decisions taken (owner, 2026-08-03)

- **Scope: core first — Stages 0–2 now (~7 subagent rounds).** Stages 3–7 and the two decided
  feature items land as `roundTrip:'lossy'/'none'` rows with reasons in the table, i.e. stated debt
  the fence reports, and follow after B12 (or interleaved, owner's call then).
- **(i) The three render-only fields get implemented** (not removed, not merely documented) — in
  the backlog, not the core.
- **(ii) The edge fabrication gets removed.** Three goldens will legitimately move
  (`simple-approval`, `multi-pool-collaboration`, `dense-edge-labels` carry fabricated `default=`)
  — the one place a golden move is a defect fix. Backlog.
- **(iii) Schema per-type scoping: later, own initiative**, on top of the settled table.
- **Execution: subagent-driven + SDD** — one implementer per stage, task review after each, scoped
  re-review per fix round, ledger in the existing SDD workspace. **New findings beyond the brief are
  reported for a decision, never collected** (standing rule from this session).

## Execution model

Same branch and PR #46. Ledger: `.superpowers/sdd/es-gibt-neue-findings-stateful-treehouse/progress.md`
(append, keep the identity line). Every stage: red test first, measured before/after in the report,
`npm test` + `npm run docs-gate` green at the boundary, `git status --porcelain tests/fixtures/`
clean of `.expected.*` (no golden moves anywhere in the core — verified: no fixture carries the new
attr/type combinations).

---

## Stage 0 — the e263551 read-side regression (1 round)

`moddle-import.js:285` and `import.js:383`: widen `type === 'subProcess'` to include `transaction`
for `triggeredByEvent`. Red first: `{type:'transaction', isEventSubProcess:true, nodes:[…]}` through
`runPipeline` → both importers → the field must survive. Today the XML carries
`triggeredByEvent="true"` and the Logic-Core comes back without it, on both paths.

**Verify:** `cd scripts && npm test -- --testPathPatterns=pipeline`, new test greppable as
`transaction.*isEventSubProcess`.

## Stage 1 — the authority table (3 rounds)

**File: `scripts/bpmn/types.js`** — extend `OMG_NODE_FIELD_SCOPE` in place (keep the export name;
both consumers stay), add sibling `OMG_EDGE_FIELD_SCOPE`. **No new module, no generated artefact,
no runtime metamodel read** — `types.js` stays dependency-free; derivation lives in the test fence
(`createRequire('bpmn-moddle/resources/bpmn/json/bpmn.json')`, exported via bpmn-moddle's
`"./resources/*"` map; the `.skill` bundle never runs Jest, so its node_modules exclusion is
irrelevant).

Two new columns on every row:
- **`shape`**: `'attr' | 'childElement' | 'eventDefinition' | 'extension' | 'di' | 'labelRouting'
  | 'layoutOnly' | 'unserialised'` — names the mechanism without claiming to implement it.
- **`roundTrip`**: `'exact' | 'presence' | 'lossy' | 'none'` plus mandatory `reason` below
  `'exact'`. **This column IS the fence's exclusion list — there is no second list.**

Rows for all 31 Node fields and the 8 Edge fields (hard cases already designed: `marker` →
eventDefinition, exact; `isCollection` → `on:'dataObject'`, exact; `has_join` → lossy with reason
"gatewayDirection recomputed, only Converging maps back"; `edge.isDefault` → `on:'sourceGateway'`;
`isAdHoc`/`isInterrupting`/`isConditional` → `'none'`, reason "render-only, implementation decided
and queued"; `extensions` → `'none'`, reason "import-side preservation only"; `isHappyPath` →
`layoutOnly`).

Convert in the same stage: the 4 inline attr guards in `buildFlowNode` (`cancelActivity:268`,
`eventGatewayType:310`, `instantiate:311`, `script:351`) to the table loop; add `allowed` guards to
the 3 unguarded child-element writes (`loopType:328`, `multiInstance:338`, `decisionRef:362`) —
closing the silent moddle drops. Extend the metamodel fence in `types.test.js` from 6 rows to every
`shape:'attr'` row in both tables — **this forces the `instantiate` widening to
`{eventBasedGateway, receiveTask}` red-first** (write + both importer reads land here too).

Docs: S15's row in `references/fachliches-regelwerk.md` (**German** — edit to an existing German
section); CHANGELOG `[Unreleased]` (English).

**Verify:** `npm test -- --testPathPatterns='types|pipeline'`; before/after:
`<bpmn:receiveTask … instantiate="true">` emitted and re-imported.

## Stage 2 — the spanning fence (3 rounds)

**New file: `scripts/bpmn/field-fidelity.test.js`** (own file — it generates ~350–450 cases;
`pipeline.test.js` is past 5k lines).

Architecture:
1. **Completeness check**: `Object.keys($defs.Node.properties)` minus `{id,type}` must equal the
   table's field set (same for Edge). An unregistered schema field fails CI naming itself. This is
   the moment the four-places problem becomes structurally unforgettable.
2. **Per row with `roundTrip !== 'none'`**, for each type in `allowed ∩ NodeType-enum`, at depth 0
   **and depth 1** (inside a `subProcess` and a `transaction`): build a minimal Logic-Core via a
   fixture factory (generalise `pipeline.test.js:1410`'s `wire()`; boundary events get a host +
   outgoing flow; artifacts get the `place()` idiom; edge fields use an XOR with two labelled edges,
   `isDefault` set on the **first** edge so last-edge fabrication cannot fake a pass), run the real
   `runPipeline`, read back through **both** importers, assert per contract: `exact` = deep equal,
   `presence` = present, `lossy` = row-specific assertion.
3. **Per row with `'none'`**: assert the field does **not** survive — implementing it later turns
   the fence red and forces the table row (and reason) to be updated. Nothing changes silently in
   either direction.
4. Failure messages name field × type × depth × importer path.
5. Known-open defects at landing (nested-edge attrs at depth ≥ 1, drill-down transaction gap, …)
   land as downgraded rows with `reason: 'defect, queued stage N'` — the suite is green, the debt is
   **stated in the table**, and each backlog stage flips its row to `'exact'` red-first.

Complements, does not subsume, the `subprocess-child-fidelity.json` field-set guard (isolation ×
exhaustive vs. composition × realistic — keep both; one pointer sentence in the fixture guard).

**Verify:** `npm test -- --testPathPatterns=field-fidelity`; the count of `'none'`/`'lossy'` rows is
the measured debt figure and goes in the stage report.

---

## Backlog (decided, ordered, not in the core)

Each is a one-brief stage with its own red-first verification; the fence rows already point at them.

1. **Stage 3** — `nodes`-on-non-container crash: gate child recursion on a new `NESTING_NODE_TYPES`
   (`subProcess`, `transaction` — deliberately ≠ `CONTAINER_TYPES`), children dropped-and-reported
   via S15's message class (rule count stays 36). (1 round)
2. **Stage 4** — importer enum copies and `rules.js` M01/P02 copies → `types.js` imports.
   Behaviour-identical; importer isolation was verified to be accident, not doctrine. (1 round)
3. **Stage 5** — `bpmnXmlTag` unknown-type fallback → loud throw; `adHocSubProcess`'s silent
   task-disguise ends (documented behaviour change, resolves with backlog item 6). (1 round)
4. **Stage 6** — nested-edge attrs at depth ≥ 1 (`condition`, per-container `default`), write + both
   reads; flip the fence rows to `'exact'`. (2 rounds)
5. **Stage 7** — drill-down/`bridge.js` on `NESTING_NODE_TYPES`; `isSequenceFlowExempt` derives its
   `isEventSubProcess` leg from the table row (closes the event-`transaction` S04/S07 misfire). (1 round)
6. **Decision (i) implementation** — `isInterrupting` (StartEvent attr), `edge.isConditional`
   (conditionExpression marker), `isAdHoc` (requires emitting `adHocSubProcess` as a real class;
   dissolves the metamodel-fence allowlist). (2–3 rounds)
7. **Decision (ii) removal** — delete the label→condition copy and the auto-default-last; **three
   goldens move legitimately and are inspected, not regenerated blind** (`simple-approval`,
   `multi-pool-collaboration`, `dense-edge-labels`); M08 carries the "XOR without default" message
   instead. Fence rows tighten to `'exact'`. (1–2 rounds)
8. **Decision (iii)** — schema per-type scoping via `allOf`/`if`/`then` forbids, generated **text**
   from the table (committed, fenced against it), `additionalProperties:false` intact. Own
   initiative, after B12. **Note:** `field-fidelity.test.js`'s completeness check asserts today's
   flat `$defs.Node`/`$defs.Edge` shape as its premise and will fail on the first applicator
   keyword — deliberately, so the fence is taught the new shape in the same commit rather than
   silently covering less. The two statements of per-type scoping (the schema's and the table's
   `allowed`) get reconciled there, which is the real content of this item.
9. **Container-level field authority** — the tables and the spanning fence cover per-**node** and
   per-**edge** fields only. Process-, pool- and lane-level fields (`lanes`, a pool's `name`, a
   process's `documentation`, `messageFlows`, `associations`) have no row and no round-trip
   contract, so the four-places class is unfenced at that level. Not a defect of Stage 2 — its
   brief scoped it out — but nothing else covers it either, and the same shape of loss is available
   there. Scope before size: decide whether these want rows in a third table or a separate fence.
   (Unsized, unscheduled.)

## Verification (core)

```bash
cd scripts
npm test                 # 0 regressions; new fences green; count of stated-debt rows reported
npm run docs-gate        # exit 0
git status --porcelain tests/fixtures/   # no .expected.* moves in the core
```

End-to-end: `{type:'transaction', isEventSubProcess:true}` survives both importers (Stage 0);
`<bpmn:receiveTask instantiate="true">` round-trips (Stage 1); adding a dummy field to
`$defs.Node.properties` makes `field-fidelity.test.js` fail naming it, then remove it (Stage 2 —
the same bite-demonstration discipline as the docs-gate and NodeType fences).

## After the core

**B12 (DMN-1.3-XML importer)** — own plan, next. The core gives it a serialisation layer whose
fidelity is fenced, and Stage 4b already made CI validate DMN output against the normative XSD, so
the importer's round trip is CI-checkable from day one.

CLAUDE.md's "Adding a per-node field" section rewrites at the end of the core to: *add a table row;
`field-fidelity.test.js` names every place you missed.*
