---
name: bpmn-generator
description: >
  Enterprise BPMN 2.0 diagram generator — converts natural language process descriptions into
  OMG-compliant BPMN 2.0 XML files and SVG previews via a 4-phase pipeline:
  Intent Extraction (LLM → JSON Logic-Core) → Validation (deadlock detection, structural soundness) →
  ElkJS Auto-Layout → BPMN XML + SVG output.
  Supports: multi-pool collaborations, message flows, boundary events (timer/error/signal),
  loop/multi-instance markers, data objects, all gateway types with correct gatewayDirection,
  and all BPMN 2.0 task types.
  Use this skill whenever the user wants to create, generate, or model a BPMN diagram, process flow,
  or workflow — even if they say "draw a process", "model this workflow", "make a BPMN for...",
  "create a Prozessmodell", "visualize this process", or describe a business process in natural language.
  Also use for editing or extending existing BPMN Logic-Core JSON.
---

# BPMN Generator Skill v2.0 — Enterprise Edition

Converts natural language process descriptions into **OMG BPMN 2.0.2 compliant** XML files and
SVG previews via a 4-phase pipeline. All visual rendering follows the bpmn-js reference implementation.

## Pipeline Overview

```
User Text
   ↓  [Phase 1] Intent Extraction  (Claude LLM)
JSON Logic-Core
   ↓  [Phase 2] Validation          (rules + deadlock detection + structural soundness)
Validated JSON
   ↓  [Phase 3] Auto-Layout         (ElkJS Sugiyama layered algorithm)
JSON + Coordinates (edge endpoints clipped to shape boundaries)
   ↓  [Phase 4] Serialization       (pipeline.js)
BPMN 2.0 XML + SVG
```

The LLM **never** handles coordinates. Layout is 100% algorithmic.

---

## Reference Files

Read these when needed:

- `references/logic-core-schema.md` — Full JSON schema, type table, all examples → **read before extracting JSON**
- `references/prompt-template.md` — LLM prompt templates for extraction, review, amendment → **read before prompting**

---

## Supported BPMN 2.0 Elements

### Events
| Type | Markers | Notes |
|------|---------|-------|
| Start Event | None, Message, Timer, Signal, Conditional, Error, Escalation, Compensation | Thin circle (strokeWidth 2) |
| End Event | None, Message, Signal, Error, Escalation, Compensation, Cancel, Terminate, Multiple | Thick circle (strokeWidth 4) |
| Intermediate Catch | Message, Timer, Signal, Conditional, Link, Error, Escalation, Compensation, Cancel | Double circle |
| Intermediate Throw | Message, Signal, Link, Escalation, Compensation | Double circle, filled marker |
| Boundary Event | Timer, Error, Message, Signal, Escalation, Compensation, Cancel, Conditional | Attached to activity, interrupting/non-interrupting |

### Activities
| Type | Icon | Notes |
|------|------|-------|
| Task | — | Generic activity |
| User Task | 👤 | Human work item |
| Service Task | ⚙⚙ | System/API call |
| Script Task | 📄 | Script execution |
| Send Task | ✉ (filled) | Outgoing message |
| Receive Task | ✉ (outlined) | Incoming message |
| Manual Task | ✋ | Physical work |
| Business Rule Task | 📊 | DMN / rule engine |
| Sub-Process | [+] | Collapsed, with expand marker |
| Call Activity | thick border | Reusable called process |

### Activity Markers (bottom-center)
| Marker | Property | Visual |
|--------|----------|--------|
| Standard Loop | `loopType: "standard"` | ↻ circular arrow |
| MI Parallel | `multiInstance: "parallel"` | ⫴ three vertical bars |
| MI Sequential | `multiInstance: "sequential"` | ≡ three horizontal bars |
| Ad-Hoc | `isAdHoc: true` | ~ tilde |
| Compensation | `isCompensation: true` | ◁◁ double rewind |

### Gateways
| Type | Marker | Direction |
|------|--------|-----------|
| Exclusive (XOR) | ✕ | Diverging/Converging/Mixed |
| Parallel (AND) | + | Diverging/Converging/Mixed |
| Inclusive (OR) | ○ | Diverging/Converging/Mixed |
| Event-Based | ○+⬠ | Diverging |
| Complex | ✱ | Mixed |

### Data & Artifacts
| Type | Visual |
|------|--------|
| Data Object | Rectangle with folded corner |
| Data Store | Cylinder |
| Text Annotation | Open bracket [ with text |
| Group | Dashed rounded rectangle |

### Connections
| Type | Style | Source marker | Target marker |
|------|-------|---------------|---------------|
| Sequence Flow | Solid | — | Filled triangle |
| Default Flow | Solid | Diagonal slash | Filled triangle |
| Conditional Flow | Solid | Open diamond | Filled triangle |
| Message Flow | Dashed (10,12) | Open circle | Open triangle |
| Association | Dotted (0.5,5) | — | Open chevron (if directed) |

---

## When to use which mode

| Context | Mode |
|---------|------|
| User gives a process description in text | Full pipeline (all 4 phases) |
| User uploads/provides existing Logic-Core JSON | Skip Phase 1, start at Phase 2 |
| User wants to add/change something in existing diagram | Amendment flow |
| User describes multiple organizations interacting | Multi-pool mode |
| User is in Claude Code with Node.js | Use `scripts/pipeline.js` |
| User is in Claude.ai (no script execution) | Inline mode: generate XML + SVG as artifacts |

---

## Phase 1 — Intent Extraction

**Read `references/logic-core-schema.md` and `references/prompt-template.md` first.**

Use the **Master Extraction Prompt** template. Key rules to enforce:

### Naming Conventions (BA-Quality)
- **Tasks**: `Verb + Substantiv` — "Antrag prüfen" ✓ / "Prüfung" ✗
- **XOR Gateways**: Question form — "Antrag gültig?" ✓ / "Entscheidung" ✗
- **AND/OR Gateways**: Empty or brief label — "" ✓ (these are sync points)
- **Gateway edges**: Always labeled — "Ja"/"Nein", "genehmigt"/"abgelehnt"
- **Lanes**: Functional roles — "Sachbearbeiter" ✓ / "Max Müller" ✗
- **Events**: Noun phrase — "Antrag eingegangen" ✓

### Granularity Rules
- Max 7–10 nodes per level. Use `subProcess` for groups with >3 logical steps.
- Never create "God-Tasks" (a single task hiding a whole sub-process).
- Prefer more granular over too abstract.

### Happy Path
- Mark the main success flow edges with `"isHappyPath": true`
- ElkJS will lay these out on the horizontal axis (left→right)
- Exception/error paths branch vertically

### Gateway Direction (OMG spec §10.5.1)
- `has_join: true` → pipeline sets `gatewayDirection="Converging"` in XML
- Split gateways get `gatewayDirection="Diverging"` automatically
- Mixed (split+join) gateways get `gatewayDirection="Mixed"`

### Event Markers
- Set `marker` explicitly when the event type is clear from context
- If not set, pipeline infers from event name (e.g. "Frist abgelaufen" → timer)

---

## Phase 2 — Validation

The pipeline validates automatically. These checks run:

**Errors (block pipeline):**
- [ ] At least one `startEvent` exists per process
- [ ] At least one `endEvent` exists per process
- [ ] All `edge.source` and `edge.target` reference existing node IDs
- [ ] No XOR-split path merging at an AND-join (**deadlock detection**)
- [ ] Message flows reference valid node/pool IDs

**Warnings (report but continue):**
- [ ] XOR gateways not named as questions
- [ ] Tasks not following Verb+Noun pattern
- [ ] Nodes with no edges (isolated)
- [ ] XOR gateway outgoing edges without labels
- [ ] Nodes with no outgoing flow (may not terminate)

Use the **Reviewer Agent Prompt** from `references/prompt-template.md` for additional automated review.

---

## Phase 3 + 4 — Script Execution (Claude Code)

### Setup (first time only)
```bash
cd scripts/
npm install   # installs: elkjs (only dependency)
```

### Run pipeline
```bash
# From JSON file:
node pipeline.js my-process.json my-process

# From stdin (inline JSON):
echo '{ ... }' | node pipeline.js - output

# Outputs:
#   output.bpmn  — BPMN 2.0 XML with full DI coordinates
#   output.svg   — SVG preview (open in browser)
```

### OMG Compliance Guarantees
The generated BPMN 2.0 XML ensures:
- Single `<laneSet>` per process (spec §10.5)
- Correct `gatewayDirection` attribute (Diverging/Converging/Mixed)
- `conditionExpression` as child element, not attribute (spec §10.3.1)
- `<incoming>` and `<outgoing>` references on all flow nodes
- Event definition child elements (messageEventDefinition, timerEventDefinition, etc.)
- Loop/multi-instance characteristics as child elements
- Boundary events with `attachedToRef` and `cancelActivity`
- Valid `isHorizontal="true"` on pool/lane shapes
- Edge endpoints clipped to actual shape boundaries

---

## Inline Mode (Claude.ai — no script execution)

When Claude Code is not available, generate outputs directly in the conversation:

1. Extract the Logic-Core JSON (show to user for confirmation)
2. Apply validation rules mentally (check for deadlocks, naming, completeness)
3. For the SVG: render as an **HTML artifact** using inline SVG
   - Use the exact OMG dimensions: 36px events, 100×80 tasks, 50×50 gateways
   - Use ElkJS-compatible manual positioning: elements spaced 60px between layers, 40px between nodes
   - Apply stroke widths: 2 (start), 4 (end), 1.5 (intermediate), 2 (task), 5 (call activity)
4. For the BPMN XML: generate as a **code artifact** following all OMG compliance rules

Show the Logic-Core JSON to the user before generating final files.

**Note:** Inline mode coordinates are manually estimated. For production-quality layout, use Claude Code with the pipeline script.

---

## Amendment Flow (editing existing diagrams)

When user wants to modify an existing diagram:

1. Load the existing Logic-Core JSON
2. Use the **Amendment Prompt** from `references/prompt-template.md`
3. Apply only the atomic changes requested
4. Re-validate (Phase 2)
5. Re-run pipeline (Phase 3+4)

**Never** regenerate the entire Logic-Core from scratch for small edits — preserve all existing IDs.

---

## Two-Agent Pattern (production quality)

For enterprise output, run Modeler + Reviewer in loop:

```
Modeler (Claude):  Text → Logic-Core JSON (draft)
     ↓
Reviewer (Claude): Logic-Core → Issues JSON
     ↓
  No issues? → Run pipeline
  Issues?    → Modeler applies fixes → repeat (max 3 iterations)
```

Use prompts from `references/prompt-template.md` for both roles.

---

## Output Artifacts

| File | Purpose | Opens in |
|------|---------|----------|
| `*.bpmn` | BPMN 2.0 XML with DI | Camunda Modeler, bpmn.io, ADONIS, Signavio |
| `*.svg` | Vector preview | Browser, Confluence, Word/PowerPoint |
| `*_logic.json` | Logic-Core (save for amendments) | Text editor, version control |

---

## Error Handling

| Error | Cause | Fix |
|-------|-------|-----|
| `Missing startEvent` | No start node in JSON | Add startEvent node |
| `Missing endEvent` | No end node in JSON | Add endEvent node |
| `Unknown source/target` | Edge references non-existent node | Fix ID typo |
| `Deadlock: XOR-split feeds AND-join` | Structural error | Change AND-join to XOR-join or restructure |
| `ELK layout failed` | Disconnected graph | Fix isolated nodes |
| `npm install fails` | No network or Node.js missing | Ensure Node.js ≥18 |

---

## Quick-Reference: Node Types

| Type | Icon | Use for |
|------|------|---------|
| `startEvent` | ○ | Process trigger |
| `endEvent` | ⬤ | Process end |
| `intermediateCatchEvent` | ◎ | Wait for event mid-flow |
| `intermediateThrowEvent` | ◎● | Send event mid-flow |
| `boundaryEvent` | ◎→ | Timer/error on task |
| `userTask` | 👤 | Human work item |
| `serviceTask` | ⚙ | System/API call |
| `scriptTask` | 📄 | Script execution |
| `sendTask` | ✉● | Send message |
| `receiveTask` | ✉○ | Receive message |
| `businessRuleTask` | 📊 | DMN / rules |
| `manualTask` | ✋ | Physical work |
| `subProcess` | [+] | Collapsed complexity |
| `callActivity` | ▬▬ | Reusable process |
| `exclusiveGateway` | ◇✕ | One path (XOR) |
| `parallelGateway` | ◇+ | All paths (AND) |
| `inclusiveGateway` | ◇○ | One or more (OR) |
| `eventBasedGateway` | ◇◎ | First event wins |
| `complexGateway` | ◇✱ | Custom logic |
| `dataObjectReference` | 📋 | Document/data |
| `dataStoreReference` | 🗄 | Database |
| `textAnnotation` | [ | Explanatory note |

---

## Round-Tripping (BPMN Import)

Import existing BPMN 2.0 XML files to extract a Logic-Core JSON for editing.

### Claude Code
```bash
cd scripts/
node import.js existing-diagram.bpmn extracted.json
```

### Workflow
```
Existing .bpmn file
   ↓  [import.js] Parse XML → extract nodes, edges, lanes, message flows
Logic-Core JSON
   ↓  [User/LLM edits]  Amendment flow
Modified Logic-Core
   ↓  [pipeline.js]  Layout + render
New .bpmn + .svg
```

**Supported on import:** Processes, collaborations, lanes, message flows,
collapsed pools, gateways (with direction), all task/event types,
boundary events, loop/MI markers, data objects, associations,
process documentation, default flows.

---

## Inline Mode (Claude.ai — with ElkJS)

When Claude Code is not available, use the **inline template** from
`references/inline-template.md` to create a self-contained HTML artifact:

1. Extract the Logic-Core JSON
2. Show to user for confirmation
3. Create an HTML artifact with the template
4. Replace `__LOGIC_CORE_JSON__` with the actual JSON

The template runs ElkJS from CDN in the browser — **no manual coordinate estimation**.
It produces orthogonal layouts with proper BPMN shapes.

**Note:** The inline renderer is simplified (no task type icons, no event markers).
For full rendering fidelity, use Claude Code with pipeline.js.

---

## Collapsed Pools (Black-Box Participants)

**Best Practice (Bruce Silver Method & Style):**
A diagram should have **one expanded pool** (your process in scope) and
collapsed pools for external participants (customers, suppliers, authorities).

### Schema
```json
{
  "collapsedPools": [
    { "id": "Pool_Kunde", "name": "Versicherungsnehmer" },
    { "id": "Pool_Gutachter", "name": "Externer Gutachter" }
  ]
}
```

### Rendering
- SVG: Thin horizontal band (600×60) with centered label
- XML: `<participant>` without `processRef` (OMG spec §9.3)
- Message flows target the collapsed pool ID directly

---

## Associations (Data Objects + Annotations)

Connect Data Objects, Data Stores, and Text Annotations to flow nodes:

```json
{
  "associations": [
    { "id": "assoc1", "source": "task_erfassen", "target": "do_akte", "directed": true },
    { "id": "assoc2", "source": "ann_hinweis", "target": "task_pruefen" }
  ]
}
```

- SVG: Dotted line (strokeDasharray `0.5,5`)
- XML: `<association>` element with `associationDirection`

---

## OMG Compliance Checklist (v3)

| Feature | Status | OMG Reference |
|---------|--------|---------------|
| Single `<laneSet>` per process | ✅ | §10.5 |
| `gatewayDirection` Diverging/Converging/Mixed | ✅ | §10.5.1 |
| `default` attribute on XOR gateways | ✅ | §10.5.1 |
| `conditionExpression` as child element | ✅ | §10.3.1 |
| `<incoming>`/`<outgoing>` on flow nodes | ✅ | §10.2.1 |
| Top-level `<message>`/`<signal>`/`<error>` definitions | ✅ | §8.4, §9 |
| Event definitions with `messageRef`/`errorRef` | ✅ | §10.4 |
| `<documentation>` on process and nodes | ✅ | §8.3.1 |
| `<association>` elements | ✅ | §7.2 |
| Collapsed pool (`<participant>` without `processRef`) | ✅ | §9.3 |
| DI Label Bounds with `<dc:Bounds>` | ✅ | §12.1 |
| Loop/MI characteristics as child elements | ✅ | §10.2.2 |
| Boundary events with `attachedToRef` | ✅ | §10.4.4 |
| Orthogonal edge routing | ✅ | Visual convention |
| Edge endpoint clipping to shape boundaries | ✅ | Visual convention |
| Pool width equalization | ✅ | Visual convention |
| Deadlock detection (XOR→AND) | ✅ | Structural soundness |
| Round-tripping (BPMN→JSON→BPMN) | ✅ | Interoperability |
