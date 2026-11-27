// Resolve hook for hide-resvg.mjs: every import of `@resvg/resvg-wasm` (or a subpath of it)
// fails the way a missing package does, with ERR_MODULE_NOT_FOUND.
const HIDDEN = '@resvg/resvg-wasm';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === HIDDEN || specifier.startsWith(`${HIDDEN}/`)) {
    const err = new Error(`Cannot find package '${HIDDEN}' imported from ${context.parentURL} (hidden by a test hook)`);
    err.code = 'ERR_MODULE_NOT_FOUND';
    throw err;
  }
  return nextResolve(specifier, context);
}
