/**
 * The BPMN vocabulary — loaded from references/bpmn-ontology.jsonld, the single source of which
 * node types, event markers and definition kinds exist, which classes they belong to, and which
 * Logic-Core fields each element may carry.
 *
 * The file is JSON-LD so that other tools can read it as linked data, but this module reads it as
 * plain JSON: no RDF tooling at runtime. Validation runs at import time, so an invalid or missing
 * file makes every importer of types.js fail loudly instead of deriving empty classes.
 *
 * Must not import types.js — types.js derives everything from here.
 */
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { ontologyPath } from '../shared/resource-paths.js';

export const ONTOLOGY_NS = 'https://stieges.github.io/bpmn-generator/ontology#';

const STATUS = { enum: ['supported', 'lossy', 'announced'] };
const ID = { type: 'string', pattern: '^bg:[A-Za-z][A-Za-z0-9_-]*$' };   // _ for fields such as has_join
const IDS = { type: 'array', items: ID };
const LINKS = { type: 'array', items: { type: 'string', pattern: '^(omg|bbo):[A-Za-z]+$' } };
// Every `then` block closes its property list with additionalProperties: false, which only counts
// properties named in the SAME schema object — so each one must name @id and @type itself.
const BASE = { '@id': ID, '@type': { type: 'string' } };

const ONTOLOGY_SCHEMA = {
  type: 'object',
  required: ['@context', '@id', '@type', 'version', '@graph'],
  properties: {
    '@context': { type: 'object' },
    '@id': { const: 'https://stieges.github.io/bpmn-generator/ontology' },
    '@type': { const: 'owl:Ontology' },
    version: { type: 'string', pattern: '^1\\.(0|[1-9][0-9]*)$' },
    label: { type: 'string' },
    '@graph': {
      type: 'array',
      items: {
        type: 'object',
        required: ['@id', '@type'],
        properties: { '@id': ID, '@type': { enum: ['owl:Class', 'bg:NodeType', 'bg:EventMarker', 'bg:DefinitionKind', 'rdf:Property'] } },
        allOf: [
          { if: { properties: { '@type': { const: 'owl:Class' } } },
            then: { required: ['label', 'subClassOf', 'seeAlso'],
                    properties: { ...BASE, label: { type: 'string' }, subClassOf: IDS, seeAlso: LINKS, comment: { type: 'string' } },
                    additionalProperties: false } },
          { if: { properties: { '@type': { const: 'bg:NodeType' } } },
            then: { required: ['name', 'label', 'subClassOf', 'status', 'seeAlso'],
                    properties: { ...BASE, name: { type: 'string' }, label: { type: 'string' }, subClassOf: IDS, status: STATUS,
                                  xmlTag: { type: 'string' }, reason: { type: 'string' }, seeAlso: LINKS },
                    additionalProperties: false } },
          { if: { properties: { '@type': { const: 'bg:EventMarker' } } },
            then: { required: ['name', 'label', 'status', 'groups'],
                    properties: { ...BASE, name: { type: 'string' }, label: { type: 'string' }, status: STATUS,
                                  eventDefinition: { type: 'string', pattern: '^bpmn:[A-Za-z]+EventDefinition$' },
                                  reason: { type: 'string' }, groups: { type: 'array', items: { type: 'string' } }, seeAlso: LINKS },
                    additionalProperties: false } },
          { if: { properties: { '@type': { const: 'bg:DefinitionKind' } } },
            then: { required: ['name', 'label'], properties: { ...BASE, name: { type: 'string' }, label: { type: 'string' } },
                    additionalProperties: false } },
          { if: { properties: { '@type': { const: 'rdf:Property' } } },
            then: { required: ['name', 'element'],
                    properties: { ...BASE, name: { type: 'string' },
                                  element: { enum: ['Process', 'Collaboration', 'Pool', 'CollapsedPool', 'Node', 'Edge', 'Lane', 'MessageFlow', 'Association', 'TopLevelDefinition'] },
                                  domain: IDS },
                    additionalProperties: false } },
          // status rules
          { if: { required: ['status'], properties: { status: { const: 'lossy' } } }, then: { required: ['reason'] } },
          { if: { required: ['status'], properties: { '@type': { const: 'bg:NodeType' }, status: { const: 'supported' } } }, then: { required: ['xmlTag'] } },
          { if: { required: ['status'], properties: { '@type': { const: 'bg:EventMarker' }, status: { const: 'supported' } } }, then: { required: ['eventDefinition'] } },
        ],
      },
    },
  },
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(ONTOLOGY_SCHEMA);

export function validateOntology(onto) {
  if (validate(onto)) return [];
  return validate.errors.map(e => `${e.instancePath || '/'} ${e.message}`);
}

export function loadOntology(path = ontologyPath()) {
  const onto = JSON.parse(readFileSync(path, 'utf8'));
  const messages = validateOntology(onto);
  if (messages.length) throw new Error('bpmn-ontology.jsonld is invalid: ' + messages.join('; '));
  return onto;
}

const local = (id) => id.slice('bg:'.length);

export function buildVocabulary(onto) {
  const graph = onto['@graph'];
  const parents = new Map();                       // local id → local parent ids
  for (const e of graph) if (e.subClassOf) parents.set(local(e['@id']), e.subClassOf.map(local));
  const closure = (start) => {
    const out = new Set(); const stack = [...(parents.get(start) || [])];
    while (stack.length) { const x = stack.pop(); if (out.has(x)) continue; out.add(x); stack.push(...(parents.get(x) || [])); }
    return out;
  };
  const nodeTypes = graph.filter(e => e['@type'] === 'bg:NodeType').map(e => ({
    name: e.name, label: e.label, status: e.status, xmlTag: e.xmlTag ?? null, reason: e.reason ?? null,
    classes: closure(local(e['@id'])),
  }));
  const markers = graph.filter(e => e['@type'] === 'bg:EventMarker').map(e => ({
    name: e.name, label: e.label, status: e.status, eventDefinition: e.eventDefinition ?? null,
    groups: new Set(e.groups), reason: e.reason ?? null,
  }));
  const properties = graph.filter(e => e['@type'] === 'rdf:Property');
  const typeById = new Map(graph.filter(e => e['@type'] === 'bg:NodeType').map(e => [e['@id'], e.name]));
  const ALL = ['supported', 'lossy', 'announced'];
  return {
    version: onto.version,
    nodeTypes,
    nodeTypeNames: (statuses = ALL) => nodeTypes.filter(t => statuses.includes(t.status)).map(t => t.name),
    classMembers: (cls) => nodeTypes.filter(t => t.classes.has(cls)).map(t => t.name),
    markers,
    markerNames: (statuses = ALL) => markers.filter(m => statuses.includes(m.status)).map(m => m.name),
    markersInGroup: (g) => markers.filter(m => m.groups.has(g)).map(m => m.name),
    definitionKinds: graph.filter(e => e['@type'] === 'bg:DefinitionKind').map(e => e.name),
    fieldsOf: (element) => properties.filter(p => p.element === element).map(p => p.name),
    fieldDomain: (element, field) => {
      const p = properties.find(x => x.element === element && x.name === field);
      if (!p || !p.domain) return null;
      const wanted = new Set();
      for (const d of p.domain) {
        if (typeById.has(d)) wanted.add(typeById.get(d));
        else for (const t of nodeTypes) if (t.classes.has(local(d))) wanted.add(t.name);
      }
      return nodeTypes.map(t => t.name).filter(n => wanted.has(n));   // @graph order
    },
  };
}

export const VOCABULARY = buildVocabulary(loadOntology());
