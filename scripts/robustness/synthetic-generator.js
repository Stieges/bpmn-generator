/**
 * Synthetic data generator — produces (description, lcJson|dot) pairs via two-step LLM prompting.
 * See spec Section 4.3.
 */

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleCells(cells, { n, strategy = 'uniform', seed = Date.now(), filter = null } = {}) {
  const pool = filter ? cells.filter(filter) : cells.slice();
  if (n >= pool.length) return pool;

  const rand = mulberry32(seed);
  const picked = [];
  const remaining = pool.slice();
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rand() * remaining.length);
    picked.push(remaining.splice(idx, 1)[0]);
  }
  return picked;
}

export function enumerateCells(catalog) {
  const cells = [];
  for (const domain of catalog.domains) {
    for (const complexity of Object.keys(catalog.complexity)) {
      for (const pattern of catalog.patterns) {
        for (const stress_mode of catalog.stress_modes) {
          cells.push({ domain, complexity, pattern, stress_mode });
        }
      }
    }
  }
  return cells;
}
