# Showing roles and systems

A process model answers two questions beside *what happens*: **who** does a step, and **which IT
system** is involved. This page shows how to get the common pictures for both **today**, with the
lanes and pools the generator already draws, and what the new `role` and `system` fields on an
activity are for.

Every JSON block on this page is a complete Logic-Core document. Save one as `example.json` and run

```bash
cd scripts
node bpmn/pipeline.js ../example.json /tmp/example     # writes /tmp/example.bpmn and /tmp/example.svg
```

Each of them is run through the pipeline by `scripts/bpmn/roles-and-systems-guide.test.js`, which
checks that it produces valid BPMN with no layout error — so the examples cannot silently rot.

| You want to see | Model it as | Section |
|---|---|---|
| Which department or role does each step | one pool, one lane per role | [1](#1-responsibility-lanes) |
| Which steps run automatically, in which system | an extra lane per system (Signavio style) | [2](#2-system-lanes) |
| A system as an outside party you exchange data with | a collapsed pool + message flows | [3](#3-systems-as-collapsed-pools) |
| What happens inside the system as well | an expanded pool of its own + message flows | [4](#4-systems-as-expanded-pools) |
| The facts only, without changing the picture | `role` / `system` on the activity | [5](#5-the-role-and-system-fields) |

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
documentation if the diagram leaves your team.

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

**Planned:** dedicated views that draw a model by these fields — lanes per role, lanes per system,
systems as pools — without changing the model. Until they exist, use sections 1–4.
