import { describe, test, expect } from '@jest/globals';
import { quoteForMessage, boundText } from './safe-text.js';
import { quoteForMessage as profileQuote } from './rule-profile.js';

describe('safe-text', () => {
  test('boundText cuts to max characters plus one ellipsis', () => {
    expect(boundText('a'.repeat(10), 4)).toBe('aaaa…');
    expect(boundText('abc', 4)).toBe('abc');
  });

  test('boundText escapes control, line-separator and format characters instead of passing them', () => {
    const out = boundText('a\nb\u001b[31m\u2028\u202e\u200b\u0085\u007f', 100);
    expect(out).toBe('a\\u000ab\\u001b[31m\\u2028\\u202e\\u200b\\u0085\\u007f');
    expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b\u202e]/);
  });

  test('boundText stringifies non-strings', () => {
    expect(boundText(42, 10)).toBe('42');
  });

  test('quoteForMessage keeps its behaviour, and the profile module uses the same helper', () => {
    expect(quoteForMessage('x\ny\u202e', 80)).toBe('"x\\ny"');
    expect(profileQuote('x\ny\u202e')).toBe('"x\\ny"');
    expect(profileQuote('a'.repeat(100))).toBe(`"${'a'.repeat(80)}…"`);
  });
});
