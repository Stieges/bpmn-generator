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
    for (const f of ['taskName', 'containerName', 'eventName', 'messageName', 'isQuestion', 'eventMarker']) {
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

  test.each(['Check', 'Checking invoice', 'Invoice check', 'Path A', 'Follow-up', 'Step 1', 'SAP: Review invoice', '1. 2.'])(
    'flags %s', (n) => expect(flagged(s.taskName, n)).toBe(true));

  test('Re-check order passes', () => expect(s.taskName('Re-check order')).toBeNull());
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
    'Fraud review', 'Hire to retire', 'Intake', 'Customer need',
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
    'Pay slip', 'Read receipt', 'Pay run', 'Train schedule', 'Merge request', 'Follow-up', 'Pay-out', 'Clean-up',
  ])('passes %s', (n) => expect(s.messageName(n)).toBeNull());
  test.each(['Send invoice', 'Order received', 'Case closed'])('flags %s', (n) =>
    expect(flagged(s.messageName, n)).toBe(true));
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
  test('time scales sub-quadratically: 4n costs less than 16 times n', () => {
    const make = (k) => 'Check ' + 'order '.repeat(k);
    const cost = (k) => {
      const h = make(k);
      const t = performance.now();
      for (const fn of ['taskName', 'eventName', 'isQuestion']) s[fn](h);
      s.eventMarker(h, 'startEvent');
      return Math.max(performance.now() - t, 1);
    };
    const ratio = () => cost(40000) / cost(10000);
    // One retry: a load spike in one measurement must not fail a sound implementation.
    expect(Math.min(ratio(), ratio())).toBeLessThan(16);
  });
  test('non-string input never throws', () => {
    for (const v of [undefined, null, 1, {}, [], Symbol.iterator]) {
      for (const f of ['taskName', 'containerName', 'eventName', 'messageName', 'isQuestion']) expect(() => s[f](v)).not.toThrow();
      expect(() => s.eventMarker(v, 'startEvent')).not.toThrow();
    }
  });
});
