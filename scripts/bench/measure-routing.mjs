#!/usr/bin/env node
/**
 * measure-routing.mjs — quick routing-quality metric harness.
 *
 * For every fixture, run pipeline and report:
 *   - total bends (waypoint count - 2 * edges, since first+last are endpoints)
 *   - average bends per edge
 *   - max bends on any single edge
 *   - edge crossings (CCW intersection scan)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', '..', 'tests', 'fixtures');

function ccw(A, B, C) { return (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x); }
function segIx(p1, p2, p3, p4) {
  return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
}
function edgeCrossings(coords) {
  const edges = Object.values(coords.edgeCoords || {});
  let cs = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i], b = edges[j];
      for (let p = 0; p < a.length - 1; p++)
        for (let q = 0; q < b.length - 1; q++)
          if (segIx(a[p], a[p+1], b[q], b[q+1])) { cs++; p = a.length; break; }
    }
  }
  return cs;
}

const results = [];
const fixtures = readdirSync(fixturesDir).filter(f => f.endsWith('.json')).sort();
for (const f of fixtures) {
  const lc = JSON.parse(readFileSync(join(fixturesDir, f), 'utf8'));
  let r;
  try { r = await runPipeline(lc); }
  catch { results.push({ fixture: f, error: true }); continue; }
  if (!r.coordMap) { results.push({ fixture: f, error: 'unsound (no coordMap)' }); continue; }
  const edges = Object.values(r.coordMap.edgeCoords || {});
  // bends = waypoints - 2 (start + end). >=0.
  const bendsArr = edges.map(e => Math.max(0, e.length - 2));
  const totalBends = bendsArr.reduce((a,b)=>a+b, 0);
  const maxBends = Math.max(0, ...bendsArr);
  const avgBends = edges.length ? +(totalBends / edges.length).toFixed(2) : 0;
  const cs = edgeCrossings(r.coordMap);
  results.push({ fixture: f, edges: edges.length, totalBends, avgBends, maxBends, crossings: cs });
}

console.log('Fixture\tEdges\tTotalBends\tAvgBends\tMaxBends\tCrossings');
for (const r of results) {
  if (r.error) { console.log(`${r.fixture}\tERROR`); continue; }
  console.log(`${r.fixture}\t${r.edges}\t${r.totalBends}\t${r.avgBends}\t${r.maxBends}\t${r.crossings}`);
}
const tot = results.filter(r => !r.error).reduce((a,r) => ({
  edges: a.edges + r.edges, totalBends: a.totalBends + r.totalBends,
  crossings: a.crossings + r.crossings,
}), { edges: 0, totalBends: 0, crossings: 0 });
console.log(`\nTOTAL\t${tot.edges}\t${tot.totalBends}\t${(tot.totalBends/tot.edges).toFixed(2)}\t-\t${tot.crossings}`);
