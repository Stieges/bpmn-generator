// Resolve hook for hide-resvg.mjs: every import of `@resvg/resvg-wasm` (or a subpath of it)
// fails the way a missing package does, with ERR_MODULE_NOT_FOUND. Each such request also writes
// a marker line to stderr, so a test can tell whether the program asked for the renderer at all.
// The write is synchronous on file descriptor 2: the hook runs on the loader thread, whose
// process.stderr is flushed asynchronously and would be lost when the CLI exits right after.
import { writeSync } from 'node:fs';

const HIDDEN = '@resvg/resvg-wasm';
const MARKER = '[hide-resvg] @resvg/resvg-wasm requested\n';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === HIDDEN || specifier.startsWith(`${HIDDEN}/`)) {
    writeSync(2, MARKER);
    const err = new Error(`Cannot find package '${HIDDEN}' imported from ${context.parentURL} (hidden by a test hook)`);
    err.code = 'ERR_MODULE_NOT_FOUND';
    throw err;
  }
  return nextResolve(specifier, context);
}
