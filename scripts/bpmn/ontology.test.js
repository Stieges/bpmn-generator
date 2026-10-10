import { describe, test, expect } from '@jest/globals';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveWithFallback, ontologyPath } from '../shared/resource-paths.js';
import { loadOntology, validateOntology, buildVocabulary, VOCABULARY, ONTOLOGY_NS } from './ontology.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ONTO_FILE = join(__dirname, '..', '..', 'references', 'bpmn-ontology.jsonld');
const raw = () => JSON.parse(readFileSync(ONTO_FILE, 'utf8'));

describe('ontology loader', () => {
  test('the committed ontology is valid and loads', () => {
    expect(validateOntology(raw())).toEqual([]);
    expect(VOCABULARY.version).toBe('1.0');
  });

  test('an invalid ontology is rejected with the failing location', () => {
    const bad = raw();
    bad['@graph'].find(e => e['@type'] === 'bg:NodeType').status = 'sometimes';
    const msgs = validateOntology(bad);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.join(' ')).toMatch(/@graph\/\d+\/status/);
  });

  test('loadOntology throws on an invalid file instead of returning empty classes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onto-'));
    const p = join(dir, 'bpmn-ontology.jsonld');
    const bad = raw(); delete bad.version;
    writeFileSync(p, JSON.stringify(bad));
    expect(() => loadOntology(p)).toThrow(/bpmn-ontology\.jsonld is invalid: .*version/);
  });

  test('a lossy entry without a reason is invalid', () => {
    const bad = raw();
    const m = bad['@graph'].find(e => e['@type'] === 'bg:EventMarker' && e.status === 'lossy');
    delete m.reason;
    expect(validateOntology(bad).join(' ')).toMatch(/reason/);
  });

  test('the source copy wins over a stale packaged copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onto-prec-'));
    const src = join(dir, 'source.jsonld'); const pkg = join(dir, 'packaged.jsonld');
    writeFileSync(src, '{}'); writeFileSync(pkg, '{}');
    expect(resolveWithFallback(src, pkg, 'bpmn-ontology.jsonld')).toBe(src);
  });

  test('a missing ontology names both searched paths', () => {
    expect(() => resolveWithFallback('/nope/a.jsonld', '/nope/b.jsonld', 'bpmn-ontology.jsonld'))
      .toThrow(/\/nope\/a\.jsonld.*\/nope\/b\.jsonld/);
  });

  test('ontologyPath resolves to the repo copy in a checkout', () => {
    expect(ontologyPath()).toBe(ONTO_FILE);
  });
});

describe('buildVocabulary', () => {
  test('class closure: a userTask is a Task, an Activity and a FlowNode', () => {
    const v = buildVocabulary(raw());
    const ut = v.nodeTypes.find(t => t.name === 'userTask');
    expect([...ut.classes]).toEqual(expect.arrayContaining(['Task', 'Activity', 'FlowNode']));
  });
  test('classMembers keeps @graph order and includes announced types', () => {
    const v = buildVocabulary(raw());
    expect(v.classMembers('Container')).toContain('adHocSubProcess');
    expect(v.nodeTypeNames(['supported'])).not.toContain('adHocSubProcess');
  });
  test('fieldDomain expands classes to node types', () => {
    const v = buildVocabulary(raw());
    expect(v.fieldDomain('Node', 'calledElement')).toEqual(['callActivity']);
    expect(v.fieldDomain('Lane', 'name')).toBeNull();
  });
});

describe('JSON-LD coherence (no RDF tooling)', () => {
  const onto = raw();
  const ctx = onto['@context'];
  const prefixes = Object.entries(ctx).filter(([, v]) => typeof v === 'string' && /^https?:\/\//.test(v)).map(([k]) => k);
  const ids = onto['@graph'].map(e => e['@id']);

  test('every compact IRI uses a declared prefix', () => {
    const used = new Set();
    const walk = (x) => { if (typeof x === 'string') { const m = /^([a-z]+):[^/]/.exec(x); if (m && !x.startsWith('http')) used.add(m[1]); }
      else if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) if (k !== '@context' && k !== 'eventDefinition') walk(v); };
    walk(onto['@graph']);
    expect([...used].filter(p => !prefixes.includes(p))).toEqual([]);
  });
  test('every @id is unique and in the bg namespace', () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter(i => !i.startsWith('bg:'))).toEqual([]);
    expect(ctx.bg).toBe(ONTOLOGY_NS);
  });
  test('every subClassOf / domain target exists in the file', () => {
    const idSet = new Set(ids);
    const dangling = onto['@graph'].flatMap(e => [...(e.subClassOf || []), ...(e.domain || [])]).filter(t => !idSet.has(t));
    expect(dangling).toEqual([]);
  });
  test('external links are hints only: no equivalence, no exactMatch', () => {
    const text = readFileSync(ONTO_FILE, 'utf8');
    expect(text).not.toMatch(/equivalentClass|exactMatch|sameAs/);
  });
  test('every node type links its OMG class; BBO links stay in the BBO namespace', () => {
    for (const t of onto['@graph'].filter(e => e['@type'] === 'bg:NodeType')) {
      expect(t.seeAlso.some(s => s.startsWith('omg:'))).toBe(true);
      expect(t.seeAlso.filter(s => !s.startsWith('omg:') && !s.startsWith('bbo:'))).toEqual([]);
    }
  });
});
describe('ontology packaging', () => {
  const pkgJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  test('the package exports the ontology under ./ontology', () => {
    expect(pkgJson.exports['./ontology']).toBe('./references/bpmn-ontology.jsonld');
  });
  test('prepack copies it into the package', () => {
    const prepack = readFileSync(join(__dirname, '..', 'prepack-copy-references.mjs'), 'utf8');
    expect(prepack).toMatch(/'bpmn-ontology\.jsonld'/);
  });
  test('the skill bundle filter accepts .jsonld', () => {
    const build = readFileSync(join(__dirname, '..', 'build-skill.mjs'), 'utf8');
    expect(build).toMatch(/endsWith\('\.jsonld'\)/);
  });
});

import * as T from './types.js';
const SNAP = JSON.parse(readFileSync(join(__dirname, '..', '..', 'tests', 'fixtures', 'ontology', 'type-sets.snapshot.json'), 'utf8'));

describe('characterization — deriving from the ontology changes nothing', () => {
  for (const [name, members] of Object.entries(SNAP.sets)) {
    test(`${name} has the same members in the same order`, () => {
      expect([...T[name]]).toEqual(members);
    });
  }
  test('isBpmnArtifact selects the same types', () => {
    expect([...T.ALL_NODE_TYPES].filter(T.isBpmnArtifact)).toEqual(SNAP.bpmnArtifact);
  });
  test('bpmnXmlTag maps every supported type as before', () => {
    for (const [t, tag] of Object.entries(SNAP.xmlTag)) expect(T.bpmnXmlTag(t)).toBe(tag);
  });
  test('marker groups and event-definition maps match the old literals', () => {
    // Groups are membership sets (only .has() is ever asked), so compare members, not order.
    expect([...T.MARKER_GROUPS.exception].sort()).toEqual([...SNAP.markers.exception].sort());
    expect([...T.MARKER_GROUPS.wait].sort()).toEqual([...SNAP.markers.wait].sort());
    expect([...T.MARKER_GROUPS.boundary].sort()).toEqual([...SNAP.markers.boundary].sort());
    expect(Object.fromEntries(T.EVENT_DEFINITION_BY_MARKER)).toEqual(SNAP.markers.eventDefinition);
  });
  test('SUPPORTED_NODE_TYPES equals the schema enum, in order', () => {
    const schema = JSON.parse(readFileSync(join(__dirname, '..', '..', 'references', 'input-schema.json'), 'utf8'));
    expect([...T.SUPPORTED_NODE_TYPES].sort()).toEqual([...schema.$defs.NodeType.enum].sort());
  });
});

describe('fields — one source', () => {
  const schema = JSON.parse(readFileSync(join(__dirname, '..', '..', 'references', 'input-schema.json'), 'utf8'));
  const ELEMENTS = { Process: 'SingleProcess', Collaboration: 'Collaboration', Pool: 'Pool', CollapsedPool: 'CollapsedPool',
    Node: 'Node', Edge: 'Edge', Lane: 'Lane', MessageFlow: 'MessageFlow', Association: 'Association', TopLevelDefinition: 'TopLevelDefinition' };
  for (const [element, def] of Object.entries(ELEMENTS)) {
    test(`${element}: the ontology lists exactly the schema's fields`, () => {
      expect([...VOCABULARY.fieldsOf(element)].sort()).toEqual(Object.keys(schema.$defs[def].properties).sort());
    });
  }
  test('every node-table row takes its allowed set from the ontology', () => {
    for (const row of T.OMG_NODE_FIELD_SCOPE) {
      expect([...row.allowed]).toEqual(VOCABULARY.fieldDomain('Node', row.field));
    }
  });
  test('every edge-table row takes its allowed set from the ontology', () => {
    for (const row of T.OMG_EDGE_FIELD_SCOPE) {
      expect([...row.allowed]).toEqual(VOCABULARY.fieldDomain('Edge', row.field));
    }
  });
  test('…and those sets are what they were before (characterization)', () => {
    for (const row of T.OMG_NODE_FIELD_SCOPE) expect([...row.allowed].sort()).toEqual([...SNAP.nodeAllowed[row.field]].sort());
    for (const row of T.OMG_EDGE_FIELD_SCOPE) expect([...row.allowed].sort()).toEqual([...SNAP.edgeAllowed[row.field]].sort());
  });
});

test('net-check.js keeps its own artifact list, equal to the ontology\'s Artifact class', () => {
  const src = readFileSync(join(__dirname, 'net-check.js'), 'utf8');
  const m = /const ARTIFACT_TYPES = new Set\(\[([^\]]+)\]\)/.exec(src);
  const own = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  expect(own.sort()).toEqual([...VOCABULARY.classMembers('Artifact')].sort());
  expect(src).not.toMatch(/^import /m);
});

import { findVocabularyLists } from './ontology-audit.js';
import { readdirSync, statSync } from 'node:fs';
import { relative } from 'node:path';
const NAMES = new Set(['userTask', 'serviceTask', 'task', 'timer', 'message', 'error']);

describe('findVocabularyLists', () => {
  test('reports an injected list with its line', () => {
    const src = "const a = 1;\nconst X = new Set(['userTask', 'serviceTask', 'task']);\n";
    expect(findVocabularyLists(src, NAMES)).toEqual([{ line: 2, names: ['userTask', 'serviceTask', 'task'] }]);
  });
  test('reports a multi-line array', () => {
    const src = "const M = [\n  'timer',\n  'message',\n  'error',\n];";
    expect(findVocabularyLists(src, NAMES)).toEqual([{ line: 1, names: ['timer', 'message', 'error'] }]);
  });
  test('ignores a per-type switch', () => {
    const src = "switch (t) { case 'userTask': a(); break; case 'serviceTask': b(); break; case 'task': c(); }";
    expect(findVocabularyLists(src, NAMES)).toEqual([]);
  });
  test('ignores an object keyed by type', () => {
    expect(findVocabularyLists("const m = { userTask: 1, serviceTask: 2, task: 3 };", NAMES)).toEqual([]);
  });
  test('ignores lists inside comments', () => {
    expect(findVocabularyLists("// ['userTask', 'serviceTask', 'task']\n/* ['timer','message','error'] */", NAMES)).toEqual([]);
  });
  test('ignores pairs below the threshold', () => {
    expect(findVocabularyLists("x(['userTask', 'task'])", NAMES)).toEqual([]);
  });
  test('ignores arrays that mix non-literal elements', () => {
    expect(findVocabularyLists("[...A, 'userTask', 'serviceTask', 'task']", NAMES)).toEqual([]);
  });
  test('reports the bpmn-moddle spelling when those names are passed in', () => {
    const moddle = new Set(['bpmn:UserTask', 'bpmn:ServiceTask', 'bpmn:Task']);
    const src = "const X = new Set(['bpmn:UserTask', 'bpmn:ServiceTask', 'bpmn:Task']);";
    expect(findVocabularyLists(src, moddle)).toEqual([{ line: 1, names: ['bpmn:UserTask', 'bpmn:ServiceTask', 'bpmn:Task'] }]);
  });
});

// Every exception names its file and why the copy is deliberate. Kept small on purpose.
const LIST_ALLOWLIST = new Map([
  ['scripts/bpmn/net-check.js', 'Deliberately independent of types.js: a checker that shares predicates with the code it checks cannot see a bug in them. Fenced by equality above.'],
]);

describe('no vocabulary list outside the ontology', () => {
  const root = join(__dirname, '..', '..');
  const plain = [...VOCABULARY.nodeTypeNames(), ...VOCABULARY.markerNames()];
  // Both spellings: Logic-Core ('userTask') and bpmn-moddle ('bpmn:UserTask').
  const vocab = new Set([...plain, ...plain.map(n => 'bpmn:' + n[0].toUpperCase() + n.slice(1))]);
  const files = [];
  const walk = (dir) => { for (const n of readdirSync(dir)) { const p = join(dir, n);
    if (n === 'node_modules' || n === 'references') continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(m?js)$/.test(n) && !/\.test\.js$/.test(n)) files.push(p); } };
  walk(join(root, 'scripts'));

  const findings = files.flatMap(f => findVocabularyLists(readFileSync(f, 'utf8'), vocab)
    .map(x => ({ file: relative(root, f), ...x })));

  test('no list of three or more vocabulary names outside the allowlist', () => {
    expect(findings.filter(f => !LIST_ALLOWLIST.has(f.file))).toEqual([]);
  });
  test('every allowlist entry has a reason and is still needed', () => {
    for (const [file, reason] of LIST_ALLOWLIST) {
      expect(reason.length).toBeGreaterThan(20);
      expect(findings.some(f => f.file === file)).toBe(true);
    }
  });
});
