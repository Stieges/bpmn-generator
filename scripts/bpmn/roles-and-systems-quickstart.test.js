/**
 * The format 2.0 quick start of `docs/roles-and-systems.md` (section 6) is runnable: the catalogue,
 * the model and the command lines are read from the document, written to a temporary directory laid
 * out like the repository (files next to a `scripts/` directory), and every command is run with
 * `--strict`. A snippet is marked by the HTML comment `<!-- quickstart: <name> -->` on the line
 * before its fence (`jsonc` for a file, `bash` for the commands), so the plain ```json blocks that
 * `roles-and-systems-guide.test.js` counts are not touched.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUIDE = path.join(__dirname, '..', '..', 'docs', 'roles-and-systems.md');
const PIPELINE = path.join(__dirname, 'pipeline.js');
const CLI_PREFIX = 'node bpmn/pipeline.js ';

const snippets = Object.fromEntries(
  [...readFileSync(GUIDE, 'utf8').matchAll(/<!-- quickstart: ([\w.-]+) -->\n```(?:jsonc|bash)\n([\s\S]*?)```/g)].map((m) => [m[1], m[2]]),
);
const commands = (snippets.cli || '').split('\n').map((l) => l.trim()).filter(Boolean);
const LANES = {
  rollen: ['Claims handler', 'Team lead', 'Accountant', '(nicht zugeordnet)'],
  einheiten: ['Claims department', '(Einheit nicht erhoben)', '(nicht zugeordnet)'],
  organigramm: ['Claims department', '(Einheit nicht erhoben)', '(nicht zugeordnet)'],
};

describe('docs/roles-and-systems.md — the format 2.0 quick start runs', () => {
  test('the guide marks a catalogue, a model and the commands', () => {
    expect(Object.keys(snippets).sort()).toEqual(['catalog.json', 'cli', 'quickstart.json']);
    expect(commands).toHaveLength(3);
    expect(commands.map((c) => /--view=(\w+)/.exec(c)?.[1])).toEqual(['rollen', 'einheiten', 'organigramm']);
  });

  test.each(commands.map((c) => [c]))('%s', (command) => {
    expect(command.startsWith(CLI_PREFIX)).toBe(true);
    expect(command).toContain('--strict');
    const root = mkdtempSync(path.join(tmpdir(), 'quickstart-'));
    try {
      const cwd = path.join(root, 'scripts');
      mkdirSync(cwd);
      writeFileSync(path.join(root, 'catalog.json'), JSON.stringify(JSON.parse(snippets['catalog.json'])));
      writeFileSync(path.join(root, 'quickstart.json'), JSON.stringify(JSON.parse(snippets['quickstart.json'])));
      const args = command.slice(CLI_PREFIX.length).split(/\s+/);
      const run = spawnSync(process.execPath, [PIPELINE, ...args], { cwd, encoding: 'utf8' });
      expect(run.stderr).not.toMatch(/Error/);
      expect(run.status).toBe(0);
      const out = path.join(root, args[1].replace(/^\.\.\//, ''));
      expect(existsSync(`${out}.bpmn`)).toBe(true);
      expect(existsSync(`${out}.svg`)).toBe(true);
      expect(readFileSync(`${out}.bpmn`, 'utf8')).toMatch(/<bpmn:definitions/);
      expect(run.stdout).not.toMatch(/⚠ Warnings/);
      const view = /--view=(\w+)/.exec(command)[1];
      const lanes = [...readFileSync(`${out}.bpmn`, 'utf8').matchAll(/<bpmn:lane [^>]*name="([^"]*)"/g)].map((m) => m[1]);
      expect(lanes).toEqual(LANES[view]);
      expect(run.stdout).toContain('[H02]');
      expect(/\[H04\]/.test(run.stdout)).toBe(view !== 'rollen');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
