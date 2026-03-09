# BPMN Generator Skill — Roadmap & Aenderungsprotokoll

Version 3.1 | Stand: Maerz 2026 | adesso SE — Sovereign Knowledge Platform
Erstellt von: Daniel (Senior Consultant) + Claude

## 1 Aktueller Stand (v3.1)

Der BPMN Generator Skill konvertiert natuerliche Sprache in OMG-konforme BPMN 2.0.2 XML (ISO/IEC 19510:2013) und SVG-Vorschau ueber eine 4-Phasen-Pipeline: Intent Extraction (LLM → JSON Logic-Core) → Validierung (22 Regeln, 3 Schichten) → ElkJS Auto-Layout (Sugiyama) → BPMN XML + SVG Serialisierung.

### 1.1 Implementierte Features

| Feature | Details | Status |
|---------|---------|--------|
| Pipeline-Architektur | 4-Phasen: LLM→JSON→ELK→XML/SVG | Done |
| Modulare Architektur | 13 ES-Module, azyklischer Dependency-Graph | Done |
| Regel-Engine | 25 Regeln in 4 Schichten (Soundness/Style/Pragmatik/Workflow-Net), konfigurierbare JSON-Profile | Done |
| Flat Layout + Partitioning | Globales Sugiyama-Layout, Lanes als Constraints | Done |
| Topologische Sortierung | Nodes in Happy-Path-Reihenfolge, ELK Model Order | Done |
| Lane-Ordnung nach Fluss | Start-Lane oben, End-Lane unten | Done |
| Layer Constraints | StartEvent→FIRST, EndEvent→LAST | Done |
| Orthogonale Sequence Flows | 90-Grad Routing + Edge Clipping auf Shapes | Done |
| Multi-Pool Collaboration | Mehrere Participants + Message Flows | Done |
| Collapsed Pools (Black-Box) | Participant ohne processRef, 60px Band | Done |
| Deadlock-Erkennung | XOR-Split → AND-Join + Inclusive-GW Detection | Done |
| OMG XML Compliance | LaneSet, gatewayDirection, conditionExpr, incoming/outgoing, top-level defs, DI Label Bounds | Done |
| Round-Tripping (import.js) | BPMN XML → Logic-Core JSON → BPMN XML | Done |
| Inline-Modus (ElkJS CDN) | HTML-Artifact mit Browser-seitigem Layout | Done |
| Associations | Data Objects/Annotations via dotted lines | Done |
| Process Documentation | `<documentation>` auf Process/Nodes | Done |
| Method & Style Regeln | Bruce Silver Konventionen im Reviewer-Prompt + Regel-Engine | Done |
| Expanded Sub-Processes | Container mit internem Flow, hierarchischer ELK-Graph | Done |
| Transaction Sub-Process | Doppelter Rahmen, `<transaction>` Tag, OMG §13.2.2 | Done |
| SVG Icon Fidelity | Echte bpmn-js PathMap-Pfade fuer alle Task-Typen | Done |
| DOT-Format | Graphviz Export + Import, CLI-Integration (--dot, --import-dot) | Done |
| Few-Shot Enterprise Patterns | 5 Patterns: Vier-Augen, Eskalation, Schleifen, Compensation, Event SubProcess | Done |
| Pool-Breite Equalisierung | Collapsed + Expanded Pools auf gleicher Breite | Done |
| bpmn.io Kompatibilitaet | Verifiziert, COMPATIBILITY.md dokumentiert | Done |
| OMG-Compliance-Mapping | Vollstaendiges Mapping OMG → Code in omg-compliance.md | Done |
| JSON Schema | Formales JSON Schema (draft 2020-12) fuer Logic-Core Input | Done |
| OMG 2.0.2 Execution Attributes | Timer, Script, MI/Loop Details, Definitions, Conditional/Link Events, calledElement, implementation | Done |
| Round-Trip Fidelity | Import + Export aller Execution-Attribute (25 OMG-Beispiele + 13 Unit Tests) | Done |
| bpmn-moddle Import | Standards-konformer BPMN-Parser via bpmn-moddle (CMOF-Deskriptoren, alle ~200 BPMN-Typen) | Done |
| Nested Lane Export | childLaneSet korrekt im XML, rekursive Lane-Emission | Done |
| Extension Attribute Preservation | Unbekannte Attribute (camunda:, zeebe:) ueberleben Round-Trip via extensions.$attrs | Done |

### 1.2 Modul-Architektur

```
scripts/
├── pipeline.js        Orchestrator + CLI (~180 LOC)
│   ├── validate.js    Validation Wrapper → rules.js
│   ├── rules.js       Regel-Engine (22 Regeln, 3 Schichten, Profile)
│   ├── topology.js    Gateway-Richtungen, topologische Sortierung, Lane-Ordnung
│   ├── layout.js      ELK-Graphbau + Layout-Ausfuehrung
│   ├── coordinates.js Koordinaten-Maps, Edge-Clipping, Pool-Equalisierung
│   ├── bpmn-xml.js    BPMN 2.0 XML-Generierung (DI, Top-Level Defs)
│   ├── svg.js         SVG-Rendering (Pools, Lanes, Activities, Events)
│   ├── icons.js       Event-Marker, Task-Icons, Bottom-Marker
│   ├── dot.js         DOT Export/Import (Graphviz)
│   ├── types.js       Typ-Praedikate, BPMN XML Tag Mapping
│   └── utils.js       Config-Loader, visuelle Konstanten, Hilfsfunktionen
├── import.js          BPMN XML → Logic-Core JSON (async, delegiert an moddle-import.js)
├── moddle-import.js   bpmn-moddle Adapter: fromXML() → Logic-Core JSON (~200 LOC)
├── orchestrator.js    Multi-Agent State Machine + CLI
├── agents/
│   ├── modeler.js     LLM-basiert: Text→JSON, Refine, Amend
│   ├── reviewer.js    Deterministisch: validateLogicCore() Wrapper
│   ├── layout.js      runPipeline() + optionaler Vision-Review
│   ├── compliance.js  Deterministisch: runRules() Gate
│   └── llm-provider.js OpenAI-kompatible Fetch-Abstraktion
├── mcp-bpmn-server.js MCP Server (4 Tools)
├── http-server.js     HTTP API (5 Endpoints)
├── config.json        Externalisierte Konstanten (Shapes, Farben, Abstaende)
├── workflow-net.js     Petri-Net Soundness Checker (WF01-WF03)
├── prepare-training-data.js  L1 Training Data ETL (BPMN→LC, Filter, JSONL)
├── evaluate-slm.js    L1 SLM Evaluation (Pipeline-basierte Metriken)
├── pipeline.test.js   85 Tests (Jest, ES Modules)
└── orchestrator.test.js 22 Tests (Agents + State Machine)
```

---

## 2 Kurzfristige Verbesserungen — ERLEDIGT

Alle K0-K8 Items sind implementiert.

| # | Massnahme | Status | Implementiert in |
|---|-----------|--------|------------------|
| K0a | Config-Externalisierung | Done | config.json, utils.js |
| K0b | ES Module Exports | Done | Alle 13 Module mit named exports |
| K0c | Unit Tests (Jest) | Done | pipeline.test.js (30 Tests) |
| K1 | SVG Icon Fidelity | Done | icons.js (echte PathMap-Pfade) |
| K2 | Edge-Label Placement | Done | coordinates.js |
| K3 | Expanded Sub-Processes | Done | layout.js, svg.js, bpmn-xml.js |
| K4 | Validierung erweitern | Done | rules.js (22 Regeln, 3 Schichten) |
| K5 | Few-Shot Enterprise Patterns | Done | references/prompt-template.md |
| K6 | Transaction Sub-Process | Done | types.js, svg.js, bpmn-xml.js, import.js |
| K7 | Pool-Breite an Content | Done | coordinates.js §5.0b |
| K8 | BPMN Tool Kompatibilitaetstest | Done | COMPATIBILITY.md |

---

## 3 Mittelfristige Verbesserungen — Bewertung

Stand: Maerz 2026. Jedes Item mit Bewertung, Begruendung und Empfehlung.

### M2 — Happy-Path Nivellierung | ERLEDIGT

Post-Layout-Pass: Happy-Path-Nodes per `identifyHappyPathNodes()` identifizieren, Y-Positionen innerhalb ihrer Lane auf gemeinsamen Median nivellieren. Opt-in via `config.json` (`happyPathLeveling: true`).

**Dateien:** coordinates.js (§5.0c), topology.js, config.json

### M3 — Documentation View | ERLEDIGT

SVG-Tooltips (`<title>` auf Nodes mit `documentation`) + Markdown-Companion-Dokument via `generateProcessDoc()` + CLI `--doc` Flag.

**Dateien:** svg.js (renderNode), pipeline.js (generateProcessDoc, --doc)

### M6 — BPMN-in-Color Extension | ERLEDIGT

bioc:stroke/bioc:fill Attribute auf BPMNShape-Elementen, per-node Farben im SVG-Rendering, Import von bioc-Attributen. Schema erweitert um `node.color: { stroke, fill }`.

**Dateien:** input-schema.json, bpmn-xml.js (biocAttrs + xmlns:bioc), svg.js (4 Render-Funktionen), import.js (bioc-Parsing)

### M1 — Layout-Feedback-Loop | GESTRICHEN

~~Nach ELK-Layout: SVG als Bild an einen zweiten LLM-Aufruf geben, der als Layout-Reviewer agiert.~~

**Begruendung:** M1 ist eine Teilmenge von L3 (Multi-Agent Orchestration). Der Layout-Reviewer ist ein Agent im Multi-Agent-System. Standalone wuerde M1 einen fragilen Vision-API→Koordinaten-Hack erfordern (SVG→PNG→Vision→Parse→ELK-Constraints). In L3 laeuft der Feedback-Loop strukturiert ueber JSON statt ueber Screenshot-Analyse. M1 separat bauen waere Doppelarbeit.

### M4 — Expanded SubProcess Drill-Down | ERLEDIGT

`generateDiagramSet()` erzeugt Parent-Diagramm (SubProcesses collapsed) + pro SubProcess ein eigenstaendiges Diagramm. CLI: `--drill-down` Flag. MCP: `generate_bpmn` mit `drillDown: true`. Navigation-Manifest mit Breadcrumbs. Rekursiv fuer verschachtelte SubProcesses.

**Dateien:** pipeline.js (+`generateDiagramSet`, `collapseSubProcesses`, `extractSubProcessAsLogicCore`), mcp-bpmn-server.js (+drillDown Option), pipeline.test.js (+7 Tests)

### M5 — Process Mining Integration | GESTRICHEN

~~Event-Logs → Process Discovery → Logic-Core.~~

**Begruendung:** Process Mining ist ein Pre-Processor (Event-Log → Variants → Logic-Core), nicht Teil des BPMN Generators. Die Pipeline konsumiert fertigen Logic-Core JSON — woher dieser kommt (LLM, Process Mining, manuell) ist nicht ihr Scope. Gehoert in iwf-knowledge oder ein eigenes Tool.

---

## 4 Langfristige Verbesserungen — Bewertung

### L4 — A2A/MCP-Integration | ERLEDIGT

MCP-Server mit 3 Tools: `generate_bpmn`, `validate_bpmn`, `import_bpmn`. Nutzt `@modelcontextprotocol/sdk`. Konfigurierbar via `claude_desktop_config.json`.

**Dateien:** scripts/mcp-bpmn-server.js (neu), package.json, README.md

### L6 — Description-to-DOT Alternative | ERLEDIGT

~~DOT als Intermediate Representation statt JSON.~~

**Begruendung:** dot.js Export + Import existiert vollstaendig. CLI-Integration (`--dot`, `--import-dot`) funktioniert. DOT-first-Extraction (LLM generiert DOT statt JSON) waere eine Optimierung innerhalb von L1 (Fine-tuned SLM), kein eigenstaendiges Item.

### L7 — Multi-User HTTP Service | ERLEDIGT

HTTP API Gateway (`http-server.js`) mit 4 Endpoints: generate, validate, import, health. Node.js native `http`, keine neuen Dependencies. Callback-Zustellung mit 3x Retry + Dead Letter (`delivery.js`). Append-only Audit-Log (`audit.js`, JSON Lines, nur Metadaten). Laeuft parallel zum MCP-Server (Stdio).

**Dateien:** scripts/http-server.js (neu), scripts/delivery.js (neu), scripts/audit.js (neu), README.md

### L3 — Multi-Agent BPMN Orchestration | ERLEDIGT

Lightweight Custom Orchestrator (kein CrewAI — Polyglot-Bruch vermieden). 4 Agents: Modeler (LLM) → Reviewer (deterministisch) → Layout (Pipeline + optionaler Vision-Review) → Compliance (deterministisch). State Machine mit Blackboard-Pattern, konfigurierbare Iterationslimits (Review: max 3, Layout: max 2). Dual-Mode: `orchestrate(text, {llmProvider})` fuer Text→BPMN oder `orchestrate(logicCoreJson)` fuer Review-only ohne LLM.

**Dateien:** scripts/orchestrator.js, scripts/agents/{modeler,reviewer,layout,compliance,llm-provider}.js, scripts/orchestrator.test.js (20 Tests). Integration: MCP-Server (+orchestrate_bpmn Tool), HTTP-API (+/api/v1/orchestrate Endpoint), CLI (--input/--text).

85 Tests gruen (63 Pipeline + 22 Orchestrator).

### L1 — Training Data Pipeline fuer BPMN-SLM | ERLEDIGT

Trainingsdaten-Aufbereitung fuer spezialisiertes BPMN-SLM: `prepare-training-data.js` konvertiert 3734 BPMN-Dateien (Research-Dataset EN/DE + IWF BPMNs) via import.js Round-Trip zu Logic-Core JSON, filtert nach Validierung + Compliance, und erzeugt JSONL fuer Instruction-Tuning. Eval-Script `evaluate-slm.js` validiert SLM-Output durch die Pipeline (Parse-Rate, Schema, Soundness, Compliance, Strukturtreue). LLM-Provider um Local-Inference-Modus erweitert (Ollama, llama.cpp, vLLM).

**Ergebnis:** 1897 valide Training-Samples (50.8% der 3734 BPMNs bestehen Validierung + Compliance). 80/10/10 Split: 1517 Train, 190 Val, 190 Test.

**Dateien:** scripts/prepare-training-data.js, scripts/evaluate-slm.js, scripts/agents/llm-provider.js (Local-Inference)

### L2 — Workflow-Net Soundness Checker | ERLEDIGT

Pure-JS Petri-Net-Verifikation (kein Python-Bridge): BPMN → Place/Transition-Net Konversion + BFS State-Space-Exploration. Prueft Liveness (WF01), 1-Boundedness (WF02), Proper Completion/Deadlock-Freiheit (WF03). Opt-in via `workflow_net` Layer in Rule-Profilen (strict-profile.json: aktiv, default-profile.json: deaktiviert). Behandelt implizite XOR-Merges (Tasks mit mehreren eingehenden Kanten) und XOR-Splits (N Choice-Transitions).

Scope: XOR + AND Gateways formalisiert. OR-Gateways → Info-Warnung. Event-Based Gateways + Timer/Signal Events → uebersprungen (nicht modellierbar in klassischen WF-Nets).

**Dateien:** scripts/workflow-net.js (~300 LOC), scripts/rules.js (+WORKFLOW_NET_RULES, Integration in runRules), rules/strict-profile.json, rules/default-profile.json, tests/fixtures/deadlock-process.json, pipeline.test.js (+7 WF-Tests)

### L5 — BPMN als AI-Orchestrierungssprache | ZURUECKGESTELLT

Ad-Hoc-Subprozesse als Container fuer LLM-Entscheidungen, Deploy auf Camunda Zeebe.

**Begruendung:** Erfordert Camunda Zeebe Infrastruktur + IWF Agent Registry. Kein bpmn-generator Feature, sondern IWF-Plattform-Integration. Zu frueh — erst relevant wenn IWF-Agents im Produktivbetrieb laufen.

---

## 5 Platzhalter-Regeln — Bewertung

6 registrierte Platzhalter in rules.js (`check: () => ({ pass: true })`):

### UMSETZEN

| Regel | Schicht | Beschreibung | Aufwand |
|-------|---------|-------------|---------|
| **M07** | Style (WARNING) | Vermeide OR-Gateways (inclusive) — Inclusive-GW-Nutzung als Warning | 10 LOC |
| **M08** | Style (WARNING) | Jeder XOR-Split hat einen Default-Flow | 15 LOC |
| **P02** | Pragmatik (INFO) | Gateway-Verschachtelungstiefe ≤ 3 (DFS mit Tiefenzaehler) | 30 LOC |
| **P03** | Pragmatik (INFO) | Control-Flow Complexity Score (Cardoso-Metrik: Σ XOR-Splits + 2^n AND-Splits) | 40 LOC |

### ZURUECKGESTELLT

| Regel | Schicht | Beschreibung | Begruendung |
|-------|---------|-------------|-------------|
| **M05** | Style (WARNING) | Message-Flow-Labels: nur Substantive | Erfordert POS-Tagger fuer deutsche Sprache (kein npm-Package verfuegbar). Fraglicher Nutzen da das LLM Labels bereits nach Prompt-Regeln generiert. |
| **M06** | Style (WARNING) | Event-Labels: Partizip/Zustand | Gleiche POS-Tagger-Problematik wie M05. Deutsche Komposita und Partizipkonstruktionen sind per Regex nicht zuverlaessig erkennbar. |

---

## 6 Implementierungsplan — ABGESCHLOSSEN

Alle 5 Phasen sind implementiert (Maerz 2026):

| Phase | Item | Status |
|-------|------|--------|
| 1 | Regeln M07, M08, P02, P03 | ERLEDIGT |
| 2 | M6 — BPMN-in-Color | ERLEDIGT |
| 3 | M3 — Documentation View | ERLEDIGT |
| 4 | M2 — Happy-Path Nivellierung | ERLEDIGT |
| 5 | L4 — MCP Server | ERLEDIGT |

30/30 Tests gruen nach allen Aenderungen.

---

## 7 Bekannte Limitierungen

| Limitation | Ursache | Loesung in |
|------------|---------|------------|
| Cross-Lane Rueckfluesse | Prozessinhaerente Rueckfluesse koennen nicht begradigt werden. ELK optimiert, aber Topologie erzwingt den Rueckfluss. | L3 Layout-Agent (Vision-Review opt-in) |
| Edge-Crossing bei synthetischen Pfaden | Synthetische Pfade (nicht ELK-geroutet) haben keine Kreuzungsvermeidung. | M2 (Nivellierung) |
| Inline-Modus ohne Task-Icons | HTML-Inline-Template rendert vereinfachte Shapes. Fuer volle Fidelity: pipeline.js. | — (by design) |
| Formale Soundness nur fuer XOR/AND | WF-Net-Check deckt XOR/AND-Gateways ab. OR-Gateways nur Warnung, Event-Based GW uebersprungen. | — (klassische WF-Net-Limitation) |
| Sprachanalyse-Regeln (M05/M06) | Deutsche Labels erfordern POS-Tagger — kein zuverlaessiges npm-Package verfuegbar. | — (zurueckgestellt) |

---

## 8 Forschungsreferenzen

- **Soliman et al. (2025):** "Size matters less: how fine-tuned small LLMs excel in BPMN generation". Springer JESIT. Description-to-DOT Pipeline, Qwen2.5 14B Coder Fine-Tuning, MaD Dataset.
- **Nour Eldin et al. (2026):** "Do LLMs Speak BPMN?" Evaluation Framework fuer LLM-basierte BPMN-Tools. 15 Qualitaetskriterien, 5 Tools evaluiert. 0% Pass-Rate bei complementary elements (Pools/Lanes).
- **Kourani et al. (2024/25):** POWL → Workflow-Net → BPMN Konversion. Van-der-Aalst-Gruppe. Mathematisch fundierte Prozesskorrektheit.
- **BPMN Assistant (2025):** JSON Logic-Core Ansatz. Modifikations-Erfolgsrate JSON vs XML: 50% vs 8%. Unsere Architektur-Basis.
- **Domroes et al. (2023):** "Model Order in Sugiyama Layouts". ELK-Forschung. Basis fuer unsere topologische Node-Sortierung.
- **Kasperowski et al. (2024):** "The Eclipse Layout Kernel". GD 2024. 140+ Layout-Optionen, Partitioning, Model Order, Constraint Resolving.
- **Bruce Silver:** "BPMN Method and Style, 2nd Edition". Style Rules fuer lesbare Modelle. Basis fuer unsere Naming Conventions und Reviewer-Prompts.
- **Cardoso (2005):** "How to Measure the Control-Flow Complexity of Web Processes and Workflows". Basis fuer CFC-Metrik (P03).
