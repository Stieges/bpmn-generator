/**
 * Where to read the two `references/` files that are needed at RUNTIME
 * (`input-schema.json` for the schema gate, `prompt-template.md` for the agents).
 *
 * There are two possible layouts and the resolution has to work in both:
 *
 *   dev checkout / Skill bundle   references/ is a SIBLING of scripts/
 *   published npm package         references/ is a COPY inside the package,
 *                                 put there by prepack-copy-references.mjs
 *                                 because npm's `files` field cannot reach
 *                                 outside the package root
 *
 * **The source wins.** Where the repo-root copy exists we are in a checkout or a
 * Skill bundle, and that file is the source of truth; the in-package copy is a
 * build artifact. The precedence used to be the other way round, and that was a
 * quiet trap: `npm pack` (including `--dry-run`, which the docs gate runs for its
 * package-integrity check) executes `prepack`, which leaves the copy behind. From
 * then on every read in the checkout silently returned a SNAPSHOT of the source,
 * so editing references/input-schema.json appeared to do nothing at all. It is
 * gitignored, so `git status` says nothing either.
 *
 * In an installed package the code sits at node_modules/bpmn-generator/, so `..`
 * is node_modules/ and the source branch simply does not exist — the check is on
 * the FILE, not the directory, so a stray package named `references` would still
 * not match.
 *
 * Resolution is deliberately a FUNCTION rather than a module-load constant: a
 * constant cannot be tested without reaching into the module registry, and the
 * absence of exactly that test is why the wrong precedence survived. Callers may
 * still evaluate it eagerly at import time.
 *
 * The filenames are spelled out literally in each `join(__dirname, …)` on
 * purpose. The docs gate's package-integrity check parses those calls for string
 * literals and verifies the target actually ships; passing the name through a
 * variable would leave it looking at a directory and reporting a false violation.
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SOURCE_SCHEMA   = join(__dirname, '..', 'references', 'input-schema.json');
const PACKAGED_SCHEMA = join(__dirname, 'references', 'input-schema.json');
const SOURCE_PROMPT   = join(__dirname, '..', 'references', 'prompt-template.md');
const PACKAGED_PROMPT = join(__dirname, 'references', 'prompt-template.md');
const SOURCE_DECISION   = join(__dirname, '..', 'references', 'decision-core-schema.json');
const PACKAGED_DECISION = join(__dirname, 'references', 'decision-core-schema.json');

/**
 * Source first, packaged copy second, loud failure last. Exported because it is
 * the actual decision this module makes — including the error path, which is not
 * reachable through the two wrappers below without deleting the repo's own
 * references/.
 */
export function resolveWithFallback(sourcePath, packagedPath, label) {
  if (existsSync(sourcePath)) return sourcePath;
  if (existsSync(packagedPath)) return packagedPath;
  // Failing here beats a readFileSync ENOENT further down that says nothing
  // about which of the two layouts was expected.
  throw new Error(
    `${label} not found — looked for "${sourcePath}" (dev checkout / Skill bundle) ` +
    `and "${packagedPath}" (published package). If this is a published package, ` +
    'prepack-copy-references.mjs did not run before pack.'
  );
}

/** Absolute path to references/input-schema.json. */
export function inputSchemaPath() {
  return resolveWithFallback(SOURCE_SCHEMA, PACKAGED_SCHEMA, 'input-schema.json');
}

/** Absolute path to references/prompt-template.md. */
export function promptTemplatePath() {
  return resolveWithFallback(SOURCE_PROMPT, PACKAGED_PROMPT, 'prompt-template.md');
}

/** Absolute path to references/decision-core-schema.json. */
export function decisionCoreSchemaPath() {
  return resolveWithFallback(SOURCE_DECISION, PACKAGED_DECISION, 'decision-core-schema.json');
}
