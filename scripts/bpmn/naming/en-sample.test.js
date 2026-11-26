/**
 * English M01 against a sample of task names written before the judge was measured
 * (`tests/fixtures/naming/en-task-names.json`): correct names give no finding, clearly wrong ones
 * are flagged, and the correct names whose first word is not on the verb list are counted (H14).
 * `heldOut` holds names a reviewer wrote later; they were not used to grow the word lists.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLexicon } from './lexicon.js';
import { labelTokens } from './tokens.js';
import { verbFirst } from './verb-first.js';
import { namingHints } from './index.js';

const sample = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'naming', 'en-task-names.json'), 'utf8'));
const lexicon = loadLexicon('en');
const s = verbFirst(lexicon);
const missedOf = (names) => names.filter((n) => s.taskName(n) === null);
const unlistedOf = (names) => names.map((n) => s.unlistedFirstWord(n)).filter((w) => w !== null);

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

  test('85 % of the wrong names are flagged (98 of 115); the misses are pinned', () => {
    const missed = missedOf(sample.wrong);
    expect(missed).toEqual([
      'Form complete', 'Invoice check', 'Credit check', 'Document review', 'Account update', 'Address change',
      'Stock count', 'Price quote', 'Contract management', 'Invoice approval', 'Order fulfilment', 'Credit decision',
      'Purchase requisition', 'Expense report', 'Process step 4', 'Order pick', 'Change request',
    ]);
    expect((sample.wrong.length - missed.length) / sample.wrong.length).toBeGreaterThanOrEqual(0.85);
  });

  test('24 correct names have a first word that is not on the verb list', () => {
    expect(unlistedOf(sample.correct)).toEqual([
      'Photograph', 'Lapse', 'Invoice', 'Page', 'Snapshot', 'Whitelist', 'Discipline', 'Second', 'Blacklist', 'Apostille',
      'Mill', 'Retool', 'Kit', 'Cash', 'Groom', 'Demo', 'Minute', 'Cater', 'Geocode', 'Invoice', 'Dun', 'Escrow', 'Net',
      'Backtest',
    ]);
  });

  test('a model of all correct names gets one H14 with 10 of its 23 distinct words', () => {
    const lc = { id: 'p', language: 'en', nodes: sample.correct.map((name, i) => ({ id: `t${i}`, type: 'task', name })) };
    const hints = namingHints(lc);
    expect(hints.map((h) => h.code)).toEqual(['H14']);
    expect(hints[0].message).toBe("First word not in the English verb list: 'Photograph', 'Lapse', 'Invoice', 'Page', 'Snapshot', "
      + "'Whitelist', 'Discipline', 'Second', 'Blacklist', 'Apostille' and 13 more. If these are verbs nothing is wrong; "
      + 'add them to "verbs" through BPMN_NAMING to silence this hint.');
  });
});

describe('the held-out names', () => {
  const held = sample.heldOut;

  test('143 correct and 55 wrong names, none twice', () => {
    expect(held.correct).toHaveLength(143);
    expect(held.wrong).toHaveLength(55);
    expect(new Set(held.correct).size).toBe(143);
    expect(new Set(held.wrong).size).toBe(55);
  });

  test('no correct name is an M01 finding', () => {
    expect(held.correct.filter((n) => s.taskName(n) !== null)).toEqual([]);
  });

  test('48 of 55 wrong names are flagged; the misses are pinned', () => {
    expect(missedOf(held.wrong)).toEqual([
      'Invoice approval', 'Invoice check', 'Contract review', 'Invoice verification', 'Order entry', 'Claim registration',
      'Loan disbursement',
    ]);
  });

  test('34 correct names have a first word that is not on the verb list', () => {
    expect(unlistedOf(held.correct)).toHaveLength(34);
  });
});

describe('a shorter verb list gives more hints, never more findings', () => {
  // For every name of both samples and every word of it on the verb list: the judge without that
  // verb flags the name only if the judge with it does. Synthetic hyphen groups (a gerund or a
  // starter word joined to a verb) and to-be shapes are added, the shapes a verb test reads.
  const VERBS = ['check', 'confirm', 'review', 'approve', 'track', 'sign'];
  const synthetic = ['Billing', 'Booking', 'Shipping', 'Customer', 'The', 'Phase'].flatMap((w) => VERBS.map((v) => `${w}-${v} unit`));
  const names = [...sample.correct, ...sample.wrong, ...sample.heldOut.correct, ...sample.heldOut.wrong, ...synthetic,
    'Design to-be process', 'Step up KYC checks', 'Team up with partner', 'Phase out legacy system'];
  test('over every sample name and each of its listed words', () => {
    const added = [];
    let checked = 0;
    for (const name of names) {
      const before = s.taskName(name) !== null;
      for (const { folded } of labelTokens(name).tokens) {
        if (!lexicon.verbs.has(folded)) continue;
        const verbs = new Set(lexicon.verbs);
        verbs.delete(folded);
        const after = verbFirst({ ...lexicon, verbs }).taskName(name) !== null;
        if (after && !before) added.push(`${name} without "${folded}"`);
        checked++;
      }
    }
    expect(added).toEqual([]);
    expect(checked).toBeGreaterThan(749);
  });

  test('over every sample name and each verb phrase that opens it', () => {
    const added = [];
    let checked = 0;
    for (const name of names) {
      const before = s.taskName(name) !== null;
      const folded = labelTokens(name).tokens.map((t) => t.folded);
      lexicon.verbPhrases.forEach((phrase, i) => {
        if (!phrase.every((w, j) => folded[j] === w)) return;
        const verbPhrases = lexicon.verbPhrases.filter((_, j) => j !== i);
        if (verbFirst({ ...lexicon, verbPhrases }).taskName(name) !== null && !before) added.push(`${name} without "${phrase.join(' ')}"`);
        checked++;
      });
    }
    expect(added).toEqual([]);
    expect(checked).toBeGreaterThan(40);
  });

  test('no verb phrase starts with a word of the starter lists', () => {
    for (const phrase of lexicon.verbPhrases) {
      expect([phrase[0], lexicon.nounStarters.has(phrase[0]) || lexicon.nonVerbStarters.has(phrase[0])]).toEqual([phrase[0], false]);
    }
  });

  test('a correct name whose first word is removed from the list gets the hint instead', () => {
    const { folded } = labelTokens('Diagnose fault').tokens[0];
    const verbs = new Set(lexicon.verbs);
    verbs.delete(folded);
    const without = verbFirst({ ...lexicon, verbs });
    expect(without.taskName('Diagnose fault')).toBeNull();
    expect(without.unlistedFirstWord('Diagnose fault')).toBe('Diagnose');
  });
});
