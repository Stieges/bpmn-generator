---
name: bpmn-generator
description: >
  Generates OMG BPMN 2.0.2-compliant process diagrams (BPMN XML with diagram interchange plus an
  SVG preview) and DMN 1.3 decision models (DMN XML) from natural-language descriptions,
  Logic-Core/Decision-Core JSON, or existing .bpmn/.dmn files. Validates soundness and modelling
  style, lays the diagram out automatically, and can enumerate process scenarios and preview
  redesigns. Use when the user asks to draw, model, document or visualize a business process,
  workflow or decision table, to edit or import a BPMN or DMN file, or mentions "BPMN", "DMN",
  "Prozessmodell", "Ablaufdiagramm", "Geschäftsprozess", "Entscheidungstabelle", "bpmn.io" or
  "Camunda Modeler".
---

# BPMN Generator

Turns a process description into **OMG BPMN 2.0.2** XML + SVG, and a decision description into
**DMN 1.3** XML. You extract a JSON model; the pipeline validates, lays out and serialises it.

```
User text ──[you: extraction]──> Logic-Core JSON ──[pipeline]──> validation ─> ElkJS layout ─> .bpmn + .svg
Rule text ──[you: extraction]──> Decision-Core JSON ──[dmn pipeline]──> validation ─> layout ─> .dmn
```

**You never write coordinates.** Layout is 100 % algorithmic; the JSON carries topology only.

**Run vs. read.** Commands in this file and in the reference files are meant to be **run**, from the
skill's `scripts/` directory (install once: `npm install --omit=dev` there — see
`references/cli.md`). Reference files are meant to be **read** when the "load when" line below says so.

---

## Modes: document (default) vs. optimize

| Mode | When | What changes |
|------|------|--------------|
| `document` (IST / as-is) | the user wants the process captured **faithfully** — the default everywhere | nothing is judged or improved |
| `optimize` (Soll / to-be) | the user asks for a **better** process | adds non-blocking `advisories` (O01–O04) with trade-off tags; never auto-applied |

Select it with `--optimize` on the CLI. Present advisories as options, never apply them silently.
Applying one is a separate, explicit step — see `references/redesign-toolbox.md`.

---

## Advise the user

Do not just transcribe. When a modelling choice is open, propose the construct that fits, say in one
line why, and **ask what the diagram is for** when that decides it: a **business** view (who does
what, in what order), an **IT/integration** view (which systems exchange what), or an
**audit/compliance** view (who is responsible, where the evidence is).

- **Pools** are participants (organisations); one expanded pool for the process in scope, a
  collapsed pool per external party. **Lanes** are roles, never people, at most 25 characters.
- **IT systems** depend on the view: an attribute of a `serviceTask`, a system lane, a collapsed
  pool, or an expanded pool — ask which picture is wanted.
- **Decisions by rules** belong in a DMN decision table behind a `businessRuleTask`, not in a
  cascade of gateways — see `references/dmn.md`.
- Do not fill the `role` and `system` fields during extraction yet; they do not change the drawing.

The full guide (construct-by-construct table with the rule that warns on a wrong choice) is in
`references/modeling-guide.md`.

---

## Extraction rules (Logic-Core)

Before writing JSON, read `references/logic-core-schema.md` (field contract) and use the Master
Extraction Prompt in `references/prompt-template.md`. These rules always apply:

**Naming**
- Tasks: object + verb — German `Antrag prüfen` (infinitive last) or English verb-first
  `Review application`. Not `Prüfung`. (M01)
- XOR gateways: a question — `Antrag gültig?`. AND/OR gateways: empty or a brief label.
- Every outgoing edge of an XOR split is labelled (`Ja`/`Nein`, `approved`/`rejected`); mark one
  `isDefault: true`.
- Lanes: functional roles — `Sachbearbeiter`, never `Max Müller`.
- Events: noun phrase in a state — `Antrag eingegangen`.

**Granularity**
- 7–10 nodes per level; move a group of more than 3 logical steps into a `subProcess`.
- No "god tasks" hiding a whole sub-process; prefer more granular over too abstract.

**Happy path**
- Mark the main success flow with `"isHappyPath": true`; the layout puts it on the horizontal axis
  and branches exceptions off it.

**Gateway direction** (OMG §10.5.1)
- `has_join: true` on a joining gateway → `Converging`; splits become `Diverging`, split+join
  `Mixed` — automatically. Close every split with a join of the **same type** unless the branches
  end in separate end events.

**Event markers**
- Set `marker` (`message`, `timer`, `error`, `signal`, …) whenever the trigger is clear; otherwise
  the pipeline infers it from the name (`Frist abgelaufen` → timer).

---

## Pre-delivery gate (MANDATORY — do not skip)

A first draft is expected to be wrong. **Never present a diagram as finished until it passes this
gate.** Warnings are not noise — they are the alarm.

1. **Read `references/logic-core-schema.md` first.** It is the field-by-field contract (every node
   type, marker, edge, message flow, black-box pool). Fill the input file against it — do not guess
   field names or values.
2. **Validate the draft against the schema and run it strictly:**
   ```bash
   node bpmn/pipeline.js <input>.json <output> --strict
   ```
   - The schema gate (`references/input-schema.json`) rejects malformed structure with a precise
     field path and exits non-zero — fix every reported field.
   - `--strict` makes every warning fatal (exit non-zero, no files written), across four
     independent checks: rule-engine warnings, diagram (DI) integrity, Petri-net translation (NC)
     integrity, and BPMN serialisation (the round trip of the generated XML through bpmn-moddle —
     this is what catches an invalid element, e.g. an annotation carrying an illegal attribute).
3. **Resolve every warning** and re-run until `--strict` exits `0`. Delivering a diagram with
   unresolved warnings is not allowed.
4. Only then present the output. If a warning is a deliberate, justified exception, say so
   explicitly to the user — do not silently ship past it.

The same gate applies to DMN: `node dmn/pipeline.js <input>.json <output> --strict`.

---

## Core commands

Run from `scripts/`:

```bash
node bpmn/pipeline.js process.json out --strict      # Logic-Core → out.bpmn + out.svg
node bpmn/pipeline.js process.json out --optimize    # same, plus optimisation advisories
node bpmn/import.js existing.bpmn extracted.json     # BPMN XML → Logic-Core (round trip)
node dmn/pipeline.js decision.json out --strict      # Decision-Core → out.dmn (no SVG yet)
```

Outputs: `*.bpmn` opens in Camunda Modeler, bpmn.io, ADONIS, Signavio; `*.svg` in a browser or
Office; `*.dmn` in dmn.io or Camunda Modeler. Keep the Logic-Core JSON — it is the source for every
later amendment. All flags: `references/cli.md`.

**No Node.js available** (e.g. Claude.ai without code execution): use the ElkJS HTML template in
`references/inline-template.md` for an SVG preview. It still lays out algorithmically; it writes
no BPMN XML, so recommend the pipeline for a deliverable file.

---

## Amendment flow (editing an existing diagram)

1. Load the existing Logic-Core JSON (from a `.bpmn` file: `node bpmn/import.js` first — see
   `references/round-trip.md`).
2. Apply only the requested atomic changes, using the Amendment Prompt in
   `references/prompt-template.md`.
3. **Preserve every existing id** — never regenerate the Logic-Core from scratch for a small edit.
4. Re-run the pre-delivery gate.

---

## Errors

| Message | Cause | Fix |
|---------|-------|-----|
| schema gate error with a field path | field name, type or enum value wrong | fix that field against `references/logic-core-schema.md` |
| `Missing startEvent` / `Missing endEvent` | a process without start or end | add the event |
| `Edge "…" unknown source` / `unknown target` | an edge names a node id that does not exist (S03) | fix the id |
| S05 / S06 (deadlock, split/join mismatch) | e.g. an XOR split feeding an AND join | join with the same gateway type |
| `--strict: N warning(s)` | unresolved rule, DI, NC or XML warning | fix and re-run; see `references/fachliches-regelwerk.md` for the rule |
| `npm install` fails | no network or Node.js < 20 | install Node.js ≥ 20 |

---

## Reference files

Load only the file the task needs; each is self-contained.

| File | Load when … |
|------|-------------|
| `references/logic-core-schema.md` | **always before extracting or editing Logic-Core** — fields, node types, markers, pools, associations, examples |
| `references/prompt-template.md` | extracting, reviewing or amending — prompt templates, two-agent loop, few-shot patterns |
| `references/modeling-guide.md` | the user needs advice: pools vs. lanes, IT systems, which construct to use when |
| `references/dmn.md` | the process contains a rule-based decision, or the user asks for DMN or a decision table |
| `references/cli.md` | setting up, or you need a flag beyond the core commands |
| `references/round-trip.md` | the user supplies an existing `.bpmn` file to edit or check |
| `references/redesign-toolbox.md` | the user wants an advisory applied or a process restructured mechanically |
| `references/inline-template.md` | no Node.js is available and only a browser preview is possible |
| `references/fachliches-regelwerk.md` | explaining or resolving a specific rule finding (S/M/P/WF/O/SC/D/B ids) |
| `references/omg-compliance.md` | the user asks what the XML guarantees or how an OMG element is mapped |
| `references/api-reference.md` | integrating through the HTTP API instead of the CLI |
| `references/input-schema.json` | the formal Logic-Core JSON Schema (the gate) — read when a schema error is unclear |
| `references/decision-core-schema.json` | the formal Decision-Core JSON Schema (the DMN gate) |
| `references/api-schema.json`, `references/rule-profile-schema.json`, `references/ontology.jsonld` | machine-read by the scripts; open only to debug the HTTP contract, a rule profile or the vocabulary |
