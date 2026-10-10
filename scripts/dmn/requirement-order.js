/**
 * DMN requirement identity and ordering — the two derivations every requirement consumer shares.
 *
 * Dependency-free on purpose: `layout.js`, `coordinates.js`, `dmn-xml.js` and `import.js` all need
 * the same answer, and none of them may import another's module to get it (`layout.js` runs before
 * `coordinates.js` and must not depend on it).
 */

/**
 * The one place a requirement's identity is derived. `id` is optional on a Requirement
 * (references/decision-core-schema.json), so a deterministic fallback is needed — and it must be
 * derived in exactly ONE place, because two consumers depend on it agreeing:
 *
 *   - `coordinates.js` keys `edgeCoords` with it,
 *   - `dmn-xml.js` keys its requirement element map with it AND uses it as the element's `id`
 *     when the requirement carries none.
 *
 * A divergence between the two does not throw. The DMNDI writer's lookup returns undefined, the
 * edge is skipped as "no waypoints", and the diagram silently loses a connection. Mirrors
 * `messageFlowKey` in `bpmn/coordinates.js` (`mf.id || 'mf_' + ...`), prefix and all.
 *
 * @param {{id?: string, source: string, target: string}} req
 * @returns {string}
 */
export function requirementKey(req) {
  // `||`, not `??`, is deliberate: an empty-string id is not a usable identity either, and
  // should fall through to the derived key just like `undefined`/`null` do.
  return req.id || `req_${req.source}_${req.target}`;
}

/**
 * The three requirement kinds in the order DMN13.xsd sequences them inside a DRG element
 * (`informationRequirement`, then `knowledgeRequirement`, then `authorityRequirement` — the same
 * order `import.js`'s `REQUIREMENT_KINDS` walks on the way back in).
 */
const REQUIREMENT_EMIT_KINDS = ['information', 'knowledge', 'authority'];

/**
 * `dc.requirements` in the order the requirement ELEMENTS appear in the emitted document: grouped by
 * target in `dc.nodes` order, then by kind, preserving the input array's order inside each group.
 *
 * WHAT IS AND IS NOT NORMALISED. Two requirements that differ in target or in kind are placed by the
 * MODEL (`dc.nodes` order, the XSD's kind sequence), whatever order the input array holds them in.
 * Siblings that share BOTH target and kind keep the author's array order: that order is the author's
 * and is deliberately preserved (it is the order of `<informationRequirement>` children, which a
 * reader may take as meaningful). So the emitted bytes are a function of the model plus the relative
 * order of such siblings, not of the array order as a whole.
 *
 * WHY THIS EXISTS. The emitted order has to be independent of the input array's order, and until
 * Stage 5b only half of it was. The DRG half had the property by accident of nesting (`attachRequirements`
 * pushes each requirement into a per-target, per-kind collection). The DI half did not: `edgeCoords`
 * was keyed by walking `dc.requirements` flat, and `dmn-xml.js` emits `<dmndi:DMNEdge>` in that key
 * order. A third consumer, `layout.js`, feeds the requirements to ELK as its edge list, and ELK's
 * layered algorithm is sensitive to edge order, so the GEOMETRY itself depended on array order.
 *
 * All three consumers now go through this function, so they agree by construction rather than by
 * coincidence. The module is dependency-free so that `layout.js`, `coordinates.js`, `dmn-xml.js` and
 * `import.js` can all import it without a cycle or a layering violation.
 *
 * Requirements the grouping cannot place (a target that is not a declared node, an unknown `type`)
 * are appended in array order rather than dropped: neither reaches the XML, but a caller iterating
 * this instead of `dc.requirements` must not silently lose one.
 *
 * Returns the input array itself (not a copy) when it holds fewer than two entries; callers only
 * iterate it.
 *
 * @param {object} dc - Decision-Core JSON (`nodes` and `requirements`)
 * @returns {Array<object>}
 */
export function orderedRequirements(dc) {
  const requirements = dc.requirements ?? [];
  if (requirements.length < 2) return requirements;

  const byTarget = new Map();
  for (const req of requirements) {
    if (!byTarget.has(req.target)) byTarget.set(req.target, []);
    byTarget.get(req.target).push(req);
  }

  const ordered = [];
  const placed = new Set();
  for (const node of (dc.nodes ?? [])) {
    const group = byTarget.get(node.id);
    if (!group) continue;
    for (const kind of REQUIREMENT_EMIT_KINDS) {
      for (const req of group) {
        if (req.type !== kind) continue;
        ordered.push(req);
        placed.add(req);
      }
    }
  }
  for (const req of requirements) if (!placed.has(req)) ordered.push(req);
  return ordered;
}
