#!/usr/bin/env node
/**
 * postpack step — removes the scripts/references/ copy that prepack made.
 *
 * The copy exists only so `npm pack` can put those files in the tarball
 * (see prepack-copy-references.mjs for why a copy is the only option). Once the
 * tarball is written the artifact has done its job, and leaving it behind used
 * to be a quiet trap: `npm pack --dry-run` — which the docs gate runs for its
 * package-integrity check — created it too, so simply running the gate left a
 * snapshot of references/ sitting in the checkout.
 *
 * Since then resource-paths.js prefers the source over the copy, so a leftover
 * is no longer harmful. Removing it is still right: a build artifact should not
 * outlive the build, and it is gitignored, so nothing else would ever mention
 * that it is there.
 *
 * Verified: npm runs `postpack` after BOTH `npm pack` and `npm pack --dry-run`,
 * and in both cases after the file list has been determined — so this cannot
 * remove files from the tarball it is cleaning up after.
 */

import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEST_DIR = join(__dirname, 'references');

rmSync(DEST_DIR, { recursive: true, force: true });
// stderr for the same reason prepack uses it: `npm pack --json` writes its
// payload to stdout and must not be polluted.
console.error('postpack: removed scripts/references/ (build artifact)');
