import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { LANGUAGE_TAG, languageTag, modelLanguage } from './index.js';

const readSchema = (name) => JSON.parse(readFileSync(new URL(`../../../references/${name}`, import.meta.url), 'utf8'));

/** Every `properties.language.pattern` anywhere in a schema. */
function languagePatterns(value, out = []) {
  if (Array.isArray(value)) { for (const v of value) languagePatterns(v, out); return out; }
  if (value && typeof value === 'object') {
    const pattern = value.properties?.language?.pattern;
    if (typeof pattern === 'string') out.push(pattern);
    for (const v of Object.values(value)) languagePatterns(v, out);
  }
  return out;
}

describe('LANGUAGE_TAG', () => {
  test.each([['input-schema.json'], ['input-schema-v2.json']])('is the pattern of %s', (name) => {
    const patterns = languagePatterns(readSchema(name));
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) expect(LANGUAGE_TAG.source).toBe(pattern);
  });
});

describe('modelLanguage', () => {
  test.each([
    [{ language: 'de' }, 'de'],
    [{ language: 'en-GB' }, 'en'],
    [{ language: 'gsw-CH' }, 'gsw'],
    [{}, null],
    [{ language: 'German' }, null],
    [{ language: 'DE' }, null],
    [{ language: 5 }, null],
    [{ language: null }, null],
    [{ language: 'de" x="1' }, null],
  ])('%j → %p', (lc, expected) => {
    expect(modelLanguage(lc)).toBe(expected);
  });

  test.each([[null], [[]], ['x'], [undefined], [5], [[{ language: 'de' }]]])('never throws: %p → null', (lc) => {
    expect(modelLanguage(lc)).toBeNull();
  });
});

describe('languageTag', () => {
  test('is the whole valid tag', () => {
    expect(languageTag({ language: 'en-GB' })).toBe('en-GB');
    expect(languageTag({ language: 'de' })).toBe('de');
  });

  test.each([[{ language: 'German' }], [{ language: 'de" x="1' }], [{}], [null], [[]], ['de'], [undefined]])('null for %p', (lc) => {
    expect(languageTag(lc)).toBeNull();
  });
});
