/**
 * BPMN 2.0 XML Generation (OMG-compliant)
 * Produces valid BPMN 2.0.2 XML with DI (Diagram Interchange).
 */

import { isEvent, isGateway, isBoundaryEvent, bpmnXmlTag } from './types.js';
import { esc, rn, LANE_HEADER_W, LABEL_DISTANCE } from './utils.js';
import { inferGatewayDirections } from './topology.js';
import { inferEventMarker } from './icons.js';

function biocAttrs(node) {
  if (!node?.color) return '';
  let a = '';
  if (node.color.stroke) a += ` bioc:stroke="${node.color.stroke}"`;
  if (node.color.fill) a += ` bioc:fill="${node.color.fill}"`;
  return a;
}

function generateBpmnXml(lc, coordMap) {
  const { coords, laneCoords, poolCoords, edgeCoords } = coordMap;
  const isMultiPool = lc.pools && lc.pools.length > 0;
  const processes   = isMultiPool ? lc.pools : [lc];
  const collapsedPools = lc.collapsedPools || [];
  const associations = lc.associations || [];

  const x = [];

  // §6.1  XML Header & namespace declarations
  x.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  x.push(`<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"`);
  x.push(`  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`);
  x.push(`  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"`);
  x.push(`  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"`);
  x.push(`  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"`);
  x.push(`  xmlns:bioc="http://bpmn.io/schema/bpmn/biocolor/1.0"`);
  x.push(`  id="Definitions_1"`);
  x.push(`  targetNamespace="http://bpmn.io/schema/bpmn">`);
  x.push('');

  // §6.1b  Top-level definitions: message, signal, error, escalation (OMG spec §9)
  const topLevelDefs = collectTopLevelDefinitions(processes, lc.definitions);
  for (const def of topLevelDefs) {
    let attrs = `id="${def.id}" name="${esc(def.name)}"`;
    if (def.errorCode) attrs += ` errorCode="${esc(def.errorCode)}"`;
    if (def.escalationCode) attrs += ` escalationCode="${esc(def.escalationCode)}"`;
    x.push(`  <${def.tag} ${attrs} />`);
  }
  if (topLevelDefs.length > 0) x.push('');

  // §6.2  Collaboration element
  const hasAnyLanes = processes.some(p => (p.lanes || []).length > 0);
  const needsCollaboration = isMultiPool || hasAnyLanes || collapsedPools.length > 0;

  if (needsCollaboration) {
    x.push(`  <collaboration id="Collaboration_1">`);

    // Expanded pool participants (with processRef)
    for (const proc of processes) {
      const partId = `Participant_${proc.id}`;
      x.push(`    <participant id="${partId}" processRef="${proc.id}" name="${esc(proc.name || '')}" />`);
    }

    // Collapsed pool participants (no processRef — black box, OMG spec §9.3)
    for (const cp of collapsedPools) {
      const partId = `Participant_${cp.id}`;
      x.push(`    <participant id="${partId}" name="${esc(cp.name || '')}" />`);
    }

    // Message flows (OMG spec §9.4)
    if (lc.messageFlows) {
      for (const mf of lc.messageFlows) {
        const srcRef = resolveMessageFlowRef(mf.source, processes, collapsedPools);
        const tgtRef = resolveMessageFlowRef(mf.target, processes, collapsedPools);
        x.push(`    <messageFlow id="${mf.id}" name="${esc(mf.name || '')}" sourceRef="${srcRef}" targetRef="${tgtRef}" />`);
      }
    }
    x.push(`  </collaboration>`);
    x.push('');
  }

  // §6.4  Process elements (only for expanded pools)
  for (const proc of processes) {
    const nodes = proc.nodes || [];
    const edges = proc.edges || [];
    const lanes = proc.lanes || [];

    inferGatewayDirections(nodes, edges);

    // Build incoming/outgoing maps
    const incomingMap = {}, outgoingMap = {};
    for (const e of edges) {
      const eid = e.id || `flow_${e.source}_${e.target}`;
      if (!outgoingMap[e.source]) outgoingMap[e.source] = [];
      outgoingMap[e.source].push(eid);
      if (!incomingMap[e.target]) incomingMap[e.target] = [];
      incomingMap[e.target].push(eid);
    }

    // Build default flow map (gateway → default edge id)
    // For XOR/Inclusive gateways with >1 outgoing: auto-assign last flow as default
    // if no explicit isDefault is set (OMG spec §10.5.1)
    const defaultFlowMap = {};
    for (const e of edges) {
      if (e.isDefault) {
        defaultFlowMap[e.source] = e.id || `flow_${e.source}_${e.target}`;
      }
    }
    for (const n of nodes) {
      if ((n.type === 'exclusiveGateway' || n.type === 'inclusiveGateway') &&
          n._direction === 'Diverging' && !defaultFlowMap[n.id]) {
        const gwOutEdges = edges.filter(e => e.source === n.id);
        if (gwOutEdges.length > 1) {
          // Pick the last outgoing edge as default (typically the "else" branch)
          const defaultEdge = gwOutEdges[gwOutEdges.length - 1];
          defaultFlowMap[n.id] = defaultEdge.id || `flow_${defaultEdge.source}_${defaultEdge.target}`;
        }
      }
    }

    x.push(`  <process id="${proc.id}" isExecutable="false">`);

    // Process-level documentation
    if (proc.documentation) {
      x.push(`    <documentation>${esc(proc.documentation)}</documentation>`);
    }

    // §6.5  LaneSet — ONE laneSet per process (OMG spec §10.5)
    if (lanes.length > 0) {
      x.push(`    <laneSet id="LaneSet_${proc.id || '1'}">`);
      for (const lane of lanes) {
        emitLane(lane, nodes, '      ', x);
      }
      x.push(`    </laneSet>`);
    }

    // §6.6  Flow nodes
    for (const node of nodes) {
      const tag  = bpmnXmlTag(node.type);
      const attrs = [`id="${node.id}"`, `name="${esc(node.name || '')}"`];

      // Gateway direction (OMG spec §10.5.1)
      if (isGateway(node.type) && node._direction) {
        attrs.push(`gatewayDirection="${node._direction}"`);
      }

      // Default flow attribute on splitting gateways (OMG spec §10.5.1)
      if (isGateway(node.type) && defaultFlowMap[node.id]) {
        attrs.push(`default="${defaultFlowMap[node.id]}"`);
      }

      // Boundary event attachment
      if (isBoundaryEvent(node)) {
        attrs.push(`attachedToRef="${node.attachedTo}"`);
        if (node.cancelActivity === false) attrs.push(`cancelActivity="false"`);
      }

      // isForCompensation (OMG spec §10.2.1)
      if (node.isCompensation) attrs.push(`isForCompensation="true"`);

      // isCollection on dataObjectReference (OMG spec §10.3.1)
      if (node.isCollection && node.type === 'dataObjectReference') attrs.push(`isCollection="true"`);

      // Event SubProcess: triggeredByEvent (OMG spec §10.2.4)
      if (node.isEventSubProcess && (node.type === 'subProcess')) attrs.push(`triggeredByEvent="true"`);

      // CallActivity: calledElement (OMG spec §10.2.3)
      if (node.calledElement && node.type === 'callActivity') attrs.push(`calledElement="${esc(node.calledElement)}"`);

      // ScriptTask: scriptFormat (OMG spec §10.2.5)
      if (node.scriptFormat && node.type === 'scriptTask') attrs.push(`scriptFormat="${esc(node.scriptFormat)}"`);

      // ServiceTask/SendTask/ReceiveTask: implementation (OMG spec §10.2.5)
      if (node.implementation) attrs.push(`implementation="${esc(node.implementation)}"`);

      // EventBasedGateway: eventGatewayType, instantiate (OMG spec §10.5.6)
      if (node.type === 'eventBasedGateway') {
        if (node.eventGatewayType) attrs.push(`eventGatewayType="${node.eventGatewayType}"`);
        if (node.instantiate) attrs.push(`instantiate="true"`);
      }

      const incoming = incomingMap[node.id] || [];
      const outgoing = outgoingMap[node.id] || [];
      const eventDef = getEventDefinitionXml(node, topLevelDefs);
      const isExpandedSub = node.isExpanded && node.nodes && node.nodes.length > 0;
      const needsBody = incoming.length > 0 || outgoing.length > 0 || eventDef ||
                        node.loopType || node.multiInstance || node.documentation || isExpandedSub ||
                        (node.type === 'scriptTask' && node.script);

      if (!needsBody) {
        x.push(`    <${tag} ${attrs.join(' ')} />`);
      } else {
        x.push(`    <${tag} ${attrs.join(' ')}>`);

        // Documentation (OMG spec §8.3.1)
        if (node.documentation) {
          x.push(`      <documentation>${esc(node.documentation)}</documentation>`);
        }

        for (const inc of incoming) x.push(`      <incoming>${inc}</incoming>`);
        for (const out of outgoing) x.push(`      <outgoing>${out}</outgoing>`);

        if (eventDef) x.push(eventDef);

        // Expanded SubProcess: emit child flow elements + sequence flows inline
        if (isExpandedSub) {
          for (const child of node.nodes) {
            const childTag = bpmnXmlTag(child.type);
            const childAttrs = [`id="${child.id}"`, `name="${esc(child.name || '')}"`];
            const childEventDef = getEventDefinitionXml(child, topLevelDefs);
            // Build child incoming/outgoing from subprocess edges
            const subEdges = node.edges || [];
            const childInc = subEdges.filter(e => e.target === child.id).map(e => e.id || `flow_${e.source}_${e.target}`);
            const childOut = subEdges.filter(e => e.source === child.id).map(e => e.id || `flow_${e.source}_${e.target}`);
            const childNeedsBody = childInc.length > 0 || childOut.length > 0 || childEventDef;
            if (!childNeedsBody) {
              x.push(`      <${childTag} ${childAttrs.join(' ')} />`);
            } else {
              x.push(`      <${childTag} ${childAttrs.join(' ')}>`);
              for (const inc of childInc) x.push(`        <incoming>${inc}</incoming>`);
              for (const out of childOut) x.push(`        <outgoing>${out}</outgoing>`);
              if (childEventDef) x.push(childEventDef);
              x.push(`      </${childTag}>`);
            }
          }
          for (const subEdge of (node.edges || [])) {
            const seid = subEdge.id || `flow_${subEdge.source}_${subEdge.target}`;
            const seAttrs = [`id="${seid}"`, `sourceRef="${subEdge.source}"`, `targetRef="${subEdge.target}"`];
            if (subEdge.label) seAttrs.push(`name="${esc(subEdge.label)}"`);
            x.push(`      <sequenceFlow ${seAttrs.join(' ')} />`);
          }
        }

        // ScriptTask: script body (OMG spec §10.2.5)
        if (node.type === 'scriptTask' && node.script) {
          x.push(`      <script>${esc(node.script)}</script>`);
        }

        // Loop / Multi-instance (OMG spec §10.2.2)
        if (node.loopType) {
          if (typeof node.loopType === 'object') {
            const loopAttrs = [];
            if (node.loopType.testBefore) loopAttrs.push(`testBefore="true"`);
            if (node.loopType.loopMaximum != null) loopAttrs.push(`loopMaximum="${node.loopType.loopMaximum}"`);
            if (node.loopType.loopCondition) {
              x.push(`      <standardLoopCharacteristics${loopAttrs.length ? ' ' + loopAttrs.join(' ') : ''}>`);
              x.push(`        <loopCondition xsi:type="tFormalExpression">${esc(node.loopType.loopCondition)}</loopCondition>`);
              x.push(`      </standardLoopCharacteristics>`);
            } else {
              x.push(`      <standardLoopCharacteristics${loopAttrs.length ? ' ' + loopAttrs.join(' ') : ''} />`);
            }
          } else {
            x.push(`      <standardLoopCharacteristics />`);
          }
        } else if (node.multiInstance) {
          const mi = typeof node.multiInstance === 'object' ? node.multiInstance : { type: node.multiInstance };
          const isSeq = mi.type === 'sequential' ? 'true' : 'false';
          const hasChildren = mi.loopCardinality || mi.completionCondition;
          if (hasChildren) {
            x.push(`      <multiInstanceLoopCharacteristics isSequential="${isSeq}">`);
            if (mi.loopCardinality) x.push(`        <loopCardinality>${esc(mi.loopCardinality)}</loopCardinality>`);
            if (mi.completionCondition) x.push(`        <completionCondition>${esc(mi.completionCondition)}</completionCondition>`);
            x.push(`      </multiInstanceLoopCharacteristics>`);
          } else {
            x.push(`      <multiInstanceLoopCharacteristics isSequential="${isSeq}" />`);
          }
        }

        x.push(`    </${tag}>`);
      }
    }

    // §6.7  Sequence flows
    // Build set of default flow IDs for conditionExpression logic
    const defaultFlowIds = new Set(Object.values(defaultFlowMap));
    for (const edge of edges) {
      const eid = edge.id || `flow_${edge.source}_${edge.target}`;
      const attrs = [`id="${eid}"`, `sourceRef="${edge.source}"`, `targetRef="${edge.target}"`];
      if (edge.label) attrs.push(`name="${esc(edge.label)}"`);

      // Determine if this flow needs a conditionExpression:
      // Non-default outgoing flows from XOR/Inclusive gateways (OMG spec §10.5.1)
      const sourceNode = nodes.find(n => n.id === edge.source);
      const needsCondition = edge.condition ||
        (sourceNode && (sourceNode.type === 'exclusiveGateway' || sourceNode.type === 'inclusiveGateway') &&
         sourceNode._direction === 'Diverging' && !defaultFlowIds.has(eid));

      if (needsCondition) {
        const expr = edge.condition || edge.label || '';
        x.push(`    <sequenceFlow ${attrs.join(' ')}>`);
        x.push(`      <conditionExpression xsi:type="tFormalExpression">${esc(expr)}</conditionExpression>`);
        x.push(`    </sequenceFlow>`);
      } else {
        x.push(`    <sequenceFlow ${attrs.join(' ')} />`);
      }
    }

    // §6.8  Data objects
    for (const node of nodes) {
      if (node.type === 'dataObjectReference') {
        x.push(`    <dataObject id="${node.id}_do" />`);
      }
    }

    // §6.8b  Associations (OMG spec §7.2)
    const procAssociations = associations.filter(a => {
      const srcInProc = nodes.some(n => n.id === a.source);
      const tgtInProc = nodes.some(n => n.id === a.target);
      return srcInProc || tgtInProc;
    });
    for (const assoc of procAssociations) {
      const dir = assoc.directed ? ` associationDirection="One"` : '';
      x.push(`    <association id="${assoc.id}" sourceRef="${assoc.source}" targetRef="${assoc.target}"${dir} />`);
    }

    x.push(`  </process>`);
    x.push('');
  }

  // §6.9  BPMN Diagram Interchange (DI)
  x.push(`  <bpmndi:BPMNDiagram id="BPMNDiagram_1">`);
  x.push(`    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="${needsCollaboration ? 'Collaboration_1' : processes[0].id}">`);

  // Pool shapes (expanded + collapsed)
  if (needsCollaboration) {
    for (const proc of processes) {
      const partId = `Participant_${proc.id}`;
      const pc = poolCoords[proc.id] || poolCoords['_singlePool'];
      if (pc) {
        let px = pc.x, py = pc.y, pw = pc.w, ph = pc.h;
        const lanes = proc.lanes || [];
        if (lanes.length > 0) {
          const lcs = lanes.map(l => laneCoords[l.id]).filter(Boolean);
          if (lcs.length) {
            px = Math.min(...lcs.map(l => l.x)) - LANE_HEADER_W;
            py = Math.min(...lcs.map(l => l.y));
            pw = Math.max(...lcs.map(l => l.x + l.w)) - px;
            ph = Math.max(...lcs.map(l => l.y + l.h)) - py;
          }
        }
        x.push(`      <bpmndi:BPMNShape id="${partId}_di" bpmnElement="${partId}" isHorizontal="true">`);
        x.push(`        <dc:Bounds x="${rn(px)}" y="${rn(py)}" width="${rn(pw)}" height="${rn(ph)}" />`);
        x.push(`      </bpmndi:BPMNShape>`);
      }

      emitLaneDI(proc.lanes || [], laneCoords, x);
    }

    // Collapsed pool shapes
    for (const cp of collapsedPools) {
      const partId = `Participant_${cp.id}`;
      const pc = poolCoords[cp.id];
      if (pc) {
        x.push(`      <bpmndi:BPMNShape id="${partId}_di" bpmnElement="${partId}" isHorizontal="true">`);
        x.push(`        <dc:Bounds x="${rn(pc.x)}" y="${rn(pc.y)}" width="${rn(pc.w)}" height="${rn(pc.h)}" />`);
        x.push(`      </bpmndi:BPMNShape>`);
      }
    }
  }

  // Node shapes with DI Label Bounds
  for (const proc of processes) {
    for (const node of (proc.nodes || [])) {
      const c = coords[node.id];
      if (!c) continue;
      const markerAttr = (node.type === 'exclusiveGateway') ? ' isMarkerVisible="true"' : '';
      const expandedAttr = (node.isExpanded && node.nodes) ? ' isExpanded="true"' : '';
      x.push(`      <bpmndi:BPMNShape id="${node.id}_di" bpmnElement="${node.id}"${markerAttr}${expandedAttr}${biocAttrs(node)}>`);
      x.push(`        <dc:Bounds x="${rn(c.x)}" y="${rn(c.y)}" width="${rn(c.w)}" height="${rn(c.h)}" />`);

      // DI Label Bounds (OMG spec §12.1) — calculate actual label position
      if ((isEvent(node.type) || isGateway(node.type)) && node.name) {
        const labelW = Math.min(node.name.length * 6.5 + 10, 90);
        const labelX = c.x + c.w / 2 - labelW / 2;
        const labelY = c.y + c.h + LABEL_DISTANCE;
        x.push(`        <bpmndi:BPMNLabel>`);
        x.push(`          <dc:Bounds x="${rn(labelX)}" y="${rn(labelY)}" width="${rn(labelW)}" height="${rn(20)}" />`);
        x.push(`        </bpmndi:BPMNLabel>`);
      }
      x.push(`      </bpmndi:BPMNShape>`);

      // Expanded SubProcess children: emit BPMNShape + BPMNEdge for child nodes
      if (node.isExpanded && node.nodes) {
        for (const child of node.nodes) {
          const cc = coords[child.id];
          if (!cc) continue;
          const childMarker = (child.type === 'exclusiveGateway') ? ' isMarkerVisible="true"' : '';
          x.push(`      <bpmndi:BPMNShape id="${child.id}_di" bpmnElement="${child.id}"${childMarker}${biocAttrs(child)}>`);
          x.push(`        <dc:Bounds x="${rn(cc.x)}" y="${rn(cc.y)}" width="${rn(cc.w)}" height="${rn(cc.h)}" />`);
          if ((isEvent(child.type) || isGateway(child.type)) && child.name) {
            const clw = Math.min(child.name.length * 6.5 + 10, 90);
            const clx = cc.x + cc.w / 2 - clw / 2;
            const cly = cc.y + cc.h + LABEL_DISTANCE;
            x.push(`        <bpmndi:BPMNLabel>`);
            x.push(`          <dc:Bounds x="${rn(clx)}" y="${rn(cly)}" width="${rn(clw)}" height="${rn(20)}" />`);
            x.push(`        </bpmndi:BPMNLabel>`);
          }
          x.push(`      </bpmndi:BPMNShape>`);
        }
        for (const subEdge of (node.edges || [])) {
          const seid = subEdge.id || `flow_${subEdge.source}_${subEdge.target}`;
          const spts = edgeCoords[seid] || [];
          x.push(`      <bpmndi:BPMNEdge id="${seid}_di" bpmnElement="${seid}">`);
          if (spts.length >= 2) {
            for (const p of spts) x.push(`        <di:waypoint x="${rn(p.x)}" y="${rn(p.y)}" />`);
          } else {
            const ss = coords[subEdge.source], st = coords[subEdge.target];
            if (ss && st) {
              x.push(`        <di:waypoint x="${rn(ss.x + ss.w/2)}" y="${rn(ss.y + ss.h/2)}" />`);
              x.push(`        <di:waypoint x="${rn(st.x + st.w/2)}" y="${rn(st.y + st.h/2)}" />`);
            }
          }
          x.push(`      </bpmndi:BPMNEdge>`);
        }
      }
    }
  }

  // Edge shapes
  for (const proc of processes) {
    for (const edge of (proc.edges || [])) {
      const eid = edge.id || `flow_${edge.source}_${edge.target}`;
      const pts = edgeCoords[eid] || [];
      x.push(`      <bpmndi:BPMNEdge id="${eid}_di" bpmnElement="${eid}">`);
      if (pts.length >= 2) {
        for (const p of pts) x.push(`        <di:waypoint x="${rn(p.x)}" y="${rn(p.y)}" />`);
      } else {
        const s = coords[edge.source], t = coords[edge.target];
        if (s && t) {
          x.push(`        <di:waypoint x="${rn(s.x + s.w/2)}" y="${rn(s.y + s.h/2)}" />`);
          x.push(`        <di:waypoint x="${rn(t.x + t.w/2)}" y="${rn(t.y + t.h/2)}" />`);
        }
      }
      // Edge label DI bounds — first horizontal segment, 5px above
      if (edge.label && pts.length >= 2) {
        let lx, ly;
        let found = false;
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
        x.push(`        <bpmndi:BPMNLabel>`);
        x.push(`          <dc:Bounds x="${rn(lx - lw/2)}" y="${rn(ly - 8)}" width="${rn(lw)}" height="${rn(16)}" />`);
        x.push(`        </bpmndi:BPMNLabel>`);
      }
      x.push(`      </bpmndi:BPMNEdge>`);
    }
  }

  // Message flow DI
  if (lc.messageFlows) {
    for (const mf of lc.messageFlows) {
      const srcCoord = coords[mf.source] || poolCoords[mf.source];
      const tgtCoord = coords[mf.target] || poolCoords[mf.target];
      x.push(`      <bpmndi:BPMNEdge id="${mf.id}_di" bpmnElement="${mf.id}">`);
      if (srcCoord && tgtCoord) {
        const sx = (srcCoord.x || 0) + (srcCoord.w || 0) / 2;
        const sy = (srcCoord.y || 0) + (srcCoord.h || 0);
        const tx = (tgtCoord.x || 0) + (tgtCoord.w || 0) / 2;
        const ty = tgtCoord.y || 0;
        x.push(`        <di:waypoint x="${rn(sx)}" y="${rn(sy)}" />`);
        x.push(`        <di:waypoint x="${rn(tx)}" y="${rn(ty)}" />`);
      }
      x.push(`      </bpmndi:BPMNEdge>`);
    }
  }

  // Association DI
  for (const assoc of associations) {
    const srcC = coords[assoc.source];
    const tgtC = coords[assoc.target];
    if (srcC && tgtC) {
      x.push(`      <bpmndi:BPMNEdge id="${assoc.id}_di" bpmnElement="${assoc.id}">`);
      x.push(`        <di:waypoint x="${rn(srcC.x + srcC.w/2)}" y="${rn(srcC.y + srcC.h/2)}" />`);
      x.push(`        <di:waypoint x="${rn(tgtC.x + tgtC.w/2)}" y="${rn(tgtC.y + tgtC.h/2)}" />`);
      x.push(`      </bpmndi:BPMNEdge>`);
    }
  }

  x.push(`    </bpmndi:BPMNPlane>`);
  x.push(`  </bpmndi:BPMNDiagram>`);
  x.push(`</definitions>`);
  return x.join('\n');
}

function emitLaneDI(lanes, laneCoords, x) {
  for (const lane of lanes) {
    const lcc = laneCoords[lane.id];
    if (lcc) {
      x.push(`      <bpmndi:BPMNShape id="${lane.id}_di" bpmnElement="${lane.id}" isHorizontal="true">`);
      x.push(`        <dc:Bounds x="${rn(lcc.x)}" y="${rn(lcc.y)}" width="${rn(lcc.w)}" height="${rn(lcc.h)}" />`);
      x.push(`      </bpmndi:BPMNShape>`);
    }
    if (lane.children?.length) {
      emitLaneDI(lane.children, laneCoords, x);
    }
  }
}

function emitLane(lane, nodes, indent, x) {
  x.push(`${indent}<lane id="${lane.id}" name="${esc(lane.name || lane.id)}">`);
  nodes.filter(n => n.lane === lane.id)
       .forEach(n => x.push(`${indent}  <flowNodeRef>${n.id}</flowNodeRef>`));
  if (lane.children?.length) {
    x.push(`${indent}  <childLaneSet>`);
    for (const child of lane.children) {
      emitLane(child, nodes, indent + '    ', x);
    }
    x.push(`${indent}  </childLaneSet>`);
  }
  x.push(`${indent}</lane>`);
}

function resolveMessageFlowRef(ref, processes, collapsedPools) {
  for (const p of processes) {
    if (p.id === ref) return `Participant_${ref}`;
  }
  for (const cp of (collapsedPools || [])) {
    if (cp.id === ref) return `Participant_${ref}`;
  }
  return ref; // node id
}

// §6.10  Collect top-level definitions (OMG spec §8.4, §9)
// If explicit definitions[] are provided, use them. Otherwise auto-generate from markers.
function collectTopLevelDefinitions(processes, explicitDefs) {
  // Use explicit definitions if provided (from import round-trip or user input)
  if (explicitDefs && explicitDefs.length > 0) {
    return explicitDefs.map(d => ({
      tag: d.type,
      id: d.id,
      name: d.name || '',
      marker: d.type,
      errorCode: d.errorCode,
      escalationCode: d.escalationCode,
    }));
  }

  // Auto-generate from event markers (backward-compatible)
  const defs = [];
  const seen = new Set();

  for (const proc of processes) {
    for (const node of (proc.nodes || [])) {
      const marker = node.marker || inferEventMarker(node.name || '');
      if (!marker || seen.has(marker)) continue;

      const tag = {
        message: 'message', timer: null, error: 'error', signal: 'signal',
        escalation: 'escalation', compensation: null, conditional: null,
        link: null, cancel: null, terminate: null, multiple: null, parallelMultiple: null,
      }[marker];

      if (tag) {
        seen.add(marker);
        const id = `${tag.charAt(0).toUpperCase() + tag.slice(1)}_${defs.length + 1}`;
        const name = marker.charAt(0).toUpperCase() + marker.slice(1);
        defs.push({ tag, id, name, marker });
      }
    }
  }
  return defs;
}

function getEventDefinitionXml(node, topLevelDefs) {
  const marker = node.marker || inferEventMarker(node.name || '');
  if (!marker) return null;
  const indent = '      ';

  // Find matching top-level definition for ref attribute
  const topDef = (topLevelDefs || []).find(d => d.marker === marker);
  const refAttr = topDef ? ` ${topDef.tag}Ref="${topDef.id}"` : '';

  switch (marker) {
    case 'message':      return `${indent}<messageEventDefinition${refAttr} />`;
    case 'timer': {
      if (node.timerExpression) {
        const te = node.timerExpression;
        const timerTag = te.type === 'date' ? 'timeDate' : te.type === 'cycle' ? 'timeCycle' : 'timeDuration';
        return `${indent}<timerEventDefinition>\n${indent}  <${timerTag}>${esc(te.value)}</${timerTag}>\n${indent}</timerEventDefinition>`;
      }
      return `${indent}<timerEventDefinition />`;
    }
    case 'error':        return `${indent}<errorEventDefinition${refAttr} />`;
    case 'signal':       return `${indent}<signalEventDefinition${refAttr} />`;
    case 'escalation':   return `${indent}<escalationEventDefinition${refAttr} />`;
    case 'compensation': return `${indent}<compensateEventDefinition />`;
    case 'conditional': {
      if (node.conditionExpression) {
        return `${indent}<conditionalEventDefinition>\n${indent}  <condition xsi:type="tFormalExpression">${esc(node.conditionExpression)}</condition>\n${indent}</conditionalEventDefinition>`;
      }
      return `${indent}<conditionalEventDefinition />`;
    }
    case 'link': {
      const linkName = node.linkName || node.name || '';
      if (linkName) {
        return `${indent}<linkEventDefinition name="${esc(linkName)}" />`;
      }
      return `${indent}<linkEventDefinition />`;
    }
    case 'cancel':       return `${indent}<cancelEventDefinition />`;
    case 'terminate':    return `${indent}<terminateEventDefinition />`;
    default: return null;
  }
}

export { generateBpmnXml, resolveMessageFlowRef, collectTopLevelDefinitions, getEventDefinitionXml };
