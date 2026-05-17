/**
 * Failure classifier — maps stress-test results to (category, bucket, fingerprint).
 * See spec Section 4.5. Fingerprint is filled in Task 3.8.
 */

export function classify(result) {
  if (!result.failure) {
    return { category: 'pass', bucket: null, fingerprint: null, evidence: null };
  }

  const { failure } = result;

  if (failure.stage === 'pre-filter') {
    if (failure.schemaErrors && failure.schemaErrors.length > 0) {
      return makeRecord('schema-violation', 'llm-signal', failure, result);
    }
    if (failure.ruleErrors && failure.ruleErrors.length > 0) {
      return makeRecord('rule-violation', 'llm-signal', failure, result);
    }
  }

  if (failure.stage === 'pipeline') {
    let category;
    switch (failure.failedStep) {
      case 'timeout':           category = 'timeout'; break;
      case 'pipeline-throw':    category = inferThrowCategory(failure.error); break;
      case 'elk-or-xml':        category = 'elk-error'; break;
      case 'xml':               category = 'xml-malform'; break;
      case 'svg':               category = 'svg-render-issue'; break;
      default:                  category = 'unknown';
    }
    return makeRecord(category, 'auto', failure, result);
  }

  if (failure.stage === 'roundtrip') {
    return makeRecord('roundtrip-break', 'auto', failure, result);
  }

  return makeRecord('unknown', 'triage', failure, result);
}

function inferThrowCategory(errorMessage) {
  if (!errorMessage) return 'elk-error';
  const lower = errorMessage.toLowerCase();
  if (lower.includes('elk') || lower.includes('layout')) return 'elk-error';
  if (lower.includes('xml') || lower.includes('parse')) return 'xml-malform';
  if (lower.includes('svg') || lower.includes('render')) return 'svg-render-issue';
  return 'elk-error';
}

function makeRecord(category, bucket, failure, result) {
  return {
    category,
    bucket,
    fingerprint: null, // filled in by Task 3.8
    evidence: failure,
  };
}
