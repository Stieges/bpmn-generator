/**
 * H17: a message start event, message catch event, message boundary event or receive task that no
 * message flow arrives at, in a model with more than one participant (expanded or black-box pool).
 */

import { describe, test, expect } from '@jest/globals';
import { runPipeline } from './pipeline.js';

const h17 = (r) => r.validation.hints.filter((h) => h.code === 'H17');
const ids = (r) => h17(r).flatMap((h) => h.elements);

const seq = (nodes) => nodes.slice(1).map((n, i) => ({ id: `f_${nodes[i].id}_${n.id}`, source: nodes[i].id, target: n.id }));

/** Pool A sends nothing by itself; pool B holds the catcher under test. */
function twoPools(catcherNodes, messageFlows = []) {
  const a = [
    { id: 'a_s', type: 'startEvent', name: 'Case received' },
    { id: 'a_t', type: 'userTask', name: 'Check case' },
    { id: 'a_e', type: 'endEvent', name: 'Case closed' },
  ];
  return {
    pools: [
      { id: 'Pool_A', name: 'Sender', nodes: a, edges: seq(a) },
      { id: 'Pool_B', name: 'Receiver', nodes: catcherNodes.nodes, edges: catcherNodes.edges },
    ],
    messageFlows,
  };
}

const startMessage = () => {
  const nodes = [
    { id: 'b_s', type: 'startEvent', name: 'Order received', marker: 'message' },
    { id: 'b_t', type: 'userTask', name: 'Process order' },
    { id: 'b_e', type: 'endEvent', name: 'Order processed' },
  ];
  return { nodes, edges: seq(nodes) };
};
const catchMessage = () => {
  const nodes = [
    { id: 'b_s', type: 'startEvent', name: 'Order placed' },
    { id: 'b_c', type: 'intermediateCatchEvent', name: 'Reply arrived', marker: 'message' },
    { id: 'b_e', type: 'endEvent', name: 'Order closed' },
  ];
  return { nodes, edges: seq(nodes) };
};
const boundaryMessage = () => {
  const nodes = [
    { id: 'b_s', type: 'startEvent', name: 'Order placed' },
    { id: 'b_t', type: 'userTask', name: 'Process order' },
    { id: 'b_e', type: 'endEvent', name: 'Order closed' },
    { id: 'b_x', type: 'boundaryEvent', name: 'Cancellation arrived', attachedTo: 'b_t', marker: 'message' },
    { id: 'b_ex', type: 'endEvent', name: 'Order cancelled' },
  ];
  return { nodes, edges: [...seq(nodes.slice(0, 3)), { id: 'f_x', source: 'b_x', target: 'b_ex' }] };
};
const receiveTask = () => {
  const nodes = [
    { id: 'b_s', type: 'startEvent', name: 'Order placed' },
    { id: 'b_r', type: 'receiveTask', name: 'Receive confirmation' },
    { id: 'b_e', type: 'endEvent', name: 'Order closed' },
  ];
  return { nodes, edges: seq(nodes) };
};

const CASES = [['message start event', startMessage, 'b_s'], ['message catch event', catchMessage, 'b_c'],
  ['message boundary event', boundaryMessage, 'b_x'], ['receive task', receiveTask, 'b_r']];

describe('H17 positives', () => {
  test.each(CASES)('%s without an incoming message flow', async (kind, build, id) => {
    const r = await runPipeline(twoPools(build()));
    expect(h17(r)).toEqual([{
      code: 'H17',
      message: expect.stringContaining(`The ${kind} "${id}"`),
      elements: [id],
    }]);
    expect(h17(r)[0].message).toContain('no message flow arrives at it');
    expect(r.validation.errors).toEqual([]);
  }, 30_000);

  test('the name is quoted when there is one', async () => {
    const r = await runPipeline(twoPools(catchMessage()));
    expect(h17(r)[0].message).toBe('The message catch event "b_c" ("Reply arrived") waits for a message, but no message flow arrives at it. Draw the message flow from the sender to it, or remove the message marker.');
  }, 30_000);

  test('a receive task is told to become a plain task, an event to lose its marker', async () => {
    const t = await runPipeline(twoPools(receiveTask()));
    expect(h17(t)[0].message).toMatch(/, or make it a plain task\.$/);
    expect(h17(t)[0].message).not.toContain('message marker');
  }, 30_000);

  test('H17 comes after H16', async () => {
    const m = twoPools(receiveTask());
    m.pools[0].nodes[1].name = 'Verylongwordthatdoesnotfitanywhereontheline';
    const r = await runPipeline(m);
    expect(r.validation.hints.map((h) => h.code)).toEqual(['H16', 'H17']);
  }, 30_000);

  test('a receive task in a pool next to a black box only is reported', async () => {
    const m = { ...receiveTask(), id: 'P', name: 'Receiver', collapsedPools: [{ id: 'Pool_X', name: 'Partner' }] };
    expect(ids(await runPipeline(m))).toEqual(['b_r']);
  }, 30_000);

  test('a catcher in a subprocess, and an event subprocess start, are reported', async () => {
    const inner = [
      { id: 'i_s', type: 'startEvent', name: 'Inner start' },
      { id: 'i_c', type: 'intermediateCatchEvent', name: 'Inner reply', marker: 'message' },
      { id: 'i_e', type: 'endEvent', name: 'Inner end' },
    ];
    const evs = [
      { id: 'v_s', type: 'startEvent', name: 'Change arrived', marker: 'message', isInterrupting: false },
      { id: 'v_t', type: 'userTask', name: 'Apply change' },
      { id: 'v_e', type: 'endEvent', name: 'Change applied' },
    ];
    const nodes = [
      { id: 'b_s', type: 'startEvent', name: 'Order placed' },
      { id: 'b_sub', type: 'subProcess', name: 'Handle order', nodes: inner, edges: seq(inner) },
      { id: 'b_ev', type: 'subProcess', name: 'Handle change', triggeredByEvent: true, nodes: evs, edges: seq(evs) },
      { id: 'b_e', type: 'endEvent', name: 'Order closed' },
    ];
    const r = await runPipeline(twoPools({ nodes, edges: seq([nodes[0], nodes[1], nodes[3]]) }));
    expect(ids(r).sort()).toEqual(['i_c', 'v_s']);
  }, 30_000);
});

describe('H17 negatives', () => {
  test.each(CASES)('%s with an incoming message flow', async (_kind, build, id) => {
    const r = await runPipeline(twoPools(build(), [{ id: 'm1', source: 'a_t', target: id }]));
    expect(h17(r)).toEqual([]);
  }, 30_000);

  test('a flow that ends at the pool does not count', async () => {
    const r = await runPipeline(twoPools(startMessage(), [{ id: 'm1', source: 'a_t', target: 'Pool_B' }]));
    expect(ids(r)).toEqual(['b_s']);
  }, 30_000);

  test('a single participant gets nothing', async () => {
    const nodes = [
      { id: 's', type: 'startEvent', name: 'Order received', marker: 'message' },
      { id: 'c', type: 'intermediateCatchEvent', name: 'Reply arrived', marker: 'message' },
      { id: 'r', type: 'receiveTask', name: 'Receive confirmation' },
      { id: 'e', type: 'endEvent', name: 'Order closed' },
    ];
    const r = await runPipeline({ id: 'P', name: 'Order', nodes, edges: seq(nodes) });
    expect(h17(r)).toEqual([]);
  }, 30_000);

  test('a throwing event and a send task are not catchers', async () => {
    const b = [
      { id: 'b_s', type: 'startEvent', name: 'Order placed' },
      { id: 'b_t', type: 'sendTask', name: 'Send order' },
      { id: 'b_x', type: 'intermediateThrowEvent', name: 'Notice sent', marker: 'message' },
      { id: 'b_e', type: 'endEvent', name: 'Done', marker: 'message' },
    ];
    expect(h17(await runPipeline(twoPools({ nodes: b, edges: seq(b) })))).toEqual([]);
  }, 30_000);

  test('a timer start is not a message catcher', async () => {
    const b = [
      { id: 'b_s', type: 'startEvent', name: 'Month begins', marker: 'timer' },
      { id: 'b_e', type: 'endEvent', name: 'Done' },
    ];
    expect(h17(await runPipeline(twoPools({ nodes: b, edges: seq(b) })))).toEqual([]);
  }, 30_000);
});

describe('H17 with a black-box partner', () => {
  const model = (flows) => ({
    id: 'P', name: 'Receiver',
    ...startMessage(),
    collapsedPools: [{ id: 'Pool_X', name: 'Customer' }],
    messageFlows: flows,
  });
  test('the catcher is reported when no flow arrives, also with a flow to the black box', async () => {
    expect(ids(await runPipeline(model([{ id: 'm1', source: 'b_t', target: 'Pool_X' }])))).toEqual(['b_s']);
  }, 30_000);
  test('a flow from the black box to the catcher silences it', async () => {
    expect(ids(await runPipeline(model([{ id: 'm1', source: 'Pool_X', target: 'b_s' }])))).toEqual([]);
  }, 30_000);
});
