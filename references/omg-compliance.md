# OMG BPMN 2.0.2 Compliance Mapping

Mapping of OMG BPMN 2.0.2 (formal/2013-12-09, ISO/IEC 19510:2013) requirements to our code.

**Status Legend:** Implemented | Placeholder | Partial

---

## Specification Sources

The normative OMG files live under `references/omg-spec/` and are **gitignored** — they are third-party
documents, not our source. Download them locally from the URLs below; nothing in the build depends on
their presence.

### BPMN 2.0.2 — `references/omg-spec/normative/`

Specification page: <https://www.omg.org/spec/BPMN/2.0.2/About-BPMN> (formal/2013-12-09, ISO/IEC 19510:2013)

| File | URL |
|------|-----|
| `Semantic.xsd` | <https://www.omg.org/spec/BPMN/20100501/Semantic.xsd> |
| `BPMNDI.xsd` | <https://www.omg.org/spec/BPMN/20100501/BPMNDI.xsd> |
| `DI.xsd` | <https://www.omg.org/spec/BPMN/20100501/DI.xsd> |
| `DC.xsd` | <https://www.omg.org/spec/BPMN/20100501/DC.xsd> |
| `BPMN20.xsd` | <https://www.omg.org/spec/BPMN/20100501/BPMN20.xsd> |
| Specification PDF | <https://www.omg.org/spec/BPMN/2.0.2/PDF> |

Provenance verified 2026-07-30: every URL above returns HTTP 200 with a byte count identical to the
corresponding local file (`Semantic.xsd` 62 507, `BPMNDI.xsd` 4 010, `DI.xsd` 3 470, `DC.xsd` 1 324,
`BPMN20.xsd` 1 941, PDF 7 296 515).

`Semantic.xsd` is the file to check first for any question about what an element may legally carry —
see the artifact-label fix (#36), which turned on `tArtifact` extending `tBaseElement` and therefore
having no `name`.

### DMN 1.3 — `references/omg-spec/normative/dmn/`

Retrieved 2026-07-30 for the feasibility analysis in
[2026-07-30-dmn-feasibility-design.md](../docs/superpowers/specs/2026-07-30-dmn-feasibility-design.md).
Nothing in this project implements DMN — these are reference material only. Keep them in the `dmn/`
subdirectory: the DMN `DI.xsd`/`DC.xsd` belong to a **different namespace** than the BPMN files of the
same name, and the schemas reference each other by relative `schemaLocation`.

Specification page: <https://www.omg.org/spec/DMN/1.3/About-DMN> (formal/21-01-01, February 2021)

| File | URL |
|------|-----|
| `DMN13.xsd` | <https://www.omg.org/spec/DMN/20191111/DMN13.xsd> |
| `DMNDI13.xsd` | <https://www.omg.org/spec/DMN/20191111/DMNDI13.xsd> |
| `DI.xsd` | <https://www.omg.org/spec/DMN/20180521/DI.xsd> |
| `DC.xsd` | <https://www.omg.org/spec/DMN/20180521/DC.xsd> |
| `DMN-1.3-spec.pdf` | <https://www.omg.org/spec/DMN/1.3/PDF> |

DMN 1.5 (August 2024) is the current formal version; 1.3 is what the tooling ecosystem implements —
the same standard-ahead-of-its-readers split as BPMN. Version index: <https://www.omg.org/spec/DMN>

---

## Chapter 7 — Infrastructure

| OMG Section | Requirement | Status | File:Function |
|-------------|------------|--------|---------------|
| §7.1 | definitions xmlns + targetNamespace | Implemented | bpmn-xml.js:L20 (generateBpmnXml) |
| §7.2 | Association (sourceRef, targetRef, directed) | Implemented | bpmn-xml.js:L244 |

## Chapter 8 — Common Elements

| OMG Section | Requirement | Status | File:Function |
|-------------|------------|--------|---------------|
| §8.3.1 | Documentation on FlowElements | Implemented | bpmn-xml.js:generateBpmnXml |
| §8.4 | Top-Level Definitions (Message, Signal, Error, Escalation) | Implemented | bpmn-xml.js:collectTopLevelDefinitions |

## Chapter 9 — Collaboration

| OMG Section | Requirement | Status | File:Function |
|-------------|------------|--------|---------------|
| §9.2 | Collaboration element | Implemented | bpmn-xml.js:generateBpmnXml |
| §9.3 | Participant (expanded + collapsed/black-box) | Implemented | bpmn-xml.js:generateBpmnXml |
| §9.4 | Message Flow (cross-pool only) | Implemented | bpmn-xml.js:generateBpmnXml, rules.js:S09 |

## Chapter 10 — Process

| OMG Section | Requirement | Status | File:Function |
|-------------|------------|--------|---------------|
| §10.2.1 | Process, SubProcess, laneSet as child of process | Implemented | bpmn-xml.js:generateBpmnXml |
| §10.2.2 | Loop / Multi-Instance Characteristics | Implemented | bpmn-xml.js:generateBpmnXml |
| §10.3.1 | Sequence Flow with conditionExpression (child element) | Implemented | bpmn-xml.js:generateBpmnXml |
| §10.3.1 | incoming/outgoing references on FlowNodes | Implemented | bpmn-xml.js:generateBpmnXml |
| §10.4.2 | Start Event (at least 1 per process) | Implemented | rules.js:S01 |
| §10.4.2 | End Event (at least 1 per process) | Implemented | rules.js:S02 |
| §10.4.4 | Boundary Event (attachedToRef, cancelActivity) — at every nesting level | Implemented | bpmn-xml.js:buildFlowNode, rules.js:S08, rules.js:S13 |
| §10.2.1 | SubProcess `flowElements` are content, `isExpanded` is presentation (DI only) | Implemented | bpmn-xml.js:buildFlowNode |
| §10.5 | LaneSet (one laneSet per Process) | Implemented | bpmn-xml.js:generateBpmnXml |
| §10.5.1 | gatewayDirection attribute (Diverging/Converging/Mixed) | Implemented | topology.js:inferGatewayDirections |
| §10.5.1 | Default Flow on XOR/Inclusive Gateway | Implemented | bpmn-xml.js:generateBpmnXml |
| §10.5.1 | conditionExpression on non-default outgoing flows | Implemented | bpmn-xml.js:generateBpmnXml |
| §10.6 | Data Objects, Data Stores | Implemented | bpmn-xml.js:generateBpmnXml, svg.js:renderDataArtifact |
| §10.7 | Artifacts in `<artifacts>`, not `<flowElements>` (tProcess sequence) | Implemented | bpmn-xml.js:buildProcess |
| §10.7.1 | Association (sourceRef, targetRef, associationDirection) | Implemented | bpmn-xml.js:generateBpmnXml |
| §10.7.2 | Group label via categoryValueRef → Category/CategoryValue | Implemented | bpmn-xml.js:buildCategoryForGroup |
| §10.7.3 | TextAnnotation content in a `<text>` child, not `name` | Implemented | bpmn-xml.js:buildNodeAttrs |

> Artifacts extend `tArtifact` → `tBaseElement`, which declares only `id`; `name` is introduced by
> `tFlowElement`. It is therefore illegal on TextAnnotation, Group and Association, and each keeps
> its label elsewhere — see `buildNodeAttrs`. bpmn-moddle accepts the unknown attribute silently
> (it lands in `$attrs` and is written back out), so this is not caught at write time; the guard is
> the round-trip warning surfaced via `validation.xmlWarnings`.

## Chapter 12 — DI (Diagram Interchange)

| OMG Section | Requirement | Status | File:Function |
|-------------|------------|--------|---------------|
| §12.1 | BPMNShape (isHorizontal, isExpanded, isMarkerVisible) | Implemented | bpmn-xml.js:generateBpmnXml |
| §12.1 | BPMNLabel Bounds for Events/Gateways | Implemented | bpmn-xml.js:generateBpmnXml |
| §12.2 | BPMNEdge with di:waypoint | Implemented | bpmn-xml.js:generateBpmnXml |
| §12.2 | Edge Label Bounds | Implemented | bpmn-xml.js:generateBpmnXml |

## Chapter 13 — Extended Elements

| OMG Section | Requirement | Status | File:Function |
|-------------|------------|--------|---------------|
| §13.1 | Event Sub-Process (isEventSubProcess) | Implemented | svg.js:renderActivity |
| §13.2.2 | Transaction SubProcess (double border, Cancel) | Implemented | types.js:L31, svg.js:L405 |

## Event Definitions (OMG Table 10.87)

| Event Type | Start | Intermediate Catch | Intermediate Throw | End | Boundary | File |
|------------|-------|-------------------|-------------------|-----|----------|------|
| Message | Implemented | Implemented | Implemented | Implemented | Implemented | icons.js, bpmn-xml.js |
| Timer | Implemented | Implemented | — | — | Implemented | icons.js, bpmn-xml.js |
| Error | — | — | — | Implemented | Implemented | icons.js, bpmn-xml.js |
| Signal | Implemented | Implemented | Implemented | Implemented | Implemented | icons.js, bpmn-xml.js |
| Escalation | — | — | Implemented | Implemented | Implemented | icons.js, bpmn-xml.js |
| Compensation | — | — | Implemented | Implemented | Implemented | icons.js, bpmn-xml.js |
| Conditional | Implemented | Implemented | — | — | Implemented | icons.js, bpmn-xml.js |
| Link | — | Implemented | Implemented | — | — | icons.js, bpmn-xml.js |
| Cancel | — | — | — | Implemented | Implemented | icons.js, bpmn-xml.js |
| Terminate | — | — | — | Implemented | — | icons.js, bpmn-xml.js |

## Gateway Types (OMG §10.5)

| Gateway Type | Rendering | Direction | Validation | File |
|--------------|-----------|-----------|------------|------|
| Exclusive (XOR) | Implemented | Implemented | S05 (Deadlock) | svg.js, topology.js, rules.js |
| Parallel (AND) | Implemented | Implemented | S05 (Join) | svg.js, topology.js |
| Inclusive (OR) | Implemented | Implemented | S06 (Deadlock) | svg.js, topology.js, rules.js |
| Event-Based | Implemented | Implemented | — | svg.js, topology.js |
| Complex | Implemented | Implemented | — | svg.js, topology.js |

## Activity Types (OMG §10.2)

| Activity Type | XML Tag | Icon | Marker | File |
|---------------|---------|------|--------|------|
| Task | Implemented | — | — | bpmn-xml.js, svg.js |
| User Task | Implemented | Implemented | — | icons.js |
| Service Task | Implemented | Implemented | — | icons.js |
| Script Task | Implemented | Implemented | — | icons.js |
| Send Task | Implemented | Implemented | — | icons.js |
| Receive Task | Implemented | Implemented | — | icons.js |
| Manual Task | Implemented | Implemented | — | icons.js |
| Business Rule Task | Implemented | Implemented | — | icons.js |
| Sub-Process | Implemented | [+] Marker | Implemented | svg.js |
| Expanded Sub-Process | Implemented | Inline Rendering | — | svg.js, bpmn-xml.js |
| Call Activity | Implemented | Bold border | Implemented | svg.js |
| Transaction | Implemented | Double border | Implemented | types.js:L31, svg.js:L405 |

## Bottom Markers (OMG §10.2.2)

| Marker | Status | File |
|--------|--------|------|
| Standard Loop | Implemented | icons.js:renderLoopMarker |
| MI Parallel | Implemented | icons.js:renderMIParallelMarker |
| MI Sequential | Implemented | icons.js:renderMISequentialMarker |
| Collapsed SubProcess [+] | Implemented | icons.js:renderSubProcessMarker |
| Ad-Hoc ~ | Implemented | icons.js:renderAdHocMarker |
| Compensation | Implemented | icons.js:renderCompensationMarker |

---

## OMG 2.0.2 Compliance Sprint (March 2026)

The following gaps were closed during the compliance sprint:

### Category A — Semantic Attributes

| # | Gap | Status | Implementation |
|---|-----|--------|----------------|
| A1 | Timer expressions (timeDate/timeDuration/timeCycle) | Closed | bpmn-xml.js:getEventDefinitionXml, import.js:detectEventMarkerFull |
| A2 | Error/Signal/Message/Escalation definitions (explicit) | Closed | bpmn-xml.js:collectTopLevelDefinitions (accepts definitions[]), import.js (top-level extraction) |
| A3 | Conditional Expressions on Sequence Flows | Already implemented | bpmn-xml.js:generateBpmnXml |
| A4 | Script content (scriptFormat + script) | Closed | bpmn-xml.js (scriptFormat attr + script body), import.js (extraction) |
| A5 | Implementation attributes on Service/Send/Receive Tasks | Closed | bpmn-xml.js (implementation attr), import.js (non-default extraction) |
| A6 | Multi-Instance details (loopCardinality, completionCondition) | Closed | bpmn-xml.js (MI object with child elements), import.js (object extraction), Schema: oneOf [string, object] |
| A7 | Documentation on Nodes + Processes | Already implemented | bpmn-xml.js:generateBpmnXml |
| A8 | isForCompensation on Tasks | Closed | bpmn-xml.js (isForCompensation attr), import.js (extraction) |
| A9 | Default Flow (isDefault + default attribute) | Already implemented | bpmn-xml.js:generateBpmnXml |
| A10 | Loop Characteristics (loopCondition, testBefore, loopMaximum) | Closed | bpmn-xml.js (loop object with child elements), import.js (object extraction), Schema: oneOf [string, object] |
| A11 | Performer/Resources | Accepted (out-of-scope) | Rarely used, Camunda uses extensions |
| A12 | Data State | Accepted (out-of-scope) | Rarely used |
| A13 | isCollection on dataObjectReference | Closed | bpmn-xml.js (isCollection attr), import.js (extraction) |

### Category B — DI/Visual

All 6 DI gaps were already substantially resolved. Only polishing (edge routing, label positioning).

### Category C — Structural Features

| # | Feature | Status | Implementation |
|---|---------|--------|----------------|
| C1 | Complex Gateway | Already implemented | types.js, svg.js, topology.js |
| C2 | Transaction SubProcess | Already implemented | types.js, svg.js, bpmn-xml.js |
| C3 | Compensation Handling | Partial | isForCompensation emitted, compensation events implemented |
| C4 | Ad-hoc SubProcess | Already implemented | isAdHoc marker, svg.js |
| C5 | Event SubProcess (triggeredByEvent) | Closed | bpmn-xml.js (triggeredByEvent attr), import.js (isEventSubProcess extraction) |
| C6 | Non-interrupting Boundary Events | Already implemented | cancelActivity=false |
| C7 | Link Events (name attribute) | Closed | bpmn-xml.js (linkName on linkEventDefinition), import.js (linkName extraction) |
| C8 | Escalation Events | Already implemented | icons.js, bpmn-xml.js |
| C9 | Conditional Events (condition body) | Closed | bpmn-xml.js (condition child element), import.js (conditionExpression extraction) |
| C10 | Multiple Events | Already implemented | icons.js (multiple/parallelMultiple) |

### Category E — Import Gaps

| # | Gap | Status | Implementation |
|---|-----|--------|----------------|
| E1 | calledElement on CallActivity | Closed | import.js + bpmn-xml.js |
| E2 | scriptFormat/script on ScriptTask | Closed | import.js + bpmn-xml.js |
| E3 | eventGatewayType/instantiate on EventBasedGateway | Closed | import.js + bpmn-xml.js |
| E4 | isForCompensation read | Closed | import.js |
| E5 | isCollection read | Closed | import.js |
| E6 | Nested Lanes (childLaneSet recursive) | Closed | import.js:parseLanes (recursive), bpmn-xml.js:emitLane (recursive export), Schema: Lane.children |
| E7 | Timer/Conditional/Link event details read | Closed | import.js:detectEventMarkerFull |

### Schema Extensions (input-schema.json)

New optional fields on Node: `calledElement`, `scriptFormat`, `script`, `implementation`, `eventGatewayType`, `instantiate`, `linkName`, `conditionExpression`, `timerExpression` (object). `loopType` and `multiInstance` now accept both string (backward-compatible) and object (with execution details). Lane: `children` (recursive). SingleProcess/Collaboration: `definitions[]` (TopLevelDefinition).

---

## Still Open

- Style rules M05-M08 (placeholders in rules.js)
- Pragmatics rules P02-P03 (placeholders in rules.js)
- bpmn-moddle as export layer (long-term — replaces bpmn-xml.js template strings, enables Camunda/Zeebe extensions)

## bpmn-moddle Integration (March 2026)

**Phase A: Import Layer — completed**

| Change | File | Details |
|--------|------|---------|
| Dependency | package.json | bpmn-moddle ^10.0.0 (MIT) |
| Adapter | moddle-import.js | moddleParse() + moddleToLogicCore() |
| Async Import | import.js | bpmnToLogicCore() async via moddle, legacy fallback |
| Caller Updates | mcp-bpmn-server.js, http-server.js, prepare-training-data.js | +await |
| Nested Lane Export Fix | bpmn-xml.js | emitLane() recursive with childLaneSet |
| Extension Preservation | moddle-import.js | Unknown attributes in node.extensions.$attrs |
| Schema | input-schema.json | Node.extensions (additionalProperties: true) |
| Tests | pipeline.test.js | +6 tests (moddle vs legacy, extensions, OMG examples, nested lanes) |

**Phase B: Export Layer — planned**

- bpmn-moddle as XML serializer (replaces template strings in bpmn-xml.js)
- camunda-bpmn-moddle + zeebe-bpmn-moddle for Camunda 7/8 extensions
- Full DI fidelity (coordinates directly in moddle object tree)
