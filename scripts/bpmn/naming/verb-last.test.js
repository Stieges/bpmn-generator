import { describe, test, expect } from '@jest/globals';
import { loadLexicon } from './lexicon.js';
import { verbLast } from './verb-last.js';
import { inferMarker } from './markers.js';

const de = loadLexicon('de');
const s = verbLast(de);
const flagged = (j, name) => j(name) !== null;
const STATE_REASON = 'A task name is an instruction, not a state; write "Rechnung zahlen", not "Rechnung zu zahlen".';

describe('verb-last strategy shape', () => {
  test('exposes language, word order, examples and the judges', () => {
    expect(s.language).toBe('de');
    expect(s.wordOrder).toBe('verb-last');
    expect(s.examples.task).toBe('Antrag prüfen');
    for (const f of ['taskName', 'containerName', 'eventName', 'messageName', 'isQuestion', 'eventMarker']) {
      expect(typeof s[f]).toBe('function');
    }
    expect(Object.isFrozen(s)).toBe(true);
  });
  test('a verdict is null or { reason }', () => {
    const r = s.taskName('Prüfen');
    expect(typeof r.reason).toBe('string');
    expect(s.taskName('Antrag prüfen')).toBeNull();
  });
});

describe('taskName', () => {
  test.each([
    'Antrag prüfen', 'Paket an Paketdienst übergeben', 'Schufa-Auskunft einholen', 'SVG-Vorschau rendern',
    'Sachlich prüfen', 'Antrag pruefen', 'Rechnung freigeben', 'Antrag genehmigen', 'Antrag prüfen und freigeben',
    'Vertrag gegenlesen', 'Rechnung gegenzeichnen', 'Angebote gegenüberstellen', 'Unterlagen geheimhalten',
    'Kunde zu Termin einladen',
    // `anzünden` folds to `anzuenden`: a folded `zu` test would read an + zu + enden; the raw word has no `zu`.
    'Feuer anzünden',
    // Capitalised `Soll`, `Ist` are nouns, not state markers.
    'Soll-Ist vergleichen', 'Soll/Ist abgleichen', 'Soll und Ist vergleichen',
    // `dazu` is a separable prefix, not `da` + `zu`.
    'Tarif dazubuchen', 'Betrag dazurechnen', 'Artikel dazugeben',
    // `zu` + a rest without a vowel before its suffix is no zu-infinitive.
    'Ladung festzurren', 'Unkraut auszupfen',
    // The first letter decides lower case, not a leading quote.
    'Antrag "prüfen"', 'Antrag „prüfen“',
  ])('passes %s', (n) => expect(s.taskName(n)).toBeNull());

  test.each([
    'Prüfen', 'Schritt 3', 'Klärung mit Lieferant', 'Erinnerung an Vorgesetzten', 'Antrag eingegangen',
    'Antrag abgelehnt', 'Lieferung offen', 'Text gegengelesen',
  ])('flags %s', (n) => expect(flagged(s.taskName, n)).toBe(true));

  test.each(['Rechnung zu zahlen', 'Kunde möchte kündigen', 'Betrag auszuzahlen', 'Betrag abzurechnen', 'Daten zuzuordnen'])(
    'flags %s as a state', (n) => expect(s.taskName(n)).toEqual({ reason: STATE_REASON }));

  test('a conjunction is not the object', () => expect(flagged(s.taskName, 'und prüfen')).toBe(true));
  test('non-strings never throw', () => {
    for (const v of [undefined, null, 5, {}, [], '']) expect(() => s.taskName(v)).not.toThrow();
    expect(flagged(s.taskName, undefined)).toBe(true);
  });
});

describe('containerName', () => {
  test.each([
    'Kommissionierung', 'Schadenprüfung', 'Prüfung der Unterlagen', 'Antrag prüfen', 'Daten', 'Wareneingang',
    'Versand', 'Einkauf', 'Mahnwesen', 'Monatsabschluss', 'Onboarding', 'Schreiben',
    // A verb ending in `ieren` is no `ge…en` participle.
    'Adresse geocodieren',
  ])('passes %s', (n) => expect(s.containerName(n)).toBeNull());
  test.each(['Antrag geprüft', 'Rechnung storniert', 'Prüfen', 'Validieren'])('flags %s', (n) =>
    expect(flagged(s.containerName, n)).toBe(true));
  // split takes the longest prefix: `hinzu` + `gefügt` is a participle; `hin` + `zugefügt` would not be.
  test('flags Daten hinzugefügt (longest prefix hinzu)', () =>
    expect(s.containerName('Daten hinzugefügt')).toEqual({ reason: 'A container names a topic, not a state; avoid a participle at the end.' }));
});

describe('eventName', () => {
  test.each([
    'Antrag eingegangen', 'Akte erhalten', 'Input empfangen', 'Plan aktiv', 'Urlaubswunsch',
    'Lieferung nach 10 Tagen offen', 'Start', 'Ende', 'Kunde möchte kündigen', 'Zahlung soll erfolgen',
    'Rechnung zu zahlen', 'Antrag ist zu prüfen', 'Betrag zu erstatten', 'Betrag auszuzahlen',
  ])('passes %s', (n) => expect(s.eventName(n)).toBeNull());
  test.each(['Antrag prüfen', 'Daten validieren'])('flags %s', (n) => expect(flagged(s.eventName, n)).toBe(true));
});

describe('messageName', () => {
  test.each(['Bestellung', 'XML → fromXML() Validierung', 'CMOF-Objekte → toXML()', 'Rechnung zu zahlen'])(
    'passes %s', (n) => expect(s.messageName(n)).toBeNull());
  test.each(['Rechnung senden', 'Rechnung gesendet', 'Rechnung storniert'])('flags %s', (n) =>
    expect(flagged(s.messageName, n)).toBe(true));
});

describe('isQuestion', () => {
  test.each([['Vollständig?', true], ['Vollständig\n?', true], ['Vollständig', false], ['', false]])('%j', (n, e) =>
    expect(s.isQuestion(n)).toBe(e));
});

describe('markers', () => {
  test.each([
    ['Lieferfrist überschritten', 'boundaryEvent', 'timer'],
    ['Fristablauf', 'boundaryEvent', 'timer'],
    ['Zeitüberschreitung', 'boundaryEvent', 'timer'],
    ['Zeitablauf', 'boundaryEvent', 'timer'],
    ['Wartezeit abgelaufen', 'boundaryEvent', 'timer'],
    ['Warten auf Zahlung', 'intermediateCatchEvent', 'timer'],
    ['Fehlerfall', 'boundaryEvent', 'error'],
    ['Fehlermeldung erhalten', 'boundaryEvent', 'error'],
    ['Nachrichteneingang', 'startEvent', 'message'],
    ['Nachrichten eingegangen', 'startEvent', 'message'],
    ['Eskalation erfasst', 'endEvent', 'escalation'],
    ['Prüfung beendet', 'endEvent', null],
    ['Zeitung gelesen', 'startEvent', null],
    ['Arbeitszeitmodell geändert', 'startEvent', null],
  ])('eventMarker(%s, %s) = %s', (n, t, e) => {
    expect(s.eventMarker(n, t)).toBe(e);
    expect(inferMarker(de, n, t)).toBe(e);
  });
});

describe('Review Focus 4: robustness and linear time', () => {
  const huge = [
    'a'.repeat(200000), ('(' + 'x ').repeat(50000), 'Antrag ' + 'prüfen '.repeat(50000), '-'.repeat(100000),
    '\n'.repeat(100000), 'aus' + 'zu'.repeat(100000) + 'zahlen', 'ge'.repeat(100000) + 't', 'ä'.repeat(200000),
  ];
  test.each(huge.map((h, i) => [i, h]))('input %i never throws and finishes fast', (_i, h) => {
    const t = Date.now();
    for (const f of ['taskName', 'containerName', 'eventName', 'messageName', 'isQuestion']) expect(() => s[f](h)).not.toThrow();
    for (const t2 of ['startEvent', 'boundaryEvent']) expect(() => s.eventMarker(h, t2)).not.toThrow();
    expect(Date.now() - t).toBeLessThan(2000);
  });
  test('non-string input never throws', () => {
    for (const v of [undefined, null, 1, {}, [], Symbol.iterator]) {
      for (const f of ['taskName', 'containerName', 'eventName', 'messageName', 'isQuestion']) expect(() => s[f](v)).not.toThrow();
      expect(() => s.eventMarker(v, 'startEvent')).not.toThrow();
    }
  });
});
