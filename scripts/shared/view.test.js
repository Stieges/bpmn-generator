import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertView, loadView, loadNamedView, ViewRejectedError, VIEW_LIMITS, resolveViewOptions } from './view.js';
import { PROFILE_LIMITS } from './rule-profile.js';
import { viewsDirFor, viewsDirPath } from './resource-paths.js';

describe('shipped views', () => {
  test.each(['aligned-ports', 'default', 'einheiten', 'explicit-joins', 'organigramm', 'rollen', 'systeme'])('%s loads by name and passes the gate', (name) => {
    const view = loadNamedView(name);
    expect(view.view).toBe(name);
    expect(() => assertView(view)).not.toThrow();
  });

  test('derivations differ, neither names a rule profile', () => {
    expect(loadNamedView('default').derivations.joinGateways).toBe(false);
    expect(loadNamedView('explicit-joins').derivations.joinGateways).toBe(true);
    expect(loadNamedView('default').ruleProfile).toBeUndefined();
    expect(loadNamedView('explicit-joins').ruleProfile).toBeUndefined();
  });

  test('rollen and einheiten form lanes; the other two carry no lanes key', () => {
    expect(loadNamedView('rollen').lanes).toBe('role');
    expect(loadNamedView('einheiten').lanes).toBe('unit');
    expect('lanes' in loadNamedView('default')).toBe(false);
    expect('lanes' in loadNamedView('explicit-joins')).toBe(false);
  });

  test('resolveViewOptions passes lanes and the view name on; without a view both are undefined', () => {
    expect(resolveViewOptions(loadNamedView('einheiten'))).toMatchObject({ lanes: 'unit', viewName: 'einheiten' });
    const none = resolveViewOptions(null, {});
    expect(none.lanes).toBeUndefined();
    expect(none.viewName).toBeUndefined();
  });

  test('a lanes value off the enum is refused', () => {
    expect(() => assertView({ view: 'x', version: '1.0', lanes: 'process' })).toThrow(ViewRejectedError);
  });

  test('systeme forms lanes per system of the task', () => {
    expect(loadNamedView('systeme').lanes).toBe('system');
    expect(() => assertView({ view: 'x', version: '1.0', lanes: 'system' })).not.toThrow();
    expect(() => assertView({ view: 'x', version: '1.0', lanes: { by: 'system' } })).toThrow(ViewRejectedError);
    expect(() => assertView({ view: 'x', version: '1.0', lanes: { by: 'system', automatic: 'lane' } })).toThrow(ViewRejectedError);
  });

  test('organigramm nests the unit lanes along partOf', () => {
    expect(loadNamedView('organigramm').lanes).toEqual({ by: 'unit', nested: true });
  });

  test('both forms of lanes pass the gate', () => {
    for (const lanes of ['role', 'unit', 'none', { by: 'unit' }, { by: 'unit', level: 2 }, { by: 'unit', level: 16, nested: true }, { by: 'unit', nested: false }]) {
      expect(() => assertView({ view: 'x', version: '1.0', lanes })).not.toThrow();
    }
  });

  test('the automatic switch and its name pass the gate', () => {
    for (const lanes of [{ by: 'role' }, { by: 'role', automatic: 'lane' }, { by: 'role', automatic: 'lane', automaticName: '(maschinell)' },
      { by: 'unit', nested: true, automatic: 'lane' }, { by: 'unit', level: 2, automatic: 'neighbour' }]) {
      expect(() => assertView({ view: 'x', version: '1.0', lanes })).not.toThrow();
    }
  });

  test.each([
    [{ by: 'role', nested: true }],
    [{ by: 'unit', level: 0 }],
    [{ by: 'unit', level: 17 }],
    [{ by: 'unit', level: 1.5 }],
    [{ by: 'unit', nested: 'yes' }],
    [{ by: 'unit', depth: 2 }],
    [{ level: 2 }],
  ])('the lanes object %j is a view error', (lanes) => {
    expect(() => assertView({ view: 'x', version: '1.0', lanes })).toThrow(ViewRejectedError);
  });

  test('limits equal the profile limits', () => {
    expect(VIEW_LIMITS).toEqual(PROFILE_LIMITS);
  });
});

describe('assertView', () => {
  test('a misspelt key is refused and named', () => {
    const bad = { view: 'x', version: '1.0', derivation: {} };
    expect(() => assertView(bad)).toThrow(ViewRejectedError);
    expect(() => assertView(bad)).toThrow(/derivation/);
  });

  test('unknown keys are refused at nested levels', () => {
    expect(() => assertView({ view: 'x', version: '1.0', layout: { bend: true } })).toThrow(/bend/);
  });

  test('accepts every documented layout switch', () => {
    expect(() => assertView({
      view: 'x', version: '1.0', ruleProfile: 'strict',
      layout: { bendRule: true, nodeLabelsAvoidFlows: false, foreignShapeRepair: true,
        visualRefinement: { laneCompaction: true }, poolOrder: 'declared', elkWrapping: 'auto' },
      derivations: { joinGateways: true },
    })).not.toThrow();
  });

  test('visualRefinement takes no keys beyond the shared option schema', () => {
    expect(() => assertView({ view: 'x', version: '1.0', layout: { visualRefinement: { laneCompaction: 'yes' } } })).toThrow(ViewRejectedError);
    expect(() => assertView({ view: 'x', version: '1.0', layout: { visualRefinement: { anything: true } } })).toThrow(/anything/);
  });

  test('refuses a bad enum, a path as rule profile, a wrong version, a non-object', () => {
    expect(() => assertView({ view: 'x', version: '1.0', layout: { poolOrder: 'sorted' } })).toThrow(ViewRejectedError);
    expect(() => assertView({ view: 'x', version: '1.0', ruleProfile: '../strict' })).toThrow(ViewRejectedError);
    expect(() => assertView({ view: 'x', version: '2.0' })).toThrow(ViewRejectedError);
    expect(() => assertView([])).toThrow(ViewRejectedError);
    expect(() => assertView(null)).toThrow(ViewRejectedError);
  });

  test('refuses an object over 64 KiB', () => {
    expect(() => assertView({ view: 'x', version: '1.0', description: 'a'.repeat(70 * 1024) })).toThrow(/larger than 64 KiB/);
  });

  test('refuses an object deeper than 4 levels', () => {
    expect(() => assertView({ view: 'x', version: '1.0', layout: { visualRefinement: { a: { b: { c: 1 } } } } }))
      .toThrow(/deeper than 4/);
  });
});

describe('layout.alignParticipantPorts in a view', () => {
  test('aligned-ports carries the key into the resolved options; the explicit option wins; others leave it absent', () => {
    expect(resolveViewOptions(loadNamedView('aligned-ports')).alignParticipantPorts).toBe(true);
    expect(resolveViewOptions(loadNamedView('aligned-ports'), { alignParticipantPorts: false }).alignParticipantPorts).toBe(false);
    expect('alignParticipantPorts' in resolveViewOptions(loadNamedView('default'))).toBe(false);
  });

  test('a non-boolean value is refused', () => {
    expect(() => assertView({ view: 'x', version: '1.0', layout: { alignParticipantPorts: 'yes' } })).toThrow(ViewRejectedError);
  });
});

describe('loadNamedView', () => {
  test('an unknown name lists the shipped views', () => {
    let msg;
    try { loadNamedView('nope'); } catch (e) { msg = e; }
    expect(msg).toBeInstanceOf(ViewRejectedError);
    expect(msg.message).toMatch(/default/);
    expect(msg.message).toMatch(/explicit-joins/);
  });

  test.each(['../x', '/etc/passwd', 'custom/x', 'A', '', 'x/../y', 7])('name %p is refused by the name rule', (name) => {
    expect(() => loadNamedView(name)).toThrow(/not valid/);
  });

  test('no views directory refuses every name', () => {
    expect(viewsDirFor(join(tmpdir(), 'nowhere', 'shared'))).toBeNull();
    expect(viewsDirPath()).not.toBeNull();
  });
});

describe('loadView', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'view-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('a missing file throws', () => {
    expect(() => loadView('/no/such/file.json')).toThrow(ViewRejectedError);
  });

  test('reads a valid file (BOM tolerated) and a valid object', () => {
    const p = join(dir, 'v.json');
    writeFileSync(p, '﻿' + JSON.stringify({ view: 'mine', version: '1.0' }));
    expect(loadView(p).view).toBe('mine');
    expect(loadView({ view: 'o', version: '1.0' }).view).toBe('o');
  });

  test('invalid JSON names the position, never the content', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{\n  "secret": oops');
    let err;
    try { loadView(p); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ViewRejectedError);
    expect(err.message).toMatch(/line 2/);
    expect(err.message).not.toMatch(/secret/);
  });

  test('a directory and an oversize file are refused as ViewRejectedError', () => {
    expect(() => loadView(dir)).toThrow(ViewRejectedError);
    const big = join(dir, 'big.json');
    writeFileSync(big, ' '.repeat(VIEW_LIMITS.fileBytes + 1));
    expect(() => loadView(big)).toThrow(/larger than 256 KiB/);
  });

  test('a file failing the schema throws', () => {
    const p = join(dir, 'x.json');
    writeFileSync(p, JSON.stringify({ view: 'x', version: '1.0', bogus: 1 }));
    expect(() => loadView(p)).toThrow(/bogus/);
  });

  test('messages say "view", not "rule profile"', () => {
    expect(() => loadView('/no/such/file.json')).toThrow(/^view /);
  });
});
