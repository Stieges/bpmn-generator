import { describe, test, expect, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inputSchemaPath, promptTemplatePath, resolveWithFallback } from './resource-paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGED_DIR = join(__dirname, '..', 'references');
const REPO_REFERENCES = join(__dirname, '..', '..', 'references');

// These tests create and remove the very build artifact the resolver has to
// ignore, so they must leave the checkout exactly as they found it. Nothing here
// touches the repo-root references/ — the source is only ever read.
//
// This is shared filesystem state that other test files' modules read at import
// time, and Jest runs files in parallel workers. It is safe precisely because of
// the property under test: with the source winning, a copy appearing or vanishing
// mid-run cannot change what any other module reads. If that precedence is ever
// inverted again, this file becomes a source of flakes as well as a red test —
// which is the correct incentive.
afterEach(() => {
  rmSync(PACKAGED_DIR, { recursive: true, force: true });
});

function writePackagedCopy(contents) {
  mkdirSync(PACKAGED_DIR, { recursive: true });
  writeFileSync(join(PACKAGED_DIR, 'input-schema.json'), contents.schema ?? '{}');
  writeFileSync(join(PACKAGED_DIR, 'prompt-template.md'), contents.prompt ?? '# stale');
}

describe('resource-paths — the source outranks the build artifact', () => {
  test('a leftover in-package copy does not shadow references/', () => {
    // This is the whole point of the module. `npm pack` — including the
    // `--dry-run` the docs gate performs — runs prepack, which leaves a copy of
    // references/ inside scripts/. The old precedence read that copy, so after
    // running the gate once, every later edit to references/input-schema.json
    // silently had no effect. It is gitignored, so nothing said so.
    writePackagedCopy({ schema: '{"stale": true}' });

    expect(existsSync(join(PACKAGED_DIR, 'input-schema.json'))).toBe(true);
    expect(inputSchemaPath()).toBe(join(REPO_REFERENCES, 'input-schema.json'));
    expect(promptTemplatePath()).toBe(join(REPO_REFERENCES, 'prompt-template.md'));
  });

  test('and the content that comes back is the source, not the snapshot', () => {
    // Asserting the path alone would still pass if a caller resolved differently.
    // Read through and compare against the real file.
    writePackagedCopy({ schema: '{"stale": true}' });
    const got = JSON.parse(readFileSync(inputSchemaPath(), 'utf8'));
    const source = JSON.parse(readFileSync(join(REPO_REFERENCES, 'input-schema.json'), 'utf8'));
    expect(got.stale).toBeUndefined();
    expect(got.$id ?? got.title).toEqual(source.$id ?? source.title);
  });

  test('with no copy present it still resolves — the ordinary dev checkout', () => {
    expect(existsSync(PACKAGED_DIR)).toBe(false);
    expect(inputSchemaPath()).toBe(join(REPO_REFERENCES, 'input-schema.json'));
    expect(promptTemplatePath()).toBe(join(REPO_REFERENCES, 'prompt-template.md'));
  });

  test('the schema gate reads the source too, not just the resolver', () => {
    // The resolver being right is worth nothing if a consumer resolves its own
    // way. schema-gate.js compiles its validator at module load, so this asserts
    // the wiring rather than re-testing the resolver: a schema poisoned to reject
    // everything would fail this if the copy were being read.
    writePackagedCopy({ schema: JSON.stringify({ type: 'string' }) });
    return import('../bpmn/schema-gate.js').then(({ validateLogicCoreSchema }) => {
      const lc = { pools: [{ id: 'P', name: 'P', nodes: [{ id: 's', type: 'startEvent' }], edges: [] }] };
      expect(validateLogicCoreSchema(lc).valid).toBe(true);
    });
  });
});

describe('resource-paths — the published layout still works', () => {
  const missing = join(__dirname, '__no_such_dir__', 'input-schema.json');

  test('with no source present it falls back to the packaged copy', () => {
    // This is the installed-package case: node_modules/bpmn-generator/ has no
    // ../references, so the copy prepack wrote is all there is. Exercised through
    // resolveWithFallback because the repo's own references/ cannot be taken away.
    writePackagedCopy({ schema: '{"packaged": true}' });
    const packaged = join(PACKAGED_DIR, 'input-schema.json');
    expect(resolveWithFallback(missing, packaged, 'input-schema.json')).toBe(packaged);
  });

  test('with neither layout present it throws and names both paths', () => {
    // A readFileSync ENOENT three modules down says nothing about which layout
    // was expected, nor that prepack is the thing that did not run.
    expect(() => resolveWithFallback(missing, missing, 'input-schema.json'))
      .toThrow(/input-schema\.json not found[\s\S]*prepack-copy-references\.mjs/);
  });
});
