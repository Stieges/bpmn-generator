#!/usr/bin/env node
/**
 * prepack step — copies the two references/ files the published package
 * actually reads at runtime (schema-gate.js, agents/prompt-sections.js) into
 * scripts/references/, so they ship inside the npm tarball.
 *
 * references/ is the canonical source and stays at the repo root. Runtime reads
 * go through resource-paths.js, which prefers that source and treats what this
 * script writes as the fallback for the published layout — see the reasoning
 * there. scripts/references/ is gitignored; it is a build artifact, regenerated
 * by `npm pack`/`npm publish` (which both run `prepack` automatically) or by
 * running this script directly, and removed again by
 * postpack-clean-references.mjs.
 *
 * Why a copy instead of a package.json "files" entry pointing at "../references":
 * npm's `files` field cannot reach outside the package root (verified: an
 * entry like "../references/input-schema.json" is silently dropped from the
 * pack, not an error) — there is no way to publish a file from outside
 * scripts/ without either moving it in permanently or copying it in at
 * pack time. A permanent move would touch every doc, script and this
 * project's Claude Code Skill bundle (build-skill.mjs) that references
 * `references/...` today; a copy at pack time touches only packaging.
 */

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = join(__dirname, '..', 'references');
const DEST_DIR = join(__dirname, 'references');

// Keep in step with resource-paths.js — every file resolved there must be packed
// here, or the published package throws on first import. The docs gate's
// package-integrity check is what catches a mismatch.
const FILES = ['input-schema.json', 'prompt-template.md', 'decision-core-schema.json'];

mkdirSync(DEST_DIR, { recursive: true });
for (const name of FILES) {
  copyFileSync(join(SOURCE_DIR, name), join(DEST_DIR, name));
}
// stderr, not stdout: `npm pack --json`/`npm publish --json` write their JSON
// payload to stdout, and this script's own output must not land in the middle
// of it. Matches npm's own lifecycle-banner convention (also stderr).
console.error(`prepack: copied ${FILES.length} file(s) from references/ to scripts/references/`);
