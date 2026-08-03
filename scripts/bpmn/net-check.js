/**
 * Petri-Net Integrity Check — post-translation sanity pass on the net `bpmnToPN` produces.
 *
 * `checkSoundness` (workflow-net.js) reasons about *markings*: it explores the state space of
 * whatever net it is handed and can prove that net has a reachable sink, but it never sees the
 * Logic-Core it came from. A translation defect — a dropped container, an edge that silently
 * failed to produce a place — therefore yields a well-formed verdict about the wrong graph. That
 * is how an expanded subprocess spent several releases being reported as a deadlocked main
 * process (WF03) with a dead end event (WF01): `bpmnToPN` had dropped the container, and
 * `checkSoundness` correctly analyzed the broken net it was given.
 *
 * This pass closes that gap, the same way `di-check.js` closed it for geometry after a class of
 * layout defects passed green validation. It checks the *translation* — does every Logic-Core
 * node have a transition, does every place get produced and consumed, are ids unique — never the
 * *model*. A process that is legitimately unsound (a real deadlock, a real dead end) must come
 * out of here clean; that is `checkSoundness` / WF01-WF03's job, not this pass's. See the
 * `deadlock-process.json` test in net-check.test.js for the fixture that pins this down.
 *
 * Findings are diagnostics, in the same shape as di-check.js's: `{ ok, issues: [{ code,
 * severity, message, elements }] }`, `ok = !issues.some(i => i.severity === 'ERROR')`.
 */

// Same set bpmnToPN (workflow-net.js) pushes to `skipped` with reason 'artifact' — these node
// types never get a transition on purpose, they don't participate in control flow. Duplicated
// here (not imported) to keep this module dependency-free, matching di-check.js's shape.
const ARTIFACT_TYPES = new Set(['dataObjectReference', 'dataStoreReference', 'textAnnotation', 'group']);

// One severity constant per code, so a later stage that fixes the underlying defect can flip a
// code from WARNING to ERROR (or vice versa) by changing one line here — nothing else in this
// file encodes severity. NC02 was WARNING until boundary events got a translation
// (`wireBoundaryEvents`, workflow-net.js): a transition with no way to fire had exactly one
// legitimate cause, and that cause is gone, so the code now says what it always meant. NC04 is
// still WARNING on purpose — two edges silently sharing one place is real, but the place-id
// scheme that causes it has not been changed yet.
const SEVERITY = {
  NC01: 'ERROR',
  NC02: 'ERROR',
  NC02b: 'ERROR',
  NC03a: 'ERROR',
  NC03b: 'ERROR',
  NC04: 'WARNING',
  NC05: 'INFO',
  NC06: 'ERROR',
};

/**
 * @param {object} pn   - a net from bpmnToPN(), or a composed net from composeCollaboration()
 * @param {object} proc - the Logic-Core process/pool the net came from (for NC01's node list
 *                        and for the element ids in the messages)
 * @param {object} [opts]
 * @param {string[]} [opts.exemptUnconsumedPlaces] - place ids the caller already accounts for.
 *        composeCollaboration's `unconsumablePlaces` (scenarios/collaboration.js) is exactly
 *        this list — a message-receiving place that a gated clone consumes only in some
 *        branches is a legitimate design, not a translation defect, and the composing caller
 *        already knows which places those are. Passed IN rather than re-derived here, for the
 *        same reason flatNodes/flatEdges travel with the net itself (workflow-net.js:198-201):
 *        identity beats agreement.
 * @returns {{ ok: boolean, issues: Array<{code, severity, message, elements}> }}
 */
export function checkNetIntegrity(pn, proc, opts = {}) {
  const exempt = new Set(opts.exemptUnconsumedPlaces || []);
  const issues = [];

  const { places, transitions, arcs, sourcePlace, sinkPlace, skipped, flatNodes, flatEdges } = pn;

  const skippedIds = new Set((skipped || []).map(s => s.id));
  const transitionsByBpmnNodeId = new Map();
  for (const [, t] of transitions) {
    if (!transitionsByBpmnNodeId.has(t.bpmnNodeId)) transitionsByBpmnNodeId.set(t.bpmnNodeId, []);
    transitionsByBpmnNodeId.get(t.bpmnNodeId).push(t);
  }

  // NC01 — a control-flow node with no transition, and not on the skip list.
  // The exact shape of the container-blindness defect: bpmnToPN's flatten step silently drops a
  // node instead of translating it, and nothing downstream ever notices because the resulting
  // net is still well-formed — just not the model's net.
  for (const n of (flatNodes || [])) {
    if (ARTIFACT_TYPES.has(n.type)) continue;
    if (skippedIds.has(n.id)) continue;
    if (!transitionsByBpmnNodeId.has(n.id)) {
      issues.push({
        code: 'NC01',
        severity: SEVERITY.NC01,
        message: `Node "${n.id}" (${n.type}) produced no transition in the Petri net.`,
        elements: [n.id],
      });
    }
  }

  // NC02 — a transition with no incoming P→T arc. getEnabledTransitions (workflow-net.js)
  // requires inputArcs.length > 0, so a transition in this state can never fire, in any
  // marking — a structural fact about the net, not a behavioural one that BFS would need to
  // discover. ERROR: the one shape that used to make this legitimate — a boundary event, whose
  // trigger is its host rather than a sequence flow — now consumes the host's own input places
  // (`wireBoundaryEvents`, workflow-net.js). A boundary event whose host cannot be found gets
  // no transition at all and is disclosed on `skipped` instead, so it does not land here.
  for (const [tId, t] of transitions) {
    const hasIncoming = arcs.some(a => a.type === 'P→T' && a.to === tId);
    if (!hasIncoming) {
      issues.push({
        code: 'NC02',
        severity: SEVERITY.NC02,
        message: `Transition "${tId}" (node "${t.bpmnNodeId}") has no incoming place — it can never fire.`,
        elements: [t.bpmnNodeId, tId],
      });
    }
  }

  // NC02b — a transition with no outgoing T→P arc: it consumes a token and destroys it. Unlike
  // NC02, there is no legitimate reason for this outside an end event (which always produces
  // into the sink place) — ERROR.
  for (const [tId, t] of transitions) {
    const hasOutgoing = arcs.some(a => a.type === 'T→P' && a.from === tId);
    if (!hasOutgoing) {
      issues.push({
        code: 'NC02b',
        severity: SEVERITY.NC02b,
        message: `Transition "${tId}" (node "${t.bpmnNodeId}") has no outgoing place — it consumes a token and never produces one.`,
        elements: [t.bpmnNodeId, tId],
      });
    }
  }

  // NC03a — a place no transition ever produces (other than the source place, whose initial
  // token is placed directly, and any place the caller already accounts for).
  // NC03b — a place no transition ever consumes (other than the sink place, and the same
  // exemptions). Together these are the "dropped container" signature: a subprocess boundary
  // vanishing from bpmnToPN's flatten leaves exactly one produced-never-consumed place on the
  // way in and one consumed-never-produced place on the way out.
  for (const [pid] of places) {
    if (pid === sourcePlace || exempt.has(pid)) continue;
    const isProduced = arcs.some(a => a.type === 'T→P' && a.to === pid);
    if (!isProduced) {
      issues.push({
        code: 'NC03a',
        severity: SEVERITY.NC03a,
        message: `Place "${pid}" is never produced by any transition.`,
        elements: [pid],
      });
    }
  }
  for (const [pid] of places) {
    if (pid === sinkPlace || exempt.has(pid)) continue;
    const isConsumed = arcs.some(a => a.type === 'P→T' && a.from === pid);
    if (!isConsumed) {
      issues.push({
        code: 'NC03b',
        severity: SEVERITY.NC03b,
        message: `Place "${pid}" is never consumed by any transition.`,
        elements: [pid],
      });
    }
  }

  // NC04 — two distinct entries of flatEdges computing the same place id
  // (today: `p_${e.source}_${e.target}`). A silent Map.set overwrite: the second edge's place
  // replaces the first's in `places`, but both edges still exist in the Logic-Core, so the
  // rendered/analyzed net has fewer places than the model has flows. WARNING at this stage —
  // see SEVERITY comment.
  {
    const bySource = new Map();
    for (const e of (flatEdges || [])) {
      const pid = `p_${e.source}_${e.target}`;
      if (!bySource.has(pid)) bySource.set(pid, []);
      bySource.get(pid).push(e);
    }
    for (const [pid, edgeGroup] of bySource) {
      if (edgeGroup.length > 1) {
        issues.push({
          code: 'NC04',
          severity: SEVERITY.NC04,
          message: `Edges ${edgeGroup.map(e => `"${e.id}"`).join(', ')} all map to place "${pid}" — one silently overwrote the others.`,
          elements: [pid, ...edgeGroup.map(e => e.id)],
        });
      }
    }
  }

  // NC05 — the source place has more than one consuming transition: N start events share one
  // token. This is disclosure, not a defect — van der Aalst's WF-nets require a single source,
  // and OMG BPMN 2.0.2 §10.4.2 treats multiple start events as alternative instantiations, so
  // the normalisation is deliberate and standard. INFO.
  {
    const sourceConsumers = arcs.filter(a => a.type === 'P→T' && a.from === sourcePlace).map(a => a.to);
    if (sourceConsumers.length > 1) {
      issues.push({
        code: 'NC05',
        severity: SEVERITY.NC05,
        message: `Source place "${sourcePlace}" has ${sourceConsumers.length} consuming transitions — multiple start events share one initial token (standard WF-net/OMG normalisation, not a defect).`,
        elements: [sourcePlace, ...sourceConsumers],
      });
    }
  }

  // NC06 — two distinct Logic-Core elements silently colliding on the same net id, so a
  // Map.set overwrote one with the other. Two shapes of this:
  //  (a) two flatNodes sharing the same node id — both `nodeMap` (workflow-net.js:62) and
  //      `transitions` (keyed `t_${node.id}`) can only keep one of them.
  //  (b) an edge-derived place id landing on the reserved source/sink key — 'p_source' or
  //      'p_sink' collides with the synthesized boundary places bpmnToPN always creates first.
  {
    const nodesById = new Map();
    for (const n of (flatNodes || [])) {
      if (!nodesById.has(n.id)) nodesById.set(n.id, []);
      nodesById.get(n.id).push(n);
    }
    for (const [id, group] of nodesById) {
      if (group.length > 1) {
        issues.push({
          code: 'NC06',
          severity: SEVERITY.NC06,
          message: `${group.length} distinct nodes all use id "${id}" — the net can only represent one of them.`,
          elements: [id],
        });
      }
    }
    for (const e of (flatEdges || [])) {
      const pid = `p_${e.source}_${e.target}`;
      if (pid === sourcePlace || pid === sinkPlace) {
        issues.push({
          code: 'NC06',
          severity: SEVERITY.NC06,
          message: `Edge "${e.id}" computes place id "${pid}", which collides with the reserved ${pid === sourcePlace ? 'source' : 'sink'} place.`,
          elements: [pid, e.id],
        });
      }
    }
  }

  return { ok: !issues.some(i => i.severity === 'ERROR'), issues };
}
