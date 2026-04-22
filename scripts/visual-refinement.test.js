/**
 * Visual Refinement — unit tests
 */
import { estimateTextWidth } from './visual-refinement.js';

describe('estimateTextWidth', () => {
  test('returns 0 for empty string', () => {
    expect(estimateTextWidth('', 11)).toBe(0);
  });

  test('scales roughly with character count at fontSize 11', () => {
    const short = estimateTextWidth('abc', 11);
    const long  = estimateTextWidth('abcabcabc', 11);
    expect(long).toBeGreaterThan(short * 2.5);
    expect(long).toBeLessThan(short * 3.5);
  });

  test('scales with font size', () => {
    const w11 = estimateTextWidth('Hello World', 11);
    const w22 = estimateTextWidth('Hello World', 22);
    expect(w22).toBeGreaterThan(w11 * 1.8);
  });

  test('handles German compound words (no spaces)', () => {
    const w = estimateTextWidth('Prozessverantwortlicher', 11);
    expect(w).toBeGreaterThan(100); // ~120–150 px expected
    expect(w).toBeLessThan(200);
  });
});
