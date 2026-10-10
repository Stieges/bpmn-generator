import { describe, test, expect } from '@jest/globals';
import { mkdtempSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule } from './entry-point.js';

describe('isMainModule', () => {
  test('posix: same file is main', () => {
    expect(isMainModule('file:///home/u/app/server.js', '/home/u/app/server.js', { windows: false })).toBe(true);
  });
  test('posix: different file is not main', () => {
    expect(isMainModule('file:///home/u/app/server.js', '/home/u/app/other.js', { windows: false })).toBe(false);
  });
  test('no argv[1] is not main', () => {
    expect(isMainModule('file:///a.js', undefined, { windows: false })).toBe(false);
  });
  test('windows: backslash path equals file:///C:/ URL (the #51 case)', () => {
    expect(isMainModule('file:///C:/Users/me/app/mcp-bpmn-server.js', 'C:\\Users\\me\\app\\mcp-bpmn-server.js', { windows: true })).toBe(true);
  });
  test('windows: drive-letter case and percent-encoding do not matter', () => {
    expect(isMainModule('file:///c:/Users/me/my%20app/s.js', 'C:\\Users\\me\\my app\\s.js', { windows: true })).toBe(true);
  });
  test('windows: different file is not main', () => {
    expect(isMainModule('file:///C:/a/s.js', 'C:\\a\\t.js', { windows: true })).toBe(false);
  });
  test('the old template-string comparison fails on Windows (documents the defect)', () => {
    expect('file:///C:/a/s.js' === `file://${'C:\\a\\s.js'}`).toBe(false);
  });

  test('a script started through a symlink is still main (import.meta.url is the real path)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'entry-'));
    try {
      const real = join(realpathSync(dir), 'real.js');
      const link = join(dir, 'link.js');
      writeFileSync(real, '');
      symlinkSync(real, link);
      expect(isMainModule(pathToFileURL(real).href, link)).toBe(true);
      expect(isMainModule(pathToFileURL(real).href, join(dir, 'missing.js'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
