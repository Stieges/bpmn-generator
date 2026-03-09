# OMG BPMN 2.0.2 Compliance Mapping

Mapping von OMG BPMN 2.0.2 (formal/2013-12-09, ISO/IEC 19510:2013) Anforderungen auf unseren Code.

**Status-Legende:** Implementiert | Platzhalter | Teilweise

---

## Kapitel 7 — Infrastructure

| OMG Section | Anforderung | Status | Datei:Funktion |
|-------------|-------------|--------|----------------|
| §7.1 | definitions xmlns + targetNamespace | Implementiert | bpmn-xml.js:L20 (generateBpmnXml) |
| §7.2 | Association (sourceRef, targetRef, directed) | Implementiert | bpmn-xml.js:L244 |

## Kapitel 8 — Common Elements

| OMG Section | Anforderung | Status | Datei:Funktion |
|-------------|-------------|--------|----------------|
| §8.3.1 | Documentation auf FlowElements | Implementiert | bpmn-xml.js:generateBpmnXml |
| §8.4 | Top-Level Definitions (Message, Signal, Error, Escalation) | Implementiert | bpmn-xml.js:collectTopLevelDefinitions |

## Kapitel 9 — Collaboration

| OMG Section | Anforderung | Status | Datei:Funktion |
|-------------|-------------|--------|----------------|
| §9.2 | Collaboration element | Implementiert | bpmn-xml.js:generateBpmnXml |
| §9.3 | Participant (expanded + collapsed/black-box) | Implementiert | bpmn-xml.js:generateBpmnXml |
| §9.4 | Message Flow (nur cross-pool) | Implementiert | bpmn-xml.js:generateBpmnXml, rules.js:S09 |

## Kapitel 10 — Process

| OMG Section | Anforderung | Status | Datei:Funktion |
|-------------|-------------|--------|----------------|
| §10.2.1 | Process, SubProcess, laneSet als Kind von process | Implementiert | bpmn-xml.js:generateBpmnXml |
| §10.2.2 | Loop / Multi-Instance Characteristics | Implementiert | bpmn-xml.js:generateBpmnXml |
| §10.3.1 | Sequence Flow mit conditionExpression (child element) | Implementiert | bpmn-xml.js:generateBpmnXml |
| §10.3.1 | incoming/outgoing Referenzen auf FlowNodes | Implementiert | bpmn-xml.js:generateBpmnXml |
| §10.4.2 | Start Event (mind. 1 pro Prozess) | Implementiert | rules.js:S01 |
| §10.4.2 | End Event (mind. 1 pro Prozess) | Implementiert | rules.js:S02 |
| §10.4.4 | Boundary Event (attachedToRef, cancelActivity) | Implementiert | bpmn-xml.js:generateBpmnXml, rules.js:S08 |
| §10.5 | LaneSet (ein laneSet pro Process) | Implementiert | bpmn-xml.js:generateBpmnXml |
| §10.5.1 | gatewayDirection Attribut (Diverging/Converging/Mixed) | Implementiert | topology.js:inferGatewayDirections |
| §10.5.1 | Default Flow auf XOR/Inclusive-Gateway | Implementiert | bpmn-xml.js:generateBpmnXml |
| §10.5.1 | conditionExpression auf nicht-default Ausgaengen | Implementiert | bpmn-xml.js:generateBpmnXml |
| §10.6 | Data Objects, Data Stores | Implementiert | bpmn-xml.js:generateBpmnXml, svg.js:renderDataArtifact |

## Kapitel 12 — DI (Diagram Interchange)

| OMG Section | Anforderung | Status | Datei:Funktion |
|-------------|-------------|--------|----------------|
| §12.1 | BPMNShape (isHorizontal, isExpanded, isMarkerVisible) | Implementiert | bpmn-xml.js:generateBpmnXml |
| §12.1 | BPMNLabel Bounds fuer Events/Gateways | Implementiert | bpmn-xml.js:generateBpmnXml |
| §12.2 | BPMNEdge mit di:waypoint | Implementiert | bpmn-xml.js:generateBpmnXml |
| §12.2 | Edge Label Bounds | Implementiert | bpmn-xml.js:generateBpmnXml |

## Kapitel 13 — Extended Elements

| OMG Section | Anforderung | Status | Datei:Funktion |
|-------------|-------------|--------|----------------|
| §13.1 | Event Sub-Process (isEventSubProcess) | Implementiert | svg.js:renderActivity |
| §13.2.2 | Transaction SubProcess (doppelter Rahmen, Cancel) | Implementiert | types.js:L31, svg.js:L405 |

## Event-Definitionen (OMG Table 10.87)

| Event-Typ | Start | Intermediate Catch | Intermediate Throw | End | Boundary | Datei |
|-----------|-------|-------------------|-------------------|-----|----------|-------|
| Message | Implementiert | Implementiert | Implementiert | Implementiert | Implementiert | icons.js, bpmn-xml.js |
| Timer | Implementiert | Implementiert | — | — | Implementiert | icons.js, bpmn-xml.js |
| Error | — | — | — | Implementiert | Implementiert | icons.js, bpmn-xml.js |
| Signal | Implementiert | Implementiert | Implementiert | Implementiert | Implementiert | icons.js, bpmn-xml.js |
| Escalation | — | — | Implementiert | Implementiert | Implementiert | icons.js, bpmn-xml.js |
| Compensation | — | — | Implementiert | Implementiert | Implementiert | icons.js, bpmn-xml.js |
| Conditional | Implementiert | Implementiert | — | — | Implementiert | icons.js, bpmn-xml.js |
| Link | — | Implementiert | Implementiert | — | — | icons.js, bpmn-xml.js |
| Cancel | — | — | — | Implementiert | Implementiert | icons.js, bpmn-xml.js |
| Terminate | — | — | — | Implementiert | — | icons.js, bpmn-xml.js |

## Gateway-Typen (OMG §10.5)

| Gateway-Typ | Rendering | Direction | Validation | Datei |
|-------------|-----------|-----------|------------|-------|
| Exclusive (XOR) | Implementiert | Implementiert | S05 (Deadlock) | svg.js, topology.js, rules.js |
| Parallel (AND) | Implementiert | Implementiert | S05 (Join) | svg.js, topology.js |
| Inclusive (OR) | Implementiert | Implementiert | S06 (Deadlock) | svg.js, topology.js, rules.js |
| Event-Based | Implementiert | Implementiert | — | svg.js, topology.js |
| Complex | Implementiert | Implementiert | — | svg.js, topology.js |

## Activity-Typen (OMG §10.2)

| Activity-Typ | XML Tag | Icon | Marker | Datei |
|--------------|---------|------|--------|-------|
| Task | Implementiert | — | — | bpmn-xml.js, svg.js |
| User Task | Implementiert | Implementiert | — | icons.js |
| Service Task | Implementiert | Implementiert | — | icons.js |
| Script Task | Implementiert | Implementiert | — | icons.js |
| Send Task | Implementiert | Implementiert | — | icons.js |
| Receive Task | Implementiert | Implementiert | — | icons.js |
| Manual Task | Implementiert | Implementiert | — | icons.js |
| Business Rule Task | Implementiert | Implementiert | — | icons.js |
| Sub-Process | Implementiert | [+] Marker | Implementiert | svg.js |
| Expanded Sub-Process | Implementiert | Inline-Rendering | — | svg.js, bpmn-xml.js |
| Call Activity | Implementiert | Bold border | Implementiert | svg.js |
| Transaction | Implementiert | Double border | Implementiert | types.js:L31, svg.js:L405 |

## Bottom Markers (OMG §10.2.2)

| Marker | Status | Datei |
|--------|--------|-------|
| Standard Loop | Implementiert | icons.js:renderLoopMarker |
| MI Parallel | Implementiert | icons.js:renderMIParallelMarker |
| MI Sequential | Implementiert | icons.js:renderMISequentialMarker |
| Collapsed SubProcess [+] | Implementiert | icons.js:renderSubProcessMarker |
| Ad-Hoc ~ | Implementiert | icons.js:renderAdHocMarker |
| Compensation | Implementiert | icons.js:renderCompensationMarker |

---

## OMG 2.0.2 Compliance Sprint (Maerz 2026)

Folgende Gaps wurden im Compliance-Sprint geschlossen:

### Kategorie A — Semantische Attribute

| # | Gap | Status | Implementierung |
|---|-----|--------|-----------------|
| A1 | Timer-Ausdruecke (timeDate/timeDuration/timeCycle) | Geschlossen | bpmn-xml.js:getEventDefinitionXml, import.js:detectEventMarkerFull |
| A2 | Error/Signal/Message/Escalation-Definitionen (explizit) | Geschlossen | bpmn-xml.js:collectTopLevelDefinitions (akzeptiert definitions[]), import.js (Top-Level-Extraktion) |
| A3 | Conditional Expressions auf Sequence Flows | Bereits implementiert | bpmn-xml.js:generateBpmnXml |
| A4 | Script-Inhalt (scriptFormat + script) | Geschlossen | bpmn-xml.js (scriptFormat-Attr + script-Body), import.js (Extraktion) |
| A5 | Implementation-Attribute auf Service/Send/Receive Tasks | Geschlossen | bpmn-xml.js (implementation-Attr), import.js (non-default Extraktion) |
| A6 | Multi-Instance Details (loopCardinality, completionCondition) | Geschlossen | bpmn-xml.js (MI-Objekt mit Child-Elementen), import.js (Objekt-Extraktion), Schema: oneOf [string, object] |
| A7 | Documentation auf Nodes + Processes | Bereits implementiert | bpmn-xml.js:generateBpmnXml |
| A8 | isForCompensation auf Tasks | Geschlossen | bpmn-xml.js (isForCompensation-Attr), import.js (Extraktion) |
| A9 | Default Flow (isDefault + default-Attribut) | Bereits implementiert | bpmn-xml.js:generateBpmnXml |
| A10 | Loop-Characteristics (loopCondition, testBefore, loopMaximum) | Geschlossen | bpmn-xml.js (Loop-Objekt mit Child-Elementen), import.js (Objekt-Extraktion), Schema: oneOf [string, object] |
| A11 | Performer/Resources | Akzeptiert (out-of-scope) | Selten genutzt, Camunda nutzt Extensions |
| A12 | Data State | Akzeptiert (out-of-scope) | Selten genutzt |
| A13 | isCollection auf dataObjectReference | Geschlossen | bpmn-xml.js (isCollection-Attr), import.js (Extraktion) |

### Kategorie B — DI/Visual

Alle 6 DI-Gaps waren bereits substantiell geloest. Nur Polishing (Edge-Routing, Label-Positionierung).

### Kategorie C — Strukturelle Features

| # | Feature | Status | Implementierung |
|---|---------|--------|-----------------|
| C1 | Complex Gateway | Bereits implementiert | types.js, svg.js, topology.js |
| C2 | Transaction SubProcess | Bereits implementiert | types.js, svg.js, bpmn-xml.js |
| C3 | Compensation Handling | Teilweise | isForCompensation emittiert, compensation events implementiert |
| C4 | Ad-hoc SubProcess | Bereits implementiert | isAdHoc-Marker, svg.js |
| C5 | Event SubProcess (triggeredByEvent) | Geschlossen | bpmn-xml.js (triggeredByEvent-Attr), import.js (isEventSubProcess-Extraktion) |
| C6 | Non-interrupting Boundary Events | Bereits implementiert | cancelActivity=false |
| C7 | Link Events (name-Attribut) | Geschlossen | bpmn-xml.js (linkName auf linkEventDefinition), import.js (linkName-Extraktion) |
| C8 | Escalation Events | Bereits implementiert | icons.js, bpmn-xml.js |
| C9 | Conditional Events (condition-Body) | Geschlossen | bpmn-xml.js (condition Child-Element), import.js (conditionExpression-Extraktion) |
| C10 | Multiple Events | Bereits implementiert | icons.js (multiple/parallelMultiple) |

### Kategorie E — Import-Gaps

| # | Gap | Status | Implementierung |
|---|-----|--------|-----------------|
| E1 | calledElement auf CallActivity | Geschlossen | import.js + bpmn-xml.js |
| E2 | scriptFormat/script auf ScriptTask | Geschlossen | import.js + bpmn-xml.js |
| E3 | eventGatewayType/instantiate auf EventBasedGateway | Geschlossen | import.js + bpmn-xml.js |
| E4 | isForCompensation lesen | Geschlossen | import.js |
| E5 | isCollection lesen | Geschlossen | import.js |
| E6 | Nested Lanes (childLaneSet rekursiv) | Geschlossen | import.js:parseLanes (rekursiv), bpmn-xml.js:emitLane (rekursiver Export), Schema: Lane.children |
| E7 | Timer/Conditional/Link Event-Details lesen | Geschlossen | import.js:detectEventMarkerFull |

### Schema-Erweiterungen (input-schema.json)

Neue optionale Felder auf Node: `calledElement`, `scriptFormat`, `script`, `implementation`, `eventGatewayType`, `instantiate`, `linkName`, `conditionExpression`, `timerExpression` (Objekt). `loopType` und `multiInstance` akzeptieren jetzt sowohl String (backward-kompatibel) als auch Objekt (mit Execution-Details). Lane: `children` (rekursiv). SingleProcess/Collaboration: `definitions[]` (TopLevelDefinition).

---

## Noch offen

- Style-Regeln M05-M08 (Platzhalter in rules.js)
- Pragmatik-Regeln P02-P03 (Platzhalter in rules.js)
- bpmn-moddle als Export-Layer (langfristig — ersetzt bpmn-xml.js Template-Strings, ermoeglicht Camunda/Zeebe Extensions)

## bpmn-moddle Integration (Maerz 2026)

**Phase A: Import-Layer — abgeschlossen**

| Aenderung | Datei | Details |
|-----------|-------|---------|
| Dependency | package.json | bpmn-moddle ^9.0.1 (MIT, ~150KB mit Deps) |
| Adapter | moddle-import.js | moddleParse() + moddleToLogicCore() — ~200 LOC |
| Async Import | import.js | bpmnToLogicCore() async via moddle, Legacy-Fallback |
| Caller-Updates | mcp-bpmn-server.js, http-server.js, prepare-training-data.js | +await |
| Nested Lane Export Fix | bpmn-xml.js | emitLane() rekursiv mit childLaneSet |
| Extension Preservation | moddle-import.js | Unbekannte Attribute in node.extensions.$attrs |
| Schema | input-schema.json | Node.extensions (additionalProperties: true) |
| Tests | pipeline.test.js | +6 Tests (Moddle vs Legacy, Extensions, OMG Examples, Nested Lanes) |

**Phase B: Export-Layer — geplant**

- bpmn-moddle als XML-Serialisierer (ersetzt Template-Strings in bpmn-xml.js)
- camunda-bpmn-moddle + zeebe-bpmn-moddle fuer Camunda 7/8 Extensions
- Vollstaendige DI-Fidelity (Koordinaten direkt in moddle-Objektbaum)
