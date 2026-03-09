# Plan: BPMN Generator — Modularisierung + Regel-Engine + K5-K8 + DOT + Doku

## Context

**Ausgangslage:** pipeline.js ist ein 2566-LOC-Monolith. K1-K4 fertig (30/30 Tests grün). Validierung ist hartcodiert.

**Leitprinzip:** *"Irgendjemand macht das in Zukunft besser als wir"* — jeder Pipeline-Schritt unabhängig ersetzbar, konfigurierbar, testbar.

**Neue Anforderung:** Fachliches Regelwerk (3 Schichten: Soundness/Style/Pragmatik) als Plugin-System mit konfigurierbaren Severities. OMG-Compliance-Mapping als separates Dokument. Beides im bpmn-generator Repo.

## Reihenfolge

```
Phase 1: Modularisierung + Regel-Engine
  1.1  types.js + utils.js              (Blätter)
  1.2  rules.js + validate.js           (Regel-Engine + alle Checks)
  1.3  topology.js                      (Sortierung, Lanes)
  1.4  layout.js                        (ELK-Graphbau)
  1.5  coordinates.js                   (Koordinaten, Clipping)
  1.6  bpmn-xml.js                      (BPMN 2.0 XML)
  1.7  icons.js + svg.js                (SVG Rendering)
  1.8  pipeline.js → Orchestrator       (~150 LOC)
  1.9  Tests umstellen
       ── npm test nach JEDEM Commit ──

Phase 2: Regelwerk + Doku
  2.1  references/fachliches-regelwerk.md    (Fachliches Regelwerk ins Repo)
  2.2  references/omg-compliance.md          (OMG Spec → Code, Platzhalter)
  2.3  rules/default-profile.json            (Default-Regelprofil)

Phase 3: Features (K5-K8)
  3.1  K5  Few-Shot Patterns            (prompt-template.md)
  3.2  K6  Transaction SubProcess       (types + validate + layout + bpmn-xml + svg)
  3.3  K7  Pool-Breite Fix              (coordinates.js)
  3.4  K8  Kompatibilitätstest          (bpmn.io → COMPATIBILITY.md)
       ── Review-Zyklus ──

Phase 4: DOT-Support + Input-Format
  4.1  dot.js Export                    (logicCoreToDot)
  4.2  dot.js Import                    (dotToLogicCore)
  4.3  CLI-Integration                  (--format dot)
  4.4  Input-Schema                     (JSON Schema)

Phase 5: OMG-Compliance finalisieren
  5.1  omg-compliance.md Platzhalter füllen (stabile Zeilennummern)
       ── Final-Review ──
```

---

## Phase 1: Modularisierung + Regel-Engine

Jeder Commit = pure Extraktion + bei 1.2 Umbau der Validierung auf Rule-Engine. 30/30 Tests müssen nach jedem Commit grün sein.

### Modul-Architektur

```
pipeline.js (Orchestrator, ~150 LOC)
  ├── validate.js      ← rules.js, types.js
  ├── rules.js         ← (Rule-Definitionen, Profile-Loader)
  ├── topology.js      ← types.js
  ├── layout.js        ← types.js, utils.js, elkjs
  ├── coordinates.js   ← types.js, utils.js
  ├── bpmn-xml.js      ← types.js, utils.js
  ├── svg.js           ← types.js, utils.js, icons.js
  ├── icons.js         ← utils.js
  ├── import.js        (unverändert)
  └── dot.js           (neu, Phase 4)

types.js   ← (keine Deps)
utils.js   ← (keine Deps, nur config.json)
rules.js   ← types.js  (Rule-Registry + Built-in Rules)
```

### 1.1 — types.js + utils.js

**types.js** (~30 LOC): `isEvent`, `isGateway`, `isBoundaryEvent`, `isArtifact`, `isDataArtifact`, `bpmnXmlTag`

**utils.js** (~80 LOC): `loadConfig`, `CFG`, Konstanten, `esc`, `rn`, `wrapText`

### 1.2 — rules.js + validate.js (Regel-Engine)

**Kernkonzept:** Statt hartcodierter `if`-Ketten ein dynamisches Rule-Registry.

**rules.js** (~300 LOC) — neue Datei:
```javascript
// Regel-Definition
const RULES = [
  {
    id: 'S01', layer: 'soundness', defaultSeverity: 'ERROR',
    description: 'Jeder Prozess hat mindestens ein Start-Event',
    ref: { omg: '§10.4.2', pmg: 'G3' },
    check: (proc) => {
      const starts = proc.nodes.filter(n => n.type === 'startEvent');
      return starts.length >= 1
        ? { pass: true }
        : { pass: false, message: `Process '${proc.id}' has no startEvent` };
    }
  },
  // ... S01-S12, M01-M16, P01-P10 (38 Regeln)
];

// Profil-Loader
function loadRuleProfile(profilePath) { ... }

// Rule-Runner
function runRules(lc, profile) {
  const results = { errors: [], warnings: [], infos: [], metrics: {} };
  for (const rule of RULES) {
    if (!isEnabled(rule, profile)) continue;
    const severity = profile?.overrides?.[rule.id]?.severity || rule.defaultSeverity;
    // ... check + classify
  }
  return results;
}

export { RULES, loadRuleProfile, runRules };
```

**validate.js** (~100 LOC) — wird zum Thin Wrapper:
```javascript
import { runRules, loadRuleProfile } from './rules.js';

function validateLogicCore(lc, profilePath) {
  const profile = profilePath ? loadRuleProfile(profilePath) : null;
  return runRules(lc, profile);
}
```

**Migration:** Alle bestehenden Checks (S01, S02, S05, S07, S09 + K4-Checks) werden zu Rule-Objekten umgeschrieben. Verhalten identisch, aber jetzt konfigurierbar.

**Neue Regeln (noch nicht implementiert):** Als Platzhalter mit `check: () => ({ pass: true })` registrieren, damit die IDs reserviert sind.

### 1.3 — topology.js (~140 LOC)

`inferGatewayDirections`, `sortNodesTopologically`, `orderLanesByFlow`, `preprocessLogicCore`

### 1.4 — layout.js (~210 LOC)

`logicCoreToElk`, `build*Elk`, `buildElkNode`, `buildElkEdge`, `elkDefaults`, `runElkLayout`

### 1.5 — coordinates.js (~430 LOC)

`buildCoordinateMap`, `enforceOrthogonal`, `findNodeInAllProcesses`, `clipOrthogonal` + Varianten

### 1.6 — bpmn-xml.js (~470 LOC)

`generateBpmnXml`, `resolveMessageFlowRef`, `collectTopLevelDefinitions`, `getEventDefinitionXml`

### 1.7 — icons.js + svg.js

**icons.js** (~200 LOC): `renderEventMarker`, `inferEventMarker`, `renderTaskIcon`, `renderPentagon`

**svg.js** (~550 LOC): `generateSvg`, alle `render*`-Funktionen

### 1.8 — pipeline.js → Orchestrator (~150 LOC)

`runPipeline(logicCore, options)` — options enthält jetzt optional `ruleProfile`
Re-Export aller Module.

### 1.9 — Tests umstellen

- Imports auf direkte Module umstellen
- Neue Tests für Rule-Engine: Profil-Loading, Override-Severities, Layer-Deaktivierung
- Bestehende 30 Tests müssen unverändert grün bleiben

---

## Phase 2: Regelwerk + Doku

### 2.1 — Fachliches Regelwerk ins Repo

**Datei:** `references/fachliches-regelwerk.md`

Inhalt = das vom User bereitgestellte Dokument (BPMN-Fachliches-Regelwerk.md), angepasst:
- Code-Referenzen auf neue Modul-Dateien (`rules.js`, `validate.js`)
- Platzhalter für noch nicht implementierte Regeln markiert

### 2.2 — OMG-Compliance-Mapping

**Datei:** `references/omg-compliance.md`

Format:
```markdown
| OMG Section | Anforderung | Status | Datei:Zeile |
|-------------|-------------|--------|-------------|
| §7.1        | definitions xmlns | ✅ | bpmn-xml.js:L15 |
| §7.6.1      | Sequence Flow nur innerhalb Pool | ✅ | rules.js (S08) |
| §10.2.1     | laneSet als Kind von process | ✅ | bpmn-xml.js:L120 |
| §10.4.4     | Boundary Event Constraints | ✅ | rules.js (S10) |
| §10.5.1     | gatewayDirection Attribut | ✅ | topology.js:L1 |
| §12.1       | BPMNShape isExpanded | ✅ | bpmn-xml.js:L350 |
| §13.2.2     | Transaction semantics | 🔲 | Platzhalter (K6) |
| ...         | ...         | ...    | ...         |
```

Status: ✅ implementiert | 🔲 Platzhalter | ⚠️ teilweise

### 2.3 — Default-Regelprofil

**Datei:** `rules/default-profile.json`

```json
{
  "profile": "default",
  "version": "1.0",
  "layers": {
    "soundness": { "enabled": true },
    "style": { "enabled": true },
    "pragmatics": { "enabled": true }
  },
  "overrides": {}
}
```

Plus `rules/strict-profile.json` für regulierte Branchen.

---

## Phase 3: K5-K8

### 3.1 — K5: Few-Shot Enterprise Patterns

**Datei:** `references/prompt-template.md`
5 Patterns: Vier-Augen-Prinzip, Eskalation, Schleife, Compensation, Event SubProcess

### 3.2 — K6: Transaction Sub-Process

- `types.js`: `bpmnXmlTag` + Transaction
- `rules.js`: Neue Regeln für Transaction-Validierung
- `layout.js`: `buildElkNode` für Transaction
- `bpmn-xml.js`: `<transaction>` Tag
- `svg.js`: Doppelter Rahmen
- `import.js`: `<transaction>` parsen
- `omg-compliance.md`: §13.2.2 Platzhalter → ✅

### 3.3 — K7: Pool-Breite Fix

**Datei:** `coordinates.js`

### 3.4 — K8: Kompatibilitätstest

bpmn.io Validierung → `COMPATIBILITY.md`

### Review nach Phase 3

- `npm test` — alle Tests grün
- OMG-Checkliste (omg-compliance.md durchgehen)
- SVG visuell: Icons, Labels, Pool-Breiten
- bpmn.io: Alle .bpmn öffnen ohne Fehler
- Regel-Engine: Profile wechseln, Overrides testen

---

## Phase 4: DOT-Support + Input-Format

### 4.1 — dot.js Export (~100 LOC)

`logicCoreToDot(lc)`: Pools → subgraph, Nodes → labels+shapes, Edges → arrows

### 4.2 — dot.js Import (~150 LOC)

`dotToLogicCore(dotString)`: DOT-Subset Parser

### 4.3 — CLI-Integration

`--format dot`, `--import-dot`

### 4.4 — Input-Schema

**Datei:** `references/input-schema.json` — formales JSON Schema
Optional: Schema-Validierung als Regel S00 in rules.js

---

## Phase 5: OMG-Compliance finalisieren

### 5.1 — Platzhalter füllen

Nach Modularisierung + Features sind die Zeilennummern stabil.
`omg-compliance.md`: Alle 🔲 → ✅ mit finalen Datei:Zeile-Referenzen.

### Final-Review

- Dependency-Graph: azyklisch, jedes Modul einzeln testbar
- Regel-Engine: 38 Regeln registriert, Profile funktionieren
- DOT Round-Trip funktioniert
- OMG-Compliance: Alle Platzhalter gefüllt
- `npm test` grün, bpmn.io kompatibel

---

## Verifikation (nach jedem Commit)

```bash
cd ~/Projects/bpmn-generator/scripts
npm test
node pipeline.js tests/fixtures/simple-approval.json /tmp/test
```
