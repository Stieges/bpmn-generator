/**
 * Characterization: the BPMN findings — severity, count and order — for every top-level Logic-Core
 * fixture × {no profile, default, strict} × {document, optimize}, captured from master BEFORE rule
 * metadata moved into references/ontology.jsonld. Deriving the metadata must not change one of them.
 * The snapshot is a regression fence, not a golden to regenerate: a diff here is a defect.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRules, loadRuleProfile, profileForMode } from './rules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOT = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'rules-characterization', 'bpmn-findings.snapshot.json'), 'utf8'));

describe('BPMN findings are unchanged by deriving rule metadata from the ontology', () => {
  test('the snapshot covers fixtures, all three profiles and both modes', () => {
    expect(Object.keys(SNAPSHOT).length).toBeGreaterThanOrEqual(90);
  });
  for (const [key, expected] of Object.entries(SNAPSHOT)) {
    test(key, () => {
      const [file, profileName, mode] = key.split('|');
      const lc = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', file), 'utf8'));
      const profile = profileName === 'none' ? null : loadRuleProfile(join(ROOT, 'rules', `${profileName}-profile.json`));
      const r = runRules(lc, profileForMode(profile, mode));
      expect({ errors: r.errors, warnings: r.warnings, infos: r.infos, advisories: r.advisories }).toEqual(expected);
    });
  }
});
