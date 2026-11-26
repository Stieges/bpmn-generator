/**
 * English M01 against a sample of task names written before the judge was measured
 * (`tests/fixtures/naming/en-task-names.json`): correct names give no finding, clearly wrong ones
 * are flagged, and the correct names whose first word is not on the verb list are counted (H14).
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLexicon } from './lexicon.js';
import { verbFirst } from './verb-first.js';
import { namingHints } from './index.js';

const sample = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'naming', 'en-task-names.json'), 'utf8'));
const s = verbFirst(loadLexicon('en'));

describe('the English task-name sample', () => {
  test('has at least 400 correct and 100 wrong names, none twice', () => {
    expect(sample.correct.length).toBe(539);
    expect(sample.wrong.length).toBe(115);
    const all = [...sample.correct, ...sample.wrong];
    expect(new Set(all).size).toBe(all.length);
  });

  test('no correct name is an M01 finding', () => {
    expect(sample.correct.filter((n) => s.taskName(n) !== null)).toEqual([]);
  });

  test('at least 90 % of the wrong names are flagged; the misses are pinned', () => {
    const missed = sample.wrong.filter((n) => s.taskName(n) === null);
    expect(missed).toEqual([
      'Credit check', 'Document review', 'Price quote', 'Claims handling', 'Order fulfilment', 'Credit decision',
      'Purchase requisition', 'Process step 4', 'Order pick', 'Change request',
    ]);
    expect((sample.wrong.length - missed.length) / sample.wrong.length).toBeGreaterThanOrEqual(0.9);
  });

  test('25 correct names have a first word that is not on the verb list', () => {
    const unlisted = sample.correct.filter((n) => s.unlistedFirstWord(n) !== null);
    expect(unlisted).toHaveLength(25);
    expect(unlisted.map((n) => s.unlistedFirstWord(n))).toEqual([
      'Photograph', 'Lapse', 'Invoice', 'Page', 'Snapshot', 'Whitelist', 'Discipline', 'Second', 'Blacklist', 'Apostille',
      'Mill', 'Retool', 'Kit', 'Cash', 'Groom', 'Demo', 'Minute', 'Cater', 'Geocode', 'Invoice', 'Dun', 'Escrow', 'Net',
      'Backtest', 'Courier',
    ]);
  });

  test('a model of all correct names gets one H14 with 10 of its 24 distinct words', () => {
    const lc = { id: 'p', language: 'en', nodes: sample.correct.map((name, i) => ({ id: `t${i}`, type: 'task', name })) };
    const hints = namingHints(lc);
    expect(hints.map((h) => h.code)).toEqual(['H14']);
    expect(hints[0].message).toBe("First word not in the English verb list: 'Photograph', 'Lapse', 'Invoice', 'Page', 'Snapshot', "
      + "'Whitelist', 'Discipline', 'Second', 'Blacklist', 'Apostille' and 14 more. If these are verbs nothing is wrong; "
      + 'add them to "verbs" through BPMN_NAMING to silence this hint.');
  });
});
