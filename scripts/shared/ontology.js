/**
 * The vocabulary of every notation this generator speaks — loaded from references/ontology.jsonld,
 * the single source of the BPMN node types, event markers, definition kinds and element fields, the DMN terms, and
 * of the rule catalog: which rules exist, which notation(s) and layer each belongs to, its default
 * severity and where it runs (`main` pipeline or `scenario` pipeline).
 *
 * The file is JSON-LD so that other tools can read it as linked data, but this module reads it as
 * plain JSON: no RDF tooling at runtime. Loading validates in two steps — the ajv schema below
 * (shape), then `checkReferences` (what a JSON Schema cannot say: that a rule's layer belongs to the
 * rule's notation, that a rule id is declared once) — so an invalid or missing file makes every
 * importer fail loudly instead of deriving empty classes or an empty rule catalog.
 *
 * Lives in shared/ because bpmn/ and dmn/ both derive from it and dmn/ must not import bpmn/.
 * Must not import types.js or any rule module: they all derive from here (the rule modules through
 * shared/rule-catalog.js). Everything is derived once, at import — never per rule call.
 */
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { ontologyPath } from './resource-paths.js';

const ONTOLOGY_IRI = 'https://stieges.github.io/bpmn-generator/ontology';
export const ONTOLOGY_NS = 'https://stieges.github.io/bpmn-generator/ontology#';
/** Rule-set name of every rule whose `kind` is `crossNotation` (decision F23: counted only there). */
export const CROSS_NOTATION = 'cross-notation';

const STATUS = { enum: ['supported', 'lossy', 'announced'] };
const ID = { type: 'string', pattern: '^bg:[A-Za-z][A-Za-z0-9_-]*$' };   // _ for fields such as has_join
const IDS = { type: 'array', items: ID };
const LINKS = { type: 'array', items: { type: 'string', pattern: '^(omg|bbo|dmn|sh):[A-Za-z]+$' } };
const REF = (kind) => ({ type: 'string', pattern: `^bg:${kind}-[A-Za-z0-9_-]+$` });
const NOTATION_REFS = { type: 'array', minItems: 1, items: REF('notation') };
const KIND = { enum: ['specific', 'crossNotation'] };
/** The six DMN term classes and the VOCABULARY.dmn view each one feeds. */
export const DMN_TERM_TYPES = Object.freeze({
  'bg:DecisionNodeKind': 'nodeKinds', 'bg:RequirementKind': 'requirementKinds', 'bg:HitPolicy': 'hitPolicies',
  'bg:Aggregation': 'aggregations', 'bg:TableOrientation': 'orientations', 'bg:ExpressionKind': 'expressionKinds',
});
const ONLY = (notationId) => ({ type: 'array', minItems: 1, maxItems: 1, items: { const: notationId } });
const DMN_LINKS = { type: 'array', minItems: 1, items: { type: 'string', pattern: '^dmn:[A-Za-z]+$' } };
// Every `then` block closes its property list with additionalProperties: false, which only counts
// properties named in the SAME schema object — so each one must name @id and @type itself.
const BASE = { '@id': ID, '@type': { type: 'string' } };

const ONTOLOGY_SCHEMA = {
  type: 'object',
  required: ['@context', '@graph'],
  additionalProperties: false,       // @id/@type/version beside @graph would make it a NAMED graph in JSON-LD 1.1
  properties: {
    '@context': { type: 'object' },
    '@graph': {
      type: 'array',
      items: {
        type: 'object',
        required: ['@id', '@type'],
        properties: { '@id': { type: 'string' }, '@type': { enum: ['owl:Ontology', 'owl:AnnotationProperty', 'owl:Class', 'bg:NodeType', 'bg:EventMarker', 'bg:DefinitionKind', 'rdf:Property',
          'bg:Notation', 'bg:Severity', 'bg:Layer', 'bg:Rule', ...Object.keys(DMN_TERM_TYPES)] } },
        allOf: [
          { if: { properties: { '@type': { const: 'owl:Ontology' } } },
            then: { required: ['version', 'label'],
                    properties: { '@id': { const: ONTOLOGY_IRI }, '@type': { type: 'string' },
                                  version: { type: 'string', pattern: '^1\\.(0|[1-9][0-9]*)$' }, label: { type: 'string' } },
                    additionalProperties: false } },
          { if: { properties: { '@type': { const: 'owl:AnnotationProperty' } } },
            then: { required: ['label', 'comment'],
                    properties: { '@id': ID, '@type': { type: 'string' }, label: { type: 'string' }, comment: { type: 'string' } },
                    additionalProperties: false } },
          { if: { properties: { '@type': { const: 'owl:Class' } } },
            then: { required: ['label', 'subClassOf', 'seeAlso'],
                    properties: { ...BASE, label: { type: 'string' }, subClassOf: IDS, seeAlso: LINKS, comment: { type: 'string' } },
                    additionalProperties: false } },
          { if: { properties: { '@type': { const: 'bg:NodeType' } } },
            then: { required: ['name', 'label', 'subClassOf', 'status', 'seeAlso'],
                    properties: { ...BASE, name: { type: 'string' }, label: { type: 'string' }, subClassOf: IDS, status: STATUS,
                                  xmlTag: { type: 'string' }, reason: { type: 'string' }, seeAlso: LINKS,
                                  notation: ONLY('bg:notation-BPMN') },
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
                                  element: { enum: ['Process', 'Collaboration', 'Pool', 'CollapsedPool', 'Node', 'Edge', 'Lane', 'MessageFlow', 'Association', 'TopLevelDefinition',
                                                   'DecisionCore', 'DecisionNode', 'Requirement', 'DecisionTable'] },
                                  domain: IDS },
                    additionalProperties: false } },
          // A notation is an open class: a new one is a new entry, never a schema change (E3).
          { if: { properties: { '@type': { const: 'bg:Notation' } } },
            then: { required: ['name', 'label', 'status'],
                    properties: { ...BASE, name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9]*$' }, label: { type: 'string' },
                                  status: { enum: ['supported', 'announced'] }, seeAlso: LINKS },
                    additionalProperties: false } },
          { if: { properties: { '@type': { const: 'bg:Severity' } } },
            then: { required: ['name', 'label'],
                    properties: { ...BASE, name: { type: 'string', pattern: '^[A-Z]+$' }, label: { type: 'string' },
                                  comment: { type: 'string' }, seeAlso: LINKS },
                    additionalProperties: false } },
          { if: { properties: { '@type': { const: 'bg:Layer' } } },
            then: { required: ['name', 'label', 'kind', 'notation'],
                    properties: { ...BASE, name: { type: 'string', pattern: '^[a-z][a-z_]*$' }, label: { type: 'string' },
                                  kind: KIND, notation: NOTATION_REFS },
                    additionalProperties: false } },
          // No description, ref or checked-types field yet: parked (record M8, E4). Their absence is deliberate.
          { if: { properties: { '@type': { const: 'bg:Rule' } } },
            then: { required: ['name', 'kind', 'notation', 'layer', 'defaultSeverity', 'runsIn'],
                    properties: { ...BASE, name: { type: 'string', pattern: '^[A-Z]+[0-9]+$' }, kind: KIND, notation: NOTATION_REFS,
                                  layer: REF('layer'), defaultSeverity: REF('severity'), runsIn: { enum: ['main', 'scenario'] } },
                    additionalProperties: false } },
          // DMN terms: one block per class (same shape), each tied to the DMN notation and linked to
          // the DMN 1.3 XSD namespace only (F15).
          ...Object.keys(DMN_TERM_TYPES).map((type) => ({ if: { properties: { '@type': { const: type } } },
            then: { required: ['name', 'label', 'status', 'notation', 'seeAlso'],
                    properties: { ...BASE, name: { type: 'string' }, label: { type: 'string' }, status: STATUS,
                                  reason: { type: 'string' }, notation: ONLY('bg:notation-DMN'), seeAlso: DMN_LINKS },
                    additionalProperties: false } })),
          // status rules
          { if: { required: ['status'], properties: { status: { const: 'lossy' } } }, then: { required: ['reason'] } },
          // a lossy node type joins SUPPORTED_NODE_TYPES, where bpmnXmlTag must resolve it
          { if: { required: ['status'], properties: { '@type': { const: 'bg:NodeType' }, status: { enum: ['supported', 'lossy'] } } }, then: { required: ['xmlTag'] } },
          { if: { required: ['status'], properties: { '@type': { const: 'bg:EventMarker' }, status: { const: 'supported' } } }, then: { required: ['eventDefinition'] } },
        ],
      },
    },
  },
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(ONTOLOGY_SCHEMA);

const valueAt = (doc, pointer) => pointer.split('/').slice(1)
  .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
  .reduce((o, k) => (o == null ? undefined : o[k]), doc);

/**
 * Schema step. `[]` when the shape is valid; otherwise one message per violation, naming the
 * location, the offending value (for enum/const/pattern), the entry's @id and the schema path.
 */
export function validateOntology(onto) {
  if (validate(onto)) return [];
  return validate.errors.map((e) => {
    const at = /^\/@graph\/(\d+)/.exec(e.instancePath);
    const id = at ? onto['@graph'][Number(at[1])]?.['@id'] : undefined;
    const got = ['enum', 'const', 'pattern'].includes(e.keyword) ? ` (got ${JSON.stringify(valueAt(onto, e.instancePath))})` : '';
    return `${e.instancePath || '/'} ${e.message}${got}${typeof id === 'string' ? ` [${id}]` : ''} (schema ${e.schemaPath})`;
  });
}

/**
 * Reference step — runs after the schema step and checks what JSON Schema cannot: every notation,
 * layer and severity a rule or layer names exists; a specific rule/layer names exactly one notation
 * and a cross-notation one at least two (F2); a specific rule sits in a layer of its own notation
 * and a cross-notation rule in a cross-notation layer (E3, F3); a rule id and a layer name (per
 * rule set) are declared once (M9). Pure; `[]` when clean. Defensive about shape, so it can also
 * guard `buildVocabulary` on an ontology that never went through `validateOntology`.
 */
export function checkReferences(onto) {
  const graph = Array.isArray(onto?.['@graph']) ? onto['@graph'] : [];
  const of = (type) => graph.map((e, i) => ({ e, i })).filter(({ e }) => e?.['@type'] === type);
  const notations = new Set(of('bg:Notation').map(({ e }) => e['@id']));
  const severities = new Set(of('bg:Severity').map(({ e }) => e['@id']));
  const layers = new Map(of('bg:Layer').map(({ e }) => [e['@id'], e]));
  const out = [];
  if (!graph.some((e) => e?.['@type'] === 'owl:Ontology')) out.push('missing owl:Ontology head — the version cannot be read');
  const notationsOf = (what, e) => {
    const ns = Array.isArray(e.notation) ? e.notation : [];
    if (e.kind !== 'specific' && e.kind !== 'crossNotation') out.push(`${what} has unknown kind ${JSON.stringify(e.kind)} — expected specific or crossNotation`);
    for (const n of ns) if (!notations.has(n)) out.push(`${what} names unknown notation ${n}`);
    if (e.kind === 'specific' && ns.length !== 1) out.push(`${what} is specific but names ${ns.length} notations (${ns.join(', ')}) — a specific entry names exactly one`);
    if (e.kind === 'crossNotation' && ns.length < 2) out.push(`${what} is cross-notation but names only ${ns.join(', ') || 'no notation'} — a cross-notation entry names at least two`);
    return ns;
  };
  const layerKeys = new Map();
  for (const { e, i } of of('bg:Layer')) {
    const ns = notationsOf(`layer ${e.name} (${e['@id']})`, e);
    const key = `${e.kind === 'crossNotation' ? CROSS_NOTATION : ns[0]}/${e.name}`;
    if (layerKeys.has(key)) out.push(`layer ${e.name} is declared twice in one rule set: ${layerKeys.get(key)} and ${e['@id']} (@graph/${i})`);
    else layerKeys.set(key, `${e['@id']} (@graph/${i})`);
  }
  const ruleIds = new Map();
  for (const { e, i } of of('bg:Rule')) {
    const what = `rule ${e.name} (${e['@id']})`;
    if (ruleIds.has(e.name)) out.push(`rule id ${e.name} is declared twice: ${ruleIds.get(e.name)} and ${e['@id']} (@graph/${i})`);
    else ruleIds.set(e.name, `${e['@id']} (@graph/${i})`);
    const ns = notationsOf(what, e);
    if (!severities.has(e.defaultSeverity)) out.push(`${what} names unknown severity ${e.defaultSeverity}`);
    const layer = layers.get(e.layer);
    if (!layer) { out.push(`${what} names unknown layer ${e.layer}`); continue; }
    const layerNs = Array.isArray(layer.notation) ? layer.notation : [];
    if (e.kind === 'crossNotation' && layer.kind !== 'crossNotation') {
      out.push(`${what} is cross-notation, but layer ${e.layer} belongs to ${layerNs.join(' + ')} only — cross-notation rules sit in cross-notation layers`);
    }
    if (e.kind === 'specific' && (layer.kind !== 'specific' || layerNs[0] !== ns[0])) {
      out.push(`${what} has notation ${ns.join(', ')}, but layer ${e.layer} belongs to ${layerNs.join(' + ')}`);
    }
  }
  return out;
}

export function loadOntology(path = ontologyPath()) {
  let onto;
  try { onto = JSON.parse(readFileSync(path, 'utf8')); }
  catch (err) { throw new Error(`ontology.jsonld (${path}) is not valid JSON: ${err.message}`); }
  const messages = validateOntology(onto);
  if (messages.length) throw new Error(`ontology.jsonld is invalid (${path}): ` + messages.join('; '));
  const broken = checkReferences(onto);
  if (broken.length) throw new Error(`ontology.jsonld has broken references (${path}): ` + broken.join('; '));
  return onto;
}

const local = (id) => id.slice('bg:'.length);
const ALL = ['supported', 'lossy', 'announced'];

/**
 * Pure: every view the code derives from the ontology. Expects a valid ontology; one with broken
 * references throws here, naming them, rather than failing later with a TypeError.
 */
export function buildVocabulary(onto) {
  const broken = checkReferences(onto);
  if (broken.length) throw new Error(`buildVocabulary: the ontology has broken references — ${broken.join('; ')}`);
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

  // Rule catalog: notations, severities, layers, rules — and rule sets (one per notation, plus
  // CROSS_NOTATION), each with its rule ids and layer names in @graph order.
  const notationEntries = graph.filter(e => e['@type'] === 'bg:Notation');
  const notationName = new Map(notationEntries.map(e => [e['@id'], e.name]));
  const notations = notationEntries.map(e => ({ name: e.name, label: e.label, status: e.status }));
  const severityEntries = graph.filter(e => e['@type'] === 'bg:Severity');
  const severityName = new Map(severityEntries.map(e => [e['@id'], e.name]));
  const severities = severityEntries.map(e => ({ name: e.name, label: e.label, seeAlso: e.seeAlso ?? [] }));
  const ruleSetOf = (e) => (e.kind === 'crossNotation' ? CROSS_NOTATION : notationName.get(e.notation[0]));
  const layerEntries = graph.filter(e => e['@type'] === 'bg:Layer');
  const layers = layerEntries.map(e => ({
    name: e.name, label: e.label, kind: e.kind, notations: e.notation.map(n => notationName.get(n)), ruleSet: ruleSetOf(e),
  }));
  const layerById = new Map(layerEntries.map((e, i) => [e['@id'], layers[i]]));
  const rules = graph.filter(e => e['@type'] === 'bg:Rule').map(e => ({
    id: e.name, kind: e.kind, notations: e.notation.map(n => notationName.get(n)), ruleSet: ruleSetOf(e),
    layer: layerById.get(e.layer).name, defaultSeverity: severityName.get(e.defaultSeverity), runsIn: e.runsIn,
  }));
  const dmnTerms = graph.filter(e => DMN_TERM_TYPES[e['@type']]).map(e => ({
    kind: DMN_TERM_TYPES[e['@type']], name: e.name, label: e.label, status: e.status,
  }));
  const dmn = Object.fromEntries(Object.values(DMN_TERM_TYPES).map(kind => [kind,
    (statuses = ALL) => dmnTerms.filter(t => t.kind === kind && statuses.includes(t.status)).map(t => t.name)]));
  const ruleSets = {};
  for (const n of notations) ruleSets[n.name] = { rules: [], layers: [] };
  ruleSets[CROSS_NOTATION] = { rules: [], layers: [] };
  for (const l of layers) ruleSets[l.ruleSet].layers.push(l.name);
  for (const r of rules) ruleSets[r.ruleSet].rules.push(r.id);

  return {
    version: graph.find(e => e['@type'] === 'owl:Ontology').version,
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
    notations,
    severities,
    layers,
    rules,
    ruleSets,
    dmnTerms,
    dmn,
  };
}

export const VOCABULARY = buildVocabulary(loadOntology());
