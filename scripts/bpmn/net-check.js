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
 * The doctrine is not free, and NC02/NC02b are where it costs something: "this transition can
 * never fire" is true both of a translation that dropped an arc and of a model that routes
 * nothing into the node. Only the first is a finding here, and the two are told apart by asking
 * the Logic-Core whether the flow exists at all — see the long note at NC02, and `inputSourceOf`
 * for the sources that are not sequence flows (a start event's scope source, a boundary event's
 * host) and must therefore never be excused.
 *
 * Findings are diagnostics, in the same shape as di-check.js's: `{ ok, issues: [{ code,
 * severity, message, elements }] }`, `ok = !issues.some(i => i.severity === 'ERROR')`.
 */

// Same set bpmnToPN (workflow-net.js) pushes to `skipped` with reason 'artifact' — these node
// types never get a transition on purpose, they don't participate in control flow. Duplicated
// here (not imported) to keep this module dependency-free, matching di-check.js's shape.
const ARTIFACT_TYPES = new Set(['dataObjectReference', 'dataStoreReference', 'textAnnotation', 'group']);

// `isBoundaryEvent` (types.js) restated, and duplicated for a stronger reason than the set above:
// a checker that shares its predicates with the code it checks cannot see a bug in them. If the
// two readings ever diverge, this one fails in the loud direction — a node workflow-net.js treats
// as a boundary event and this file does not is simply not exempted below, so it gets reported
// rather than waved through. The reverse (this file being WIDER) would exempt something
// workflow-net.js wired from sequence flows, and that is why the copy is kept literal.
const isBoundaryEventNode = (node) => node?.type === 'boundaryEvent' || !!node?.attachedTo;

// One severity constant per code, so a later stage that fixes the underlying defect can flip a
// code from WARNING to ERROR (or vice versa) by changing one line here — nothing else in this
// file encodes severity. NC02 was WARNING until boundary events got a translation
// (`wireBoundaryEvents`, workflow-net.js): a transition with no way to fire had exactly one
// legitimate cause, and that cause is gone, so the code now says what it always meant. NC04 was
// WARNING for the same kind of reason and became ERROR the same way: two flows between one node
// pair used to share a place BY DESIGN, because the place id was keyed on the pair. `namePlaces`
// (workflow-net.js) gives each flow its own, so the only remaining way two edges can land on one
// place is a defect in this translation.
//
// A severity is only as honest as the code's SCOPE, and NC02/NC02b's scope had to be narrowed
// when they were promoted — see `inputSourceOf`/`outputSinkOf` below. At WARNING they could
// afford to fire on a model defect; at ERROR they may not, or this pass judges the model, which
// its own header forbids. Measured over 4000 random rule-engine-clean processes, the unnarrowed
// codes produced 6601 NC02 + 6612 NC02b ERRORs across 3380 of 3983 nets, while NC01, NC03a,
// NC03b, NC04 and NC06 never fired once — the whole of the model-judging was in these two.
const SEVERITY = {
  NC01: 'ERROR',
  NC02: 'ERROR',
  NC02b: 'ERROR',
  NC03a: 'ERROR',
  NC03b: 'ERROR',
  NC04: 'ERROR',
  NC05: 'INFO',
  NC06: 'ERROR',
};

/**
 * Where the Logic-Core says this node's tokens come FROM — or `null` when it says nowhere.
 *
 * `null` is the whole point of the function: it is the one answer that makes a transition with
 * no input arc a fact about the MODEL rather than about the translation, and therefore not
 * NC02's to report. Three sources, and every one of them is load-bearing:
 *   - an incoming sequence flow. The ordinary case; its place must exist and its arc must be
 *     there, whatever branch of `buildScope`/`buildContainer` built the transition.
 *   - a `startEvent`'s scope source place — `p_source`, or a container's own `p_C#source`. A
 *     start event never has an incoming flow and must still always be fireable.
 *   - a boundary event's HOST. Read the long note at NC02 before touching this line: dropping it
 *     is how the narrowing would silently undo the stage that gave boundary events a translation
 *     at all.
 * An unknown node (`undefined`, e.g. a transition whose `bpmnNodeId` is in no flattened view)
 * counts as "expected input" for the same reason `knowsTheModel` does — an unexplained
 * transition is reported, never excused.
 *
 * @param {object|undefined} node - the Logic-Core node behind the transition
 * @param {Set<string>} hasIncomingFlow - node ids that are the target of some flattened edge
 * @param {boolean} knowsTheModel - false when the net carries no flattened views
 * @returns {string|null} a phrase naming the source, for the message; `null` if there is none
 */
function inputSourceOf(node, hasIncomingFlow, knowsTheModel) {
  if (!knowsTheModel || !node) return 'an input the net does not account for';
  if (hasIncomingFlow.has(node.id)) return 'at least one incoming sequence flow';
  if (node.type === 'startEvent') return "a start event's own scope source place";
  if (isBoundaryEventNode(node)) {
    return node.attachedTo ? `its host "${node.attachedTo}" as its trigger`
      : 'a host attachment as its trigger';
  }
  return null;
}

/**
 * The mirror of `inputSourceOf`: where the Logic-Core says this node's tokens GO — or `null`.
 * Two sources, and no boundary-event clause: a boundary event's OUTPUT is its outgoing sequence
 * flows like any other node's, so the asymmetry between the two functions is the asymmetry BPMN
 * itself has.
 */
function outputSinkOf(node, hasOutgoingFlow, knowsTheModel) {
  if (!knowsTheModel || !node) return 'an output the net does not account for';
  if (hasOutgoingFlow.has(node.id)) return 'at least one outgoing sequence flow';
  if (node.type === 'endEvent') return "an end event's own scope sink place";
  return null;
}

/**
 * @param {object} pn   - a net from bpmnToPN(), or a composed net from composeCollaboration().
 *        `pn.unproducedPlaces`, when present, is the translation's own list of places it left
 *        without a producer on purpose (see below, at the NC03a loop). A composed net has no
 *        such field today; if one ever needs it, the per-pool lists have to be prefixed the way
 *        every other place id is.
 *        `pn.placeOfEdge` (edge object → place id) is what NC04 and NC06(b) consult instead of
 *        re-deriving the place-id formula; it travels with `pn.flatEdges`, so a net that has one
 *        has the other, and a composed net has neither.
 * @param {object} proc - the Logic-Core process/pool the net came from (for NC01's node list
 *                        and for the element ids in the messages)
 * @param {object} [opts]
 * @param {string[]} [opts.exemptUnconsumedPlaces] - place ids the caller already accounts for.
 *        composeCollaboration's `unconsumablePlaces` (scenarios/collaboration.js) is exactly
 *        this list — a message-receiving place that a gated clone consumes only in some
 *        branches is a legitimate design, not a translation defect, and the composing caller
 *        already knows which places those are. Passed IN rather than re-derived here, for the
 *        same reason flatNodes/flatEdges travel with the net itself (see `bpmnToPN`'s return
 *        comment, workflow-net.js):
 *        identity beats agreement.
 * @returns {{ ok: boolean, issues: Array<{code, severity, message, elements}> }}
 */
export function checkNetIntegrity(pn, proc, opts = {}) {
  const exempt = new Set(opts.exemptUnconsumedPlaces || []);
  const issues = [];

  const { places, transitions, arcs, sourcePlace, sinkPlace, skipped, flatNodes, flatEdges } = pn;

  // `pn.unproducedPlaces` — the translation's own declaration that it left these places with no
  // producer because it skipped (and disclosed) the node that would have produced them. Today
  // that is a boundary event whose host is not an Activity, or names nothing at all: the
  // escalation path downstream of it really is unreachable, which is a fact about the MODEL and
  // is what WF01 reports. Reporting it here as NC03a would be the category error this module's
  // own header forbids — judging the model instead of the translation.
  //
  // Deliberately narrower than `opts.exemptUnconsumedPlaces`, which exempts both directions
  // because a message place from a black box is legitimately neither produced nor consumed.
  // This list only ever excuses a MISSING PRODUCER, so it is applied to NC03a alone. A place
  // that also loses its consumer is a different fact and still gets reported.
  const exemptUnproduced = new Set([...exempt, ...(pn.unproducedPlaces || [])]);

  // The Logic-Core facts NC02/NC02b need in order to tell a translation defect from a model
  // defect, read off the flattened views that travel with the net (identity, not a re-flatten —
  // the same argument `workflow-net.js` makes for handing those arrays back at all).
  //
  // `knowsTheModel` is the honest-failure clause: a net that carries neither view — a composed
  // collaboration net, or anything hand-built — gives this pass no way to check the claim "the
  // model has no such flow", so nothing may be excused on it and both codes behave exactly as
  // they did before the narrowing. Loud beats blind.
  const knowsTheModel = Array.isArray(flatNodes) && Array.isArray(flatEdges);
  const nodeById = new Map();
  for (const n of (flatNodes || [])) if (!nodeById.has(n.id)) nodeById.set(n.id, n);
  const hasIncomingFlow = new Set((flatEdges || []).map(e => e.target));
  const hasOutgoingFlow = new Set((flatEdges || []).map(e => e.source));

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
  // discover.
  //
  // ── What this code may and may not say, now that it is ERROR ────────────────────────────
  // "This transition cannot fire" has two utterly different causes, and only one of them is
  // this pass's business:
  //   - the Logic-Core node HAS an incoming sequence flow (or another input source, below) and
  //     the arc for it is missing from the net. The translation dropped something. NC02, ERROR.
  //   - the Logic-Core node has no input at all — a `parallelGateway` nothing routes to, a
  //     subprocess with no incoming flow. The TRANSLATION is faithful; the MODEL is defective,
  //     and the layer that owns that is WF01 (`checkSoundness` — the transition is dead, which
  //     is exactly what a node the flow never reaches means), plus S04 where the node has no
  //     edges at all. Not a finding here.
  // Unnarrowed, the second case dominated: it was the whole of the 6601 NC02 ERRORs measured
  // over rule-engine-clean random processes (see the SEVERITY note), and it would have made
  // wiring this pass into `runPipeline` reject models that generate today.
  //
  // ── The trap in the narrowing ───────────────────────────────────────────────────────────
  // A boundary event has no incoming sequence flow BY DEFINITION (OMG §10.4.4) — its trigger is
  // the host named by `attachedTo`. A naive "no incoming flow ⇒ exempt" would therefore exempt
  // every boundary event, which is precisely the defect this code was promoted to ERROR for:
  // before `wireBoundaryEvents` (workflow-net.js), `t_<b>` reached the net with no input arc,
  // unfireable in every marking, silently deleting the whole escalation path. `inputSourceOf`
  // must keep naming the attachment as an input source, and `net-check.test.js`'s
  // "boundary-event wiring" regression test fails if it stops.
  for (const [tId, t] of transitions) {
    const hasIncoming = arcs.some(a => a.type === 'P→T' && a.to === tId);
    if (hasIncoming) continue;
    const source = inputSourceOf(nodeById.get(t.bpmnNodeId), hasIncomingFlow, knowsTheModel);
    if (!source) continue; // the model gives this node no input — S04/S07's finding, not ours
    issues.push({
      code: 'NC02',
      severity: SEVERITY.NC02,
      message: `Transition "${tId}" (node "${t.bpmnNodeId}") has no incoming place — it can never `
        + `fire, although the Logic-Core gives the node ${source}.`,
      elements: [t.bpmnNodeId, tId],
    });
  }

  // NC02b — a transition with no outgoing T→P arc: it consumes a token and destroys it. Narrowed
  // for exactly the reason NC02 is, mirrored onto the outgoing side: a node the model gives no
  // outgoing sequence flow (and which is not an end event, whose output is its scope's sink
  // place) produces nothing because the MODEL says so. S07 owns that one squarely — "no outgoing
  // flow" is its literal wording. This pass reports only the case where an outgoing flow exists
  // in the Logic-Core and its arc is missing from the net.
  for (const [tId, t] of transitions) {
    const hasOutgoing = arcs.some(a => a.type === 'T→P' && a.from === tId);
    if (hasOutgoing) continue;
    const sink = outputSinkOf(nodeById.get(t.bpmnNodeId), hasOutgoingFlow, knowsTheModel);
    if (!sink) continue;
    issues.push({
      code: 'NC02b',
      severity: SEVERITY.NC02b,
      message: `Transition "${tId}" (node "${t.bpmnNodeId}") has no outgoing place — it consumes a `
        + `token and never produces one, although the Logic-Core gives the node ${sink}.`,
      elements: [t.bpmnNodeId, tId],
    });
  }

  // NC03a — a place no transition ever produces (other than the source place, whose initial
  // token is placed directly, any place the caller already accounts for, and any place the
  // TRANSLATION declared on `pn.unproducedPlaces` — see the note at the top of this function
  // for why that list excuses a missing producer and nothing else).
  // NC03b — a place no transition ever consumes (other than the sink place, and the same
  // exemptions). Together these are the "dropped container" signature: a subprocess boundary
  // vanishing from bpmnToPN's flatten leaves exactly one produced-never-consumed place on the
  // way in and one consumed-never-produced place on the way out.
  for (const [pid] of places) {
    if (pid === sourcePlace || exemptUnproduced.has(pid)) continue;
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

  // NC04 — two distinct edges assigned the same place. Historically a silent Map.set overwrite:
  // the second edge's place replaced the first's in `places`, but both edges still existed in the
  // Logic-Core, so the analyzed net had fewer places than the model has flows and the choice
  // between the two was unobservable in every trace.
  //
  // Read off `pn.placeOfEdge` rather than re-derived from `e.source`/`e.target`, and that is the
  // difference between a fence and a false alarm: two flows between one node pair are legal BPMN
  // and are now translated to two places, so a check re-deriving the old pair formula would call
  // every such model an ERROR.
  //
  // Be clear about what that makes this code, because it is narrower than its neighbours. NC01
  // and the NC03 pair compare the net against the Logic-Core; NC04 asks `namePlaces`' output
  // whether `namePlaces` upheld its own invariant — distinct edges never share a place id.
  // Under the current naming rule it therefore cannot fire on a net `bpmnToPN` produced, by
  // construction. That is the intended end state, not a gap: it is a regression fence, ERROR
  // because a future naming rule that breaks the invariant must fail loudly rather than quietly
  // hand back a net with fewer places than the model has flows. Its whole value is in the
  // vacuity test that forces a collision into the map — do not delete that test as "testing
  // nothing"; deleting it is what would make this fence blind.
  //
  // Distinct EDGES, by object identity: the same edge object appearing twice in `flatEdges` is
  // one edge listed twice, and `namePlaces` (workflow-net.js) mints one place for it on the same
  // reading. Counting it as a collision here would contradict the translation.
  {
    const bySource = new Map();
    const seen = new Set();
    for (const e of (flatEdges || [])) {
      if (seen.has(e)) continue;
      seen.add(e);
      // A net not built by bpmnToPN carries no map; `flatEdges` and `placeOfEdge` always
      // travel together, so an edge with no entry means there is nothing to check against.
      const pid = pn.placeOfEdge?.get(e);
      if (pid === undefined) continue;
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
  //  (a) two flatNodes sharing the same node id — every id-keyed structure the translation
  //      builds (`transitions`, keyed `t_${node.id}`; `buildContainer`'s `p_<C>#source` /
  //      `p_<C>#sink` pair; `namePlaces`' `p_<src>_<tgt>`) can only keep one of them.
  //  (b) an edge-derived place id landing on the reserved source/sink key — 'p_source' or
  //      'p_sink' collides with the synthesized boundary places bpmnToPN always creates first.
  //      Asked of `pn.placeOfEdge`, for the reason NC04 gives above: the naming rule lives in
  //      one place, and this check has to follow it rather than restate it.
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
      const pid = pn.placeOfEdge?.get(e);
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
