import { describe, test, expect, jest, afterEach } from '@jest/globals';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, mkdirSync } from 'node:fs';
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
    expect(loadRuleProfile(p)).toEqual({});
    expect(profileProvenance(loadRuleProfile(p))).toEqual({ label: JSON.stringify(p), missing: true });
  });

  test('a file that is not JSON aborts, naming the file and the position', () => {
    const p = writeProfile('kaputt.json', '{ "layers": { "style": { "enabled": false } ');
    expect(() => loadRuleProfile(p)).toThrow(/rule profile ".*kaputt\.json" is not valid JSON at line 1, column \d+$/);
  });

  test('a BOM-prefixed profile (Windows editors) loads', () => {
    const p = writeProfile('bom.json', '﻿{ "overrides": { "M01": { "severity": "ERROR" } } }');
    expect(loadRuleProfile(p)).toEqual({ overrides: { M01: { severity: 'ERROR' } } });
    expect(profileProvenance(loadRuleProfile(p)).label).toBe(JSON.stringify(p));
  });
});

describe('the BPMN runner reports what a profile cannot do — findings stay as they are', () => {
  const lc = fixture('simple-approval.json');

  test('an unknown rule id: exactly one warning naming profile and id', () => {
    const warn = silenceWarn();
    const withS99 = runRules(lc, strictWith({ overrides: { ...strictWith().overrides, S99: { severity: 'ERROR' } } }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/rule profile "strict" names rule "S99", which the BPMN rule set does not have/);
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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`rule profile ${JSON.stringify(p)} not found`));
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
      .toThrow('rule profile "typo" does not match the profile schema: "/overrides/M03/severity" must be one of ERROR, WARNING, INFO, ADVISORY, OFF');
  });

  test('the runner\'s own unknown-severity check still holds for a caller that audits directly', () => {
    expect(auditProfile({ profile: 'typo', overrides: { M03: { severity: 'CRITICAL' } } }, profileContext('BPMN')).errors)
      .toEqual(['rule profile "typo": unknown severity "CRITICAL" ("M03")']);
  });

  test('ADVISORY on a non-optimization rule refuses the profile — classifyResult would drop the finding', () => {
    expect(() => runRules(lc, { profile: 'adv', overrides: { S01: { severity: 'ADVISORY' } } }))
      .toThrow(/S01 is a soundness rule, and severity ADVISORY is reported for the optimization layer only/);
    expect(() => runRules(lc, { profile: 'adv', overrides: { O01: { severity: 'ADVISORY' } } })).not.toThrow();
  });

  test('runPipeline with a broken profile file rejects, naming file and position', async () => {
    const p = writeProfile('kaputt.json', '{ "overrides": ');
    await expect(runPipeline(lc, { ruleProfile: p })).rejects.toThrow(/kaputt\.json" is not valid JSON at line 1, column 16$/);
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
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/names rule "S01", which the DMN rule set does not have/));
  });

  test('an unknown severity is refused', () => {
    expect(() => runDmnRules(dc, { profile: { profile: 'typo', overrides: { D06: { severity: 'CRITICAL' } } } }))
      .toThrow('rule profile "typo" does not match the profile schema: "/overrides/D06/severity" must be one of ERROR, WARNING, INFO, ADVISORY, OFF');
  });

  test('runDmnPipeline with a broken profile file rejects, naming the file', async () => {
    const p = writeProfile('kaputt.json', '{');
    await expect(runDmnPipeline(dc, { ruleProfile: p })).rejects.toThrow(/kaputt\.json" is not valid JSON/);
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

// ─── Profile input hardening: schema gate, safe file read, bounded and escaped messages ───

import { spawnSync } from 'node:child_process';
import { symlinkSync, rmSync, readdirSync as listDir, existsSync } from 'node:fs';
import { loadNamedRuleProfile, assertRuleProfile, assertLayerNotWeakened, profileProvenance, quoteForMessage, PROFILE_LIMITS } from './rule-profile.js';
import { VOCABULARY } from './ontology.js';

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const schemaFile = JSON.parse(readFileSync(join(ROOT, 'references', 'rule-profile-schema.json'), 'utf8'));
const committedProfiles = () => [
  ...listDir(RULES_DIR).filter((f) => f.endsWith('.json')).map((f) => join(RULES_DIR, f)),
  ...(existsSync(join(RULES_DIR, 'custom')) ? listDir(join(RULES_DIR, 'custom')).filter((f) => f.endsWith('.json')).map((f) => join(RULES_DIR, 'custom', f)) : []),
];

describe('the profile schema gate', () => {
  test('every committed profile passes it', () => {
    const files = committedProfiles();
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) expect(() => assertRuleProfile(JSON.parse(readFileSync(f, 'utf8')))).not.toThrow();
  });

  test('the top-level keys it allows are exactly the ones the committed profiles use', () => {
    const used = new Set(committedProfiles().flatMap((f) => Object.keys(JSON.parse(readFileSync(f, 'utf8')))));
    expect(Object.keys(schemaFile.properties).sort()).toEqual([...used].sort());
  });

  test('its severity enum is the ontology severity vocabulary', () => {
    expect([...schemaFile.$defs.severity.enum].sort()).toEqual(VOCABULARY.severities.map((s) => s.name).sort());
  });

  test('an array, a string, a number or a boolean is not a profile', () => {
    for (const bad of [[], [{ overrides: {} }], 'strict', 42, true]) {
      expect(() => assertRuleProfile(bad)).toThrow(ProfileRejectedError);
    }
    expect(() => runRules(fixture('simple-approval.json'), ['x'])).toThrow(ProfileRejectedError);
  });

  test('client-supplied internal markers ($source, $missing) are refused', () => {
    expect(() => assertRuleProfile({ $source: '/forged', $missing: true })).toThrow(/does not match the profile schema.*\$source/);
    expect(() => runRules(fixture('simple-approval.json'), { $source: '/forged\n[ERROR] admin login ok', $missing: true })).toThrow(ProfileRejectedError);
  });

  test('a profile larger than the inline limit is refused before the schema runs', () => {
    const big = { profile: 'big', description: 'x'.repeat(PROFILE_LIMITS.inlineBytes) };
    expect(() => assertRuleProfile(big)).toThrow(/larger than 64 KiB/);
  });

  test('ten thousand overrides are one schema refusal, not ten thousand warnings', () => {
    const warn = silenceWarn();
    const overrides = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`X${i}`, { severity: 'ERROR' }]));
    let err;
    try { runRules(fixture('simple-approval.json'), { overrides }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ProfileRejectedError);
    expect(err.message.length).toBeLessThan(2000);
    expect(warn).not.toHaveBeenCalled();
  });

  test('a schema refusal lists at most five problems', () => {
    const overrides = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`M0${i % 9}x${i}`, { severity: 'NOPE', extra: 1 }]));
    let err;
    try { assertRuleProfile({ overrides, bogus: 1 }); } catch (e) { err = e; }
    expect(err.message.split('; ').length).toBeLessThanOrEqual(6);
  });

  test('an unknown severity is refused by the schema, naming the place and the allowed values, not the value', () => {
    expect(() => runRules(fixture('simple-approval.json'), { profile: 'typo', overrides: { M03: { severity: 'hunter2-secret' } } }))
      .toThrow(/rule profile "typo" does not match the profile schema: "\/overrides\/M03\/severity" must be one of ERROR, WARNING, INFO, ADVISORY, OFF$/);
  });
});

describe('profile messages are bounded and cannot forge log lines', () => {
  test('quoteForMessage escapes newlines and ANSI escapes and strips C1 controls', () => {
    const q = quoteForMessage('a\n[ERROR] x\u001b[31mred\u0085');
    expect(q).not.toMatch(CONTROL);
    expect(q).toContain('\\n');
    expect(q).toContain('\\u001b');
  });

  test('a rule id or layer carrying a newline or an ANSI escape is escaped in every warning', () => {
    const ctx = profileContext('BPMN');
    const { warnings } = auditProfile({ profile: 'p\nq', layers: { 'x\n[ERROR] y': {} }, overrides: { 'S9\u001b[31m': {} } }, ctx);
    expect(warnings.length).toBe(2);
    for (const w of warnings) expect(w).not.toMatch(CONTROL);
  });

  test('such a profile run through a runner is refused, and the refusal is escaped too', () => {
    let err;
    try { runRules(fixture('simple-approval.json'), { profile: 'p\u001b[2J', overrides: { 'S9\n[ERROR] login': { severity: 'ERROR' } } }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ProfileRejectedError);
    expect(err.message).not.toMatch(CONTROL);
  });

  test('warnings are capped at twenty plus a count of the rest', () => {
    const ctx = profileContext('BPMN');
    const overrides = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`Z${i}`, {}]));
    const { warnings } = auditProfile({ overrides }, ctx);
    expect(warnings).toHaveLength(21);
    expect(warnings[20]).toBe('… and 30 more');
  });
});

describe('reading a profile file never reads something that is not a small regular file', () => {
  // Run in a child process: a regression here blocks the thread (a FIFO waits for a writer,
  // /dev/zero never ends), which no in-process timeout can interrupt.
  const probe = (path) => spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { loadRuleProfile } from ${JSON.stringify(join(__dirname, 'rule-profile.js'))};
     try { loadRuleProfile(${JSON.stringify(path)}); console.log('LOADED'); } catch (e) { console.log(e.name + ': ' + e.message); }`],
  { timeout: 10000, encoding: 'utf8' });

  const hasMkfifo = spawnSync('mkfifo', ['--version']).error?.code !== 'ENOENT' && process.platform !== 'win32';
  (hasMkfifo ? test : test.skip)('a FIFO is refused without waiting for a writer', () => {
    const dir = tmp();
    const fifo = join(dir, 'pipe.json');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    const r = probe(fifo);
    rmSync(dir, { recursive: true, force: true });
    expect(r.error).toBeUndefined();
    expect(r.stdout).toMatch(/ProfileRejectedError: .*is not a regular file/);
  });

  (existsSync('/dev/zero') ? test : test.skip)('/dev/zero is refused without reading it', () => {
    const r = probe('/dev/zero');
    expect(r.error).toBeUndefined();
    expect(r.stdout).toMatch(/ProfileRejectedError: .*is not a regular file/);
  });

  test('a file larger than 256 KiB is refused without parsing it', () => {
    const p = writeProfile('huge.json', `{"description":"${'x'.repeat(PROFILE_LIMITS.fileBytes)}"}`);
    expect(() => loadRuleProfile(p)).toThrow(/larger than 256 KiB/);
  });

  test('a parse failure names line and column but quotes nothing of the file', () => {
    const p = writeProfile('secret.json', 'SECRET_TOKEN=abc123');
    let err;
    try { loadRuleProfile(p); } catch (e) { err = e; }
    expect(err.message).toMatch(/is not valid JSON at line \d+, column \d+$/);
    expect(err.message).not.toMatch(/SECRET|abc123/);
  });

  test('a file that parses but is not a valid profile is refused by the schema', () => {
    const p = writeProfile('array.json', '[1, 2, 3]');
    expect(() => loadRuleProfile(p)).toThrow(ProfileRejectedError);
  });
});

describe('profiles by name, resolved inside rules/ only', () => {
  const lc = fixture('boundary-event-shapes.json');
  const strictErrors = () => runRules(lc, JSON.parse(readFileSync(join(RULES_DIR, 'strict-profile.json'), 'utf8'))).errors;

  test.each(['strict', 'strict-profile', 'strict-profile.json', 'rules/strict-profile.json'])('%s resolves to the committed strict profile', (name) => {
    const profile = loadNamedRuleProfile(name, RULES_DIR);
    expect(runRules(lc, profile).errors).toEqual(strictErrors());
    expect(strictErrors().length).toBeGreaterThan(0);
  });

  test('dmn-default-profile resolves too', () => {
    expect(loadNamedRuleProfile('dmn-default-profile', RULES_DIR).profile).toBe('dmn-default');
  });

  test('a named profile is labelled by its name, never its path', () => {
    expect(profileProvenance(loadNamedRuleProfile('strict', RULES_DIR)).label).toBe('profile "strict"');
  });

  test.each(['../../etc/passwd', '/etc/passwd', 'custom/../../x', 'Strict', 'strict/../x', 'a'.repeat(80), ''])('%s is refused, naming only the name', (name) => {
    let err;
    try { loadNamedRuleProfile(name, RULES_DIR); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ProfileRejectedError);
    expect(err.message).not.toContain(RULES_DIR);
    expect(err.message).not.toMatch(/root:|nobody/);
  });

  test('an unknown name is refused, naming the name', () => {
    expect(() => loadNamedRuleProfile('no-such-profile', RULES_DIR)).toThrow(/unknown rule profile "no-such-profile"/);
  });

  test('a symlink inside rules/ that points outside it is refused', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'custom'));
    const outside = writeProfile('outside.json', { overrides: {} });
    symlinkSync(outside, join(dir, 'custom', 'escape.json'));
    writeFileSync(join(dir, 'ok.json'), '{"overrides":{}}');
    expect(() => loadNamedRuleProfile('custom/escape', dir)).toThrow(ProfileRejectedError);
    expect(loadNamedRuleProfile('ok', dir)).toEqual({ overrides: {} });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('a client may not weaken the soundness layer', () => {
  const ctx = profileContext('BPMN');
  test.each([
    [{ layers: { soundness: { enabled: false } } }],
    [{ overrides: { S01: { severity: 'OFF' } } }],
    [{ overrides: { S03: { severity: 'INFO' } } }],
    [{ overrides: { S03: { severity: 'ADVISORY' } } }],
  ])('%j is refused', (profile) => {
    expect(() => assertLayerNotWeakened(profile, 'soundness', ctx)).toThrow(ProfileRejectedError);
  });
  test('raising a soundness rule or relaxing a style rule is fine', () => {
    expect(() => assertLayerNotWeakened({ layers: { soundness: { enabled: true } }, overrides: { S01: { severity: 'ERROR' }, M01: { severity: 'OFF' } } }, 'soundness', ctx)).not.toThrow();
  });
});
