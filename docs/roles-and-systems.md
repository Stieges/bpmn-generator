# Showing roles and systems

A process model answers two questions beside *what happens*: **who** does a step, and **which IT
system** is involved. This page shows how to get the common pictures for both **today**, with the
lanes and pools the generator already draws, what the `role` and `system` fields on an
activity are for, and, in format 2.1, how a step records the data it reads or writes.

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
| Which data a step reads or writes (format 2.1) | `data` + `dataAccess` | [7](#7-data-objects-and-data-stores-format-21) |

## 1. Responsibility lanes

The classic swimlane diagram: one pool for the process, one lane per department or role, and every
node placed in the lane of whoever does it (`lane` on the node). Name lanes after **functions**,
never after people — a model with "Ms Miller" in it is out of date the day she changes job.

```json
{
  "id": "Process_Order",
  "name": "Order handling",
  "lanes": [
    { "id": "lane_worker", "name": "Case worker" },
    { "id": "lane_lead", "name": "Team lead" }
  ],
  "nodes": [
    { "id": "start", "type": "startEvent", "name": "Order received", "lane": "lane_worker" },
    { "id": "check", "type": "userTask", "name": "Check order", "lane": "lane_worker" },
    { "id": "approve", "type": "userTask", "name": "Approve order", "lane": "lane_lead" },
    { "id": "notify", "type": "userTask", "name": "Notify customer", "lane": "lane_worker" },
    { "id": "end", "type": "endEvent", "name": "Order completed", "lane": "lane_worker" }
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
  "name": "Order handling",
  "nodes": [
    { "id": "start", "type": "startEvent", "name": "Order received" },
    { "id": "check", "type": "userTask", "name": "Check order", "role": "Case worker", "system": "Order system" },
    { "id": "book", "type": "serviceTask", "name": "Record payment", "role": "Accounting", "system": "SAP" },
    { "id": "notify", "type": "userTask", "name": "Notify customer", "role": "Case worker" },
    { "id": "end", "type": "endEvent", "name": "Order completed" }
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

A minimal catalogue: one unit, two roles in it, one role whose unit is not recorded, two systems and
three data items. Actors, systems and data share one id space. Save it as `catalog.json`.

<!-- quickstart: catalog.json -->
```jsonc
{
  "actors": [
    { "id": "u_purchasing", "name": "Purchasing", "kind": "unit" },
    { "id": "r_worker", "name": "Case worker", "kind": "role", "unit": "u_purchasing" },
    { "id": "r_lead", "name": "Team lead", "kind": "role", "unit": "u_purchasing" },
    { "id": "r_finance", "name": "Accountant", "kind": "role" }
  ],
  "systems": [
    { "id": "s_orders", "name": "Order system" },
    { "id": "s_payments", "name": "Payment system" }
  ],
  "data": [
    { "id": "d_order", "name": "Order", "kind": "object", "layer": "business" },
    { "id": "d_invoice", "name": "Invoice", "kind": "object" },
    { "id": "d_register", "name": "Order register", "kind": "store", "layer": "technical" }
  ]
}
```

A minimal 2.1 model, `quickstart.json` (`"2.1"` because it uses `system` and `dataAccess`; a model with
neither stays `"2.0"`). English names declare `"language": "en"`. The last activity has no performer on purpose,
only two tasks name a system, and two tasks record the data they use.

<!-- quickstart: quickstart.json -->
```jsonc
{
  "$schemaVersion": "2.1",
  "language": "en",
  "pools": [
    {
      "id": "Process_Order",
      "name": "Order handling",
      "nodes": [
        { "id": "start", "type": "startEvent", "name": "Order received", "assignments": [{ "type": "D", "actor": "r_worker" }] },
        { "id": "check", "type": "userTask", "name": "Check order", "system": "s_orders", "dataAccess": [{ "data": "d_order", "access": "read" }, { "data": "d_register", "access": "write" }], "assignments": [{ "type": "D", "actor": "r_worker" }] },
        { "id": "approve", "type": "userTask", "name": "Approve order", "assignments": [{ "type": "D", "actor": "r_lead" }] },
        { "id": "pay", "type": "userTask", "name": "Pay invoice", "system": "s_payments", "dataAccess": [{ "data": "d_invoice", "access": "read" }, { "data": "d_order" }], "assignments": [{ "type": "D", "actor": "r_finance" }] },
        { "id": "archive", "type": "userTask", "name": "Archive order" },
        { "id": "end", "type": "endEvent", "name": "Order completed" }
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

- `rollen`: one lane per performer (here Case worker, Team lead, Accountant).
- `einheiten`: one lane per unit of the performer (here Purchasing).
- `organigramm`: one lane per unit, nested along the organigram (`partOf`); with this flat catalogue it
  looks like `einheiten`.
- `systeme`: one lane per system of the task (here Order system, Payment system). Only a task with a
  `system` takes a lane of its own; events and gateways follow their neighbours, and the performers play
  no part. A model without any `system` gets no lanes in this view (hint H06).

A `"2.0"` model that uses `system`, `systems`, `data` or `dataAccess` is refused with one error F06 per
use; change the version to `"2.1"`. A `system` must name a system of the catalogue (C14) and sits on a
task (C15). The data of the quick start is explained in [section 7](#7-data-objects-and-data-stores-format-21);
it changes none of the lanes above.

Four **placeholder lanes** can appear: three when the model or the catalogue is incomplete, and one when a
view asks for it. All are hints, never errors:

| Lane | Meaning | Hint |
|---|---|---|
| `(nicht zugeordnet)` | An activity has no performer, or a node could take no lane from its neighbours | H02, H08 |
| `(Einheit nicht erhoben)` | The performer's unit is not in the catalogue; only in the unit views | H04 |
| `(System nicht erhoben)` | A task has no system; only in the view `systeme` | H20 |
| `(automatisch)` | An automatic task (service, script, business rule, send, receive) has no performer; only with the view option `"automatic": "lane"` | H19 |

The names are set in `scripts/config.json` under `laneFormation` (`unassignedName`, `unitUnknownName`,
`systemUnknownName`, `automaticName`). In the example, `Archive order` lands in `(nicht zugeordnet)` and, in the unit
views, `Pay invoice` in `(Einheit nicht erhoben)`; in the view `systeme`, `Approve order` and `Archive order`
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
lane. `automaticName` is optional (1-25 characters, not blank) and only valid with `"automatic": "lane"`; the view
`systeme` does not take the switch. Known limit: you reach it with `--view <path>`, an inline view over
HTTP or `runPipeline`; the MCP tools take a view by name only, and no shipped view sets it.

## 7. Data objects and data stores (format 2.1)

A step can record which data it reads or writes. The data items come from the catalogue, in the list
`data` (`{ id, name, kind?, layer?, isCollection? }`, one id space with actors and systems). `kind` is
`object` (a data object) or `store` (a data store); a business item and a technical one differ only in
the optional `layer`, which is kept in the catalogue and changes no drawing. An activity (any task,
`subProcess`, `transaction`, `callActivity`) lists its use in `dataAccess`, each entry naming a catalogue
item and, optionally, `read` or `write`:

```jsonc
// on the step "check" of the quick start
"dataAccess": [
  { "data": "d_order", "access": "read" },
  { "data": "d_register", "access": "write" }
]
```

What the generator draws for each step, whatever the view:

- One data reference per distinct item, in a row below the step. An `object` is a data object
  reference, a `store` a data store reference. `isCollection: true` draws the collection marker on an
  object; a store cannot be a collection.
- A `read` is an arrow from the data to the step, a `write` an arrow from the step to the data. An entry
  without `access` is a plain line without an arrow: the access is not recorded.
- The references follow their step in every lanes view. They never form
  a lane and never change the order of the lanes of a view.
- Several steps that use the same object share one data object element per process in the XML; a data store is one
  element of the whole diagram. Each step still gets its own reference, so each step has its own picture.

In the quick start the step `Check order` reads `Order` and writes `Order register`; `Pay invoice` reads
`Invoice` and uses `Order` with no recorded access. The XML holds 4 references, 2 input associations,
1 output association, 1 plain association and 1 data store.

The checks: a `dataAccess` entry must name a data item of the catalogue (C16, also for an actor or system id,
for an exact duplicate, for an item both with and without a recorded access on one step,
and for data without any catalogue), it sits on an activity (C15), and the ids the
generator derives for the references and their connections must not collide with an id of the model (C17).
An item without `kind` is drawn as a data object and reported once with hint H21. A model that names no
data keeps its output byte for byte.

Both importers read the result back: the references become data nodes, and a native
`dataInputAssociation` or `dataOutputAssociation` (also one drawn in a modeler) becomes a directed
association. The plain line of an unrecorded access comes back as an undirected association, so the
information is not lost, but a regenerated diagram does not distinguish it from a link someone drew.

Known limits: data on events and gateways, data states and hiding data in a view are not covered yet.
The data references of a step inside a collapsed subprocess are written to the XML but not drawn, and the
rows do not avoid the routes of sequence or message flows. A 1.x model keeps its data nodes as before;
`node bpmn/migrate.js` turns them into catalogue items and data access of the steps.
