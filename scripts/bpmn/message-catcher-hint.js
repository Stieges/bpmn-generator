/**
 * H17: a message catcher no message flow arrives at, in a model with more than one participant.
 *
 * A catcher is a start event, an intermediate catch event or a boundary event whose marker is
 * `message`, or a receive task. The marker is the one the writer writes (`resolvedMarkerOf`: the
 * explicit `marker`, else the `_marker` runPipeline resolved, else the legacy inference), so the
 * hint matches the `messageEventDefinition` in the XML. Every level counts, an event subprocess
 * start and a catcher inside a subprocess included. A participant is an expanded pool or a
 * collapsed (black box) pool; a model with one participant gets nothing. Only a message flow whose
 * `target` is the catcher's own id counts as incoming: a flow that ends at the enclosing
 * subprocess or pool does not start the catcher.
 */
import { resolvedMarkerOf } from './icons.js';
import { isEvent } from './types.js';

// The events that throw; every other event is a catcher (start, intermediate catch, boundary).
const THROWING = new Set(['endEvent', 'intermediateThrowEvent']);

const KIND = {
  startEvent: 'message start event',
  intermediateCatchEvent: 'message catch event',
  boundaryEvent: 'message boundary event',
  receiveTask: 'receive task',
};

function isMessageCatcher(node) {
  if (node.type === 'receiveTask') return true;
  return isEvent(node.type) && !THROWING.has(node.type) && resolvedMarkerOf(node) === 'message';
}

/** One H17 per message catcher without an incoming message flow, in document order. */
export function messageCatcherHints(lc) {
  const pools = lc.pools && lc.pools.length > 0 ? lc.pools : [lc];
  if (pools.length + (lc.collapsedPools || []).length < 2) return [];
  const targets = new Set((lc.messageFlows || []).map((mf) => mf.target));
  const hints = [];
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (isMessageCatcher(node) && !targets.has(node.id)) {
        const named = typeof node.name === 'string' && node.name !== '' ? ` ("${node.name}")` : '';
        hints.push({
          code: 'H17',
          message: `The ${KIND[node.type]} "${node.id}"${named} waits for a message, but no message flow arrives at it. Draw the message flow from the sender to it, ${node.type === 'receiveTask' ? 'or make it a plain task' : 'or remove the message marker'}.`,
          elements: [node.id],
        });
      }
      walk(node.nodes);
    }
  };
  for (const pool of pools) walk(pool.nodes);
  return hints;
}
