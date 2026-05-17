/**
 * Report generator — produces Markdown + JSON summaries of a stress run.
 * See spec Section 4.7.
 */

export function generateReport(runMeta, records) {
  const totals = computeTotals(records);
  const byCategory = countBy(records, r => r.category);
  const newFixturesByCategory = countBy(
    records.filter(r => r.bucket && r.wrote === 'new'),
    r => r.category
  );
  const fingerprints = [...new Set(records.filter(r => r.fingerprint).map(r => r.fingerprint))];
  const drift = computeDrift(runMeta.previousReportJson || null, { byCategory, fingerprints });

  const json = { runMeta, totals, byCategory, newFixturesByCategory, fingerprints, drift };
  const markdown = renderMarkdown(runMeta, totals, byCategory, newFixturesByCategory, records, drift);
  return { markdown, json };
}

function computeTotals(records) {
  const total = records.length;
  const pass = records.filter(r => r.category === 'pass').length;
  const fail = total - pass;
  return { total, pass, fail, passRate: total ? Math.round((pass / total) * 100) : 0 };
}

function countBy(arr, fn) {
  const out = {};
  for (const item of arr) {
    const key = fn(item);
    if (!key) continue;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function renderMarkdown(runMeta, totals, byCategory, newFixturesByCategory, records, drift) {
  const lines = [];
  lines.push(`# Robustness Run — ${runMeta.started_at?.slice(0, 10) || 'unknown'}`);
  lines.push('');
  lines.push(`Model: ${runMeta.model}  Target: ${runMeta.target}  Duration: ${Math.round((runMeta.duration_ms || 0) / 1000)}s`);
  lines.push(`Total samples: ${totals.total}  Pass: ${totals.pass} (${totals.passRate}%)  Fail: ${totals.fail}`);
  lines.push('');

  const targets = new Set(records.map(r => r.sample?.meta?.target).filter(Boolean));
  if (targets.size > 1) {
    lines.push('## Per-Target Breakdown');
    for (const t of targets) {
      const recs = records.filter(r => r.sample?.meta?.target === t);
      const pass = recs.filter(r => r.category === 'pass').length;
      lines.push(`- target ${t}: ${recs.length} total, ${pass} pass (${Math.round((pass / recs.length) * 100)}%)`);
    }
    lines.push('');
  }

  lines.push('## Failures by Category');
  lines.push('');
  lines.push('| Category | Count | New Fixtures |');
  lines.push('|---|---|---|');
  for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    if (cat === 'pass') continue;
    const newCount = newFixturesByCategory[cat] || 0;
    lines.push(`| ${cat} | ${count} | ${newCount} |`);
  }
  lines.push('');

  // MaD external sanity check section (only when runMeta.madResult is present)
  if (runMeta.madResult) {
    lines.push('## External Sanity Check (MaD subset)');
    lines.push('');
    lines.push(`MaD samples: ${runMeta.madResult.total}  Passed: ${runMeta.madResult.passed}  Failed: ${runMeta.madResult.failed}`);
    for (const [cat, count] of Object.entries(runMeta.madResult.byCategory || {})) {
      lines.push(`- ${cat}: ${count}`);
    }
    lines.push('');
  }

  if (drift && !drift.firstRun && (drift.newFingerprints.length > 0 || drift.closedFingerprints.length > 0)) {
    lines.push('## Drift vs Previous Run');
    lines.push('');
    if (drift.newFingerprints.length > 0) {
      lines.push(`- ⚠️ New fingerprints (regressions): ${drift.newFingerprints.join(', ')}`);
    }
    if (drift.closedFingerprints.length > 0) {
      lines.push(`- ✅ Closed fingerprints (fixed): ${drift.closedFingerprints.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function computeDrift(previous, current) {
  if (!previous) return { firstRun: true, newFingerprints: [], closedFingerprints: [] };
  const prevSet = new Set(previous.fingerprints || []);
  const currSet = new Set(current.fingerprints || []);
  const newFingerprints = [...currSet].filter(x => !prevSet.has(x));
  const closedFingerprints = [...prevSet].filter(x => !currSet.has(x));
  return { firstRun: false, newFingerprints, closedFingerprints };
}
