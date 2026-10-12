import { describe, test, expect } from '@jest/globals';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveWithFallback, ontologyPath } from '../shared/resource-paths.js';
import { loadOntology, validateOntology, buildVocabulary, VOCABULARY, ONTOLOGY_NS } from '../shared/ontology.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ONTO_FILE = join(__dirname, '..', '..', 'references', 'ontology.jsonld');
const raw = () => JSON.parse(readFileSync(ONTO_FILE, 'utf8'));

describe('ontology loader', () => {
  test('the committed ontology is valid and loads', () => {
    expect(validateOntology(raw())).toEqual([]);
    expect(VOCABULARY.version).toBe('1.2');
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
    const p = join(dir, 'ontology.jsonld');
    const bad = raw(); delete bad['@graph'].find(e => e['@type'] === 'owl:Ontology').version;
    writeFileSync(p, JSON.stringify(bad));
    expect(() => loadOntology(p)).toThrow(/ontology\.jsonld is invalid \(.*ontology\.jsonld\): .*version/);
  });

  test('a JSON syntax error names the file path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onto-syn-'));
    const p = join(dir, 'broken.jsonld');
    writeFileSync(p, '{ "@graph": [ ');
    expect(() => loadOntology(p)).toThrow(p);
    expect(() => loadOntology(p)).toThrow(/not valid JSON/);
  });

  test('a lossy node type without an xmlTag is invalid (it would throw in bpmnXmlTag)', () => {
    const bad = raw();
    const t = bad['@graph'].find(e => e['@type'] === 'bg:NodeType' && e.status === 'supported');
    t.status = 'lossy'; t.reason = 'x'; delete t.xmlTag;
    expect(validateOntology(bad).join(' ')).toMatch(/xmlTag/);
  });

  test('the top level holds only @context and @graph, with exactly one owl:Ontology node', () => {
    const o = raw();
    expect(Object.keys(o)).toEqual(['@context', '@graph']);
    expect(o['@graph'].filter(e => e['@type'] === 'owl:Ontology')).toHaveLength(1);
    const named = { ...o, '@id': 'https://stieges.github.io/bpmn-generator/ontology' };
    expect(validateOntology(named).length).toBeGreaterThan(0);
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
    expect(resolveWithFallback(src, pkg, 'ontology.jsonld')).toBe(src);
  });

  test('a missing ontology names both searched paths', () => {
    expect(() => resolveWithFallback('/nope/a.jsonld', '/nope/b.jsonld', 'ontology.jsonld'))
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
  const ontologyNode = onto['@graph'].find(e => e['@type'] === 'owl:Ontology');
  const ids = onto['@graph'].filter(e => e !== ontologyNode).map(e => e['@id']);

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
  test('no context term maps to an IRI that is also a node, class or marker in the graph', () => {
    const expand = (t) => { const [pre, rest] = t.split(':'); return ctx[pre] ? ctx[pre] + rest : t; };
    const predicates = Object.entries(ctx).filter(([k, v]) => !k.startsWith('@') && !(typeof v === 'string' && /^https?:\/\//.test(v)))
      .map(([k, v]) => [k, expand(typeof v === 'string' ? v : v['@id'])]);
    const nodeIris = new Set(onto['@graph'].filter(e => e['@type'] !== 'owl:AnnotationProperty' && e !== ontologyNode).map(e => expand(e['@id'])));
    expect(predicates.filter(([, iri]) => nodeIris.has(iri))).toEqual([]);
  });
  test('field domains map to the declared annotation property bg:allowedOn, not rdfs:domain', () => {
    expect(ctx.domain['@id']).toBe('bg:allowedOn');
    expect(onto['@graph'].find(e => e['@id'] === 'bg:allowedOn')['@type']).toBe('owl:AnnotationProperty');
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
    expect(pkgJson.exports['./ontology']).toBe('./references/ontology.jsonld');
  });
  test('prepack copies it into the package', () => {
    const prepack = readFileSync(join(__dirname, '..', 'prepack-copy-references.mjs'), 'utf8');
    expect(prepack).toMatch(/'ontology\.jsonld'/);
  });
  test('prepack no longer knows the old name', () => {
    const prepack = readFileSync(join(__dirname, '..', 'prepack-copy-references.mjs'), 'utf8');
    expect(prepack).not.toMatch(/bpmn-ontology/);
  });
  test('a consumer of the export that filters @type "bg:NodeType" gets the same node types as before', () => {
    const names = raw()['@graph'].filter(e => e['@type'] === 'bg:NodeType').map(e => e.name);
    expect(names.sort()).toEqual([...SNAP.sets.ALL_NODE_TYPES].sort());
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
  test('SUPPORTED_NODE_TYPES has the same members as the schema enum', () => {
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
  ['scripts/dmn/requirement-order.js', 'Deliberately dependency-free, and the list is an ORDER (the DMN13.xsd sequence the writer emits), not a membership set. Fenced by equality, in order, below.'],
  ['scripts/scenarios/decision-table.js', 'Two hit-policy CATEGORIES (one branch per rule vs. aggregated), not the vocabulary itself. Fenced below: together they are exactly the ontology hit policies.'],
]);

describe('no vocabulary list outside the ontology', () => {
  const root = join(__dirname, '..', '..');
  const plain = [...VOCABULARY.nodeTypeNames(), ...VOCABULARY.markerNames()];
  // Both spellings: Logic-Core ('userTask') and bpmn-moddle ('bpmn:UserTask'); plus every DMN term.
  const vocab = new Set([...plain, ...plain.map(n => 'bpmn:' + n[0].toUpperCase() + n.slice(1)),
    ...VOCABULARY.dmnTerms.map(t => t.name)]);
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
  test('a private copy of the seven hit policies is caught; a list of rule ids is not', () => {
    const dmnVocab = new Set(VOCABULARY.dmnTerms.map(t => t.name));
    const copy = "const H = ['UNIQUE', 'FIRST', 'PRIORITY', 'ANY', 'COLLECT', 'RULE ORDER', 'OUTPUT ORDER'];";
    expect(findVocabularyLists(copy, dmnVocab)).toEqual([{ line: 1, names: VOCABULARY.dmn.hitPolicies() }]);
    expect(findVocabularyLists("const R = ['S01', 'S02', 'S03'];", vocab)).toEqual([]);
  });
  test('requirement-order.js emits the ontology requirement kinds, in order', () => {
    const src = readFileSync(join(__dirname, '..', 'dmn', 'requirement-order.js'), 'utf8');
    const m = /const REQUIREMENT_EMIT_KINDS = \[([^\]]+)\]/.exec(src);
    expect([...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])).toEqual(VOCABULARY.dmn.requirementKinds());
  });
  test('decision-table.js partitions exactly the ontology hit policies', () => {
    const src = readFileSync(join(__dirname, '..', 'scenarios', 'decision-table.js'), 'utf8');
    const set = (name) => [...new RegExp(`const ${name} = new Set\\(\\[([^\\]]+)\\]\\)`).exec(src)[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
    const perRule = set('PER_RULE_POLICIES');
    const aggregating = set('AGGREGATING_POLICIES');
    expect(perRule.filter(p => aggregating.includes(p))).toEqual([]);
    expect([...perRule, ...aggregating].sort()).toEqual([...VOCABULARY.dmn.hitPolicies(['supported'])].sort());
  });
});

import { checkCompleteness } from './ontology-audit.js';
import { renderTaskIcon, renderEventMarker } from './icons.js';
import { SHAPE } from './constants.js';

const schemaJson = JSON.parse(readFileSync(join(__dirname, '..', '..', 'references', 'input-schema.json'), 'utf8'));
// svg.js draws the shapes, icons.js the symbols inside them (gateway symbols, data shapes) — together the renderer.
const svgSrc = readFileSync(join(__dirname, 'svg.js'), 'utf8') + readFileSync(join(__dirname, 'icons.js'), 'utf8');
const read = (p) => readFileSync(join(__dirname, '..', '..', p), 'utf8');

// One probe per place a new type must reach. Order = the order a failure lists them in.
const PROBES = (v) => ({
  nodeType: {
    'input-schema.json NodeType': (t) => schemaJson.$defs.NodeType.enum.includes(t),
    'BPMN element (bpmnXmlTag)': (t) => { try { return !!T.bpmnXmlTag(t); } catch { return false; } },
    'shape size (config.json)': (t) => !!SHAPE[t],
    'task icon (icons.js)': (t) => !v.nodeTypes.find(n => n.name === t).classes.has('Task') || t === 'task' || renderTaskIcon(t) !== null,
    'rendering (svg.js)': (t) => {
      const cls = v.nodeTypes.find(n => n.name === t).classes;
      return !(cls.has('Gateway') || cls.has('Artifact')) || svgSrc.includes(`'${t}'`);
    },
    'import, both paths': (t) => T.SUPPORTED_NODE_TYPES.has(t),
    'prompt-template.md': (t) => read('references/prompt-template.md').includes(t),
    'SKILL.md': (t) => read('SKILL.md').includes('`' + t + '`'),
    'logic-core-schema.md': (t) => read('references/logic-core-schema.md').includes('`' + t + '`'),
  },
  marker: {
    'input-schema.json EventMarker': (m) => schemaJson.$defs.EventMarker.enum.includes(m),
    'event definition': (m) => T.EVENT_DEFINITION_BY_MARKER.has(m),
    'marker icon (icons.js / svg.js)': (m) => m === 'terminate' || renderEventMarker(m, 36, 36, false) !== '',
  },
});

describe('completeness — a new type cannot slip past any place', () => {
  test('the real vocabulary is complete everywhere', () => {
    expect(checkCompleteness(VOCABULARY, PROBES(VOCABULARY))).toEqual([]);
  });

  test('a type added only to the ontology is reported at every place', () => {
    const onto = raw();
    onto['@graph'].push({ '@id': 'bg:fooTask', '@type': 'bg:NodeType', name: 'fooTask', label: 'Foo Task',
      subClassOf: ['bg:Task'], status: 'supported', xmlTag: 'fooTask', seeAlso: ['omg:Task'] });
    const v = buildVocabulary(onto);
    const places = checkCompleteness(v, PROBES(v)).filter(f => f.name === 'fooTask').map(f => f.place);
    expect(places).toEqual(expect.arrayContaining(['input-schema.json NodeType', 'shape size (config.json)',
      'task icon (icons.js)', 'import, both paths', 'prompt-template.md', 'SKILL.md', 'logic-core-schema.md']));
  });

  test('a marker added only to the ontology is reported at every place', () => {
    const onto = raw();
    onto['@graph'].push({ '@id': 'bg:marker-foo', '@type': 'bg:EventMarker', name: 'foo', label: 'Foo', status: 'supported',
      eventDefinition: 'bpmn:FooEventDefinition', groups: [] });
    const v = buildVocabulary(onto);
    const places = checkCompleteness(v, PROBES(v)).filter(f => f.name === 'foo').map(f => f.place);
    expect(places).toEqual(expect.arrayContaining(['input-schema.json EventMarker', 'event definition', 'marker icon (icons.js / svg.js)']));
  });
});

import { runPipeline } from './pipeline.js';
describe('a type without a BPMN element fails clearly', () => {
  test('bpmnXmlTag refuses an announced or unknown type', () => {
    expect(() => T.bpmnXmlTag('adHocSubProcess')).toThrow(/no BPMN element for node type "adHocSubProcess"/);
    expect(() => T.bpmnXmlTag('nonsense')).toThrow(/"nonsense"/);
  });
  test('runPipeline names the type and the node instead of emitting a plain task', async () => {
    const lc = { id: 'p', nodes: [{ id: 's', type: 'startEvent' }, { id: 'x', type: 'nonsense' }, { id: 'e', type: 'endEvent' }],
      edges: [{ source: 's', target: 'x' }, { source: 'x', target: 'e' }] };
    await expect(runPipeline(lc)).rejects.toThrow(/"nonsense".*"x"|"x".*"nonsense"/);
  });
  test('CONTAINER_TYPES still includes the announced adHocSubProcess (S14 relies on it)', () => {
    expect(T.CONTAINER_TYPES.has('adHocSubProcess')).toBe(true);
  });
});

// import.js exports both paths: bpmnToLogicCore (async, the primary bpmn-moddle path) and
// bpmnToLogicCoreLegacy (sync, the DOM fallback).
// Boundary events and artifacts are covered by field-fidelity.test.js and subprocess-child-fidelity.
import { bpmnToLogicCore, bpmnToLogicCoreLegacy } from './import.js';

const findNode = (lc, id) => (lc.pools?.flatMap(p => p.nodes) ?? lc.nodes).find(n => n.id === id);
const one = (node, extra = []) => ({ id: 'p', name: 'P',
  nodes: [{ id: 's', type: 'startEvent' }, node, ...extra, { id: 'e', type: 'endEvent' }],
  edges: [{ source: 's', target: node.id }, { source: node.id, target: 'e' }] });

describe('round trip keeps the type', () => {
  const plain = VOCABULARY.nodeTypes.filter(t => ['supported', 'lossy'].includes(t.status)
    && !t.classes.has('Artifact') && !['startEvent', 'endEvent', 'boundaryEvent'].includes(t.name));
  for (const t of plain) {
    test(`${t.name} survives both importers as ${t.name}`, async () => {
      const r = await runPipeline(one({ id: 'n', type: t.name, name: 'N' }));
      for (const reader of [bpmnToLogicCore, bpmnToLogicCoreLegacy]) {
        const back = await reader(r.bpmnXml);
        expect(findNode(back, 'n').type).toBe(t.name);
        expect(findNode(back, 's').type).toBe('startEvent');
        expect(findNode(back, 'e').type).toBe('endEvent');
      }
    });
  }
  for (const m of VOCABULARY.markerNames(['supported']).filter(m => !['terminate', 'cancel', 'link', 'compensation'].includes(m))) {
    test(`marker ${m} survives both importers`, async () => {
      const r = await runPipeline(one({ id: 'n', type: 'intermediateCatchEvent', marker: m, name: 'N' }));
      for (const reader of [bpmnToLogicCore, bpmnToLogicCoreLegacy]) {
        const back = await reader(r.bpmnXml);
        expect(findNode(back, 'n').marker).toBe(m);
      }
    });
  }
  const markerCases = {
    terminate: () => one({ id: 'n', type: 'endEvent', marker: 'terminate', name: 'N' }),
    cancel: () => one({ id: 'n', type: 'endEvent', marker: 'cancel', name: 'N' }),
    compensation: () => one({ id: 'n', type: 'intermediateThrowEvent', marker: 'compensation', name: 'N' }),
  };
  for (const [m, mk] of Object.entries(markerCases)) {
    test(`marker ${m} survives both importers on its legal host`, async () => {
      const r = await runPipeline(mk());
      for (const reader of [bpmnToLogicCore, bpmnToLogicCoreLegacy]) {
        const back = await reader(r.bpmnXml);
        expect(findNode(back, 'n').marker).toBe(m);
      }
    });
  }
  test('marker link survives both importers as a throw/catch pair', async () => {
    const lc = { id: 'p', name: 'P',
      nodes: [{ id: 's', type: 'startEvent' }, { id: 'n', type: 'intermediateThrowEvent', marker: 'link', linkName: 'L', name: 'T' },
        { id: 'c', type: 'intermediateCatchEvent', marker: 'link', linkName: 'L', name: 'C' }, { id: 'e', type: 'endEvent' }],
      edges: [{ source: 's', target: 'n' }, { source: 'c', target: 'e' }] };
    const r = await runPipeline(lc);
    for (const reader of [bpmnToLogicCore, bpmnToLogicCoreLegacy]) {
      const back = await reader(r.bpmnXml);
      expect(findNode(back, 'n').marker).toBe('link');
      expect(findNode(back, 'c').marker).toBe('link');
    }
  });
});

import { validateLogicCoreSchema } from './schema-gate.js';

describe('format and ontology agree', () => {
  const s = JSON.parse(readFileSync(join(__dirname, '..', '..', 'references', 'input-schema.json'), 'utf8'));
  test('NodeType enum equals the supported node types', () => {
    expect([...s.$defs.NodeType.enum].sort()).toEqual(VOCABULARY.nodeTypeNames(['supported', 'lossy']).sort());
  });
  test('EventMarker enum equals the ontology markers', () => {
    expect([...s.$defs.EventMarker.enum].sort()).toEqual(VOCABULARY.markerNames(['supported', 'lossy']).sort());
  });
  test('TopLevelDefinition kinds equal the ontology definition kinds', () => {
    expect([...s.$defs.TopLevelDefinition.properties.type.enum].sort()).toEqual([...VOCABULARY.definitionKinds].sort());
  });
  test('both $schemaVersion declarations default to the ontology version', () => {
    expect(s.$defs.SingleProcess.properties.$schemaVersion.default).toBe(VOCABULARY.version);
    expect(s.$defs.Collaboration.properties.$schemaVersion.default).toBe(VOCABULARY.version);
  });
  test('a Logic-Core written for 1.0 stays valid after a minor bump; 2.0 does not', () => {
    const lc = (v) => ({ $schemaVersion: v, id: 'p', nodes: [{ id: 's', type: 'startEvent' }], edges: [] });
    expect(validateLogicCoreSchema(lc('1.0')).valid).toBe(true);
    expect(validateLogicCoreSchema(lc('1.7')).valid).toBe(true);
    expect(validateLogicCoreSchema(lc('2.0')).valid).toBe(false);
    expect(validateLogicCoreSchema(lc('1.')).valid).toBe(false);
    expect(validateLogicCoreSchema(lc('1.01')).valid).toBe(false);
  });
});

// ── Task 8: prompt, docs and skill template stay in line with the ontology ──
// Prompt token rule: a type-name candidate is a backticked token or a token right after `→`.
// Doc table rule: SKILL.md and logic-core-schema.md node-type table, first column backticked types.
// omg-compliance rule: every supported type's label appears in references/omg-compliance.md.
// Skill template rule: inline-template.md SHAPE keys include every supported type; isArtifact equals the Artifact class.
const md = (p) => readFileSync(join(__dirname, '..', '..', p), 'utf8');
const CANDIDATE = /^(task|group|transaction|subProcess|callActivity|[a-z][A-Za-z]*(Task|Event|Gateway|Reference|Annotation|SubProcess))$/;
const supported = new Set(VOCABULARY.nodeTypeNames(['supported', 'lossy']));
const ALL_TYPES = new Set(VOCABULARY.nodeTypeNames());

function firstColumnTypes(text) {
  // "the node-type table" rule: of the Markdown tables (consecutive lines starting with `|`), use the one
  // whose first column holds the most supported node types; field tables are other tables and are ignored.
  const tables = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('|')) { if (!cur) { cur = []; tables.push(cur); } cur.push(line); } else cur = null;
  }
  const firsts = tables.map(rows => new Set(rows.map(r => /^\|\s*`([A-Za-z]+)`\s*\|/.exec(r)?.[1])
    .filter(t => t && CANDIDATE.test(t))));
  const score = (set) => [...set].filter(t => supported.has(t)).length;
  return firsts.reduce((best, set) => (score(set) > score(best) ? set : best), new Set());
}

describe('prompt and docs follow the ontology', () => {
  test('the prompt names no unknown type and omits none', () => {
    const p = md('references/prompt-template.md');
    const tokens = [...p.matchAll(/`([A-Za-z]+)`|→\s*([A-Za-z]+)/g)].map(m => m[1] ?? m[2]).filter(t => CANDIDATE.test(t));
    // "no unknown name": checked against every ontology node type, announced ones included
    expect([...new Set(tokens)].filter(t => !ALL_TYPES.has(t))).toEqual([]);
    expect([...supported].filter(t => !p.includes(t))).toEqual([]);
  });
  for (const file of ['SKILL.md', 'references/logic-core-schema.md']) {
    test(`${file}: the node-type table lists exactly the supported types`, () => {
      expect([...firstColumnTypes(md(file))].sort()).toEqual([...supported].sort());
    });
  }
  test('omg-compliance.md: every supported type has a table row whose first cell starts with its label', () => {
    // First cells of every Markdown table row (backticks and bold stripped). A label must start one,
    // followed by end, a space or "(" — a whole-file substring match would pass on incidental words.
    const firstCells = md('references/omg-compliance.md').split('\n').filter(l => l.startsWith('|'))
      .map(l => l.split('|')[1].replace(/[`*]/g, '').trim());
    const hasRow = (label) => firstCells.some(c => c === label || c.startsWith(label + ' ') || c.startsWith(label + '('));
    expect(VOCABULARY.nodeTypes.filter(n => supported.has(n.name) && !hasRow(n.label)).map(n => n.name)).toEqual([]);
  });
  test('omg-compliance.md: every table row has as many cells as its table header', () => {
    // A row with a missing or duplicated cell still renders as a table, so only a count check catches it.
    const cellCount = (l) => l.trimEnd().replace(/^\|/, '').replace(/\|$/, '').split('|').length;
    const bad = [];
    let header = null;
    md('references/omg-compliance.md').split('\n').forEach((l, i) => {
      if (!l.startsWith('|')) { header = null; return; }
      const n = cellCount(l);
      if (header === null) header = n;
      else if (n !== header) bad.push(`references/omg-compliance.md:${i + 1} has ${n} cells, its table header has ${header}`);
    });
    expect(bad).toEqual([]);
  });
  test('the skill template knows every supported type and the Artifact class', () => {
    const t = md('references/inline-template.md');
    const shapeBlock = /SHAPE\s*=\s*\{([\s\S]*?)\};/.exec(t)[1];
    const keys = new Set([...shapeBlock.matchAll(/([A-Za-z]+)\s*:/g)].map(m => m[1]));
    expect([...supported].filter(s => !keys.has(s))).toEqual([]);
    const art = /isArtifact\s*=\s*t\s*=>\s*\[([^\]]+)\]/.exec(t)[1];
    expect([...art.matchAll(/'([^']+)'/g)].map(m => m[1]).sort()).toEqual([...VOCABULARY.classMembers('Artifact')].sort());
  });
});
