import { describe, test, expect } from '@jest/globals';
import { loadLexicon } from './lexicon.js';
import { verbFirst } from './verb-first.js';
import { EVENT_TYPES } from '../types.js';
import { VOCABULARY } from '../../shared/ontology.js';
import { inferMarker, INFERABLE_MARKERS, MARKER_ALLOWED_ON } from './markers.js';

const s = verbFirst(loadLexicon('en'));
const flagged = (j, name) => j(name) !== null;

const DESIGN_43 = [
  'Review application', 'Check order', 'Send invoice', 'Approve request', 'Register claim',
  'Calculate premium', 'Notify customer', 'Create account', 'Update record', 'Close case',
  'Verify identity', 'Assign ticket', 'Print letter', 'Cancel order', 'Collect data', 'Submit form',
];

describe('verb-first strategy shape', () => {
  test('exposes language, word order, examples and the judges', () => {
    expect(s.language).toBe('en');
    expect(s.wordOrder).toBe('verb-first');
    expect(typeof s.examples.task).toBe('string');
    for (const f of ['taskName', 'unlistedFirstWord', 'containerName', 'eventName', 'messageName', 'isQuestion', 'eventMarker']) {
      expect(typeof s[f]).toBe('function');
    }
  });
  test('a verdict is null or { reason }', () => {
    const r = s.taskName('Check');
    expect(typeof r.reason).toBe('string');
    expect(s.taskName('Review application')).toBeNull();
  });
});

describe('taskName', () => {
  test.each([
    ...DESIGN_43,
    'Review application', 'Hand off case', 'Pre-approve loan', financeless(), 'Repair and report',
    '1. Review application', '2) Check order', 'E-mail customer', 'Email customer', 'Sell product',
    'Buy materials', 'Bill customer', 'Decline application', 'Support customer', 'Help user',
    'Finish report', 'Reply to customer', 'Interview candidate', 'Hire employee', 'Chase payment',
    'Triage ticket', 'Refer case', 'Procure goods', 'Prevent fraud', 'Comment on draft',
    'Commit changes', 'Alert on-call', 'Lock account', 'Upgrade system', 'Integrate data', 'Mail letter',
  ])('passes %s', (n) => expect(s.taskName(n)).toBeNull());

  test.each(['Check', 'Checking invoice', 'Invoice checked', 'Path A', 'Follow-up', 'Step 1', 'SAP: Review invoice', '1. 2.'])(
    'flags %s', (n) => expect(flagged(s.taskName, n)).toBe(true));

  test('Re-check order passes', () => expect(s.taskName('Re-check order')).toBeNull());

  describe('M01 flags only on positive evidence of a wrong form', () => {
    test.each([
      ['a single word', 'Escalate'],
      ['no word with a letter after the first', 'Step 3'],
      ['no letter at all', '1. 2.'],
      ['a placeholder noun and a letter', 'Path A'],
      ['a placeholder noun, a letter and a number', 'Option B 2'],
      ['a gerund of a listed verb', 'Checking invoice'],
      ['a gerund with a doubled consonant', 'Shipping order'],
      ['a gerund of a verb with a final e', 'Updating records'],
      ['a gerund of a suffix verb', 'Optimizing costs'],
      ['a participle at the end', 'Invoice checked'],
      ['an irregular participle at the end', 'Contract sent'],
      ['a state word at the end', 'Payment due'],
      ['a verb at the end after a known non-verb', 'Certificate check'],
      ['a frequent adjective, then reversed order', 'Monthly invoice check'],
      ['an action noun after a known non-verb', 'Template approval'],
      ['an -ification noun after a known non-verb', 'Template verification'],
      ['an action noun after a frequent noun', 'Customer registration'],
      ['two words ending in a participle', 'Order shipped'],
      ['two words ending in a participle, any first word', 'Contract signed'],
      ['an auxiliary as second word', 'Invoice is checked'],
      ['to and an auxiliary', 'Invoice to be checked'],
      ['two words: a noun that is also a verb, then a state word', 'Request pending'],
      ['a determiner', 'The invoice'],
      ['a preposition', 'For approval'],
      ['a pronoun', 'Our review of the file'],
      ['an auxiliary', 'Is approved by manager'],
      ['a frequent noun', 'Customer data'],
      ['a frequent adjective', 'Final approval'],
      ['a label prefix', 'SAP: Review invoice'],
    ])('flags %s: %s', (_kind, n) => expect(flagged(s.taskName, n)).toBe(true));

    test.each([
      'Diagnose fault', 'Screen applications', 'Authenticate user', 'Back up data', 'Shut down system',
      'Set up workstation', 'Log in to portal', 'Sign off timesheet', 'Roll back deployment', 'Opt out of tracking',
      'Write off bad debt', 'Wind down operations', 'Stress-test portfolio', 'X-ray chest', 'Double-check figures',
      'Calibrate sensor', 'Duplicate invoice', 'Delegate task', 'Mark invoice as paid', 'Set status to closed',
      'Quality-check part', 'Risk-assess loan', 'Fast-track claim', 'E-sign contract', 'Ensure contract is signed',
      'Handle X', 'Confirm A',
    ])('passes %s without a hint', (n) => {
      expect(s.taskName(n)).toBeNull();
      expect(s.unlistedFirstWord(n)).toBeNull();
    });

    test.each([
      ['Groom backlog', 'Groom'],
      ['Apostille certificate', 'Apostille'],
      ['1. Escrow funds', 'Escrow'],
      ['Kit components for line 2', 'Kit'],
      ['Invoice check', 'Invoice'],
      ['Groom change request', 'Groom'],
      ['Apostille document approval', 'Apostille'],
      ['Hot-desk staff', 'Hot-desk'],
    ])('passes %s; its first word %s is unlisted', (n, word) => {
      expect(s.taskName(n)).toBeNull();
      expect(s.unlistedFirstWord(n)).toBe(word);
    });

    test('unlistedFirstWord is null for a flagged name, a listed verb and a non-string', () => {
      for (const n of ['Checking invoice', 'Invoice checked', 'Check', 'Review application', 'Re-check order', undefined, null, 5, '']) {
        expect(s.unlistedFirstWord(n)).toBeNull();
      }
    });

    test('-ate counts as a verb ending from six letters, less the listed nouns and adjectives', () => {
      expect(s.unlistedFirstWord('Subrogate claim')).toBeNull();
      expect(s.unlistedFirstWord('Abate noise')).toBe('Abate');
      for (const w of ['Candidate', 'Template', 'Climate', 'Private', 'Corporate', 'Accurate', 'Appropriate', 'Surrogate']) {
        expect(s.unlistedFirstWord(`${w} notes`)).toBe(w);
      }
    });
  });
  test('non-strings never throw', () => {
    for (const v of [undefined, null, 5, {}, [], '']) expect(() => s.taskName(v)).not.toThrow();
    expect(flagged(s.taskName, undefined)).toBe(true);
  });
});
function financeless() { return 'Re-check order'; }

describe('containerName', () => {
  test.each([
    'Claims handling', 'Onboarding', 'Order fulfilment', 'Handle case', 'Call rating', 'Credit check',
    'Background check', 'Quality control', 'Customer support', 'Account setup', 'Month-end close',
    'Fraud review', 'Hire to retire', 'Intake', 'Customer need', 'Newsfeed',
  ])('passes %s', (n) => expect(s.containerName(n)).toBeNull());
  test.each(['Validate', 'Archive', 'Review', 'Order received'])('flags %s', (n) =>
    expect(flagged(s.containerName, n)).toBe(true));
});

describe('eventName', () => {
  test.each([
    'Application received', '7 days elapsed', 'Archive start', 'Start X', 'Order channel open', 'Lead score high',
    'Build broken', 'Pay day', 'Read receipt', 'Merge conflict', 'Train arrival', 'Close of business',
    'Repeat order', 'Clear signal', 'Edit lock', 'Extract file', 'Produce batch', 'Fill level low',
    'Follow-up meeting', 'Follow-up', 'Pay-out', 'Clean-up', 'Close date agreed',
  ])('passes %s', (n) => expect(s.eventName(n)).toBeNull());
  test.each(['Send invoice', 'Notify customer'])('flags %s', (n) => expect(flagged(s.eventName, n)).toBe(true));
});

describe('messageName', () => {
  test.each([
    'Request for details', 'Register query', 'Customer need', 'Data set', 'Lead details', 'Build artifacts',
    'Pay slip', 'Read receipt', 'Pay run', 'Train schedule', 'Merge request', 'Follow-up', 'Pay-out', 'Clean-up', 'Newsfeed',
  ])('passes %s', (n) => expect(s.messageName(n)).toBeNull());
  test.each(['Send invoice', 'Order received', 'Case closed'])('flags %s', (n) =>
    expect(flagged(s.messageName, n)).toBe(true));

  describe('a message noun at the end', () => {
    test.each(['Deploy request', 'Sell order', 'Renew offer', 'Print invoice'])(
      'exempts %s from the verb-first branch', (n) => expect(s.messageName(n)).toBeNull());
    test.each(['Send invoice', 'Submit application', 'Transmit report', 'Resend reminder', 'Approve order', 'Confirm order',
      'Cancel order', 'Approve request', 'Notify customer', 'Deploy requested', 'Approve invoice received'])(
      'not when the verb sends or decides on the message, the last word is no message noun or a participle: flags %s', (n) =>
        expect(flagged(s.messageName, n)).toBe(true));
  });
});

describe('isQuestion', () => {
  test.each([['Complete?', true], ['Complete\n?', true], ['Complete', false], ['', false]])('%j', (n, e) =>
    expect(s.isQuestion(n)).toBe(e));
});

describe('markers', () => {
  test.each([
    ['Deadline missed', 'endEvent', null],
    ['Deadline missed', 'boundaryEvent', 'timer'],
    ['Emails received', 'startEvent', 'message'],
    ['Error raised', 'endEvent', 'error'],
    ['Error raised', 'startEvent', null],
    ['Something', 'startEvent', null],
  ])('inferMarker(%s, %s) = %s', (n, t, e) => {
    expect(inferMarker(loadLexicon('en'), n, t)).toBe(e);
    expect(s.eventMarker(n, t)).toBe(e);
  });
  test('tables', () => {
    expect(INFERABLE_MARKERS).toEqual(['message', 'timer', 'error', 'signal', 'escalation', 'conditional']);
    expect(MARKER_ALLOWED_ON.timer).toEqual(['startEvent', 'intermediateCatchEvent', 'boundaryEvent']);
  });
  test('the tables only name ontology markers and event types', () => {
    const markers = new Set(VOCABULARY.markerNames());
    for (const m of INFERABLE_MARKERS) expect(markers.has(m)).toBe(true);
    expect(Object.keys(MARKER_ALLOWED_ON)).toEqual(INFERABLE_MARKERS);
    for (const types of Object.values(MARKER_ALLOWED_ON)) for (const t of types) expect(EVENT_TYPES.has(t)).toBe(true);
  });
  test('first matching marker decides, no fall-through', () => {
    // message precedes timer; timer precedes error, and timer is illegal on endEvent: null, not error
    expect(inferMarker(loadLexicon('en'), 'Deadline message', 'startEvent')).toBe('message');
    expect(inferMarker(loadLexicon('en'), 'Deadline error', 'endEvent')).toBeNull();
  });
});

describe('compoundMarkers is a language switch', () => {
  const en = loadLexicon('en');
  const withTimer = (compoundMarkers) => ({ ...en, compoundMarkers, eventMarkers: { ...en.eventMarkers, timer: ['frist'] } });
  const on = withTimer(true);
  test.each([
    ['Fristablauf', 'timer'],
    ['Zahlungsfrist abgelaufen', 'timer'],
    ['Frist abgelaufen', 'timer'],
    ['Fristen', null],
    ['Erfrist', null],
    ['Frist2024', null],
  ])('on: inferMarker(%s) = %s', (n, e) => {
    expect(inferMarker(on, n, 'boundaryEvent')).toBe(e);
  });
  test('off: compounds do not match, exact still does', () => {
    expect(inferMarker(withTimer(undefined), 'Fristablauf', 'boundaryEvent')).toBeNull();
    expect(inferMarker(withTimer(false), 'Zahlungsfrist abgelaufen', 'boundaryEvent')).toBeNull();
    expect(inferMarker(withTimer(undefined), 'Frist abgelaufen', 'boundaryEvent')).toBe('timer');
  });
});

describe('Review Focus 4: robustness and linear time', () => {
  const huge = ['a'.repeat(200000), ('(' + 'x ').repeat(50000), 'Check ' + 'order '.repeat(50000), '-'.repeat(100000), '\n'.repeat(100000)];
  test.each(huge.map((h, i) => [i, h]))('input %i never throws and finishes fast', (_i, h) => {
    const t = Date.now();
    for (const f of ['taskName', 'containerName', 'eventName', 'messageName', 'isQuestion']) expect(() => s[f](h)).not.toThrow();
    for (const t2 of ['startEvent', 'boundaryEvent']) expect(() => s.eventMarker(h, t2)).not.toThrow();
    // Generous wall-clock bound (catastrophic behaviour is orders of magnitude slower); the
    // scaling test below is the real guard against super-linear time.
    expect(Date.now() - t).toBeLessThan(10000);
  });
  describe('time scales sub-quadratically: 16n costs less than 64 times n', () => {
    // Quadratic growth would give about 256; linear about 16. Each timing repeats the calls, so the
    // base run is well above timer resolution, and the better of two ratios is used.
    const shapes = [
      ['Check order', (k) => 'Check ' + 'order '.repeat(k), 1500],
      ['hyphen chain', (k) => 'Check' + '-order'.repeat(k), 1500],
    ];
    test.each(shapes)('%s', (_n, make, base) => {
      const cost = (k) => {
        const h = make(k);
        const t = performance.now();
        for (let r = 0; r < 3; r++) {
          for (const fn of ['taskName', 'eventName', 'isQuestion']) s[fn](h);
          s.eventMarker(h, 'startEvent');
        }
        return Math.max(performance.now() - t, 0.5);
      };
      cost(base); // warm-up
      const ratio = () => cost(base * 16) / cost(base);
      expect(Math.min(ratio(), ratio())).toBeLessThan(64);
    });
  });
  test('non-string input never throws', () => {
    for (const v of [undefined, null, 1, {}, [], Symbol.iterator]) {
      for (const f of ['taskName', 'containerName', 'eventName', 'messageName', 'isQuestion']) expect(() => s[f](v)).not.toThrow();
      expect(() => s.eventMarker(v, 'startEvent')).not.toThrow();
    }
  });
});
