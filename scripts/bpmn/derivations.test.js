/**
 * applyDerivations — elements a view adds to the output without changing the author's model.
 * v1 has one derivation, `joinGateways`: an explicit exclusive join in front of every
 * non-gateway node that two or more sequence flows enter.
 */
import { describe, test, expect } from '@jest/globals';
import { applyDerivations } from './derivations.js';

const n = (id, type = 'task', extra = {}) => ({ id, type, name: id, ...extra });
const e = (id, source, target) => ({ id, source, target });
const ON = { joinGateways: true };

/** s → x? → a | b → t → end: `t` has two incoming flows (fa, fb). */
const mergeModel = () => ({
  id: 'p', name: 'P',
  nodes: [n('s', 'startEvent'), n('x', 'exclusiveGateway'), n('a'), n('b'), n('t'), n('end', 'endEvent')],
  edges: [e('f1', 's', 'x'), e('f2', 'x', 'a'), e('f3', 'x', 'b'), e('fa', 'a', 't'), e('fb', 'b', 't'), e('f4', 't', 'end')],
});
const incoming = (proc, id) => proc.edges.filter(x => x.target === id);

describe('applyDerivations — joinGateways', () => {
  test('a task with two incoming flows gets one join gateway in front of it', () => {
    const { lc, derived } = applyDerivations(mergeModel(), ON);
    expect(derived).toEqual([
      { kind: 'joinGateway', id: 'gw_join_t', target: 't', edge: 'flow_gw_join_t_t', process: null },
    ]);
    expect(lc.nodes.find(x => x.id === 'gw_join_t'))
      .toEqual({ id: 'gw_join_t', type: 'exclusiveGateway', has_join: true, _derived: 'joinGateway' });
    expect(incoming(lc, 't')).toEqual([e('flow_gw_join_t_t', 'gw_join_t', 't')]);
    expect(lc.edges.find(x => x.id === 'fa')).toEqual(e('fa', 'a', 'gw_join_t'));
    expect(lc.edges.find(x => x.id === 'fb')).toEqual(e('fb', 'b', 'gw_join_t'));
  });

  test('the derived flow is on the happy path when an incoming flow it gathers is', () => {
    const input = mergeModel();
    input.edges.find(x => x.id === 'fa').isHappyPath = true;
    const { lc } = applyDerivations(input, ON);
    expect(lc.edges.find(x => x.id === 'flow_gw_join_t_t'))
      .toEqual({ id: 'flow_gw_join_t_t', source: 'gw_join_t', target: 't', isHappyPath: true });
    expect(lc.edges.find(x => x.id === 'fa')).toEqual({ ...e('fa', 'a', 'gw_join_t'), isHappyPath: true });
  });

  test('without a happy-path flow among the incoming ones the derived flow carries no flag', () => {
    const { lc } = applyDerivations(mergeModel(), ON);
    expect(lc.edges.find(x => x.id === 'flow_gw_join_t_t')).not.toHaveProperty('isHappyPath');
  });

  test('the argument is not changed', () => {
    const input = mergeModel();
    const snapshot = JSON.parse(JSON.stringify(input));
    const { lc } = applyDerivations(input, ON);
    expect(input).toEqual(snapshot);
    expect(lc).not.toBe(input);
  });

  test.each([[{ joinGateways: false }], [{}], [undefined]])('derivations %p derive nothing', (derivations) => {
    const input = mergeModel();
    const { lc, derived } = applyDerivations(input, derivations);
    expect(derived).toEqual([]);
    expect(JSON.stringify(lc)).toBe(JSON.stringify(input));
  });

  test('applying it to its own output derives nothing', () => {
    const once = applyDerivations(mergeModel(), ON).lc;
    const twice = applyDerivations(once, ON);
    expect(twice.derived).toEqual([]);
    expect(twice.lc).toEqual(once);
  });

  test('an id already taken anywhere in the document gets a suffix', () => {
    const input = mergeModel();
    input.lanes = [{ id: 'gw_join_t', name: 'R1' }, { id: 'flow_gw_join_t_2_t', name: 'R2' }];
    const { derived } = applyDerivations(input, ON);
    expect(derived).toEqual([
      { kind: 'joinGateway', id: 'gw_join_t_2', target: 't', edge: 'flow_gw_join_t_2_t_2', process: null },
    ]);
  });

  test('a gateway with two incoming flows is left alone', () => {
    const input = {
      id: 'p',
      nodes: [n('s', 'startEvent'), n('x', 'exclusiveGateway'), n('a'), n('b'), n('m', 'exclusiveGateway'), n('end', 'endEvent')],
      edges: [e('f1', 's', 'x'), e('f2', 'x', 'a'), e('f3', 'x', 'b'), e('fa', 'a', 'm'), e('fb', 'b', 'm'), e('f4', 'm', 'end')],
    };
    expect(applyDerivations(input, ON).derived).toEqual([]);
  });

  test('lanes given as node.lane: the gateway takes the target\'s lane', () => {
    const input = mergeModel();
    input.lanes = [{ id: 'L1', name: 'R1' }, { id: 'L2', name: 'R2' }];
    for (const node of input.nodes) node.lane = node.id === 't' ? 'L2' : 'L1';
    const { lc } = applyDerivations(input, ON);
    expect(lc.nodes.find(x => x.id === 'gw_join_t').lane).toBe('L2');
  });

  test('lanes given as nodeIds: the gateway id lands in the list that holds the target', () => {
    const input = mergeModel();
    input.lanes = [
      { id: 'L1', name: 'R1', nodeIds: ['s', 'x', 'a', 'b'] },
      { id: 'L2', name: 'R2', children: [{ id: 'L2a', name: 'R2a', nodeIds: ['t', 'end'] }] },
    ];
    const { lc } = applyDerivations(input, ON);
    expect(lc.lanes[0].nodeIds).toEqual(['s', 'x', 'a', 'b']);
    expect(lc.lanes[1].children[0].nodeIds).toEqual(['t', 'end', 'gw_join_t']);
    expect(lc.nodes.find(x => x.id === 'gw_join_t')).not.toHaveProperty('lane');
  });

  test('a collaboration: process is the pool id, a message flow into the node does not count', () => {
    const input = {
      pools: [
        { id: 'P1', name: 'A', nodes: [n('s1', 'startEvent'), n('send', 'sendTask'), n('e1', 'endEvent')],
          edges: [e('g1', 's1', 'send'), e('g2', 'send', 'e1')] },
        { id: 'P2', name: 'B', nodes: [n('s2', 'startEvent'), n('wait'), n('t'), n('e2', 'endEvent')],
          edges: [e('h1', 's2', 't'), e('h2', 's2', 'wait'), e('h3', 'wait', 't'), e('h4', 't', 'e2')] },
        { id: 'P3', name: 'C', nodes: [n('s3', 'startEvent'), n('only'), n('e3', 'endEvent')],
          edges: [e('k1', 's3', 'only'), e('k2', 'only', 'e3')] },
      ],
      messageFlows: [{ id: 'm1', source: 'send', target: 'only' }],
    };
    const { lc, derived } = applyDerivations(input, ON);
    expect(derived).toEqual([
      { kind: 'joinGateway', id: 'gw_join_t', target: 't', edge: 'flow_gw_join_t_t', process: 'P2' },
    ]);
    expect(lc.pools[1].nodes.map(x => x.id)).toContain('gw_join_t');
    expect(lc.pools[2]).toEqual(input.pools[2]);
    expect(lc.messageFlows).toEqual(input.messageFlows);
  });

  test('children of a subprocess are not touched, but their ids count for collisions', () => {
    const sub = n('sub', 'subProcess', {
      nodes: [n('cs', 'startEvent'), n('ca'), n('cb'), n('ct'), n('gw_join_t')],
      edges: [e('c1', 'cs', 'ca'), e('c2', 'cs', 'cb'), e('c3', 'ca', 'ct'), e('c4', 'cb', 'ct')],
    });
    const input = mergeModel();
    input.nodes.splice(5, 0, sub);
    const { lc, derived } = applyDerivations(input, ON);
    expect(derived.map(d => d.id)).toEqual(['gw_join_t_2']);
    expect(lc.nodes.find(x => x.id === 'sub')).toEqual(sub);
  });
});
