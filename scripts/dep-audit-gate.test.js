import { describe, test, expect } from '@jest/globals';
import { evaluate, resolveAdvisories, validatePolicy, scanSources, ToolingError } from '../.github/scripts/dep-audit-gate.mjs';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const NOW = new Date('2026-07-25T12:00:00Z');

// Report shapes below mirror real `npm audit --json` output (auditReportVersion 2).
const advisory = (ghsa, severity = 'high') => ({
  source: 1234, name: 'x', severity, url: `https://github.com/advisories/${ghsa}`,
});

const report = (vulnerabilities) => ({ auditReportVersion: 2, vulnerabilities });

const basePolicy = (exceptions = []) => ({
  policy: { failOn: ['critical', 'high'], warnOn: ['moderate', 'low'], expiryWarningDays: 14, maxExceptionDays: 180 },
  sourceScan: { roots: ['scripts'], exclude: ['node_modules'], extensions: ['.js', '.mjs'] },
  exceptions,
});

const exception = (over = {}) => ({
  id: 'test-exception',
  packages: ['risky'],
  maxSeverity: 'high',
  scope: 'dev',
  advisories: ['GHSA-aaaa-bbbb-cccc'],
  acceptNewAdvisories: false,
  reason: 'Test reason. Second sentence.',
  whyNotFixed: 'Test.',
  reviewTrigger: 'Test.',
  opened: '2026-07-01',
  expires: '2026-09-01',
  ...over,
});

const run = (auditReport, policy, extra = {}) =>
  evaluate({ auditReport, prodAuditReport: report({}), policy, now: NOW, ...extra });

describe('dep-audit-gate — evaluate', () => {
  test('clean report yields nothing', () => {
    const r = run(report({}), basePolicy());
    expect(r).toEqual({ violations: [], warnings: [], exempt: [] });
  });

  test('unexempted high is a violation', () => {
    const r = run(report({ risky: { severity: 'high', via: [advisory('GHSA-aaaa-bbbb-cccc')] } }), basePolicy());
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ pkg: 'risky', reason: 'unexempted', severity: 'high' });
  });

  test('unexempted moderate only warns', () => {
    const r = run(report({ risky: { severity: 'moderate', via: [advisory('GHSA-aaaa-bbbb-cccc', 'moderate')] } }), basePolicy());
    expect(r.violations).toHaveLength(0);
    expect(r.warnings[0]).toMatchObject({ pkg: 'risky', reason: 'below-threshold' });
  });

  test('a valid unexpired exception makes it exempt', () => {
    const r = run(
      report({ risky: { severity: 'high', via: [advisory('GHSA-aaaa-bbbb-cccc')] } }),
      basePolicy([exception()]),
    );
    expect(r.violations).toHaveLength(0);
    expect(r.exempt).toHaveLength(1);
    expect(r.exempt[0]).toMatchObject({ pkg: 'risky', exception: 'test-exception' });
  });

  test('an expired exception fails loudly rather than lapsing silently', () => {
    const r = run(
      report({ risky: { severity: 'high', via: [advisory('GHSA-aaaa-bbbb-cccc')] } }),
      basePolicy([exception({ opened: '2026-01-01', expires: '2026-06-01' })]),
    );
    expect(r.violations[0]).toMatchObject({ reason: 'expired' });
    expect(r.exempt).toHaveLength(0);
  });

  test('severity above the exception cap is a violation', () => {
    const r = run(
      report({ risky: { severity: 'critical', via: [advisory('GHSA-aaaa-bbbb-cccc', 'critical')] } }),
      basePolicy([exception({ maxSeverity: 'high' })]),
    );
    expect(r.violations[0]).toMatchObject({ reason: 'severity-escalation' });
  });

  test('an advisory id absent from the exception is a violation when acceptNewAdvisories is false', () => {
    const r = run(
      report({ risky: { severity: 'high', via: [advisory('GHSA-aaaa-bbbb-cccc'), advisory('GHSA-9999-9999-9999')] } }),
      basePolicy([exception()]),
    );
    expect(r.violations[0]).toMatchObject({ reason: 'new-advisory' });
    expect(r.violations[0].detail).toContain('GHSA-9999-9999-9999');
  });

  test('acceptNewAdvisories true tolerates an unrecorded advisory', () => {
    const r = run(
      report({ risky: { severity: 'high', via: [advisory('GHSA-9999-9999-9999')] } }),
      basePolicy([exception({ acceptNewAdvisories: true })]),
    );
    expect(r.violations).toHaveLength(0);
    expect(r.exempt).toHaveLength(1);
  });

  test('a dev-scoped exception is void once the package appears in the production tree', () => {
    const r = evaluate({
      auditReport: report({ risky: { severity: 'high', via: [advisory('GHSA-aaaa-bbbb-cccc')] } }),
      prodAuditReport: report({ risky: { severity: 'high', via: [advisory('GHSA-aaaa-bbbb-cccc')] } }),
      policy: basePolicy([exception({ scope: 'dev' })]),
      now: NOW,
    });
    expect(r.violations[0]).toMatchObject({ reason: 'scope-escaped-to-production' });
  });

  test('the reachability guard voids the exception when the specifier is imported', () => {
    const r = run(
      report({ risky: { severity: 'high', via: [advisory('GHSA-aaaa-bbbb-cccc')] } }),
      basePolicy([exception({ voidIf: { importsFound: ['SSEServerTransport'] } })]),
      { sourceHits: { SSEServerTransport: ['scripts/somewhere.js'] } },
    );
    expect(r.violations[0]).toMatchObject({ reason: 'reachability-guard-tripped' });
    expect(r.violations[0].detail).toContain('scripts/somewhere.js');
  });

  test('an exception matching no finding warns as unused', () => {
    const r = run(report({}), basePolicy([exception()]));
    expect(r.warnings[0]).toMatchObject({ reason: 'unused-exception' });
  });

  test('an exception expiring within the warning window warns while staying exempt', () => {
    const r = run(
      report({ risky: { severity: 'high', via: [advisory('GHSA-aaaa-bbbb-cccc')] } }),
      basePolicy([exception({ opened: '2026-07-01', expires: '2026-08-01' })]),
    );
    expect(r.exempt).toHaveLength(1);
    expect(r.warnings.find((w) => w.reason === 'expiring-soon')).toBeDefined();
  });

  test('one exception covers every package of an effects chain', () => {
    const r = run(
      report({
        '@hono/node-server': { severity: 'moderate', via: [advisory('GHSA-frvp-7c67-39w9', 'moderate')] },
        '@modelcontextprotocol/sdk': { severity: 'moderate', via: ['@hono/node-server'] },
      }),
      basePolicy([exception({
        packages: ['@hono/node-server', '@modelcontextprotocol/sdk'],
        maxSeverity: 'moderate', scope: 'prod',
        advisories: ['GHSA-frvp-7c67-39w9'],
      })]),
    );
    expect(r.violations).toHaveLength(0);
    expect(r.exempt).toHaveLength(2);
  });
});

// These pin the fail-open paths found by the security audit of 2026-07-25. Each
// one previously let a finding through silently; the point of the test is that
// the gate now refuses rather than shrugs.
describe('dep-audit-gate — must fail closed, not open', () => {
  test('a finding with no severity is a tooling error, not a silent drop', () => {
    // Previously: failOn.includes(undefined) and warnOn.includes(undefined) are
    // both false, so the finding vanished from violations AND warnings.
    expect(() => run(report({ risky: { via: [advisory('GHSA-aaaa-bbbb-cccc')] } }), basePolicy()))
      .toThrow(ToolingError);
  });

  test('a severity the gate does not know is a tooling error', () => {
    expect(() => run(report({ risky: { severity: 'HIGH', via: [advisory('GHSA-aaaa-bbbb-cccc')] } }), basePolicy()))
      .toThrow(/cannot classify/);
  });

  test('an unparseable expiry counts as expired rather than exempt', () => {
    // Unreachable via main() — validatePolicy rejects it first — but evaluate()
    // is exported, and `nowMs > NaN` is false, which would have exempted.
    const r = run(
      report({ risky: { severity: 'high', via: [advisory('GHSA-aaaa-bbbb-cccc')] } }),
      basePolicy([exception({ expires: 'not-a-date' })]),
    );
    expect(r.exempt).toHaveLength(0);
    expect(r.violations[0]).toMatchObject({ reason: 'expired' });
  });

  test('a future-dated `opened` cannot smuggle an unbounded exception past the cap', () => {
    // The original cap measured expires-opened only. opened 2099-01-01 /
    // expires 2099-06-15 is a compliant-looking 165 days, yet `now > expires`
    // stays false for decades — exempting even a critical finding indefinitely.
    expect(() => validatePolicy(
      basePolicy([exception({ opened: '2099-01-01', expires: '2099-06-15' })]),
      NOW.getTime(),
    )).toThrow(/in the future/);
  });

  test('an expiry further away than maxExceptionDays is rejected even with a valid window', () => {
    expect(() => validatePolicy(
      basePolicy([exception({ opened: '2026-07-25', expires: '2027-06-01' })]),
      NOW.getTime(),
    )).toThrow(/maxExceptionDays/);
  });

  test('a normal exception opened today and expiring inside the cap still passes', () => {
    expect(() => validatePolicy(
      basePolicy([exception({ opened: '2026-07-25', expires: '2026-10-23' })]),
      NOW.getTime(),
    )).not.toThrow();
  });
});

describe('dep-audit-gate — resolveAdvisories', () => {
  test('resolves a string via to the advisory of the package it points at', () => {
    // The live shape: express-rate-limit carries via:["ip-address"] and no advisory object.
    const r = report({
      'ip-address': { severity: 'moderate', via: [advisory('GHSA-v2v4-v2v4-v2v4', 'moderate')] },
      'express-rate-limit': { severity: 'moderate', via: ['ip-address'] },
    });
    expect([...resolveAdvisories('express-rate-limit', r)]).toEqual(['GHSA-v2v4-v2v4-v2v4']);
  });

  test('terminates on a cyclic via chain', () => {
    const r = report({ a: { severity: 'high', via: ['b'] }, b: { severity: 'high', via: ['a'] } });
    expect(() => resolveAdvisories('a', r)).not.toThrow();
    expect([...resolveAdvisories('a', r)]).toEqual([]);
  });

  test('an unknown package resolves to nothing rather than throwing', () => {
    expect([...resolveAdvisories('nope', report({}))]).toEqual([]);
  });
});

describe('dep-audit-gate — validatePolicy', () => {
  test('accepts the policy actually committed to this repo', () => {
    const committed = JSON.parse(readFileSync(resolve(REPO_ROOT, '.github/dependency-policy.json'), 'utf8'));
    expect(() => validatePolicy(committed)).not.toThrow();
  });

  test.each(['id', 'packages', 'maxSeverity', 'scope', 'reason', 'whyNotFixed', 'reviewTrigger', 'opened', 'expires'])(
    'rejects an exception missing "%s"', (field) => {
      const e = exception();
      delete e[field];
      expect(() => validatePolicy(basePolicy([e]))).toThrow(new RegExp(field));
    },
  );

  test('rejects a lifetime beyond maxExceptionDays', () => {
    expect(() => validatePolicy(basePolicy([exception({ opened: '2026-01-01', expires: '2027-12-31' })])))
      .toThrow(/maxExceptionDays/);
  });

  test('rejects duplicate exception ids', () => {
    expect(() => validatePolicy(basePolicy([exception(), exception()]))).toThrow(/duplicate/);
  });

  test('rejects acceptNewAdvisories=false without an advisories list', () => {
    const e = exception();
    delete e.advisories;
    expect(() => validatePolicy(basePolicy([e]))).toThrow(/advisories/);
  });

  test('rejects an unknown severity', () => {
    expect(() => validatePolicy(basePolicy([exception({ maxSeverity: 'spicy' })]))).toThrow(/maxSeverity/);
  });
});

describe('dep-audit-gate — scanSources', () => {
  const cfg = {
    roots: ['scripts'], exclude: ['node_modules', 'coverage'],
    excludeFiles: ['.test.js'], extensions: ['.js', '.mjs'],
  };

  test('finds a specifier that is genuinely imported (positive control)', () => {
    const hits = scanSources(REPO_ROOT, cfg, ['StdioServerTransport']);
    expect(hits.StdioServerTransport?.some((f) => f.endsWith('mcp-bpmn-server.js'))).toBe(true);
  });

  test('the guarded HTTP-transport specifiers are absent from product code — the claim the policy rests on', () => {
    const guards = ['StreamableHTTPServerTransport', 'SSEServerTransport', 'serveStatic', "from 'express'"];
    expect(scanSources(REPO_ROOT, cfg, guards)).toEqual({});
  });

  test('test files are excluded — this file names every guarded specifier above, and must not count', () => {
    const guards = ['StreamableHTTPServerTransport', 'SSEServerTransport', 'serveStatic'];
    const withoutExclusion = scanSources(REPO_ROOT, { ...cfg, excludeFiles: [] }, guards);
    // Without the exclusion the guard trips on this very file — that is the regression being pinned.
    expect(withoutExclusion.SSEServerTransport?.some((f) => f.endsWith('dep-audit-gate.test.js'))).toBe(true);
    expect(scanSources(REPO_ROOT, cfg, guards)).toEqual({});
  });

  test('no specifiers means no filesystem walk', () => {
    expect(scanSources(REPO_ROOT, cfg, [])).toEqual({});
  });

  test('a configured root that does not exist is tolerated', () => {
    expect(() => scanSources(REPO_ROOT, { ...cfg, roots: ['does-not-exist'] }, ['x'])).not.toThrow();
  });
});
