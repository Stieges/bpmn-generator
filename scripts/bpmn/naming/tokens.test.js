import { describe, test, expect } from '@jest/globals';
import { foldWord, labelTokens } from './tokens.js';

describe('foldWord', () => {
  test.each([
    ['Prüfen', 'pruefen'], ['Straße', 'strasse'], ['Ärger', 'aerger'], ['Öl', 'oel'],
    ['Antrag.', 'antrag'], ['A1-b', 'a1b'], ['(…)', ''],
  ])('%s -> %s', (input, expected) => expect(foldWord(input)).toBe(expected));
});

describe('labelTokens', () => {
  test.each([
    ['Follow-up', 1, ['Follow', 'up']],
    ['Schufa-Auskunft einholen', 2, ['Schufa', 'Auskunft', 'einholen']],
    ['Antrag (CRM) prüfen', 2, ['Antrag', 'prüfen']],
    ['erfassen/ändern', 2, ['erfassen', 'ändern']],
    ['Antrag\nprüfen', 2, ['Antrag', 'prüfen']],
    ['1. Review application', 3, ['1.', 'Review', 'application']],
    ['Antrag [intern] prüfen', 2, ['Antrag', 'prüfen']],
  ])('%j', (name, wordCount, raws) => {
    const r = labelTokens(name);
    expect(r.wordCount).toBe(wordCount);
    expect(r.tokens.map(t => t.raw)).toEqual(raws);
  });

  test('raw keeps case, folded is folded', () => {
    expect(labelTokens('Antrag Prüfen').tokens).toEqual([
      { raw: 'Antrag', folded: 'antrag' }, { raw: 'Prüfen', folded: 'pruefen' },
    ]);
  });

  test('umlaut and transliteration give the same last folded token', () => {
    const a = labelTokens('Antrag pruefen').tokens.at(-1).folded;
    const b = labelTokens('Antrag prüfen').tokens.at(-1).folded;
    expect(a).toBe(b);
  });

  test('empty or unusable input', () => {
    expect(labelTokens('')).toEqual({ wordCount: 0, tokens: [] });
    expect(labelTokens('()')).toEqual({ wordCount: 0, tokens: [] });
    expect(labelTokens(undefined)).toEqual({ wordCount: 0, tokens: [] });
    expect(labelTokens('- / -')).toEqual({ wordCount: 0, tokens: [] });
  });

  test.each([
    ['5000 opening round brackets', '('.repeat(5000)],
    ['5000 opening square brackets then text', '['.repeat(5000) + 'x'],
    ['5000 closed bracket pairs', '(a)'.repeat(5000)],
    ['20000 characters', 'ab-c '.repeat(4000)],
  ])('%s finishes quickly', (_n, input) => {
    const t0 = Date.now();
    const r = labelTokens(input);
    expect(Date.now() - t0).toBeLessThan(200);
    expect(Number.isFinite(r.wordCount)).toBe(true);
  });
});
