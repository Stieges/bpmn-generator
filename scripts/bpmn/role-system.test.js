/**
 * `role` and `system` on an activity — the acceptance scenarios of the requirement "Rolle und
 * System am Arbeitsschritt".
 *
 * `field-fidelity.test.js` already drives both fields through the pipeline and back through both
 * importers for every allowed class at depth 0 and 1. What it cannot see, and what is tested here:
 * the SHAPE of the XML (one shared `<bpmn:resource>` per role name, `humanPerformer` vs.
 * `performer`), id derivation and collision safety, S15 on an out-of-scope node, the coexistence
 * with `decisionRef` in one extensionElements, that the drawing does not change, and that the
 * foreign role forms the requirement parks are deliberately NOT read.
 */
import { describe, test, expect } from '@jest/globals';
import { runPipeline } from './pipeline.js';
import { runRules } from './rules.js';
import { bpmnToLogicCore, bpmnToLogicCoreLegacy } from './import.js';
import { validateBpmnXml } from './bpmn-xml.js';

const IMPORTERS = [
  ['moddle', (xml) => bpmnToLogicCore(xml)],
  ['legacy', async (xml) => bpmnToLogicCoreLegacy(xml)],
];

/** start → ...tasks in order → end, every node wired. */
function chain(tasks, extra = {}) {
  const nodes = [{ id: 's', type: 'startEvent', name: 'Request received' }, ...tasks,
    { id: 'e', type: 'endEvent', name: 'Request handled' }];
  const edges = nodes.slice(1).map((n, i) => ({ id: `f${i}`, source: nodes[i].id, target: n.id }));
  return { id: 'P', name: 'P', nodes, edges, ...extra };
}

function findNode(nodes, id) {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    const hit = findNode(n.nodes, id);
    if (hit) return hit;
  }
  return undefined;
}

const count = (xml, re) => (xml.match(re) || []).length;

describe('role is serialised as OMG standard', () => {
  test('one shared resource per role name; humanPerformer on user/manual tasks, performer elsewhere; no moddle warning', async () => {
    const lc = chain([
      { id: 't1', type: 'userTask', name: 'Check claim', role: 'Experte XY' },
      { id: 't2', type: 'manualTask', name: 'File claim', role: 'Experte XY' },
      { id: 't3', type: 'serviceTask', name: 'Book payment', role: 'Experte XY' },
      { id: 't4', type: 'callActivity', name: 'Run audit', role: 'Auditor' },
    ]);
    const result = await runPipeline(lc);
    const xml = result.bpmnXml;

    expect(count(xml, /<bpmn:resource /g)).toBe(2);
    expect(xml).toContain('<bpmn:resource id="Resource_Experte_XY" name="Experte XY" />');
    expect(xml).toContain('<bpmn:resource id="Resource_Auditor" name="Auditor" />');
    expect(xml).toMatch(/<bpmn:userTask id="t1"[\s\S]*?<bpmn:humanPerformer>\s*<bpmn:resourceRef>Resource_Experte_XY<\/bpmn:resourceRef>/);
    expect(xml).toMatch(/<bpmn:manualTask id="t2"[\s\S]*?<bpmn:humanPerformer>\s*<bpmn:resourceRef>Resource_Experte_XY<\/bpmn:resourceRef>/);
    expect(xml).toMatch(/<bpmn:serviceTask id="t3"[\s\S]*?<bpmn:performer>\s*<bpmn:resourceRef>Resource_Experte_XY<\/bpmn:resourceRef>/);
    expect(xml).toMatch(/<bpmn:callActivity id="t4"[\s\S]*?<bpmn:performer>\s*<bpmn:resourceRef>Resource_Auditor<\/bpmn:resourceRef>/);

    expect(result.validation.xmlWarnings).toEqual([]);
    expect((await validateBpmnXml(xml)).warnings).toEqual([]);
  });

  test('a role on a subprocess and on a task inside it shares the resource across depths', async () => {
    const lc = chain([{
      id: 'sp', type: 'subProcess', name: 'Handle claim', role: 'Team A', isExpanded: true,
      nodes: [
        { id: 'is', type: 'startEvent', name: 'In' },
        { id: 'it', type: 'userTask', name: 'Check claim', role: 'Team A' },
        { id: 'ie', type: 'endEvent', name: 'Out' },
      ],
      edges: [{ id: 'i1', source: 'is', target: 'it' }, { id: 'i2', source: 'it', target: 'ie' }],
    }]);
    const { bpmnXml: xml, validation } = await runPipeline(lc);
    expect(count(xml, /<bpmn:resource /g)).toBe(1);
    expect(count(xml, /<bpmn:resourceRef>Resource_Team_A<\/bpmn:resourceRef>/g)).toBe(2);
    expect(validation.xmlWarnings).toEqual([]);
  });

  test('resource ids are derived from the name, deterministic, and collision-safe', async () => {
    // "Experte.XY" collapses to the same slug as "Experte XY"; a node already owns the plain id.
    const lc = chain([
      { id: 'Resource_Experte_XY', type: 'userTask', name: 'Check claim', role: 'Experte XY' },
      { id: 't2', type: 'userTask', name: 'File claim', role: 'Experte.XY' },
      { id: 't3', type: 'userTask', name: 'Close claim', role: '%%%' },
    ]);
    const a = await runPipeline(lc);
    const b = await runPipeline(lc);
    expect(a.bpmnXml).toBe(b.bpmnXml);
    expect(a.bpmnXml).toContain('<bpmn:resource id="Resource_Experte_XY_2" name="Experte XY" />');
    expect(a.bpmnXml).toContain('<bpmn:resource id="Resource_Experte_XY_3" name="Experte.XY" />');
    expect(a.bpmnXml).toContain('<bpmn:resource id="Resource" name="%%%" />');
    expect(a.validation.xmlWarnings).toEqual([]);
    for (const [, read] of IMPORTERS) {
      const back = await read(a.bpmnXml);
      expect(findNode(back.nodes, 'Resource_Experte_XY').role).toBe('Experte XY');
      expect(findNode(back.nodes, 't2').role).toBe('Experte.XY');
      expect(findNode(back.nodes, 't3').role).toBe('%%%');
    }
  });

  test('a model without role writes no resource at all', async () => {
    const { bpmnXml } = await runPipeline(chain([{ id: 't1', type: 'userTask', name: 'Check claim' }]));
    expect(bpmnXml).not.toMatch(/resource|erformer/);
  });
});

describe('round trip of both fields at every depth, through both importers', () => {
  const lc = chain([
    { id: 'top', type: 'userTask', name: 'Check claim', role: 'Experte XY', system: 'SAP' },
    {
      id: 'sp', type: 'subProcess', name: 'Settle claim', isExpanded: true,
      nodes: [
        { id: 'is', type: 'startEvent', name: 'In' },
        { id: 'deep', type: 'serviceTask', name: 'Book payment', role: 'Buchhaltung', system: 'SAP FI' },
        { id: 'ie', type: 'endEvent', name: 'Out' },
      ],
      edges: [{ id: 'i1', source: 'is', target: 'deep' }, { id: 'i2', source: 'deep', target: 'ie' }],
    },
  ]);

  test.each(IMPORTERS)('%s importer', async (_name, read) => {
    const { bpmnXml } = await runPipeline(lc);
    const back = await read(bpmnXml);
    expect(findNode(back.nodes, 'top')).toMatchObject({ role: 'Experte XY', system: 'SAP' });
    expect(findNode(back.nodes, 'deep')).toMatchObject({ role: 'Buchhaltung', system: 'SAP FI' });
  });

  test('system and decisionRef share one extensionElements and both survive', async () => {
    const both = chain([{ id: 'br', type: 'businessRuleTask', name: 'Rate risk', decisionRef: 'dec_risk', system: 'Rules Engine' }]);
    const { bpmnXml, validation } = await runPipeline(both);
    expect(count(bpmnXml, /<bpmn:extensionElements>/g)).toBe(1);
    expect(validation.xmlWarnings).toEqual([]);
    for (const [, read] of IMPORTERS) {
      expect(findNode((await read(bpmnXml)).nodes, 'br')).toMatchObject({ decisionRef: 'dec_risk', system: 'Rules Engine' });
    }
  });
});

describe('a field on an element out of its scope', () => {
  const S15_AS_ERROR = { profile: 'test', version: '1.0', overrides: { S15: { severity: 'ERROR' } } };

  test('role on a gateway: S15 reports it, the XML stays valid and carries no resource', async () => {
    const lc = chain([
      { id: 't1', type: 'userTask', name: 'Check claim' },
      { id: 'g', type: 'exclusiveGateway', name: 'Claim valid?', role: 'Experte XY' },
    ]);
    const result = await runPipeline(lc);
    const hit = result.validation.warnings.filter((w) => w.includes('"g"') && w.includes('"role"'));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toContain('OMG defines resources only on an Activity');
    expect(result.bpmnXml).not.toMatch(/resource|erformer/);
    expect(result.validation.xmlWarnings).toEqual([]);
    // It is S15 that says it: escalating S15 alone moves the finding to the errors.
    const escalated = runRules(lc, S15_AS_ERROR);
    expect(escalated.errors.filter((m) => m.includes('"role"'))).toHaveLength(1);
  });

  test('system on a subprocess and on an event: S15 reports both without claiming OMG defines the field', async () => {
    const lc = chain([
      { id: 'sp', type: 'subProcess', name: 'Settle claim', system: 'SAP' },
      { id: 'ev', type: 'intermediateThrowEvent', name: 'Claim settled', system: 'SAP' },
    ]);
    const result = await runPipeline(lc);
    const hits = result.validation.warnings.filter((w) => w.includes('"system"'));
    expect(hits).toHaveLength(2);
    for (const h of hits) {
      expect(h).toContain('only on a Task');
      expect(h).not.toMatch(/OMG defines system/);
    }
    expect(result.bpmnXml).not.toContain('bg:system');
    expect(result.validation.xmlWarnings).toEqual([]);
    expect(runRules(lc, S15_AS_ERROR).errors.filter((m) => m.includes('"system"'))).toHaveLength(2);
  });
});

describe('the drawing does not change', () => {
  test('SVG and DI are byte-identical with and without role/system', async () => {
    const plain = chain([
      { id: 't1', type: 'userTask', name: 'Check claim' },
      { id: 't2', type: 'serviceTask', name: 'Book payment' },
    ]);
    const tagged = chain([
      { id: 't1', type: 'userTask', name: 'Check claim', role: 'Experte XY', system: 'SAP' },
      { id: 't2', type: 'serviceTask', name: 'Book payment', role: 'Buchhaltung', system: 'SAP FI' },
    ]);
    const a = await runPipeline(plain);
    const b = await runPipeline(tagged);
    expect(b.svg).toBe(a.svg);
    const di = (xml) => xml.slice(xml.indexOf('<bpmndi:BPMNDiagram'));
    expect(di(b.bpmnXml)).toBe(di(a.bpmnXml));
  });
});

describe('foreign role forms are not read (parked: "Import-Modus")', () => {
  const wrap = (resources, taskBody) => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="http://x">
  ${resources}
  <bpmn:process id="P">
    <bpmn:startEvent id="s"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:userTask id="t" name="T"><bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>${taskBody}</bpmn:userTask>
    <bpmn:endEvent id="e"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="t" />
    <bpmn:sequenceFlow id="f2" sourceRef="t" targetRef="e" />
  </bpmn:process>
</bpmn:definitions>`;
  const R = '<bpmn:resource id="R1" name="Clerk" /><bpmn:resource id="R2" name="Lead" /><bpmn:resource id="R0" />';
  const ref = (id) => `<bpmn:resourceRef>${id}</bpmn:resourceRef>`;

  const CASES = [
    ['several performers', `<bpmn:performer>${ref('R1')}</bpmn:performer><bpmn:performer>${ref('R2')}</bpmn:performer>`],
    ['a resourceAssignmentExpression', `<bpmn:humanPerformer>${ref('R1')}<bpmn:resourceAssignmentExpression><bpmn:formalExpression>x</bpmn:formalExpression></bpmn:resourceAssignmentExpression></bpmn:humanPerformer>`],
    ['a nameless resource', `<bpmn:performer>${ref('R0')}</bpmn:performer>`],
    ['a potentialOwner', `<bpmn:potentialOwner>${ref('R1')}</bpmn:potentialOwner>`],
  ];

  test.each(IMPORTERS)('%s importer reads the single named performer', async (_n, read) => {
    const back = await read(wrap(R, `<bpmn:performer>${ref('R1')}</bpmn:performer>`));
    expect(findNode(back.nodes, 't').role).toBe('Clerk');
  });

  test('legacy importer keeps an out-of-range character reference in a resource name as written', async () => {
    const back = bpmnToLogicCoreLegacy(wrap('<bpmn:resource id="R9" name="A &#99999999; B" />', `<bpmn:performer>${ref('R9')}</bpmn:performer>`));
    expect(findNode((await back).nodes, 't').role).toBe('A &#99999999; B');
  });

  for (const [label, body] of CASES) {
    test.each(IMPORTERS)(`%s importer: ${label} → no role`, async (_n, read) => {
      const back = await read(wrap(R, body));
      expect(findNode(back.nodes, 't').role).toBeUndefined();
    });
  }
});
