# Logic-Core JSON Schema Reference v2.0

Load this before extracting or editing any Logic-Core: it is the field-by-field contract the
schema gate (`references/input-schema.json`) enforces.

## Contents

- [Overview](#overview)
- [Schema Modes](#schema-modes)
- [Format 2.0 (catalogue and lane views)](#format-20-catalogue-and-lane-views)
- [Translating 1.x models](#translating-1x-models)
- [Top-Level Fields](#top-level-fields)
- [NodeObject](#nodeobject)
- [EdgeObject](#edgeobject)
- [LaneObject](#laneobject)
- [MessageFlowObject (cross-pool communication)](#messageflowobject-cross-pool-communication)
- [Minimal Example (no lanes)](#minimal-example-no-lanes)
- [Example with Lanes](#example-with-lanes)
- [Example with Parallel Gateway (split + join)](#example-with-parallel-gateway-split--join)
- [Example: Multi-Pool with Message Flows](#example-multi-pool-with-message-flows)
- [Example: Boundary Timer Event](#example-boundary-timer-event)
- [Views (outside the model)](#views-outside-the-model)
- [Common Anti-Patterns (Reviewer checklist)](#common-anti-patterns-reviewer-checklist)
- [CollapsedPoolObject (Black-Box Participant)](#collapsedpoolobject-black-box-participant)
- [AssociationObject](#associationobject)
- [Process Documentation](#process-documentation)
- [Method & Style Rules (Bruce Silver)](#method--style-rules-bruce-silver)
- [Example: Method & Style Collaboration (1 expanded + 2 collapsed)](#example-method--style-collaboration-1-expanded--2-collapsed)

## Overview

The Logic-Core is the intermediate representation between LLM output and BPMN 2.0 XML.
It contains **only topology** – no coordinates, no layout, no visual information.
Layout is computed exclusively by ElkJS in the pipeline.

---

## Schema Modes

The Logic-Core supports two modes:

### Single-Process Mode (simple)
```json
{
  "id": "Process_1",
  "name": "Process name",
  "nodes": [ ...NodeObject ],
  "edges": [ ...EdgeObject ],
  "lanes": [ ...LaneObject ]
}
```

### Multi-Pool / Collaboration Mode (enterprise)
```json
{
  "pools": [
    {
      "id": "Process_Customer",
      "name": "Customer",
      "nodes": [ ...NodeObject ],
      "edges": [ ...EdgeObject ],
      "lanes": [ ...LaneObject ]
    },
    {
      "id": "Process_Insurer",
      "name": "Insurance Company",
      "nodes": [ ...NodeObject ],
      "edges": [ ...EdgeObject ],
      "lanes": [ ...LaneObject ]
    }
  ],
  "messageFlows": [ ...MessageFlowObject ]
}
```

---

## Top-Level Fields

| Field          | Required | Description                                       |
|----------------|----------|---------------------------------------------------|
| `id`           | Yes*     | BPMN process ID (* single-process mode)           |
| `name`         | No       | Human-readable process name (pool header label)    |
| `nodes`        | Yes*     | Array of flow nodes (* single-process mode)        |
| `edges`        | Yes*     | Array of sequence flows (* single-process mode)    |
| `lanes`        | No       | Array of lanes/roles                               |
| `pools`        | No       | Array of process objects (multi-pool mode)          |
| `messageFlows` | No       | Array of cross-pool message flows                  |
| `language`     | No       | Language of the labels, a language tag (`"de"`, `"en-GB"`) |

**`language` (1.x, since 1.3).** The natural language of the model's labels, as a language tag with
a lowercase primary subtag: it matches `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$` (`"de"`, `"en"`,
`"en-GB"`). The generated XML carries it as `bg:language="<tag>"` on `bpmn:definitions` (with
`xmlns:bg`), and both importers read it back as the top-level `language` of the result; it is no
origin marker, so it raises no import notice. Drill-down child diagrams carry the language of their
parent. A model without the field, or with a value that is no such tag, gives the output it gave
before the field existed: nothing is written. Node keys that start with `_` (`_marker` among them)
are reserved for the pipeline; on input they are ignored or removed. The language-aware marker is
resolved by `runPipeline` on its own copy of the model: `generateBpmnXml` and `generateSvg` called
directly on a model with `language` write the legacy markers.

---

## NodeObject

```json
{
  "id": "task_antrag_pruefen",
  "type": "userTask",
  "name": "Antrag prüfen",
  "lane": "lane_sachbearbeiter",
  "has_join": false,
  "marker": null,
  "loopType": null,
  "multiInstance": null,
  "attachedTo": null,
  "cancelActivity": true,
  "isInterrupting": true
}
```

| Field             | Required | Description                                              |
|-------------------|----------|----------------------------------------------------------|
| `id`              | Yes      | Unique, snake_case, descriptive                          |
| `type`            | Yes      | See node type table below                                |
| `name`            | Yes      | Human label (Objekt+Verb for tasks, question for XOR GWs)|
| `lane`            | No       | Reference to LaneObject.id                               |
| `has_join`        | No       | `true` if gateway merges (joins) split paths             |
| `marker`          | No       | Event marker: message, timer, error, signal, etc.; `none` for a plain event |
| `loopType`        | No       | `"standard"` for loop marker on task                     |
| `multiInstance`   | No       | `"parallel"` or `"sequential"` for MI markers            |
| `attachedTo`      | No       | Node ID this boundary event is attached to               |
| `cancelActivity`  | No       | `false` for non-interrupting boundary events             |
| `isInterrupting`  | No       | `false` for non-interrupting start events in subprocesses|
| `isCollection`    | No       | `true` for collection data objects                       |
| `isEventSubProcess` | No    | `true` for event sub-processes (dashed border)           |
| `isAdHoc`         | No       | `true` for ad-hoc sub-processes (~ marker)               |
| `isCompensation`  | No       | `true` for compensation tasks (◁◁ marker)                |
| `color`           | No       | BPMN-in-Color: `{ "fill": "#ffe0b2", "stroke": "#e65100" }`. Hex colours only, `#rgb` or `#rrggbb`; named and `rgb()` values are refused by the schema gate — convert them to hex |
| `role`            | No       | Who performs an Activity (task, subProcess, transaction, callActivity), e.g. `"Claims handler"`. Written as a `bpmn:humanPerformer` (userTask, manualTask) or `bpmn:performer` pointing at one shared `bpmn:resource` per role name. One role per activity; names compare exactly (`"SAP"` ≠ `"sap"`) |
| `system`          | No       | Which IT system a task involves (any task type), e.g. `"SAP"`. Written into `extensionElements` under the generator's own namespace (`bg:system`) |

`role` and `system` are data, not drawing: they change nothing in the SVG or the layout. To show
roles or systems as lanes or pools today, model them that way — see
[`docs/roles-and-systems.md`](../docs/roles-and-systems.md). A `role` on a non-Activity, or a
`system` on anything but a task, is dropped from the XML and reported by rule S15.

### Node Type Values

| Type                     | BPMN element / visual                      | When to use                                  |
|--------------------------|--------------------------------------------|----------------------------------------------|
| `startEvent`             | Start event — thin circle                  | Process trigger, one per process             |
| `endEvent`               | End event — thick circle                   | Process termination, at least one            |
| `intermediateCatchEvent` | Catch event — double circle                | Waiting for message/timer mid-process        |
| `intermediateThrowEvent` | Throw event — double circle, filled marker | Sending signal/message mid-process           |
| `boundaryEvent`          | Boundary event — on the activity's border  | Timer/error/… on an activity, requires `attachedTo` |
| `task`                   | Task — rounded rectangle                   | Generic activity, type unspecified           |
| `userTask`               | User task — person icon                    | Human action with IT support (form, approval) |
| `serviceTask`            | Service task — gear icon                   | Automated system call, API, integration      |
| `scriptTask`             | Script task — script icon                  | Script executed by the engine                |
| `sendTask`               | Send task — filled envelope                | Send message to external participant         |
| `receiveTask`            | Receive task — outlined envelope           | Wait for incoming message                    |
| `manualTask`             | Manual task — hand icon                    | Physical/offline activity, no IT             |
| `businessRuleTask`       | Business rule task — table icon            | DMN decision, rule engine call (`decisionRef`, see `references/dmn.md`) |
| `subProcess`             | Sub-process — `[+]` when collapsed         | Grouping of >3 sub-steps (`isExpanded: true` to draw the inside) |
| `transaction`            | Transaction — double border                | Sub-process that completes or is cancelled as a unit |
| `callActivity`           | Call activity — thick border               | Reusable called process (`calledElement`)    |
| `exclusiveGateway`       | XOR gateway — diamond with ✕               | Exactly one path chosen, name as question    |
| `parallelGateway`        | AND gateway — diamond with +               | All paths execute simultaneously             |
| `inclusiveGateway`       | OR gateway — diamond with ○                | One or more paths chosen                     |
| `eventBasedGateway`      | Event gateway — diamond with pentagon      | Path chosen by first event received          |
| `complexGateway`         | Complex gateway — diamond with ✱           | Custom merging/splitting logic               |
| `dataObjectReference`    | Data object — page with folded corner      | Document/data passed within one case         |
| `dataStoreReference`     | Data store — cylinder                      | Database/persistent storage                  |
| `textAnnotation`         | Text annotation — open bracket with text   | Explanatory note attached via association    |
| `group`                  | Group — dashed rounded rectangle           | Visual grouping (no execution semantics)     |

### Activity markers

Drawn at the bottom centre of a task or subprocess:

| Marker        | Field                         | Visual                  |
|---------------|-------------------------------|-------------------------|
| Standard loop | `loopType: "standard"`        | circular arrow          |
| MI parallel   | `multiInstance: "parallel"`   | three vertical bars     |
| MI sequential | `multiInstance: "sequential"` | three horizontal bars   |
| Ad-hoc        | `isAdHoc: true`               | tilde                   |
| Compensation  | `isCompensation: true`        | double rewind           |

### Event Marker Values

Set `marker` on event nodes to specify the trigger type:

| Marker           | Icon            | Use for                              |
|------------------|-----------------|--------------------------------------|
| `message`        | Envelope ✉      | Incoming/outgoing message            |
| `timer`          | Clock ⏰         | Time-based trigger, deadline, cycle  |
| `error`          | Lightning ⚡     | Error throw/catch                    |
| `signal`         | Triangle △       | Broadcast signal                     |
| `escalation`     | Arrow chevron ↑  | Escalation to higher authority       |
| `compensation`   | Rewind ◁◁       | Compensation trigger                 |
| `conditional`    | Ruled page ☰    | Condition becomes true               |
| `link`           | Arrow →          | Off-page connector                   |
| `cancel`         | X mark ✕         | Transaction cancellation             |
| `terminate`      | Filled circle ●  | Terminate all process paths          |
| `multiple`       | Pentagon ⬠       | Multiple triggers (any one fires)    |
| `parallelMultiple` | Plus +         | Multiple triggers (all must fire)    |
| `none`           | (no icon)        | A plain event on purpose             |

If `marker` is not set, the pipeline infers it from the event name (e.g. "Frist abgelaufen" → timer).
`marker: "none"` stops that: the event is drawn and written as a plain event, without an event
definition, whatever its name says (with or without a declared `language`). It is valid on an end and
intermediate throw event and on a start event outside an event subprocess; on a boundary or
intermediate catch event and on the start event of an event subprocess, which need a trigger, rule
S15 reports it. In the XML the event carries `bg:marker="none"` (namespace
`http://bpmn-generator/schema/1.0`, declared on `bpmn:definitions`), and both importers read it back
as `marker: "none"`; an event definition on the same event wins over the attribute. A model without
`"none"` writes no such attribute.

Which markers the generator draws per event type:

| Event type          | Markers |
|---------------------|---------|
| Start               | none, message, timer, signal, conditional, error, escalation, compensation |
| End                 | none, message, signal, error, escalation, compensation, cancel, terminate, multiple |
| Intermediate catch  | message, timer, signal, conditional, link, error, escalation, compensation, cancel |
| Intermediate throw  | none, message, signal, link, escalation, compensation |
| Boundary            | timer, error, message, signal, escalation, compensation, cancel, conditional |

`none` in this table is a plain event: no `marker` and no marker inferred from the name, or
`marker: "none"` (on a start event only outside an event subprocess).

### Referencing a definition: `messageRef`, `signalRef`, `errorRef`, `escalationRef`

Message, signal, error and escalation events can point at a specific top-level definition (the
`definitions` array on the document) by id. The field is named after the OMG attribute and must match
the marker: `messageRef` on a `message` event, `signalRef` on `signal`, `errorRef` on `error`,
`escalationRef` on `escalation`. `messageRef` is also valid on `sendTask` and `receiveTask`.

```json
{ "id": "w", "type": "intermediateCatchEvent", "marker": "message", "name": "Payment confirmed", "messageRef": "Msg_Pay" }
```

Without the field: exactly one definition of the type is referenced implicitly; with several, no
reference is written and rule S17 warns. A reference to an unknown id, to a definition of another
type, or on a node whose marker does not match is rule S16 (ERROR). An event without the field and
with exactly one definition of its type is written with that reference, so it re-imports with the
field set explicitly.

---

## EdgeObject

```json
{
  "id": "flow_pruefen_entscheiden",
  "source": "task_antrag_pruefen",
  "target": "gw_antrag_gueltig",
  "label": "",
  "condition": "",
  "isHappyPath": true,
  "isDefault": false,
  "isConditional": false
}
```

| Field           | Required | Description                                                  |
|-----------------|----------|--------------------------------------------------------------|
| `id`            | Yes      | Unique, `flow_<source>_<target>` convention                  |
| `source`        | Yes      | NodeObject.id                                                |
| `target`        | Yes      | NodeObject.id                                                |
| `label`         | No       | Gateway outgoing labels: "Ja", "Nein", "genehmigt", etc.     |
| `condition`     | No       | Formal condition expression (for BPMN execution)             |
| `isHappyPath`   | No       | `true` → ElkJS prioritizes this edge as main flow axis       |
| `isDefault`     | No       | `true` → Default flow (diagonal slash marker at source)      |
| `isConditional` | No       | `true` → Conditional flow (diamond marker at source)         |

How each connection is drawn:

| Connection       | Line              | Source marker  | Target marker               |
|------------------|-------------------|----------------|-----------------------------|
| Sequence flow    | solid             | —              | filled triangle             |
| Default flow     | solid             | diagonal slash | filled triangle             |
| Conditional flow | solid             | open diamond   | filled triangle             |
| Message flow     | dashed            | open circle    | open triangle               |
| Association      | dotted            | —              | open chevron (if `directed`) |

---

## LaneObject

```json
{
  "id": "lane_sachbearbeiter",
  "name": "Sachbearbeiter"
}
```

| Field  | Required | Description                            |
|--------|----------|----------------------------------------|
| `id`   | Yes      | Unique lane ID                         |
| `name` | Yes      | Role name (functional, not personal!)  |

---

## MessageFlowObject (cross-pool communication)

```json
{
  "id": "mf_order_to_supplier",
  "source": "task_send_order",
  "target": "start_receive_order",
  "name": "Purchase Order"
}
```

| Field    | Required | Description                                    |
|----------|----------|------------------------------------------------|
| `id`     | Yes      | Unique message flow ID                         |
| `source` | Yes      | Node ID or Pool ID (source participant)        |
| `target` | Yes      | Node ID or Pool ID (target participant)        |
| `name`   | No       | Message label                                  |

---

## Minimal Example (no lanes)

```json
{
  "id": "Process_Antragspruefung",
  "name": "Antragsprüfung",
  "nodes": [
    { "id": "start",           "type": "startEvent",       "name": "Antrag eingegangen" },
    { "id": "task_pruefen",    "type": "userTask",         "name": "Antrag prüfen" },
    { "id": "gw_gueltig",      "type": "exclusiveGateway", "name": "Antrag gültig?" },
    { "id": "task_genehmigen", "type": "userTask",         "name": "Antrag genehmigen" },
    { "id": "task_ablehnen",   "type": "userTask",         "name": "Antrag ablehnen" },
    { "id": "end_ok",          "type": "endEvent",         "name": "Antrag genehmigt" },
    { "id": "end_abgelehnt",   "type": "endEvent",         "name": "Antrag abgelehnt" }
  ],
  "edges": [
    { "id": "f1", "source": "start",           "target": "task_pruefen",    "isHappyPath": true },
    { "id": "f2", "source": "task_pruefen",    "target": "gw_gueltig",      "isHappyPath": true },
    { "id": "f3", "source": "gw_gueltig",      "target": "task_genehmigen", "label": "Ja",  "isHappyPath": true },
    { "id": "f4", "source": "gw_gueltig",      "target": "task_ablehnen",   "label": "Nein" },
    { "id": "f5", "source": "task_genehmigen", "target": "end_ok" },
    { "id": "f6", "source": "task_ablehnen",   "target": "end_abgelehnt" }
  ],
  "lanes": []
}
```

---

## Example with Lanes

```json
{
  "id": "Process_Rechnungsverarbeitung",
  "name": "Rechnungsverarbeitung",
  "lanes": [
    { "id": "lane_posteingang", "name": "Posteingang" },
    { "id": "lane_buchhaltung", "name": "Buchhaltung" },
    { "id": "lane_freigabe",    "name": "Freigabe" }
  ],
  "nodes": [
    { "id": "start",          "type": "startEvent",       "name": "Rechnung eingegangen", "lane": "lane_posteingang" },
    { "id": "task_erfassen",  "type": "userTask",         "name": "Rechnung erfassen",    "lane": "lane_buchhaltung" },
    { "id": "task_pruefen",   "type": "userTask",         "name": "Rechnung prüfen",      "lane": "lane_buchhaltung" },
    { "id": "gw_korrekt",     "type": "exclusiveGateway", "name": "Rechnung korrekt?",    "lane": "lane_buchhaltung" },
    { "id": "task_freigeben", "type": "userTask",         "name": "Rechnung freigeben",   "lane": "lane_freigabe" },
    { "id": "task_zurueck",   "type": "userTask",         "name": "Rückfrage stellen",    "lane": "lane_buchhaltung" },
    { "id": "task_bezahlen",  "type": "serviceTask",      "name": "Zahlung anweisen",     "lane": "lane_buchhaltung" },
    { "id": "end",            "type": "endEvent",         "name": "Rechnung bezahlt",     "lane": "lane_buchhaltung" }
  ],
  "edges": [
    { "id": "f1", "source": "start",          "target": "task_erfassen",  "isHappyPath": true },
    { "id": "f2", "source": "task_erfassen",  "target": "task_pruefen",   "isHappyPath": true },
    { "id": "f3", "source": "task_pruefen",   "target": "gw_korrekt",     "isHappyPath": true },
    { "id": "f4", "source": "gw_korrekt",     "target": "task_freigeben", "label": "Ja", "isHappyPath": true },
    { "id": "f5", "source": "gw_korrekt",     "target": "task_zurueck",   "label": "Nein" },
    { "id": "f6", "source": "task_freigeben", "target": "task_bezahlen",  "isHappyPath": true },
    { "id": "f7", "source": "task_bezahlen",  "target": "end",            "isHappyPath": true }
  ]
}
```

---

## Example with Parallel Gateway (split + join)

```json
{
  "id": "Process_Parallel",
  "name": "Parallelverarbeitung",
  "nodes": [
    { "id": "start",      "type": "startEvent",      "name": "Auftrag erhalten" },
    { "id": "gw_split",   "type": "parallelGateway",  "name": "" },
    { "id": "task_a",     "type": "userTask",         "name": "Dokument prüfen" },
    { "id": "task_b",     "type": "serviceTask",      "name": "Bonität prüfen" },
    { "id": "gw_join",    "type": "parallelGateway",  "name": "", "has_join": true },
    { "id": "task_final", "type": "userTask",         "name": "Ergebnis bewerten" },
    { "id": "end",        "type": "endEvent",         "name": "Auftrag abgeschlossen" }
  ],
  "edges": [
    { "id": "f1", "source": "start",      "target": "gw_split",   "isHappyPath": true },
    { "id": "f2", "source": "gw_split",   "target": "task_a",     "isHappyPath": true },
    { "id": "f3", "source": "gw_split",   "target": "task_b" },
    { "id": "f4", "source": "task_a",     "target": "gw_join",    "isHappyPath": true },
    { "id": "f5", "source": "task_b",     "target": "gw_join" },
    { "id": "f6", "source": "gw_join",    "target": "task_final", "isHappyPath": true },
    { "id": "f7", "source": "task_final", "target": "end" }
  ],
  "lanes": []
}
```

---

## Example: Multi-Pool with Message Flows

```json
{
  "pools": [
    {
      "id": "Process_Customer",
      "name": "Kunde",
      "nodes": [
        { "id": "c_start",      "type": "startEvent",  "name": "Bedarf erkannt" },
        { "id": "c_send_order", "type": "sendTask",    "name": "Bestellung senden" },
        { "id": "c_wait",       "type": "intermediateCatchEvent", "name": "Lieferung abwarten", "marker": "message" },
        { "id": "c_end",        "type": "endEvent",    "name": "Ware erhalten" }
      ],
      "edges": [
        { "id": "cf1", "source": "c_start",      "target": "c_send_order", "isHappyPath": true },
        { "id": "cf2", "source": "c_send_order",  "target": "c_wait",      "isHappyPath": true },
        { "id": "cf3", "source": "c_wait",        "target": "c_end" }
      ],
      "lanes": []
    },
    {
      "id": "Process_Supplier",
      "name": "Lieferant",
      "nodes": [
        { "id": "s_start",   "type": "startEvent",   "name": "Bestellung eingegangen", "marker": "message" },
        { "id": "s_process", "type": "serviceTask",   "name": "Bestellung verarbeiten" },
        { "id": "s_ship",    "type": "sendTask",      "name": "Lieferung versenden" },
        { "id": "s_end",     "type": "endEvent",      "name": "Bestellung abgeschlossen" }
      ],
      "edges": [
        { "id": "sf1", "source": "s_start",   "target": "s_process", "isHappyPath": true },
        { "id": "sf2", "source": "s_process", "target": "s_ship",    "isHappyPath": true },
        { "id": "sf3", "source": "s_ship",    "target": "s_end" }
      ],
      "lanes": []
    }
  ],
  "messageFlows": [
    { "id": "mf1", "source": "c_send_order", "target": "s_start",  "name": "Bestellung" },
    { "id": "mf2", "source": "s_ship",       "target": "c_wait",   "name": "Lieferbestätigung" }
  ]
}
```

---

## Example: Boundary Timer Event

```json
{
  "id": "Process_WithBoundary",
  "name": "Fristüberwachung",
  "nodes": [
    { "id": "start",         "type": "startEvent",      "name": "Antrag eingegangen" },
    { "id": "task_bearbeit", "type": "userTask",         "name": "Antrag bearbeiten" },
    { "id": "timer_frist",   "type": "boundaryEvent",   "name": "Frist 5 Tage", "marker": "timer", "attachedTo": "task_bearbeit", "cancelActivity": false },
    { "id": "task_eskalat",  "type": "userTask",         "name": "Eskalation auslösen" },
    { "id": "end_ok",        "type": "endEvent",         "name": "Antrag bearbeitet" },
    { "id": "end_eskaliert", "type": "endEvent",         "name": "Eskaliert" }
  ],
  "edges": [
    { "id": "f1", "source": "start",         "target": "task_bearbeit", "isHappyPath": true },
    { "id": "f2", "source": "task_bearbeit", "target": "end_ok",        "isHappyPath": true },
    { "id": "f3", "source": "timer_frist",   "target": "task_eskalat" },
    { "id": "f4", "source": "task_eskalat",  "target": "end_eskaliert" }
  ],
  "lanes": []
}
```

---

## Format 2.0 (catalogue and lane views)

Format 2.0 is a second input format next to 1.x. A model says `"$schemaVersion": "2.0"` and is
validated by [`input-schema-v2.json`](input-schema-v2.json). A model without the field, or with
`1.x`, is a 1.x model and is unchanged. Exactly the string `"2.0"` is format 2.0: any other value of
the 2 line (`"2"`, `"2.1"`, `"2.7"`) is refused with one error that names the value and says that only
`"2.0"` is supported. The generated XML carries `bg:modelVersion="2.0"`.

**What 2.0 is:**

- The model has no `lanes`, `lane`, `role`, `system` or `children`. Lanes are formed from the
  model's assignments by a view (see the rule below), so the same model gives role lanes or unit
  lanes without an edit.
- An activity, event or gateway may carry `assignments`: `[ { "type": "D", "actor": "sb_schaden" } ]`.
  `type` is a key of the responsibility scheme, `actor` an id of the catalogue. At most one
  performer per node. Events and gateways carry only the performer type.
- Actors come from a catalogue: `{ "actors": [ { "id", "name", "kind"?, "unit"?, "partOf"? } ] }`,
  with `kind` `role` or `unit` (omitted: not recorded), `unit` naming the unit a role works in and
  `partOf` naming the parent unit of a unit (the organigram). The schema is
  [`catalog-schema.json`](catalog-schema.json).
- Every process needs an `id` matching `^[A-Za-z_][A-Za-z0-9_-]*$`; it is part of the lane ids.

**The organigram.** `partOf` names the parent unit and is allowed on units (`kind: "unit"`) and on
actors without `kind`, not on roles (a role's unit is `unit`). It must lead to a unit. Units that
nest in a cycle, including a unit that is part of itself, are error C07, once per cycle. Who counts
as a unit: an actor with `kind: "unit"`, and an actor without `kind` that another actor names as its
`unit` or `partOf` or that has a valid `partOf` of its own; the latter nests under its parent like a
unit. The organigram only matters to a view whose `lanes` is the object form (see "Lanes by
view").

**What 2.0 is not (yet):** no systems or data nodes, no positions or persons, no matrices (RACI),
no migration tool.

**The catalogue (three ways to pass it).**

1. CLI `--catalog <path>` (or `--catalog=<path>`), relative to the working directory. It wins over
   the model's own field.
2. The model's field `"catalog": "<path>"`, relative to the model file. Not on standard input,
   which has no file: there only `--catalog` works.
3. Library: `runPipeline(model, { catalog })` with a catalogue object. A string is a `TypeError`;
   read a file with `loadCatalog` (`scripts/shared/catalog.js`) first.

A model may carry `actors` (and `scheme`) itself, without a catalogue. Beside a catalogue (the file's
`catalog` field, `--catalog`, or the `catalog` option) its `actors` **replace** the entry of the same
id as a whole, in place, and an actor with a new id is appended after the catalogue's actors in the
model's order; hint H09 names each replaced entry (`elements` is `[id]`): one id then means different
things in two processes. Rules C01–C07 judge the effective catalogue, so replacing a unit by a role
(or the reverse) that other actors reference is C02. A `scheme` beside a catalogue is error C13; the
process file cannot change the scheme. The fingerprint `bg:catalog` is over the effective catalogue.
`--catalog` with a 1.x model is an error.

**The responsibility scheme.** `scheme` is the name of a shipped scheme or an embedded object; when
it is absent the scheme is `demi`. `demi` ([`schemes/demi-scheme.json`](schemes/demi-scheme.json))
has four types: `D` Durchführung (the performer, `performs: true`; exactly one type of a scheme
performs), `E` Ergebnisverantwortung, `M` Mitarbeit, `I` Information. The labels have no fixed
external source; the design chose them deliberately, so treat them as this project's wording and
not as a quotation of a standard.

**Lanes by view.** The view's `lanes` (`role`, `unit`, `none`, or the object form
`{ "by": "unit", "level"?: 1–16, "nested"?: boolean }`) forms the lanes. Shipped:
`views/rollen-view.json` (`role`), `views/einheiten-view.json` (`unit`) and
`views/organigramm-view.json` (`{ "by": "unit", "nested": true }`). Without `lanes` a 2.0
model gets role lanes; `none` gives no lanes. A `lanes` view on a 1.x model is a view error on
every surface.

- `role`: the lane is the performer of the step (a role, an actor without `kind`, or a unit that
  performs the step directly).
- `unit`: the unit of the performer: the performer itself when it is a unit (`kind: "unit"`, or an
  actor without `kind` that another actor names as its `unit` or `partOf` or that has a `partOf` of
  its own), else its `unit`; when
  that is missing the placeholder `(Einheit nicht erhoben)`, with hint H04. With the object form
  `{ "by": "unit", "level": k }` the lane is the unit at depth `k` of that unit's `partOf` chain
  (1 = a unit without `partOf`, counted from the top; `k` is 1–16); a unit shallower than `k` keeps its own lane. Without `level` each
  performer stays in its own unit.
- `{ "by": "unit", "nested": true }` (shipped as `views/organigramm-view.json`): the unit lanes nest
  along the organigram. Each unit a step is keyed on gets a lane for every unit of its `partOf` chain,
  as child lanes (`childLaneSet`), siblings in catalogue order; the layout may stack them along the
  flow. A unit that has steps of its own and child lanes holds those steps in an extra first child
  lane `L.<process-id>.<unit-id>._own`, named like the unit, so a parent lane holds no step itself.
  A performer without `kind` follows its own `partOf` chain: with a `partOf` it nests under its
  parent like a unit, without one it is a top-level lane.
  With `level` as well, the steps are mapped to depth `k` first, so the deepest lane is the unit at
  depth `k`. The placeholders are top-level lanes after the tree. Every lane of the tree, parent and
  own lane included, carries `bg:derived` with the unit's id as `actor`.

**The inheritance rule.** Only top-level flow nodes of each modelled process take a lane (children of
subprocesses get none, and only sequence flows count), and a node with a performer takes the lane of that
performer. An activity without performer goes to the placeholder `(nicht zugeordnet)` (H02), unless it is an
automatic task (`serviceTask`, `scriptTask`, `businessRuleTask`, `sendTask`, `receiveTask`), which is placed
with its neighbour (H03). Every other node without a lane inherits one from its neighbours, in rounds until
nothing changes:

- Direction by node kind: a start event and a merging gateway (two or more incoming flows, at most one
  outgoing) take the lane of their successors; a splitting gateway (and a gateway that both merges and
  splits, or does neither), an intermediate event, an end event and an automatic task take the lane of their
  predecessors.
- Back edges (loop-backs) do not count, neither as predecessor nor as successor. A back edge is a flow to a
  node on the current path of a depth-first search that starts at the start events in the order of `nodes`
  (at the first node when there is no start event), restarts from every node not yet visited, which is how
  paths behind boundary events are searched, and follows the flows in the order of `edges`.
- A node takes the most common lane among its neighbours in its direction (each neighbour counted once, by
  the state at the start of the round); on a tie the lane declared first in the catalogue wins, the
  placeholders last.
- When no round in that direction changes anything, one round in the other direction is tried; if it
  changes something, the rounds in the first direction resume.
- A node that still has no lane goes to `(nicht zugeordnet)` (H08).
- Boundary events take no part in the rounds: they are neither given a lane by a neighbour nor counted as
  one. A boundary event takes the lane of its host in the last step, wherever its exception path leads.

Behind a boundary event, an activity that is not automatic and has no performer goes to `(nicht zugeordnet)`
with H02 before any round, whatever its neighbours. An event, a gateway or an automatic task there has no
predecessor lane during the rounds (the boundary event takes no part). For the nodes whose direction is the
predecessor (an intermediate event, an end event, an automatic task, a splitting gateway) the other direction
then applies and the node takes the lane of its successors if they have one; a start event or a merging
gateway there already takes its lane from its successors; without any neighbour lane it lands in `(nicht zugeordnet)`
with H08.

A process without any performer gets no lanes (hint H06). The placeholders are ids
`L.<process-id>._unassigned` and `L.<process-id>._unitUnknown` with the names `(nicht zugeordnet)`
and `(Einheit nicht erhoben)`; ordinary lane ids are `L.<process-id>.<actor-id>`. A collision of a
lane id, or of its `<lane-id>_di`, with another id of the document is error C10, never a rename.

**Hints.** Hints go to `validation.hints` and never fail `--strict`. H02 (activity without
performer), H03 (automatic step placed with its neighbour), H04 (unit not recorded), H05 (lane name
over 25 characters), H06 (process without performer), H09 (a catalogue entry replaced by the process file) and H08 (node without a neighbour with a lane, or boundary event without a host with a lane: the step-7 fallback, reached only without prior validation)
come from the lane formation; H01 is the view's join-gateway derivation.

**Output of a 2.0 model (XML).** The assignments and the origin are kept in the XML so that the
diagram can be read back:

- `<bg:assignment type="D" actor="sb_schaden"/>` in the `extensionElements` of the node;
- `<bg:derived by="role" actor="sb_schaden">lane</bg:derived>` in the `extensionElements` of a
  formed lane (`by` is `role` or `unit`);
- on `bpmn:definitions`: `bg:modelVersion="2.0"`, `bg:view="<name>"`, `bg:catalog="sha256:<64 hex>"`
  and `exporter="bpmn-generator"`; there is no `exporterVersion`.

**`language` (2.0).** A 2.0 model may carry the same top-level `language` as a 1.x model (the same
pattern, see "Top-Level Fields"). It is kept on the intermediate form and written after the origin
attributes as `bg:language="<tag>"` on `bpmn:definitions`. Importing such a diagram yields a 1.x model
with the same `language`.

The fingerprint is SHA-256 (hex, prefixed `sha256:`) over the UTF-8 bytes of the canonical JSON of
`{ "actors": …, "scheme": … }`, with the scheme resolved to its object, keys sorted at every level,
arrays in their order, and no whitespace. A 2.0 output has no `bpmn:performer`, `bpmn:resource` or
`bg:system`.

**Which entry points read 2.0.** The CLI generate path (`node bpmn/pipeline.js`), the library
functions `runPipeline`, `validateModel` (`bpmn/validate.js`: the catalogue errors, else the rule
verdict with `findings`; it forms no lanes, so it never reports C10) and `orchestrate` (option
`catalog`; reviewer, layout and compliance judge the model, compliance gains `findings`; the
Modeler, which writes 1.x, is not asked to refine or amend a 2.0 model — the history records
`skipped: 'format 2.0'` — and `mode` optimize or soll throws F04 before any agent). The library function `generateDiagramSet` refuses a 2.0 model with a
blocked parent result ("[F04] drill-down is not available for format 2.0 models yet"). The MCP tools `generate_bpmn`, `validate_bpmn` and
`orchestrate_bpmn` and the HTTP endpoints `/api/v1/generate`, `/api/v1/validate` and
`/api/v1/orchestrate` read a 2.0 model with the catalogue embedded as an object (`catalog`; a path is never read: a `catalog` field that is a path without a `catalog` object is C13). `/api/v1/import` is unchanged. `validate_bpmn` and `/validate` do not report C10, which depends on the view. `mode` optimize or soll and `drillDown` are F04 (`drillDown`: library and MCP; HTTP has no such parameter). Every other entry point
(`redesign-cli.js`, the scenario pipeline) refuses a 2.0 model before any work with
one message, "format 2.0 is not accepted here yet". On the CLI a
2.0 model refuses `--optimize`, `--mode=soll`, `--dot`, `--format=dot` and `--drill-down`; `--doc`
works. The importers (`node bpmn/import.js`, MCP `import_bpmn`, HTTP `/api/v1/import`) read the
diagram of a 2.0 model and report that it was generated from one as notice N01 (the CLI on stderr
as `[N01] …`, MCP as a second text block holding the JSON `{"notices":[…]}`, HTTP as
`notices: [{ code, message }]`); the result is a 1.x model.

**Message codes.** The messages of the 2.0-specific path (catalogue, format, lane formation, import notice) carry a code
from `scripts/shared/message-codes.js`: a string leads with `[<code>] ` (C01–C07, C10–C13, F01–F04; the redesign and
scenarios CLIs print `✗ [F03] …`), an object has a `code` field (gate errors, hints H01–H06, H08 and H09,
`validation.findings`, notices), a thrown `CatalogRejectedError` has `messageCode`. Rule messages (S, M, P, WF) keep their text and get their id only in `validation.findings`. C12
covers the catalogue's bounds and schema; a model-carried `actors` list shares the catalogue's Actor
schema, so its schema failures surface as F01 at the format gate and only its bounds reach C12. The
table and the list of messages that stay uncoded are in
[`api-reference.md`](api-reference.md#message-codes). A 1.x model gets responses without codes.

## Translating 1.x models

`node bpmn/migrate.js <input.json> [output-base]` translates a 1.x model into a format 2.0 model, so
that the lane views (`rollen`, `einheiten`) can be applied to it. It writes `<base>.json` (the 2.0
model), `<base>.catalog.json` (the actors it created, to merge into your catalogue) and
`<base>.migrate-report.json`; flags, exit codes and the overwrite rule are in
[`cli.md`](cli.md#migrate-1x-to-20). The library function is `migrateModel(lc, { catalog,
dropUnsupported })` in `scripts/bpmn/migrate.js`. No byte-identity is promised across the
translator: the 2.0 model is a new document, the 1.x file stays as it is.

**Mapping.**

- Each lane becomes an actor without `kind` (`id` = the lane id, `name` = the lane name or id) and
  hint H07 asks you to check its kind. A lane id that is no valid actor id, or that collides with an
  id of a given catalogue, is renamed (MG06). A child lane gets `unit` = its parent lane's actor
  (none when the parent maps to a catalogue actor of `kind: "role"`, C02).
- An activity in a lane gets the assignment `{ type: <the scheme's performs type>, actor }`, `D`
  with the default demi scheme.
- A `role` on an activity names its performer: the lane actor of the same process with that name,
  else a catalogue actor of that name (MG07), else a new actor without `kind`, `role_<slug>`. Where
  the performer differs from the lane the report says so (MG03). A role actor's `unit` is the actor of
  its one lane; it has none when its activities sit in several lanes.
- Events, gateways, boundary events and subprocess children get no assignments; their lane follows
  the inheritance rule of the lane views. Where that differs from the 1.x lane the report says so
  (MG04); boundary events are not compared. An activity without a lane in a process with lanes gets
  no assignment (MG05; a role's actor performs it).
- A process without lanes gets no assignments (hint H06 when you generate it).
- `language` and every event `marker` are kept; `$schemaVersion` becomes `"2.0"`.

**Refused.** `system`, data objects and data stores and the flows and associations touching them
have no place in format 2.0 yet; they are refused (MG02) unless `--drop-unsupported` drops and lists
them. A duplicate id anywhere in the document (so also the same lane id in two pools), a 2.0 input or
a schema failure is refused as MG01. A refused input writes the report only.

**With `--catalog`.** A lane or role whose name equals an actor's name in that catalogue, exactly, is
that actor (MG07). The 2.0 model names that catalogue and carries the new actors itself; the supplement
lists the same new actors for merging. `migrate` never writes the given catalogue.

**Views afterwards.** Under `rollen` the lanes are those of the 1.x model (plus the effects of MG03
and MG04). Under `einheiten` a migrated top-level lane's actor has no `unit`, so its nodes land in the
placeholder lane "(Einheit nicht erhoben)"; child lanes appear under their parent's actor. That is
expected: add units to the catalogue to get unit lanes.

**Measured on the 28 1.x fixtures** (`tests/bench/migrate-fixtures.json`): `translated 19 of 28
(67.9 %), 28 of 28 with --drop-unsupported; MG03 3, MG04 16, MG05 0`. The 9 refusals are all MG02 (8
for data nodes, 1 for `system`). Under `rollen` the lane names and the placement of the nodes equal
the 1.x model for 20 of 28; the other 8 differ only by events or gateways that moved (each with MG04) or
by role lanes (MG03). The errors of the rules are identical to the 1.x run for all 28.

## Views (outside the model)

A view is not part of the Logic-Core. It is a separate file that decides how a model is processed
(rule profile, layout switches, derivations) and adds no knowledge about the process, so the author
never writes one into the model. Its one derivation that changes the diagram,
`derivations.joinGateways`, makes an implicit join (a task several flows enter) an explicit
exclusive join gateway in the output only. The gateway and its onward flow are both marked in the
XML (`<bg:derived>`); the model keeps its implicit join, and import removes the gateway and its
onward flow again unless someone edited them in a modeler. Each derivation is reported as hint
`H01` with `elements: [gatewayId, targetId, flowId]`. Format: `references/view-schema.json`;
see the README section [Views](../README.md#views).

## Common Anti-Patterns (Reviewer checklist)

| Anti-Pattern              | Problem                                            | Fix                                       |
|---------------------------|----------------------------------------------------|--------------------------------------------|
| AND-Join after XOR-Split  | Deadlock: AND waits for path that won't fire       | Use XOR-Join or restructure flow           |
| XOR Gateway without `?`   | Ambiguous decision                                | Rename to "Bedingung?" form                |
| Task not Objekt+Verb      | Unclear activity                                  | e.g. "Prüfung" → "Antrag prüfen"          |
| Isolated node             | Not connected to flow                             | Add at least one in/out edge               |
| No endEvent               | Flow never terminates                             | Add endEvent to every terminal path        |
| >10 nodes flat            | Cognitive overload                                | Group into subProcess                      |
| Split without join        | Open parallel paths                               | Add matching join gateway (same type)      |
| Missing edge labels       | XOR gateway with unlabeled outgoing edges         | Label every outgoing edge (Ja/Nein etc.)   |
| Personal names in lanes   | Model becomes outdated when people change roles   | Use functional roles: "Sachbearbeiter"     |

---

## CollapsedPoolObject (Black-Box Participant)

```json
{
  "id": "Pool_Kunde",
  "name": "Versicherungsnehmer (Kunde)"
}
```

| Field  | Required | Description                                       |
|--------|----------|---------------------------------------------------|
| `id`   | Yes      | Unique pool ID (used in messageFlow source/target) |
| `name` | Yes      | Participant name shown in the thin band            |

**Usage:** Collapsed pools represent external participants whose internal process
is unknown or out of scope (Bruce Silver "Method & Style" best practice).
A diagram should have **one expanded pool** (your process) and N collapsed pools
for external parties. Message Flows connect to collapsed pools as a whole.

**Rendering:** a thin horizontal band with the name centred; in the XML a `<participant>` without
`processRef` (OMG §9.3). Message flows name the collapsed pool's `id` as `source` or `target`.

**Position:** The order in which pools and collapsed pools are declared does **not**
determine their position in the diagram. By default the generator stacks all
participants so that the ones exchanging messages sit next to each other — a
message flow spanning N positions has to cross N-1 uninvolved pools, which reads
as a participation that does not exist. Expanded and collapsed participants are
ordered together, so an external system ends up next to the pool it talks to.

Pass `poolOrder: "declared"` (pipeline option, `config.json → layout.poolOrder`,
or the parameter of the same name on `generate_bpmn` and `/api/v1/generate`) to
keep the declared order instead. Nothing else changes: routing stays orthogonal,
there are just more crossings, and the DI check reports them as DI05.

---

## AssociationObject

```json
{
  "id": "assoc_task_data",
  "source": "task_erfassen",
  "target": "do_schadenakte",
  "directed": true
}
```

| Field     | Required | Description                                    |
|-----------|----------|------------------------------------------------|
| `id`      | Yes      | Unique association ID                          |
| `source`  | Yes      | Source node ID                                 |
| `target`  | Yes      | Target node ID                                 |
| `directed`| No       | `true` for directed association (with arrow)   |

**Usage:** Associations connect Data Objects, Data Stores, and Text Annotations
to flow nodes. They are dotted lines, not sequence flows.

In the XML an `<association>` (with `associationDirection`) sits in the process's `<artifacts>`,
next to the TextAnnotation or Group it connects — never in `<flowElements>` (OMG §10.7).

```json
{
  "associations": [
    { "id": "assoc1", "source": "task_erfassen", "target": "do_akte", "directed": true },
    { "id": "assoc2", "source": "ann_hinweis", "target": "task_pruefen" }
  ]
}
```

---

## Process Documentation

Any node or process can have a `documentation` string field:

```json
{
  "id": "task_pruefen",
  "type": "userTask",
  "name": "Antrag prüfen",
  "documentation": "Sachbearbeiter prüft den Antrag auf Vollständigkeit und Deckung"
}
```

This generates `<documentation>` child elements in the BPMN XML.

---

## Method & Style Rules (Bruce Silver)

The following rules are enforced by the pipeline validator and reviewer:

1. **One expanded pool per diagram** — your process. External participants → collapsed pools.
2. **Task names**: Objekt + Verb, Verb im Infinitiv ("Antrag prüfen", nicht "Prüfung")
3. **XOR Gateway names**: Question form ("Antrag gültig?")
4. **AND/OR Gateway names**: Empty or brief label — never a question
5. **Merge gateways**: Never labeled
6. **Message Flow labels**: Noun (the message name), never verb ("Bestellung", nicht "Bestellung senden")
7. **Every flow path terminates** at an endEvent
8. **Max 7-10 elements per level** — use subProcess for complexity
9. **Default flow**: Mark exactly one outgoing edge from XOR gateways as `isDefault: true`
10. **Lanes = functional roles or departments**, never people ("Sachbearbeiter", nicht "Max Müller")

---

## Example: Method & Style Collaboration (1 expanded + 2 collapsed)

```json
{
  "pools": [
    {
      "id": "Process_Versicherer",
      "name": "Schadenregulierung",
      "lanes": [
        { "id": "lane_sb", "name": "Sachbearbeiter" }
      ],
      "nodes": [
        { "id": "start",       "type": "startEvent",       "name": "Schadensmeldung eingegangen", "lane": "lane_sb", "marker": "message" },
        { "id": "task_pruef",  "type": "businessRuleTask",  "name": "Deckung prüfen", "lane": "lane_sb" },
        { "id": "gw_gedeckt",  "type": "exclusiveGateway",  "name": "Schaden gedeckt?", "lane": "lane_sb" },
        { "id": "task_zahlen", "type": "serviceTask",        "name": "Betrag auszahlen", "lane": "lane_sb" },
        { "id": "task_ableh",  "type": "sendTask",           "name": "Ablehnung versenden", "lane": "lane_sb" },
        { "id": "end_ok",      "type": "endEvent",           "name": "Reguliert", "lane": "lane_sb" },
        { "id": "end_nein",    "type": "endEvent",           "name": "Abgelehnt", "lane": "lane_sb" }
      ],
      "edges": [
        { "id": "f1", "source": "start",      "target": "task_pruef",  "isHappyPath": true },
        { "id": "f2", "source": "task_pruef",  "target": "gw_gedeckt", "isHappyPath": true },
        { "id": "f3", "source": "gw_gedeckt",  "target": "task_zahlen", "label": "Ja", "isHappyPath": true },
        { "id": "f4", "source": "gw_gedeckt",  "target": "task_ableh",  "label": "Nein", "isDefault": true },
        { "id": "f5", "source": "task_zahlen", "target": "end_ok" },
        { "id": "f6", "source": "task_ableh",  "target": "end_nein" }
      ]
    }
  ],
  "collapsedPools": [
    { "id": "Pool_Kunde", "name": "Versicherungsnehmer" },
    { "id": "Pool_Gutachter", "name": "Externer Gutachter" }
  ],
  "messageFlows": [
    { "id": "mf1", "source": "Pool_Kunde", "target": "start", "name": "Schadensmeldung" },
    { "id": "mf2", "source": "task_ableh", "target": "Pool_Kunde", "name": "Ablehnungsbescheid" },
    { "id": "mf3", "source": "task_zahlen", "target": "Pool_Kunde", "name": "Leistungsbescheid" }
  ]
}
```
