---
typ: anforderung
id: beratender-modus
titel: Advisory mode — methodically guided process elicitation without prior process knowledge
status: draft
erstellt: 2026-07-28
aktualisiert: 2026-07-28
erstellt_von: daniel.stiegler
quelle: Working session 2026-07-28 (dialogue following the layout hardening, PR #29)
tore_ebene: goal   # slice C of the "three modes" initiative; altitude deliberately higher than A
prioritaet: offen  # to be set in the business_intent pillar, confirmed at GATE 1
reifegrad: raw
regulatory_refs: []
beziehungen:
  - {typ: geschwister_scheibe, ziel: docs/anforderungen/2026-07-28_import-modus-geometrie-uebernehmen.md}
---

# Advisory mode — methodically guided process elicitation without prior process knowledge

> **Maturity `raw`.** So far this record only holds the origin, one decision already
> made, and the open questions. The pillar pass (Phase 2) has not happened yet.

## Review view

> Derived view — **not** a new source of truth, **not** a seal of approval. **Open
> items first.**

| Review goal | Status | → Evidence |
|---|---|---|
| **Restraint** | **3 open questions** (input form · depth of subject-matter guidance · boundary with optimize mode) · priority not set | ↓ Open items |
| **Coverage** | 0 of 7 pillars · negation axis not applied | ↓ Pillars |
| **Substantiation** | 2 Verified (existing building blocks), 0 Hypotheses | ↓ Starting point |
| **Test penetration** | 0 scenarios | — |
| **Integrity** | GATE 1 pending · GATE 2 pending · Change log created | ↓ Change log |

## Origin

- **Source:** Working session 2026-07-28. No external document — synthesized from the
  conversation. Sibling slice to the import record, same verbatim source.
- **Verbatim original (audit anchor, NEVER overwritten):**
  > (verbatim, German — audit anchor, never rewritten)
  >
  > „eigentlich brauchen wir drei modi. […] und ein modus wo man sagt ich habe keine
  > ahnung von prozessen aber ich hoffe ich weiß wie es ungefähr läuft und beraten wird
  > methodisch und fachlich"
  >
  > „oder darauf hingewiesen, dass man fachlich recherchieren soll."

- **Canonical formulation:** A mode that guides someone with no process-modelling
  knowledge through describing their own process — methodically (which dimensions
  belong) and substantively (what's missing, what's inconsistent) — while explicitly
  naming what the tool **cannot** know and the human has to research.

- **Rationale (draft — GATE 1 pending):**
  Model quality today depends on the person entering the process already knowing what
  belongs in a process description. Someone who doesn't know that delivers a chain of
  steps with no roles, no exceptions, no deadlines — and gets exactly that back as a
  diagram. The tool is then formally correct and substantively worthless. "Advisory"
  here means: name the gap before it turns into a clean picture of nothing.

## Decided

**Audience: self-sufficient** (dialogue 2026-07-28). The subject-matter expert
describes their own work; nobody is sitting next to them. Consequence: the mode needs
a substantiated elicitation methodology with guardrails — not just better prompting.
The assistive variant ("the tool feeds the consultant") was explicitly **not** chosen.

## Starting point — what already exists

| Building block | Status | Source |
|---|---|---|
| `agents/chat.js` runs a multi-turn discovery conversation and decides `readyToGenerate` along with a `suggestedSummary`. It **asks**, but it does not advise and has no concept of a research need. | Verified | `scripts/agents/chat.js` |
| Advice on the process already exists structurally: O01–O04 (Reijers 2005, BABOK §10.34 Lean) plus the M/P layers. It advises **purely from the graph structure** — with no effort, volume or probability data — and states that limitation only in a module comment. | Verified | `scripts/optimize.js` (module header), `scripts/rules.js` |

## Methodology — carried over, not built from scratch

Insight from the dialogue on 2026-07-28: the elicitation methodology does not need to
be invented. `anforderungs-denkrahmen` is the template; the mapping is structurally
identical.

| Denkrahmen (requirement) | Counterpart (process) |
|---|---|
| 7 pillars, each with a finding **or** a justified opt-out | Fixed elicitation dimensions: trigger · roles · outcome · exceptions · deadlines · systems · decisions — never silently omitted |
| Negation axis §6a | "What prevents, negates, interrupts this step?" — rejection, abort, missed deadline, partial fulfilment. The path a subject-matter expert never names on their own |
| Necessity §6b | No step in the model that the human has not confirmed — hallucination protection at the model level |
| `Verified` / `Hypothesis` / `Not found` | **derivable** (from the structure) / **askable** (the human knows it) / **needs research** ("I cannot know this — clarify it with the process owner") |
| Review view, open items first, no traffic lights | Feedback to the user that shows what's unresolved first — no green checkmark on half a process |

The user's wish to be "pointed to a need for subject-matter research" is therefore
**not an extra feature but the third status class** — surfaced to the end user
instead of the developer.

## Pillars

_(Phase 2 — not yet addressed.)_

## Open items

- **Input form.** How does the description come in? Free text in one go · a dialogue
  like `agents/chat.js` · a guided questionnaire along the elicitation dimensions. This
  choice determines whether the methodology drives the flow or only evaluates it.
  **Trigger:** before Phase 2. **Owner:** daniel.stiegler.
- **Depth of subject-matter guidance.** "Advise on substance" can mean: structural
  only (what's formally missing) or also domain-specific (what's typically part of an
  approval procedure). The latter needs domain knowledge and raises the question of
  where it comes from with evidence — the optimization layer today explicitly does
  **not** advise on domain specifics. **Trigger:** before Phase 2. **Owner:**
  daniel.stiegler.
- **Boundary with optimize mode.** `mode: optimize` already advises on the process
  (O01–O04). Is advisory mode its precursor (elicitation), its counterpart
  (evaluation), or a bracket around both? Two axes must not collapse into one
  parameter — the same trap as `document|optimize` versus the three modes.
  **Trigger:** before Phase 2. **Owner:** daniel.stiegler.
- Priority (MoSCoW) not set.
- Rationale not yet approved (GATE 1).

## Acceptance criteria

_(Phase 4 — not yet addressed.)_

## Change log

- 2026-07-28 · MATURITY · Record · — → raw · Working session 2026-07-28
- 2026-07-28 · ADDITION · Audience · Decided self-sufficient; assistive variant rejected · Dialogue
- 2026-07-28 · ADDITION · Methodology · Carried over from `anforderungs-denkrahmen` instead of a new build · Dialogue
