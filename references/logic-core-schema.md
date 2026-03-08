# Logic-Core JSON Schema Reference v2.0

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
| `name`            | Yes      | Human label (Verb+Noun for tasks, question for XOR GWs)  |
| `lane`            | No       | Reference to LaneObject.id                               |
| `has_join`        | No       | `true` if gateway merges (joins) split paths             |
| `marker`          | No       | Event marker: message, timer, error, signal, etc.        |
| `loopType`        | No       | `"standard"` for loop marker on task                     |
| `multiInstance`   | No       | `"parallel"` or `"sequential"` for MI markers            |
| `attachedTo`      | No       | Node ID this boundary event is attached to               |
| `cancelActivity`  | No       | `false` for non-interrupting boundary events             |
| `isInterrupting`  | No       | `false` for non-interrupting start events in subprocesses|
| `isCollection`    | No       | `true` for collection data objects                       |
| `isEventSubProcess` | No    | `true` for event sub-processes (dashed border)           |
| `isAdHoc`         | No       | `true` for ad-hoc sub-processes (~ marker)               |
| `isCompensation`  | No       | `true` for compensation tasks (◁◁ marker)                |

### Node Type Values

| Type                     | BPMN Element            | When to use                                  |
|--------------------------|-------------------------|----------------------------------------------|
| `startEvent`             | Start Event             | Process trigger, one per process             |
| `endEvent`               | End Event               | Process termination, at least one            |
| `intermediateCatchEvent` | Catch Event             | Waiting for message/timer mid-process        |
| `intermediateThrowEvent` | Throw Event             | Sending signal/message mid-process           |
| `boundaryEvent`          | Boundary Event          | Attached to task, requires `attachedTo`      |
| `task`                   | Task                    | Generic activity                             |
| `userTask`               | User Task               | Human action (form, decision, approval)      |
| `serviceTask`            | Service Task            | Automated system call, API, integration      |
| `scriptTask`             | Script Task             | Automated script/rule execution              |
| `sendTask`               | Send Task               | Send message to external participant         |
| `receiveTask`            | Receive Task            | Wait for incoming message                    |
| `manualTask`             | Manual Task             | Physical/offline activity                    |
| `businessRuleTask`       | Business Rule Task      | DMN decision, rule engine call               |
| `subProcess`             | Sub-Process (collapsed) | Collapsed activity grouping >3 sub-steps     |
| `callActivity`           | Call Activity           | Reusable called process                      |
| `exclusiveGateway`       | XOR Gateway             | Exactly one path chosen, name as question    |
| `parallelGateway`        | AND Gateway             | All paths execute simultaneously             |
| `inclusiveGateway`       | OR Gateway              | One or more paths chosen                     |
| `eventBasedGateway`      | Event Gateway           | Path chosen by first event received          |
| `complexGateway`         | Complex Gateway         | Custom merging/splitting logic               |
| `dataObjectReference`    | Data Object             | Document/artifact flowing through process    |
| `dataStoreReference`     | Data Store              | Database/persistent storage                  |
| `textAnnotation`         | Text Annotation         | Explanatory note attached via association     |
| `group`                  | Group                   | Visual grouping (no execution semantics)      |

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

If `marker` is not set, the pipeline infers it from the event name (e.g. "Frist abgelaufen" → timer).

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
    { "id": "lane_lieferant",   "name": "Lieferant" },
    { "id": "lane_buchhaltung", "name": "Buchhaltung" },
    { "id": "lane_freigabe",    "name": "Freigabe" }
  ],
  "nodes": [
    { "id": "start",          "type": "startEvent",       "name": "Rechnung eingegangen", "lane": "lane_lieferant" },
    { "id": "task_erfassen",  "type": "userTask",         "name": "Rechnung erfassen",    "lane": "lane_buchhaltung" },
    { "id": "task_pruefen",   "type": "userTask",         "name": "Rechnung prüfen",      "lane": "lane_buchhaltung" },
    { "id": "gw_korrekt",     "type": "exclusiveGateway", "name": "Rechnung korrekt?",    "lane": "lane_buchhaltung" },
    { "id": "task_freigeben", "type": "userTask",         "name": "Rechnung freigeben",   "lane": "lane_freigabe" },
    { "id": "task_zurueck",   "type": "userTask",         "name": "Rückfrage stellen",    "lane": "lane_lieferant" },
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

## Common Anti-Patterns (Reviewer checklist)

| Anti-Pattern              | Problem                                            | Fix                                       |
|---------------------------|----------------------------------------------------|--------------------------------------------|
| AND-Join after XOR-Split  | Deadlock: AND waits for path that won't fire       | Use XOR-Join or restructure flow           |
| XOR Gateway without `?`   | Ambiguous decision                                | Rename to "Bedingung?" form                |
| Task not Verb+Noun        | Unclear activity                                  | e.g. "Prüfen" → "Antrag prüfen"           |
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
2. **Task names**: Verb + Substantiv ("Antrag prüfen", nicht "Prüfung")
3. **XOR Gateway names**: Question form ("Antrag gültig?")
4. **AND/OR Gateway names**: Empty or brief label — never a question
5. **Merge gateways**: Never labeled
6. **Message Flow labels**: Noun (the message name), never verb ("Bestellung", nicht "Bestellung senden")
7. **Every flow path terminates** at an endEvent
8. **Max 7-10 elements per level** — use subProcess for complexity
9. **Default flow**: Mark exactly one outgoing edge from XOR gateways as `isDefault: true`
10. **Lanes = specific roles**, not departments ("Sachbearbeiter", nicht "Abteilung")

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
