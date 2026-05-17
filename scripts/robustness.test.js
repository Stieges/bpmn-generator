import { describe, test, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import { runPipeline } from './pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const autoDir = resolve(__dirname, '../tests/fixtures/robustness/auto');

describe('Robustness Regression', () => {
  const autoFixtures = fs.existsSync(autoDir)
    ? fs
        .readdirSync(autoDir)
        .filter(f => f.endsWith('.json') && !f.endsWith('.meta.json'))
        .map(f => path.join(autoDir, f))
    : [];

  if (autoFixtures.length === 0) {
    test.skip('No robustness fixtures yet — run `cli.js run` first', () => {});
    return;
  }

  autoFixtures.forEach(f => {
    test(`auto-fixture: ${path.basename(f)}`, async () => {
      const lc = JSON.parse(fs.readFileSync(f, 'utf8'));
      const result = await runPipeline(lc);
      expect(result.validation.errors).toEqual([]);
    });
  });
});
