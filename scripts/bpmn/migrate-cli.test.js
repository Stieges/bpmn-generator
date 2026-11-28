/**
 * The command line of the translator: `node bpmn/migrate.js <input.json> [output-base] [--catalog <path>]
 * [--drop-unsupported] [--force]`. Every run spawns the real program with a temp directory as working
 * directory, so nothing is written into the repository.
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, realpathSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scripts = resolve(here, '..');
const fixtures = resolve(scripts, '..', 'tests/fixtures');
const MIGRATE = join(here, 'migrate.js');
const PIPELINE = join(here, 'pipeline.js');

const run = (script, args, cwd) => {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
const migrate = (args, cwd) => run(MIGRATE, args, cwd);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const fixturePath = (name) => join(fixtures, name);

let tmp;
beforeEach(() => { tmp = realpathSync(mkdtempSync(join(tmpdir(), 'migrate-cli-'))); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('migrate CLI: the three files', () => {
  test('simple-approval writes model, catalogue supplement and report beside the given base', () => {
    const r = migrate([fixturePath('simple-approval.json'), 'out/sa'], tmp);
    expect(r.err).toBe('');
    expect(r.status).toBe(0);
    expect(readdirSync(join(tmp, 'out')).sort()).toEqual(['sa.catalog.json', 'sa.json', 'sa.migrate-report.json']);
    const model = readJson(join(tmp, 'out/sa.json'));
    const supplement = readJson(join(tmp, 'out/sa.catalog.json'));
    const report = readJson(join(tmp, 'out/sa.migrate-report.json'));
    expect(model.$schemaVersion).toBe('2.0');
    expect(model.catalog).toBe('sa.catalog.json');
    expect(Object.keys(supplement)).toEqual(['actors']);
    expect(supplement.actors.length).toBeGreaterThan(0);
    expect(report.status).toBe('translated');
    expect(r.out).toBe(`✓ ${fixturePath('simple-approval.json')} → out/sa.json: ${report.summary.actors} actors, ${report.summary.assigned} assignments, ${report.entries.length} report entries\n`);
    expect(readFileSync(join(tmp, 'out/sa.migrate-report.json'), 'utf8')).toBe(`${JSON.stringify(report, null, 2)}\n`);
  });

  test('the default base is <working directory>/<input basename>.v2, never beside the input', () => {
    const input = join(tmp, 'in', 'proc.json');
    mkdirSync(join(tmp, 'in'));
    writeFileSync(input, readFileSync(fixturePath('simple-approval.json')));
    const work = join(tmp, 'work');
    mkdirSync(work);
    const r = migrate([input], work);
    expect(r.status).toBe(0);
    expect(readdirSync(work).sort()).toEqual(['proc.v2.catalog.json', 'proc.v2.json', 'proc.v2.migrate-report.json']);
    expect(readdirSync(join(tmp, 'in'))).toEqual(['proc.json']);
    expect(r.out).toContain('→ proc.v2.json:');
  });

  test('a relative input resolves against the working directory', () => {
    mkdirSync(join(tmp, 'sub'));
    writeFileSync(join(tmp, 'sub', 'm.json'), readFileSync(fixturePath('simple-approval.json')));
    const r = migrate(['sub/m.json', 'x'], tmp);
    expect(r.status).toBe(0);
    expect(existsSync(join(tmp, 'x.json'))).toBe(true);
  });

  test('the migrated model passes pipeline.js under rollen; --strict needs a declared language', () => {
    migrate([fixturePath('simple-approval.json'), 'plain'], tmp);
    // The 1.x fixture itself fails --strict on a naming warning (no language, German rules apply): that
    // is not the translator's doing. The plain result therefore runs without --strict ...
    const plain = run(PIPELINE, ['plain.json', 'plain-out', '--view=rollen'], tmp);
    expect(plain.status).toBe(0);
    // ... and a copy with a declared language passes --strict.
    const en = readJson(fixturePath('simple-approval.json'));
    en.language = 'en';
    writeFileSync(join(tmp, 'en-in.json'), JSON.stringify(en));
    expect(migrate(['en-in.json', 'en'], tmp).status).toBe(0);
    const strict = run(PIPELINE, ['en.json', 'en-out', '--view=rollen', '--strict'], tmp);
    expect(strict.err).toBe('');
    expect(strict.status).toBe(0);
    expect(existsSync(join(tmp, 'en-out.bpmn'))).toBe(true);
  });

  test('the input file is never changed', () => {
    const input = join(tmp, 'keep.json');
    const bytes = readFileSync(fixturePath('simple-approval.json'));
    writeFileSync(input, bytes);
    migrate([input, 'k'], tmp);
    expect(readFileSync(input).equals(bytes)).toBe(true);
  });

  test('--force never overwrites a hard link to the input', () => {
    const input = join(tmp, 'in.json');
    writeFileSync(input, readFileSync(fixturePath('simple-approval.json')));
    linkSync(input, join(tmp, 'h.json'));
    const bytes = readFileSync(input);
    const r = migrate([input, 'h', '--force'], tmp);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/^✗ h\.json is the input file/);
    expect(readFileSync(input).equals(bytes)).toBe(true);
    expect(readFileSync(join(tmp, 'h.json')).equals(bytes)).toBe(true);
  });

  test('--force never overwrites the input under a base that differs only in letter case', () => {
    const input = join(tmp, 'in.json');
    writeFileSync(input, readFileSync(fixturePath('simple-approval.json')));
    const caseInsensitive = existsSync(join(tmp, 'IN.json'));
    const bytes = readFileSync(input);
    const r = migrate([input, 'IN', '--force'], tmp);
    expect(readFileSync(input).equals(bytes)).toBe(true);
    if (caseInsensitive) {
      expect(r.status).toBe(1);
      expect(r.err).toMatch(/^✗ IN\.json is the input file/);
    } else {
      // a case-sensitive file system: IN.json is a different file, so the run translates
      expect(r.status).toBe(0);
    }
  });
});

describe('migrate CLI: overwrite rule', () => {
  test('an existing output without --force exits 1 and writes nothing; --force overwrites', () => {
    const args = [fixturePath('simple-approval.json'), 'o'];
    expect(migrate(args, tmp).status).toBe(0);
    const before = readFileSync(join(tmp, 'o.json'), 'utf8');
    writeFileSync(join(tmp, 'o.json'), 'changed');
    const again = migrate(args, tmp);
    expect(again.status).toBe(1);
    expect(again.err).toBe('✗ o.json exists; pass --force to overwrite\n✗ o.catalog.json exists; pass --force to overwrite\n✗ o.migrate-report.json exists; pass --force to overwrite\n');
    expect(readFileSync(join(tmp, 'o.json'), 'utf8')).toBe('changed');
    expect(migrate([...args, '--force'], tmp).status).toBe(0);
    expect(readFileSync(join(tmp, 'o.json'), 'utf8')).toBe(before);
  });

  test('nothing is half-written: one existing file stops all three, and every existing file is named', () => {
    writeFileSync(join(tmp, 'h.catalog.json'), 'x');
    writeFileSync(join(tmp, 'h.migrate-report.json'), 'y');
    const r = migrate([fixturePath('simple-approval.json'), 'h'], tmp);
    expect(r.status).toBe(1);
    expect(r.err).toBe('✗ h.catalog.json exists; pass --force to overwrite\n✗ h.migrate-report.json exists; pass --force to overwrite\n');
    expect(existsSync(join(tmp, 'h.json'))).toBe(false);
    expect(readFileSync(join(tmp, 'h.catalog.json'), 'utf8')).toBe('x');
  });

  test('--force never overwrites the input itself', () => {
    const input = join(tmp, 'same.json');
    writeFileSync(input, readFileSync(fixturePath('simple-approval.json')));
    const bytes = readFileSync(input);
    const r = migrate([input, 'same', '--force'], tmp);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/^✗ same\.json is the input file/);
    expect(readFileSync(input).equals(bytes)).toBe(true);
  });
});

describe('migrate CLI: the given catalogue is never overwritten', () => {
  test.each([['catalog', 'g.catalog.json'], ['model', 'g.json'], ['report', 'g.migrate-report.json']])('--catalog naming the %s file of the base, even with --force', (_n, file) => {
    const given = JSON.stringify({ actors: [{ id: 'dl', name: 'Default Lane', kind: 'role' }] });
    writeFileSync(join(tmp, file), given);
    const r = migrate([fixturePath('simple-approval.json'), 'g', '--catalog', file, '--force'], tmp);
    expect(r.status).toBe(1);
    expect(r.err).toBe(`✗ ${file} is the given catalogue; choose another output base\n`);
    expect(readFileSync(join(tmp, file), 'utf8')).toBe(given);
    expect(readdirSync(tmp)).toEqual([file]);
  });

  test('--force never overwrites a hard link to the given catalogue', () => {
    const given = JSON.stringify({ actors: [{ id: 'dl', name: 'Default Lane', kind: 'role' }] });
    writeFileSync(join(tmp, 'cat.json'), given);
    linkSync(join(tmp, 'cat.json'), join(tmp, 'k.catalog.json'));
    const r = migrate([fixturePath('simple-approval.json'), 'k', '--catalog', 'cat.json', '--force'], tmp);
    expect(r.status).toBe(1);
    expect(r.err).toBe('✗ k.catalog.json is the given catalogue; choose another output base\n');
    expect(readFileSync(join(tmp, 'cat.json'), 'utf8')).toBe(given);
    expect(readdirSync(tmp).sort()).toEqual(['cat.json', 'k.catalog.json']);
  });
});

describe('migrate CLI: refusal', () => {
  /** A 1.x model that migrate refuses: a system on a gateway (MG02). */
  const refusedModel = () => {
    const path = join(tmp, 'refused.json');
    writeFileSync(path, JSON.stringify({
      id: 'Process_G', name: 'G', language: 'de',
      lanes: [{ id: 'vt', name: 'Vertrieb' }],
      nodes: [
        { id: 's', type: 'startEvent', name: 'Bestellung eingegangen', lane: 'vt' },
        { id: 'g', type: 'exclusiveGateway', name: 'Bestellung vollständig?', lane: 'vt', system: 'Shop' },
        { id: 'e', type: 'endEvent', name: 'Bestellung erledigt', lane: 'vt' }],
      edges: [{ source: 's', target: 'g' }, { source: 'g', target: 'e' }],
    }));
    return path;
  };

  test('a refused model exits 2, writes only the report and says why on stderr', () => {
    const input = refusedModel();
    const r = migrate([input, 'n'], tmp);
    expect(r.status).toBe(2);
    expect(readdirSync(tmp).sort()).toEqual(['n.migrate-report.json', 'refused.json']);
    const report = readJson(join(tmp, 'n.migrate-report.json'));
    expect(report.status).toBe('refused');
    expect(r.out).toBe('');
    const lines = r.err.trimEnd().split('\n');
    expect(lines.slice(0, report.entries.length)).toEqual(report.entries.map((e) => `✗ ${e.message}`));
    expect(lines[lines.length - 1]).toBe(`✗ ${input} not translated; the reasons are in n.migrate-report.json`);
    expect(report.entries.map((e) => e.code)).toEqual(['MG02']);
  });

  test('--drop-unsupported translates the same input', () => {
    const r = migrate([refusedModel(), 'n', '--drop-unsupported'], tmp);
    expect(r.status).toBe(0);
    expect(readdirSync(tmp).sort()).toEqual(['n.catalog.json', 'n.json', 'n.migrate-report.json', 'refused.json']);
  });

  test('a refusal leaves an earlier model and catalogue of the same base alone', () => {
    writeFileSync(join(tmp, 'n.json'), 'old model');
    writeFileSync(join(tmp, 'n.catalog.json'), 'old catalogue');
    const r = migrate([refusedModel(), 'n'], tmp);
    expect(r.status).toBe(2);
    expect(readFileSync(join(tmp, 'n.json'), 'utf8')).toBe('old model');
    expect(readFileSync(join(tmp, 'n.catalog.json'), 'utf8')).toBe('old catalogue');
  });

  test('a refusal with an existing report needs --force, and the report is the only file touched', () => {
    writeFileSync(join(tmp, 'n.migrate-report.json'), 'old report');
    const args = [refusedModel(), 'n'];
    const r = migrate(args, tmp);
    expect(r.status).toBe(1);
    expect(r.err).toBe('✗ n.migrate-report.json exists; pass --force to overwrite\n');
    expect(migrate([...args, '--force'], tmp).status).toBe(2);
    expect(readJson(join(tmp, 'n.migrate-report.json')).status).toBe('refused');
  });

  test('nested-lanes-role-system translates (its systems go into the catalogue) and passes the system view under --strict', () => {
    const r = migrate([fixturePath('nested-lanes-role-system.json'), 'n'], tmp);
    expect(r.err).toBe('');
    expect(r.status).toBe(0);
    expect(readdirSync(tmp).sort()).toEqual(['n.catalog.json', 'n.json', 'n.migrate-report.json']);
    expect(readJson(join(tmp, 'n.json')).$schemaVersion).toBe('2.1');
    expect(readJson(join(tmp, 'n.catalog.json')).systems).toEqual([{ id: 'sys_CRM', name: 'CRM' }, { id: 'sys_Workflow-System', name: 'Workflow-System' }]);
    const p = run(PIPELINE, ['n.json', join(tmp, 'out'), '--view=systeme', '--strict'], tmp);
    expect(p.err).toBe('');
    expect(p.status).toBe(0);
    expect(existsSync(join(tmp, 'out.bpmn'))).toBe(true);
  });

  test('a 2.0 input and an input failing the 1.x schema are MG01 refusals (exit 2)', () => {
    const v2 = { $schemaVersion: '2.0', nodes: [], edges: [] };
    writeFileSync(join(tmp, 'v2.json'), JSON.stringify(v2));
    expect(migrate(['v2.json', 'a'], tmp).status).toBe(2);
    expect(readJson(join(tmp, 'a.migrate-report.json')).entries[0].code).toBe('MG01');
    writeFileSync(join(tmp, 'bad.json'), '{"nodes": 5}');
    expect(migrate(['bad.json', 'b'], tmp).status).toBe(2);
    expect(readJson(join(tmp, 'b.migrate-report.json')).entries[0].code).toBe('MG01');
    writeFileSync(join(tmp, 'arr.json'), '[]');
    expect(migrate(['arr.json', 'c'], tmp).status).toBe(2);
  });
});

describe('migrate CLI: --catalog', () => {
  const given = { actors: [{ id: 'dl', name: 'Default Lane', kind: 'role' }] };

  test('a missing catalogue file exits 1 with C11 and writes nothing', () => {
    const r = migrate([fixturePath('simple-approval.json'), 'c', '--catalog', 'nope.json'], tmp);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/^✗ \[C11\] /);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test('a malformed catalogue is C12; an empty --catalog= is C11', () => {
    writeFileSync(join(tmp, 'bad.json'), '{"actors": 5}');
    const bad = migrate([fixturePath('simple-approval.json'), 'c', '--catalog', 'bad.json'], tmp);
    expect(bad.status).toBe(1);
    expect(bad.err).toMatch(/^✗ \[C12\] /);
    const empty = migrate([fixturePath('simple-approval.json'), 'c', '--catalog='], tmp);
    expect(empty.status).toBe(1);
    expect(empty.err).toMatch(/^✗ \[C11\] /);
  });

  test('--catalog <path> and --catalog=<path> match a lane by name; the model names the catalogue relative to itself', () => {
    mkdirSync(join(tmp, 'cat'));
    writeFileSync(join(tmp, 'cat', 'given.json'), JSON.stringify(given));
    for (const form of [['--catalog', 'cat/given.json'], ['--catalog=cat/given.json']]) {
      const r = migrate([fixturePath('simple-approval.json'), 'out/m', ...form, '--force'], tmp);
      expect(r.status).toBe(0);
      const model = readJson(join(tmp, 'out/m.json'));
      expect(model.catalog).toBe('../cat/given.json');
      expect(model.actors).toEqual([]);
      const supplement = readJson(join(tmp, 'out/m.catalog.json'));
      expect(supplement).toEqual({ actors: [] });
      expect(readJson(join(tmp, 'out/m.migrate-report.json')).entries.some((e) => e.code === 'MG07')).toBe(true);
    }
  });

  test('pipeline.js finds the catalogue from a different working directory', () => {
    mkdirSync(join(tmp, 'cat'));
    mkdirSync(join(tmp, 'elsewhere'));
    writeFileSync(join(tmp, 'cat', 'given.json'), JSON.stringify(given));
    expect(migrate([fixturePath('simple-approval.json'), 'out/m', '--catalog', 'cat/given.json'], tmp).status).toBe(0);
    const r = run(PIPELINE, [join(tmp, 'out/m.json'), join(tmp, 'elsewhere/o'), '--view=rollen'], join(tmp, 'elsewhere'));
    expect(r.err).not.toMatch(/\[C1\d\]/);
    expect(r.status).toBe(0);
    expect(existsSync(join(tmp, 'elsewhere/o.bpmn'))).toBe(true);
  });

  test('without --catalog the supplement carries no scheme; with it the given scheme still applies', () => {
    expect(migrate([fixturePath('simple-approval.json'), 'p'], tmp).status).toBe(0);
    expect(readJson(join(tmp, 'p.catalog.json')).scheme).toBeUndefined();
    writeFileSync(join(tmp, 'g.json'), JSON.stringify({ ...given, scheme: 'demi' }));
    expect(migrate([fixturePath('simple-approval.json'), 'q', '--catalog', 'g.json'], tmp).status).toBe(0);
    expect(readJson(join(tmp, 'q.catalog.json')).scheme).toBeUndefined();
  });
});

describe('migrate CLI: usage and I/O errors', () => {
  test.each([
    ['no input', []],
    ['an unknown flag', ['x.json', '--nope']],
    ['two output bases', ['x.json', 'a', 'b']],
    ['--catalog without a value', ['x.json', '--catalog']],
  ])('%s: exit 1 with a usage line', (_name, args) => {
    const r = migrate(args, tmp);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/Usage: node migrate\.js <input\.json>/);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test.each([[['--help']], [['-h']], [['x.json', '--help']], [['x.json', 'a', '-h', '--nope']]])('%p prints the usage on stdout and exits 0, reading and writing nothing', (args) => {
    const r = migrate(args, tmp);
    expect(r.status).toBe(0);
    expect(r.out).toBe('Usage: node migrate.js <input.json> [output-base] [--catalog <path>] [--drop-unsupported] [--force]\n');
    expect(r.err).toBe('');
    expect(readdirSync(tmp)).toEqual([]);
  });

  test('an unreadable input and an input that is not JSON exit 1', () => {
    const missing = migrate(['missing.json', 'a'], tmp);
    expect(missing.status).toBe(1);
    expect(missing.err).toMatch(/^✗ missing\.json cannot be read/);
    writeFileSync(join(tmp, 'broken.json'), '{ nope');
    const broken = migrate(['broken.json', 'b'], tmp);
    expect(broken.status).toBe(1);
    expect(broken.err).toMatch(/^✗ broken\.json is not valid JSON/);
    expect(readdirSync(tmp).sort()).toEqual(['broken.json']);
  });

  test('importing the module runs nothing', async () => {
    const mod = await import('./migrate.js');
    expect(typeof mod.migrateModel).toBe('function');
  });
});
