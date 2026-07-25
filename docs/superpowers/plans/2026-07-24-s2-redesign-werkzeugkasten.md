# S2 — Redesign-Werkzeugkasten: Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Ein deterministischer Werkzeugkasten aus fünf benannten Prozess-Eingriffen, die ein
Logic-Core-Modell umbauen — ohne Sprachmodell, mit `preview`/`apply`-Trennung und Rollback-Garantie.

**Architecture:** Zwei neue Module. `redesign-core.js` trägt das Gemeinsame (profilunabhängiges
Validierungs-Gate, deterministische ID-Vergabe, Schutzlisten, Klonen). `redesign.js` enthält die fünf
Eingriffe, jeder mit `preview(lc, params)` und `apply(lc, params)`. Beide sind reine Funktionen und
importieren **nie** `agents/llm-provider.js`. Vorgelagert wird der Advisory-Vertrag von Texten auf
Objekte umgestellt, damit ein Eingriff überhaupt adressierbar ist.

**Tech Stack:** Node.js ≥18, ES Modules, Jest (`--experimental-vm-modules`). Keine neuen Dependencies.

**Quellen:** Anforderungs-Record [2026-07-24_soll-redesign-agent.md](../../anforderungen/2026-07-24_soll-redesign-agent.md)
(Reifegrad `formalized`, 15 Szenarien) · Design-Spec [2026-07-24-redesign-agent-design.md](../specs/2026-07-24-redesign-agent-design.md)

## Global Constraints

- **ES Modules only** — kein `require()`, kein CommonJS. Das Projekt ist `"type": "module"`.
- **Keine neuen Runtime-Dependencies.** Erlaubt sind nur die vorhandenen: `elkjs`, `bpmn-moddle`,
  `@modelcontextprotocol/sdk`, `ajv`, `ajv-formats`.
- **Der Kern bleibt sprachmodellfrei.** `redesign.js` und `redesign-core.js` dürfen
  `agents/llm-provider.js` weder direkt noch transitiv importieren.
- **Keine Mutation der Eingabe.** Jede `apply`-Funktion arbeitet auf einem tiefen Klon; das übergebene
  Modell bleibt unverändert.
- **Determinismus.** Gleiche Eingabe + gleiche Parameter ⇒ identisches Ergebnis, **einschließlich neu
  erzeugter IDs**. Kein `Math.random()`, kein Zeitstempel.
- **ID-Konvention:** `^[a-zA-Z_][a-zA-Z0-9_-]*$` (siehe `references/input-schema.json`).
- **Testlauf:** aus `scripts/`: `npm test`. Gezielt: `npm test -- --testPathPatterns=pipeline`.
- **Nach jeder Aufgabe muss `npm test` grün sein.** Golden-Dateien dürfen sich nicht ändern.
- **Kein `git add .`** — immer konkrete Pfade stagen.

---

## Dateistruktur

| Datei | Verantwortung |
|---|---|
| `scripts/redesign-core.js` | **neu** — Validierungs-Gate (profilunabhängig), deterministische IDs, Schutzlisten, Klonen, Änderungssatz-Form |
| `scripts/redesign.js` | **neu** — die fünf Eingriffe, je `preview` + `apply` |
| `scripts/optimize.js` | **ändern** — Advisories als Objekte mit `targets` + `transform` + `message` |
| `scripts/pipeline.js` | **ändern** — CLI-Ausgabe liest `.message`; später CLI-Zugang zum Werkzeugkasten |
| `scripts/mcp-bpmn-server.js` | **ändern** — nur Kommentar/Doku der Antwortform |
| `scripts/pipeline.test.js` | **ändern** — 5 Regex-Assertions auf Objektfelder migrieren |
| `scripts/redesign.test.js` | **neu** — Tests der Eingriffe |
| `references/api-reference.md`, `SKILL.md` | **ändern** — neue Advisory-Form dokumentieren |

---

### Task 1: Advisory-Vertrag auf Objekte umstellen

Fundament: Ohne maschinenlesbare `targets`/`transform` ist kein Eingriff adressierbar.
**Achtung — sechs bestehende Konsumenten** (GATE 2a §1): CLI-Ausgabe, fünf Test-Assertions, MCP-Antwort,
HTTP-Doku, SKILL.md. `message` ist deshalb **Pflichtfeld**.

**Files:**
- Modify: `scripts/optimize.js` (Rückgabeform der vier `check*`-Funktionen + `runOptimizationAnalysis`)
- Modify: `scripts/pipeline.js:388` (CLI-Ausgabe)
- Modify: `scripts/pipeline.test.js:2656-2734` (5 Assertions)
- Test: `scripts/pipeline.test.js`

**Interfaces:**
- Produces: `Advisory = { id, transform, targets: string[], message: string, tradeoff: object, ref: object, judgment: boolean }`
  — `id` ∈ `O01|O02|O03|O04`; `transform` ∈ `isolateException|reorderKnockouts|mergeTasks|parallelize|relane`;
  `targets` sind Knoten-IDs; `judgment: true` heißt „braucht Bestätigung, nicht mechanisch anwendbar".

- [ ] **Step 1: Failing test schreiben**

In `scripts/pipeline.test.js`, im Block `describe('Optimization Advisory (optimize mode)')`, ergänzen:

```javascript
  test('advisories sind Objekte mit message, transform und targets', () => {
    const r = runOpt(knockoutExc, 'optimize');
    expect(r.advisories.length).toBeGreaterThan(0);
    for (const a of r.advisories) {
      expect(typeof a).toBe('object');
      expect(typeof a.message).toBe('string');
      expect(a.message.length).toBeGreaterThan(0);
      expect(typeof a.id).toBe('string');
      expect(typeof a.transform).toBe('string');
      expect(Array.isArray(a.targets)).toBe(true);
      expect(typeof a.judgment).toBe('boolean');
    }
    const o01 = r.advisories.find(a => a.id === 'O01');
    expect(o01.transform).toBe('isolateException');
    expect(o01.targets.length).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd scripts && npm test -- --testPathPatterns=pipeline -t "advisories sind Objekte"`
Expected: FAIL — `expect(typeof a).toBe('object')` erhält `'string'`.

- [ ] **Step 3: `optimize.js` auf Objekte umstellen**

Die vier `check*`-Funktionen geben statt eines Strings ein Objekt zurück. Beispiel
`checkExceptionIsolation` — die Zeile `return \`${interleaved} Ausnahme-Enden ...\`;` wird zu:

```javascript
    return {
      id: 'O01',
      transform: 'isolateException',
      targets: excEndIds,
      message: `${interleaved} Ausnahme-Enden zweigen aus dem Hauptfluss ab — Exception-Isolation prüfen (Boundary-Event/Event-Subprocess statt inline) [Reijers 2005: exception]. Trade-off: Klarheit ↑.`,
      tradeoff: { quality: '+' },
      ref: { reijers: 'exception' },
      judgment: true,
    };
```

Dafür sammelt die Funktion die IDs mit (statt nur zu zählen): `const excEndIds = [];` und im Treffer-Zweig
`excEndIds.push(n.id); interleaved++;`.

Analog:
- `checkKnockoutOrdering` → `id: 'O02'`, `transform: 'reorderKnockouts'`, `targets` = die Gateway-IDs
  (Array `chainIds` statt Zähler `chain`), `tradeoff: { cost: '−' }`, `ref: { reijers: 'knock-out' }`,
  `judgment: true`.
- `checkHandoffs` → `id: 'O03'`, `transform: 'relane'`, `targets` = IDs der Zielknoten
  Lane-wechselnder Kanten, `tradeoff: { time: '−' }`, `ref: { reijers: 'task-composition', babok: '§10.34' }`,
  `judgment: true`.
- `checkParallelismCandidate` → `id: 'O04'`, `transform: 'parallelize'`, `targets` = `best` (die Kette),
  `tradeoff: { time: '−' }`, `ref: { reijers: 'parallelism' }`, `judgment: true`.

In `runOptimizationAnalysis` wird aus dem String-Präfix ein Feld:

```javascript
    for (const f of findings) advisories.push(lc.pools ? { ...f, pool: proc.name || proc.id } : f);
```

(die Zeile `for (const f of findings) advisories.push(prefix + f);` ersetzen; `prefix` entfällt).

- [ ] **Step 4: CLI-Ausgabe migrieren**

`scripts/pipeline.js:388` — statt der Objektdarstellung die Meldung ausgeben:

```javascript
    result.validation.advisories.forEach(a => console.log('  · ' + (a.pool ? `[${a.pool}] ` : '') + a.message));
```

Und die JSDoc-Zeile 53: `advisories: string[]` → `advisories: object[]`.

- [ ] **Step 5: Die fünf bestehenden Assertions migrieren**

In `scripts/pipeline.test.js` die Regex-Prüfungen auf Objektfelder umstellen:

```javascript
// Zeile ~2662 und ~2688:
    expect(r.advisories.some(a => a.id === 'O01')).toBe(true);
// Zeile ~2693:
    expect(r.advisories.some(a => a.id === 'O02')).toBe(true);
// Zeile ~2711:
    expect(r.advisories.some(a => a.id === 'O03')).toBe(true);
// Zeile ~2734:
    expect(r.advisories.some(a => a.id === 'O04')).toBe(true);
```

- [ ] **Step 6: Volle Suite grün**

Run: `cd scripts && npm test`
Expected: PASS, keine Golden-Änderung. `expect(r.advisories).toEqual([])` (document mode) und die
beiden `http-server.test.js`-Tests bleiben unverändert gültig.

- [ ] **Step 7: Commit**

```bash
git add scripts/optimize.js scripts/pipeline.js scripts/pipeline.test.js
git commit -m "feat(optimize): advisories als Objekte mit targets und transform

message bleibt Pflichtfeld, damit die CLI-Ausgabe lesbar bleibt. Fuenf
bestehende Test-Assertions auf Objektfelder migriert."
```

---

### Task 2: Fundament — `redesign-core.js`

**Files:**
- Create: `scripts/redesign-core.js`
- Test: `scripts/redesign.test.js` (neu)

**Interfaces:**
- Produces:
  - `cloneLc(lc): object` — tiefer Klon
  - `SOUNDNESS_GATE: object` — festes Profil, profilunabhängiges Rollback-Gate
  - `checkGate(lc): { ok: boolean, errors: string[], warnings: string[] }`
  - `nextId(lc, prefix): string` — deterministisch, kollisionsfrei
  - `collectIds(lc): Set<string>`
  - `isProtected(node, policy): boolean` — trifft über **ID und Name**
  - `refusal(reason): { feasible: 'none', scope: [], reason }`

- [ ] **Step 1: Failing tests schreiben**

Neue Datei `scripts/redesign.test.js`:

```javascript
import { describe, test, expect } from '@jest/globals';
import { cloneLc, checkGate, nextId, isProtected, refusal } from './redesign-core.js';

const lcMin = {
  id: 'P',
  nodes: [
    { id: 's', type: 'startEvent', lane: 'L' },
    { id: 't1', type: 'userTask', name: 'Antrag prüfen', lane: 'L' },
    { id: 'e', type: 'endEvent', lane: 'L' },
  ],
  edges: [
    { id: 'f1', source: 's', target: 't1' },
    { id: 'f2', source: 't1', target: 'e' },
  ],
  lanes: [{ id: 'L', name: 'Sachbearbeiter' }],
};

describe('redesign-core', () => {
  test('cloneLc liefert eine unabhaengige Kopie', () => {
    const copy = cloneLc(lcMin);
    copy.nodes[0].id = 'geaendert';
    expect(lcMin.nodes[0].id).toBe('s');
  });

  test('nextId ist deterministisch und kollisionsfrei', () => {
    const a = nextId(lcMin, 'gw_and');
    const b = nextId(lcMin, 'gw_and');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-zA-Z_][a-zA-Z0-9_-]*$/);
    const withA = { ...lcMin, nodes: [...lcMin.nodes, { id: a, type: 'parallelGateway' }] };
    expect(nextId(withA, 'gw_and')).not.toBe(a);
  });

  test('checkGate akzeptiert ein sauberes Modell', () => {
    const r = checkGate(lcMin);
    expect(r.ok).toBe(true);
  });

  test('checkGate lehnt ein Modell ohne endEvent ab', () => {
    const broken = { ...lcMin, nodes: lcMin.nodes.filter(n => n.type !== 'endEvent'),
                     edges: [{ id: 'f1', source: 's', target: 't1' }] };
    const r = checkGate(broken);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  test('checkGate laesst reine Stil-Verstoesse durch (profilunabhaengig)', () => {
    const styleIssue = { ...lcMin, nodes: lcMin.nodes.map(n => n.id === 't1' ? { ...n, name: 'Pruefung' } : n) };
    const r = checkGate(styleIssue);
    expect(r.ok).toBe(true);
  });

  test('isProtected trifft ueber Kennung und Anzeigenamen', () => {
    const node = { id: 't1', name: 'Antrag prüfen', lane: 'L' };
    expect(isProtected(node, { protectNodes: ['t1'] })).toBe(true);
    expect(isProtected(node, { protectNodes: ['Antrag prüfen'] })).toBe(true);
    expect(isProtected(node, { protectLanes: ['L'] })).toBe(true);
    expect(isProtected(node, { protectLanes: ['Sachbearbeiter'] }, lcMin)).toBe(true);
    expect(isProtected(node, { protectNodes: ['anderes'] })).toBe(false);
  });

  test('refusal liefert die vereinbarte Form', () => {
    const r = refusal('kein Grund');
    expect(r).toEqual({ feasible: 'none', scope: [], reason: 'kein Grund' });
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd scripts && npm test -- --testPathPatterns=redesign`
Expected: FAIL — `Cannot find module './redesign-core.js'`.

- [ ] **Step 3: `redesign-core.js` implementieren**

```javascript
/**
 * Redesign-Kern — Gemeinsames für alle Eingriffe.
 *
 * Rein deterministisch, ohne Sprachmodell. Dieses Modul darf
 * agents/llm-provider.js weder direkt noch transitiv importieren.
 */

import { runRules } from './rules.js';

/** Tiefer Klon; die Eingabe eines Aufrufers wird nie mutiert. */
export function cloneLc(lc) {
  return JSON.parse(JSON.stringify(lc));
}

/**
 * Festes Rollback-Gate — bewusst PROFILUNABHÄNGIG.
 * Das Default-Profil hat die Workflow-Netz-Schicht aus, das strict-Profil macht
 * Stil-Regeln zu Fehlern. Beides würde das Rollback-Verhalten vom Nutzerprofil
 * abhängig machen und die Determinismus-Zusage brechen.
 */
export const SOUNDNESS_GATE = {
  profile: 'redesign-gate',
  layers: {
    soundness:    { enabled: true },
    workflow_net: { enabled: true },
    style:        { enabled: false },
    pragmatics:   { enabled: false },
    optimization: { enabled: false },
  },
};

/** Prüft ein Modell gegen das feste Gate. Stil-Verstöße blockieren nie. */
export function checkGate(lc) {
  const r = runRules(lc, SOUNDNESS_GATE);
  return { ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings };
}

/** Alle vergebenen Knoten-, Kanten- und Lane-IDs. */
export function collectIds(lc) {
  const ids = new Set();
  const procs = lc.pools ? lc.pools : [lc];
  for (const p of procs) {
    for (const n of (p.nodes || [])) ids.add(n.id);
    for (const e of (p.edges || [])) ids.add(e.id);
    for (const l of (p.lanes || [])) ids.add(l.id);
  }
  for (const mf of (lc.messageFlows || [])) ids.add(mf.id);
  return ids;
}

/**
 * Deterministische, kollisionsfreie ID: <prefix> bzw. <prefix>_2, _3, …
 * Kein Zufall, kein Zeitstempel — sonst faellt die Determinismus-Zusage.
 */
export function nextId(lc, prefix) {
  const ids = collectIds(lc);
  if (!ids.has(prefix)) return prefix;
  let i = 2;
  while (ids.has(`${prefix}_${i}`)) i++;
  return `${prefix}_${i}`;
}

/**
 * Schutzliste. Trifft über Kennung UND Anzeigenamen — eine Lane per Name zu
 * schuetzen darf nicht wirkungslos verpuffen, nur weil intern eine ID steht.
 */
export function isProtected(node, policy = {}, lc = null) {
  const nodes = policy.protectNodes || [];
  const lanes = policy.protectLanes || [];
  if (nodes.includes(node.id) || (node.name && nodes.includes(node.name))) return true;
  if (node.lane && lanes.includes(node.lane)) return true;
  if (node.lane && lc) {
    const procs = lc.pools ? lc.pools : [lc];
    for (const p of procs) {
      const lane = (p.lanes || []).find(l => l.id === node.lane);
      if (lane && lane.name && lanes.includes(lane.name)) return true;
    }
  }
  return false;
}

/** Einheitliche Verweigerungsform für preview(). */
export function refusal(reason) {
  return { feasible: 'none', scope: [], reason };
}
```

- [ ] **Step 4: Tests grün**

Run: `cd scripts && npm test -- --testPathPatterns=redesign`
Expected: PASS (7 Tests).

- [ ] **Step 5: Sprachmodellfreiheit als Inspektion prüfen**

Run: `cd scripts && grep -rn "llm-provider" redesign-core.js || echo "OK: kein LLM-Import"`
Expected: `OK: kein LLM-Import`

- [ ] **Step 6: Commit**

```bash
git add scripts/redesign-core.js scripts/redesign.test.js
git commit -m "feat(redesign): Fundament — profilunabhaengiges Gate, deterministische IDs, Schutzlisten

Das Rollback-Gate ist bewusst profilunabhaengig: Default-Profil hat die
Workflow-Netz-Schicht aus, strict-Profil macht Stil zu Fehlern. Schutzlisten
treffen ueber Kennung UND Anzeigenamen."
```

---

### Task 3: Eingriff „Nebeneinanderlegen" (`parallelize`)

**Files:**
- Create: `scripts/redesign.js`
- Test: `scripts/redesign.test.js` (erweitern)

**Interfaces:**
- Consumes: `cloneLc`, `checkGate`, `nextId`, `isProtected`, `refusal` aus `redesign-core.js`
- Produces:
  - `previewParallelize(lc, { nodeIds, policy }): { feasible, scope, reason }`
  - `applyParallelize(lc, { nodeIds, policy }): { lc, change, warnings }`
  - `change = { transform, targets, added: string[], removed: string[], note }`

- [ ] **Step 1: Failing tests schreiben**

An `scripts/redesign.test.js` anhängen:

```javascript
import { previewParallelize, applyParallelize } from './redesign.js';

const lcChain = {
  id: 'P',
  nodes: [
    { id: 's', type: 'startEvent', lane: 'L' },
    { id: 'a', type: 'userTask', name: 'Adresse prüfen', lane: 'L' },
    { id: 'b', type: 'userTask', name: 'Telefon prüfen', lane: 'L' },
    { id: 'c', type: 'userTask', name: 'E-Mail prüfen', lane: 'L' },
    { id: 'e', type: 'endEvent', lane: 'L' },
  ],
  edges: [
    { id: 'f0', source: 's', target: 'a' },
    { id: 'f1', source: 'a', target: 'b' },
    { id: 'f2', source: 'b', target: 'c' },
    { id: 'f3', source: 'c', target: 'e' },
  ],
  lanes: [{ id: 'L', name: 'Sachbearbeiter' }],
};

describe('parallelize', () => {
  test('preview meldet Machbarkeit fuer eine lineare Kette', () => {
    const r = previewParallelize(lcChain, { nodeIds: ['a', 'b', 'c'] });
    expect(r.feasible).toBe('full');
    expect(r.scope).toEqual(['a', 'b', 'c']);
  });

  test('preview verweigert bei unbekannter Kennung', () => {
    const r = previewParallelize(lcChain, { nodeIds: ['a', 'gibtsnicht'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/unbekannt/i);
  });

  test('preview verweigert bei geschuetztem Element ueber den Anzeigenamen', () => {
    const r = previewParallelize(lcChain, { nodeIds: ['a', 'b', 'c'],
                                            policy: { protectLanes: ['Sachbearbeiter'] } });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/geschützt/i);
  });

  test('preview verweigert bei nicht zusammenhaengender Kette', () => {
    const r = previewParallelize(lcChain, { nodeIds: ['a', 'c'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/zusammenhäng/i);
  });

  test('apply erzeugt AND-Split und AND-Join und bleibt sound', () => {
    const r = applyParallelize(lcChain, { nodeIds: ['a', 'b', 'c'] });
    const types = r.lc.nodes.filter(n => n.type === 'parallelGateway');
    expect(types.length).toBe(2);
    expect(checkGate(r.lc).ok).toBe(true);
    expect(r.change.transform).toBe('parallelize');
    expect(r.change.added.length).toBe(2);
  });

  test('apply mutiert die Eingabe nicht', () => {
    const before = JSON.stringify(lcChain);
    applyParallelize(lcChain, { nodeIds: ['a', 'b', 'c'] });
    expect(JSON.stringify(lcChain)).toBe(before);
  });

  test('apply ist deterministisch, auch bei den neuen Kennungen', () => {
    const r1 = applyParallelize(lcChain, { nodeIds: ['a', 'b', 'c'] });
    const r2 = applyParallelize(lcChain, { nodeIds: ['a', 'b', 'c'] });
    expect(JSON.stringify(r1.lc)).toBe(JSON.stringify(r2.lc));
  });

  test('apply veraendert nur das Beabsichtigte', () => {
    const r = applyParallelize(lcChain, { nodeIds: ['a', 'b', 'c'] });
    const startBefore = lcChain.nodes.find(n => n.id === 's');
    const startAfter = r.lc.nodes.find(n => n.id === 's');
    expect(startAfter).toEqual(startBefore);
    expect(r.lc.lanes).toEqual(lcChain.lanes);
  });

  test('apply verweigert, wenn preview nicht machbar meldet', () => {
    expect(() => applyParallelize(lcChain, { nodeIds: ['a', 'c'] })).toThrow(/zusammenhäng/i);
  });
});
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd scripts && npm test -- --testPathPatterns=redesign`
Expected: FAIL — `Cannot find module './redesign.js'`.

- [ ] **Step 3: `redesign.js` mit `parallelize` implementieren**

```javascript
/**
 * Redesign-Werkzeugkasten — benannte Prozess-Eingriffe.
 *
 * Jeder Eingriff hat zwei Funktionen:
 *   preview(lc, params) → { feasible: 'full'|'partial'|'none', scope, reason }
 *   apply(lc, params)   → { lc, change, warnings }
 *
 * Rein deterministisch, ohne Sprachmodell. Der Werkzeugkasten entscheidet nie,
 * OB ein Eingriff gemacht wird — das tut der Aufrufer.
 */

import { cloneLc, checkGate, nextId, isProtected, refusal } from './redesign-core.js';

const procOf = (lc) => (lc.pools ? lc.pools[0] : lc);

function findNodes(proc, ids) {
  const map = {};
  for (const n of (proc.nodes || [])) map[n.id] = n;
  return ids.map(id => map[id]);
}

/** Ist ids eine zusammenhängende, lineare Kette (jeweils genau eine Kante)? */
function isLinearChain(proc, ids) {
  const edges = proc.edges || [];
  for (let i = 0; i < ids.length - 1; i++) {
    const between = edges.filter(e => e.source === ids[i] && e.target === ids[i + 1]);
    if (between.length !== 1) return false;
    const outs = edges.filter(e => e.source === ids[i]);
    if (outs.length !== 1) return false;
  }
  return true;
}

export function previewParallelize(lc, { nodeIds = [], policy = {} } = {}) {
  const proc = procOf(lc);
  if (nodeIds.length < 2) return refusal('Mindestens zwei Schritte nötig.');
  const nodes = findNodes(proc, nodeIds);
  const missing = nodeIds.filter((id, i) => !nodes[i]);
  if (missing.length) return refusal(`Unbekannte Kennung: ${missing.join(', ')}`);
  const prot = nodes.filter(n => isProtected(n, policy, lc));
  if (prot.length) return refusal(`Geschütztes Element betroffen: ${prot.map(n => n.id).join(', ')}`);
  if (!isLinearChain(proc, nodeIds)) return refusal('Die Schritte bilden keine zusammenhängende Kette.');
  return { feasible: 'full', scope: [...nodeIds], reason: '' };
}

export function applyParallelize(lc, params = {}) {
  const pv = previewParallelize(lc, params);
  if (pv.feasible === 'none') throw new Error(pv.reason);

  const out = cloneLc(lc);
  const proc = procOf(out);
  const ids = pv.scope;
  const first = ids[0], last = ids[ids.length - 1];
  const edges = proc.edges || [];

  const inEdge = edges.find(e => e.target === first);
  const outEdge = edges.find(e => e.source === last);
  const lane = (proc.nodes.find(n => n.id === first) || {}).lane;

  // Reihenfolge beachten: erst den Split anlegen, DANN den Join berechnen —
  // sonst kollidieren beide Kennungen bei gleichem Präfix.
  const splitId = nextId(out, 'gw_par_split');
  proc.nodes.push({ id: splitId, type: 'parallelGateway', name: '', lane });
  const joinId = nextId(out, 'gw_par_join');
  proc.nodes.push({ id: joinId, type: 'parallelGateway', name: '', lane, has_join: true });

  // Alte Kettenkanten entfernen
  const removed = [];
  for (let i = 0; i < ids.length - 1; i++) {
    const idx = edges.findIndex(e => e.source === ids[i] && e.target === ids[i + 1]);
    if (idx >= 0) removed.push(edges.splice(idx, 1)[0].id);
  }
  if (inEdge) inEdge.target = splitId;
  if (outEdge) outEdge.source = joinId;

  const added = [splitId, joinId];
  for (const id of ids) {
    const eIn = nextId(out, `flow_${splitId}_${id}`);
    edges.push({ id: eIn, source: splitId, target: id });
    const eOut = nextId(out, `flow_${id}_${joinId}`);
    edges.push({ id: eOut, source: id, target: joinId });
    added.push(eIn, eOut);
  }

  const gate = checkGate(out);
  if (!gate.ok) throw new Error(`Rollback: Ergebnis waere nicht sound — ${gate.errors.join('; ')}`);

  return {
    lc: out,
    change: { transform: 'parallelize', targets: ids, added, removed,
              note: `${ids.length} Schritte parallel gefuehrt` },
    warnings: gate.warnings,
  };
}
```

- [ ] **Step 4: Unabhängigkeits-Prüfung nachziehen (Record: Rechenteil)**

Der Record verlangt: Unabhängigkeit ist **nur bei modellierten, gerichteten Datenflüssen** überhaupt
prüfbar; **ungerichtete** Assoziationen tragen keine Lese-/Schreib-Semantik ⇒ nicht beweisbar ⇒
verweigern. Sind **gar keine** Assoziationen modelliert, übernimmt der Aufrufer die Verantwortung
(der Eingriff läuft, meldet aber `provenIndependent: false`).

Zuerst der Test — an den `describe('parallelize')`-Block anhängen:

```javascript
  test('verweigert bei ungerichteter Assoziation zwischen den Schritten', () => {
    const undirected = { ...lcChain, associations: [{ id: 'as1', source: 'a', target: 'b' }] };
    const r = previewParallelize(undirected, { nodeIds: ['a', 'b', 'c'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/ungerichtet/i);
  });

  test('verweigert bei nachgewiesener Datenabhaengigkeit', () => {
    const dependent = { ...lcChain,
      nodes: [...lcChain.nodes, { id: 'do1', type: 'dataObjectReference', name: 'Ergebnis', lane: 'L' }],
      associations: [{ id: 'as1', source: 'a', target: 'do1', directed: true },
                     { id: 'as2', source: 'do1', target: 'b', directed: true }] };
    const r = previewParallelize(dependent, { nodeIds: ['a', 'b', 'c'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/abhängig/i);
  });

  test('ohne Assoziationen laeuft der Eingriff, meldet aber ungeprueft', () => {
    const r = previewParallelize(lcChain, { nodeIds: ['a', 'b', 'c'] });
    expect(r.feasible).toBe('full');
    expect(r.provenIndependent).toBe(false);
  });
```

Dann in `redesign.js` vor `previewParallelize` einfügen:

```javascript
/**
 * Datenabhängigkeit zwischen Schritten.
 * Rückgabe: 'dependent' (nachgewiesen abhängig) | 'proven' (nachweislich unabhängig)
 *         | 'unprovable' (ungerichtete Assoziationen vorhanden) | 'unmodelled' (nichts modelliert)
 */
function dependencyState(lc, ids) {
  const assocs = lc.associations || [];
  const touching = assocs.filter(a => ids.includes(a.source) || ids.includes(a.target));
  if (touching.length === 0) return 'unmodelled';
  if (touching.some(a => !a.directed)) return 'unprovable';
  // Schreibt ein Schritt ein Datenobjekt, das ein späterer Schritt liest?
  const writes = {}, reads = {};
  for (const a of touching) {
    if (ids.includes(a.source)) (writes[a.target] ??= []).push(a.source);
    if (ids.includes(a.target)) (reads[a.source] ??= []).push(a.target);
  }
  for (const obj of Object.keys(writes)) {
    if (reads[obj] && reads[obj].length) return 'dependent';
  }
  return 'proven';
}
```

und in `previewParallelize` direkt vor dem `return`:

```javascript
  const dep = dependencyState(lc, nodeIds);
  if (dep === 'dependent') return refusal('Nachgewiesene Datenabhängigkeit zwischen den Schritten.');
  if (dep === 'unprovable') {
    return refusal('Ungerichtete Assoziationen tragen keine Lese-/Schreib-Semantik — Unabhängigkeit nicht beweisbar.');
  }
  return { feasible: 'full', scope: [...nodeIds], reason: '', provenIndependent: dep === 'proven' };
```

(das bisherige `return { feasible: 'full', scope: [...nodeIds], reason: '' };` ersetzen)

- [ ] **Step 5: Tests grün**

Run: `cd scripts && npm test -- --testPathPatterns=redesign`
Expected: PASS.

- [ ] **Step 6: Volle Suite grün**

Run: `cd scripts && npm test`
Expected: PASS, Golden-Dateien unverändert.

- [ ] **Step 7: Commit**

```bash
git add scripts/redesign.js scripts/redesign.test.js
git commit -m "feat(redesign): Eingriff Nebeneinanderlegen mit preview und apply

Verweigert bei unbekannten Kennungen, geschuetzten Elementen und nicht
zusammenhaengender Kette. Rollback, wenn das Ergebnis nicht sound waere.
Neue Kennungen sind deterministisch."
```

---

### Task 4: Eingriff „Schritte bündeln" (`mergeTasks`)

Abbruchgründe laut Record: Boundary-Events würden heimatlos, heterogene Typen, Loop-/MI-Marker,
Daten-Assoziationen — und der **Name ist Pflichtparameter**, weil eine Benennung ein Urteil wäre.

**Files:**
- Modify: `scripts/redesign.js`
- Test: `scripts/redesign.test.js`

**Interfaces:**
- Produces: `previewMergeTasks(lc, { nodeIds, name, policy })`, `applyMergeTasks(lc, { nodeIds, name, policy })`

- [ ] **Step 1: Failing tests schreiben**

```javascript
import { previewMergeTasks, applyMergeTasks } from './redesign.js';

describe('mergeTasks', () => {
  const lcMerge = {
    id: 'P',
    nodes: [
      { id: 's', type: 'startEvent', lane: 'L' },
      { id: 'm1', type: 'userTask', name: 'Daten erfassen', lane: 'L' },
      { id: 'm2', type: 'userTask', name: 'Daten sichern', lane: 'L' },
      { id: 'e', type: 'endEvent', lane: 'L' },
    ],
    edges: [
      { id: 'g0', source: 's', target: 'm1' },
      { id: 'g1', source: 'm1', target: 'm2' },
      { id: 'g2', source: 'm2', target: 'e' },
    ],
    lanes: [{ id: 'L', name: 'Sachbearbeiter' }],
  };

  test('verweigert ohne Namen — Benennung waere ein Urteil', () => {
    const r = previewMergeTasks(lcMerge, { nodeIds: ['m1', 'm2'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/name/i);
  });

  test('verweigert bei angehaengtem Boundary-Event', () => {
    const withBoundary = { ...lcMerge, nodes: [...lcMerge.nodes,
      { id: 'bnd', type: 'boundaryEvent', attachedTo: 'm1', marker: 'timer', lane: 'L' }] };
    const r = previewMergeTasks(withBoundary, { nodeIds: ['m1', 'm2'], name: 'Daten erfassen und sichern' });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/boundary/i);
  });

  test('verweigert bei unterschiedlichen Typen', () => {
    const mixed = { ...lcMerge, nodes: lcMerge.nodes.map(n => n.id === 'm2' ? { ...n, type: 'serviceTask' } : n) };
    const r = previewMergeTasks(mixed, { nodeIds: ['m1', 'm2'], name: 'X tun' });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/typ/i);
  });

  test('verweigert bei Schleifen- oder Mehrfach-Marker', () => {
    const looped = { ...lcMerge, nodes: lcMerge.nodes.map(n => n.id === 'm1' ? { ...n, loopType: 'standard' } : n) };
    const r = previewMergeTasks(looped, { nodeIds: ['m1', 'm2'], name: 'X tun' });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/marker/i);
  });

  test('buendelt zwei gleichartige Schritte und bleibt sound', () => {
    const r = applyMergeTasks(lcMerge, { nodeIds: ['m1', 'm2'], name: 'Daten erfassen und sichern' });
    expect(r.lc.nodes.find(n => n.id === 'm2')).toBeUndefined();
    expect(r.lc.nodes.find(n => n.id === 'm1').name).toBe('Daten erfassen und sichern');
    expect(checkGate(r.lc).ok).toBe(true);
    expect(r.change.removed).toContain('m2');
  });
});
```

- [ ] **Step 2: Fehlschlag bestätigen**

Run: `cd scripts && npm test -- --testPathPatterns=redesign -t "mergeTasks"`
Expected: FAIL — `previewMergeTasks is not a function`.

- [ ] **Step 3: Implementieren**

An `scripts/redesign.js` anhängen:

```javascript
const TASK_TYPES = new Set(['task', 'userTask', 'serviceTask', 'scriptTask', 'manualTask',
                            'businessRuleTask', 'sendTask', 'receiveTask']);

export function previewMergeTasks(lc, { nodeIds = [], name = '', policy = {} } = {}) {
  const proc = procOf(lc);
  if (nodeIds.length < 2) return refusal('Mindestens zwei Schritte nötig.');
  if (!name || !name.trim()) {
    return refusal('Name des gebündelten Schritts ist Pflicht — eine Benennung wäre ein fachliches Urteil.');
  }
  const nodes = findNodes(proc, nodeIds);
  if (nodes.some(n => !n)) return refusal('Unbekannte Kennung.');
  if (nodes.some(n => !TASK_TYPES.has(n.type))) return refusal('Nur Aufgaben lassen sich bündeln.');
  const prot = nodes.filter(n => isProtected(n, policy, lc));
  if (prot.length) return refusal(`Geschütztes Element betroffen: ${prot.map(n => n.id).join(', ')}`);
  const types = new Set(nodes.map(n => n.type));
  if (types.size > 1) return refusal(`Unterschiedliche Typen (${[...types].join(', ')}) — welcher überlebt, ist ein Urteil.`);
  const lanes = new Set(nodes.map(n => n.lane));
  if (lanes.size > 1) return refusal('Schritte liegen in verschiedenen Bahnen.');
  if (nodes.some(n => n.loopType || n.multiInstance)) {
    return refusal('Schleifen- oder Mehrfach-Marker vorhanden — Bündeln würde die Semantik verändern.');
  }
  const boundaries = (proc.nodes || []).filter(n => n.type === 'boundaryEvent' && nodeIds.includes(n.attachedTo));
  if (boundaries.length) {
    return refusal(`Angehängtes Boundary-Event (${boundaries.map(b => b.id).join(', ')}) würde heimatlos.`);
  }
  if (!isLinearChain(proc, nodeIds)) return refusal('Die Schritte bilden keine zusammenhängende Kette.');
  return { feasible: 'full', scope: [...nodeIds], reason: '' };
}

export function applyMergeTasks(lc, params = {}) {
  const pv = previewMergeTasks(lc, params);
  if (pv.feasible === 'none') throw new Error(pv.reason);

  const out = cloneLc(lc);
  const proc = procOf(out);
  const ids = pv.scope;
  const keep = ids[0], drop = ids.slice(1);
  const edges = proc.edges || [];

  proc.nodes.find(n => n.id === keep).name = params.name;

  const removed = [];
  for (let i = 0; i < ids.length - 1; i++) {
    const idx = edges.findIndex(e => e.source === ids[i] && e.target === ids[i + 1]);
    if (idx >= 0) removed.push(edges.splice(idx, 1)[0].id);
  }
  const lastOut = edges.find(e => e.source === ids[ids.length - 1]);
  if (lastOut) lastOut.source = keep;
  proc.nodes = proc.nodes.filter(n => !drop.includes(n.id));
  removed.push(...drop);

  const gate = checkGate(out);
  if (!gate.ok) throw new Error(`Rollback: Ergebnis waere nicht sound — ${gate.errors.join('; ')}`);

  return {
    lc: out,
    change: { transform: 'mergeTasks', targets: ids, added: [], removed,
              note: `${ids.length} Schritte gebündelt zu "${params.name}"` },
    warnings: gate.warnings,
  };
}
```

- [ ] **Step 4: Tests grün**

Run: `cd scripts && npm test -- --testPathPatterns=redesign`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/redesign.js scripts/redesign.test.js
git commit -m "feat(redesign): Eingriff Schritte buendeln

Name ist Pflichtparameter — eine Benennung waere ein fachliches Urteil, das der
Werkzeugkasten nicht faellen darf. Verweigert bei Boundary-Events, heterogenen
Typen, Schleifen-/Mehrfach-Markern und Bahnwechsel."
```

---

### Task 5: Eingriff „Rolle wechseln" (`relane`)

Kernrisiko laut Record: Das Schema kennt **zwei Zuordnungsformate** (`node.lane` und `Lane.nodeIds`).
Wer nur eines schreibt, erzeugt ein widersprüchliches Modell.

**Files:**
- Modify: `scripts/redesign.js`
- Test: `scripts/redesign.test.js`

**Interfaces:**
- Produces: `previewRelane(lc, { nodeId, lane, policy })`, `applyRelane(lc, { nodeId, lane, policy })`

- [ ] **Step 1: Failing tests schreiben**

```javascript
import { previewRelane, applyRelane } from './redesign.js';

describe('relane', () => {
  const lcTwoLanes = {
    id: 'P',
    nodes: [
      { id: 's', type: 'startEvent', lane: 'A' },
      { id: 'x', type: 'userTask', name: 'Fall prüfen', lane: 'A' },
      { id: 'e', type: 'endEvent', lane: 'B' },
    ],
    edges: [
      { id: 'h0', source: 's', target: 'x' },
      { id: 'h1', source: 'x', target: 'e' },
    ],
    lanes: [{ id: 'A', name: 'Vorpruefung' }, { id: 'B', name: 'Entscheidung' }],
  };

  test('verweigert bei unbekannter Zielbahn', () => {
    const r = previewRelane(lcTwoLanes, { nodeId: 'x', lane: 'gibtsnicht' });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/bahn/i);
  });

  test('verschiebt den Schritt und bleibt sound', () => {
    const r = applyRelane(lcTwoLanes, { nodeId: 'x', lane: 'B' });
    expect(r.lc.nodes.find(n => n.id === 'x').lane).toBe('B');
    expect(checkGate(r.lc).ok).toBe(true);
  });

  test('pflegt auch das zweite Zuordnungsformat (Lane.nodeIds)', () => {
    const formatB = {
      ...lcTwoLanes,
      lanes: [{ id: 'A', name: 'Vorpruefung', nodeIds: ['s', 'x'] },
              { id: 'B', name: 'Entscheidung', nodeIds: ['e'] }],
    };
    const r = applyRelane(formatB, { nodeId: 'x', lane: 'B' });
    const a = r.lc.lanes.find(l => l.id === 'A');
    const b = r.lc.lanes.find(l => l.id === 'B');
    expect(a.nodeIds).not.toContain('x');
    expect(b.nodeIds).toContain('x');
  });

  test('weist die Veraenderung der Uebergaben aus, auch wenn sie steigt', () => {
    const r = applyRelane(lcTwoLanes, { nodeId: 'x', lane: 'B' });
    expect(typeof r.change.handoffsBefore).toBe('number');
    expect(typeof r.change.handoffsAfter).toBe('number');
  });
});
```

- [ ] **Step 2: Fehlschlag bestätigen**

Run: `cd scripts && npm test -- --testPathPatterns=redesign -t "relane"`
Expected: FAIL — `previewRelane is not a function`.

- [ ] **Step 3: Implementieren**

```javascript
function countHandoffs(proc) {
  const map = {};
  for (const n of (proc.nodes || [])) map[n.id] = n;
  let c = 0;
  for (const e of (proc.edges || [])) {
    const s = map[e.source], t = map[e.target];
    if (s && t && s.lane && t.lane && s.lane !== t.lane) c++;
  }
  return c;
}

export function previewRelane(lc, { nodeId, lane, policy = {} } = {}) {
  const proc = procOf(lc);
  const node = (proc.nodes || []).find(n => n.id === nodeId);
  if (!node) return refusal(`Unbekannte Kennung: ${nodeId}`);
  if (isProtected(node, policy, lc)) return refusal(`Geschütztes Element betroffen: ${nodeId}`);
  const target = (proc.lanes || []).find(l => l.id === lane || l.name === lane);
  if (!target) return refusal(`Unbekannte Zielbahn: ${lane}`);
  if (lc.pools && lc.pools.length > 1) {
    const inThisPool = (proc.lanes || []).some(l => l.id === target.id);
    if (!inThisPool) return refusal('Bahnwechsel über Pool-Grenzen ist außerhalb des Umfangs.');
  }
  if (node.lane === target.id) return refusal('Der Schritt liegt bereits in dieser Bahn.');
  return { feasible: 'full', scope: [nodeId], reason: '' };
}

export function applyRelane(lc, params = {}) {
  const pv = previewRelane(lc, params);
  if (pv.feasible === 'none') throw new Error(pv.reason);

  const out = cloneLc(lc);
  const proc = procOf(out);
  const before = countHandoffs(proc);
  const node = proc.nodes.find(n => n.id === params.nodeId);
  const target = proc.lanes.find(l => l.id === params.lane || l.name === params.lane);

  node.lane = target.id;
  // Zweites Zuordnungsformat mitpflegen, sonst entsteht ein widerspruechliches Modell.
  for (const l of proc.lanes) {
    if (Array.isArray(l.nodeIds)) {
      l.nodeIds = l.nodeIds.filter(id => id !== node.id);
      if (l.id === target.id) l.nodeIds.push(node.id);
    }
  }

  const gate = checkGate(out);
  if (!gate.ok) throw new Error(`Rollback: Ergebnis waere nicht sound — ${gate.errors.join('; ')}`);
  const after = countHandoffs(proc);

  return {
    lc: out,
    change: { transform: 'relane', targets: [params.nodeId], added: [], removed: [],
              handoffsBefore: before, handoffsAfter: after,
              note: `Übergaben ${before} → ${after}` },
    warnings: gate.warnings,
  };
}
```

- [ ] **Step 4: Tests grün + Commit**

Run: `cd scripts && npm test -- --testPathPatterns=redesign`
Expected: PASS.

```bash
git add scripts/redesign.js scripts/redesign.test.js
git commit -m "feat(redesign): Eingriff Rolle wechseln

Pflegt beide Zuordnungsformate (node.lane und Lane.nodeIds), sonst entsteht ein
widerspruechliches Modell. Weist die Veraenderung der Uebergaben aus, auch wenn
sie steigt."
```

---

### Task 6: Eingriff „Prüfreihenfolge drehen" (`reorderKnockouts`)

Zentrale Zusage: Der Eingriff **berechnet keine Reihenfolge** — er wendet eine übergebene an und
verweigert, wenn keine da ist. Bedingungs-Labels und Standardfluss müssen mitwandern.

**Files:**
- Modify: `scripts/redesign.js`
- Test: `scripts/redesign.test.js`

**Interfaces:**
- Produces: `previewReorderKnockouts(lc, { gatewayIds, order, policy })`, `applyReorderKnockouts(...)`

- [ ] **Step 1: Failing tests schreiben**

```javascript
import { previewReorderKnockouts, applyReorderKnockouts } from './redesign.js';

describe('reorderKnockouts', () => {
  const lcKo = {
    id: 'P',
    nodes: [
      { id: 's', type: 'startEvent', lane: 'L' },
      { id: 'g1', type: 'exclusiveGateway', name: 'Vollständig?', lane: 'L' },
      { id: 'r1', type: 'endEvent', name: 'Abgelehnt', marker: 'terminate', lane: 'L' },
      { id: 'g2', type: 'exclusiveGateway', name: 'Zulässig?', lane: 'L' },
      { id: 'r2', type: 'endEvent', name: 'Fehler', marker: 'error', lane: 'L' },
      { id: 't', type: 'userTask', name: 'Antrag bearbeiten', lane: 'L' },
      { id: 'e', type: 'endEvent', name: 'Fertig', lane: 'L' },
    ],
    edges: [
      { id: 'k0', source: 's', target: 'g1' },
      { id: 'k1', source: 'g1', target: 'r1', label: 'Nein' },
      { id: 'k2', source: 'g1', target: 'g2', label: 'Ja' },
      { id: 'k3', source: 'g2', target: 'r2', label: 'Nein' },
      { id: 'k4', source: 'g2', target: 't', label: 'Ja' },
      { id: 'k5', source: 't', target: 'e' },
    ],
    lanes: [{ id: 'L', name: 'Sachbearbeiter' }],
  };

  test('verweigert ohne uebergebene Reihenfolge und erfindet keine', () => {
    const r = previewReorderKnockouts(lcKo, { gatewayIds: ['g1', 'g2'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/reihenfolge/i);
  });

  test('verweigert, wenn die Reihenfolge keine Permutation ist', () => {
    const r = previewReorderKnockouts(lcKo, { gatewayIds: ['g1', 'g2'], order: ['g2', 'g3'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/permutation/i);
  });

  test('dreht die Reihenfolge, behaelt Labels und bleibt sound', () => {
    const r = applyReorderKnockouts(lcKo, { gatewayIds: ['g1', 'g2'], order: ['g2', 'g1'] });
    const firstEdge = r.lc.edges.find(e => e.source === 's');
    expect(firstEdge.target).toBe('g2');
    const rejectG2 = r.lc.edges.find(e => e.source === 'g2' && e.target === 'r2');
    expect(rejectG2.label).toBe('Nein');
    expect(checkGate(r.lc).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Fehlschlag bestätigen**

Run: `cd scripts && npm test -- --testPathPatterns=redesign -t "reorderKnockouts"`
Expected: FAIL — `previewReorderKnockouts is not a function`.

- [ ] **Step 3: Implementieren**

```javascript
export function previewReorderKnockouts(lc, { gatewayIds = [], order = null, policy = {} } = {}) {
  const proc = procOf(lc);
  if (gatewayIds.length < 2) return refusal('Mindestens zwei Prüfungen nötig.');
  const nodes = findNodes(proc, gatewayIds);
  if (nodes.some(n => !n)) return refusal('Unbekannte Kennung.');
  if (nodes.some(n => n.type !== 'exclusiveGateway')) return refusal('Nur exklusive Gateways.');
  const prot = nodes.filter(n => isProtected(n, policy, lc));
  if (prot.length) return refusal(`Geschütztes Element betroffen: ${prot.map(n => n.id).join(', ')}`);
  if (!order) {
    return refusal('Keine Reihenfolge übergeben — der Eingriff berechnet keine und erfindet keine.');
  }
  const same = order.length === gatewayIds.length && [...order].sort().join() === [...gatewayIds].sort().join();
  if (!same) return refusal('Die Reihenfolge ist keine Permutation der übergebenen Prüfungen.');
  return { feasible: 'full', scope: [...order], reason: '' };
}

export function applyReorderKnockouts(lc, params = {}) {
  const pv = previewReorderKnockouts(lc, params);
  if (pv.feasible === 'none') throw new Error(pv.reason);

  const out = cloneLc(lc);
  const proc = procOf(out);
  const edges = proc.edges;
  const oldOrder = params.gatewayIds;
  const newOrder = pv.scope;

  // Die "Weiter"-Kante eines Knock-outs ist die, die nicht zu einem Ausnahme-Ende fuehrt.
  const nodeById = {};
  for (const n of proc.nodes) nodeById[n.id] = n;
  const isExcEnd = (id) => {
    const n = nodeById[id];
    return n && n.type === 'endEvent' &&
      (['error', 'terminate', 'escalation', 'cancel'].includes(n.marker) ||
       /fehler|error|abbruch|abgebroch|eskal|storn|ablehn|abgelehnt|reject|cancel|verwerf|verworf/i.test(n.name || ''));
  };
  const contEdge = (gwId) => edges.find(e => e.source === gwId && !isExcEnd(e.target));

  const entry = edges.find(e => e.target === oldOrder[0] && !oldOrder.includes(e.source));
  const exit = contEdge(oldOrder[oldOrder.length - 1]).target;

  if (entry) entry.target = newOrder[0];
  for (let i = 0; i < newOrder.length; i++) {
    const c = contEdge(newOrder[i]);
    c.target = i < newOrder.length - 1 ? newOrder[i + 1] : exit;
  }

  const gate = checkGate(out);
  if (!gate.ok) throw new Error(`Rollback: Ergebnis waere nicht sound — ${gate.errors.join('; ')}`);

  return {
    lc: out,
    change: { transform: 'reorderKnockouts', targets: newOrder, added: [], removed: [],
              note: `Reihenfolge ${oldOrder.join(' → ')} zu ${newOrder.join(' → ')}` },
    warnings: gate.warnings,
  };
}
```

- [ ] **Step 4: Tests grün + Commit**

Run: `cd scripts && npm test -- --testPathPatterns=redesign`
Expected: PASS.

```bash
git add scripts/redesign.js scripts/redesign.test.js
git commit -m "feat(redesign): Eingriff Pruefreihenfolge drehen

Berechnet keine Reihenfolge und erfindet keine — er wendet eine uebergebene an
und verweigert sonst. Bedingungs-Labels wandern mit."
```

---

### Task 7: Eingriff „Ausnahme herausnehmen" (`isolateException`)

Der heikelste Eingriff: Inline-Zweig (Geschäftsentscheidung) und Boundary-Event (Störung) sehen im
Graphen gleich aus. Deshalb **Pflichtparameter für die Semantik** — keine Ableitung aus Namen.

**Files:**
- Modify: `scripts/redesign.js`
- Test: `scripts/redesign.test.js`

**Interfaces:**
- Produces: `previewIsolateException(lc, { endId, attachTo, marker, cancelActivity, policy })`,
  `applyIsolateException(...)`

- [ ] **Step 1: Failing tests schreiben**

```javascript
import { previewIsolateException, applyIsolateException } from './redesign.js';

describe('isolateException', () => {
  const lcExc = {
    id: 'P',
    nodes: [
      { id: 's', type: 'startEvent', lane: 'L' },
      { id: 'task', type: 'userTask', name: 'Antrag prüfen', lane: 'L' },
      { id: 'gw', type: 'exclusiveGateway', name: 'Frist überschritten?', lane: 'L' },
      { id: 'xend', type: 'endEvent', name: 'Fall eskaliert', lane: 'L' },
      { id: 'e', type: 'endEvent', name: 'Fertig', lane: 'L' },
    ],
    edges: [
      { id: 'j0', source: 's', target: 'task' },
      { id: 'j1', source: 'task', target: 'gw' },
      { id: 'j2', source: 'gw', target: 'xend', label: 'Ja' },
      { id: 'j3', source: 'gw', target: 'e', label: 'Nein' },
    ],
    lanes: [{ id: 'L', name: 'Sachbearbeiter' }],
  };

  test('verweigert ohne ausdrueckliche Semantik-Parameter', () => {
    const r = previewIsolateException(lcExc, { endId: 'xend', attachTo: 'task' });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/marker/i);
  });

  test('leitet die Semantik nicht aus dem Namen ab', () => {
    const r = previewIsolateException(lcExc, { endId: 'xend', attachTo: 'task', marker: null });
    expect(r.feasible).toBe('none');
  });

  test('haengt die Ausnahme als Boundary-Event an und bleibt sound', () => {
    const r = applyIsolateException(lcExc, { endId: 'xend', attachTo: 'task',
                                             marker: 'timer', cancelActivity: true });
    const bnd = r.lc.nodes.find(n => n.type === 'boundaryEvent');
    expect(bnd.attachedTo).toBe('task');
    expect(bnd.marker).toBe('timer');
    expect(bnd.cancelActivity).toBe(true);
    expect(checkGate(r.lc).ok).toBe(true);
    expect(r.change.added).toContain(bnd.id);
  });
});
```

- [ ] **Step 2: Fehlschlag bestätigen**

Run: `cd scripts && npm test -- --testPathPatterns=redesign -t "isolateException"`
Expected: FAIL — `previewIsolateException is not a function`.

- [ ] **Step 3: Implementieren**

```javascript
const BOUNDARY_MARKERS = new Set(['timer', 'error', 'message', 'signal', 'escalation',
                                  'compensation', 'cancel', 'conditional']);

export function previewIsolateException(lc, { endId, attachTo, marker, policy = {} } = {}) {
  const proc = procOf(lc);
  const end = (proc.nodes || []).find(n => n.id === endId);
  if (!end) return refusal(`Unbekannte Kennung: ${endId}`);
  if (end.type !== 'endEvent') return refusal('Ziel ist kein End-Ereignis.');
  const host = (proc.nodes || []).find(n => n.id === attachTo);
  if (!host) return refusal(`Unbekannte Aufgabe: ${attachTo}`);
  if (!TASK_TYPES.has(host.type)) return refusal('Boundary-Ereignisse hängen nur an Aufgaben.');
  if (isProtected(host, policy, lc) || isProtected(end, policy, lc)) {
    return refusal('Geschütztes Element betroffen.');
  }
  if (!marker || !BOUNDARY_MARKERS.has(marker)) {
    return refusal('Marker ist Pflicht (timer|error|message|…) — die Semantik ist nicht aus dem Graphen oder dem Namen ableitbar.');
  }
  return { feasible: 'full', scope: [endId, attachTo], reason: '' };
}

export function applyIsolateException(lc, params = {}) {
  const pv = previewIsolateException(lc, params);
  if (pv.feasible === 'none') throw new Error(pv.reason);

  const out = cloneLc(lc);
  const proc = procOf(out);
  const { endId, attachTo, marker } = params;
  const cancelActivity = params.cancelActivity !== false;

  const bndId = nextId(out, `bnd_${attachTo}_${marker}`);
  const host = proc.nodes.find(n => n.id === attachTo);
  proc.nodes.push({ id: bndId, type: 'boundaryEvent', name: '', lane: host.lane,
                    attachedTo: attachTo, marker, cancelActivity });

  // Bisherige Zufuehrung zum Ausnahme-Ende entfernen, neu vom Boundary-Ereignis fuehren.
  const removed = [];
  for (let i = proc.edges.length - 1; i >= 0; i--) {
    if (proc.edges[i].target === endId) removed.push(proc.edges.splice(i, 1)[0].id);
  }
  const newEdge = nextId(out, `flow_${bndId}_${endId}`);
  proc.edges.push({ id: newEdge, source: bndId, target: endId });

  const gate = checkGate(out);
  if (!gate.ok) throw new Error(`Rollback: Ergebnis waere nicht sound — ${gate.errors.join('; ')}`);

  return {
    lc: out,
    change: { transform: 'isolateException', targets: [endId, attachTo],
              added: [bndId, newEdge], removed,
              note: `Ausnahme "${(proc.nodes.find(n => n.id === endId) || {}).name || endId}" an ${attachTo} gehängt (${marker})` },
    warnings: gate.warnings,
  };
}
```

- [ ] **Step 4: Tests grün + volle Suite + Commit**

Run: `cd scripts && npm test`
Expected: PASS.

```bash
git add scripts/redesign.js scripts/redesign.test.js
git commit -m "feat(redesign): Eingriff Ausnahme herausnehmen

Marker und cancelActivity sind Pflichtparameter. Der Eingriff leitet die
Semantik NICHT aus dem Namen ab: Inline-Zweig (Geschaeftsentscheidung) und
Boundary-Ereignis (Stoerung) sehen im Graphen gleich aus."
```

---

### Task 8: CLI-Zugang

**Files:**
- Create: `scripts/redesign-cli.js`
- Test: `scripts/redesign.test.js` (spawn-basiert, Muster aus `pipeline.test.js`)

**Interfaces:**
- Consumes: alle `preview*`/`apply*` aus `redesign.js`
- Produces: CLI `node redesign-cli.js <input.json> <transform> [--nodes a,b,c] [--name "…"] [--lane X] [--marker timer] [--order g2,g1] [--apply] [-o out.json]`
  — ohne `--apply` nur Vorschau; Rückgabewert `0` bei machbar, `1` bei Verweigerung.

- [ ] **Step 1: Failing tests schreiben**

```javascript
describe('redesign-cli', () => {
  const runCli = async (lc, args) => {
    const { spawnSync } = await import('node:child_process');
    const os = await import('node:os'); const fs = await import('node:fs'); const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redesign-cli-'));
    const inPath = path.join(dir, 'in.json'); const outPath = path.join(dir, 'out.json');
    fs.writeFileSync(inPath, JSON.stringify(lc), 'utf8');
    const res = spawnSync('node', ['redesign-cli.js', inPath, ...args, '-o', outPath],
                          { cwd: __dirname, encoding: 'utf8' });
    return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '',
             wrote: fs.existsSync(outPath) };
  };

  test('Vorschau schreibt nichts und meldet Machbarkeit', async () => {
    const r = await runCli(lcChain, ['parallelize', '--nodes', 'a,b,c']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/machbar/i);
    expect(r.wrote).toBe(false);
  });

  test('Verweigerung endet mit Fehler-Rueckgabewert und schreibt nicht', async () => {
    const r = await runCli(lcChain, ['parallelize', '--nodes', 'a,c', '--apply']);
    expect(r.status).not.toBe(0);
    expect(r.wrote).toBe(false);
  });

  test('mit --apply wird das Ergebnis geschrieben', async () => {
    const r = await runCli(lcChain, ['parallelize', '--nodes', 'a,b,c', '--apply']);
    expect(r.status).toBe(0);
    expect(r.wrote).toBe(true);
  });
});
```

- [ ] **Step 2: Fehlschlag bestätigen**

Run: `cd scripts && npm test -- --testPathPatterns=redesign -t "redesign-cli"`
Expected: FAIL — `Cannot find module 'redesign-cli.js'`.

- [ ] **Step 3: Implementieren**

```javascript
#!/usr/bin/env node
/**
 * CLI-Zugang zum Redesign-Werkzeugkasten.
 * Ohne --apply nur Vorschau. Verweigerung ⇒ Rückgabewert 1, keine Datei.
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import * as R from './redesign.js';

const TRANSFORMS = {
  parallelize:      [R.previewParallelize, R.applyParallelize],
  mergeTasks:       [R.previewMergeTasks, R.applyMergeTasks],
  relane:           [R.previewRelane, R.applyRelane],
  reorderKnockouts: [R.previewReorderKnockouts, R.applyReorderKnockouts],
  isolateException: [R.previewIsolateException, R.applyIsolateException],
};

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const [inputArg, transform] = args;
  if (!inputArg || !TRANSFORMS[transform]) {
    console.error(`Usage: node redesign-cli.js <input.json> <${Object.keys(TRANSFORMS).join('|')}> [--nodes a,b] [--name "…"] [--lane X] [--marker timer] [--order g2,g1] [--apply] [-o out.json]`);
    process.exit(1);
  }
  const lc = JSON.parse(readFileSync(resolve(inputArg), 'utf8'));
  const nodes = flag(args, '--nodes');
  const order = flag(args, '--order');
  const params = {
    nodeIds: nodes ? nodes.split(',') : undefined,
    nodeId: nodes ? nodes.split(',')[0] : undefined,
    name: flag(args, '--name'),
    lane: flag(args, '--lane'),
    marker: flag(args, '--marker'),
    endId: nodes ? nodes.split(',')[0] : undefined,
    attachTo: flag(args, '--attach-to'),
    gatewayIds: nodes ? nodes.split(',') : undefined,
    order: order ? order.split(',') : undefined,
  };

  const [preview, apply] = TRANSFORMS[transform];
  const pv = preview(lc, params);
  if (pv.feasible === 'none') {
    console.error(`✗ Nicht machbar: ${pv.reason}`);
    process.exit(1);
  }
  console.log(`✓ Machbar (${pv.feasible}): ${pv.scope.join(', ')}`);
  if (!args.includes('--apply')) {
    console.log('Vorschau — nichts geschrieben. Mit --apply anwenden.');
    return;
  }
  const res = apply(lc, params);
  const outPath = flag(args, '-o') || `${inputArg.replace(/\.json$/, '')}.soll.json`;
  writeFileSync(outPath, JSON.stringify(res.lc, null, 2), 'utf8');
  console.log(`✓ ${res.change.note}`);
  console.log(`✓ Ergebnis → ${outPath}`);
  if (res.warnings.length) {
    console.warn('⚠ Neue Warnungen:');
    res.warnings.forEach(w => console.warn('  · ' + w));
  }
}

main();
```

- [ ] **Step 4: Tests grün + Commit**

Run: `cd scripts && npm test`
Expected: PASS.

```bash
git add scripts/redesign-cli.js scripts/redesign.test.js
git commit -m "feat(redesign): CLI-Zugang mit Vorschau als Standard

Ohne --apply wird nur geprueft und nichts geschrieben. Verweigerung endet mit
Fehler-Rueckgabewert und laesst die Zieldatei unberuehrt."
```

---

### Task 9: Dokumentation nachziehen

**Files:**
- Modify: `references/api-reference.md` (Advisory-Form)
- Modify: `SKILL.md` (Werkzeugkasten + neue Advisory-Form)
- Modify: `CLAUDE.md` (Modul-Inventar + Schlüsseldateien)
- Modify: `references/fachliches-regelwerk.md` (Verweis auf den Werkzeugkasten)

- [ ] **Step 1: `api-reference.md` — Advisory-Form beschreiben**

Bei `/api/v1/generate` und `/api/v1/validate` die Antwortform ergänzen:

```markdown
`validation.advisories` ist eine Liste von Objekten:
`{ id, transform, targets, message, tradeoff, ref, judgment }` — `message` ist die menschenlesbare
Fassung, `targets` benennt die betroffenen Knoten, `transform` den passenden Eingriff aus dem
Werkzeugkasten. `judgment: true` heißt: erfordert Bestätigung, nicht mechanisch anwendbar.
```

- [ ] **Step 2: `SKILL.md` — Werkzeugkasten aufnehmen**

Im Abschnitt „Modes" nach dem Optimize-Absatz ergänzen:

```markdown
### Redesign-Werkzeugkasten (S2)

Im `optimize`-Modus benennt jede Advisory über `transform` + `targets` einen konkreten Eingriff. Die
Eingriffe liegen in `scripts/redesign.js`, je mit `preview` (was wäre machbar) und `apply` (anwenden):
`parallelize` · `mergeTasks` · `relane` · `reorderKnockouts` · `isolateException`.

Sie sind rein deterministisch — **kein Sprachmodell, kein API-Schlüssel**. Jeder Eingriff prüft das
Ergebnis gegen ein festes, profilunabhängiges Soundness-Gate und rollt bei strukturellen Fehlern zurück;
Stil-Warnungen blockieren nie, werden aber gemeldet. Der Werkzeugkasten entscheidet **nie**, *ob* ein
Eingriff gemacht wird.

CLI: `node redesign-cli.js <input.json> <transform> [--nodes …] [--apply]`
```

- [ ] **Step 3: `CLAUDE.md` — Inventar aktualisieren**

In der Schlüsseldateien-Tabelle ergänzen:

```markdown
| `scripts/redesign.js` | Fünf Redesign-Eingriffe, je `preview`/`apply`; deterministisch, ohne LLM |
| `scripts/redesign-core.js` | Profilunabhängiges Soundness-Gate, deterministische IDs, Schutzlisten |
| `scripts/redesign-cli.js` | CLI-Zugang zum Werkzeugkasten (Vorschau als Standard) |
```

- [ ] **Step 4: Volle Suite + Commit**

Run: `cd scripts && npm test`
Expected: PASS.

```bash
git add references/api-reference.md SKILL.md CLAUDE.md references/fachliches-regelwerk.md
git commit -m "docs: Redesign-Werkzeugkasten und neue Advisory-Form dokumentiert"
```

---

## Abschlussprüfung

- [ ] `cd scripts && npm test` — volle Suite grün, Golden-Dateien unverändert
- [ ] `grep -rn "llm-provider" scripts/redesign*.js` — **kein Treffer** (Sprachmodellfreiheit als Inspektion)
- [ ] `node pipeline.js ../tests/fixtures/simple-approval.json /tmp/doc` — `document`-Modus unverändert
- [ ] `node pipeline.js <fixture> /tmp/opt --optimize` — Advisories erscheinen **lesbar** (nicht als Objektdarstellung)

## Bewusst nicht in diesem Plan

- **Durchlaufzeit und gewichtete Bewertung** — im Record geparkt: das Schema trägt keine Dauern, und
  Gewichte sind Zielpriorisierung, die dem Werkzeugkasten fehlt.
- **Laufzeit-/Größenschranke** — geparkt bis zum ersten Lauf gegen die Robustness-Suite.
- **Teil-Erfüllung (`feasible: 'partial'`)** — die Form ist vorgesehen, aber kein Eingriff nutzt sie
  bisher; sie kommt, wenn ein realer Fall sie verlangt (YAGNI).
- **Interaktiver Loop, Agent, Greenfield** — Scheiben S3–S5, eigene Records.
