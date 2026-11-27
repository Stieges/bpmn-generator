# Showing roles and systems

A process model answers two questions beside *what happens*: **who** does a step, and **which IT
system** is involved. This page shows how to get the common pictures for both **today**, with the
lanes and pools the generator already draws, and what the new `role` and `system` fields on an
activity are for.

Every `json` block on this page (sections 1 to 5) is a complete Logic-Core document. Save one as `example.json` and run

```bash
cd scripts
node bpmn/pipeline.js ../example.json /tmp/example     # writes /tmp/example.bpmn and /tmp/example.svg
```

Each of them is run through the pipeline by `scripts/bpmn/roles-and-systems-guide.test.js`, which
checks that it produces valid BPMN with no layout error — so the examples cannot silently rot. The
quick start in section 6 is run, command by command, by `scripts/bpmn/roles-and-systems-quickstart.test.js`.

| You want to see | Model it as | Section |
|---|---|---|
| Which department or role does each step | one pool, one lane per role | [1](#1-responsibility-lanes) |
| Which steps run automatically, in which system | an extra lane per system (Signavio style) | [2](#2-system-lanes) |
| A system as an outside party you exchange data with | a collapsed pool + message flows | [3](#3-systems-as-collapsed-pools) |
| What happens inside the system as well | an expanded pool of its own + message flows | [4](#4-systems-as-expanded-pools) |
| The facts only, without changing the picture | `role` / `system` on the activity | [5](#5-the-role-and-system-fields) |
| Lanes formed from a catalogue of actors and systems (format 2.x) | `assignments`, `system` + a lanes view | [6](#6-format-21-quick-start) |

## 1. Responsibility lanes

The classic swimlane diagram: one pool for the process, one lane per department or role, and every
node placed in the lane of whoever does it (`lane` on the node). Name lanes after **functions**,
never after people — a model with "Ms Miller" in it is out of date the day she changes job.

```json
{
  "id": "Process_Claim",
  "name": "Claim handling",
  "lanes": [
    { "id": "lane_handler", "name": "Claims handler" },
    { "id": "lane_lead", "name": "Team lead" }
  ],
  "nodes": [
    { "id": "start", "type": "startEvent", "name": "Claim received", "lane": "lane_handler" },
    { "id": "check", "type": "userTask", "name": "Check claim", "lane": "lane_handler" },
    { "id": "approve", "type": "userTask", "name": "Approve payout", "lane": "lane_lead" },
    { "id": "notify", "type": "userTask", "name": "Notify customer", "lane": "lane_handler" },
    { "id": "end", "type": "endEvent", "name": "Claim settled", "lane": "lane_handler" }
  ],
  "edges": [
    { "id": "f1", "source": "start", "target": "check" },
    { "id": "f2", "source": "check", "target": "approve" },
    { "id": "f3", "source": "approve", "target": "notify" },
    { "id": "f4", "source": "notify", "target": "end" }
  ]
}
```

## 2. System lanes

Some tools (Signavio among them) draw automated steps in a lane of their own, one per IT system, so
the picture shows at a glance where people work and where a system does. You get the same picture
by declaring a lane for each system and putting its `serviceTask`s there. Formally a lane is still a
partition of *responsibility*, so this is a reading convention — say so in the process
documentation if the diagram leaves your team. In a format 2.x model these lanes are not drawn in
the model: record the `system` of each task and let the view `systeme` form them
([section 6](#6-format-21-quick-start)).

```json
{
  "id": "Process_Invoice",
  "name": "Invoice processing",
  "lanes": [
    { "id": "lane_accounting", "name": "Accounting" },
    { "id": "lane_sap", "name": "SAP" },
    { "id": "lane_dms", "name": "Document management" }
  ],
  "nodes": [
    { "id": "start", "type": "startEvent", "name": "Invoice received", "lane": "lane_accounting" },
    { "id": "scan", "type": "serviceTask", "name": "Archive invoice", "lane": "lane_dms" },
    { "id": "check", "type": "userTask", "name": "Check invoice", "lane": "lane_accounting" },
    { "id": "book", "type": "serviceTask", "name": "Record invoice", "lane": "lane_sap" },
    { "id": "end", "type": "endEvent", "name": "Invoice posted", "lane": "lane_accounting" }
  ],
  "edges": [
    { "id": "f1", "source": "start", "target": "scan" },
    { "id": "f2", "source": "scan", "target": "check" },
    { "id": "f3", "source": "check", "target": "book" },
    { "id": "f4", "source": "book", "target": "end" }
  ]
}
```

## 3. Systems as collapsed pools

When the system is a separate party you exchange data with, and its inside does not matter here,
draw it as a **collapsed pool** (a black box) and connect it with **message flows**. Message flows
may start or end at the collapsed pool as a whole. The generator places each collapsed pool next to
the pool it talks to.

```json
{
  "pools": [
    {
      "id": "Process_Order",
      "name": "Sales",
      "nodes": [
        { "id": "start", "type": "startEvent", "name": "Order received" },
        { "id": "check", "type": "userTask", "name": "Check order" },
        { "id": "send", "type": "sendTask", "name": "Request credit check" },
        { "id": "receive", "type": "receiveTask", "name": "Receive credit result" },
        { "id": "end", "type": "endEvent", "name": "Order confirmed" }
      ],
      "edges": [
        { "id": "f1", "source": "start", "target": "check" },
        { "id": "f2", "source": "check", "target": "send" },
        { "id": "f3", "source": "send", "target": "receive" },
        { "id": "f4", "source": "receive", "target": "end" }
      ],
      "lanes": []
    }
  ],
  "collapsedPools": [
    { "id": "Pool_CRM", "name": "CRM system" }
  ],
  "messageFlows": [
    { "id": "mf1", "source": "send", "target": "Pool_CRM", "name": "Credit request" },
    { "id": "mf2", "source": "Pool_CRM", "target": "receive", "name": "Credit result" }
  ]
}
```

## 4. Systems as expanded pools

When the system's own steps matter, give it an **expanded pool** with a process of its own. Each
pool is then a separate process: the two are connected by message flows only, never by sequence
flows. This is the right picture when the system side is an integration you are specifying too.

```json
{
  "pools": [
    {
      "id": "Process_Sales",
      "name": "Sales",
      "nodes": [
        { "id": "s_start", "type": "startEvent", "name": "Order received" },
        { "id": "s_send", "type": "sendTask", "name": "Request credit check" },
        { "id": "s_receive", "type": "receiveTask", "name": "Receive credit result" },
        { "id": "s_end", "type": "endEvent", "name": "Order confirmed" }
      ],
      "edges": [
        { "id": "sf1", "source": "s_start", "target": "s_send" },
        { "id": "sf2", "source": "s_send", "target": "s_receive" },
        { "id": "sf3", "source": "s_receive", "target": "s_end" }
      ],
      "lanes": []
    },
    {
      "id": "Process_CRM",
      "name": "CRM system",
      "nodes": [
        { "id": "c_start", "type": "startEvent", "name": "Credit request received", "marker": "message" },
        { "id": "c_score", "type": "serviceTask", "name": "Calculate credit score" },
        { "id": "c_end", "type": "endEvent", "name": "Credit result sent", "marker": "message" }
      ],
      "edges": [
        { "id": "cf1", "source": "c_start", "target": "c_score" },
        { "id": "cf2", "source": "c_score", "target": "c_end" }
      ],
      "lanes": []
    }
  ],
  "messageFlows": [
    { "id": "mf1", "source": "s_send", "target": "c_start", "name": "Credit request" },
    { "id": "mf2", "source": "c_end", "target": "s_receive", "name": "Credit result" }
  ]
}
```

## 5. The `role` and `system` fields

The four pictures above are drawing choices: you decide once, by hand, how roles and systems show.
The fields below record the facts instead, on the activity itself, so the same model can later be
*drawn* either way without being re-modelled.

- **`role`** — who performs an activity (any task, `subProcess`, `transaction`, `callActivity`).
  Written as BPMN standard: one `<bpmn:resource>` per distinct role name, referenced from the
  activity by a `<bpmn:humanPerformer>` (`userTask`, `manualTask`) or a `<bpmn:performer>`
  (everything else). Tasks with the same role share one resource. One role per activity; names are
  compared exactly, so `"SAP"` and `"sap"` are two different names.
- **`system`** — which IT system a task involves (any task type). BPMN has no element for this, so
  it is written into the task's `extensionElements` as `<bg:system>`, in the generator's own
  namespace.

Both survive a round trip through the generator's importers (`node bpmn/import.js`) at every
nesting level, and both are valid BPMN 2.0 XML — the extension sits in `extensionElements`, which
the standard reserves for exactly this kind of foreign content. **Neither changes the drawing** — this example comes out exactly like the same model without them. Put either field on an
element it does not belong to (a `role` on a gateway, a `system` on an event) and it is left out of
the XML and reported by rule S15.

```json
{
  "id": "Process_Tagged",
  "name": "Claim handling",
  "nodes": [
    { "id": "start", "type": "startEvent", "name": "Claim received" },
    { "id": "check", "type": "userTask", "name": "Check claim", "role": "Claims handler", "system": "Claims portal" },
    { "id": "book", "type": "serviceTask", "name": "Record payout", "role": "Accounting", "system": "SAP" },
    { "id": "notify", "type": "userTask", "name": "Notify customer", "role": "Claims handler" },
    { "id": "end", "type": "endEvent", "name": "Claim settled" }
  ],
  "edges": [
    { "id": "f1", "source": "start", "target": "check" },
    { "id": "f2", "source": "check", "target": "book" },
    { "id": "f3", "source": "book", "target": "notify" },
    { "id": "f4", "source": "notify", "target": "end" }
  ]
}
```

**Planned:** a dedicated view that draws systems as pools, without changing the model. Until it
exists, use sections 3 and 4. For format 2.x models the lanes views `rollen`, `einheiten`,
`organigramm` and, per system of the task, `systeme` exist already, see
[section 6](#6-format-21-quick-start).

## 6. Format 2.1 quick start

In format 2.x the model has no lanes. Each step names who performs it (`assignments`, type `D`) and,
on a task, which system it uses (`system`, format 2.1); the actors and the systems come from a
**catalogue**, and a **view** decides which lanes are drawn. The same model gives role lanes, unit
lanes or system lanes without an edit. The full rules are in
[`references/logic-core-schema.md`](../references/logic-core-schema.md#format-20-catalogue-and-lane-views).

A minimal catalogue: one unit, two roles in it, one role whose unit is not recorded, and two systems.
Actors and systems share one id space. Save it as `catalog.json`.

<!-- quickstart: catalog.json -->
```jsonc
{
  "actors": [
    { "id": "u_claims", "name": "Claims department", "kind": "unit" },
    { "id": "r_handler", "name": "Claims handler", "kind": "role", "unit": "u_claims" },
    { "id": "r_lead", "name": "Team lead", "kind": "role", "unit": "u_claims" },
    { "id": "r_finance", "name": "Accountant", "kind": "role" }
  ],
  "systems": [
    { "id": "s_portal", "name": "Claims portal" },
    { "id": "s_payments", "name": "Payment system" }
  ]
}
```

A minimal 2.1 model, `quickstart.json` (`"2.1"` because it uses `system`; a model without systems stays
`"2.0"`). English names declare `"language": "en"`. The last activity has no performer on purpose,
and only two tasks name a system.

<!-- quickstart: quickstart.json -->
```jsonc
{
  "$schemaVersion": "2.1",
  "language": "en",
  "pools": [
    {
      "id": "Process_Claim",
      "name": "Claim handling",
      "nodes": [
        { "id": "start", "type": "startEvent", "name": "Claim received", "assignments": [{ "type": "D", "actor": "r_handler" }] },
        { "id": "check", "type": "userTask", "name": "Check claim", "system": "s_portal", "assignments": [{ "type": "D", "actor": "r_handler" }] },
        { "id": "approve", "type": "userTask", "name": "Approve payout", "assignments": [{ "type": "D", "actor": "r_lead" }] },
        { "id": "pay", "type": "userTask", "name": "Pay claim", "system": "s_payments", "assignments": [{ "type": "D", "actor": "r_finance" }] },
        { "id": "archive", "type": "userTask", "name": "Archive file" },
        { "id": "end", "type": "endEvent", "name": "Claim settled" }
      ],
      "edges": [
        { "id": "f1", "source": "start", "target": "check" },
        { "id": "f2", "source": "check", "target": "approve" },
        { "id": "f3", "source": "approve", "target": "pay" },
        { "id": "f4", "source": "pay", "target": "archive" },
        { "id": "f5", "source": "archive", "target": "end" }
      ]
    }
  ]
}
```

One command per shipped lanes view, run from `scripts/` with both files saved one directory up. Each
writes a `.bpmn` and an `.svg`; `--strict` passes, the hints below are information only.

<!-- quickstart: cli -->
```bash
node bpmn/pipeline.js ../quickstart.json ../quickstart-rollen --strict --view=rollen --catalog ../catalog.json
node bpmn/pipeline.js ../quickstart.json ../quickstart-einheiten --strict --view=einheiten --catalog ../catalog.json
node bpmn/pipeline.js ../quickstart.json ../quickstart-organigramm --strict --view=organigramm --catalog ../catalog.json
node bpmn/pipeline.js ../quickstart.json ../quickstart-systeme --strict --view=systeme --catalog ../catalog.json
```

- `rollen`: one lane per performer (here Claims handler, Team lead, Accountant).
- `einheiten`: one lane per unit of the performer (here Claims department).
- `organigramm`: one lane per unit, nested along the organigram (`partOf`); with this flat catalogue it
  looks like `einheiten`.
- `systeme`: one lane per system of the task (here Claims portal, Payment system). Only a task with a
  `system` takes a lane of its own; events and gateways follow their neighbours, and the performers play
  no part. A model without any `system` gets no lanes in this view (hint H06).

A `"2.0"` model that uses `system` or `systems` is refused with one error F06 per use; change the
version to `"2.1"`. A `system` must name a system of the catalogue (C14) and sits on a task (C15).

Four **placeholder lanes** appear when the model or the catalogue is incomplete. All are hints, never
errors:

| Lane | Meaning | Hint |
|---|---|---|
| `(nicht zugeordnet)` | An activity has no performer, or a node could take no lane from its neighbours | H02, H08 |
| `(Einheit nicht erhoben)` | The performer's unit is not in the catalogue; only in the unit views | H04 |
| `(System nicht erhoben)` | A task has no system; only in the view `systeme` | H20 |
| `(automatisch)` | An automatic task (service, script, business rule, send, receive) has no performer; only with the view option `"automatic": "lane"` | H19 |

The names are set in `scripts/config.json` under `laneFormation` (`unassignedName`, `unitUnknownName`,
`systemUnknownName`, `automaticName`). In the example, `Archive file` lands in `(nicht zugeordnet)` and, in the unit
views, `Pay claim` in `(Einheit nicht erhoben)`; in the view `systeme`, `Approve payout` and `Archive file`
land in `(System nicht erhoben)`.

By default an automatic task without a performer sits in its neighbour's lane (hint H03). A view file of
your own can give these tasks a lane instead:

```jsonc
// my-view.json (a view file of your own; use "unit" instead of "role" for the unit lanes)
{
  "view": "mine",
  "version": "1.0",
  "lanes": { "by": "role", "automatic": "lane", "automaticName": "(automatisch)" }
}
```

With it, an automatic task without a performer lands in `(automatisch)` with hint H19. Only
automatic tasks without a performer (and their boundary events) move; events and gateways keep their
lane. `automaticName` is optional (1-25 characters) and only valid with `"automatic": "lane"`; the view
`systeme` does not take the switch. Known limit: you reach it with `--view <path>`, an inline view over
HTTP or `runPipeline`; the MCP tools take a view by name only, and no shipped view sets it.
