/**
 * Derived elements round trip: the writer marks every element a view derived with
 * `<bg:derived>` in its extensionElements, and reading the XML back removes the ones still as the
 * writer left them, so the author's model comes back. A derived gateway a person edited in a
 * modeler is theirs: it stays and loses the marker. No import result carries `_derived`.
 *
 * The edited files are real generated XML with one change made in the test, never hand-written.
 */
import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const actualDerivations = await import('./derivations.js');
// One switch, so a test can make the next removeDerivedElements call throw; every other call is
// the real function.
let throwOnNextRemove = null;
jest.unstable_mockModule('./derivations.js', () => ({
  ...actualDerivations,
  removeDerivedElements: (lc) => {
    if (throwOnNextRemove) {
      const err = throwOnNextRemove;
      throwOnNextRemove = null;
      throw err;
    }
    return actualDerivations.removeDerivedElements(lc);
  },
}));

const { applyDerivations, removeDerivedElements } = actualDerivations;
const { runPipeline } = await import('./pipeline.js');
const { bpmnToLogicCore, bpmnToLogicCoreLegacy } = await import('./import.js');
const { moddleParse } = await import('./moddle-import.js');
const { EXTENSION_NS } = await import('../shared/utils.js');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = (file) => JSON.parse(readFileSync(resolve(root, 'tests/fixtures', file), 'utf8'));
const JOINS = resolve(root, 'views/explicit-joins-view.json');
const MARKER = '<bg:derived>joinGateway</bg:derived>';
const FLOW_MARKER = '<bg:derived>joinGatewayFlow</bg:derived>';
const GW = 'gw_join_task1';
const ONWARD = 'flow_gw_join_task1_task1';

const READERS = [
  ['bpmnToLogicCore', (xml) => bpmnToLogicCore(xml)],
  ['bpmnToLogicCoreLegacy', async (xml) => bpmnToLogicCoreLegacy(xml)],
];

/** Every process of an import result: the pools, or the result itself. */
const processes = (lc) => lc.pools || [lc];
const nodesOf = (lc) => processes(lc).flatMap(p => p.nodes);
const edgesOf = (lc) => processes(lc).flatMap(p => p.edges);
const byId = (list) => Object.fromEntries(list.map(x => [x.id, x]));
const hasDerivedKey = (value) => JSON.stringify(value).includes('"_derived"');

let plainXml;
let joinedXml;
beforeAll(async () => {
  plainXml = (await runPipeline(fixture('simple-approval.json'))).bpmnXml;
  joinedXml = (await runPipeline(fixture('simple-approval.json'), { view: JOINS })).bpmnXml;
});

/** The gateway's element in the generated XML, for edits that touch it alone. */
const GATEWAY_ELEMENT = new RegExp(`<bpmn:exclusiveGateway id="${GW}"[\\s\\S]*?</bpmn:exclusiveGateway>`);
const ONWARD_FLOW = new RegExp(`<bpmn:sequenceFlow id="${ONWARD}"[^>]*?(?:/>|>[\\s\\S]*?</bpmn:sequenceFlow>)`);
/** The onward flow's extensionElements, which hold its flow marker. */
const ONWARD_EXTENSION = new RegExp(`(<bpmn:sequenceFlow id="${ONWARD}"[^>]*>)\\s*<bpmn:extensionElements>[\\s\\S]*?</bpmn:extensionElements>`);

/** `child` as the first (`first`) or last child of a flow element, self-closing or not. */
function withChild(el, child, { first = false } = {}) {
  if (el.endsWith('/>')) return `${el.slice(0, -2).trimEnd()}>\n      ${child}\n    </bpmn:sequenceFlow>`;
  if (first) return el.replace('>', `>\n      ${child}`);
  return el.replace(/\s*<\/bpmn:sequenceFlow>$/, `\n      ${child}\n    </bpmn:sequenceFlow>`);
}

/** A modeler's own namespace, declared on the definitions element as Camunda Modeler does. */
const CAMUNDA = 'http://camunda.org/schema/1.0/bpmn';
const declareCamunda = (xml) => editOnce(xml, /<bpmn:definitions /, `<bpmn:definitions xmlns:camunda="${CAMUNDA}" `);

/** Replace exactly one match, so an edit that no longer applies fails loudly. */
function editOnce(xml, pattern, replace) {
  const matches = xml.match(new RegExp(pattern.source, 'g')) || [];
  if (matches.length !== 1) throw new Error(`edit pattern matched ${matches.length} times: ${pattern}`);
  return xml.replace(pattern, replace);
}

describe('writer: the marker', () => {
  test('explicit-joins XML carries exactly one bg:derived, on the derived gateway', () => {
    expect(joinedXml.split(MARKER)).toHaveLength(2);
    expect(joinedXml.match(GATEWAY_ELEMENT)[0]).toContain(MARKER);
  });

  test('the derived onward flow carries the flow marker, and nothing else does', () => {
    expect(joinedXml.split(FLOW_MARKER)).toHaveLength(2);
    expect(joinedXml.match(ONWARD_FLOW)[0]).toContain(FLOW_MARKER);
  });

  test('XML without a view carries no marker and no extension namespace', () => {
    expect(plainXml).not.toContain('derived');
    expect(plainXml).not.toContain('xmlns:bg');
  });
});

describe.each(READERS)('%s: an untouched derived gateway is removed', (_, read) => {
  test('no gw_join_task1, six nodes, f1 and f5 enter task1 again', async () => {
    const lc = await read(joinedXml);
    const nodes = nodesOf(lc);
    expect(nodes.map(x => x.id)).not.toContain(GW);
    expect(nodes).toHaveLength(6);
    const edges = byId(edgesOf(lc));
    expect(edges[ONWARD]).toBeUndefined();
    expect(edges.f1.target).toBe('task1');
    expect(edges.f5.target).toBe('task1');
    expect(hasDerivedKey(lc)).toBe(false);
  });

  test('nodes, edges and lanes equal the import of the XML without a view', async () => {
    const joined = await read(joinedXml);
    const plain = await read(plainXml);
    expect(byId(nodesOf(joined))).toEqual(byId(nodesOf(plain)));
    expect(byId(edgesOf(joined))).toEqual(byId(edgesOf(plain)));
    expect(processes(joined).map(p => p.lanes)).toEqual(processes(plain).map(p => p.lanes));
  });

  test('a marker body with surrounding whitespace is the marker: the gateway is removed', async () => {
    const xml = editOnce(joinedXml, new RegExp(MARKER), '<bg:derived>\n  joinGateway  \n</bg:derived>');
    const lc = await read(xml);
    expect(nodesOf(lc).map(x => x.id)).not.toContain(GW);
    expect(byId(edgesOf(lc)).f5.target).toBe('task1');
    expect(hasDerivedKey(lc)).toBe(false);
  });

  test('a gateway written without any name attribute counts as nameless', async () => {
    const xml = editOnce(joinedXml, new RegExp(`id="${GW}" name=""`), `id="${GW}"`);
    expect(nodesOf(await read(xml)).map(x => x.id)).not.toContain(GW);
  });
});

/** The onward flow's opening tag, whatever follows it (a self-closing tag or child elements). */
const ONWARD_OPEN = new RegExp(`<bpmn:sequenceFlow id="${ONWARD}"[^>]*?(?=/?>)`);
/** `<bpmn:incoming>id</bpmn:incoming>` inside the element `elementId`, moved to `toId` (or dropped). */
const moveIncoming = (xml, flowId, fromId, toId) => {
  const inFrom = new RegExp(`(<bpmn:\\w+ id="${fromId}"[\\s\\S]*?)\\s*<bpmn:incoming>${flowId}</bpmn:incoming>`);
  let out = editOnce(xml, inFrom, '$1');
  if (toId) out = editOnce(out, new RegExp(`(<bpmn:\\w+ id="${toId}"[^>]*>)`), `$1\n      <bpmn:incoming>${flowId}</bpmn:incoming>`);
  return out;
};
/** The onward flow's arrowhead dragged onto `toId`, as a modeler writes it (targetRef and incoming). */
const repointOnward = (xml, toId) => moveIncoming(
  editOnce(xml, ONWARD_OPEN, (el) => el.replace('targetRef="task1"', `targetRef="${toId}"`)), ONWARD, 'task1', toId);
const ANNOTATION = (target) => `  <bpmn:textAnnotation id="note1">\n      <bpmn:text>Bewusst so</bpmn:text>\n    </bpmn:textAnnotation>\n    <bpmn:association id="assoc1" sourceRef="note1" targetRef="${target}" />\n  </bpmn:process>`;

/**
 * Edits a person can make in a modeler, each one applied to the generated XML. The optional third
 * entry is where f1 and f5 end afterwards (default: still at the gateway).
 */
const EDITS = [
  ['a second outgoing flow', (xml) => editOnce(
    editOnce(xml, GATEWAY_ELEMENT, (el) => el.replace('<bpmn:outgoing>', '<bpmn:outgoing>flow_extra</bpmn:outgoing>\n      <bpmn:outgoing>')),
    /<\/bpmn:process>/, `  <bpmn:sequenceFlow id="flow_extra" sourceRef="${GW}" targetRef="end1" />\n  </bpmn:process>`)],
  ['a name', (xml) => editOnce(xml, new RegExp(`id="${GW}" name=""`), `id="${GW}" name="Zusammenführen"`)],
  ['its type changed to parallelGateway', (xml) => editOnce(xml, GATEWAY_ELEMENT,
    (el) => el.replace('<bpmn:exclusiveGateway', '<bpmn:parallelGateway').replace('</bpmn:exclusiveGateway>', '</bpmn:parallelGateway>'))],
  ['a label on its outgoing flow', (xml) => editOnce(xml, ONWARD_FLOW, (el) => el.replace(`id="${ONWARD}"`, `id="${ONWARD}" name="weiter"`))],
  ['a condition on its outgoing flow', (xml) => editOnce(xml, ONWARD_FLOW, (el) => withChild(el,
    '<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">ok</bpmn:conditionExpression>'))],
  ['its outgoing flow set as default', (xml) => editOnce(xml, new RegExp(`id="${GW}" name=""`), `id="${GW}" name="" default="${ONWARD}"`)],
  ['documentation', (xml) => editOnce(xml, GATEWAY_ELEMENT,
    (el) => el.replace('>', '>\n      <bpmn:documentation>Bewusst gesetzt</bpmn:documentation>'))],
  // Edits neither importer reads into Logic-Core: the reader has to see them in the XML.
  ['a second extension element next to the marker', (xml) => editOnce(declareCamunda(xml), new RegExp(MARKER),
    `${MARKER}\n        <camunda:executionListener class="org.example.Listener" event="start" />`)],
  ['documentation on its outgoing flow', (xml) => editOnce(xml, ONWARD_FLOW, (el) => withChild(el,
    '<bpmn:documentation>Bewusst gesetzt</bpmn:documentation>', { first: true }))],
  ['a foreign attribute on it', (xml) => editOnce(declareCamunda(xml), new RegExp(`id="${GW}" name=""`),
    `id="${GW}" name="" camunda:asyncBefore="true"`)],
  ['a foreign attribute on its outgoing flow', (xml) => editOnce(declareCamunda(xml), ONWARD_FLOW,
    (el) => el.replace(`id="${ONWARD}"`, `id="${ONWARD}" camunda:asyncAfter="true"`))],
  // Edits after which removing the gateway would change what the process does, or leave a dangling
  // reference: the derivation never produces them, so the gateway stays.
  ['its outgoing flow re-pointed at another gateway', (xml) => repointOnward(xml, 'gw1')],
  ['both incoming flows dragged off it onto task1 (zero incoming flows)', (xml) => {
    let out = xml;
    for (const f of ['f1', 'f5']) {
      out = editOnce(out, new RegExp(`(<bpmn:sequenceFlow id="${f}"[^>]*?)targetRef="${GW}"`), '$1targetRef="task1"');
      out = moveIncoming(out, f, GW, 'task1');
    }
    return out;
  }, 'task1'],
  ['a text annotation attached to its outgoing flow', (xml) => editOnce(xml, /\s*<\/bpmn:process>/, `\n  ${ANNOTATION(ONWARD)}`)],
  // The onward flow's own marker: the gateway is the derivation's only while its flow is too.
  ['its outgoing flow without the flow marker', (xml) => editOnce(xml, ONWARD_EXTENSION, '$1')],
  ['its outgoing flow marked with the gateway\'s marker instead', (xml) => editOnce(xml, new RegExp(FLOW_MARKER), MARKER)],
  ['a second extension element next to the flow marker', (xml) => editOnce(declareCamunda(xml), new RegExp(FLOW_MARKER),
    `${FLOW_MARKER}\n        <camunda:executionListener class="org.example.Listener" event="take" />`)],
];

/** Read by the legacy reader only: bpmn-moddle warns about the unresolved reference. */
const DANGLING_EDIT = ['its outgoing flow re-pointed at an id that does not exist', (xml) =>
  editOnce(moveIncoming(xml, ONWARD, 'task1', null), ONWARD_OPEN, (el) => el.replace('targetRef="task1"', 'targetRef="nowhere"'))];

describe.each(READERS)('%s: a derived gateway edited by a person stays', (_, read) => {
  test.each([...EDITS, DANGLING_EDIT])('given %s', async (_label, edit, incomingAt = GW) => {
    const xml = edit(joinedXml);
    expect(xml).toContain(MARKER); // the edit kept the marker: the reader is what decides
    const lc = await read(xml);
    expect(nodesOf(lc).map(x => x.id)).toContain(GW);
    const edges = byId(edgesOf(lc));
    expect(edges.f1.target).toBe(incomingAt);
    expect(edges.f5.target).toBe(incomingAt);
    expect(edges[ONWARD]).toBeDefined();
    expect(edges[ONWARD].source).toBe(GW);
    expect(hasDerivedKey(lc)).toBe(false);
  });
});

/** The extension namespace declared, as the writer declares it, where the file does not yet. */
const declareBg = (xml) => (xml.includes('xmlns:bg=') ? xml
  : editOnce(xml, /<bpmn:definitions /, `<bpmn:definitions xmlns:bg="${EXTENSION_NS}" `));
/** The flow marker copied onto f2 (task1 → gw1) and f4 (leaving the unmarked gateway gw1). */
const strayFlowMarkers = (xml) => ['f2', 'f4'].reduce((out, f) => editOnce(out,
  new RegExp(`<bpmn:sequenceFlow id="${f}"[^>]*?(?:/>|>[\\s\\S]*?</bpmn:sequenceFlow>)`),
  (el) => withChild(el, `<bpmn:extensionElements>\n        ${FLOW_MARKER}\n      </bpmn:extensionElements>`, { first: true })), declareBg(xml));

describe.each(READERS)('%s: a flow marker on a flow that does not leave a marked gateway', (_, read) => {
  test.each([['the explicit-joins XML', () => joinedXml], ['the XML without a view', () => plainXml]])(
    'in %s is read as a plain flow: nothing is removed, no _derived anywhere', async (_label, source) => {
      const xml = strayFlowMarkers(source());
      const lc = await read(xml);
      const plain = await read(plainXml);
      expect(byId(nodesOf(lc))).toEqual(byId(nodesOf(plain)));
      expect(byId(edgesOf(lc))).toEqual(byId(edgesOf(plain)));
      expect(hasDerivedKey(lc)).toBe(false);
    });
});

describe.each(READERS)('%s: an annotation on the onward flow survives the round trip', (_, read) => {
  test('the association still points at an existing flow, and regenerating writes no "undefined"', async () => {
    const lc = await read(editOnce(joinedXml, /\s*<\/bpmn:process>/, `\n  ${ANNOTATION(ONWARD)}`));
    const ids = new Set([...nodesOf(lc), ...edgesOf(lc)].map(x => x.id));
    expect(lc.associations).toEqual([expect.objectContaining({ source: 'note1', target: ONWARD })]);
    expect(ids.has(ONWARD)).toBe(true);
    const { bpmnXml } = await runPipeline(lc);
    expect(bpmnXml).not.toContain('"undefined"');
  });
});

/**
 * What the stripping decides: which nodes exist and how the flows run. Compared instead of the
 * whole result because the readers already differ elsewhere — bpmn-moddle keeps a foreign
 * attribute in `extensions.$attrs`, the DOM reader has no such read.
 */
const strippingOutcome = (lc) => ({ nodes: nodesOf(lc).map(x => x.id), edges: edgesOf(lc) });

describe('both readers agree on every edited file', () => {
  test.each(EDITS)('given %s', async (_label, edit) => {
    const xml = edit(joinedXml);
    // bpmn-moddle reads the file cleanly, so bpmnToLogicCore really takes the moddle path.
    expect((await moddleParse(xml)).warnings).toEqual([]);
    expect(strippingOutcome(await bpmnToLogicCore(xml))).toEqual(strippingOutcome(bpmnToLogicCoreLegacy(xml)));
  });

  test('given a marker body with surrounding whitespace', async () => {
    const xml = editOnce(joinedXml, new RegExp(MARKER), '<bg:derived> joinGateway </bg:derived>');
    expect(await bpmnToLogicCore(xml)).toEqual(bpmnToLogicCoreLegacy(xml));
  });

  test('given a flow marker body with surrounding whitespace: the gateway is removed by both', async () => {
    const xml = editOnce(joinedXml, new RegExp(FLOW_MARKER), '<bg:derived>\n  joinGatewayFlow  \n</bg:derived>');
    const lc = await bpmnToLogicCore(xml);
    expect(nodesOf(lc).map(x => x.id)).not.toContain(GW);
    expect(lc).toEqual(bpmnToLogicCoreLegacy(xml));
  });

  test.each([['the explicit-joins XML', () => joinedXml], ['the XML without a view', () => plainXml]])(
    'given stray flow markers in %s', async (_label, source) => {
      const xml = strayFlowMarkers(source());
      expect((await moddleParse(xml)).warnings).toEqual([]);
      expect(strippingOutcome(await bpmnToLogicCore(xml))).toEqual(strippingOutcome(bpmnToLogicCoreLegacy(xml)));
    });
});

describe('removeDerivedElements on Logic-Core', () => {
  const n = (id, type = 'task', extra = {}) => ({ id, type, name: id, ...extra });
  const e = (id, source, target, extra = {}) => ({ id, source, target, ...extra });
  const ON = { joinGateways: true };

  /** s → x? → a | b → t → end: `t` has two incoming flows. Lanes list membership by nodeIds. */
  const mergeModel = () => ({
    id: 'p', name: 'P',
    nodes: [n('s', 'startEvent'), n('x', 'exclusiveGateway'), n('a'), n('b'), n('t'), n('end', 'endEvent')],
    edges: [e('f1', 's', 'x'), e('f2', 'x', 'a'), e('f3', 'x', 'b'), e('fa', 'a', 't', { isHappyPath: true }), e('fb', 'b', 't'), e('f4', 't', 'end')],
    lanes: [{ id: 'L', name: 'L', children: [{ id: 'L1', name: 'L1', nodeIds: ['s', 'x', 'a'] }, { id: 'L2', name: 'L2', nodeIds: ['b', 't', 'end'] }] }],
  });

  test('undoes applyDerivations, nested lane nodeIds included', () => {
    const derivedLc = applyDerivations(mergeModel(), ON).lc;
    expect(JSON.stringify(derivedLc.lanes)).toContain('gw_join_t');
    expect(removeDerivedElements(derivedLc)).toEqual(mergeModel());
  });

  test.each([
    'simple-approval.json', 'bpmn-generator-pipeline.json', 'example-kreditantrag.json',
    'example-rechnungspruefung.json', 'boundary-event-shapes.json', 'subprocess-merge-fanout.json',
    'wrapping-back-edge.json',
  ])('undoes applyDerivations on %s', (file) => {
    const { lc: derivedLc, derived } = applyDerivations(fixture(file), ON);
    expect(derived.length).toBeGreaterThan(0);
    expect(removeDerivedElements(derivedLc)).toEqual(fixture(file));
  });

  test('the argument is not changed', () => {
    const derivedLc = applyDerivations(mergeModel(), ON).lc;
    const snapshot = JSON.stringify(derivedLc);
    const result = removeDerivedElements(derivedLc);
    expect(JSON.stringify(derivedLc)).toBe(snapshot);
    expect(result).not.toBe(derivedLc);
  });

  test('a model without derived elements comes back equal', () => {
    expect(removeDerivedElements(mergeModel())).toEqual(mergeModel());
  });

  test('inside a subprocess and in every pool: removed when untouched, unmarked when edited', () => {
    const gw = (id) => ({ id, type: 'exclusiveGateway', name: '', has_join: true, _derived: 'joinGateway' });
    const lc = {
      pools: [
        { id: 'P1', name: 'P1', lanes: [],
          nodes: [n('s', 'startEvent'), { ...n('sub', 'subProcess'),
            nodes: [n('a'), n('b'), gw('g_in'), n('c')],
            edges: [e('s1', 'a', 'g_in'), e('s2', 'b', 'g_in'), e('s3', 'g_in', 'c')] }],
          edges: [e('p1', 's', 'sub')] },
        { id: 'P2', name: 'P2', lanes: [],
          nodes: [n('a2'), { ...gw('g_named'), name: 'Join' }, n('c2')],
          edges: [e('q1', 'a2', 'g_named'), e('q2', 'g_named', 'c2')] },
      ],
      messageFlows: [],
    };
    const out = removeDerivedElements(lc);
    const sub = out.pools[0].nodes[1];
    expect(sub.nodes.map(x => x.id)).toEqual(['a', 'b', 'c']);
    expect(sub.edges).toEqual([e('s1', 'a', 'c'), e('s2', 'b', 'c')]);
    expect(out.pools[1].nodes[1]).toEqual({ id: 'g_named', type: 'exclusiveGateway', name: 'Join', has_join: true });
    expect(out.pools[1].edges).toEqual(lc.pools[1].edges);
    expect(hasDerivedKey(out)).toBe(false);
  });

  /** a, b → g (marked) → `onward target`; the derivation can only ever produce a non-gateway target. */
  const markedJoin = (targetType, { incoming = true, target = 'c' } = {}) => ({
    nodes: [n('a'), n('b'), { id: 'g', type: 'exclusiveGateway', has_join: true, _derived: 'joinGateway' }, n('c', targetType), n('d'), n('end', 'endEvent')],
    edges: [
      ...(incoming ? [e('f1', 'a', 'g'), e('f2', 'b', 'g')] : [e('f1', 'a', 'c'), e('f2', 'b', 'c')]),
      e('f3', 'g', target), e('f4', 'd', 'c'), e('f5', 'c', 'end'),
    ],
  });

  test.each([
    ['its onward target is a parallel join', markedJoin('parallelGateway')],
    ['its onward target is an exclusive gateway', markedJoin('exclusiveGateway')],
    ['its onward target does not exist', markedJoin('task', { target: 'nowhere' })],
    ['it has no incoming flow', markedJoin('task', { incoming: false })],
  ])('a marked gateway stays, unmarked, when %s', (_label, lc) => {
    const out = removeDerivedElements(lc);
    const { _derived, ...unmarked } = lc.nodes[2];
    expect(out.nodes[2]).toEqual(unmarked);
    expect(out.edges).toEqual(lc.edges);
    expect(hasDerivedKey(out)).toBe(false);
  });

  test('a marked gateway whose onward target is a node of another container stays', () => {
    const lc = {
      nodes: [n('a'), n('b'), { id: 'g', type: 'exclusiveGateway', has_join: true, _derived: 'joinGateway' },
        { ...n('sub', 'subProcess'), nodes: [n('inner')], edges: [] }],
      edges: [e('f1', 'a', 'g'), e('f2', 'b', 'g'), e('f3', 'g', 'inner')],
    };
    expect(removeDerivedElements(lc).nodes.map(x => x.id)).toContain('g');
  });

  test('a stray flow marker on an edge is dropped; an edited gateway\'s onward edge loses its marker', () => {
    const lc = markedJoin('parallelGateway');
    lc.edges[2]._derived = 'joinGatewayFlow';
    lc.edges[3]._derived = 'joinGatewayFlow';
    const out = removeDerivedElements(lc);
    expect(out.nodes.map(x => x.id)).toContain('g');
    expect(out.edges.map(x => x.id)).toEqual(lc.edges.map(x => x.id));
    expect(hasDerivedKey(out)).toBe(false);
  });

  test('an edge marked with a value the derivation does not write keeps the gateway', () => {
    const lc = markedJoin('task');
    lc.edges[2]._derived = 'joinGateway';
    const out = removeDerivedElements(lc);
    expect(out.nodes.map(x => x.id)).toContain('g');
    expect(hasDerivedKey(out)).toBe(false);
  });

  test('a gateway whose onward flow an association refers to stays', () => {
    const lc = { ...markedJoin('task'), associations: [{ id: 'as1', source: 'note', target: 'f3' }] };
    lc.nodes.push(n('note', 'textAnnotation'));
    const out = removeDerivedElements(lc);
    expect(out.nodes.map(x => x.id)).toContain('g');
    expect(out.edges.map(x => x.id)).toContain('f3');
    expect(hasDerivedKey(out)).toBe(false);
  });

  test('a gateway an association or message flow refers to stays', () => {
    const lc = {
      nodes: [n('a'), n('b'), { id: 'g', type: 'exclusiveGateway', has_join: true, _derived: 'joinGateway' }, n('c'), n('note', 'textAnnotation')],
      edges: [e('f1', 'a', 'g'), e('f2', 'b', 'g'), e('f3', 'g', 'c')],
      associations: [{ id: 'as1', source: 'note', target: 'g' }],
    };
    const out = removeDerivedElements(lc);
    expect(out.nodes.map(x => x.id)).toContain('g');
    expect(hasDerivedKey(out)).toBe(false);
  });
});

const MULTI_POOL = ['bpmn-generator-pipeline.json', 'example-kreditantrag.json'];
describe.each(READERS)('%s: multi-pool XML round trip', (_, read) => {
  test.each(MULTI_POOL)('explicit-joins XML of %s imports like the XML without a view', async (file) => {
    const lc = fixture(file);
    const joined = (await runPipeline(lc, { view: JOINS })).bpmnXml;
    expect(joined).toContain(MARKER);
    const plain = (await runPipeline(lc)).bpmnXml;
    const fromJoined = await read(joined);
    const fromPlain = await read(plain);
    expect(byId(nodesOf(fromJoined))).toEqual(byId(nodesOf(fromPlain)));
    expect(byId(edgesOf(fromJoined))).toEqual(byId(edgesOf(fromPlain)));
    expect(processes(fromJoined).map(p => p.lanes)).toEqual(processes(fromPlain).map(p => p.lanes));
    expect(hasDerivedKey(fromJoined)).toBe(false);
  });
});

describe('bpmnToLogicCore: an error in removeDerivedElements is not masked', () => {
  test('it propagates instead of falling back to the legacy reader', async () => {
    // Only the first call throws: had the moddle path's error been caught, the legacy reader's own
    // call would succeed and the import would resolve.
    throwOnNextRemove = new Error('defect in removeDerivedElements');
    await expect(bpmnToLogicCore(joinedXml)).rejects.toThrow('defect in removeDerivedElements');
    expect(throwOnNextRemove).toBeNull();
  });
});
