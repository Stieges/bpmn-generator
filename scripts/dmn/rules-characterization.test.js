/**
 * Characterization: DMN findings for the Decision-Core fixtures (one deliberately dirty, with a
 * finding in every layer) × {no profile, dmn-default, dmn-best-practice} × {semantic, best-practice},
 * captured from master BEFORE rule metadata moved into references/ontology.jsonld. A diff is a defect.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDmnRules, loadRuleProfile } from './rules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOT = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'rules-characterization', 'dmn-findings.snapshot.json'), 'utf8'));

describe('DMN findings are unchanged by deriving rule metadata from the ontology', () => {
  test('the dirty fixture really exercises all three layers', () => {
    const r = SNAPSHOT['rules-characterization/dmn/dirty-discount.json|none|best-practice'];
    expect(r.errors.some((m) => m.startsWith('[D01]'))).toBe(true);
    expect(r.warnings.some((m) => m.startsWith('[D06]'))).toBe(true);
    expect(r.warnings.some((m) => m.startsWith('[B05]'))).toBe(true);
  });
  for (const [key, expected] of Object.entries(SNAPSHOT)) {
    test(key, () => {
      const [file, profileName, mode] = key.split('|');
      const dc = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', file), 'utf8'));
      const profile = profileName === 'none' ? null : loadRuleProfile(join(ROOT, 'rules', `${profileName}-profile.json`));
      const r = runDmnRules(dc, { profile, mode });
      expect({ errors: r.errors, warnings: r.warnings, infos: r.infos }).toEqual(expected);
    });
  }
});
