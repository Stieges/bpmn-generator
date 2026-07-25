#!/usr/bin/env node
/**
 * dep-audit-gate — CI gate over `npm audit`.
 *
 * Fails the build on high/critical advisories that are not covered by a valid,
 * unexpired, justified exception in .github/dependency-policy.json.
 *
 * Not to be confused with scripts/audit.js, which is the HTTP API's append-only
 * JSONL audit log. This file is CI policy, not library code — hence it lives
 * under .github/ and stays out of the npm package and the skill bundle.
 *
 * Usage:
 *   node .github/scripts/dep-audit-gate.mjs [--policy <path>] [--dir <npm root>]
 *                                           [--json] [--summary]
 *
 * Exit codes:
 *   0  clean, or every failing-severity finding is validly exempted
 *   1  policy violation
 *   2  tooling error (audit unrunnable, policy malformed) — never passes silently
 *
 * No dependencies: node: builtins only.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY = resolve(HERE, '..', 'dependency-policy.json');
const DEFAULT_DIR = resolve(HERE, '..', '..', 'scripts');

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const REQUIRED_EXCEPTION_FIELDS = [
  'id', 'packages', 'maxSeverity', 'scope', 'reason', 'whyNotFixed',
  'reviewTrigger', 'opened', 'expires',
];

class ToolingError extends Error {}

// ---------------------------------------------------------------- audit input

/**
 * `npm audit` exits 1 whenever any vulnerability exists, so execFileSync throws
 * on the normal path. The report is on stdout either way.
 */
function runAudit(dir, extraArgs = []) {
  const args = ['audit', '--json', '--package-lock-only', ...extraArgs];
  let stdout;
  try {
    stdout = execFileSync('npm', args, { cwd: dir, encoding: 'utf8', maxBuffer: 1e8 });
  } catch (err) {
    stdout = err.stdout;
    if (!stdout) {
      throw new ToolingError(
        `could not run \`npm ${args.join(' ')}\` in ${dir}: ${err.shortMessage ?? err.message}`,
      );
    }
  }

  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new ToolingError(`\`npm audit\` produced output that is not JSON (network? npm version?)`);
  }
  if (report.error) {
    throw new ToolingError(`\`npm audit\` reported an error: ${report.error.summary ?? report.error.code}`);
  }
  if (report.auditReportVersion !== 2) {
    throw new ToolingError(
      `unexpected auditReportVersion ${report.auditReportVersion} (expected 2) — refusing to interpret`,
    );
  }
  return report;
}

/**
 * Collect the GHSA ids behind a finding. `via` entries are either advisory
 * objects or plain package-name strings pointing at another finding — the live
 * case being `@modelcontextprotocol/sdk` with `via: ["@hono/node-server"]`.
 * Cycles are possible, hence `seen`.
 */
export function resolveAdvisories(name, report, seen = new Set()) {
  const ids = new Set();
  if (seen.has(name)) return ids;
  seen.add(name);

  const finding = report.vulnerabilities?.[name];
  if (!finding) return ids;

  for (const via of finding.via ?? []) {
    if (typeof via === 'string') {
      for (const id of resolveAdvisories(via, report, seen)) ids.add(id);
    } else if (via.url) {
      ids.add(via.url.split('/').pop());
    } else if (via.source != null) {
      ids.add(String(via.source));
    }
  }
  return ids;
}

// ------------------------------------------------------------ reachability

/**
 * Grep first-party sources for the specifiers an exception claims are never
 * imported. This turns "unreachable" into a machine-checked claim rather than a
 * comment that rots. Only .js/.mjs — otherwise prose in a .md mentioning "hono"
 * would trip the guard.
 *
 * `excludeFiles` keeps the question at "does *product* code reach this?".
 * Test files necessarily name the guarded specifiers in order to test the guard;
 * counting those would make the gate trip over its own test suite.
 */
export function scanSources(root, scanConfig, specifiers) {
  const hits = {};
  if (!specifiers?.length) return hits;

  const roots = scanConfig?.roots ?? [];
  const exclude = new Set(scanConfig?.exclude ?? ['node_modules', '.git']);
  const excludeFiles = scanConfig?.excludeFiles ?? ['.test.js'];
  const extensions = new Set(scanConfig?.extensions ?? ['.js', '.mjs']);

  const inspect = (file) => {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    for (const spec of specifiers) {
      if (content.includes(spec)) (hits[spec] ??= []).push(file);
    }
  };

  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a configured root that does not exist is not an error
    }
    for (const entry of entries) {
      if (exclude.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        entry.isFile() &&
        extensions.has(extname(entry.name)) &&
        !excludeFiles.some((suffix) => entry.name.endsWith(suffix))
      ) inspect(full);
    }
  };

  for (const r of roots) {
    const full = resolve(root, r);
    try {
      if (statSync(full).isDirectory()) walk(full);
    } catch { /* missing root — ignore */ }
  }
  return hits;
}

// ------------------------------------------------------------------ policy

export function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object') throw new ToolingError('policy file is not an object');
  const p = policy.policy;
  if (!p || !Array.isArray(p.failOn) || !Array.isArray(p.warnOn)) {
    throw new ToolingError('policy.failOn and policy.warnOn must be arrays');
  }
  for (const sev of [...p.failOn, ...p.warnOn]) {
    if (!(sev in SEVERITY_RANK)) throw new ToolingError(`unknown severity "${sev}" in policy`);
  }
  if (!Array.isArray(policy.exceptions)) throw new ToolingError('policy.exceptions must be an array');

  const ids = new Set();
  for (const e of policy.exceptions) {
    for (const field of REQUIRED_EXCEPTION_FIELDS) {
      if (e[field] === undefined || e[field] === null || e[field] === '') {
        throw new ToolingError(`exception "${e.id ?? '<no id>'}" is missing required field "${field}"`);
      }
    }
    if (ids.has(e.id)) throw new ToolingError(`duplicate exception id "${e.id}"`);
    ids.add(e.id);
    if (!Array.isArray(e.packages) || e.packages.length === 0) {
      throw new ToolingError(`exception "${e.id}": packages must be a non-empty array`);
    }
    if (!(e.maxSeverity in SEVERITY_RANK)) {
      throw new ToolingError(`exception "${e.id}": unknown maxSeverity "${e.maxSeverity}"`);
    }
    if (!['dev', 'prod', 'any'].includes(e.scope)) {
      throw new ToolingError(`exception "${e.id}": scope must be dev|prod|any`);
    }
    const opened = Date.parse(e.opened);
    const expires = Date.parse(e.expires);
    if (Number.isNaN(opened)) throw new ToolingError(`exception "${e.id}": opened is not a date`);
    if (Number.isNaN(expires)) throw new ToolingError(`exception "${e.id}": expires is not a date`);
    const days = (expires - opened) / 86_400_000;
    const max = p.maxExceptionDays ?? 180;
    if (days > max) {
      throw new ToolingError(
        `exception "${e.id}": lifetime of ${Math.round(days)} days exceeds policy.maxExceptionDays (${max})`,
      );
    }
    if (e.acceptNewAdvisories === false && !Array.isArray(e.advisories)) {
      throw new ToolingError(`exception "${e.id}": acceptNewAdvisories=false requires an advisories array`);
    }
  }
  return policy;
}

// -------------------------------------------------------------- evaluation

/**
 * Pure. Everything above this line does I/O; everything here is testable.
 */
export function evaluate({ auditReport, prodAuditReport, policy, sourceHits = {}, now }) {
  const violations = [];
  const warnings = [];
  const exempt = [];
  const { failOn, warnOn, expiryWarningDays = 14 } = policy.policy;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const usedExceptions = new Set();

  const findException = (pkg) =>
    policy.exceptions.find((e) => e.packages.includes(pkg));

  for (const [pkg, finding] of Object.entries(auditReport.vulnerabilities ?? {})) {
    const severity = finding.severity;
    const advisories = [...resolveAdvisories(pkg, auditReport)];
    const exception = findException(pkg);

    if (!exception) {
      if (failOn.includes(severity)) {
        violations.push({ pkg, severity, advisories, reason: 'unexempted',
          detail: 'no exception covers this package' });
      } else if (warnOn.includes(severity)) {
        warnings.push({ pkg, severity, advisories, reason: 'below-threshold' });
      }
      continue;
    }

    usedExceptions.add(exception.id);
    const expiresMs = Date.parse(exception.expires);

    if (nowMs > expiresMs) {
      violations.push({ pkg, severity, advisories, reason: 'expired', exception: exception.id,
        detail: `exception expired ${exception.expires} — re-review, do not extend blindly` });
      continue;
    }
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[exception.maxSeverity]) {
      violations.push({ pkg, severity, advisories, reason: 'severity-escalation', exception: exception.id,
        detail: `now ${severity}, exception caps at ${exception.maxSeverity}` });
      continue;
    }
    if (exception.acceptNewAdvisories === false) {
      const unknown = advisories.filter((id) => !exception.advisories.includes(id));
      if (unknown.length > 0) {
        violations.push({ pkg, severity, advisories, reason: 'new-advisory', exception: exception.id,
          detail: `advisories not recorded in the exception: ${unknown.join(', ')}` });
        continue;
      }
    }
    if (exception.scope === 'dev' && prodAuditReport?.vulnerabilities?.[pkg]) {
      violations.push({ pkg, severity, advisories, reason: 'scope-escaped-to-production', exception: exception.id,
        detail: 'declared dev-only but present in `npm audit --omit=dev`' });
      continue;
    }
    const tripped = (exception.voidIf?.importsFound ?? []).filter((spec) => sourceHits[spec]?.length);
    if (tripped.length > 0) {
      violations.push({ pkg, severity, advisories, reason: 'reachability-guard-tripped', exception: exception.id,
        detail: tripped.map((s) => `${s} found in ${sourceHits[s].join(', ')}`).join('; ') });
      continue;
    }

    exempt.push({ pkg, severity, advisories, exception: exception.id,
      reason: exception.reason, expires: exception.expires });

    const daysLeft = (expiresMs - nowMs) / 86_400_000;
    if (daysLeft < expiryWarningDays) {
      warnings.push({ pkg, severity, reason: 'expiring-soon', exception: exception.id,
        detail: `expires ${exception.expires} (${Math.ceil(daysLeft)} days) — ${exception.reviewTrigger}` });
    }
  }

  for (const e of policy.exceptions) {
    if (!usedExceptions.has(e.id)) {
      warnings.push({ pkg: e.packages.join(', '), reason: 'unused-exception', exception: e.id,
        detail: 'matches no current finding — remove it, a stale exception masks future findings' });
    }
  }

  return { violations, warnings, exempt };
}

// ------------------------------------------------------------------- output

function render({ violations, warnings, exempt }) {
  const lines = [];
  const pad = (s, n) => String(s).padEnd(n);

  if (violations.length) {
    lines.push('VIOLATIONS');
    for (const v of violations) {
      lines.push(`  ${pad(v.severity, 9)} ${pad(v.pkg, 30)} ${v.reason}`);
      lines.push(`    ${v.detail}`);
      if (v.advisories?.length) lines.push(`    advisories: ${v.advisories.join(', ')}`);
    }
    lines.push('');
  }
  if (warnings.length) {
    lines.push('WARNINGS (non-blocking)');
    for (const w of warnings) {
      lines.push(`  ${pad(w.severity ?? '-', 9)} ${pad(w.pkg, 30)} ${w.reason}`);
      if (w.detail) lines.push(`    ${w.detail}`);
    }
    lines.push('');
  }
  if (exempt.length) {
    lines.push('ACCEPTED RISKS (documented exceptions)');
    const seenException = new Set();
    for (const e of exempt) {
      lines.push(`  ${pad(e.severity, 9)} ${pad(e.pkg, 30)} until ${e.expires}  [${e.exception}]`);
      // The rationale belongs to the exception, not the package — print it once
      // even when one exception covers several packages via an effects chain.
      if (!seenException.has(e.exception)) {
        seenException.add(e.exception);
        lines.push(`    ${e.reason.split('. ')[0]}.`);
        lines.push(`    full rationale: .github/dependency-policy.json -> ${e.exception}`);
      }
    }
    lines.push('');
  }
  lines.push(`${violations.length} violations, ${warnings.length} warnings, ${exempt.length} accepted`);
  return lines.join('\n');
}

// --------------------------------------------------------------------- main

function parseArgs(argv) {
  const opts = { policy: DEFAULT_POLICY, dir: DEFAULT_DIR, json: false, summary: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--policy') opts.policy = resolve(argv[++i]);
    else if (argv[i] === '--dir') opts.dir = resolve(argv[++i]);
    else if (argv[i] === '--json') opts.json = true;
    else if (argv[i] === '--summary') opts.summary = true;
    else throw new ToolingError(`unknown argument "${argv[i]}"`);
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);

  let policy;
  try {
    policy = validatePolicy(JSON.parse(readFileSync(opts.policy, 'utf8')));
  } catch (err) {
    if (err instanceof ToolingError) throw err;
    throw new ToolingError(`cannot read policy ${opts.policy}: ${err.message}`);
  }

  const auditReport = runAudit(opts.dir);
  const prodAuditReport = runAudit(opts.dir, ['--omit=dev']);

  const specifiers = [...new Set(policy.exceptions.flatMap((e) => e.voidIf?.importsFound ?? []))];
  const sourceHits = scanSources(resolve(opts.dir, '..'), policy.sourceScan, specifiers);

  const result = evaluate({ auditReport, prodAuditReport, policy, sourceHits, now: new Date() });

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(render(result) + '\n');
  }

  if (opts.summary && process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      '## Dependency audit',
      '',
      `**${result.violations.length}** violations · **${result.warnings.length}** warnings · **${result.exempt.length}** accepted risks`,
      '',
      '```',
      render(result),
      '```',
    ].join('\n');
    execFileSync('sh', ['-c', `cat >> "$GITHUB_STEP_SUMMARY"`], { input: md });
  }

  return result.violations.length > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`dep-audit-gate: ${err.message}\n`);
    process.exit(2);
  }
}
