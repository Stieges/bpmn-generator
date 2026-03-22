# Collaboration

2 Pools, 7 Message Flows


## Benutzer

| Element | Typ | Dokumentation |
|---------|-----|---------------|
| Prozessbedarf erkannt | startEvent | — |
| Prozess beschreiben | userTask | Der Benutzer erstellt eine natürlichsprachliche Prozessbeschreibung oder ein strukturiertes Logic-Core JSON. Eingabe über CLI, MCP-Server oder Orchestrator-API. |
| BPMN-Diagramm prüfen | userTask | Ergebnis enthält: BPMN 2.0 XML (.bpmn), SVG-Vorschau (.svg), Compliance-Report, Validierungs-Warnings und Agent-History. |
| Ergebnis akzeptabel? | exclusiveGateway | — |
| Beschreibung anpassen | userTask | Feedback einarbeiten: fehlende Schritte ergänzen, Rollen korrigieren, Gateways präzisieren. |
| Diagramm finalisiert | endEvent | — |

## BPMN Generator System

| Element | Typ | Dokumentation |
|---------|-----|---------------|
| Input empfangen | startEvent | Orchestrator empfängt Anfrage: entweder natürlichsprachlicher Text oder strukturiertes Logic-Core JSON. |
| Input-Typ? | exclusiveGateway | — |
| Logic-Core aus Text extrahieren | serviceTask | Modeler Agent im Extract-Modus: Baut LLM-Prompt mit System-Prompt (Logic-Core Schema + Regeln) + 5 Enterprise Few-Shot-Patterns aus references/prompt-template.md. Sendet an Claude API. Parst JSON-Antwort (auch aus Markdown-Codeblöcken). |
| Strukturelle Validierung durchführen | serviceTask | Reviewer Agent: Führt 22 Regeln in 4 Schichten aus. Soundness (S01-S11): Start/End-Events, Edge-Referenzen, Gateway-Balance, Boundary-Events. Style (M01-M08): Naming-Konventionen, Label-Vollständigkeit. Pragmatik (P01-P03): Komplexitätsmetriken. Workflow-Net (WF01-WF03): Petri-Net-Soundness. Profile konfigurierbar (default/strict). |
| Validierung bestanden? | exclusiveGateway | — |
| Max Iterationen erreicht? | exclusiveGateway | — |
| Logic-Core verfeinern | serviceTask | Modeler Agent im Refine-Modus: Sendet bisheriges Logic-Core + Review-Issues (Severity + Problem-Beschreibung) an LLM. Claude korrigiert strukturelle Fehler und gibt verbessertes JSON zurück. Max 3 Iterationen (konfigurierbar via maxReviewIterations). |
| Topologie inferieren | serviceTask | topology.js: inferGatewayDirections() bestimmt Diverging/Converging aus In/Out-Edge-Verhältnis. sortNodesTopologically() für deterministische Reihenfolge. orderLanesByFlow() ordnet Lanes nach Hauptflussrichtung. identifyHappyPathNodes() markiert den Happy Path. |
| ELK Sugiyama Layout berechnen | serviceTask | layout.js: logicCoreToElk() konvertiert Logic-Core in ELK-Graph. Nodes bekommen Dimensionen aus config.json. Events/Gateways: externe Label-Höhe. Start→FIRST, End→LAST Layer-Constraint. Lanes via elk.partitioning. Multi-Pool via rectpacking. runElkLayout(): Sugiyama hierarchisch, Direction RIGHT, ORTHOGONAL Routing, LAYER_SWEEP Crossing-Minimierung, NETWORK_SIMPLEX Node-Placement. |
| Koordinaten transformieren | serviceTask | coordinates.js — 10 Post-Processing-Phasen: §5.0 Lane-Bounds aus Node-Positionen, §5.0b Pool-Breitenausgleich, §5.0b2 Collapsed-Pool-Positionierung, §5.0c Happy-Path Y-Leveling, §5.0d Fan-Out Alignment, §5.0e Edge-Route-Compaction, §5.0f Cross-Lane Deconfliction, §5.1 Orthogonales Endpoint-Clipping, §5.2 Synthetisches Routing, §5.3 Force Orthogonal, §5.5 Zigzag-Cleanup. |
| BPMN 2.0 XML erzeugen | serviceTask | bpmn-xml.js via bpmn-moddle: Erzeugt typisierte CMOF-Objekte (moddle.create). Semantic Model: Definitions, Process, FlowNodes, SequenceFlows. Diagram Interchange: BPMNDiagram, BPMNPlane, BPMNShape mit Bounds, BPMNEdge mit Waypoints. incoming/outgoing-Referenzen (Industriekonvention). OMG BPMN 2.0.2 konform (ISO/IEC 19510:2013). |
| Round-Trip validieren | serviceTask | validateBpmnXml(): Parst erzeugtes XML zurück durch moddle.fromXML(). 0 Warnings = strukturell korrekt. Erkennt: fehlende Namespace-Deklarationen, ungültige Attribut-Typen, nicht auflösbare Referenzen, unbekannte Elemente. |
| SVG-Vorschau rendern | serviceTask | svg.js + icons.js: Standalone-SVG ohne externe Dependencies. Pools/Lanes mit rotiertem Header. Events mit Marker-Icons (Message, Timer, Error, Signal, Compensation, Link, Terminate). Gateways mit Marker (X, +, O, Pentagon). Tasks mit Type-Icon + Bottom-Markers (Loop, MI-Parallel, MI-Sequential, Ad-Hoc, Compensation). Edges mit Arrow-Markern. Text-Wrapping mit automatischem Zeilenumbruch. |
| OMG-Konformität prüfen | serviceTask | Compliance Agent: Prüft OMG BPMN 2.0.2 Konformität. Namespace-URIs (MODEL, DI, DC, DI), Pflicht-Attribute (id, targetNamespace), DI-Vollständigkeit (jeder FlowNode hat BPMNShape, jeder Flow hat BPMNEdge), Element-Typ-Mapping gegen OMG-Spezifikation. |
| Ergebnis zusammenstellen | serviceTask | Bündelt alle Artefakte: BPMN XML, SVG-Vorschau, Compliance-Report (errors/warnings/violations), Validierungs-Ergebnis (errors/warnings/xmlWarnings), History aller Agent-Aufrufe mit Timestamps. |
| Pipeline abgeschlossen | endEvent | — |