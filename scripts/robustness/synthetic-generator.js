/**
 * Synthetic data generator — produces (description, lcJson|dot) pairs via two-step LLM prompting.
 * See spec Section 4.3.
 */

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
