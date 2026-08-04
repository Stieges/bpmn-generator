/**
 * BPMN 2.0 XML Generation via bpmn-moddle
 * Uses bpmn-moddle's typed CMOF object model + toXML() for OMG-compliant serialization.
 * Replaces the legacy string-concatenation approach.
 *
 * Signature: generateBpmnXml(lc, coordMap) → Promise<string>
 */

import { BpmnModdle } from 'bpmn-moddle';
import {
  isEvent, isGateway, isBoundaryEvent, isBpmnArtifact,
  OMG_NODE_FIELD_SCOPE, nodeFieldSpec, matchesFieldType, bpmnXmlTag,
} from './types.js';

import { LANE_HEADER_W, LABEL_DISTANCE } from './constants.js';
import { rn, EXTENSION_NS, EXTENSION_PREFIX } from '../shared/utils.js';
import { inferGatewayDirections } from './topology.js';
import { inferEventMarker } from './icons.js';

const moddle = new BpmnModdle();

/**
 * May `node` carry `field`, with the value it actually holds?
 *
 * The single question every table-guarded write site asks, so that "guarded by the table" means one
 * thing across all of them. The rows whose write site calls this are exactly the ones whose
 * `enforcedBy` is `'table'` or `'convention'` — the two values that mean "`allowed` is consulted
 * here". The split between them is about which RULE reports the drop, not about whether it happens:
 * `'table'` rows are S15's (the scope is OMG's), the single `'convention'` row is M11's (the scope
 * is our own published contract). Either way the serialiser and the reporting rule read one table,
 * which is what keeps them from disagreeing about which fields are legal where.
 *
 * Throws on an unknown field rather than returning `true`: a mistyped name here would silently
 * remove a guard, which is the failure mode this whole table exists to end.
 */
function fieldAllowedOn(node, field) {
  const spec = nodeFieldSpec(field);
  if (!spec) throw new Error(`bpmn-xml.js: no OMG_NODE_FIELD_SCOPE row for "${field}"`);
  return spec.allowed.has(node.type) && matchesFieldType(node[field], spec.type);
}

/**
 * Return the effective lane-header strip width for a pool, preferring
 * any dynamic value computed by visual-refinement over the default.
 * Falls back to '_singlePool' if the requested key isn't in poolCoords,
 * mirroring the lookup pattern in visual-refinement.js.
 */
function laneHeaderW(poolCoords, poolKey) {
  return poolCoords?.[poolKey]?.laneHeaderWidth
      ?? poolCoords?.['_singlePool']?.laneHeaderWidth
      ?? LANE_HEADER_W;
}

/** Helper: create a moddle element with shorthand */
function create(type, attrs = {}) {
  return moddle.create(type, attrs);
}

/**
 * The identity attributes for a node, with the label routed to whichever field
 * the element's BPMN class actually has.
 *
 * Logic-Core carries every label in `name`, which is right for Logic-Core — one
 * field for "the caption". BPMN is not that uniform: Artifacts extend BaseElement,
 * which declares only `id`, so `name` is illegal on them (OMG Semantic.xsd;
 * bpmn-moddle's descriptor agrees). moddle does not reject the unknown attribute,
 * it parks it in $attrs and writes it straight back out — so the mistake costs no
 * error at write time and shows up only as an empty annotation in the modeller.
 *
 * Translating here, in ONE place used by both the top-level and the subprocess-child
 * path, is deliberate: the two call sites carried the same literal before, which is
 * how the defect reached both.
 */
function buildNodeAttrs(node) {
  if (node.type === 'textAnnotation') {
    // `text` has no isAttr in the descriptor → serialises as a <bpmn:text> child.
    return { id: node.id, text: node.name || '' };
  }
  if (node.type === 'group') {
    // The label lives in a CategoryValue the group points at; wired up by the
    // caller, which owns the definitions-level rootElements.
    return { id: node.id };
  }
  return { id: node.id, name: node.name || '' };
}

/**
 * A Group's label is not on the Group: it sits in a CategoryValue held by a
 * Category, which is a rootElement, and the Group references it. Returns the
 * CategoryValue to point `categoryValueRef` at, plus the Category to publish.
 */
function buildCategoryForGroup(node) {
  const categoryValue = create('bpmn:CategoryValue', {
    id: `CategoryValue_${node.id}`,
    value: node.name,
  });
  const category = create('bpmn:Category', {
    id: `Category_${node.id}`,
    categoryValue: [categoryValue],
  });
  return { category, categoryValue };
}

/**
 * Map Logic-Core type to bpmn-moddle qualified type name.
 * e.g. 'userTask' → 'bpmn:UserTask'
 */
function moddleType(lcType) {
  const tag = bpmnXmlTag(lcType);
  return 'bpmn:' + tag.charAt(0).toUpperCase() + tag.slice(1);
}

/**
 * Build event definition moddle element for a node.
 */
function buildEventDefinition(node, topLevelDefsMap) {
  const marker = node.marker || inferEventMarker(node.name || '');
  if (!marker) return null;

  const typeMap = {
    message: 'bpmn:MessageEventDefinition',
    timer: 'bpmn:TimerEventDefinition',
    error: 'bpmn:ErrorEventDefinition',
    signal: 'bpmn:SignalEventDefinition',
    escalation: 'bpmn:EscalationEventDefinition',
    compensation: 'bpmn:CompensateEventDefinition',
    conditional: 'bpmn:ConditionalEventDefinition',
    link: 'bpmn:LinkEventDefinition',
    cancel: 'bpmn:CancelEventDefinition',
    terminate: 'bpmn:TerminateEventDefinition',
  };

  const bpmnType = typeMap[marker];
  if (!bpmnType) return null;

  const attrs = {};

  // Reference to top-level definition
  const topDef = topLevelDefsMap.get(marker);
  if (topDef) {
    const refProp = {
      message: 'messageRef', error: 'errorRef',
      signal: 'signalRef', escalation: 'escalationRef',
    }[marker];
    if (refProp) attrs[refProp] = topDef;
  }

  // Timer expressions
  if (marker === 'timer' && node.timerExpression) {
    const te = node.timerExpression;
    const timerTag = te.type === 'date' ? 'timeDate' : te.type === 'cycle' ? 'timeCycle' : 'timeDuration';
    const formalExpr = create('bpmn:FormalExpression', { body: te.value });
    attrs[timerTag] = formalExpr;
  }

  // Conditional expression
  if (marker === 'conditional' && node.conditionExpression) {
    attrs.condition = create('bpmn:FormalExpression', { body: node.conditionExpression });
  }

  // Link name
  if (marker === 'link') {
    attrs.name = node.linkName || node.name || '';
  }

  return create(bpmnType, attrs);
}

/**
 * Collect top-level definitions (message, signal, error, escalation)
 * and return both the moddle elements array and a marker→element lookup map.
 */
function buildTopLevelDefinitions(processes, explicitDefs) {
  const elements = [];
  const markerMap = new Map();

  if (explicitDefs && explicitDefs.length > 0) {
    for (const d of explicitDefs) {
      const typeMap = {
        message: 'bpmn:Message', error: 'bpmn:Error',
        signal: 'bpmn:Signal', escalation: 'bpmn:Escalation',
      };
      const bpmnType = typeMap[d.type];
      if (!bpmnType) continue;
      const attrs = { id: d.id, name: d.name || '' };
      if (d.errorCode) attrs.errorCode = d.errorCode;
      if (d.escalationCode) attrs.escalationCode = d.escalationCode;
      const el = create(bpmnType, attrs);
      elements.push(el);
      markerMap.set(d.type, el);
    }
    return { elements, markerMap };
  }

  // Auto-generate from event markers
  const seen = new Set();
  for (const proc of processes) {
    for (const node of (proc.nodes || [])) {
      const marker = node.marker || inferEventMarker(node.name || '');
      if (!marker || seen.has(marker)) continue;

      const tagMap = {
        message: 'bpmn:Message', error: 'bpmn:Error',
        signal: 'bpmn:Signal', escalation: 'bpmn:Escalation',
      };
      const bpmnType = tagMap[marker];
      if (!bpmnType) continue;

      seen.add(marker);
      const shortName = marker.charAt(0).toUpperCase() + marker.slice(1);
      const el = create(bpmnType, {
        id: `${shortName}_${elements.length + 1}`,
        name: shortName,
      });
      elements.push(el);
      markerMap.set(marker, el);
    }
  }
  return { elements, markerMap };
}

/**
 * Turn one Logic-Core node into its fully enriched moddle element.
 *
 * EVERY node goes through here — top-level nodes and the children of an expanded
 * subprocess alike, at any nesting depth. That is the whole point of the function
 * existing: the child path used to be a hand-rolled subset of the top-level loop
 * (id/name plus event definitions, nothing else), so `documentation`, loop and
 * multi-instance characteristics, the script body, `calledElement`,
 * `scriptFormat`, `gatewayDirection` and every grandchild were dropped in
 * silence. Silence is the operative word: bpmn-moddle reports attributes it does
 * not know, never fields that never arrived, so nothing complained.
 *
 * Adding a new per-node field? Add it here and both paths get it. Adding it to a
 * caller instead is how the divergence came back the last two times.
 *
 * `registerNode` collects (node, element) pairs for the callers that need a
 * second pass — currently boundary-event attachedToRef, which can only be
 * resolved once every element exists.
 */
/**
 * The `<bpmn:dataObject>` that belongs to a `dataObjectReference` node, or `null` for any other
 * node type.
 *
 * Logic-Core models a data object and the reference to it as ONE node; BPMN splits them into a
 * `DataObject` (the thing) and a `DataObjectReference` (a use of it). The properties split too,
 * and `isCollection` belongs to the DataObject — bpmn-moddle's metamodel grants
 * DataObjectReference only `dataObjectRef`. Writing it on the reference is what produced
 * `unknown attribute <isCollection>` on every round trip.
 *
 * Called from BOTH build paths, and that is the point rather than an incidental tidy-up: the
 * top-level loop in `buildProcess` used to be the only place a DataObject was created, so a
 * `dataObjectReference` nested inside a subprocess got a reference and no object at all. Moving
 * `isCollection` onto the object without also closing that hole would have silently dropped the
 * field for nested references — the same defect, one nesting level down.
 *
 * `refEl` is the reference element the object belongs to, and it gets `dataObjectRef` pointing at
 * the object. That link is what makes the split survive a round trip: once a property lives on the
 * object rather than on the reference, an importer has to be able to get from one to the other,
 * and `dataObjectRef` is the standard way — the only one that also works for a file some other
 * tool wrote, where our `<id>_do` naming convention means nothing.
 */
function buildDataObject(node, refEl) {
  if (node.type !== 'dataObjectReference') return null;
  const attrs = { id: `${node.id}_do` };
  for (const spec of OMG_NODE_FIELD_SCOPE) {
    // The generic loop's other half: `writeSite: 'fieldLoop'` is what puts a row in a loop at all,
    // and `on` decides which of the two loops. Filtering on `on` alone would sweep up every row
    // whose emission target happens to be a dataObject but whose write lives elsewhere.
    if (spec.writeSite !== 'fieldLoop' || spec.on !== 'dataObject') continue;
    const value = node[spec.field];
    // Same three guards as the `on: 'self'` loop, for the same reasons: falsy is nothing to
    // write, a class that may not carry the field is dropped (S15 reports it), and a wrongly
    // typed value is dropped rather than coerced.
    if (!value) continue;
    if (!spec.allowed.has(node.type)) continue;
    if (!matchesFieldType(value, spec.type)) continue;
    attrs[spec.attr] = value;
  }
  const dataObject = create('bpmn:DataObject', attrs);
  if (refEl) refEl.dataObjectRef = dataObject;
  return dataObject;
}

function buildFlowNode(node, topLevelDefsMap, registerNode) {
  const attrs = buildNodeAttrs(node);

  // Gateway direction
  if (isGateway(node.type) && node._direction) {
    attrs.gatewayDirection = node._direction;
  }

  // Boundary event — attachedToRef is resolved later, once all nodes exist.
  //
  // The class guard now comes from `OMG_NODE_FIELD_SCOPE` (`enforcedBy: 'table'`), and that is not
  // cosmetic: `isBoundaryEvent` is deliberately wider than the boundaryEvent CLASS — it also
  // answers true for anything carrying `attachedTo` — so this branch used to emit
  // `<bpmn:task cancelActivity="false">` for a task with an `attachedTo`, an attribute OMG grants
  // to BoundaryEvent alone.
  //
  // The emission condition stays here rather than joining the generic loop, because it is the one
  // attribute in the table where FALSE is the value worth writing: `cancelActivity` defaults to
  // true in the XSD, so an interrupting boundary event is spelled by the attribute's absence. The
  // loop skips falsy values — right for every other row, exactly wrong for this one — so putting
  // this row in the loop would have dropped every `cancelActivity: false` in the corpus.
  if (isBoundaryEvent(node) && node.cancelActivity === false && fieldAllowedOn(node, 'cancelActivity')) {
    attrs.cancelActivity = false;
  }

  // Special attributes — every one of them scoped to the node classes OMG defines it on.
  //
  // `references/input-schema.json` declares each of these as a generic property of `Node`, valid
  // on any `NodeType`, so schema-valid input can put any of them on any node. OMG scopes them far
  // more narrowly, and an attribute outside a class's content model is not merely unusual, it is
  // XSD-invalid — bpmn-moddle reports it straight back as `unknown attribute <…>` when we re-parse
  // our own output. These guards used to be written out one per line here, which is how two of
  // them came to be missing (`isForCompensation`, emitting `<bpmn:parallelGateway
  // isForCompensation="true">`, and `implementation`, emitting it on events and gateways alike)
  // while the four beside them were correct. The scopes now come from `OMG_NODE_FIELD_SCOPE` in
  // types.js, which S15 reads too — a rule that disagreed with the serialiser about which fields
  // are legal where would be worse than no rule, and a shared table makes disagreeing impossible.
  //
  // A field the node's class may not carry is dropped, not reported, and that is a layering
  // decision: this function's contract is "emit valid BPMN for the model it was handed", not
  // "diagnose the model" — the same separation that keeps `net-check.js` out of judging XML. The
  // reporting is S15's job, in the layer that owns model defects and can say so in prose.
  for (const spec of OMG_NODE_FIELD_SCOPE) {
    // The rows this loop owns are exactly `writeSite: 'fieldLoop'` + `on: 'self'`. The table now
    // covers every `$defs.Node` property, and most of them serialise some other way — as a child
    // element, as an eventDefinition property, into extensionElements, or into the DI — so the loop
    // has to say which rows are its own instead of taking the whole array. `writeSite` is that
    // statement, and it is explicit on every row rather than inferred, so that adding a row cannot
    // accidentally enrol it here.
    //
    // `isCollection` is written onto the companion `<bpmn:dataObject>` by
    // `buildDataObject` below, because OMG puts the attribute on DataObject and not on
    // DataObjectReference — writing it here produced `<bpmn:dataObjectReference
    // isCollection="true">` and an `unknown attribute <isCollection>` on every round trip.
    if (spec.writeSite !== 'fieldLoop' || spec.on !== 'self') continue;
    const value = node[spec.field];
    if (!value) continue;                        // falsy: nothing to serialise, same as before
    if (!spec.allowed.has(node.type)) continue;  // wrong class for this attribute
    // Wrong TYPE is dropped too, and the expected type comes from the table rather than from
    // `typeof value`. Inferring it from the data was a real defect: a `typeof value === 'boolean'
    // ? true : value` passed any truthy non-boolean straight through, so `isCompensation: 'yes'`
    // emitted `isForCompensation="yes"` — invalid against the XSD and silent, since bpmn-moddle
    // reports attributes it does not KNOW, never values of the wrong shape.
    //
    // Dropped rather than coerced, and `isCompensation: 'no'` is why: `!!'no'` is `true`, so
    // coercion would emit the exact opposite of what the author wrote, with no way to tell. A
    // serialiser guessing at intent is worse than one that declines. S15 reports the drop.
    if (!matchesFieldType(value, spec.type)) continue;
    attrs[spec.attr] = value;
  }

  const el = create(moddleType(node.type), attrs);

  // Documentation
  if (node.documentation) {
    el.get('documentation').push(create('bpmn:Documentation', { text: node.documentation }));
  }

  // Event definitions (only Event types have this property, not SubProcess)
  const eventDef = buildEventDefinition(node, topLevelDefsMap);
  if (eventDef && el.$descriptor.properties.some(p => p.name === 'eventDefinitions')) {
    el.get('eventDefinitions').push(eventDef);
  }

  // Loop / Multi-instance.
  //
  // Both guarded by the table since this stage, and the guards close a measured silent drop: OMG
  // puts `loopCharacteristics` on Activity, so a `loopType` on a `startEvent` or a `multiInstance`
  // on a `parallelGateway` produced NO element and NO moddle warning — bpmn-moddle reports
  // attributes it does not KNOW, but a property it has no descriptor for it simply discards. The
  // author got a green build, valid XML, and no loop. Now the field is dropped deliberately, which
  // is the same output, and S15 says so, which is the whole difference.
  //
  // The `else if` is not a style choice: OMG gives an Activity ONE `loopCharacteristics` slot, so a
  // node carrying both fields can only express one of them. `loopType` wins; the `multiInstance`
  // row's `roundTrip` reason records that.
  if (node.loopType && fieldAllowedOn(node, 'loopType')) {
    const loopAttrs = {};
    if (typeof node.loopType === 'object') {
      if (node.loopType.testBefore) loopAttrs.testBefore = true;
      if (node.loopType.loopMaximum != null) loopAttrs.loopMaximum = node.loopType.loopMaximum;
      if (node.loopType.loopCondition) {
        loopAttrs.loopCondition = create('bpmn:FormalExpression', { body: node.loopType.loopCondition });
      }
    }
    el.loopCharacteristics = create('bpmn:StandardLoopCharacteristics', loopAttrs);
  } else if (node.multiInstance && fieldAllowedOn(node, 'multiInstance')) {
    const mi = typeof node.multiInstance === 'object' ? node.multiInstance : { type: node.multiInstance };
    const miAttrs = { isSequential: mi.type === 'sequential' };
    if (mi.loopCardinality) {
      miAttrs.loopCardinality = create('bpmn:FormalExpression', { body: mi.loopCardinality });
    }
    if (mi.completionCondition) {
      miAttrs.completionCondition = create('bpmn:FormalExpression', { body: mi.completionCondition });
    }
    el.loopCharacteristics = create('bpmn:MultiInstanceLoopCharacteristics', miAttrs);
  }

  // Script body. The `scriptTask` literal is now the table's `allowed` set — same verdict, one
  // fewer restatement of a class scope, and the row is what S15 reads to report the drop.
  if (node.script && fieldAllowedOn(node, 'script')) {
    el.script = node.script;
  }

  // decisionRef — which decision model a Business Rule Task invokes.
  //
  // BPMN 2.0 has no standard attribute for this; the DMN side of the link IS
  // standard (Decision/usingTask, DMN13.xsd) but points the other way. So this
  // goes into extensionElements under our own namespace rather than borrowing
  // `camunda:`. Created via createAny so the namespace URI travels with the
  // element — see EXTENSION_NS in utils.js for why that matters.
  //
  // Scoped to `businessRuleTask` by the table since this stage. `references/input-schema.json` is
  // the authority for that — the property's own description reads "For businessRuleTask" — and the
  // write was unguarded, so a `decisionRef` on a userTask was emitted, re-imported and never
  // questioned. Unlike loopType/multiInstance this was not a silent DROP but a silent
  // ACCEPTANCE: the field reached the XML on a class the published contract does not scope it to.
  if (node.decisionRef && fieldAllowedOn(node, 'decisionRef')) {
    const ref = moddle.createAny(`${EXTENSION_PREFIX}:decisionRef`, EXTENSION_NS, {
      $body: String(node.decisionRef),
    });
    el.extensionElements = create('bpmn:ExtensionElements', { values: [ref] });
  }

  registerNode(node, el);

  // Children of a subprocess. Deliberately NOT gated on isExpanded: whether a
  // subprocess is drawn open or collapsed is a DI question (BPMNShape's
  // isExpanded), while its content is semantics and always belongs in the file.
  // Gating the content made "collapsed but drillable" — a perfectly legal BPMN
  // state — impossible to express, and produced an empty box instead.
  if (node.nodes?.length) {
    inferGatewayDirections(node.nodes, node.edges || []);
    const childMap = new Map();
    for (const child of node.nodes) {
      const childEl = buildFlowNode(child, topLevelDefsMap, registerNode);
      childMap.set(child.id, childEl);
      el.get('flowElements').push(childEl);
      // A nested data object needs its DataObject in the subprocess's own flowElements — a
      // SubProcess is a FlowElementsContainer, so that is where it belongs. Without this the
      // reference existed with nothing to reference, and (since the move above) `isCollection`
      // on a nested reference would have gone nowhere at all.
      const childDataObject = buildDataObject(child, childEl);
      if (childDataObject) el.get('flowElements').push(childDataObject);
    }
    for (const subEdge of (node.edges || [])) {
      const seid = subEdge.id || `flow_${subEdge.source}_${subEdge.target}`;
      const seAttrs = { id: seid };
      if (subEdge.label) seAttrs.name = subEdge.label;
      seAttrs.sourceRef = childMap.get(subEdge.source);
      seAttrs.targetRef = childMap.get(subEdge.target);
      const seFlow = create('bpmn:SequenceFlow', seAttrs);
      el.get('flowElements').push(seFlow);
      registerNode({ id: seid, _isEdge: true }, seFlow);
    }
  }

  return el;
}

/**
 * Build a single BPMN process with all flow elements.
 * Returns { process, flowNodeMap } where flowNodeMap maps node.id → moddle element.
 */
function buildProcess(proc, defaultFlowMap, topLevelDefsMap) {
  const nodes = proc.nodes || [];
  const edges = proc.edges || [];

  inferGatewayDirections(nodes, edges);

  // Build incoming/outgoing maps
  const incomingMap = {};
  const outgoingMap = {};
  for (const e of edges) {
    const eid = e.id || `flow_${e.source}_${e.target}`;
    if (!outgoingMap[e.source]) outgoingMap[e.source] = [];
    outgoingMap[e.source].push(eid);
    if (!incomingMap[e.target]) incomingMap[e.target] = [];
    incomingMap[e.target].push(eid);
  }

  const flowNodeMap = new Map();
  const flowElements = [];
  // tProcess is an xsd:sequence — laneSet*, flowElement*, artifact* — so
  // artifacts have to be collected separately and appended after the flow.
  const artifacts = [];
  const categories = [];

  // Every node the process contains, at any depth, paired with its element —
  // boundary-event resolution below needs the pairs, and it must reach nested
  // hosts too, not just the top level.
  const builtNodes = [];
  const registerNode = (node, el) => {
    flowNodeMap.set(node.id, el);
    if (!node._isEdge) builtNodes.push({ node, el });
  };

  // Create flow nodes
  for (const node of nodes) {
    const el = buildFlowNode(node, topLevelDefsMap, registerNode);
    if (isBpmnArtifact(node.type)) {
      if (node.type === 'group' && node.name) {
        const { category, categoryValue } = buildCategoryForGroup(node);
        el.categoryValueRef = categoryValue;
        categories.push(category);
      }
      artifacts.push(el);
    } else {
      flowElements.push(el);
    }
  }

  // Resolve boundary event attachedToRef. Walks builtNodes, not proc.nodes: a
  // boundary event on a subprocess CHILD is just as valid, and iterating the top
  // level only left it without the attribute the OMG schema makes mandatory —
  // invalid BPMN that every check reported green.
  for (const { node, el } of builtNodes) {
    if (!isBoundaryEvent(node) || !node.attachedTo) continue;
    const attachedEl = flowNodeMap.get(node.attachedTo);
    if (attachedEl) el.attachedToRef = attachedEl;
  }

  // Create sequence flows
  const defaultFlowIds = new Set(Object.values(defaultFlowMap));
  const seqFlowMap = new Map();
  for (const edge of edges) {
    const eid = edge.id || `flow_${edge.source}_${edge.target}`;
    const attrs = {
      id: eid,
      sourceRef: flowNodeMap.get(edge.source),
      targetRef: flowNodeMap.get(edge.target),
    };
    if (edge.label) attrs.name = edge.label;

    // Condition expression
    const sourceNode = nodes.find(n => n.id === edge.source);
    const needsCondition = edge.condition ||
      (sourceNode && (sourceNode.type === 'exclusiveGateway' || sourceNode.type === 'inclusiveGateway') &&
       sourceNode._direction === 'Diverging' && !defaultFlowIds.has(eid));
    if (needsCondition) {
      const expr = edge.condition || edge.label || '';
      attrs.conditionExpression = create('bpmn:FormalExpression', { body: expr });
    }

    const seqFlow = create('bpmn:SequenceFlow', attrs);
    seqFlowMap.set(eid, seqFlow);
    flowElements.push(seqFlow);
  }

  // Set incoming/outgoing references on flow nodes (industry convention)
  for (const edge of edges) {
    const eid = edge.id || `flow_${edge.source}_${edge.target}`;
    const seqFlow = seqFlowMap.get(eid);
    if (!seqFlow) continue;
    const srcEl = flowNodeMap.get(edge.source);
    const tgtEl = flowNodeMap.get(edge.target);
    if (srcEl) srcEl.get('outgoing').push(seqFlow);
    if (tgtEl) tgtEl.get('incoming').push(seqFlow);
  }

  // Set default flow references on gateways
  for (const [nodeId, flowId] of Object.entries(defaultFlowMap)) {
    const gwEl = flowNodeMap.get(nodeId);
    const dfEl = seqFlowMap.get(flowId);
    if (gwEl && dfEl) gwEl.default = dfEl;
  }

  // Data objects. The nested case is handled in `buildFlowNode`'s child loop, so that every
  // dataObjectReference has a DataObject at whatever depth it sits — see `buildDataObject`.
  for (const node of nodes) {
    const dataObject = buildDataObject(node, flowNodeMap.get(node.id));
    if (dataObject) flowElements.push(dataObject);
  }

  // Associations
  // (handled at caller level since they can span processes)

  // Build process element
  const processEl = create('bpmn:Process', {
    id: proc.id,
    isExecutable: false,
  });
  if (proc.documentation) {
    processEl.get('documentation').push(create('bpmn:Documentation', { text: proc.documentation }));
  }

  // LaneSet
  const lanes = proc.lanes || [];
  if (lanes.length > 0) {
    const laneSet = create('bpmn:LaneSet', { id: `LaneSet_${proc.id || '1'}` });
    for (const lane of lanes) {
      const laneEl = buildLane(lane, nodes, flowNodeMap);
      laneSet.get('lanes').push(laneEl);
    }
    processEl.get('laneSets').push(laneSet);
  }

  // Add all flow elements
  for (const fe of flowElements) {
    processEl.get('flowElements').push(fe);
  }

  // …then the artifacts, keeping the tProcess sequence intact.
  for (const artifact of artifacts) {
    processEl.get('artifacts').push(artifact);
  }

  return { process: processEl, flowNodeMap, categories };
}

function buildLane(lane, nodes, flowNodeMap) {
  const laneEl = create('bpmn:Lane', { id: lane.id, name: lane.name || lane.id });
  // Lane#flowNodeRef is typed FlowNode. Artifacts are not FlowNodes at all, and
  // data references are FlowElements but still not FlowNodes — listing either
  // makes the lane reference something it is not allowed to hold. Which lane an
  // annotation sits in visually is a geometry question, and geometry lives in
  // coordMap, not here.
  const refs = nodes
    .filter(n => n.lane === lane.id && !isBpmnArtifact(n.type)
      && n.type !== 'dataObjectReference' && n.type !== 'dataStoreReference')
    .map(n => flowNodeMap.get(n.id)).filter(Boolean);
  for (const ref of refs) {
    laneEl.get('flowNodeRef').push(ref);
  }
  if (lane.children?.length) {
    const childLaneSet = create('bpmn:LaneSet');
    for (const child of lane.children) {
      childLaneSet.get('lanes').push(buildLane(child, nodes, flowNodeMap));
    }
    laneEl.childLaneSet = childLaneSet;
  }
  return laneEl;
}

/**
 * Build default flow map for XOR/Inclusive gateways.
 */
function buildDefaultFlowMap(proc) {
  const nodes = proc.nodes || [];
  const edges = proc.edges || [];
  const map = {};

  for (const e of edges) {
    if (e.isDefault) {
      map[e.source] = e.id || `flow_${e.source}_${e.target}`;
    }
  }
  for (const n of nodes) {
    if ((n.type === 'exclusiveGateway' || n.type === 'inclusiveGateway') &&
        n._direction === 'Diverging' && !map[n.id]) {
      const gwOutEdges = edges.filter(e => e.source === n.id);
      if (gwOutEdges.length > 1) {
        const defaultEdge = gwOutEdges[gwOutEdges.length - 1];
        map[n.id] = defaultEdge.id || `flow_${defaultEdge.source}_${defaultEdge.target}`;
      }
    }
  }
  return map;
}

// ═══════════════════════════════════════════════════════════════════════
// DI (Diagram Interchange) — BPMNDiagram, BPMNPlane, BPMNShape, BPMNEdge
// ═══════════════════════════════════════════════════════════════════════

function buildDI(lc, coordMap, processes, collaboration, allFlowNodeMaps, collapsedParticipants) {
  const { coords, laneCoords, poolCoords, edgeCoords } = coordMap;
  const isMultiPool = lc.pools && lc.pools.length > 0;
  const associations = lc.associations || [];
  const needsCollaboration = !!collaboration;

  const plane = create('bpmndi:BPMNPlane', {
    id: 'BPMNPlane_1',
    bpmnElement: needsCollaboration ? collaboration : processes[0],
  });
  const planeElements = [];

  // Pool shapes
  if (needsCollaboration) {
    const allParticipants = collaboration.get('participants');
    for (const part of allParticipants) {
      const procId = part.processRef?.id || part.id?.replace('Participant_', '');
      const pc = poolCoords[procId] || poolCoords['_singlePool'];
      if (!pc) continue;

      let px = pc.x, py = pc.y, pw = pc.w, ph = pc.h;

      // Recalculate from lanes if available
      const proc = (lc.pools || [lc]).find(p => p.id === procId);
      const lanes = proc?.lanes || [];
      if (lanes.length > 0) {
        const lcs = lanes.map(l => laneCoords[l.id]).filter(Boolean);
        if (lcs.length) {
          px = Math.min(...lcs.map(l => l.x)) - laneHeaderW(poolCoords, procId);
          py = Math.min(...lcs.map(l => l.y));
          pw = Math.max(...lcs.map(l => l.x + l.w)) - px;
          ph = Math.max(...lcs.map(l => l.y + l.h)) - py;
        }
      }

      const shape = create('bpmndi:BPMNShape', {
        id: `${part.id}_di`,
        bpmnElement: part,
        isHorizontal: true,
        bounds: create('dc:Bounds', { x: rn(px), y: rn(py), width: rn(pw), height: rn(ph) }),
      });
      planeElements.push(shape);

      // Lane DI
      if (proc?.lanes) {
        buildLaneDI(proc.lanes, laneCoords, planeElements, allFlowNodeMaps);
      }
    }
  }

  // Node shapes
  for (const proc of (lc.pools || [lc])) {
    for (const node of (proc.nodes || [])) {
      const c = coords[node.id];
      if (!c) continue;

      const flowNodeEl = allFlowNodeMaps.get(node.id);
      const shapeAttrs = {
        id: `${node.id}_di`,
        bpmnElement: flowNodeEl || node.id,
        bounds: create('dc:Bounds', { x: rn(c.x), y: rn(c.y), width: rn(c.w), height: rn(c.h) }),
      };
      if (node.type === 'exclusiveGateway') shapeAttrs.isMarkerVisible = true;
      if (node.isExpanded && node.nodes) shapeAttrs.isExpanded = true;

      // bioc color
      if (node.color) {
        if (node.color.stroke) shapeAttrs['bioc:stroke'] = node.color.stroke;
        if (node.color.fill) shapeAttrs['bioc:fill'] = node.color.fill;
      }

      const shape = create('bpmndi:BPMNShape', shapeAttrs);

      // Label bounds for events/gateways
      if ((isEvent(node.type) || isGateway(node.type)) && node.name) {
        const labelW = Math.min(node.name.length * 6.5 + 10, 90);
        const labelX = c.x + c.w / 2 - labelW / 2;
        const labelY = c.y + c.h + LABEL_DISTANCE;
        shape.label = create('bpmndi:BPMNLabel', {
          bounds: create('dc:Bounds', { x: rn(labelX), y: rn(labelY), width: rn(labelW), height: 20 }),
        });
      }
      planeElements.push(shape);

      // Expanded SubProcess children DI
      if (node.isExpanded && node.nodes) {
        for (const child of node.nodes) {
          const cc = coords[child.id];
          if (!cc) continue;
          const childShapeAttrs = {
            id: `${child.id}_di`,
            bpmnElement: allFlowNodeMaps.get(child.id) || child.id,
            bounds: create('dc:Bounds', { x: rn(cc.x), y: rn(cc.y), width: rn(cc.w), height: rn(cc.h) }),
          };
          if (child.type === 'exclusiveGateway') childShapeAttrs.isMarkerVisible = true;
          if (child.color) {
            if (child.color.stroke) childShapeAttrs['bioc:stroke'] = child.color.stroke;
            if (child.color.fill) childShapeAttrs['bioc:fill'] = child.color.fill;
          }
          const childShape = create('bpmndi:BPMNShape', childShapeAttrs);
          if ((isEvent(child.type) || isGateway(child.type)) && child.name) {
            const clw = Math.min(child.name.length * 6.5 + 10, 90);
            const clx = cc.x + cc.w / 2 - clw / 2;
            const cly = cc.y + cc.h + LABEL_DISTANCE;
            childShape.label = create('bpmndi:BPMNLabel', {
              bounds: create('dc:Bounds', { x: rn(clx), y: rn(cly), width: rn(clw), height: 20 }),
            });
          }
          planeElements.push(childShape);
        }
        // SubProcess edge DI
        for (const subEdge of (node.edges || [])) {
          const seid = subEdge.id || `flow_${subEdge.source}_${subEdge.target}`;
          const spts = edgeCoords[seid] || [];
          const waypoints = buildWaypoints(spts, coords, subEdge.source, subEdge.target);
          planeElements.push(create('bpmndi:BPMNEdge', {
            id: `${seid}_di`,
            bpmnElement: allFlowNodeMaps.get(seid) || seid,
            waypoint: waypoints,
          }));
        }
      }
    }
  }

  // Edge DI
  for (const proc of (lc.pools || [lc])) {
    for (const edge of (proc.edges || [])) {
      const eid = edge.id || `flow_${edge.source}_${edge.target}`;
      const pts = edgeCoords[eid] || [];
      const waypoints = buildWaypoints(pts, coords, edge.source, edge.target);
      // DI requires at least two waypoints. Reachable when an endpoint has no
      // geometry at all — e.g. a boundary event whose attachedTo points nowhere.
      if (waypoints.length < 2) continue;
      const edgeEl = create('bpmndi:BPMNEdge', {
        id: `${eid}_di`,
        bpmnElement: allFlowNodeMaps.get(eid) || eid,
        waypoint: waypoints,
      });

      // Edge label
      if (edge.label && pts.length >= 2) {
        let lx, ly, found = false;
        for (let i = 0; i < pts.length - 1; i++) {
          if (Math.abs(pts[i + 1].y - pts[i].y) < 1) {
            lx = (pts[i].x + pts[i + 1].x) / 2;
            ly = pts[i].y - 5;
            found = true;
            break;
          }
        }
        if (!found) { lx = pts[1].x; ly = pts[1].y - 5; }
        const lw = edge.label.length * 6.5 + 8;
        edgeEl.label = create('bpmndi:BPMNLabel', {
          bounds: create('dc:Bounds', { x: rn(lx - lw / 2), y: rn(ly - 8), width: rn(lw), height: 16 }),
        });
      }
      planeElements.push(edgeEl);
    }
  }

  // Message flow DI — direction-aware ports
  if (lc.messageFlows) {
    for (const mf of lc.messageFlows) {
      // Route comes from coordinates.js §5.4 — same source as the SVG, so the
      // two can no longer diverge.
      const pts = edgeCoords[mf.id || `mf_${mf.source}_${mf.target}`] || [];
      // DI requires at least two waypoints; emitting fewer produces XML that no
      // tool can read. Better no DI edge than an invalid one.
      if (pts.length < 2) continue;
      const waypoints = pts.map(p => create('dc:Point', { x: rn(p.x), y: rn(p.y) }));
      planeElements.push(create('bpmndi:BPMNEdge', {
        id: `${mf.id}_di`,
        bpmnElement: allFlowNodeMaps.get(mf.id) || mf.id,
        waypoint: waypoints,
      }));
    }
  }

  // Association DI — route from coordinates.js §5.4, clipped to both shapes.
  for (const assoc of associations) {
    const pts = edgeCoords[assoc.id] || [];
    if (pts.length < 2) continue;
    planeElements.push(create('bpmndi:BPMNEdge', {
      id: `${assoc.id}_di`,
      bpmnElement: allFlowNodeMaps.get(assoc.id) || assoc.id,
      waypoint: pts.map(p => create('dc:Point', { x: rn(p.x), y: rn(p.y) })),
    }));
  }

  // Assign planeElements
  for (const pe of planeElements) {
    plane.get('planeElement').push(pe);
  }

  return create('bpmndi:BPMNDiagram', { id: 'BPMNDiagram_1', plane });
}

function buildLaneDI(lanes, laneCoords, planeElements, allFlowNodeMaps) {
  for (const lane of lanes) {
    const lcc = laneCoords[lane.id];
    if (lcc) {
      planeElements.push(create('bpmndi:BPMNShape', {
        id: `${lane.id}_di`,
        bpmnElement: allFlowNodeMaps.get(lane.id) || lane.id,
        isHorizontal: true,
        bounds: create('dc:Bounds', { x: rn(lcc.x), y: rn(lcc.y), width: rn(lcc.w), height: rn(lcc.h) }),
      }));
    }
    if (lane.children?.length) {
      buildLaneDI(lane.children, laneCoords, planeElements, allFlowNodeMaps);
    }
  }
}

function buildWaypoints(pts, coords, sourceId, targetId) {
  if (pts.length >= 2) {
    return pts.map(p => create('dc:Point', { x: rn(p.x), y: rn(p.y) }));
  }
  const s = coords[sourceId], t = coords[targetId];
  if (s && t) {
    return [
      create('dc:Point', { x: rn(s.x + s.w / 2), y: rn(s.y + s.h / 2) }),
      create('dc:Point', { x: rn(t.x + t.w / 2), y: rn(t.y + t.h / 2) }),
    ];
  }
  return [];
}

function resolveMessageFlowRef(ref, processes, collapsedPools, participantMap) {
  for (const p of processes) {
    if (p.id === ref) return participantMap.get(ref);
  }
  for (const cp of (collapsedPools || [])) {
    if (cp.id === ref) return participantMap.get(ref);
  }
  // Must be a node id — return string (will be resolved from flowNodeMap)
  return ref;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════

async function generateBpmnXml(lc, coordMap) {
  const isMultiPool = lc.pools && lc.pools.length > 0;
  const processes = isMultiPool ? lc.pools : [lc];
  const collapsedPools = lc.collapsedPools || [];
  const associations = lc.associations || [];
  const hasAnyLanes = processes.some(p => (p.lanes || []).length > 0);
  const needsCollaboration = isMultiPool || hasAnyLanes || collapsedPools.length > 0;

  // 1. Top-level definitions
  const { elements: topLevelElements, markerMap: topLevelDefsMap } =
    buildTopLevelDefinitions(processes, lc.definitions);

  // 2. Build processes
  const allFlowNodeMaps = new Map();
  const processElements = [];
  const categoryElements = [];
  for (const proc of processes) {
    // Need to infer gateway directions before building default flow map
    inferGatewayDirections(proc.nodes || [], proc.edges || []);
    const defaultFlowMap = buildDefaultFlowMap(proc);
    const { process: processEl, flowNodeMap, categories } = buildProcess(proc, defaultFlowMap, topLevelDefsMap);
    processElements.push(processEl);
    categoryElements.push(...categories);
    for (const [k, v] of flowNodeMap) allFlowNodeMaps.set(k, v);
    // Also register sequence flows
    for (const fe of processEl.get('flowElements')) {
      if (fe.$type === 'bpmn:SequenceFlow') allFlowNodeMaps.set(fe.id, fe);
    }
  }

  // 3. Collaboration
  let collaboration = null;
  const participantMap = new Map();
  if (needsCollaboration) {
    collaboration = create('bpmn:Collaboration', { id: 'Collaboration_1' });
    const participants = [];

    for (let i = 0; i < processes.length; i++) {
      const proc = processes[i];
      const part = create('bpmn:Participant', {
        id: `Participant_${proc.id}`,
        name: proc.name || '',
        processRef: processElements[i],
      });
      participants.push(part);
      participantMap.set(proc.id, part);
    }

    for (const cp of collapsedPools) {
      const part = create('bpmn:Participant', {
        id: `Participant_${cp.id}`,
        name: cp.name || '',
      });
      participants.push(part);
      participantMap.set(cp.id, part);
    }

    // Message flows
    if (lc.messageFlows) {
      const msgFlows = [];
      for (const mf of lc.messageFlows) {
        const srcRef = participantMap.get(mf.source) || allFlowNodeMaps.get(mf.source) || mf.source;
        const tgtRef = participantMap.get(mf.target) || allFlowNodeMaps.get(mf.target) || mf.target;
        const msgFlow = create('bpmn:MessageFlow', {
          id: mf.id,
          name: mf.name || '',
          sourceRef: srcRef,
          targetRef: tgtRef,
        });
        msgFlows.push(msgFlow);
        allFlowNodeMaps.set(mf.id, msgFlow);
      }
      collaboration.messageFlows = msgFlows;
    }

    collaboration.participants = participants;
  }

  // 4. Associations (at process level)
  for (const assoc of associations) {
    for (const processEl of processElements) {
      // Search flowElements AND artifacts: an association's whole job is to tie
      // an annotation to something, and annotations live in artifacts. Looking
      // in flowElements alone would drop exactly the associations that matter.
      const owned = [...processEl.get('flowElements'), ...processEl.get('artifacts')];
      const srcInProc = owned.some(fe => fe.id === assoc.source);
      const tgtInProc = owned.some(fe => fe.id === assoc.target);
      if (srcInProc || tgtInProc) {
        const dir = assoc.directed ? 'One' : undefined;
        const assocEl = create('bpmn:Association', {
          id: assoc.id,
          sourceRef: allFlowNodeMaps.get(assoc.source) || assoc.source,
          targetRef: allFlowNodeMaps.get(assoc.target) || assoc.target,
          associationDirection: dir,
        });
        processEl.get('artifacts').push(assocEl);
        allFlowNodeMaps.set(assoc.id, assocEl);
        break;
      }
    }
  }

  // 5. Register lane elements in allFlowNodeMaps (for DI bpmnElement refs)
  for (const proc of processes) {
    registerLaneRefs(proc.lanes || [], processElements, allFlowNodeMaps);
  }

  // 6. DI
  const diagram = buildDI(lc, coordMap, processElements, collaboration, allFlowNodeMaps, []);

  // 7. Assemble definitions
  const definitions = create('bpmn:Definitions', {
    id: 'Definitions_1',
    targetNamespace: 'http://bpmn.io/schema/bpmn',
  });

  const rootElements = definitions.get('rootElements');

  // Top-level definitions first
  for (const el of topLevelElements) rootElements.push(el);

  // Categories carry the Groups' labels and must be resolvable when the
  // Groups' categoryValueRef is read, so they go in ahead of the processes.
  for (const category of categoryElements) rootElements.push(category);

  // Collaboration before processes
  if (collaboration) rootElements.push(collaboration);

  // Processes
  for (const pe of processElements) rootElements.push(pe);

  // Diagram
  definitions.get('diagrams').push(diagram);

  // 8. Serialize
  const { xml } = await moddle.toXML(definitions, { format: true, preamble: true });
  return xml;
}

function registerLaneRefs(lanes, processElements, allFlowNodeMaps) {
  for (const lane of lanes) {
    // Find the lane moddle element in the process
    for (const proc of processElements) {
      const laneSets = proc.get('laneSets');
      const found = findLaneInSets(laneSets, lane.id);
      if (found) {
        allFlowNodeMaps.set(lane.id, found);
        break;
      }
    }
    if (lane.children?.length) {
      registerLaneRefs(lane.children, processElements, allFlowNodeMaps);
    }
  }
}

function findLaneInSets(laneSets, laneId) {
  for (const ls of (laneSets || [])) {
    for (const lane of (ls.get('lanes') || [])) {
      if (lane.id === laneId) return lane;
      if (lane.childLaneSet) {
        const found = findLaneInSets([lane.childLaneSet], laneId);
        if (found) return found;
      }
    }
  }
  return null;
}

/**
 * Round-trip validate BPMN XML by parsing it back through moddle.
 * @param {string} xml - BPMN 2.0 XML string
 * @returns {Promise<{valid: boolean, warnings: string[]}>}
 */
async function validateBpmnXml(xml) {
  const { warnings } = await moddle.fromXML(xml);
  return {
    valid: warnings.length === 0,
    warnings: warnings.map(w => w.message || String(w)),
  };
}

export { generateBpmnXml, validateBpmnXml };
