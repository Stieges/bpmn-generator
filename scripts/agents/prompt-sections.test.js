import { describe, test, expect } from '@jest/globals';
import { extractPromptSection } from './prompt-sections.js';

describe('extractPromptSection', () => {
  test('extracts the Master Extraction Prompt section, stopping before the section separator', () => {
    const section = extractPromptSection('Master Extraction Prompt');
    expect(section).toContain('{{USER_TEXT}}');
    expect(section).not.toMatch(/```\s*$/);
  });

  test('extracts a section whose block contains nested ```json examples without truncating early', () => {
    const section = extractPromptSection('Master Extraction Prompt');
    expect(section).toContain('Root shape A');
    expect(section).toContain('Root shape B');
    expect(section).toContain('"lanes": [ {"id": "lane_sb"');
  });

  test('extracts the Chat Discovery Prompt section', () => {
    const section = extractPromptSection('Chat Discovery Prompt');
    expect(section).toContain('readyToGenerate');
    expect(section).toContain('suggestedSummary');
  });

  test('returns an empty string for an unknown header', () => {
    expect(extractPromptSection('Nonexistent Section Header')).toBe('');
  });
});
