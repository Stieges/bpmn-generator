/**
 * bpmn-moddle Import Adapter
 * Converts BPMN 2.0 XML → Logic-Core JSON using bpmn-moddle's typed object tree.
 *
 * Replaces the custom XML parser with a standards-compliant CMOF-derived parser
 * that preserves all attributes (including unknown/extension attributes via $attrs).
 */

import { BpmnModdle } from 'bpmn-moddle';

const moddle = new BpmnModdle();

const FLOW_NODE_TYPES = new Set([
  'bpmn:StartEvent', 'bpmn:EndEvent', 'bpmn:IntermediateCatchEvent', 'bpmn:IntermediateThrowEvent', 'bpmn:BoundaryEvent',
  'bpmn:Task', 'bpmn:UserTask', 'bpmn:ServiceTask', 'bpmn:ScriptTask', 'bpmn:SendTask', 'bpmn:ReceiveTask',
  'bpmn:ManualTask', 'bpmn:BusinessRuleTask', 'bpmn:CallActivity', 'bpmn:SubProcess', 'bpmn:Transaction',
  'bpmn:ExclusiveGateway', 'bpmn:ParallelGateway', 'bpmn:InclusiveGateway', 'bpmn:EventBasedGateway', 'bpmn:ComplexGateway',
  'bpmn:DataObjectReference', 'bpmn:DataStoreReference', 'bpmn:TextAnnotation', 'bpmn:Group',
]);

const EVENT_DEF_MAP = {
  'bpmn:MessageEventDefinition': 'message',
  'bpmn:TimerEventDefinition': 'timer',
  'bpmn:ErrorEventDefinition': 'error',
  'bpmn:SignalEventDefinition': 'signal',
  'bpmn:EscalationEventDefinition': 'escalation',
  'bpmn:CompensateEventDefinition': 'compensation',
  'bpmn:ConditionalEventDefinition': 'conditional',
  'bpmn:LinkEventDefinition': 'link',
  'bpmn:CancelEventDefinition': 'cancel',
  'bpmn:TerminateEventDefinition': 'terminate',
};

/**
 * Parse BPMN XML using bpmn-moddle.
 * @param {string} xml - BPMN 2.0 XML string
 * @returns {Promise<{rootElement: object, warnings: string[]}>}
 */
async function moddleParse(xml) {
  const { rootElement, warnings } = await moddle.fromXML(xml);
  return { rootElement, warnings: warnings.map(w => w.message || String(w)) };
}

/**
 * Convert bpmn-moddle root element to Logic-Core JSON.
 * @param {object} definitions - bpmn:Definitions moddle element
 * @returns {object} Logic-Core JSON
 */
function moddleToLogicCore(definitions) {
  const collaboration = definitions.rootElements?.find(e => e.$type === 'bpmn:Collaboration');
  const processes = definitions.rootElements?.filter(e => e.$type === 'bpmn:Process') || [];

  // Build participant → process mapping
  const participants = collaboration?.participants || [];
  const partMap = {};
  for (const p of participants) {
    partMap[p.id] = {
      processRef: p.processRef?.id || null,
      name: p.name || '',
      id: p.id,
    };
  }

  // Identify collapsed/expanded pools
  const processIds = new Set(processes.map(p => p.id));
  const expandedParts = participants.filter(p => p.processRef && processIds.has(p.processRef.id));
  const collapsedParts = participants.filter(p => !p.processRef || !processIds.has(p.processRef.id));
  const isMultiPool = expandedParts.length > 1 || collapsedParts.length > 0;

  // Whether a subprocess is drawn open or collapsed is recorded in the DI, on
  // BPMNShape.isExpanded — not by whether it happens to contain flowElements.
  // Inferring it from content presence (the previous behaviour) turns every
  // legitimately collapsed-but-drillable subprocess into an expanded one on
  // re-import, and silently changes the diagram.
  const expandedIds = new Set();
  for (const diElement of definitions.diagrams?.[0]?.plane?.planeElement || []) {
    if (diElement.$type === 'bpmndi:BPMNShape' && diElement.isExpanded === true) {
      const id = diElement.bpmnElement?.id ?? diElement.bpmnElement;
      if (id) expandedIds.add(id);
    }
  }

  // Convert each process
  const pools = processes.map(proc => convertProcess(proc, partMap, expandedIds));

  // Collapsed pools
  const collapsedPools = collapsedParts.map(p => ({
    id: p.processRef?.id || p.id.replace('Participant_', ''),
    name: p.name || '',
  }));

  // Message flows
  const messageFlows = (collaboration?.messageFlows || []).map(mf => ({
    id: mf.id,
    name: mf.name || '',
    source: resolveParticipantRef(mf.sourceRef?.id, partMap),
    target: resolveParticipantRef(mf.targetRef?.id, partMap),
  }));

  // Top-level definitions (error, message, signal, escalation)
  const topLevelDefs = [];
  for (const el of definitions.rootElements || []) {
    if (el.$type === 'bpmn:Error') {
      const def = { type: 'error', id: el.id, name: el.name || '' };
      if (el.errorCode) def.errorCode = el.errorCode;
      topLevelDefs.push(def);
    } else if (el.$type === 'bpmn:Message') {
      topLevelDefs.push({ type: 'message', id: el.id, name: el.name || '' });
    } else if (el.$type === 'bpmn:Signal') {
      topLevelDefs.push({ type: 'signal', id: el.id, name: el.name || '' });
    } else if (el.$type === 'bpmn:Escalation') {
      const def = { type: 'escalation', id: el.id, name: el.name || '' };
      if (el.escalationCode) def.escalationCode = el.escalationCode;
      topLevelDefs.push(def);
    }
  }

  // Associations
  const associations = [];
  for (const proc of processes) {
    for (const art of proc.artifacts || []) {
      if (art.$type === 'bpmn:Association') {
        associations.push({
          id: art.id,
          source: art.sourceRef?.id || art.sourceRef,
          target: art.targetRef?.id || art.targetRef,
          directed: art.associationDirection === 'One',
        });
      }
    }
  }

  // Parse bioc: colors from DI
  const diagram = definitions.diagrams?.[0];
  const plane = diagram?.plane;
  if (plane) {
    for (const diElement of plane.planeElement || []) {
      if (diElement.$type === 'bpmndi:BPMNShape') {
        const bpmnElement = diElement.bpmnElement?.id;
        const biocStroke = diElement.$attrs?.['bioc:stroke'];
        const biocFill = diElement.$attrs?.['bioc:fill'];
        if (bpmnElement && (biocStroke || biocFill)) {
          for (const pool of pools) {
            const node = (pool.nodes || []).find(n => n.id === bpmnElement);
            if (node) {
              node.color = {};
              if (biocStroke) node.color.stroke = biocStroke;
              if (biocFill) node.color.fill = biocFill;
              break;
            }
          }
        }
      }
    }
  }

  // Build output
  if (isMultiPool || pools.length > 1) {
    const result = { pools, collapsedPools, messageFlows };
    if (associations.length > 0) result.associations = associations;
    if (topLevelDefs.length > 0) result.definitions = topLevelDefs;
    return result;
  } else if (pools.length === 1) {
    const result = pools[0];
    if (associations.length > 0) result.associations = associations;
    if (topLevelDefs.length > 0) result.definitions = topLevelDefs;
    return result;
  }

  return { id: 'Process_1', name: 'Empty', nodes: [], edges: [], lanes: [] };
}

function convertProcess(proc, partMap, expandedIds = new Set()) {
  const processId = proc.id;
  const processName = proc.name || findPartNameForProcess(processId, partMap) || processId;
  const documentation = proc.documentation?.[0]?.text || undefined;

  // Lanes (recursive)
  const lanes = [];
  const nodeLaneMap = {};
  if (proc.laneSets?.length) {
    for (const laneSet of proc.laneSets) {
      parseLanes(laneSet, lanes, nodeLaneMap);
    }
  }

  // Flow nodes
  const nodes = [];
  const flowNodeTags = new Set([
    'startEvent', 'endEvent', 'intermediateCatchEvent', 'intermediateThrowEvent', 'boundaryEvent',
    'task', 'userTask', 'serviceTask', 'scriptTask', 'sendTask', 'receiveTask',
    'manualTask', 'businessRuleTask', 'callActivity', 'subProcess', 'transaction',
    'exclusiveGateway', 'parallelGateway', 'inclusiveGateway', 'eventBasedGateway', 'complexGateway',
    'dataObjectReference', 'dataStoreReference', 'textAnnotation', 'group',
  ]);

  /**
   * One moddle flow element → one Logic-Core node, recursively.
   *
   * The mirror image of buildFlowNode in bpmn-xml.js, and it exists for the same
   * reason: the child branch here used to read back only {id, type, name, marker},
   * so documentation, loop/multi-instance, script, calledElement and attachedTo
   * were dropped on import even once the exporter emitted them. Export and import
   * have to agree field for field, or the round trip loses data in one direction
   * while both sides individually look fine.
   */
  const nodeFromElement = (el) => {
    const type = shortType(el.$type);
    const node = { id: el.id, type, name: el.name || '' };

    // Lane assignment
    if (nodeLaneMap[node.id]) node.lane = nodeLaneMap[node.id];

    // Documentation
    if (el.documentation?.[0]?.text) node.documentation = el.documentation[0].text;

    // Gateway direction
    if (el.gatewayDirection === 'Converging') node.has_join = true;

    // Boundary event
    if (el.attachedToRef) {
      node.attachedTo = el.attachedToRef.id || el.attachedToRef;
      if (el.cancelActivity === false) node.cancelActivity = false;
    }

    // Event markers + details
    const markerInfo = detectEventMarkerModdle(el);
    if (markerInfo.marker) node.marker = markerInfo.marker;
    if (markerInfo.linkName) node.linkName = markerInfo.linkName;
    if (markerInfo.conditionExpression) node.conditionExpression = markerInfo.conditionExpression;
    if (markerInfo.timerExpression) node.timerExpression = markerInfo.timerExpression;

    // isForCompensation
    if (el.isForCompensation === true) node.isCompensation = true;

    // isCollection on dataObjectReference
    if (el.isCollection === true) node.isCollection = true;

    // CallActivity: calledElement
    if (type === 'callActivity' && el.calledElement) node.calledElement = el.calledElement;

    // ScriptTask: scriptFormat + script body
    if (type === 'scriptTask') {
      if (el.scriptFormat) node.scriptFormat = el.scriptFormat;
      if (el.script) node.script = el.script;
    }

    // Implementation (skip defaults)
    if (el.implementation && el.implementation !== '##WebService' && el.implementation !== '##unspecified') {
      node.implementation = el.implementation;
    }

    // decisionRef out of our own extensionElements. Matched on the local name so
    // a file written with a different prefix for the same namespace still reads.
    const decisionRefEl = (el.extensionElements?.values ?? [])
      .find(v => v.$type?.split(':').pop() === 'decisionRef');
    if (decisionRefEl?.$body) node.decisionRef = decisionRefEl.$body;

    // EventBasedGateway
    if (type === 'eventBasedGateway') {
      if (el.eventGatewayType && el.eventGatewayType !== 'Exclusive') node.eventGatewayType = el.eventGatewayType;
      if (el.instantiate === true) node.instantiate = true;
    }

    // Event SubProcess
    if (type === 'subProcess' && el.triggeredByEvent === true) node.isEventSubProcess = true;

    // Loop / Multi-instance
    if (el.loopCharacteristics) {
      const lc = el.loopCharacteristics;
      if (lc.$type === 'bpmn:StandardLoopCharacteristics') {
        const loopCond = lc.loopCondition?.body;
        if (loopCond || lc.testBefore || lc.loopMaximum != null) {
          node.loopType = {};
          if (loopCond) node.loopType.loopCondition = loopCond;
          if (lc.testBefore === true) node.loopType.testBefore = true;
          if (lc.loopMaximum != null) node.loopType.loopMaximum = parseInt(lc.loopMaximum, 10);
        } else {
          node.loopType = 'standard';
        }
      } else if (lc.$type === 'bpmn:MultiInstanceLoopCharacteristics') {
        const miType = lc.isSequential === true ? 'sequential' : 'parallel';
        const loopCard = lc.loopCardinality?.body;
        const completionCond = lc.completionCondition?.body;
        if (loopCard || completionCond) {
          node.multiInstance = { type: miType };
          if (loopCard) node.multiInstance.loopCardinality = loopCard;
          if (completionCond) node.multiInstance.completionCondition = completionCond;
        } else {
          node.multiInstance = miType;
        }
      }
    }

    // SubProcess content — read whether or not the shape is expanded, and
    // recursively, so a subprocess inside a subprocess keeps its own children.
    if ((type === 'subProcess' || type === 'transaction') && el.flowElements?.length) {
      const subFlowNodes = el.flowElements.filter(c => flowNodeTags.has(shortType(c.$type)));
      const subSeqFlows = el.flowElements.filter(c => c.$type === 'bpmn:SequenceFlow');
      if (subFlowNodes.length > 0) {
        node.nodes = subFlowNodes.map(nodeFromElement);
        node.edges = subSeqFlows.map(sf => {
          const se = { id: sf.id, source: sf.sourceRef?.id || sf.sourceRef, target: sf.targetRef?.id || sf.targetRef };
          if (sf.name) se.label = sf.name;
          return se;
        });
      }
      if (expandedIds.has(el.id)) node.isExpanded = true;
    }

    // Preserve unknown extension attributes for round-trip (Phase B)
    if (el.$attrs && Object.keys(el.$attrs).length > 0) {
      if (!node.extensions) node.extensions = {};
      node.extensions.$attrs = { ...el.$attrs };
    }

    return node;
  };

  for (const el of proc.flowElements || []) {
    if (!flowNodeTags.has(shortType(el.$type))) continue;
    nodes.push(nodeFromElement(el));
  }

  // Artifacts. bpmn-moddle parks TextAnnotation and Group in proc.artifacts, not
  // in proc.flowElements — they are Artifacts, not FlowElements — so the loop
  // above never sees them. Skipping this dropped every annotation and group on
  // import and left their associations pointing at ids that no longer existed.
  for (const el of proc.artifacts || []) {
    const type = shortType(el.$type);
    if (type !== 'textAnnotation' && type !== 'group') continue;

    // Logic-Core keeps every label in `name`; BPMN splits it per artifact class.
    // The fallback reads $attrs because `name` is not in the Artifact descriptor:
    // moddle cannot map it onto the element and parks it there instead — the very
    // behaviour that let the old, invalid output pass unnoticed. Files written
    // before the fix are recovered through exactly that channel.
    let name = el.name || el.$attrs?.name || '';
    if (type === 'textAnnotation') name = el.text || name;
    if (type === 'group') name = el.categoryValueRef?.value || name;

    const node = { id: el.id, type, name };
    if (nodeLaneMap[node.id]) node.lane = nodeLaneMap[node.id];
    if (el.documentation?.[0]?.text) node.documentation = el.documentation[0].text;
    nodes.push(node);
  }

  // Sequence flows
  const edges = [];
  for (const el of proc.flowElements || []) {
    if (el.$type !== 'bpmn:SequenceFlow') continue;
    const edge = {
      id: el.id,
      source: el.sourceRef?.id || el.sourceRef,
      target: el.targetRef?.id || el.targetRef,
    };
    if (el.name) edge.label = el.name;

    // Condition expression
    if (el.conditionExpression?.body) edge.condition = el.conditionExpression.body;

    // Default flow detection
    for (const other of proc.flowElements || []) {
      if (other.default?.id === el.id || other.default === el.id) {
        edge.isDefault = true;
        break;
      }
    }

    edges.push(edge);
  }

  const result = { id: processId, name: processName, nodes, edges, lanes };
  if (documentation) result.documentation = documentation;
  return result;
}

function parseLanes(laneSet, lanes, nodeLaneMap) {
  for (const lane of laneSet.lanes || []) {
    const laneObj = { id: lane.id, name: lane.name || lane.id };
    // Nested lanes via childLaneSet
    if (lane.childLaneSet) {
      laneObj.children = [];
      parseLanes(lane.childLaneSet, laneObj.children, nodeLaneMap);
    }
    lanes.push(laneObj);
    for (const ref of lane.flowNodeRef || []) {
      const refId = ref.id || ref;
      nodeLaneMap[refId] = lane.id;
    }
  }
}

function detectEventMarkerModdle(element) {
  const result = { marker: null };
  const eventDefs = element.eventDefinitions || [];
  if (eventDefs.length === 0) return result;

  const def = eventDefs[0];
  const marker = EVENT_DEF_MAP[def.$type];
  if (!marker) return result;

  result.marker = marker;

  // Link event: extract name
  if (def.$type === 'bpmn:LinkEventDefinition' && def.name) {
    result.linkName = def.name;
  }

  // Conditional event: extract condition
  if (def.$type === 'bpmn:ConditionalEventDefinition' && def.condition?.body) {
    result.conditionExpression = def.condition.body;
  }

  // Timer event: extract time expression
  if (def.$type === 'bpmn:TimerEventDefinition') {
    if (def.timeDate?.body) result.timerExpression = { type: 'date', value: def.timeDate.body };
    else if (def.timeDuration?.body) result.timerExpression = { type: 'duration', value: def.timeDuration.body };
    else if (def.timeCycle?.body) result.timerExpression = { type: 'cycle', value: def.timeCycle.body };
  }

  return result;
}

function resolveParticipantRef(ref, partMap) {
  if (partMap[ref]) {
    return partMap[ref].processRef || ref.replace('Participant_', '');
  }
  return ref;
}

function findPartNameForProcess(processId, partMap) {
  for (const p of Object.values(partMap)) {
    if (p.processRef === processId) return p.name;
  }
  return null;
}

function shortType(moddleType) {
  // 'bpmn:UserTask' → 'userTask'
  const name = moddleType.replace(/^bpmn:/, '');
  return name.charAt(0).toLowerCase() + name.slice(1);
}

export { moddleParse, moddleToLogicCore };
