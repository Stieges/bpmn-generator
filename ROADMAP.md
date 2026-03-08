# BPMN Generator Skill — Roadmap & Aenderungsprotokoll

Version 3.0 | Stand: Maerz 2026 | adesso SE — Sovereign Knowledge Platform
Erstellt von: Daniel (Senior Consultant) + Claude

## 1 Aktueller Stand (v3.0)

Der BPMN Generator Skill konvertiert natuerliche Sprache in OMG-konforme BPMN 2.0 XML und SVG-Vorschau ueber eine 4-Phasen-Pipeline: Intent Extraction (LLM -> JSON Logic-Core) -> Validierung (Deadlock-Erkennung, strukturelle Soundness) -> ElkJS Auto-Layout (Sugiyama) -> BPMN XML + SVG Serialisierung.

### 1.1 Implementierte Features

| Feature | Details | Status |
|---------|---------|--------|
| Pipeline-Architektur | 4-Phasen: LLM->JSON->ELK->XML/SVG | Done |
| Flat Layout + Partitioning | Globales Sugiyama-Layout, Lanes als Constraints | Done |
| Topologische Sortierung | Nodes in Happy-Path-Reihenfolge, ELK Model Order | Done |
| Lane-Ordnung nach Fluss | Start-Lane oben, End-Lane unten | Done |
| Layer Constraints | StartEvent->FIRST, EndEvent->LAST | Done |
| Orthogonale Sequence Flows | 90-Grad Routing + Edge Clipping auf Shapes | Done |
| Multi-Pool Collaboration | Mehrere Participants + Message Flows | Done |
| Collapsed Pools (Black-Box) | Participant ohne processRef, 60px Band | Done |
| Deadlock-Erkennung | XOR-Split -> AND-Join Detection | Done |
| OMG XML Compliance | LaneSet, gatewayDirection, conditionExpr, incoming/outgoing, top-level defs, DI Label Bounds | Done |
| Round-Tripping (import.js) | BPMN XML -> Logic-Core JSON -> BPMN XML | Done |
| Inline-Modus (ElkJS CDN) | HTML-Artifact mit Browser-seitigem Layout | Done |
| Associations | Data Objects/Annotations via dotted lines | Done |
| Process Documentation | `<documentation>` auf Process/Nodes | Done |
| Method & Style Regeln | Bruce Silver Konventionen im Reviewer-Prompt | Done |

## 2 Kurzfristige Verbesserungen

Aufwand: je 1-4 Stunden | Umsetzbar in der naechsten Session

### K0 — Infrastruktur (vor K1-K8)

| # | Massnahme | Beschreibung | Impact |
|---|-----------|--------------|--------|
| K0a | Config-Externalisierung | Hardcoded Constants (SHAPE, SW, CLR, Gaps — 20+ Magic Numbers in Zeile 36-104) in ein `config.json` oder CONFIG-Objekt extrahieren. Ermoeglicht Anpassung ohne Code-Aenderung. Voraussetzung fuer Portabilitaet. | Wartbarkeit: hoch |
| K0b | module.exports | Pipeline-Funktionen (`validateLogicCore`, `generateBpmnXml`, `generateSvg`, `runLayout`) als Node.js-Module exportieren. Ermoeglicht programmatische Nutzung ohne CLI. Voraussetzung fuer L4 (A2A) und REST-API. | Portabilitaet: hoch |
| K0c | Unit Tests (Jest) | Test-Harness fuer kritische Funktionen: `clipOrthogonal()`, `enforceOrthogonal()`, `validateLogicCore()`, `sortNodesTopologically()`. Golden-File Tests (JSON->BPMN->Reimport->Vergleich). | Qualitaet: hoch |

### K1-K8 — Funktionale Verbesserungen

| # | Massnahme | Beschreibung | Impact |
|---|-----------|--------------|--------|
| K1 | SVG Icon Fidelity | Task-Typ-Icons (Service=Zahnraeder, User=Bueste, Script=Seite) durch echte bpmn-js PathMap-Pfade ersetzen statt geometrische Approximationen. Aktuell: 2 Kreise + Linie fuer Service-Task. Ziel: exakte Camunda-Modeler-Optik. | Visuell: hoch |
| K2 | Edge-Label Placement | Labels auf dem ersten horizontalen Segment nach dem Gateway platzieren, mit 5px Offset nach oben. Aktuell: am ersten Bendpoint, was bei vertikalen Segmenten Labels ueber andere Nodes legt. | Visuell: mittel |
| K3 | Expanded Sub-Processes | SubProcess-Nodes mit eigenen nodes/edges als Children. ELK behandelt sie als hierarchischen Graph. SVG: groesseres Rechteck (350x200) mit internem Flow. XML: `<subProcess>` mit eingebetteten Flow-Elementen. Kritisch fuer SDK-Prozesslandschaften. | Funktional: hoch |
| K4 | Validierung erweitern | Neue Checks: Inclusive-GW Deadlocks, Boundary-Event-Pfade ohne EndEvent, Loops ohne Exit, Merge-GW mit Labels (Method & Style Verstoss), Message-Flows innerhalb eines Pools (verboten). | Qualitaet: hoch |
| K5 | Few-Shot Enterprise Patterns | Prompt-Templates erweitern um: Vier-Augen-Prinzip, Eskalation ueber 3 Ebenen, Prozess mit optionalen Schleifen, Compensation Pattern, Event Sub-Process Pattern. Basierend auf Camunda-Referenzbeispielen. | LLM-Qualitaet: hoch |
| K6 | Transaction Sub-Process | Doppelter Rahmen, compensateEventDefinition, cancelEventDefinition. SVG: aeusserer + innerer Rahmen mit Dash-Pattern. XML: `<transaction>` statt `<subProcess>`. | Funktional: mittel |
| K7 | Pool-Breite an Content | Collapsed Pools sollen dieselbe Breite haben wie Expanded Pools. Aktuell korrekt bei Multi-Pool, aber bei Mixed (1 expanded + N collapsed) koennen Breiten abweichen. | Visuell: mittel |
| K8 | BPMN Tool Kompatibilitaetstest | Generierte .bpmn-Dateien systematisch in Camunda Modeler, ADONIS, Signavio und bpmn.io laden. Kompatibilitaetsmatrix erstellen. Bekannte Inkompatibilitaeten dokumentieren. | Vertrauen: hoch |

## 3 Mittelfristige Verbesserungen

Aufwand: je 1-3 Tage | Architektonische Entscheidungen noetig

| # | Massnahme | Beschreibung | Abhaengigkeiten |
|---|-----------|--------------|-----------------|
| M1 | Layout-Feedback-Loop (Agentic) | Nach ELK-Layout: SVG als Bild an einen zweiten LLM-Aufruf geben, der als Layout-Reviewer agiert. Prueft: Rueckfluesse, Lane-Ordnung, Label-Ueberlappungen. Gibt konkrete Aenderungsvorschlaege. 3-Agent-Pattern: Modeler -> Logic Reviewer -> Layout Reviewer. | Claude API, Bild-Analyse |
| M2 | Happy-Path Nivellierung | Deterministischer Post-Layout-Pass: alle Happy-Path-Nodes identifizieren, Y-Positionen innerhalb ihrer Lane auf gemeinsamen Median nivellieren. Nicht-Happy-Path-Nodes nach oben/unten. Erzeugt den 'handgemachten' Look. | Keine externen |
| M3 | Documentation View | Prozess-Dokumentation im SVG als Tooltips (title-Attribut), im HTML-Template als Klick-Popups. Begleitendes Markdown-Dokument mit Prozessbeschreibung + Dokumentations-Fragmenten pro Element. | Keine externen |
| M4 | Expanded SubProcess Drill-Down | Collapsed SubProcess als Link, der ein zweites SVG anzeigt. Im HTML-Inline-Template: Click-Handler zeigt internes Diagramm. Hierarchisches Modellieren (Bruce Silver Level 3). | K3 (Expanded SubProcess) |
| M5 | Process Mining Integration | Event-Logs (z.B. aus SDK EcoSphere) -> Process Discovery -> Logic-Core. Schliesst den Kreis zwischen Ist-Prozess und Soll-Modell. Alpha Miner oder Inductive Miner als Algorithmus. | PM4Py oder ProM |
| M6 | BPMN-in-Color Extension | bioc:stroke/bioc:fill Attribute fuer farbliche Kennzeichnung. Use Case: Happy Path gruen, Fehlerbehandlung rot, Eskalation gelb. Unterstuetzt von Camunda Modeler. | Keine externen |

## 4 Langfristige Verbesserungen (IWF-Integration)

Aufwand: Wochen-Monate | Forschungs- und Produktentwicklung | IWF-Roadmap

| # | Massnahme | Beschreibung | IWF-Bezug |
|---|-----------|--------------|-----------|
| L1 | Fine-tuned BPMN-SLM | Spezialisiertes 7-14B Modell (Qwen2.5 Coder Basis) trainiert auf MaD-Dataset + adesso-Prozessdaten. Uebernimmt Logic-Core-Extraktion. 6-11x schneller als General-Purpose-LLMs (Forschung: Soliman et al., Springer 2025). Laeuft lokal im IWF-Cluster. | IWF Post-Go-Live, Q1 2027 |
| L2 | POWL Validierungsschicht | Partially Ordered Workflow Language als mathematisch fundierte Verifikation. Logic-Core -> POWL -> Workflow-Net -> Soundness-Pruefung (Lebendigkeit, Beschraenktheit, tote Transitionen). Goldstandard der van-der-Aalst-Gruppe. Fuer regulierte Industrien ein Verkaufsargument. | IWF Security Block C |
| L3 | Multi-Agent BPMN Orchestration | CrewAI-basiert: Modeler-Agent (extrahiert Logic-Core) -> Reviewer-Agent (prueft Logik) -> Layout-Agent (optimiert Darstellung) -> Compliance-Agent (branchenspezifische Regeln). Iteriert bis alle Agents 'OK' sagen. | CrewAI POC Q4 2026 |
| L4 | A2A-Integration | BPMN-Skill als Agent im Agent-to-Agent-Protokoll. Confluence/Jira/EcoSphere senden Prozessbeschreibungen -> BPMN-Agent generiert Diagramm -> wird als Anhang zurueckgegeben. 'Process Documentation on Demand'. | A2A Pilot E11 |
| L5 | BPMN als AI-Orchestrierungssprache | Ad-Hoc-Subprozesse als Container fuer LLM-Entscheidungen (Camunda-Ansatz). BPMN-Skill generiert ausfuehrbare Prozessdefinitionen, AI Tasks werden von IWF-Agents ausgefuehrt. Deploy auf Camunda Zeebe. | IWF + Camunda |
| L6 | Description-to-DOT Alternative | Graphviz DOT als IR statt JSON: 6x weniger Tokens, 11x schneller bei komplexen Prozessen. Trade-off: keine native Lane-Semantik. Hybrid-Ansatz: DOT fuer Topologie, JSON fuer Lanes/Pools. Basierend auf Soliman et al. 2025. | Forschung |

## 5 Bekannte Limitierungen

| Limitation | Ursache | Loesung in |
|------------|---------|------------|
| Cross-Lane Rueckfluesse | Prozessinhaerente Rueckfluesse (z.B. Gutachter-Feedback) koennen nicht in eine gerade Linie gezwungen werden. ELK optimiert, aber die Topologie erzwingt den Rueckfluss. | M1 (Layout Feedback) |
| Edge-Crossing bei synthetischen Pfaden | Cross-Lane-Pfade koennen durch andere Elemente laufen. ElkJS loest Crossings intern, aber synthetische Pfade (fuer nicht-geroutete Edges) haben keine Kreuzungsvermeidung. | M2 (Nivellierung) |
| Expanded Sub-Processes fehlen | Nur collapsed [+] Marker. Keine Container mit internem Flow. Fuer hierarchische SDK-Prozesslandschaften benoetigt. | K3 |
| Transaction Sub-Process fehlt | Doppelter Rahmen, Compensation/Cancel-Events in Transactions nicht unterstuetzt. | K6 |
| Inline-Modus ohne Task-Icons | Das HTML-Inline-Template rendert vereinfachte Shapes (keine Gears, keine User-Bueste). Fuer volle Fidelity: Claude Code + pipeline.js. | K1 (Icon Fidelity) |
| Keine formale Soundness-Verifikation | Heuristische Deadlock-Erkennung statt mathematischem Beweis. Subtile Deadlocks (Inclusive-GW, verschachtelte Loops) koennen durchrutschen. | L2 (POWL) |

## 6 Forschungsreferenzen

- **Soliman et al. (2025):** "Size matters less: how fine-tuned small LLMs excel in BPMN generation". Springer JESIT. Description-to-DOT Pipeline, Qwen2.5 14B Coder Fine-Tuning, MaD Dataset.
- **Nour Eldin et al. (2026):** "Do LLMs Speak BPMN?" Evaluation Framework fuer LLM-basierte BPMN-Tools. 15 Qualitaetskriterien, 5 Tools evaluiert. 0% Pass-Rate bei complementary elements (Pools/Lanes).
- **Kourani et al. (2024/25):** POWL -> Workflow-Net -> BPMN Konversion. Van-der-Aalst-Gruppe. Mathematisch fundierte Prozesskorrektheit.
- **BPMN Assistant (2025):** JSON Logic-Core Ansatz. Modifikations-Erfolgsrate JSON vs XML: 50% vs 8%. Unsere Architektur-Basis.
- **Domroes et al. (2023):** "Model Order in Sugiyama Layouts". ELK-Forschung. Basis fuer unsere topologische Node-Sortierung.
- **Kasperowski et al. (2024):** "The Eclipse Layout Kernel". GD 2024. 140+ Layout-Optionen, Partitioning, Model Order, Constraint Resolving.
- **Bruce Silver:** "BPMN Method and Style, 2nd Edition". Style Rules fuer lesbare Modelle. Basis fuer unsere Naming Conventions und Reviewer-Prompts.
