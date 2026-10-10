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
