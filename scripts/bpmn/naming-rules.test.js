/**
 * M01 and M02 follow the declared `language` of a model. With a registered language the naming
 * strategy judges every named task and container at every nesting level; without one (absent,
 * invalid) M01 is today's heuristic, which reads no word list and no BPMN_NAMING.
 *
 * `tests/fixtures/rules-characterization/naming-languages.snapshot.json` pins the messages per
 * fixture and rule: a diff there is a defect, not a snapshot to regenerate.
 */
import { describe, test, expect, jest, beforeAll, afterAll } from '@jest/globals';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runRules, loadRuleProfile, profileForMode } from './rules.js';
import { namingFor, namingMessage } from './naming/index.js';
import { resolveFields } from './model-v2.js';
import { generateDiagramSet, runPipeline } from './pipeline.js';
import { loadNamedView } from '../shared/view.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SCRIPTS = join(__dirname, '..');
const FIXTURES = join(ROOT, 'tests', 'fixtures');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const fixture = (file) => readJson(join(FIXTURES, file));
const LANGUAGES = readJson(join(FIXTURES, 'rules-characterization', 'fixture-languages.json'));
const SNAPSHOT_PATH = join(FIXTURES, 'rules-characterization', 'naming-languages.snapshot.json');
const V2_MODELS = ['fixtures-v2/schaden.json', 'fixtures-v2/organigramm.json'];

const messagesOf = (result, code) => result.findings.filter((f) => f.code === code).map((f) => f.message);
const withFindings = (lc, profile = null) => runRules(lc, profile, undefined, { withFindings: true });

/** The intermediate form of a 2.0 model (its catalogue next to it), with `language: "de"`. */
function v2Form(path) {
  const model = readJson(join(ROOT, 'tests', path));
  const catalog = readJson(join(ROOT, 'tests', dirname(path), model.catalog));
  const r = resolveFields({ ...model, language: 'de' }, { catalog });
  expect(r.errors).toEqual([]);
  return r.lc;
}

/** The measured entry of one model: M01, M05 and M06. */
function measure(lc) {
  const r = withFindings(lc);
  return { language: lc.language, M01: messagesOf(r, 'M01'), M05: messagesOf(r, 'M05'), M06: messagesOf(r, 'M06') };
}

// fixture → [M01 findings without language, M01 findings with its true language]
const COUNTS = {
  de: {
    'artifacts-laneless-pool': [0, 0],
    'bpmn-generator-pipeline': [0, 0],
    'dense-edge-labels': [5, 5],
    'example-bestellung-versand': [0, 0],
    'example-kreditantrag': [0, 0],
    'example-onboarding': [0, 0],
    'example-rechnungspruefung': [1, 1],
    'example-schadenmeldung': [1, 1],
    'example-urlaubsantrag': [0, 1],
    'expanded-subprocess': [1, 1],
    'long-lane-names': [3, 3],
    'nested-lanes-role-system': [0, 0],
    'wide-pipeline': [25, 25],
  },
  en: {
    'all-element-classes': [2, 2],
    'boundary-event-shapes': [1, 0],
    'deadlock-process': [3, 3],
    'loop-with-join': [0, 0],
    'message-flow-participant-ports': [0, 0],
    'messageflow-to-subprocess': [0, 0],
    'multi-pool-collaboration': [0, 0],
    'parallel-split-join': [3, 0],
    'realistic-collaboration': [6, 0],
    'simple-approval': [1, 0],
    'sparse-lanes': [4, 0],
    'subprocess-child-fidelity': [0, 1],
    'subprocess-collapsed-children': [1, 2],
    'subprocess-merge-fanout': [0, 0],
    'wrapping-back-edge': [20, 20],
  },
};
const TOTALS = { de: [36, 37], en: [41, 28] };

describe('the count table', () => {
  test('covers every top-level fixture with its true language', () => {
    const table = Object.fromEntries(Object.entries(COUNTS).flatMap(([l, rows]) => Object.keys(rows).map((f) => [`${f}.json`, l])));
    expect(table).toEqual(LANGUAGES);
    for (const [l, rows] of Object.entries(COUNTS)) {
      const sum = (i) => Object.values(rows).reduce((s, r) => s + r[i], 0);
      expect([sum(0), sum(1)]).toEqual(TOTALS[l]);
    }
  });

  for (const [language, rows] of Object.entries(COUNTS)) {
    for (const [name, [now, declared]] of Object.entries(rows)) {
      test(`${name}: ${now} without language, ${declared} with "${language}"`, () => {
        const lc = fixture(`${name}.json`);
        expect(messagesOf(withFindings(lc), 'M01')).toHaveLength(now);
        expect(messagesOf(withFindings({ ...lc, language }), 'M01')).toHaveLength(declared);
      });
    }
  }
});

describe('the pinned snapshot', () => {
  let snapshot;
  beforeAll(() => { snapshot = readJson(SNAPSHOT_PATH); });

  test('has one entry per top-level fixture and per format 2.0 model, M06 still empty', () => {
    expect(Object.keys(snapshot).sort()).toEqual([...Object.keys(LANGUAGES), ...V2_MODELS].sort());
    for (const entry of Object.values(snapshot)) {
      expect(Object.keys(entry)).toEqual(['language', 'M01', 'M05', 'M06']);
      expect(entry.M06).toEqual([]);
    }
  });

  test('its M01 counts are the table', () => {
    for (const [language, rows] of Object.entries(COUNTS)) {
      for (const [name, [, declared]] of Object.entries(rows)) {
        expect([name, snapshot[`${name}.json`].language, snapshot[`${name}.json`].M01.length]).toEqual([name, language, declared]);
      }
    }
  });

  for (const file of Object.keys(LANGUAGES)) {
    test(`${file}: the messages equal the snapshot`, () => {
      expect(measure({ ...fixture(file), language: LANGUAGES[file] })).toEqual(snapshot[file]);
    });
  }

  for (const path of V2_MODELS) {
    test(`${path} (format 2.0, "de"): the messages equal the snapshot`, () => {
      expect(measure(v2Form(path))).toEqual(snapshot[path]);
    });
  }
});

describe('the messages', () => {
  test('the design example, literally', () => {
    expect(namingMessage(namingFor('de'), 'task', 'X'))
      .toBe('Task "X" does not follow the German convention object + infinitive (e.g. "Antrag prüfen").');
  });

  test('every kind, in both languages', () => {
    const de = namingFor('de');
    const en = namingFor('en');
    expect(namingMessage(en, 'task', 'Step 1'))
      .toBe('Task "Step 1" does not follow the English convention verb + object (e.g. "Review application").');
    expect(namingMessage(en, 'container', 'Archive', 'subProcess'))
      .toBe('Subprocess "Archive" is named like a state or a bare verb; name it as an activity (e.g. "Review application" or "Claims handling").');
    expect(namingMessage(de, 'container', 'Geprüft', 'callActivity'))
      .toBe('Call activity "Geprüft" is named like a state or a bare verb; name it as an activity (e.g. "Antrag prüfen" or "Schadenprüfung").');
    expect(namingMessage(de, 'container', 'Geprüft', 'transaction'))
      .toBe('Subprocess "Geprüft" is named like a state or a bare verb; name it as an activity (e.g. "Antrag prüfen" or "Schadenprüfung").');
    expect(namingMessage(de, 'event', 'Antrag prüfen'))
      .toBe('Event "Antrag prüfen" is named like an activity; the German convention for events is a state or a noun (e.g. "Antrag eingegangen").');
    expect(namingMessage(en, 'message', 'Send invoice'))
      .toBe('Message flow "Send invoice" is named like an activity or a state; the English convention for message flows is a noun phrase (e.g. "Invoice").');
  });

  test('a language without a display name is named by its code', () => {
    const naming = { language: 'qqq', wordOrder: 'verb-first', examples: { task: 'Do it', subprocess: 'Doing', event: 'Done', message: 'Note' } };
    expect(namingMessage(naming, 'task', 'X')).toBe('Task "X" does not follow the language "qqq" convention verb + object (e.g. "Do it").');
  });
});

describe('M01 with a declared language', () => {
  test('a nested task and a nested container are reported with the pool prefix in a collaboration', () => {
    const lc = {
      language: 'en',
      pools: [
        {
          id: 'p1', name: 'Shop',
          nodes: [
            { id: 's', type: 'startEvent', name: 'Order received' },
            { id: 'sp', type: 'subProcess', name: 'Handle order', isExpanded: true, nodes: [
              { id: 'sp_s', type: 'startEvent' },
              { id: 't', type: 'task', name: 'Continue' },
              { id: 'ca', type: 'callActivity', name: 'Archive' },
              { id: 'sp_e', type: 'endEvent' },
            ], edges: [{ id: 'f1', source: 'sp_s', target: 't' }, { id: 'f2', source: 't', target: 'ca' }, { id: 'f3', source: 'ca', target: 'sp_e' }] },
            { id: 'e', type: 'endEvent', name: 'Order handled' },
          ],
          edges: [{ id: 'g1', source: 's', target: 'sp' }, { id: 'g2', source: 'sp', target: 'e' }],
        },
        { id: 'p2', name: 'Bank', nodes: [{ id: 'b', type: 'task', name: 'Validate' }], edges: [] },
      ],
    };
    expect(messagesOf(withFindings(lc), 'M01')).toEqual([
      '[Shop] Task "Continue" does not follow the English convention verb + object (e.g. "Review application").',
      '[Shop] Call activity "Archive" is named like a state or a bare verb; name it as an activity (e.g. "Review application" or "Claims handling").',
      '[Bank] Task "Validate" does not follow the English convention verb + object (e.g. "Review application").',
    ]);
  });

  test('a language without naming data: no M01 finding and no throw', () => {
    for (const file of Object.keys(LANGUAGES)) {
      expect(messagesOf(withFindings({ ...fixture(file), language: 'fr' }), 'M01')).toEqual([]);
    }
  });

  test('under the strict profile, the English container "Archive" is an ERROR', () => {
    const profile = profileForMode(loadRuleProfile(join(ROOT, 'rules', 'strict-profile.json')), 'document');
    const r = runRules({ ...fixture('subprocess-collapsed-children.json'), language: 'en' }, profile, undefined, { withFindings: true });
    const archive = r.findings.filter((f) => f.code === 'M01' && f.message.includes('"Archive"'));
    expect(archive).toHaveLength(1);
    expect(archive[0].severity).toBe('ERROR');
    expect(r.errors).toContain(archive[0].message);
  });
});

describe('M05 with a declared language', () => {
  const strict = () => profileForMode(loadRuleProfile(join(ROOT, 'rules', 'strict-profile.json')), 'document');
  const flowModel = (name, language = 'en') => ({
    language,
    pools: [
      { id: 'p1', name: 'Shop', nodes: [{ id: 's', type: 'startEvent' }, { id: 'a', type: 'task', name: 'Place order' }, { id: 'e', type: 'endEvent' }], edges: [{ id: 'f1', source: 's', target: 'a' }, { id: 'f2', source: 'a', target: 'e' }] },
      { id: 'p2', name: 'Bank', nodes: [{ id: 'bs', type: 'startEvent' }, { id: 'b', type: 'task', name: 'Check order' }, { id: 'be', type: 'endEvent' }], edges: [{ id: 'g1', source: 'bs', target: 'b' }, { id: 'g2', source: 'b', target: 'be' }] },
    ],
    messageFlows: [{ id: 'm1', source: 'a', target: 'bs', name }],
  });
  const m05 = (lc, profile = null) => messagesOf(withFindings(lc, profile), 'M05');

  test('English totals 2, German 0, measured per fixture', () => {
    const measured = {};
    for (const [file, language] of Object.entries(LANGUAGES)) measured[file] = m05({ ...fixture(file), language });
    expect(Object.fromEntries(Object.entries(measured).filter(([, v]) => v.length))).toEqual({
      'loop-with-join.json': ['Message flow "Order received" is named like an activity or a state; the English convention for message flows is a noun phrase (e.g. "Invoice").'],
      'realistic-collaboration.json': ['Message flow "Case closed" is named like an activity or a state; the English convention for message flows is a noun phrase (e.g. "Invoice").'],
    });
  });

  test('without language: no M05 output under no profile, the default and the strict profile, all fixtures', () => {
    const files = readdirSync(FIXTURES).filter((f) => Object.hasOwn(LANGUAGES, f));
    expect(files).toHaveLength(28);
    const profiles = [null, loadRuleProfile(join(ROOT, 'rules', 'default-profile.json')), strict()];
    for (const file of files) {
      for (const p of profiles) {
        const r = withFindings(fixture(file), p);
        expect([file, r.findings.filter((f) => f.code === 'M05')]).toEqual([file, []]);
      }
    }
  });

  test('under the strict profile with "en", "Send invoice" is an ERROR and blocks; "Merge request" and "Follow-up" pass', () => {
    const r = runRules(flowModel('Send invoice'), strict(), undefined, { withFindings: true });
    const f = r.findings.filter((x) => x.code === 'M05');
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('ERROR');
    expect(r.errors).toContain(f[0].message);
    expect(m05(flowModel('Merge request'), strict())).toEqual([]);
    expect(m05(flowModel('Follow-up'), strict())).toEqual([]);
    expect(m05(flowModel('Deploy request'), strict())).toEqual([]);
    expect(m05(flowModel('Sell order'), strict())).toEqual([]);
  });

  test('a profile override M05: OFF silences it', () => {
    const profile = { ...strict(), overrides: { ...strict().overrides, M05: { severity: 'OFF' } } };
    const r = runRules(flowModel('Send invoice'), profile, undefined, { withFindings: true });
    expect(r.findings.filter((x) => x.code === 'M05')).toEqual([]);
  });

  test('a model without messageFlows, a single process, and odd entries do not throw', () => {
    expect(m05({ language: 'en', nodes: [{ id: 's', type: 'startEvent' }, { id: 'e', type: 'endEvent' }], edges: [{ id: 'f', source: 's', target: 'e' }] })).toEqual([]);
    expect(m05({ ...flowModel('x'), messageFlows: 'nope' })).toEqual([]);
    expect(m05({ ...flowModel('x'), messageFlows: [{ id: 'm' }, { id: 'n', name: 7 }] })).toEqual([]);
    expect(m05({ ...flowModel('x'), language: 'fr' })).toEqual([]);
  });
});

describe('M06 with a declared language', () => {
  const strict = () => profileForMode(loadRuleProfile(join(ROOT, 'rules', 'strict-profile.json')), 'document');
  const eventModel = (startName, endName, language) => ({
    language,
    nodes: [
      { id: 's', type: 'startEvent', ...(startName === undefined ? {} : { name: startName }) },
      { id: 'a', type: 'task', name: language === 'en' ? 'Check order' : 'Antrag prüfen' },
      { id: 'e', type: 'endEvent', ...(endName === undefined ? {} : { name: endName }) },
    ],
    edges: [{ id: 'f1', source: 's', target: 'a' }, { id: 'f2', source: 'a', target: 'e' }],
  });
  const m06 = (lc, profile = null) => messagesOf(withFindings(lc, profile), 'M06');
  const msg = (name, language) => namingMessage(namingFor(language), 'event', name);

  test('every fixture with its true language gives 0 M06 findings', () => {
    for (const [file, language] of Object.entries(LANGUAGES)) {
      expect([file, m06({ ...fixture(file), language })]).toEqual([file, []]);
    }
  });

  test('German: "Antrag prüfen" and "Daten validieren" are flagged; states, nouns and unnamed events are not', () => {
    expect(m06(eventModel('Antrag prüfen', 'Daten validieren', 'de'))).toEqual([msg('Antrag prüfen', 'de'), msg('Daten validieren', 'de')]);
    for (const ok of ['Akte erhalten', 'Start', 'Kunde möchte kündigen', 'Rechnung zu zahlen', undefined]) {
      expect([ok, m06(eventModel(ok, ok, 'de'))]).toEqual([ok, []]);
    }
  });

  test('English: "Send invoice" and "Notify customer" are flagged; "Start X", "Archive start", "Follow-up", "Build broken" are not', () => {
    expect(m06(eventModel('Send invoice', 'Notify customer', 'en'))).toEqual([msg('Send invoice', 'en'), msg('Notify customer', 'en')]);
    for (const ok of ['Start X', 'Archive start', 'Follow-up', 'Build broken']) {
      expect([ok, m06(eventModel(ok, ok, 'en'))]).toEqual([ok, []]);
    }
  });

  test('an event inside an expanded subprocess is reported', () => {
    const lc = {
      language: 'de',
      nodes: [
        { id: 's', type: 'startEvent' },
        { id: 'sp', type: 'subProcess', name: 'Antrag bearbeiten', nodes: [
          { id: 'ss', type: 'startEvent', name: 'Antrag prüfen' },
          { id: 'st', type: 'task', name: 'Akte anlegen' },
          { id: 'se', type: 'endEvent' },
        ], edges: [{ id: 'g1', source: 'ss', target: 'st' }, { id: 'g2', source: 'st', target: 'se' }] },
        { id: 'e', type: 'endEvent' },
      ],
      edges: [{ id: 'f1', source: 's', target: 'sp' }, { id: 'f2', source: 'sp', target: 'e' }],
    };
    expect(m06(lc)).toEqual([msg('Antrag prüfen', 'de')]);
  });

  test('a collapsed pool and a pool without nodes do not throw', () => {
    const lc = {
      language: 'de',
      pools: [
        { id: 'p1', name: 'Kunde', nodes: eventModel('Antrag prüfen', undefined, 'de').nodes, edges: eventModel('x', 'y', 'de').edges },
        { id: 'p2', name: 'Bank', collapsed: true },
        { id: 'p3', name: 'Amt' },
      ],
    };
    expect(m06(lc)).toEqual([`[Kunde] ${msg('Antrag prüfen', 'de')}`]);
  });

  test('an unregistered language does not throw and flags nothing', () => {
    expect(m06({ ...eventModel('Antrag prüfen', 'x', 'de'), language: 'fr' })).toEqual([]);
  });

  test('under the strict profile with "de", "Antrag prüfen" is an ERROR and blocks', () => {
    const r = runRules(eventModel('Antrag prüfen', undefined, 'de'), strict(), undefined, { withFindings: true });
    const f = r.findings.filter((x) => x.code === 'M06');
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('ERROR');
    expect(r.errors).toContain(f[0].message);
  });

  test('without language the strict profile has no M05 or M06 output', () => {
    const lc = eventModel('Antrag prüfen', 'Daten validieren', 'de');
    delete lc.language;
    const r = runRules(lc, strict(), undefined, { withFindings: true });
    expect(r.findings.filter((x) => x.code === 'M05' || x.code === 'M06')).toEqual([]);
  });

  test('no rule of the ontology points at severity OFF any more, and OFF is still a vocabulary entry', () => {
    const graph = readJson(join(ROOT, 'references', 'ontology.jsonld'))['@graph'];
    expect(graph.filter((e) => e['@type'] === 'bg:Rule' && e.defaultSeverity === 'bg:severity-OFF')).toEqual([]);
    expect(graph.some((e) => e['@id'] === 'bg:severity-OFF')).toBe(true);
  });
});

describe('a model without a valid language gives exactly today\'s results', () => {
  const INVALID = ['', 'DE', 'de_DE', 'german', 'd', 'de-', ' de', 'de ', 42, true, null, ['de'], { code: 'de' }];
  const SAMPLES = ['simple-approval.json', 'expanded-subprocess.json', 'realistic-collaboration.json', 'wide-pipeline.json'];

  test.each(INVALID.map((v) => [JSON.stringify(v), v]))('language %s: the legacy findings', (_, value) => {
    for (const file of SAMPLES) {
      const lc = fixture(file);
      expect(withFindings({ ...lc, language: value })).toEqual(withFindings(lc));
    }
  });

  test('a throwing language getter: the legacy findings', () => {
    const lc = fixture('simple-approval.json');
    const tricky = { ...lc };
    Object.defineProperty(tricky, 'language', { enumerable: true, get() { throw new Error('boom'); } });
    expect(withFindings(tricky)).toEqual(withFindings(lc));
  });

  test('odd roots behave as before', () => {
    expect(() => runRules(null)).toThrow(TypeError);
    expect(() => runRules(undefined)).toThrow(TypeError);
    const missingEnds = { errors: ['Missing startEvent.', 'Missing endEvent.'], warnings: [], infos: [], advisories: [], metrics: {} };
    for (const root of [[], 42, 's', {}, { nodes: null }]) expect(runRules(root)).toEqual(missingEnds);
    expect(runRules({ pools: [] })).toEqual({ errors: [], warnings: [], infos: [], advisories: [], metrics: {} });
  });

  test('M02 findings are identical with and without the language, for every fixture', () => {
    for (const [file, language] of Object.entries(LANGUAGES)) {
      const lc = fixture(file);
      expect([file, messagesOf(withFindings({ ...lc, language }), 'M02')]).toEqual([file, messagesOf(withFindings(lc), 'M02')]);
    }
  });
});

describe('drill-down: a child diagram judges its tasks in the parent\'s language', () => {
  const renamed = () => {
    const lc = fixture('expanded-subprocess.json');
    const sub = lc.pools[0].nodes.find((n) => n.id === 'sub1');
    sub.nodes.find((n) => n.id === 'sub1_task1').name = 'Dokumente';
    return lc;
  };
  // The child diagram is a pool named after the subprocess, hence the prefix.
  const LEGACY = '[Detailprüfung] Task "Dokumente" folgt nicht der Objekt+Verb-Konvention (z.B. "Antrag prüfen"). Heuristik — exakte Wortartprüfung: M05/M06.';
  const GERMAN = '[Detailprüfung] Task "Dokumente" does not follow the German convention object + infinitive (e.g. "Antrag prüfen").';

  test('with "de" the German-convention message; without language today\'s warnings', async () => {
    const declared = await generateDiagramSet({ ...renamed(), language: 'de' });
    const plain = await generateDiagramSet(renamed());
    const declaredWarnings = declared.subProcesses.sub1.validation.warnings;
    const plainWarnings = plain.subProcesses.sub1.validation.warnings;
    expect(declaredWarnings).toContain(GERMAN);
    expect(plainWarnings).toContain(LEGACY);
    expect(plainWarnings.some((w) => w.includes('German convention'))).toBe(false);
    expect(declaredWarnings).toEqual(plainWarnings.map((w) => (w === LEGACY ? GERMAN : w)));
  }, 60_000);
});

describe('the CLI with a broken BPMN_NAMING', () => {
  const cli = (args, env) => spawnSync(process.execPath, ['bpmn/pipeline.js', ...args], {
    cwd: SCRIPTS, encoding: 'utf8', env, timeout: 60_000, killSignal: 'SIGKILL',
  });

  test('a model with language fails naming the path; one without runs as without the variable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'naming-cli-'));
    try {
      const base = { ...process.env };
      delete base.BPMN_NAMING;
      const broken = { ...base, BPMN_NAMING: '/nonexistent.json' };
      const lc = fixture('simple-approval.json');
      const declared = join(dir, 'declared.json');
      const plain = join(dir, 'plain.json');
      writeFileSync(declared, JSON.stringify({ ...lc, language: 'en' }));
      writeFileSync(plain, JSON.stringify(lc));
      const out = join(dir, 'out');

      const failed = cli([declared, out], broken);
      expect(failed.error).toBeUndefined();
      expect(failed.status).not.toBe(0);
      expect(failed.stderr).toMatch(/naming data "\/nonexistent\.json" \S+/);

      const withVar = cli([plain, out], broken);
      rmSync(out, { recursive: true, force: true });
      const without = cli([plain, out], base);
      expect(withVar.error).toBeUndefined();
      expect(withVar.status).toBe(0);
      expect(without.status).toBe(0);
      expect(withVar.stdout).toBe(without.stdout);
      expect(withVar.stderr).toBe(without.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

// Un-mocked: the real rules read the real, broken overlay file and throw a genuine NamingDataError.
describe('the servers with a broken BPMN_NAMING, end to end', () => {
  const SAVED_ENV = ['BPMN_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'BPMN_NAMING'];
  const saved = {};
  let dir;
  let broken;
  let realError;
  beforeAll(() => {
    for (const k of SAVED_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    dir = mkdtempSync(join(tmpdir(), 'naming-e2e-'));
    broken = join(dir, 'broken-overlay.json');
    writeFileSync(broken, '{ not json');
    realError = console.error;
  });
  afterAll(() => {
    console.error = realError;
    for (const k of SAVED_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(dir, { recursive: true, force: true });
  });
  const model = () => ({ ...fixture('simple-approval.json'), language: 'en' });

  test('HTTP /api/v1/generate: the fixed 500, no path in the body', async () => {
    const { server, _resetRateLimit } = await import('../http-server.js');
    await new Promise((r) => server.listen(0, r));
    try {
      process.env.BPMN_NAMING = broken;
      console.error = () => {};
      _resetRateLimit();
      const correlationId = `naming-e2e-${Date.now()}-${process.pid}`;
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ logicCore: model(), correlationId }),
      });
      const text = await res.text();
      expect(res.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ correlationId, status: 'internal_error', error: 'naming data unavailable' });
      expect(text).not.toContain(broken);
      expect(text).not.toContain('broken-overlay');
    } finally {
      console.error = realError;
      delete process.env.BPMN_NAMING;
      await new Promise((r) => server.close(r));
    }
  }, 60_000);

  test('MCP generate_bpmn: rejects with exactly "naming data unavailable"', async () => {
    const { handleToolCall } = await import('../mcp-bpmn-server.js');
    try {
      process.env.BPMN_NAMING = broken;
      console.error = () => {};
      const err = await handleToolCall({ params: { name: 'generate_bpmn', arguments: { logicCore: model() } } }).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('naming data unavailable');
    } finally {
      console.error = realError;
      delete process.env.BPMN_NAMING;
    }
  }, 60_000);
});

describe('hints for an unsupported language and for labels in another language than declared', () => {
  const ALL = readdirSync(FIXTURES).filter((f) => Object.hasOwn(LANGUAGES, f));
  const hintsOf = (result, ...codes) => result.validation.hints.filter((h) => codes.includes(h.code));
  const run = (model, opts) => runPipeline(model, opts);
  const H13 = (declared, other, f, n, p) => ({
    code: 'H13',
    message: `The task names look like "${other}" but the model declares "${declared}": ${f} of ${n} fail the ${declared === 'de' ? 'German' : 'English'} convention, ${p} pass the ${other === 'de' ? 'German' : 'English'} one.`,
    elements: [],
  });

  test('realistic-collaboration declared de: one H13 naming en (15 of 15 fail, 15 pass)', async () => {
    const result = await run({ ...fixture('realistic-collaboration.json'), language: 'de' });
    expect(hintsOf(result, 'H12', 'H13')).toEqual([H13('de', 'en', 15, 15, 15)]);
  }, 60_000);

  test('simple-approval declared de (3 tasks): H13', async () => {
    const result = await run({ ...fixture('simple-approval.json'), language: 'de' });
    expect(hintsOf(result, 'H13')).toEqual([H13('de', 'en', 3, 3, 3)]);
  }, 60_000);

  test('wide-pipeline declared en (25 fail both): no H13', async () => {
    const result = await run({ ...fixture('wide-pipeline.json'), language: 'en' });
    expect(hintsOf(result, 'H12', 'H13')).toEqual([]);
  }, 60_000);

  test('every fixture with its true language gets no H12 and no H13', async () => {
    for (const file of ALL) {
      const result = await run({ ...fixture(file), language: LANGUAGES[file] });
      expect({ file, hints: hintsOf(result, 'H12', 'H13') }).toEqual({ file, hints: [] });
    }
  }, 240_000);

  test('fr: exactly one H12, first of the hints, and no M01, M05 or M06 finding', async () => {
    const result = await run({ ...fixture('simple-approval.json'), language: 'fr' });
    expect(result.validation.hints).toEqual([{
      code: 'H12',
      message: 'Language "fr" has no naming conventions here; the naming rules M01, M05 and M06 are skipped (supported: de, en).',
      elements: [],
    }]);
    const all = [...result.validation.warnings, ...result.validation.errors, ...result.validation.infos, ...result.validation.advisories];
    expect(all.filter((m) => /Objekt\+Verb|convention|M0[156]/.test(m))).toEqual([]);
    const tagged = await run({ ...fixture('simple-approval.json'), language: 'fr-CA' });
    expect(tagged.validation.hints.map((h) => h.message)).toEqual([expect.stringContaining('Language "fr-CA" has')]);
  }, 60_000);

  test('H12 or H13 come before H10 and H11', async () => {
    const model = { ...fixture('simple-approval.json'), language: 'de' };
    const result = await run(model);
    const codes = result.validation.hints.map((h) => h.code);
    expect(codes.indexOf('H13')).toBe(0);
  }, 60_000);

  const INVALID = [undefined, 'German', 'DE', 5, null, 'de" x="1'];
  test.each(INVALID.map((v) => [String(v), v]))('language %s: validation.hints is [] for all 28 fixtures; explicit-joins gives H01 only', async (_label, value) => {
    expect(ALL).toHaveLength(28);
    const view = loadNamedView('explicit-joins');
    for (const file of ALL) {
      const model = fixture(file);
      if (value !== undefined) model.language = value;
      const plain = await run(structuredClone(model));
      expect({ file, hints: plain.validation.hints }).toEqual({ file, hints: [] });
      const joined = await run(structuredClone(model), { view });
      expect({ file, codes: [...new Set(joined.validation.hints.map((h) => h.code))].filter((c) => c !== 'H01') }).toEqual({ file, codes: [] });
    }
  }, 600_000);

  test('--strict exits 0 for a fr model whose only output is H12', () => {
    const dir = mkdtempSync(join(tmpdir(), 'naming-h12-'));
    try {
      const input = join(dir, 'fr.json');
      writeFileSync(input, JSON.stringify({ ...fixture('simple-approval.json'), language: 'fr' }));
      const r = spawnSync(process.execPath, ['bpmn/pipeline.js', input, join(dir, 'out'), '--strict'], { cwd: SCRIPTS, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
      expect(r.error).toBeUndefined();
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('ℹ [H12] Language "fr" has no naming conventions here');
      expect(r.stderr).not.toContain('--strict');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test('/api/v1/validate of a fr model returns the pinned key set, without hints (the validate path has no hint channel)', async () => {
    const { server, _resetRateLimit } = await import('../http-server.js');
    await new Promise((r) => server.listen(0, r));
    try {
      _resetRateLimit();
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/validate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ logicCore: { ...fixture('simple-approval.json'), language: 'fr' } }),
      });
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(Object.keys(json)).toEqual(['correlationId', 'status', 'validation']);
      expect(Object.keys(json.validation)).toEqual(['errors', 'warnings', 'infos', 'advisories', 'metrics']);
      expect(JSON.stringify(json)).not.toContain('H12');
    } finally {
      await new Promise((r) => server.close(r));
    }
  }, 60_000);
});

// Last in this file: a module mock outlives jest.resetModules.
describe('without a language the word lists are never consulted', () => {
  test('namingFor is not called for any fixture without language, nor for an invalid one', async () => {
    jest.resetModules();
    const actual = await import('./naming/index.js');
    const spy = jest.fn(actual.namingFor);
    jest.unstable_mockModule('./naming/index.js', () => ({ ...actual, namingFor: spy }));
    const fresh = await import('./rules.js');
    for (const file of readdirSync(FIXTURES).filter((f) => Object.hasOwn(LANGUAGES, f))) {
      const lc = fixture(file);
      fresh.runRules(lc, null, undefined, { withFindings: true });
      fresh.runRules({ ...lc, language: 'DE' });
    }
    expect(spy).not.toHaveBeenCalled();
    fresh.runRules({ ...fixture('simple-approval.json'), language: 'en' });
    expect(spy).toHaveBeenCalledWith('en');
  });
});
