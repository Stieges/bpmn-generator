import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

// Pinned hash of the bundled font. It must equal the value recorded in THIRD_PARTY_NOTICES.md.
const ARIMO_SHA256 = '41b22bc8f0b51f932825d37bc55b5eb6ba67dfe599a626e4aff2b43b624f9f8c';

describe('png assets — font, licence and packaging', () => {
  test('the bundled font is a TrueType file with the pinned SHA-256', () => {
    const font = readFileSync(join(root, 'fonts', 'Arimo-Regular.ttf'));
    const magic = font.subarray(0, 4);
    const isTrueType = magic.equals(Buffer.from([0x00, 0x01, 0x00, 0x00])) || magic.toString('latin1') === 'true';
    expect(isTrueType).toBe(true);
    const sha = createHash('sha256').update(font).digest('hex');
    expect(sha).toBe(ARIMO_SHA256);
    const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    expect(notices).toContain(ARIMO_SHA256);
  });

  test('the font licence ships beside the font', () => {
    const licence = readFileSync(join(root, 'fonts', 'OFL.txt'), 'utf8');
    expect(licence).toContain('SIL OPEN FONT LICENSE Version 1.1');
    // A Reserved Font Name would forbid shipping a modified (e.g. subset) font under the
    // same name; the upstream licence declares none, and the notices rely on that.
    expect(licence).not.toMatch(/with Reserved Font Name/i);
  });

  test('the published package ships fonts/', () => {
    expect(pkg.files).toContain('fonts/');
  });

  test('@resvg/resvg-wasm is an exact-pinned optional dependency', () => {
    expect(pkg.optionalDependencies['@resvg/resvg-wasm']).toBe('2.6.2');
    expect(pkg.dependencies['@resvg/resvg-wasm']).toBeUndefined();
  });

  test('the package version is unchanged', () => {
    expect(pkg.version).toBe('4.0.0-rc.2');
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
  });
});
