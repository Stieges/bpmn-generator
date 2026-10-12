# DMN decision models

Load this when a process contains a decision made by rules, or when the user asks for DMN, a
decision table or an "Entscheidungstabelle". The DMN side mirrors the BPMN side: you write a JSON
model (**Decision-Core**), the pipeline validates it, lays out the decision requirements diagram
(DRD) and writes DMN 1.3 XML plus the DRD as SVG — and, on request, the decision tables as
Markdown, SVG and HTML.

## Contents

- [When a decision table fits](#when-a-decision-table-fits)
- [From rule text to Decision-Core](#from-rule-text-to-decision-core)
- [Worked example](#worked-example)
- [Confirm the table first](#confirm-the-table-first)
- [Running the DMN pipeline](#running-the-dmn-pipeline)
- [Viewing the result](#viewing-the-result)
- [Linking a BPMN task to the decision](#linking-a-bpmn-task-to-the-decision)
- [The table in the task's documentation](#the-table-in-the-tasks-documentation)
- [Checking the bridge: scenario analysis](#checking-the-bridge-scenario-analysis)
- [Importing a DMN file](#importing-a-dmn-file)

## When a decision table fits

| Use a DMN decision table when … | Keep gateway logic in BPMN when … |
|---|---|
| the outcome follows from **rules over data** ("amount below 1 000 and premium customer → automatic") | a **person** judges (approve/reject after reading) — a `userTask` followed by a gateway |
| there are more than two or three conditions, or they combine | one yes/no question decides the path |
| the rules change more often than the process | the branch is part of the process structure itself |
| the same decision is used by several tasks or processes | the decision only routes this one flow |

The usual pattern is both: a `businessRuleTask` evaluates the table, and an exclusive gateway right
after it routes on the **result** ("Approval level?" → `auto` / `clerk or manager`). The gateway
names the result, never repeats the conditions.

## From rule text to Decision-Core

The formal contract is `references/decision-core-schema.json` — read it for every field. In short:

1. **Nodes** (`nodes`, at least one). `inputData` for each fact the decision reads (with `typeRef`:
   `number`, `string`, `boolean`, `date`); one `decision` per question; optionally a
   `knowledgeSource` (the policy the rules come from) and a `businessKnowledgeModel` (reusable
   logic). Every node needs `id`, `type`, `name`.
2. **Requirements** (`requirements`) read in flow direction: `source` is what is required, `target`
   what requires it. `information` for inputData/decision → decision, `knowledge` for a business
   knowledge model → decision, `authority` for a knowledge source.
3. **The decision table** (`decision.decisionTable`):
   - `inputs` — one column per fact, `expression` is the variable name, `label` the header.
   - `outputs` — at least one column; `allowedValues` lists the possible results.
   - `rules` — one row each: `when` holds one unary test per input column, in order (`< 1000`,
     `[1000..10000)`, `>= 10000`, `"premium"`, `-` for "any"); `then` one result per output column.
   - `hitPolicy` — `UNIQUE` (default: exactly one row may match — the right choice almost always),
     `FIRST` (row order decides; avoid, rule B01), `COLLECT` (all matching rows, optionally
     aggregated), `PRIORITY`, `ANY`, `RULE ORDER`, `OUTPUT ORDER`.
4. **Root**: `namespace` (an absolute URI identifying the model) is required; give `id` and `name`.
5. **Write ids** in ASCII: letters, digits, `_`, `-`, `.`, not starting with a digit.

Make the rules **complete** (every combination of inputs is covered) and, under `UNIQUE`,
**disjoint** (no two rows match the same input) — the scenario analysis below checks both (SC04,
SC05) for tests written in the supported subset: numbers, dates, strings, intervals, comma lists
and `-`. A column using anything else (a FEEL function such as `not(…)`) makes that rule
unanalysable rather than guessed at.

## Worked example

Rule text: *"Claims under 1 000 are paid automatically. Between 1 000 and 10 000, a clerk approves
premium customers' claims and a manager everyone else's. From 10 000 a manager always approves."*

```json
{
  "id": "Definitions_claimApproval",
  "name": "Claim approval",
  "namespace": "http://example.com/dmn/claim-approval",
  "nodes": [
    { "id": "in_amount", "type": "inputData", "name": "Claim amount", "typeRef": "number" },
    { "id": "in_segment", "type": "inputData", "name": "Customer segment", "typeRef": "string" },
    {
      "id": "dec_approvalLevel",
      "type": "decision",
      "name": "Approval level",
      "question": "Who has to approve this claim?",
      "typeRef": "string",
      "usingTask": "task_evaluateApproval",
      "decisionTable": {
        "hitPolicy": "UNIQUE",
        "inputs": [
          { "label": "Claim amount", "expression": "claimAmount", "typeRef": "number" },
          { "label": "Customer segment", "expression": "customerSegment", "typeRef": "string", "allowedValues": "\"premium\",\"standard\"" }
        ],
        "outputs": [
          { "name": "level", "typeRef": "string", "allowedValues": "\"auto\",\"clerk\",\"manager\"" }
        ],
        "rules": [
          { "when": ["< 1000", "-"], "then": ["\"auto\""] },
          { "when": ["[1000..10000)", "\"premium\""], "then": ["\"clerk\""] },
          { "when": ["[1000..10000)", "\"standard\""], "then": ["\"manager\""] },
          { "when": [">= 10000", "-"], "then": ["\"manager\""] }
        ]
      }
    }
  ],
  "requirements": [
    { "type": "information", "source": "in_amount", "target": "dec_approvalLevel" },
    { "type": "information", "source": "in_segment", "target": "dec_approvalLevel" }
  ]
}
```

`usingTask` is DMN's own, standardised back-link to the BPMN task that calls the decision.

## Confirm the table first

The order is fixed: **show → confirm → generate → report.**

1. **Show** the decision table to the user as Markdown in the chat, before you write any file, in
   exactly the form the pipeline writes into `--doc` (so the user sees what they will get). For
   the worked example:

   ```markdown
   ### Approval level

   Hit policy: **UNIQUE (U)** – exactly one rule can match

   | U | When: Claim amount *(number)* | And: Customer segment *("premium","standard")* | Then: level *("auto","clerk","manager")* |
   |--:|:--|:--|:--|
   | 1 | < 1000 | – | "auto" |
   | 2 | [1000..10000) | "premium" | "clerk" |
   | 3 | [1000..10000) | "standard" | "manager" |
   | 4 | >= 10000 | – | "manager" |
   ```

   The rules of the form: the first column carries the hit-policy letter (`U`, `F`, `P`, `A`,
   `R`, `O`, `C`, or `C+`/`C#`/`C<`/`C>` for an aggregated COLLECT) and numbers the rules; inputs
   are headed `When:`/`And:`, outputs `Then:`/`And:`, each with its allowed values (else its type)
   in italics; `–` means "any"; an `Annotation` column only if a rule has one. Say in one line what
   the hit policy means, and that order matters under `FIRST` and `RULE ORDER`.
2. **Confirm.** Ask whether the rules are right and complete. Change the Decision-Core until the
   user agrees — a table is cheap to fix in chat and expensive to fix in a file someone already
   imported.
3. **Generate** the files (below), with `--strict`.
4. **Report** what the rules and the scenario analysis found (D/B rules, SC01–SC06), even when
   nothing blocked — a gap (SC04) or an overlap (SC05) is a question for the user, not a detail.

## Running the DMN pipeline

Run from `scripts/`:

```bash
node dmn/pipeline.js approval.json approval --strict                   # → approval.dmn + approval.svg
node dmn/pipeline.js approval.json approval --strict --doc             # plus .md, .tables.svg, .tables.html
node dmn/pipeline.js approval.json approval --strict --best-practice   # plus readability rules
cat approval.json | node dmn/pipeline.js - approval --strict           # Decision-Core from stdin
```

| File | Content |
|------|---------|
| `approval.dmn` | DMN 1.3 XML with its diagram (DMNDI) |
| `approval.svg` | the DRD as an image — the same coordinates as the DMNDI, drawn as dmn.io draws them |
| `approval.md` (`--doc`) | per decision: heading, question, inputs and outputs, the decision table |
| `approval.tables.svg` (`--doc`) | every decision table, stacked, drawn like dmn.io's table view; a decision decided by a literal expression as its name, type and FEEL text |
| `approval.tables.html` (`--doc`) | the same tables as HTML with inline styles — pastes into Confluence or a wiki |

The words in the Markdown, SVG and HTML tables (When/And/Then, the hit-policy meanings, "any") are
English by default; `config.json → dmn.labels.locale: "de"` switches them to German.

The pre-delivery gate from `SKILL.md` applies unchanged: run with `--strict` and resolve every
warning before you deliver. The schema gate rejects malformed input with a field path. The rules are
D01–D11 (soundness and semantics, always on) and, with `--best-practice`, B01–B06 (table size,
`FIRST` hit policy, missing question or type, DRD depth); each is explained in
`references/fachliches-regelwerk.md` ("DMN Rules").

## Viewing the result

`approval.svg` is the DRD as an image; `--doc` adds the decision tables as image
(`.tables.svg`), as a page (`.tables.html`) and as Markdown (`.md`). The `.dmn` file itself opens
in the dmn-js demo (<https://demo.bpmn.io/dmn>) or in Camunda Modeler, which show the DRD and let
the user edit the decision table.

## Linking a BPMN task to the decision

In the process, the task that evaluates the table is a `businessRuleTask` whose `decisionRef` is the
decision's `id`. Put `decisionRef` on nothing else — rule M11 warns, because on any other element it
is inert. Because BPMN draws no link to a DMN file, **add a text annotation naming the decision**, so
the link is visible in the diagram:

```json
{
  "id": "Process_claimApproval",
  "name": "Claim approval",
  "nodes": [
    { "id": "start", "type": "startEvent", "name": "Claim received" },
    { "id": "task_evaluateApproval", "type": "businessRuleTask", "name": "Evaluate approval level", "decisionRef": "dec_approvalLevel" },
    { "id": "ann_decision", "type": "textAnnotation", "name": "DMN decision: Approval level (dec_approvalLevel)" },
    { "id": "gw_level", "type": "exclusiveGateway", "name": "Approval level?" },
    { "id": "task_pay", "type": "serviceTask", "name": "Release payment" },
    { "id": "task_review", "type": "userTask", "name": "Review claim" },
    { "id": "gw_join", "type": "exclusiveGateway", "name": "", "has_join": true },
    { "id": "end", "type": "endEvent", "name": "Claim settled" }
  ],
  "edges": [
    { "id": "f1", "source": "start", "target": "task_evaluateApproval", "isHappyPath": true },
    { "id": "f2", "source": "task_evaluateApproval", "target": "gw_level", "isHappyPath": true },
    { "id": "f3", "source": "gw_level", "target": "task_pay", "label": "auto", "isHappyPath": true, "isDefault": true },
    { "id": "f4", "source": "gw_level", "target": "task_review", "label": "clerk or manager" },
    { "id": "f5", "source": "task_review", "target": "gw_join" },
    { "id": "f6", "source": "task_pay", "target": "gw_join", "isHappyPath": true },
    { "id": "f7", "source": "gw_join", "target": "end", "isHappyPath": true }
  ],
  "associations": [
    { "id": "assoc_decision", "source": "ann_decision", "target": "task_evaluateApproval" }
  ]
}
```

**Known limitation — no engine binding.** `decisionRef` is written into `extensionElements` under
the generator's own namespace (`bg:decisionRef`), because BPMN 2.0 defines no attribute for this
link. Camunda's own attributes (`camunda:decisionRef`, `camunda:resultVariable`,
`camunda:mapDecisionResult` in Camunda 7; `zeebe:calledDecision` in Camunda 8) are **not** written.
A model meant to execute on Camunda needs the decision reference set once more in Camunda Modeler's
properties panel. Say so when the user mentions an engine.

## The table in the task's documentation

BPMN tools show nothing of the DMN file, but bpmn.io and Camunda Modeler show a task's
documentation. Pass the decision models to the BPMN pipeline and every `businessRuleTask` with a
`decisionRef` gets its decision table in its documentation:

```bash
node bpmn/pipeline.js process.json claim --strict --decisions approval.json          # or approval.dmn
node bpmn/pipeline.js process.json claim --strict --decisions a.json,b.dmn --doc     # several models
```

The section is plain text between two marker lines, after whatever documentation the task already
had:

```text
=== BEGIN generated: DMN decision (bpmn-generator) — replaced on every run ===
Decision: Approval level (dec_approvalLevel) — generated from Definitions_claimApproval
Hit policy: UNIQUE (U) – exactly one rule can match
Rule 1: WHEN Claim amount < 1000 THEN level = "auto"
Rule 2: WHEN Claim amount [1000..10000) AND Customer segment "premium" THEN level = "clerk"
Rule 3: WHEN Claim amount [1000..10000) AND Customer segment "standard" THEN level = "manager"
Rule 4: WHEN Claim amount >= 10000 THEN level = "manager"
=== END generated: DMN decision ===
```

One sentence per rule, not a table: the Camunda properties panel shows documentation in a
proportional font, where aligned columns fall apart. An input that matches anything is left out of
its sentence. A decision decided by a literal expression gets
`Literal expression (type: number): <FEEL text>` instead of rules.
Every run **replaces** the section, so importing the `.bpmn` and generating it again never
duplicates it; do not edit inside the markers — write your own notes above them. A `decisionRef`
none of the given models defines reads `Calls decision: <id> (table not supplied)`; one that two
models define says so. Without `--decisions` the documentation is left as it is. The SVG shows the
documentation as the task's tooltip, and `--doc` prints the table after the element list.

## Checking the bridge: scenario analysis

Optional, and worth it whenever a process and its decision tables are delivered together. The
scenario pipeline enumerates every path through the process, resolves every `decisionRef` against
the given decision models, and analyses each referenced table:

```bash
node scenarios/pipeline.js process.json claim --decisions approval.json --strict   # → claim.scenarios.json + .md
node scenarios/pipeline.js process.json claim --decisions approval.dmn,other.dmn   # .dmn files work too
```

`--decisions` takes a comma-separated list of Decision-Core JSON files or `.dmn` files (recognised
by content). `--strict` exits non-zero on any finding, on an incomplete enumeration, and on a lossy
DMN import — and every `.dmn` file imports as lossy (see "Importing a DMN file"), even one this
generator wrote. So pass the **Decision-Core JSON** when you use `--strict`, and drop `--strict` for
a `.dmn` file from elsewhere.

| Rule | Reports |
|------|---------|
| SC01 | a branch of an exclusive gateway that no scenario takes |
| SC02 | a `decisionRef` that resolves to no decision in the given files — usually a typo in the id |
| SC03 | a `decisionRef` that resolves to decisions in more than one file |
| SC04 | a gap: an input combination no rule of the referenced table covers |
| SC05 | overlapping rules in a `UNIQUE` table |
| SC06 | improper completion: two tokens reach a pool's end in one scenario |

These rules are not switched by rule profiles. The Markdown output groups the scenarios by gateway
decision and opens with the happy path — a good basis for test cases.

## Importing a DMN file

```bash
node dmn/import.js existing.dmn decision.json          # DMN 1.3 XML → Decision-Core + loss report on stderr
cat existing.dmn | node dmn/import.js - decision.json --strict   # abort, writing nothing, when the import is lossy
```

The report lists what Decision-Core cannot hold (IM01–IM09). The diagram layout is never imported —
it is recomputed on the next emit — so **every file reports IM06, including files this generator
wrote**, which also report IM05 for the variable ids the writer generates. `--strict` therefore
rejects the generator's own output; use it on foreign files, and otherwise read the report and tell
the user what was dropped.
