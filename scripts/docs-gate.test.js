import { describe, test, expect } from '@jest/globals';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkResponseContract,
  checkNumbers,
  checkDocPaths,
  checkPackageIntegrity,
  evaluateChangelogNudge,
  ToolingError,
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
    readmeText: 'The rule engine has 33 rules, 5 layers, covering soundness and style.',
    claudeMdText: '29 top-level scripts live under scripts/. The rule engine has 33 rules, 5 layers.',
    apiReferenceText: 'Codes: DI01, DI02, DI03, DI04, DI05, DI06.',
    roadmapText: 'Validation (33 rules, 5 layers) via ElkJS.',
    skillText: 'No rule/layer count claim in this fixture — SKILL.md does not currently make one.',
    evaluationText: 'Configurable rule engine | Yes (33 rules, 5 layers, JSON profiles).',
    pipelineDocText: 'Führt 33 Regeln in 5 Schichten aus.',
    actualRuleCount: 33,
    actualLayerCount: 5,
    actualDmnRuleCount: 8,
    actualDmnLayerCount: 2,
    actualTopLevelScriptCount: 29,
    actualDiCodes: ['DI01', 'DI02', 'DI03', 'DI04', 'DI05', 'DI06'],
    ...overrides,
  });

  test('matching numbers and codes yield nothing', () => {
    expect(checkNumbers(base())).toEqual([]);
  });

  // Two rule engines now: scripts/rules.js and scripts/dmn/rules.js. A claim is
  // routed by whether its own LINE says DMN — see the comment on DMN_CLAIM_RE for
  // why routing on the text beats accepting whatever matches either engine.
  test('a DMN claim is measured against the DMN engine, not the BPMN one', () => {
    expect(checkNumbers(base({
      claudeMdText: '29 top-level scripts. The DMN engine has 8 rules, 2 layers.',
    }))).toEqual([]);
  });

  test('a wrong DMN claim is still caught, and names the DMN file', () => {
    const findings = checkNumbers(base({
      claudeMdText: '29 top-level scripts. The DMN engine has 9 rules, 2 layers.',
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('scripts/dmn/rules.js');
    expect(findings[0].detail).toContain('has 8 rules');
  });

  test('an unqualified claim is measured against the BPMN engine even when it fits DMN', () => {
    // The point of routing on the line rather than on "does it match either":
    // "8 rules, 2 layers" with no mention of DMN is a wrong BPMN claim, and has
    // to fail. A reader cannot tell those sentences apart either.
    const findings = checkNumbers(base({
      readmeText: 'The rule engine has 8 rules, 2 layers.',
    }));
    expect(findings).toHaveLength(2);        // rule count and layer count
    expect(findings[0].detail).toContain('scripts/rules.js');
  });

  test('the two engines are checked independently in one file', () => {
    const findings = checkNumbers(base({
      claudeMdText: '29 top-level scripts. Engine: 33 rules, 5 layers.\nDMN: 7 rules, 2 layers.',
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('scripts/dmn/rules.js');
  });

  test('a stale rule count in README.md is a finding', () => {
    const findings = checkNumbers(base({ readmeText: 'The rule engine has 32 rules, 5 layers.' }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'rule-count' });
    expect(findings[0].detail).toContain('README.md');
  });

  test('a stale rule count in CLAUDE.md is a finding', () => {
    const findings = checkNumbers(base({ claudeMdText: '29 top-level scripts. The rule engine has 34 rules, 5 layers.' }));
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('CLAUDE.md');
  });

  test('an unrelated "N rules" mention does not false-positive', () => {
    // Regression pin: README.md's "WF-Net (3 rules)" mention (WF01-WF03) once
    // matched a broader /\d+ rules\b/ and was wrongly compared to the 33-rule
    // engine total. Requiring a layer count in the same match is what protects
    // this: a subset claim never also states how many layers the engine has.
    const findings = checkNumbers(base({
      readmeText: 'WF-Net soundness (3 rules) is opt-in. The rule engine has 33 rules, 5 layers.',
    }));
    expect(findings).toEqual([]);
  });

  test('a stale layer count is caught even when the rule count is right', () => {
    // Regression pin: the original pattern hard-coded the literal "5 layers",
    // so a doc claiming a wrong layer count with the right rule count was
    // invisible to it by construction — this is exactly the class of bug
    // that shipped in ROADMAP.md/EVALUATION.md ("N rules, 4 layers").
    const findings = checkNumbers(base({ roadmapText: 'Validation (33 rules, 4 layers) via ElkJS.' }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'rule-count' });
    expect(findings[0].detail).toContain('ROADMAP.md');
    expect(findings[0].detail).toContain('distinct layers');
  });

  test('a stale rule count in ROADMAP.md is a finding — a file the old check never read', () => {
    const findings = checkNumbers(base({ roadmapText: 'Validation (28 rules, 5 layers) via ElkJS.' }));
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('ROADMAP.md');
  });

  test('the "N rules in M layers" phrasing (no comma) is also caught', () => {
    const findings = checkNumbers(base({ evaluationText: 'Configurable rule engine | Yes (27 rules in 4 layers).' }));
    expect(findings).toHaveLength(2); // wrong rule count AND wrong layer count in one match
    expect(findings.every((f) => f.detail.includes('EVALUATION.md'))).toBe(true);
  });

  test('the German phrasing in docs/bpmn-generator-pipeline.md is checked too', () => {
    const findings = checkNumbers(base({ pipelineDocText: 'Führt 22 Regeln in 4 Schichten aus.' }));
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.detail.includes('docs/bpmn-generator-pipeline.md'))).toBe(true);
  });

  test('a missing "N top-level scripts" claim in CLAUDE.md is a finding', () => {
    const findings = checkNumbers(base({ claudeMdText: 'The rule engine has 33 rules, 5 layers.' }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'script-count' });
    expect(findings[0].detail).toContain('wording changed');
  });

  test('a stale top-level script count is a finding', () => {
    const findings = checkNumbers(base({ claudeMdText: '28 top-level scripts. 33 rules, 5 layers.' }));
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
    const findings = checkNumbers(base({ apiReferenceText: 'Codes: DI01, DI02, DI03, DI04, DI05, DI06, DI09.' }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'di-codes' });
    expect(findings[0].detail).toContain('DI09');
    expect(findings[0].detail).toContain('does not emit');
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
      ['resource-paths.js',
       'references/input-schema.json',
       'references/prompt-template.md',
       'references/decision-core-schema.json'],
      new Set([join(__dirname, 'resource-paths.js')]),
    );
    expect(findings).toEqual([]);
  });

  test('reproduces the original publish-blocker: primary target missing, only the escaping fallback resolves', () => {
    // Before the prepack fix, references/input-schema.json never shipped —
    // this is the exact state that made a fresh install of the published
    // package throw on first import. Kept pointed at whichever module owns the
    // dual path today; the defect it guards against is the packaging one, not
    // the module name.
    const findings = checkPackageIntegrity(
      ['resource-paths.js'],
      new Set([join(__dirname, 'resource-paths.js')]),
    );
    expect(findings).toHaveLength(3);   // one per file resource-paths.js reads
    expect(findings[0]).toMatchObject({ check: 'package-integrity' });
    expect(findings.map(f => f.detail).join(' ')).toContain('resource-paths.js');
  });

  test('a target shipped via a plain package.json "files" entry resolves', () => {
    const findings = checkPackageIntegrity(
      ['utils.js', 'config.json'],
      new Set([join(__dirname, 'utils.js')]),
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
