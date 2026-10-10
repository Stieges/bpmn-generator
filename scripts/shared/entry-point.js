/**
 * "Was this module started as the program?" — one platform-independent answer.
 *
 * The naive guard `import.meta.url === \`file://${process.argv[1]}\`` is false on Windows
 * (`file:///C:/x/y.js` vs `file://C:\x\y.js`), so a CLI/server entry silently did nothing and
 * exited 0 (#51). Both sides are turned into a file-system path instead, and compared with the
 * path rules of the platform in question.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} metaUrl  the caller's `import.meta.url`
 * @param {string|undefined} argv1  `process.argv[1]`
 * @param {{windows?: boolean}} [opts]  override the platform (tests use it for Windows paths)
 */
export function isMainModule(metaUrl, argv1, { windows = process.platform === 'win32' } = {}) {
  if (!argv1) return false;
  const p = windows ? path.win32 : path.posix;
  const norm = (s) => (windows ? s.toLowerCase() : s);
  try {
    return norm(p.resolve(fileURLToPath(metaUrl, { windows }))) === norm(p.resolve(argv1));
  } catch {
    return false;
  }
}
