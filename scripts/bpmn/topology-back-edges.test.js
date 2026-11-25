/**
 * Back edges (DFS): findBackEdges returns the edge objects that point to a node on the current
 * DFS path. The rework-loop metric counts them with restartFromUnvisited: false, and the lane
 * inheritance rule uses the default and excludes them.
 *
 * The reference below is today's countBackEdges from optimize.js, copied verbatim before the
 * metric was rewired onto findBackEdges. The metric must keep returning exactly its numbers.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBackEdges } from './topology.js';
import { runOptimizationAnalysis } from './optimize.js';

// ---- Reference: verbatim copy of countBackEdges (and its `out` helper) from optimize.js ----
const out = (edges) => { const m = {}; for (const e of edges) (m[e.source] ??= []).push(e); return m; };

// Rework loops ≈ back edges (DFS): edges pointing to an ancestor on the current stack.
function countBackEdgesReference(nodes, edges) {
  const outMap = out(edges);
  const starts = nodes.filter(n => n.type === 'startEvent').map(n => n.id);
  const roots = starts.length ? starts : (nodes[0] ? [nodes[0].id] : []);
  const state = {}; // 0=unvisited,1=on-stack,2=done
  let back = 0;
  const dfs = (id) => {
    state[id] = 1;
    for (const e of (outMap[id] || [])) {
      const t = e.target;
      if (state[t] === 1) back++;
      else if (!state[t]) dfs(t);
    }
    state[id] = 2;
  };
  for (const r of roots) if (!state[r]) dfs(r);
  return back;
}
// ---- end of reference ----

const fixturesRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const fixtureFiles = readdirSync(fixturesRoot).filter(f => f.endsWith('.json')).sort();
const loadFixture = (file) => JSON.parse(readFileSync(resolve(fixturesRoot, file), 'utf8'));
const processesOf = (lc) => (lc.pools ? lc.pools : [lc]);
const referenceCount = (proc) => countBackEdgesReference(proc.nodes || [], proc.edges || []);

const start = (id) => ({ id, type: 'startEvent' });
const task = (id) => ({ id, type: 'task' });
const flow = (source, target) => ({ source, target });

describe('findBackEdges', () => {
  test('a loop a→b→c→b returns exactly the edge c→b', () => {
    const nodes = [start('s'), task('a'), task('b'), task('c')];
    const ab = flow('a', 'b'), bc = flow('b', 'c'), cb = flow('c', 'b');
    const edges = [flow('s', 'a'), ab, bc, cb];
    const result = findBackEdges(nodes, edges);
    expect(result.size).toBe(1);
    expect(result.has(cb)).toBe(true);
  });

  test('a self-loop is a back edge', () => {
    const aa = flow('a', 'a');
    const result = findBackEdges([start('s'), task('a')], [flow('s', 'a'), aa]);
    expect([...result]).toEqual([aa]);
  });

  test('without a start event the roots are nodes[0] only', () => {
    const nodes = [task('p'), task('a'), task('b')];
    const edges = [flow('a', 'b'), flow('b', 'a')];
    expect(findBackEdges(nodes, edges, { restartFromUnvisited: false }).size).toBe(0);
    expect(findBackEdges(nodes, edges).size).toBe(1);
    const rootedAtA = [task('a'), task('b')];
    const ba = flow('b', 'a');
    expect([...findBackEdges(rootedAtA, [flow('a', 'b'), ba], { restartFromUnvisited: false })]).toEqual([ba]);
  });

  test('an unreachable cycle is found only with restartFromUnvisited', () => {
    const nodes = [start('s'), task('a'), task('x'), task('y')];
    const yx = flow('y', 'x');
    const edges = [flow('s', 'a'), flow('x', 'y'), yx];
    expect(findBackEdges(nodes, edges, { restartFromUnvisited: false }).size).toBe(0);
    const result = findBackEdges(nodes, edges);
    expect(result.size).toBe(1);
    expect(result.has(yx)).toBe(true);
  });

  test('two parallel edges c→b are both returned', () => {
    const nodes = [start('s'), task('b'), task('c')];
    const first = flow('c', 'b'), second = flow('c', 'b');
    const edges = [flow('s', 'b'), flow('b', 'c'), first, second];
    const result = findBackEdges(nodes, edges);
    expect(result.size).toBe(2);
    expect(result.has(first)).toBe(true);
    expect(result.has(second)).toBe(true);
  });
});

describe('reworkLoops unchanged', () => {
  const fixtureFilesWithLoops = fixtureFiles.filter(f => processesOf(loadFixture(f)).some(p => referenceCount(p) > 0));

  test('the fixtures contain back edges to check against', () => {
    expect(fixtureFilesWithLoops.length).toBeGreaterThan(0);
  });

  test.each(fixtureFiles)('%s: metric equals the reference for the whole model', (file) => {
    const lc = loadFixture(file);
    const expected = processesOf(lc).reduce((sum, p) => sum + referenceCount(p), 0);
    expect(runOptimizationAnalysis(lc).metrics.reworkLoops).toBe(expected);
  });

  test.each(fixtureFiles)('%s: metric equals the reference for each process', (file) => {
    const lc = loadFixture(file);
    processesOf(lc).forEach((proc, i) => {
      const single = processesOf(loadFixture(file))[i];
      expect(runOptimizationAnalysis(single).metrics.reworkLoops).toBe(referenceCount(proc));
    });
  });
});
