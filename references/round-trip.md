# Round-tripping existing BPMN files

Load this when the user supplies an existing `.bpmn` file — to edit it, re-layout it, or check it
against the rules. For an existing `.dmn` file, see `references/dmn.md` ("Importing a DMN file").

## Workflow

```
existing .bpmn
   ↓  node bpmn/import.js     parse XML → nodes, edges, lanes, pools, message flows, artifacts
Logic-Core JSON
   ↓  amendment flow          you apply the requested changes, ids preserved (SKILL.md)
modified Logic-Core
   ↓  node bpmn/pipeline.js   validate (--strict), lay out, serialise
new .bpmn + .svg
```

Run from `scripts/`:

```bash
node bpmn/import.js existing-diagram.bpmn extracted.json   # file → file
cat existing-diagram.bpmn | node bpmn/import.js - extracted.json
node bpmn/pipeline.js extracted.json redrawn --strict      # re-validate and re-draw
```

Without an output path the Logic-Core is printed to stdout, mixed with status lines — pass an output
path when you want to process the JSON further.

## What is read

Processes, collaborations, lanes (including nested lanes), message flows, collapsed pools, gateways
with their direction, all task and event types with their markers and event-definition details,
boundary events, loop and multi-instance characteristics, subprocesses with their children,
data objects and data stores, text annotations and groups, associations, documentation, default and
conditional flows, top-level message/signal/error/escalation definitions, and the generator's own
extensions (`decisionRef`, `system`).

## What to expect

- **Layout is recomputed.** The importer reads semantics, not coordinates; the pipeline lays the
  diagram out again, so a re-drawn file looks different from the original even when nothing in the
  model changed.
- **Vendor extensions are lost on the way back.** Unknown attributes (`camunda:`, `zeebe:` …) are
  kept in the Logic-Core's `node.extensions`, but the writer emits no vendor namespace, so a re-drawn
  file no longer carries them. Tell the user before re-drawing an engine-configured file.
- **Strict run first.** A foreign file often violates style rules the generator enforces (task
  naming, unlabelled gateway branches). Run the pipeline with `--strict`, then tell the user which
  findings come from the original model before you change anything — fixing them is an amendment
  the user should agree to.
