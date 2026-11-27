// Resolve hook for failing-resvg.mjs: the bare specifier `@resvg/resvg-wasm` resolves to the stub.
// Only the ESM import is redirected. The CommonJS resolve of `@resvg/resvg-wasm/index_bg.wasm`
// (where the renderer reads its wasm bytes) still finds the real, installed file; the stub's
// initWasm ignores those bytes.
const STUB = new URL('./resvg-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@resvg/resvg-wasm') return { url: STUB, shortCircuit: true };
  return nextResolve(specifier, context);
}
