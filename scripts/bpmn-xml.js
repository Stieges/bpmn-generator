/**
 * BPMN 2.0 XML Generation via bpmn-moddle
 * Uses bpmn-moddle's typed CMOF object model + toXML() for OMG-compliant serialization.
 * Replaces the legacy string-concatenation approach.
 *
 * Signature: generateBpmnXml(lc, coordMap) → Promise<string>
 */

import BpmnModdle from 'bpmn-moddle';
import { isEvent, isGateway, isBoundaryEvent, bpmnXmlTag } from './types.js';
import { rn, LANE_HEADER_W, LABEL_DISTANCE } from './utils.js';
import { inferGatewayDirections } from './topology.js';
import { inferEventMarker } from './icons.js';

const moddle = new BpmnModdle();

/** Helper: create a moddle element with shorthand */
function create(type, attrs = {}) {
  return moddle.create(type, attrs);
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

  // Create flow nodes
  for (const node of nodes) {
    const type = moddleType(node.type);
    const attrs = { id: node.id, name: node.name || '' };

    // Gateway direction
    if (isGateway(node.type) && node._direction) {
      attrs.gatewayDirection = node._direction;
    }

    // Boundary event
    if (isBoundaryEvent(node)) {
      // attachedToRef will be resolved after all nodes are created
      if (node.cancelActivity === false) attrs.cancelActivity = false;
    }

    // Special attributes
    if (node.isCompensation) attrs.isForCompensation = true;
    if (node.isCollection && node.type === 'dataObjectReference') attrs.isCollection = true;
    if (node.isEventSubProcess && node.type === 'subProcess') attrs.triggeredByEvent = true;
    if (node.calledElement && node.type === 'callActivity') attrs.calledElement = node.calledElement;
    if (node.scriptFormat && node.type === 'scriptTask') attrs.scriptFormat = node.scriptFormat;
    if (node.implementation) attrs.implementation = node.implementation;
    if (node.type === 'eventBasedGateway') {
      if (node.eventGatewayType) attrs.eventGatewayType = node.eventGatewayType;
      if (node.instantiate) attrs.instantiate = true;
    }

    const el = create(type, attrs);

    // Documentation
    if (node.documentation) {
      el.get('documentation').push(create('bpmn:Documentation', { text: node.documentation }));
    }

    // Event definitions (only Event types have this property, not SubProcess)
    const eventDef = buildEventDefinition(node, topLevelDefsMap);
    if (eventDef && el.$descriptor.properties.some(p => p.name === 'eventDefinitions')) {
      el.get('eventDefinitions').push(eventDef);
    }

    // Loop / Multi-instance
    if (node.loopType) {
      const loopAttrs = {};
      if (typeof node.loopType === 'object') {
        if (node.loopType.testBefore) loopAttrs.testBefore = true;
        if (node.loopType.loopMaximum != null) loopAttrs.loopMaximum = node.loopType.loopMaximum;
        if (node.loopType.loopCondition) {
          loopAttrs.loopCondition = create('bpmn:FormalExpression', { body: node.loopType.loopCondition });
        }
      }
      el.loopCharacteristics = create('bpmn:StandardLoopCharacteristics', loopAttrs);
    } else if (node.multiInstance) {
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

    // Script body
    if (node.type === 'scriptTask' && node.script) {
      el.script = node.script;
    }

    // Expanded SubProcess: add child elements
    if (node.isExpanded && node.nodes && node.nodes.length > 0) {
      const childNodeMap = new Map();
      for (const child of node.nodes) {
        const childType = moddleType(child.type);
        const childEl = create(childType, { id: child.id, name: child.name || '' });
        const childEventDef = buildEventDefinition(child, topLevelDefsMap);
        if (childEventDef && childEl.$descriptor.properties.some(p => p.name === 'eventDefinitions')) {
          childEl.get('eventDefinitions').push(childEventDef);
        }
        childNodeMap.set(child.id, childEl);
        el.get('flowElements').push(childEl);
        flowNodeMap.set(child.id, childEl);
      }
      for (const subEdge of (node.edges || [])) {
        const seid = subEdge.id || `flow_${subEdge.source}_${subEdge.target}`;
        const seAttrs = { id: seid };
        if (subEdge.label) seAttrs.name = subEdge.label;
        seAttrs.sourceRef = childNodeMap.get(subEdge.source);
        seAttrs.targetRef = childNodeMap.get(subEdge.target);
        const seFlow = create('bpmn:SequenceFlow', seAttrs);
        el.get('flowElements').push(seFlow);
        flowNodeMap.set(seid, seFlow);
      }
    }

    flowNodeMap.set(node.id, el);
    flowElements.push(el);
  }

  // Resolve boundary event attachedToRef
  for (const node of nodes) {
    if (isBoundaryEvent(node) && node.attachedTo) {
      const el = flowNodeMap.get(node.id);
      const attachedEl = flowNodeMap.get(node.attachedTo);
      if (el && attachedEl) el.attachedToRef = attachedEl;
    }
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

  // Data objects
  for (const node of nodes) {
    if (node.type === 'dataObjectReference') {
      flowElements.push(create('bpmn:DataObject', { id: `${node.id}_do` }));
    }
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

  return { process: processEl, flowNodeMap };
}

function buildLane(lane, nodes, flowNodeMap) {
  const laneEl = create('bpmn:Lane', { id: lane.id, name: lane.name || lane.id });
  const refs = nodes.filter(n => n.lane === lane.id).map(n => flowNodeMap.get(n.id)).filter(Boolean);
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
          px = Math.min(...lcs.map(l => l.x)) - LANE_HEADER_W;
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

  // Message flow DI
  if (lc.messageFlows) {
    for (const mf of lc.messageFlows) {
      const srcCoord = coords[mf.source] || poolCoords[mf.source];
      const tgtCoord = coords[mf.target] || poolCoords[mf.target];
      const waypoints = [];
      if (srcCoord && tgtCoord) {
        waypoints.push(create('dc:Point', {
          x: rn((srcCoord.x || 0) + (srcCoord.w || 0) / 2),
          y: rn((srcCoord.y || 0) + (srcCoord.h || 0)),
        }));
        waypoints.push(create('dc:Point', {
          x: rn((tgtCoord.x || 0) + (tgtCoord.w || 0) / 2),
          y: rn(tgtCoord.y || 0),
        }));
      }
      planeElements.push(create('bpmndi:BPMNEdge', {
        id: `${mf.id}_di`,
        bpmnElement: allFlowNodeMaps.get(mf.id) || mf.id,
        waypoint: waypoints,
      }));
    }
  }

  // Association DI
  for (const assoc of associations) {
    const srcC = coords[assoc.source];
    const tgtC = coords[assoc.target];
    if (srcC && tgtC) {
      planeElements.push(create('bpmndi:BPMNEdge', {
        id: `${assoc.id}_di`,
        bpmnElement: allFlowNodeMaps.get(assoc.id) || assoc.id,
        waypoint: [
          create('dc:Point', { x: rn(srcC.x + srcC.w / 2), y: rn(srcC.y + srcC.h / 2) }),
          create('dc:Point', { x: rn(tgtC.x + tgtC.w / 2), y: rn(tgtC.y + tgtC.h / 2) }),
        ],
      }));
    }
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
  for (const proc of processes) {
    // Need to infer gateway directions before building default flow map
    inferGatewayDirections(proc.nodes || [], proc.edges || []);
    const defaultFlowMap = buildDefaultFlowMap(proc);
    const { process: processEl, flowNodeMap } = buildProcess(proc, defaultFlowMap, topLevelDefsMap);
    processElements.push(processEl);
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
      const flowEls = processEl.get('flowElements');
      const srcInProc = flowEls.some(fe => fe.id === assoc.source);
      const tgtInProc = flowEls.some(fe => fe.id === assoc.target);
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

export { generateBpmnXml };
