/**
 * orthogonal-router.js — obstacle-aware orthogonal pathfinding.
 *
 * Used as a fallback candidate source inside edge-simplify.js's
 * `repairCrossings`, invoked only when its bounded candidate search
 * (L-shapes, offset Z-shapes, offset staircases — all fixed shapes around
 * the direct source-target line) fails to find a route that clears a
 * crossing. In a congested local cluster, every one of those fixed shapes
 * can be blocked while an around-the-cluster path still exists; finding
 * that path needs real search, not more shapes.
 *
 * Endpoints are always fixed — this module never re-derives a clip point.
 * That is the geometry-contract rule (see coordinates.js's own header):
 * endpoint clipping happens in exactly one place, and this module is not it.
 *
 * Algorithm: the standard "trellis"/extended-lines technique for orthogonal
 * connector routing. Build a sparse coordinate grid from every obstacle's
 * boundary lines plus the two fixed endpoints (not a dense pixel grid),
 * connect axis-adjacent grid points whose segment is obstacle-clear, and run
 * Dijkstra with a per-bend cost penalty and a soft penalty for crossing
 * another edge's current route. Grid state includes the incoming travel
 * direction, not just position — without it, bend cost is undefined (the
 * same grid point can be reached from different directions with different
 * follow-on costs) and arriving at the target from the wrong side cannot be
 * told apart from arriving correctly.
 *
 * This module deliberately duplicates edge-simplify.js's segment/box
 * clearance test rather than importing it: edge-simplify.js calls INTO this
 * module as its fallback candidate source, so importing back would be
 * circular.
 */

const PAD = 12; // px clearance kept around every hard obstacle when building the grid

function segClearOfBox(a, b, box, pad = 4) {
  const x1 = box.x - pad, y1 = box.y - pad, x2 = box.x + box.w + pad, y2 = box.y + box.h + pad;
  const loX = Math.min(a.x, b.x), hiX = Math.max(a.x, b.x);
  const loY = Math.min(a.y, b.y), hiY = Math.max(a.y, b.y);
  if (hiX <= x1 || loX >= x2) return true;
  if (hiY <= y1 || loY >= y2) return true;
  return false;
}

function orient(a, b, c) {
  const v = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  return Math.abs(v) < 1e-9 ? 0 : (v > 0 ? 1 : 2);
}
function onSeg(a, b, c) {
  return Math.min(a.x, b.x) - 1e-6 <= c.x && c.x <= Math.max(a.x, b.x) + 1e-6
      && Math.min(a.y, b.y) - 1e-6 <= c.y && c.y <= Math.max(a.y, b.y) + 1e-6;
}
export function segsIntersect(p1, p2, p3, p4) {
  const o1 = orient(p1, p2, p3), o2 = orient(p1, p2, p4);
  const o3 = orient(p3, p4, p1), o4 = orient(p3, p4, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSeg(p1, p2, p3)) || (o2 === 0 && onSeg(p1, p2, p4))
      || (o3 === 0 && onSeg(p3, p4, p1)) || (o4 === 0 && onSeg(p3, p4, p2));
}

const DIRS = ['up', 'down', 'left', 'right'];
const DIRV = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const NO_DIR = 4; // "no incoming direction yet" — the start state

// Binary min-heap keyed by (cost, ix, iy, dirIndex), in that priority order —
// exact numeric fields, no traversal-order dependence, so results are
// byte-stable across runs.
function cmpState(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  if (a[2] !== b[2]) return a[2] - b[2];
  return a[3] - b[3];
}
class MinHeap {
  constructor(cmp) { this.data = []; this.cmp = cmp; }
  get size() { return this.data.length; }
  push(item) {
    const d = this.data;
    d.push(item);
    let i = d.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(d[i], d[p]) < 0) { [d[i], d[p]] = [d[p], d[i]]; i = p; } else break;
    }
  }
  pop() {
    const d = this.data;
    const top = d[0];
    const last = d.pop();
    if (d.length) {
      d[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let smallest = i;
        if (l < d.length && this.cmp(d[l], d[smallest]) < 0) smallest = l;
        if (r < d.length && this.cmp(d[r], d[smallest]) < 0) smallest = r;
        if (smallest === i) break;
        [d[i], d[smallest]] = [d[smallest], d[i]];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * @param {{x:number,y:number}} start fixed endpoint — never re-derived
 * @param {'up'|'down'|'left'|'right'} startDir the first move must leave in this direction
 * @param {{x:number,y:number}} end fixed endpoint — never re-derived
 * @param {'up'|'down'|'left'|'right'} endDir the path must arrive travelling in this direction
 * @param {{x:number,y:number,w:number,h:number}[]} obstacles hard obstacles (node boxes) — a
 *   grid segment through one is never generated
 * @param {object} [opts]
 * @param {{x:number,y:number}[][]} [opts.softObstacles] other edges' current routes — crossing
 *   one is allowed but costed, so a route is still found when one geometrically exists but every
 *   option shares space with another edge
 * @param {number} [opts.bendPenalty=60]
 * @param {number} [opts.crossPenalty=200]
 * @param {number} [opts.maxGridPoints=4000] safety cap on the grid size, checked per attempt
 *   AFTER the margin restriction below — capping the unclipped (2N+2)² grid would silently
 *   disable the router on exactly the large diagrams it is most needed for
 * @param {number[]} [opts.margins=[140,400,900]] escalating search-region margins (px) around
 *   the endpoints' bounding box; each is tried in turn until one finds a path or all are exhausted
 * @returns {{x:number,y:number}[]|null} minimal orthogonal waypoint list, or null if no path
 *   was found within any attempted margin
 */
export function routeAroundObstacles(start, startDir, end, endDir, obstacles, opts = {}) {
  const bendPenalty = opts.bendPenalty ?? 60;
  const crossPenalty = opts.crossPenalty ?? 200;
  const maxGridPoints = opts.maxGridPoints ?? 4000;
  const soft = opts.softObstacles ?? [];
  const margins = opts.margins ?? [140, 400, 900];

  for (const margin of margins) {
    const res = attempt(start, startDir, end, endDir, obstacles, soft, margin, bendPenalty, crossPenalty, maxGridPoints);
    if (res) return res;
  }
  return null;
}

function attempt(start, startDir, end, endDir, obstacles, soft, margin, bendPenalty, crossPenalty, maxGridPoints) {
  const minX = Math.min(start.x, end.x) - margin, maxX = Math.max(start.x, end.x) + margin;
  const minY = Math.min(start.y, end.y) - margin, maxY = Math.max(start.y, end.y) + margin;

  const xsSet = new Set([start.x, end.x]);
  const ysSet = new Set([start.y, end.y]);
  for (const b of obstacles) {
    for (const x of [b.x - PAD, b.x + b.w + PAD]) if (x >= minX && x <= maxX) xsSet.add(x);
    for (const y of [b.y - PAD, b.y + b.h + PAD]) if (y >= minY && y <= maxY) ysSet.add(y);
  }
  const xs = [...xsSet].sort((a, b) => a - b);
  const ys = [...ysSet].sort((a, b) => a - b);
  if (xs.length * ys.length > maxGridPoints) return null;

  const gridKey = (ix, iy) => ix * ys.length + iy;
  const clearOfNodes = (a, b) => obstacles.every((o) => segClearOfBox(a, b, o));
  const softCrossings = (a, b) => {
    let n = 0;
    for (const poly of soft) {
      for (let i = 0; i < poly.length - 1; i++) {
        if (segsIntersect(a, b, poly[i], poly[i + 1])) n++;
      }
    }
    return n;
  };

  const six = xs.indexOf(start.x), siy = ys.indexOf(start.y);
  const eix = xs.indexOf(end.x), eiy = ys.indexOf(end.y);
  if (six < 0 || siy < 0 || eix < 0 || eiy < 0) return null;

  const stateKey = (ix, iy, dirIdx) => gridKey(ix, iy) * 5 + dirIdx;
  const dist = new Map();
  const prev = new Map();
  const startKey = stateKey(six, siy, NO_DIR);
  dist.set(startKey, 0);

  const heap = new MinHeap(cmpState);
  heap.push([0, six, siy, NO_DIR]);

  let bestKey = null;
  while (heap.size) {
    const [cost, ix, iy, dirIdx] = heap.pop();
    const sk = stateKey(ix, iy, dirIdx);
    if (cost > (dist.get(sk) ?? Infinity)) continue; // stale queue entry

    if (ix === eix && iy === eiy) {
      if (DIRS[dirIdx] === endDir) { bestKey = sk; break; }
      continue; // reached the target grid point from the wrong side — keep searching
    }

    for (let d = 0; d < DIRS.length; d++) {
      const dir = DIRS[d];
      if (dirIdx === NO_DIR && dir !== startDir) continue; // first move is constrained
      const [dx, dy] = DIRV[dir];
      const nix = ix + dx, niy = iy + dy;
      if (nix < 0 || nix >= xs.length || niy < 0 || niy >= ys.length) continue;
      const a = { x: xs[ix], y: ys[iy] };
      const b = { x: xs[nix], y: ys[niy] };
      if (!clearOfNodes(a, b)) continue;
      const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      const bend = (dirIdx !== NO_DIR && dirIdx !== d) ? bendPenalty : 0;
      const cross = softCrossings(a, b) * crossPenalty;
      const nc = cost + len + bend + cross;
      const nk = stateKey(nix, niy, d);
      if (nc < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nc);
        prev.set(nk, sk);
        heap.push([nc, nix, niy, d]);
      }
    }
  }
  if (bestKey === null) return null;

  const pts = [];
  let cur = bestKey;
  while (cur !== startKey) {
    const gridIdx = Math.floor(cur / 5);
    const iy = gridIdx % ys.length;
    const ix = (gridIdx - iy) / ys.length;
    pts.push({ x: xs[ix], y: ys[iy] });
    cur = prev.get(cur);
  }
  pts.push(start);
  pts.reverse();

  // Collapse collinear interior points into minimal waypoints.
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = out[out.length - 1], c = pts[i], n = pts[i + 1];
    const d1 = [Math.sign(c.x - p.x), Math.sign(c.y - p.y)];
    const d2 = [Math.sign(n.x - c.x), Math.sign(n.y - c.y)];
    if (d1[0] !== d2[0] || d1[1] !== d2[1]) out.push(c);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
