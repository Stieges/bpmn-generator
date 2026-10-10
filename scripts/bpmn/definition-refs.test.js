/**
 * Issue #53 — an event (or send/receive task) names its top-level definition by id.
 *
 * Before: `buildTopLevelDefinitions` keyed definitions by TYPE, so with two messages every message
 * event pointed at the last one. Now `messageRef` / `signalRef` / `errorRef` / `escalationRef`
 * select the definition; S16 reports a reference that cannot be honoured, S17 an ambiguity that
 * makes the writer emit no reference at all.
 */
import { describe, test, expect } from '@jest/globals';
import { runPipeline } from './pipeline.js';
import { runRules } from './rules.js';
import { bpmnToLogicCore, bpmnToLogicCoreLegacy } from './import.js';

const proc = (nodes, definitions, extraEdges = []) => ({
  id: 'p', name: 'P',
  definitions,
  nodes,
  edges: [{ source: nodes[0].id, target: nodes[1].id }, { source: nodes[1].id, target: nodes[2].id }, ...extraEdges],
});

const TWO_MSG = [
  { type: 'message', id: 'Msg_Order', name: 'OrderReceived' },
  { type: 'message', id: 'Msg_Pay', name: 'PaymentConfirmed' },
];

const twoMessageModel = (withRefs) => proc([
  { id: 's', type: 'startEvent', marker: 'message', name: 'Order received', ...(withRefs ? { messageRef: 'Msg_Order' } : {}) },
  { id: 'w', type: 'intermediateCatchEvent', marker: 'message', name: 'Payment confirmed', ...(withRefs ? { messageRef: 'Msg_Pay' } : {}) },
  { id: 'e', type: 'endEvent', name: 'Done' },
], TWO_MSG);

const refsIn = (xml, prop) => [...xml.matchAll(new RegExp(`${prop}="([^"]*)"`, 'g'))].map((m) => m[1]);
const about = (list, field) => list.filter((m) => m.includes(field));

describe('#53 reproduction — two message definitions, two message events', () => {
  test('with messageRef set, each event definition references its own message', async () => {
    const r = await runPipeline(twoMessageModel(true));
    expect(r.validation.errors).toEqual([]);
    expect(refsIn(r.bpmnXml, 'messageRef')).toEqual(['Msg_Order', 'Msg_Pay']);
    expect(about(r.validation.warnings, 'messageRef')).toEqual([]);
  });

  test('without the field, no reference is emitted (never "the last one") and S17 fires once per event', async () => {
    const r = await runPipeline(twoMessageModel(false));
    expect(refsIn(r.bpmnXml, 'messageRef')).toEqual([]);
    const s17 = about(r.validation.warnings, 'messageRef');
    expect(s17).toHaveLength(2);
    expect(s17[0]).toContain('"s"');
    expect(s17[0]).toContain('Msg_Order');
    expect(s17[0]).toContain('Msg_Pay');
    expect(s17[1]).toContain('"w"');
  });

  test('exactly one definition, no field: the reference is emitted as before, no S17', async () => {
    const r = await runPipeline(proc([
      { id: 's', type: 'startEvent', marker: 'message', name: 'Order received' },
      { id: 'w', type: 'intermediateCatchEvent', marker: 'message', name: 'Paid' },
      { id: 'e', type: 'endEvent', name: 'Done' },
    ], [TWO_MSG[0]]));
    expect(refsIn(r.bpmnXml, 'messageRef')).toEqual(['Msg_Order', 'Msg_Order']);
    expect(about(r.validation.warnings, 'messageRef')).toEqual([]);
  });

  test('no definitions at all: the implicit definition is generated as before, no S17', async () => {
    const r = await runPipeline(proc([
      { id: 's', type: 'startEvent', marker: 'message', name: 'Order received' },
      { id: 'w', type: 'intermediateCatchEvent', marker: 'message', name: 'Paid' },
      { id: 'e', type: 'endEvent', name: 'Done' },
    ], undefined));
    expect(refsIn(r.bpmnXml, 'messageRef')).toEqual(['Message_1', 'Message_1']);
    expect(about(r.validation.warnings, 'messageRef')).toEqual([]);
  });
});

describe('S16 — a *Ref that cannot be honoured is an ERROR', () => {
  const errorsFor = (node, defs = TWO_MSG) => runRules(proc([
    { id: 's', type: 'startEvent', name: 'Start' }, node, { id: 'e', type: 'endEvent', name: 'End' },
  ], [...defs, { type: 'signal', id: 'Sig_1', name: 'Alarm' }]), null).errors;

  test('a dangling id', () => {
    const errs = errorsFor({ id: 'w', type: 'intermediateCatchEvent', marker: 'message', name: 'W', messageRef: 'Msg_Nope' });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('Msg_Nope');
  });

  test('an id of the wrong definition type', () => {
    const errs = errorsFor({ id: 'w', type: 'intermediateCatchEvent', marker: 'message', name: 'W', messageRef: 'Sig_1' });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('signal');
  });

  test('a field whose marker does not match', () => {
    const errs = errorsFor({ id: 'w', type: 'intermediateCatchEvent', marker: 'signal', name: 'W', messageRef: 'Msg_Order' });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('marker');
  });

  test('a field on an event without any marker', () => {
    const errs = errorsFor({ id: 'w', type: 'intermediateCatchEvent', name: 'Wait', messageRef: 'Msg_Order' });
    expect(errs).toHaveLength(1);
  });

  test('a valid reference is clean', () => {
    expect(errorsFor({ id: 'w', type: 'intermediateCatchEvent', marker: 'message', name: 'W', messageRef: 'Msg_Order' })).toEqual([]);
  });

  test('a node class that cannot carry the field', () => {
    const errs = errorsFor({ id: 'w', type: 'userTask', name: 'Do it', messageRef: 'Msg_Order' });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('userTask');
  });

  test('reaches into subprocess children', () => {
    const lc = proc([
      { id: 's', type: 'startEvent', name: 'Start' },
      { id: 'sp', type: 'subProcess', name: 'Sub', isExpanded: true,
        nodes: [{ id: 'c', type: 'startEvent', marker: 'message', name: 'C', messageRef: 'Msg_Nope' }], edges: [] },
      { id: 'e', type: 'endEvent', name: 'End' },
    ], TWO_MSG);
    expect(runRules(lc, null).errors.some((m) => m.includes('Msg_Nope'))).toBe(true);
  });
});

describe('send/receive tasks carry messageRef as an attribute', () => {
  const model = (type) => proc([
    { id: 's', type: 'startEvent', name: 'Start' },
    { id: 't', type, name: 'Task', messageRef: 'Msg_Pay' },
    { id: 'e', type: 'endEvent', name: 'End' },
  ], TWO_MSG);

  test.each(['sendTask', 'receiveTask'])('%s: written and read back by both importers', async (type) => {
    const r = await runPipeline(model(type));
    expect(r.validation.errors).toEqual([]);
    expect(r.bpmnXml).toMatch(new RegExp(`<bpmn:${type}[^>]* messageRef="Msg_Pay"`));
    for (const lc of [await bpmnToLogicCore(r.bpmnXml), bpmnToLogicCoreLegacy(r.bpmnXml)]) {
      expect(lc.nodes.find((n) => n.id === 't').messageRef).toBe('Msg_Pay');
    }
  });

  test('a task with several messages and no field gets neither attribute nor S17', async () => {
    const lc = model('sendTask');
    delete lc.nodes[1].messageRef;
    const r = await runPipeline(lc);
    expect(refsIn(r.bpmnXml, 'messageRef')).toEqual([]);
    expect(about(r.validation.warnings, 'messageRef')).toEqual([]);
  });
});

describe('every definition kind — explicit reference round-trips through both importers', () => {
  const KINDS = [
    ['message', 'messageRef', 'intermediateCatchEvent'],
    ['signal', 'signalRef', 'intermediateCatchEvent'],
    ['error', 'errorRef', 'endEvent'],
    ['escalation', 'escalationRef', 'endEvent'],
  ];
  test.each(KINDS)('%s via %s', async (kind, field, eventType) => {
    const defs = [{ type: kind, id: `${kind}_A`, name: 'A' }, { type: kind, id: `${kind}_B`, name: 'B' }];
    const mid = eventType === 'endEvent'
      ? { id: 'x', type: 'endEvent', marker: kind, name: 'X', [field]: `${kind}_B` }
      : { id: 'x', type: eventType, marker: kind, name: 'X', [field]: `${kind}_B` };
    const lc = eventType === 'endEvent'
      ? { id: 'p', name: 'P', definitions: defs,
          nodes: [{ id: 's', type: 'startEvent', name: 'S' }, { id: 't', type: 'userTask', name: 'T' }, mid],
          edges: [{ source: 's', target: 't' }, { source: 't', target: 'x' }] }
      : proc([{ id: 's', type: 'startEvent', name: 'S' }, mid, { id: 'e', type: 'endEvent', name: 'E' }], defs);
    const r = await runPipeline(lc);
    expect(r.validation.errors).toEqual([]);
    expect(refsIn(r.bpmnXml, field)).toEqual([`${kind}_B`]);
    for (const out of [await bpmnToLogicCore(r.bpmnXml), bpmnToLogicCoreLegacy(r.bpmnXml)]) {
      expect(out.nodes.find((n) => n.id === 'x')[field]).toBe(`${kind}_B`);
    }
  });
});

describe('collaboration: definitions live on the document, events in the pools', () => {
  test('two pools, two messages, explicit references', async () => {
    const lc = {
      definitions: TWO_MSG,
      pools: [
        { id: 'a', name: 'A', nodes: [{ id: 'a1', type: 'startEvent', marker: 'message', name: 'In', messageRef: 'Msg_Pay' }, { id: 'a2', type: 'endEvent', name: 'End' }], edges: [{ source: 'a1', target: 'a2' }] },
        { id: 'b', name: 'B', nodes: [{ id: 'b1', type: 'startEvent', marker: 'message', name: 'In', messageRef: 'Msg_Order' }, { id: 'b2', type: 'endEvent', name: 'End' }], edges: [{ source: 'b1', target: 'b2' }] },
      ],
    };
    const r = await runPipeline(lc);
    expect(r.validation.errors).toEqual([]);
    expect(refsIn(r.bpmnXml, 'messageRef')).toEqual(['Msg_Pay', 'Msg_Order']);
  });
});
