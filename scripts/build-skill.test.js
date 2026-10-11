import { describe, test, expect } from '@jest/globals';
import path from 'path';
import { hasSegment, includeScriptFile, includeReferenceFile } from './build-skill.mjs';

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
