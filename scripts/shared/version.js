/**
 * The package version, read once from scripts/package.json.
 *
 * That file sits one level above this module in the source tree, in the npm package and in the
 * bundled skill alike (npm always ships package.json). Read with a URL relative to this module,
 * not a join(__dirname, …), so it is no extra packaged-file read for the docs gate to chase.
 * An unreadable file yields 'unknown' rather than taking a server down for a version string.
 */
import { readFileSync } from 'node:fs';

function readVersion() {
  try {
    const v = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    return typeof v === 'string' && v ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const PACKAGE_VERSION = readVersion();
