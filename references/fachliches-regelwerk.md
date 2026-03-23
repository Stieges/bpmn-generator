# BPMN Fachliches Regelwerk

Konfigurierbare Validierungsregeln fuer BPMN-Prozesse. 4 Schichten, 26 Regeln (M05/M06 deaktiviert).

## Architektur

```
rules.js           → Regel-Definitionen + Runner
validate.js         → Thin Wrapper (public API)
rules/*.json        → Profile (Severity-Overrides, Layer-Deaktivierung)
```

**Erweiterbar:** Neue Regeln = neues Objekt im `RULES`-Array in `rules.js`.
**Konfigurierbar:** Profile ueberschreiben Severities oder deaktivieren ganze Layer.

## Quellen

| Kuerzel | Quelle |
|---------|--------|
| OMG | OMG BPMN 2.0.2 (formal/2013-12-09, ISO/IEC 19510:2013) |
| 7PMG | Seven Process Modeling Guidelines (Mendling/Reijers/van der Aalst, 2010) |
| Silver | Bruce Silver: BPMN Method & Style, 2nd Ed. |
| MG.org | modeling-guidelines.org |
| BEF4LLM | BEF4LLM (Kourani et al., 2025) |

---

## Schicht 1: Soundness (ERROR)

Strukturelle Korrektheit. Blockiert die Pipeline bei Verletzung.

| ID | Regel | Referenz | Status |
|----|-------|----------|--------|
| S01 | Jeder Prozess hat mindestens ein Start-Event | OMG §10.4.2, 7PMG G3 | implementiert |
| S02 | Jeder Prozess hat mindestens ein End-Event | OMG §10.4.2, 7PMG G3 | implementiert |
| S03 | Kanten referenzieren nur existierende Nodes (source/target) | OMG §10.3.1 | implementiert |
| S04 | Keine isolierten Nodes (ohne ein-/ausgehende Kante) | 7PMG G2 | implementiert |
| S05 | Kein Deadlock: XOR-Split darf nicht direkt/indirekt in AND-Join muenden | OMG §10.5.1, Silver Ch.5 | implementiert |
| S06 | Kein Deadlock: Inclusive-Split darf nicht direkt/indirekt in AND-Join muenden | OMG §10.5.1 | implementiert |
| S07 | Jeder Pfad vom Start muss ein End-Event erreichen koennen | 7PMG G1 | implementiert |
| S08 | Boundary-Event-Pfade muessen in End-Event terminieren | OMG §10.4.4, BEF4LLM | implementiert |
| S09 | Message Flows nur zwischen verschiedenen Pools | OMG §9.4 | implementiert |
| S10 | Message Flows: Quell- und Ziel-Nodes muessen existieren | OMG §9.4 | implementiert |
| S11 | SubProcess-Kinder: Start-Event + End-Event vorhanden | OMG §10.2.1 | implementiert |

## Schicht 2: Style (WARNING)

Modellierungsrichtlinien. Warnt, blockiert nicht.

| ID | Regel | Referenz | Status |
|----|-------|----------|--------|
| M01 | Tasks benennen mit Verb+Substantiv-Pattern | 7PMG G7, Silver Ch.3 | implementiert |
| M02 | Divergierende XOR-Gateways: Label als Frage formulieren | Silver Ch.5, MG.org | implementiert |
| M03 | Convergierende Gateways: kein Label an ausgehenden Kanten | Silver Ch.5 | implementiert |
| M04 | Divergierende XOR-Gateways: Kanten muessen Labels haben | Silver Ch.5, OMG §10.5.1 | implementiert |
| M05 | Prozessnamen mit Verb+Substantiv-Pattern | 7PMG G7 | Platzhalter |
| M06 | Keine doppelten Knotennamen im selben Prozess | 7PMG G6 | Platzhalter |
| M07 | Start-Events nur am Anfang (keine eingehenden Kanten) | OMG §10.4.2 | Platzhalter |
| M08 | End-Events nur am Ende (keine ausgehenden Kanten) | OMG §10.4.2 | Platzhalter |

## Schicht 3: Pragmatik (INFO)

Komplexitaetsmetriken und Hinweise.

| ID | Regel | Referenz | Status |
|----|-------|----------|--------|
| P01 | Modellgroesse: max. 30 Aktivitaeten pro Prozess | 7PMG G1 (30/50 Threshold), BEF4LLM | implementiert |
| P02 | Gateway-Fanout: max. 5 ausgehende Kanten pro Gateway | Silver Ch.5 | Platzhalter |
| P03 | Verschachtelungstiefe: max. 3 Ebenen | BEF4LLM | Platzhalter |

---

## Regel-Profile

Profile ueberschreiben Severities oder deaktivieren ganze Layer.

### Default-Profil (`rules/default-profile.json`)
Alle 3 Layer aktiv, keine Overrides.

### Strict-Profil (`rules/strict-profile.json`)
Fuer regulierte Branchen: Style-Warnungen werden zu Errors.

### Custom-Profil
```json
{
  "profile": "custom",
  "layers": {
    "soundness": { "enabled": true },
    "style": { "enabled": true },
    "pragmatics": { "enabled": false }
  },
  "overrides": {
    "M01": { "severity": "ERROR" },
    "S04": { "severity": "INFO" }
  }
}
```

---

## Regel-Objekt Schema

```javascript
{
  id: 'S01',                              // Eindeutige ID
  layer: 'soundness',                     // soundness | style | pragmatics
  defaultSeverity: 'ERROR',               // ERROR | WARNING | INFO
  scope: 'process',                       // process | global
  description: 'Jeder Prozess hat mindestens ein Start-Event',
  ref: { omg: '§10.4.2', pmg: 'G3' },    // Quellverweise
  check: (proc, lc, config) => {          // Prueffunktion
    const starts = (proc.nodes || []).filter(n => n.type === 'startEvent');
    return starts.length >= 1
      ? { pass: true }
      : { pass: false, message: `Process '${proc.id}' has no startEvent` };
  }
}
```

## Erweiterung

1. Neues Regel-Objekt in `RULES`-Array in `rules.js` einfuegen
2. `check`-Funktion implementieren (Platzhalter: `() => ({ pass: true })`)
3. Tests schreiben
4. OMG-Compliance-Mapping in `references/omg-compliance.md` aktualisieren
