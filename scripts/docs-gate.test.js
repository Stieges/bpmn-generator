import { describe, test, expect } from '@jest/globals';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  checkResponseContract,
  checkNumbers,
  checkDocPaths,
  checkPackageIntegrity,
  evaluateChangelogNudge,
  extractActualCodes,
  CODE_FAMILIES,
  ToolingError,
  ruleSetCounts,
  loadRuleSetCounts,
} from '../.github/scripts/docs-gate.mjs';

// This file lives in scripts/, so __dirname here is the same absolute path
// docs-gate.mjs computes as its own SCRIPTS_DIR.
const __dirname = dirname(fileURLToPath(import.meta.url));

function newAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

describe('docs-gate — checkResponseContract', () => {
  const SCHEMA = {
    $id: 'https://docs-gate.test/schema.json',
    $defs: {
      Thing: {
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' } },
        additionalProperties: false,
      },
      Other: {
        type: 'object',
        required: ['b'],
        properties: { b: { type: 'number' } },
        additionalProperties: false,
      },
    },
  };

  test('responses matching their $defs yield nothing', () => {
    const findings = checkResponseContract({ Thing: { a: 'x' }, Other: { b: 1 } }, SCHEMA, newAjv());
    expect(findings).toEqual([]);
  });

  test('a response missing a required field is a finding naming the $def', () => {
    const findings = checkResponseContract({ Thing: {} }, SCHEMA, newAjv());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'response-contract' });
    expect(findings[0].detail).toContain('Thing');
  });

  test('an undeclared field is a finding (additionalProperties: false)', () => {
    // Shape of the real regression this check exists for: a field silently
    // dropped from a handler shows up as missing-required; a field added to
    // the handler but never documented shows up here instead.
    const findings = checkResponseContract({ Thing: { a: 'x', surprise: true } }, SCHEMA, newAjv());
    expect(findings).toHaveLength(1);
  });

  test('only the failing response kind is reported, not its passing sibling', () => {
    const findings = checkResponseContract({ Thing: { a: 'x' }, Other: {} }, SCHEMA, newAjv());
    expect(findings).toHaveLength(1);
    expect(findings[0].detail.startsWith('Other:')).toBe(true);
  });

  test('a response key with no matching $def is a tooling error, not a silent skip', () => {
    // The response-building side and api-schema.json are maintained
    // separately — a typo in one must stop the build, not read as "nothing to
    // check".
    expect(() => checkResponseContract({ Nope: { a: 'x' } }, SCHEMA, newAjv())).toThrow(ToolingError);
  });
});

describe('docs-gate — checkNumbers', () => {
  const base = (overrides = {}) => ({
    readmeText: 'The rule engine has 33 BPMN rules, 5 layers, covering soundness and style.',
    claudeMdText: '29 top-level scripts live under scripts/. The rule engine has 33 BPMN rules, 5 layers.',
    apiReferenceText: 'Codes: DI01, DI02, DI03, DI04, DI05, DI06. NC codes: NC01, NC02, NC02b, NC03a, NC03b, NC04, NC05, NC06.',
    roadmapText: 'Validation (33 BPMN rules, 5 layers) via ElkJS.',
    skillText: 'No rule/layer count claim in this fixture — SKILL.md does not currently make one.',
    evaluationText: 'Configurable rule engine | Yes (33 BPMN rules, 5 layers, JSON profiles).',
    pipelineDocText: 'Führt 33 BPMN-Regeln in 5 Schichten aus.',
    ruleSets: {
      BPMN: { rules: 33, layers: 5 },
      DMN: { rules: 8, layers: 2 },
      ArchiMate: { rules: 0, layers: 0 },
      'cross-notation': { rules: 2, layers: 1 },
    },
    actualTopLevelScriptCount: 29,
    actualDiCodes: ['DI01', 'DI02', 'DI03', 'DI04', 'DI05', 'DI06'],
    actualNcCodes: ['NC01', 'NC02', 'NC02b', 'NC03a', 'NC03b', 'NC04', 'NC05', 'NC06'],
    ...overrides,
  });

  test('matching numbers and codes yield nothing', () => {
    expect(checkNumbers(base())).toEqual([]);
  });

  // Every claim names its rule set right at the number (decisions F20, F28) and is measured
  // against that rule set's count in the ontology — never routed by a word elsewhere in the line.
  test.each([
    ['40 BPMN rules, 5 layers', { BPMN: { rules: 40, layers: 5 } }],
    ['40 BPMN rules in 5 layers', { BPMN: { rules: 40, layers: 5 } }],
    ['40 BPMN rules across 5 layers', { BPMN: { rules: 40, layers: 5 } }],
    ['40 BPMN-Regeln in 5 Schichten', { BPMN: { rules: 40, layers: 5 } }],
    ['19 DMN rules, 3 layers', { DMN: { rules: 19, layers: 3 } }],
    ['2 cross-notation rules, 1 layer', { 'cross-notation': { rules: 2, layers: 1 } }],
    ['2 übergreifende Regeln in 1 Schicht', { 'cross-notation': { rules: 2, layers: 1 } }],
  ])('"%s" is checked against its own rule set', (claim, sets) => {
    const only = (ruleSets) => base({ readmeText: `See ${claim}.`, claudeMdText: '29 top-level scripts.',
      roadmapText: '', evaluationText: '', pipelineDocText: '', ruleSets });
    const ruleSets = { ...base().ruleSets, ...sets };
    expect(checkNumbers(only(ruleSets))).toEqual([]);
    const wrong = Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, { ...v, rules: v.rules + 1 }]));
    const findings = checkNumbers(only({ ...ruleSets, ...wrong }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'rule-count' });
    expect(findings[0].detail).toContain('README.md');
  });

  test.each([
    'The rule engine has 40 rules, 5 layers.',
    'DMN rule engine (19 rules, 3 layers)',
    '38 rules across 5 layers with configurable severity',
    'Führt 38 Regeln in 5 Schichten aus.',
  ])('an unqualified claim fails even when a notation word sits elsewhere in the line: %s', (line) => {
    const findings = checkNumbers(base({ readmeText: line }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'rule-count' });
    expect(findings[0].detail).toContain('without naming its rule set at the number');
  });

  test('a wrong number names file, claim, rule set and the ontology count', () => {
    const findings = checkNumbers(base({ readmeText: 'The rule engine has 37 BPMN rules, 5 layers.' }));
    expect(findings).toEqual([{ check: 'rule-count',
      detail: 'README.md says "37 BPMN rules, 5 layers" — the ontology has 33 BPMN rules' }]);
  });

  test('a stale layer count is caught even when the rule count is right', () => {
    const findings = checkNumbers(base({ roadmapText: 'Validation (33 BPMN rules, 4 layers) via ElkJS.' }));
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('ROADMAP.md');
    expect(findings[0].detail).toContain('5 BPMN layers');
  });

  test('BPMN soundness and DMN soundness are not merged: each rule set has its own layer count', () => {
    const findings = checkNumbers(base({ claudeMdText: '29 top-level scripts. 33 BPMN rules, 5 layers.\n8 DMN rules, 5 layers.' }));
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('2 DMN layers');
  });

  test('an unrelated "N rules" mention does not false-positive', () => {
    const findings = checkNumbers(base({
      readmeText: 'WF-Net soundness (3 rules) is opt-in. The rule engine has 33 BPMN rules, 5 layers.',
    }));
    expect(findings).toEqual([]);
  });

  test('a notation the docs never count is not a finding (F24)', () => {
    const ruleSets = { ...base().ruleSets, ArchiMate: { rules: 7, layers: 2 } };
    expect(checkNumbers(base({ ruleSets }))).toEqual([]);
  });

  test('a missing "N top-level scripts" claim in CLAUDE.md is a finding', () => {
    const findings = checkNumbers(base({ claudeMdText: 'The rule engine has 33 BPMN rules, 5 layers.' }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'script-count' });
    expect(findings[0].detail).toContain('wording changed');
  });

  test('a stale top-level script count is a finding', () => {
    const findings = checkNumbers(base({ claudeMdText: '28 top-level scripts. 33 BPMN rules, 5 layers.' }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'script-count' });
    expect(findings[0].detail).toContain('28');
  });

  test('a DI code emitted by di-check.js but undocumented is a finding', () => {
    const findings = checkNumbers(base({ actualDiCodes: ['DI01', 'DI02', 'DI03', 'DI04', 'DI05', 'DI06', 'DI07'] }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'di-codes' });
    expect(findings[0].detail).toContain('DI07');
    expect(findings[0].detail).toContain('not documented');
  });

  test('a DI code documented but not emitted is a finding', () => {
    const findings = checkNumbers(base({
      apiReferenceText: 'Codes: DI01, DI02, DI03, DI04, DI05, DI06, DI09. NC codes: NC01, NC02, NC02b, NC03a, NC03b, NC04, NC05, NC06.',
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'di-codes' });
    expect(findings[0].detail).toContain('DI09');
    expect(findings[0].detail).toContain('does not emit');
  });

  // The NC family (scripts/bpmn/net-check.js) is checked the same way, over the same doc file,
  // via the generalised CODE_FAMILIES table — both drift directions, same as DI above.
  test('an NC code emitted by net-check.js but undocumented is a finding', () => {
    const findings = checkNumbers(base({
      actualNcCodes: ['NC01', 'NC02', 'NC02b', 'NC03a', 'NC03b', 'NC04', 'NC05', 'NC06', 'NC07'],
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'nc-codes' });
    expect(findings[0].detail).toContain('scripts/bpmn/net-check.js');
    expect(findings[0].detail).toContain('NC07');
    expect(findings[0].detail).toContain('not documented');
  });

  test('an NC code documented but not emitted is a finding', () => {
    // The NC digit is open (NC0\d[ab]?), same as DI's NC0\d — so, like DI09 above, a genuinely
    // fictitious code (NC09, which net-check.js has never emitted) is enough on its own; this
    // no longer needs to reuse an in-shape real code the way it did when the pattern was closed
    // to NC0[1-6].
    const findings = checkNumbers(base({
      apiReferenceText: 'Codes: DI01, DI02, DI03, DI04, DI05, DI06. NC codes: NC01, NC02, NC02b, NC03a, NC03b, NC04, NC05, NC06, NC09.',
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'nc-codes' });
    expect(findings[0].detail).toContain('NC09');
    expect(findings[0].detail).toContain('does not emit');
  });

  test('NC02b is matched as its own code, not as a mention of NC02', () => {
    // The trap the brief calls out: NC02b is not the same shape as DI01…DI06. If the NC
    // pattern only matched two digits, "NC02b" in prose would satisfy NC02's row and leave
    // NC02b itself permanently undocumented without the gate ever noticing.
    const findings = checkNumbers(base({
      actualNcCodes: ['NC01', 'NC02', 'NC02b', 'NC03a', 'NC03b', 'NC04', 'NC05', 'NC06'],
      apiReferenceText: 'Codes: DI01, DI02, DI03, DI04, DI05, DI06. NC codes: NC01, NC02, NC03a, NC03b, NC04, NC05, NC06.',
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'nc-codes' });
    expect(findings[0].detail).toContain('NC02b');
  });

  test('a tenth-range code (no leading zero) is caught by both drift directions', () => {
    // Regression pin for the finding this stage fixes: CODE_FAMILIES used to hard-code the `0`
    // in `DI0\d`/`NC0\d`, so a tenth code (DI10, NC10 — two digits, no leading zero) was
    // invisible on BOTH sides of the check at once: `prefix` never counted it as documented,
    // and `sourcePattern` never counted it as emitted. checkNumbers would have stayed green
    // with a real DI10/NC10 both unemitted-by-the-check and undocumented — the same failure
    // mode the NC07 regression pin above exercises for the digit count, one order of magnitude
    // up.
    const findings = checkNumbers(base({
      actualDiCodes: ['DI01', 'DI02', 'DI03', 'DI04', 'DI05', 'DI06', 'DI10'],
      actualNcCodes: ['NC01', 'NC02', 'NC02b', 'NC03a', 'NC03b', 'NC04', 'NC05', 'NC06', 'NC10'],
    }));
    expect(findings).toHaveLength(2);
    expect(findings.find((f) => f.check === 'di-codes').detail).toContain('DI10');
    expect(findings.find((f) => f.check === 'nc-codes').detail).toContain('NC10');
  });

  test('both families are checked independently in the same doc text', () => {
    const findings = checkNumbers(base({
      actualDiCodes: ['DI01', 'DI02', 'DI03', 'DI04', 'DI05', 'DI06', 'DI07'],
      actualNcCodes: ['NC01', 'NC02', 'NC02b', 'NC03a', 'NC03b', 'NC04', 'NC05'],
    }));
    expect(findings).toHaveLength(2);
    expect(findings.find((f) => f.check === 'di-codes').detail).toContain('DI07');
    expect(findings.find((f) => f.check === 'nc-codes').detail).toContain('NC06');
  });
});

describe('docs-gate — rule counts come from the ontology', () => {
  test('the real ontology: BPMN 40/5, DMN 19/3, cross-notation 2/1', async () => {
    const counts = await loadRuleSetCounts();
    expect(counts.BPMN).toEqual({ rules: 40, layers: 5 });
    expect(counts.DMN).toEqual({ rules: 19, layers: 3 });
    expect(counts['cross-notation']).toEqual({ rules: 2, layers: 1 });
  });

  test('a cross-notation rule counts only in the cross-notation rule set (F23)', () => {
    const vocabulary = {
      notations: [{ name: 'BPMN', status: 'supported' }, { name: 'DMN', status: 'supported' }],
      ruleSets: { BPMN: { rules: ['S01'], layers: ['soundness'] }, DMN: { rules: ['D01'], layers: ['soundness'] },
        'cross-notation': { rules: ['SC02'], layers: ['consistency'] } },
    };
    expect(ruleSetCounts(vocabulary)).toEqual({ BPMN: { rules: 1, layers: 1 }, DMN: { rules: 1, layers: 1 },
      'cross-notation': { rules: 1, layers: 1 } });
  });

  test('zero rules for a supported notation is a tooling error, never a count of 0', () => {
    const vocabulary = { notations: [{ name: 'BPMN', status: 'supported' }], ruleSets: { BPMN: { rules: [], layers: [] } } };
    expect(() => ruleSetCounts(vocabulary)).toThrow(ToolingError);
    expect(() => ruleSetCounts(vocabulary)).toThrow(/no BPMN rules — refusing to count 0/);
  });

  test('an announced notation with no rules is fine (F24)', () => {
    const vocabulary = { notations: [{ name: 'ArchiMate', status: 'announced' }], ruleSets: { ArchiMate: { rules: [], layers: [] } } };
    expect(ruleSetCounts(vocabulary)).toEqual({ ArchiMate: { rules: 0, layers: 0 } });
  });

  test('an ontology that fails to load is a ToolingError (exit 2), not a crash or a zero', async () => {
    const failing = () => Promise.reject(new Error('ontology.jsonld is invalid (/x): boom'));
    await expect(loadRuleSetCounts(failing)).rejects.toThrow(ToolingError);
    await expect(loadRuleSetCounts(failing)).rejects.toThrow(/^could not load the ontology \(references\/ontology\.jsonld\): ontology\.jsonld is invalid/);
  });
});

describe('docs-gate — extractActualCodes (the module-source side of a code family)', () => {
  // Regression pin for a real defect: the NC family's sourcePattern was originally hard-coded to
  // NC0[1-6][ab]?, so a wholly new code like NC07 was invisible to actualNcCodes — checkNumbers
  // never even saw it, so `npm run docs-gate` stayed green with NC07 both unemitted-by-the-check
  // AND undocumented. This exercises the CODE_FAMILIES table's real sourcePattern directly
  // (rather than injecting a hand-picked actualNcCodes array, as the checkNumbers tests above
  // do), so a future narrowing of the pattern fails here first.
  test('the NC sourcePattern captures a code outside the original NC01-NC06 range', () => {
    const family = CODE_FAMILIES.find((f) => f.check === 'nc-codes');
    const syntheticSrc = `
      const SEVERITY = { NC01: 'ERROR', NC07: 'ERROR' };
      issues.push({ code: 'NC01', severity: SEVERITY.NC01, message: 'x' });
      issues.push({ code: 'NC07', severity: SEVERITY.NC07, message: 'y' });
    `;
    expect(extractActualCodes(syntheticSrc, family.sourcePattern)).toEqual(
      expect.arrayContaining(['NC01', 'NC07']),
    );
  });

  test('the DI sourcePattern is exercised the same way, for parity', () => {
    const family = CODE_FAMILIES.find((f) => f.check === 'di-codes');
    const syntheticSrc = `issues.push({ code: 'DI01', severity: 'ERROR' });`;
    expect(extractActualCodes(syntheticSrc, family.sourcePattern)).toEqual(['DI01']);
  });

  test('both sourcePatterns capture a tenth-range code (two digits, no leading zero)', () => {
    // The `\d` in the pre-fix patterns (DI0\d, NC0\d) matched exactly one digit after the
    // hard-coded `0`, so it topped out at DI09/NC09. A code named without that leading zero —
    // DI10, NC10 — never matched at all, on the module-source side just as much as on the
    // doc-prose side tested above.
    const diFamily = CODE_FAMILIES.find((f) => f.check === 'di-codes');
    const ncFamily = CODE_FAMILIES.find((f) => f.check === 'nc-codes');
    expect(extractActualCodes(`issues.push({ code: 'DI10', severity: 'ERROR' });`, diFamily.sourcePattern))
      .toEqual(['DI10']);
    expect(extractActualCodes(`issues.push({ code: 'NC10', severity: 'ERROR' });`, ncFamily.sourcePattern))
      .toEqual(['NC10']);
  });

  test('a real net-check.js source read from disk is captured in full by its own sourcePattern', () => {
    // Closes the loop end-to-end: not a synthetic snippet, the actual file this stage's
    // (module, prefix, doc) table is pinned against, read the same way gatherNumberInputs()
    // reads it in production.
    const family = CODE_FAMILIES.find((f) => f.check === 'nc-codes');
    const netCheckSrc = readFileSync(join(__dirname, 'bpmn', 'net-check.js'), 'utf8');
    const codes = extractActualCodes(netCheckSrc, family.sourcePattern);
    expect(codes.sort()).toEqual(
      ['NC01', 'NC02', 'NC02b', 'NC03a', 'NC03b', 'NC04', 'NC05', 'NC06'].sort(),
    );
  });
});

describe('docs-gate — checkDocPaths', () => {
  // A synthetic filesystem — a fixed set of relative paths that "exist" —
  // instead of touching disk, per this file's own convention (pass texts and
  // a probe function, not the real docs, where feasible).
  const REAL_PATHS = new Set([
    'scripts/pipeline.js',
    'scripts/agents/',
    'references/input-schema.json',
    'rules/custom/',
    'tests/fixtures/',
  ]);
  const exists = (relPath) => REAL_PATHS.has(relPath);

  test('an existing path passes', () => {
    const findings = checkDocPaths([['README.md', 'See `scripts/pipeline.js` for the orchestrator.']], exists);
    expect(findings).toEqual([]);
  });

  test('a missing path is a finding naming the file and the token', () => {
    const findings = checkDocPaths([['README.md', 'See `scripts/nope.js` for details.']], exists);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'doc-paths' });
    expect(findings[0].detail).toBe('README.md mentions "scripts/nope.js" — no such path in the repository');
  });

  test('a directory claim (trailing slash) passes when the directory exists', () => {
    const findings = checkDocPaths([['CLAUDE.md', 'Agent modules live under scripts/agents/.']], exists);
    expect(findings).toEqual([]);
  });

  test('a :<line> anchor is stripped before checking', () => {
    const findings = checkDocPaths([['CLAUDE.md', 'See scripts/pipeline.js:42 for the entry point.']], exists);
    expect(findings).toEqual([]);
  });

  test('a #L<line> anchor is stripped before checking', () => {
    const findings = checkDocPaths([['CLAUDE.md', 'See scripts/pipeline.js#L42 for the entry point.']], exists);
    expect(findings).toEqual([]);
  });

  test('trailing punctuation from prose is stripped before checking', () => {
    const findings = checkDocPaths([['README.md', 'See (scripts/pipeline.js), and also scripts/pipeline.js.']], exists);
    expect(findings).toEqual([]);
  });

  test('an allowlisted transient path passes even though it does not exist', () => {
    const findings = checkDocPaths(
      [['CLAUDE.md', 'A fresh install writes to scripts/references/ during prepack.']],
      exists,
    );
    expect(findings).toEqual([]);
  });

  test('a `node pipeline.js` CLI example resolves against scripts/', () => {
    const findings = checkDocPaths([['README.md', '```\nnode pipeline.js input.json output\n```']], exists);
    expect(findings).toEqual([]);
  });

  test('a `node cli.js` CLI example resolves against scripts/robustness/', () => {
    const findings = checkDocPaths(
      [['CLAUDE.md', 'Run `node cli.js run --target=lc-json` for a robustness benchmark.']],
      (relPath) => relPath === 'scripts/robustness/cli.js',
    );
    expect(findings).toEqual([]);
  });

  test('a missing `node <file>.js` CLI example is a finding', () => {
    const findings = checkDocPaths([['README.md', 'node ghost.js input.json output']], exists);
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('node ghost.js');
  });

  test('a glob (`*`) is not treated as a real path', () => {
    const findings = checkDocPaths(
      [['SKILL.md', 'grep -rn "^import.*llm-provider" scripts/redesign*.js']],
      exists,
    );
    expect(findings).toEqual([]);
  });

  test('a placeholder (`<...>`) is not treated as a real path', () => {
    const findings = checkDocPaths(
      [['references/fachliches-regelwerk.md', "loadRuleProfile('rules/custom/<profile>.json')"]],
      exists,
    );
    expect(findings).toEqual([]);
  });

  test('the same token repeated in one file is only reported once', () => {
    const findings = checkDocPaths(
      [['README.md', 'scripts/nope.js is used here. Also see scripts/nope.js again.']],
      exists,
    );
    expect(findings).toHaveLength(1);
  });
});

// checkPackageIntegrity reads real file contents from SCRIPTS_DIR, which
// docs-gate.mjs computes from its own location, not from an argument — it is
// not pure in its two parameters alone. These tests exercise it against real
// files already in this repo instead of synthetic fixtures.
describe('docs-gate — checkPackageIntegrity', () => {
  test('a dual-path fallback resolves when the primary target ships', () => {
    // resource-paths.js reads references/input-schema.json two ways: an
    // in-package path and a dev-checkout one a level up. The checkout one is
    // SUPPOSED to escape the package (see the function's own doc comment) —
    // only report when NEITHER candidate resolves. Note this is order-independent
    // by design: resource-paths.js prefers the CHECKOUT path at runtime, and the
    // check still passes because the in-package candidate ships.
    // The packed list is spelled out rather than derived, so adding a file to
    // resource-paths.js without adding it to prepack-copy-references.mjs makes
    // this test fail. That is the point: it is pinned to the real module.
    const findings = checkPackageIntegrity(
      ['shared/resource-paths.js',
       'references/input-schema.json',
       'references/prompt-template.md',
       'references/decision-core-schema.json',
       'references/ontology.jsonld'],
      new Set([join(__dirname, 'shared', 'resource-paths.js')]),
    );
    expect(findings).toEqual([]);
  });

  test('a half-done rename — resolver on the new name, package still on the old — names the missing file', () => {
    const findings = checkPackageIntegrity(
      ['shared/resource-paths.js',
       'references/input-schema.json',
       'references/prompt-template.md',
       'references/decision-core-schema.json',
       'references/bpmn-ontology.jsonld'],
      new Set([join(__dirname, 'shared', 'resource-paths.js')]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('"references/ontology.jsonld"');
  });

  test('reproduces the original publish-blocker: primary target missing, only the escaping fallback resolves', () => {
    // Before the prepack fix, references/input-schema.json never shipped —
    // this is the exact state that made a fresh install of the published
    // package throw on first import. Kept pointed at whichever module owns the
    // dual path today; the defect it guards against is the packaging one, not
    // the module name.
    const findings = checkPackageIntegrity(
      ['shared/resource-paths.js'],
      new Set([join(__dirname, 'shared', 'resource-paths.js')]),
    );
    expect(findings).toHaveLength(4);   // one per file resource-paths.js reads
    expect(findings[0]).toMatchObject({ check: 'package-integrity' });
    expect(findings.map(f => f.detail).join(' ')).toContain('resource-paths.js');
  });

  test('a target shipped via a plain package.json "files" entry resolves', () => {
    // shared/utils.js reads config.json via resolve(__dirname, '..', 'config.json') —
    // a genuine dirname-relative read this check has to follow, not a synthetic one.
    // Pinned to the real module (like the resource-paths.js tests above) so that if
    // shared/utils.js stops existing at this path, or stops reading config.json this
    // way, this test fails loudly instead of quietly reading nothing.
    const findings = checkPackageIntegrity(
      ['shared/utils.js', 'config.json'],
      new Set([join(__dirname, 'shared', 'utils.js')]),
    );
    expect(findings).toEqual([]);
  });

  test('a file unreachable from package.json "exports" is never scanned, even if its target is missing', () => {
    // robustness/cli.js reads robustness/config.json and robustness/seed-catalog.json
    // at __dirname-relative paths that are absent from packedFiles below — a
    // finding here would be correct in isolation, but robustness/ is CLI
    // tooling invoked from a checkout, never reachable from a package.json
    // export. This pins the reachability-scoping decision the check exists to enforce.
    const findings = checkPackageIntegrity(['robustness/cli.js'], new Set());
    expect(findings).toEqual([]);
  });

  test('.test.js files are never scanned regardless of packed/reachable state', () => {
    const findings = checkPackageIntegrity(
      ['schema-gate.test.js'],
      new Set([join(__dirname, 'schema-gate.test.js')]),
    );
    expect(findings).toEqual([]);
  });

  test('a non-.js packed file is skipped without inspection', () => {
    const findings = checkPackageIntegrity(['config.json'], new Set([join(__dirname, 'config.json')]));
    expect(findings).toEqual([]);
  });
});

describe('docs-gate — evaluateChangelogNudge', () => {
  test('no conventional feat/fix/perf commits in range: no nudge', () => {
    const r = evaluateChangelogNudge({
      subjects: ['Merge pull request #29 from feat-branch', 'wip: exploring'],
      changedFiles: ['scripts/pipeline.js'],
      changelogUnreleasedText: '',
    });
    expect(r).toEqual({ nudge: false });
  });

  test('conventional commits present but none touch scripts/: no nudge', () => {
    const r = evaluateChangelogNudge({
      subjects: ['feat(docs): add a diagram'],
      changedFiles: ['docs/readme.md'],
      changelogUnreleasedText: '',
    });
    expect(r).toEqual({ nudge: false });
  });

  test('scripts/ touched and CHANGELOG.md already has [Unreleased] content: no nudge', () => {
    const r = evaluateChangelogNudge({
      subjects: ['feat(gate): add docs-gate check'],
      changedFiles: ['scripts/pipeline.js', 'CHANGELOG.md'],
      changelogUnreleasedText: '### Added\n- docs-gate check\n',
    });
    expect(r).toEqual({ nudge: false });
  });

  test('scripts/ touched, CHANGELOG.md touched but [Unreleased] is still empty: nudges', () => {
    // A junk edit to CHANGELOG.md (here: whitespace-only [Unreleased]) must
    // not read as "handled" — the nudge checks content, not "file touched".
    const r = evaluateChangelogNudge({
      subjects: ['feat(gate): add docs-gate check'],
      changedFiles: ['scripts/pipeline.js', 'CHANGELOG.md'],
      changelogUnreleasedText: '   \n  ',
    });
    expect(r.nudge).toBe(true);
    expect(r.reason).toBe('CHANGELOG.md touched but [Unreleased] is still empty');
  });

  test('scripts/ touched, CHANGELOG.md not touched: nudges with a draft grouped by type, non-conventional subjects ignored', () => {
    const r = evaluateChangelogNudge({
      subjects: [
        'feat(gate): add docs-gate check',
        'fix(http): pass diagnostics through orchestrate',
        'perf(layout): skip redundant elk re-layout on cache hit',
        'feat(api)!: change the generate response shape',
        'chore: bump deps',
        'Merge pull request #30',
      ],
      changedFiles: ['scripts/http-server.js', '.github/scripts/docs-gate.mjs'],
      changelogUnreleasedText: '',
    });
    expect(r.nudge).toBe(true);
    expect(r.reason).toBe('CHANGELOG.md not touched');
    expect(r.commitCount).toBe(4); // chore and Merge are not feat/fix/perf
    expect(r.draft).toBe([
      '### Added',
      '- add docs-gate check',
      '- change the generate response shape',
      '',
      '### Fixed',
      '- pass diagnostics through orchestrate',
      '',
      '### Changed',
      '- skip redundant elk re-layout on cache hit',
    ].join('\n'));
  });
});
