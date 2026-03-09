# CLAUDE.md — BPMN Generator

## Projektkontext

Enterprise BPMN 2.0 Generator: JSON Logic-Core → Validation → ElkJS Layout → BPMN 2.0 XML + SVG.
OMG BPMN 2.0.2 konform (ISO/IEC 19510:2013). Kompatibel mit bpmn.io / Camunda Modeler.

Wird als Claude Code Skill eingesetzt (SKILL.md) — das LLM extrahiert Logic-Core JSON aus natürlicher Sprache, die Pipeline übernimmt Layout und Serialisierung. Das LLM berührt NIEMALS Koordinaten.

## Architektur

13 ES-Module unter `scripts/`, azyklischer Dependency-Graph:

```
pipeline.js (Orchestrator, ~180 LOC)
  ├── validate.js      ← rules.js
  ├── rules.js         ← types.js (22 Regeln, 3 Schichten, Profile)
  ├── topology.js      ← types.js
  ├── layout.js        ← types.js, utils.js, topology.js, elkjs
  ├── coordinates.js   ← types.js, utils.js
  ├── bpmn-xml.js      ← types.js, utils.js, topology.js, icons.js
  ├── svg.js           ← types.js, utils.js, icons.js
  ├── icons.js         ← utils.js
  ├── dot.js           ← types.js
  ├── types.js         (keine Deps)
  └── utils.js         (keine Deps, liest config.json)

import.js              BPMN XML → Logic-Core (eigenständig)
```

**Leitprinzip:** Jeder Pipeline-Schritt unabhängig ersetzbar, konfigurierbar, testbar.

## Wichtige Dateien

| Datei | Zweck |
|-------|-------|
| `scripts/pipeline.js` | Orchestrator + CLI + Public API (`runPipeline`) |
| `scripts/rules.js` | Rule Engine: 22 Regeln, 3 Schichten (Soundness/Style/Pragmatik) |
| `scripts/validate.js` | Thin Wrapper um `runRules()` |
| `scripts/types.js` | `isEvent`, `isGateway`, `isArtifact`, `bpmnXmlTag` |
| `scripts/utils.js` | `loadConfig`, `CFG`, Konstanten, `esc`, `wrapText` |
| `scripts/topology.js` | `inferGatewayDirections`, `sortNodesTopologically`, `orderLanesByFlow` |
| `scripts/layout.js` | `logicCoreToElk`, `runElkLayout` (ElkJS Sugiyama) |
| `scripts/coordinates.js` | `buildCoordinateMap`, `clipOrthogonal`, Pool-Breitenausgleich |
| `scripts/bpmn-xml.js` | `generateBpmnXml` — OMG-konformes BPMN 2.0 XML + DI |
| `scripts/svg.js` | `generateSvg` — SVG-Rendering aller BPMN-Elemente |
| `scripts/icons.js` | Event-Marker, Task-Icons, Bottom-Marker (Loop, MI, Ad-Hoc) |
| `scripts/dot.js` | `logicCoreToDot` / `dotToLogicCore` — Graphviz DOT Support |
| `scripts/import.js` | BPMN XML Parser → Logic-Core JSON |
| `scripts/config.json` | Externalisierte Konstanten (Shapes, Farben, Abstände) |
| `references/input-schema.json` | Formales JSON Schema für Logic-Core Input |
| `references/logic-core-schema.md` | Schema-Dokumentation (Prosa + Beispiele) |
| `references/prompt-template.md` | LLM-Prompts + 5 Enterprise Few-Shot Patterns |
| `references/fachliches-regelwerk.md` | Regel-Dokumentation (22 Regeln, Quellen, Erweiterungsanleitung) |
| `references/omg-compliance.md` | OMG BPMN 2.0.2 → Code-Mapping |
| `rules/default-profile.json` | Default-Regelprofil (alle Schichten aktiv) |
| `rules/strict-profile.json` | Striktes Profil (Style-Warnings → Errors) |

## Entwicklung

```bash
cd scripts/
npm install
npm test                                          # 30 Tests (Jest, ES Modules)
node pipeline.js tests/fixtures/simple-approval.json /tmp/test   # Smoke Test
```

Nach jeder Änderung: `npm test` muss 30/30 grün sein.

### Neuen Test hinzufügen

1. Fixture nach `tests/fixtures/` (JSON Logic-Core)
2. Test in `pipeline.test.js` (Jest, `import { ... } from './pipeline.js'`)
3. Für Golden-File-Tests: `.expected.bpmn` neben die Fixture legen

### Neue Regel hinzufügen

1. Regel-Objekt in `scripts/rules.js` → `RULES` Array einfügen
2. Felder: `id`, `layer`, `defaultSeverity`, `description`, `ref`, `check(proc)`
3. `check` gibt `{ pass: true }` oder `{ pass: false, message: '...' }` zurück
4. Dokumentation in `references/fachliches-regelwerk.md` ergänzen
5. Tests in `pipeline.test.js`

### Neues BPMN-Element hinzufügen

1. `types.js` — `bpmnXmlTag` Map erweitern, ggf. Typ-Prädikat
2. `layout.js` — `buildElkNode` für Layout-Dimensionen
3. `bpmn-xml.js` — XML-Serialisierung
4. `svg.js` — SVG-Rendering
5. `icons.js` — Falls Icon/Marker nötig
6. `import.js` — BPMN XML → Logic-Core Parsing
7. `references/omg-compliance.md` — OMG-Mapping aktualisieren
8. `references/input-schema.json` — Schema erweitern

## Regel-Engine

3 Schichten mit konfigurierbarer Severity:

| Schicht | Default-Severity | Regeln | Fokus |
|---------|-----------------|--------|-------|
| Soundness | ERROR | S01-S12 | Strukturelle Korrektheit (OMG-Konformität) |
| Style | WARNING | M01-M04 | Lesbarkeit (Bruce Silver Method & Style) |
| Pragmatics | INFO | P01 | Komplexitätsmetriken |

Profile in `rules/*.json` überschreiben Severities oder deaktivieren Schichten.

## Konventionen

- ES Modules (`import`/`export`) — kein CommonJS
- Keine externen Deps außer `elkjs` (+ `jest` dev)
- Config in `config.json`, nicht hardcoded
- Funktionen sind pure (kein globaler State außer `CFG`)
- IDs im Logic-Core: `^[a-zA-Z_][a-zA-Z0-9_-]*$`
- XML-Escaping über `esc()` aus `utils.js`
- Koordinaten immer als `{ x, y, width, height }` Objekte

## CLI

```bash
# Standard: JSON → BPMN + SVG
node pipeline.js input.json output-basename

# Stdin:
cat input.json | node pipeline.js - output

# Mit DOT-Export:
node pipeline.js input.json output --dot

# DOT → Logic-Core JSON:
node pipeline.js graph.dot output --import-dot

# BPMN → Logic-Core (Round-Trip):
node import.js existing.bpmn extracted.json

# Mit Dokumentations-Export:
node pipeline.js input.json output --doc

# MCP Server starten:
node mcp-bpmn-server.js
```

## Bekannte Limitierungen

- Regel-Platzhalter: M05-M06 (Style) sind registriert aber nicht implementiert (POS-Tagger-Problem)
- Keine Camunda-Extensions (`camunda:` Namespace)
- Timer-Events haben leere `<timerEventDefinition/>` (kein duration/cycle)
- DOT-Import ist ein Subset-Parser (nur Ausgabe von `logicCoreToDot` garantiert)
