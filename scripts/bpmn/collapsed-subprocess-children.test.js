/**
 * A collapsed subprocess that still carries its children: the children are not drawn, so they
 * have no coords, but their flows are in the flattened edge list. The same-lane chain align's
 * route rebuild read `.x` of their missing shapes and threw — every such model crashed.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './pipeline.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');

function withCollapsedChildren(name) {
  const lc = JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
  const proc = lc.pools ? lc.pools[0] : lc;
  const task = proc.nodes.find((n) => /Task$/.test(n.type));
  Object.assign(task, {
    type: 'subProcess', isExpanded: false,
    nodes: [{ id: `${task.id}_s`, type: 'startEvent', name: 'Start' }, { id: `${task.id}_e`, type: 'endEvent', name: 'End' }],
    edges: [{ id: `${task.id}_f`, source: `${task.id}_s`, target: `${task.id}_e` }],
  });
  return { lc, id: task.id };
}

describe('collapsed subprocess with children', () => {
  for (const name of ['simple-approval.json', 'example-kreditantrag.json', 'realistic-collaboration.json']) {
    test(`${name}: lays out, children stay undrawn`, async () => {
      const { lc, id } = withCollapsedChildren(name);
      const r = await runPipeline(lc);
      expect(r.coordMap).toBeTruthy();
      expect(r.coordMap.coords[id]).toBeTruthy();
      expect(r.coordMap.coords[`${id}_s`]).toBeUndefined();
      expect(r.coordMap.edgeCoords[`${id}_f`]).toBeUndefined();
    }, 30000);
  }
});
