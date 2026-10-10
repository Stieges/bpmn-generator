# Scenario Overview

_Happy path: DERIVED — no `isHappyPath` edge was declared; this is the shortest start→end path excluding boundary-event and backward (cycle) edges._

## Enumeration summary

- Scenarios enumerated: **2**, in 2 decision group(s).

**Notes — what the Petri-net translation structurally cannot see (no verdict):**

- 1 branch continuation(s) were not followed because the cycle bound (1) would have been exceeded. Those paths exist in the model; they were simply not explored — this is the bound working, not a defect.

## Approved?@Process_Main → Yes
- Scenario #0 — distance 0: Document submitted → Review document → Approved? → Approve document → Document approved

## Approved?@Process_Main → No; Approved?@Process_Main → Yes
- Scenario #1 — distance 1: Document submitted → Review document → Approved? → Revise document → Review document → Approved? → Approve document → Document approved
