import { describe, test, expect, jest, afterEach } from '@jest/globals';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadRuleProfile, auditProfile, ProfileRejectedError } from './rule-profile.js';
import { profileContext } from './rule-catalog.js';
import { runRules } from '../bpmn/rules.js';
import { runPipeline } from '../bpmn/pipeline.js';
import { runDmnRules } from '../dmn/rules.js';
import { runDmnPipeline } from '../dmn/pipeline.js';
import { runScenarioPipeline } from '../scenarios/pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const RULES_DIR = join(ROOT, 'rules');
const tmp = () => mkdtempSync(join(tmpdir(), 'profile-'));
const writeProfile = (name, data) => { const p = join(tmp(), name); writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data)); return p; };
const fixture = (rel) => JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', rel), 'utf8'));
const strictWith = (extra) => ({ ...JSON.parse(readFileSync(join(RULES_DIR, 'strict-profile.json'), 'utf8')), ...extra });
const silenceWarn = () => jest.spyOn(console, 'warn').mockImplementation(() => {});
const findings = (r) => ({ errors: r.errors, warnings: r.warnings, infos: r.infos });

afterEach(() => jest.restoreAllMocks());

describe('loadRuleProfile', () => {
  test('a missing file is not an abort: it behaves like no profile and carries its path for the warning', () => {
    const p = join(tmp(), 'does-not-exist.json');
    expect(loadRuleProfile(p)).toEqual({ $source: p, $missing: true });
  });

  test('a file that is not JSON aborts, naming the file and the position', () => {
    const p = writeProfile('kaputt.json', '{ "layers": { "style": { "enabled": false } ');
    expect(() => loadRuleProfile(p)).toThrow(/rule profile .*kaputt\.json is not valid JSON at line 1, column \d+: /);
  });

  test('a BOM-prefixed profile (Windows editors) loads', () => {
    const p = writeProfile('bom.json', '﻿{ "overrides": { "M01": { "severity": "ERROR" } } }');
    expect(loadRuleProfile(p)).toMatchObject({ overrides: { M01: { severity: 'ERROR' } }, $source: p });
  });
});

describe('the BPMN runner reports what a profile cannot do — findings stay as they are', () => {
  const lc = fixture('simple-approval.json');

  test('an unknown rule id: exactly one warning naming profile and id', () => {
    const warn = silenceWarn();
    const withS99 = runRules(lc, strictWith({ overrides: { ...strictWith().overrides, S99: { severity: 'ERROR' } } }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/rule profile "strict" names rule S99, which the BPMN rule set does not have/);
    expect(findings(withS99)).toEqual(findings(runRules(lc, strictWith())));
  });

  test('a layer of another rule set: a warning naming profile and layer', () => {
    const warn = silenceWarn();
    runRules(lc, { profile: 'mixed', layers: { best_practice: { enabled: true } } });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/rule profile "mixed" names layer "best_practice", which the BPMN rule set does not have/));
  });

  test('a missing profile file: a warning naming the path, and the default findings', () => {
    const warn = silenceWarn();
    const p = join(tmp(), 'gibt-es-nicht.json');
    const r = runRules(lc, loadRuleProfile(p));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`rule profile ${p} not found`));
    expect(findings(r)).toEqual(findings(runRules(lc, null)));
  });

  test('an override for a scenario rule warns "not profile-switchable"; the scenario pipeline still reports it', () => {
    const warn = silenceWarn();
    runRules(lc, { profile: 'quiet', overrides: { SC01: { severity: 'OFF' } } });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/overrides SC01, which runs in the scenario pipeline and is not profile-switchable in this release/));
    const combined = fixture('scenarios/combined.json');
    expect(runScenarioPipeline(combined, []).issues.map((i) => i.rule)).toContain('SC01');
  });

  test('a profile that switches workflow_net off silences WF01–WF03 but not SC01/SC06 (known gap)', () => {
    const combined = fixture('scenarios/combined.json');
    const defaultProfile = loadRuleProfile(join(RULES_DIR, 'default-profile.json'));
    const r = runRules(combined, defaultProfile);
    expect([...r.errors, ...r.warnings, ...r.infos].filter((m) => /Improper completion|Dead transition|Unbounded place|Deadlock/.test(m))).toEqual([]);
    expect(runScenarioPipeline(combined, []).issues.map((i) => i.rule)).toEqual(expect.arrayContaining(['SC01', 'SC06']));
  });

  test('an unknown severity refuses the profile instead of losing the finding', () => {
    expect(() => runRules(lc, { profile: 'typo', overrides: { M03: { severity: 'CRITICAL' } } }))
      .toThrow('rule profile "typo": unknown severity CRITICAL (M03)');
  });

  test('ADVISORY on a non-optimization rule refuses the profile — classifyResult would drop the finding', () => {
    expect(() => runRules(lc, { profile: 'adv', overrides: { S01: { severity: 'ADVISORY' } } }))
      .toThrow(/S01 is a soundness rule, and severity ADVISORY is reported for the optimization layer only/);
    expect(() => runRules(lc, { profile: 'adv', overrides: { O01: { severity: 'ADVISORY' } } })).not.toThrow();
  });

  test('runPipeline with a broken profile file rejects, naming file and position', async () => {
    const p = writeProfile('kaputt.json', '{ "overrides": ');
    await expect(runPipeline(lc, { ruleProfile: p })).rejects.toThrow(/kaputt\.json is not valid JSON at line 1, column 16: /);
  });
});

describe('the DMN runner does the same for the DMN rule set', () => {
  const dc = fixture('dmn/discount-decision.json');

  test('an override for SC04 in a DMN profile warns "not profile-switchable"', () => {
    const warn = silenceWarn();
    runDmnRules(dc, { profile: { profile: 'dmn-custom', overrides: { SC04: { severity: 'OFF' } } } });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/overrides SC04, which runs in the scenario pipeline/));
  });

  test('a BPMN rule id in a DMN profile is unknown to the DMN rule set', () => {
    const warn = silenceWarn();
    runDmnRules(dc, { profile: { profile: 'mixed', overrides: { S01: { severity: 'ERROR' } } } });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/names rule S01, which the DMN rule set does not have/));
  });

  test('an unknown severity is refused', () => {
    expect(() => runDmnRules(dc, { profile: { profile: 'typo', overrides: { D06: { severity: 'CRITICAL' } } } }))
      .toThrow('rule profile "typo": unknown severity CRITICAL (D06)');
  });

  test('runDmnPipeline with a broken profile file rejects, naming the file', async () => {
    const p = writeProfile('kaputt.json', '{');
    await expect(runDmnPipeline(dc, { ruleProfile: p })).rejects.toThrow(/kaputt\.json is not valid JSON/);
  });
});

describe('the committed profiles stay quiet and behave as before', () => {
  for (const file of readdirSync(RULES_DIR).filter((f) => f.endsWith('.json'))) {
    test(`${file} produces no profile warning under its own rule set`, () => {
      const warn = silenceWarn();
      const profile = loadRuleProfile(join(RULES_DIR, file));
      if (file.startsWith('dmn-')) runDmnRules(fixture('dmn/discount-decision.json'), { profile });
      else runRules(fixture('simple-approval.json'), profile);
      expect(warn).not.toHaveBeenCalled();
    });
  }

  test('auditProfile is pure: no output of its own', () => {
    const warn = silenceWarn();
    const r = auditProfile({ profile: 'x', overrides: { S99: {} } }, profileContext('BPMN'));
    expect(r.warnings).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('refusals are identifiable', () => {
  test('a broken file, an unknown severity and a dropped-finding severity all throw ProfileRejectedError', () => {
    const lc = fixture('simple-approval.json');
    const p = writeProfile('kaputt.json', '{');
    expect(() => loadRuleProfile(p)).toThrow(ProfileRejectedError);
    expect(() => runRules(lc, { overrides: { M03: { severity: 'CRITICAL' } } })).toThrow(ProfileRejectedError);
    expect(() => runRules(lc, { overrides: { S01: { severity: 'ADVISORY' } } })).toThrow(ProfileRejectedError);
    expect(() => runDmnRules(fixture('dmn/discount-decision.json'), { profile: { overrides: { D06: { severity: 'CRITICAL' } } } })).toThrow(ProfileRejectedError);
  });
});
