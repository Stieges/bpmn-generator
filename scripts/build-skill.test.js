import { describe, test, expect } from '@jest/globals';
import path from 'path';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import {
  hasSegment, includeScriptFile, includeReferenceFile,
  collectIncludes, skillEntryPoints, relativeImports, reachableModules, NOT_SKILL_CLIS,
} from './build-skill.mjs';

// The skill bundle's exclusions must hold on Windows too: a substring test for '/node_modules/'
// never matches a backslash-separated path, and the bundle then carried all of node_modules.
// Paths are built with path.win32 / path.posix explicitly, so the test means the same thing on
// every platform it runs on.
describe('build-skill — path-segment exclusions are platform-independent', () => {
  const win = (...p) => path.win32.join(...p);
  const posix = (...p) => path.posix.join(...p);

  test('hasSegment matches a whole segment with either separator', () => {
    expect(hasSegment(win('C:\\repo', 'scripts', 'node_modules', 'elkjs', 'x.js'), 'node_modules')).toBe(true);
    expect(hasSegment(posix('/repo', 'scripts', 'node_modules', 'elkjs', 'x.js'), 'node_modules')).toBe(true);
    expect(hasSegment('scripts\\agents/chat.js', 'agents')).toBe(true);
  });

  test('hasSegment does not match a part of a segment', () => {
    expect(hasSegment(win('scripts', 'agents-old', 'x.js'), 'agents')).toBe(false);
    expect(hasSegment(win('scripts', 'bpmn', 'my_node_modules.js'), 'node_modules')).toBe(false);
  });

  test('the substring check this replaces fails on a Windows path', () => {
    const p = win('C:\\repo', 'scripts', 'node_modules', 'elkjs', 'x.js');
    expect(p.includes('/node_modules/')).toBe(false);
  });

  for (const [label, join] of [['win32', win], ['posix', posix]]) {
    test(`script filter (${label}) excludes node_modules, agents, robustness and tests`, () => {
      expect(includeScriptFile(join('node_modules', 'elkjs', 'lib', 'elk.js'), 'elk.js')).toBe(false);
      expect(includeScriptFile(join('agents', 'chat.js'), 'chat.js')).toBe(false);
      expect(includeScriptFile(join('robustness', 'cli.js'), 'cli.js')).toBe(false);
      expect(includeScriptFile(join('bpmn', 'rules.test.js'), 'rules.test.js')).toBe(false);
      expect(includeScriptFile(join('bpmn', 'pipeline.js'), 'pipeline.js')).toBe(true);
      expect(includeScriptFile('config.json', 'config.json')).toBe(true);
      expect(includeScriptFile('build-skill.mjs', 'build-skill.mjs')).toBe(false);
    });

    test(`reference filter (${label}) excludes omg-spec and review-set`, () => {
      expect(includeReferenceFile(join('omg-spec', 'BPMN20.cmof.md'), 'BPMN20.cmof.md')).toBe(false);
      expect(includeReferenceFile(join('review-set', 'a.json'), 'a.json')).toBe(false);
      expect(includeReferenceFile('ontology.jsonld', 'ontology.jsonld')).toBe(true);
      expect(includeReferenceFile('input-schema.json', 'input-schema.json')).toBe(true);
    });
  }
});

// The bundle must be able to import its own entry points. The earlier rule (every .js except
// agents/ and robustness/) shipped orchestrator.js, http-server.js and mcp-bpmn-server.js,
// which all import agents/, so three bundled scripts failed at import.
describe('build-skill — the bundle is closed under its own imports', () => {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = collectIncludes(repoRoot);
  const bundled = new Set(files);

  // SKILL.md keeps only the core commands; the rest moved into the reference files it links to
  // (progressive disclosure). Discovery reads both, so every CLI documented anywhere in the
  // bundle's instructions ships.
  const instructionTexts = ['SKILL.md', ...files.filter(f => f.startsWith('references/') && f.endsWith('.md'))]
    .map(f => readFileSync(path.join(repoRoot, f), 'utf8'));

  test('every CLI SKILL.md or a bundled reference file tells the skill to run is bundled', () => {
    const entries = skillEntryPoints(...instructionTexts);
    expect(entries).toEqual(expect.arrayContaining([
      'bpmn/pipeline.js', 'bpmn/import.js', 'bpmn/redesign-cli.js',
      'dmn/pipeline.js', 'dmn/import.js', 'scenarios/pipeline.js',
    ]));
    for (const e of entries) expect(bundled).toContain(`scripts/${e}`);
  });

  test('the server CLIs the reference files document are named as not run by the skill, never bundled', () => {
    expect([...NOT_SKILL_CLIS].sort()).toEqual(['http-server.js', 'mcp-bpmn-server.js']);
    for (const e of NOT_SKILL_CLIS) expect(bundled).not.toContain(`scripts/${e}`);
  });

  test('skillEntryPoints reads several texts, drops a scripts/ prefix and the server CLIs', () => {
    expect(skillEntryPoints('run `node bpmn/pipeline.js a b`', 'or `node scripts/dmn/import.js x`',
      'start `node scripts/http-server.js` and `node mcp-bpmn-server.js`', 'again `node bpmn/pipeline.js`'))
      .toEqual(['bpmn/pipeline.js', 'dmn/import.js']);
  });

  test('every module a bundled module imports is bundled too', () => {
    const missing = [];
    for (const f of files.filter(f => f.endsWith('.js'))) {
      const src = readFileSync(path.join(repoRoot, f), 'utf8');
      for (const spec of relativeImports(src)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), spec));
        if (!bundled.has(target)) missing.push(`${f} -> ${target}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('the bundle contains every module reachable from the bundled entry points', () => {
    const entries = files.filter(f => f.startsWith('scripts/') && f.endsWith('.js'))
      .map(f => f.slice('scripts/'.length));
    for (const m of reachableModules(path.join(repoRoot, 'scripts'), entries)) {
      expect(bundled).toContain(`scripts/${m}`);
    }
  });

  test('the runtime-read files ship; the agent-dependent servers and agents/ do not', () => {
    for (const f of ['scripts/config.json', 'scripts/package.json',
      'references/input-schema.json', 'references/ontology.jsonld', 'references/prompt-template.md']) {
      expect(bundled).toContain(f);
    }
    for (const f of ['scripts/orchestrator.js', 'scripts/http-server.js', 'scripts/mcp-bpmn-server.js']) {
      expect(bundled).not.toContain(f);
    }
    expect(files.filter(f => hasSegment(f, 'agents') || hasSegment(f, 'robustness') || f.endsWith('.test.js')))
      .toEqual([]);
  });

  test('relativeImports sees static, re-export and literal dynamic imports, not bare specifiers', () => {
    const src = "import a from './a.js';\nimport { b } from '../b.js';\nexport { c } from './c.js';\n" +
      "const d = await import('./d.js');\nimport e from 'elkjs';\nimport f from 'node:fs';";
    expect(relativeImports(src).sort()).toEqual(['../b.js', './a.js', './c.js', './d.js']);
  });

  const fakeRepo = (entrySrc, extra = {}) => {
    const root = mkdtempSync(path.join(tmpdir(), 'skill-'));
    mkdirSync(path.join(root, 'scripts', 'agents'), { recursive: true });
    mkdirSync(path.join(root, 'references'));
    writeFileSync(path.join(root, 'SKILL.md'), 'Run `node entry.js in out`.');
    writeFileSync(path.join(root, 'scripts', 'entry.js'), entrySrc);
    for (const [rel, src] of Object.entries(extra)) writeFileSync(path.join(root, 'scripts', rel), src);
    return root;
  };

  test('an entry point that reaches an excluded module aborts the build', () => {
    const root = fakeRepo("import { x } from './agents/x.js';\n", { 'agents/x.js': 'export const x = 1;\n' });
    expect(() => collectIncludes(root)).toThrow(/agents\/x\.js/);
  });

  test('a CLI named only in a reference file becomes an entry point', () => {
    const root = fakeRepo("export const e = 1;\n", { 'other.js': "import { y } from './dep.js';\n", 'dep.js': 'export const y = 1;\n' });
    writeFileSync(path.join(root, 'references', 'guide.md'), 'Run `node other.js in out`.');
    expect(collectIncludes(root)).toEqual(expect.arrayContaining(
      ['scripts/entry.js', 'scripts/other.js', 'scripts/dep.js', 'references/guide.md']));
  });

  test('an import of a file that does not exist aborts the build', () => {
    const root = fakeRepo("import { y } from './gone.js';\n");
    expect(() => collectIncludes(root)).toThrow(/gone\.js is imported but does not exist/);
  });
});
