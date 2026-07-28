/**
 * BPMN Coordinates — ELK Result → Coordinate Maps + Edge Clipping
 * Translates raw ELK layout output into absolute coordinates for rendering.
 */

import { isEvent, isGateway, isBoundaryEvent, isArtifact } from './types.js';
import { SHAPE, LANE_HEADER_W, LANE_PADDING, EXTERNAL_LABEL_H, POOL_GAP, MESSAGE_FLOW_FAN, ARTIFACT_GAP, CFG } from './utils.js';
import { identifyHappyPathNodes, resolveLaneId } from './topology.js';

function buildCoordinateMap(elkResult, lc) {
  const coords     = {};
  const laneCoords = {};
  const poolCoords = {};
  const edgeCoords = {};

  const allProcesses = lc.pools ? lc.pools : [lc];
  const allCollapsedPools = lc.collapsedPools || [];
  const allLaneIds = new Set();
  const allPoolIds = new Set();
  for (const p of allProcesses) {
    allPoolIds.add(p.id);
    for (const l of (p.lanes || [])) allLaneIds.add(l.id);
  }
  for (const cp of allCollapsedPools) allPoolIds.add(cp.id);

  const collectNodes = (node, offX = 0, offY = 0) => {
    const ax = (node.x || 0) + offX;
    const ay = (node.y || 0) + offY;

    if (node.id === 'collaboration' || node.id === 'root') {
      for (const c of node.children || []) collectNodes(c, ax, ay);
      for (const e of node.edges   || []) collectEdge(e, ax, ay);
      return;
    }

    if (allPoolIds.has(node.id)) {
      poolCoords[node.id] = { x: ax, y: ay, w: node.width, h: node.height, laneHeaderWidth: LANE_HEADER_W };
      for (const c of node.children || []) collectNodes(c, ax, ay);
      for (const e of node.edges   || []) collectEdge(e, ax, ay);
      return;
    }

    if (node.id === 'pool') {
      poolCoords['_singlePool'] = { x: ax, y: ay, w: node.width, h: node.height, laneHeaderWidth: LANE_HEADER_W };
      for (const c of node.children || []) collectNodes(c, ax, ay);
      for (const e of node.edges   || []) collectEdge(e, ax, ay);
      return;
    }

    if (allLaneIds.has(node.id)) {
      laneCoords[node.id] = { x: ax, y: ay, w: node.width, h: node.height };
      for (const c of node.children || []) collectNodes(c, ax, ay);
      for (const e of node.edges   || []) collectEdge(e, ax, ay);
      return;
    }

    // Regular node — use actual shape dimensions, not ELK dimensions
    // Exception: expanded subprocesses use ELK-computed dimensions
    // (ELK sizes compound nodes to encompass their children)
    if (node._isExpanded) {
      coords[node.id] = { x: ax, y: ay, w: node.width, h: node.height };
    } else {
      const shapeH = node._shapeH || node.height;
      const lcNode = findNodeInAllProcesses(node.id, allProcesses);
      const specSz = SHAPE[lcNode?.type] || { w: node.width, h: shapeH };
      // Vertical center alignment: ELK centers BBOX centers, but bboxes for
      // nodes with external labels include label-height padding below the shape.
      // Result: the shape sits at the TOP of its bbox, so an event's shape-center
      // is above a task's shape-center in the same row by EXTERNAL_LABEL_H/2.
      // Fix: shift the shape down by half the label-height padding so the
      // shape-center coincides with the bbox-center, which is what ELK aligns.
      const bboxH = node.height;
      const yOffset = Math.max(0, (bboxH - specSz.h) / 2);
      coords[node.id] = { x: ax, y: ay + yOffset, w: specSz.w, h: specSz.h };
    }

    for (const c of node.children || []) collectNodes(c, ax, ay);
    for (const e of node.edges   || []) collectEdge(e, ax, ay);
  };

  const collectEdge = (edge, offX = 0, offY = 0) => {
    const pts = [];
    for (const sec of edge.sections || []) {
      pts.push({ x: sec.startPoint.x + offX, y: sec.startPoint.y + offY });
      for (const bp of sec.bendPoints || []) pts.push({ x: bp.x + offX, y: bp.y + offY });
      pts.push({ x: sec.endPoint.x + offX, y: sec.endPoint.y + offY });
    }
    edgeCoords[edge.id] = pts;
  };

  collectNodes(elkResult);

  // §5.0-  Place everything ELK does not lay out.
  //
  //        ELK is a producer, not the geometry contract: its vocabulary is nodes
  //        and edges, BPMN's is larger. Boundary events ("attached to the border
  //        of") and artifacts (annotative — must not displace the flow) are
  //        therefore filtered out of the ELK graph in layout.js. Filtering them
  //        out is right; what was missing is putting them back. Without this,
  //        an element ends up semantically in the XML but without any DI, i.e.
  //        invisible in every BPMN tool.
  const boundaryIds = placeBoundaryEvents(coords, allProcesses);
  placeArtifacts(coords, allProcesses, lc);

  //        Their sequence flows were routed by ELK from the HOST, so the stored
  //        route starts at the wrong shape and keeps a backtracking bend.
  //        Drop it — §5.2 re-routes them cleanly from the boundary event.
  if (boundaryIds.size > 0) {
    for (const proc of allProcesses) {
      for (const e of (proc.edges || [])) {
        if (boundaryIds.has(e.source)) delete edgeCoords[e.id];
      }
    }
  }

  // §5.0  Compute lane bounds from node positions (flat layout approach)
  //       Since we use ELK partitioning, nodes are direct children of the pool.
  //       Lane bounds are computed by grouping nodes by their lane assignment
  //       and calculating the bounding box + padding for each group.
  for (const proc of allProcesses) {
    const lanes = proc.lanes || [];
    if (lanes.length === 0) continue;
    const procNodes = proc.nodes || [];

    // Group nodes by lane
    const laneNodeGroups = {};
    for (const lane of lanes) laneNodeGroups[lane.id] = [];
    for (const n of procNodes) {
      const laneId = laneOfNode(n, proc);
      if (laneId && laneNodeGroups[laneId] && coords[n.id]) {
        laneNodeGroups[laneId].push(coords[n.id]);
      }
    }

    // Find the pool bounding box for x/width reference
    const poolC = poolCoords[proc.id] || poolCoords['_singlePool'];
    const poolX = poolC ? poolC.x : 0;
    const poolW = poolC ? poolC.w : Math.max(...Object.values(coords).map(c => c.x + c.w)) + LANE_PADDING;

    // Compute lane bounds from node positions
    for (const lane of lanes) {
      const nodeCoords = laneNodeGroups[lane.id];
      if (nodeCoords.length === 0) {
        // Empty lane — give it minimum height
        laneCoords[lane.id] = { x: poolX + LANE_HEADER_W, y: 0, w: poolW - LANE_HEADER_W, h: 60 };
        continue;
      }
      const minY = Math.min(...nodeCoords.map(c => c.y)) - LANE_PADDING;
      const maxY = Math.max(...nodeCoords.map(c => c.y + c.h)) + LANE_PADDING + EXTERNAL_LABEL_H;

      laneCoords[lane.id] = {
        x: poolX + LANE_HEADER_W,
        y: minY,
        w: poolW - LANE_HEADER_W,
        h: maxY - minY,
      };
    }

    // §5.0a  Stack the lane bands in the process's own lane order.
    //
    //        ELK lays out the flow (x = layers) but knows nothing about lanes:
    //        their y comes from where ELK happened to put the nodes. Left alone,
    //        the bands would appear in an arbitrary order and could overlap.
    //        So we take the vertical axis into our own hands: bands are stacked
    //        top-down in the declared order (topology.js has already sorted
    //        `proc.lanes` by flow), each node moves with its band, and only the
    //        edges whose two ends moved differently lose their ELK route — §5.2
    //        re-routes exactly those.
    const laneOrder = lanes.map(l => l.id).filter(id => laneCoords[id]);
    const laneDelta = {};
    let cursorY = Math.min(...laneOrder.map(id => laneCoords[id].y));

    for (const laneId of laneOrder) {
      const band = laneCoords[laneId];
      const delta = cursorY - band.y;
      laneDelta[laneId] = delta;
      if (delta !== 0) {
        band.y += delta;
        for (const n of procNodes) {
          if (laneOfNode(n, proc) === laneId && coords[n.id]) coords[n.id].y += delta;
        }
      }
      cursorY = band.y + band.h;
    }

    for (const e of (proc.edges || [])) {
      const pts = edgeCoords[e.id];
      if (!pts) continue;
      const srcNode = procNodes.find(n => n.id === e.source);
      const tgtNode = procNodes.find(n => n.id === e.target);
      const ds = laneDelta[laneOfNode(srcNode, proc)] ?? 0;
      const dt = laneDelta[laneOfNode(tgtNode, proc)] ?? 0;
      if (ds === dt) {
        if (ds !== 0) for (const p of pts) p.y += ds;
      } else {
        delete edgeCoords[e.id];   // geometry no longer valid — §5.2 re-routes
      }
    }

    // Equalize all lane widths
    const allLcs = lanes.map(l => laneCoords[l.id]).filter(Boolean);
    if (allLcs.length > 0) {
      const maxW = Math.max(...allLcs.map(l => l.w));
      const minX = Math.min(...allLcs.map(l => l.x));
      for (const lc_ of allLcs) {
        lc_.x = minX;
        lc_.w = maxW;
      }

      // Recalculate pool bounds from lane bounds
      const poolKey = proc.id;
      const pc = poolCoords[poolKey] || poolCoords['_singlePool'];
      if (pc) {
        pc.x = minX - LANE_HEADER_W;
        pc.y = Math.min(...allLcs.map(l => l.y));
        pc.w = maxW + LANE_HEADER_W;
        pc.h = Math.max(...allLcs.map(l => l.y + l.h)) - pc.y;
      }
    }
  }

  // §5.0b  Equalize pool widths across entire collaboration (BPMN convention)
  const allPoolCoordValues = Object.values(poolCoords);
  if (allPoolCoordValues.length > 1) {
    const maxPoolW = Math.max(...allPoolCoordValues.map(p => p.w));
    const minPoolX = Math.min(...allPoolCoordValues.map(p => p.x));
    for (const pc of allPoolCoordValues) {
      pc.x = minPoolX;
      pc.w = maxPoolW;
    }
    // Also extend lanes to match pool width
    for (const lc_ of Object.values(laneCoords)) {
      lc_.w = maxPoolW - LANE_HEADER_W;
    }
  }

  // §5.0b2  Re-stack all participants vertically, using their FINAL heights.
  //         layout.js already stacks them, but §5.0 recomputes pool bounds from
  //         the node positions and a pool can end up taller than the height ELK
  //         reserved for it — the next pool would then overlap it.  Restacking
  //         here, after every height has settled, is what makes the result
  //         collision-free for any number of participants.  Expanded pools keep
  //         their declared order, black-box participants go below them.
  const byId = new Map([
    ...allProcesses.map(p => [p.id, { id: p.id, proc: p }]),
    ...allCollapsedPools.map(cp => [cp.id, { id: cp.id, proc: null }]),
  ]);
  // Order from topology.js: partners adjacent, expanded and black-box
  // participants interleaved. Falls back to declaration order.
  const participantOrder = (lc._participantOrder ?? [...byId.keys()])
    .map(id => byId.get(id))
    .filter(e => e && poolCoords[e.id]);

  if (participantOrder.length > 1) {
    const shiftParticipant = (entry, delta) => {
      if (!delta) return;
      poolCoords[entry.id].y += delta;
      if (!entry.proc) return;   // black box has no content
      for (const lane of (entry.proc.lanes || [])) {
        if (laneCoords[lane.id]) laneCoords[lane.id].y += delta;
      }
      for (const n of flattenProcessNodes(entry.proc.nodes)) {
        if (coords[n.id]) coords[n.id].y += delta;
      }
      for (const e of flattenProcessEdges(entry.proc)) {
        for (const p of (edgeCoords[e.id] || [])) p.y += delta;
      }
    };

    let nextY = poolCoords[participantOrder[0].id].y;
    for (const entry of participantOrder) {
      const pc = poolCoords[entry.id];
      shiftParticipant(entry, nextY - pc.y);
      nextY = pc.y + pc.h + POOL_GAP;
    }
  }

  // §5.0c  Happy-Path Y-Leveling (align happy-path nodes to median Y per lane)
  if (CFG.layout?.happyPathLeveling) {
    for (const proc of allProcesses) {
      const happyIds = identifyHappyPathNodes(proc.nodes || [], proc.edges || []);
      if (happyIds.size === 0) continue;
      const lanes = proc.lanes || [];
      if (lanes.length > 0) {
        for (const lane of lanes) {
          const laneHappyNodes = (proc.nodes || [])
            .filter(n => n.lane === lane.id && happyIds.has(n.id))
            .map(n => n.id)
            .filter(id => coords[id]);
          if (laneHappyNodes.length < 2) continue;
          const ys = laneHappyNodes.map(id => coords[id].y + coords[id].h / 2);
          ys.sort((a, b) => a - b);
          const medianY = ys[Math.floor(ys.length / 2)];
          for (const id of laneHappyNodes) {
            coords[id].y = medianY - coords[id].h / 2;
          }
        }
      } else {
        const happyNodeIds = [...happyIds].filter(id => coords[id]);
        if (happyNodeIds.length >= 2) {
          const ys = happyNodeIds.map(id => coords[id].y + coords[id].h / 2);
          ys.sort((a, b) => a - b);
          const medianY = ys[Math.floor(ys.length / 2)];
          for (const id of happyNodeIds) {
            coords[id].y = medianY - coords[id].h / 2;
          }
        }
      }
    }
  }

  // §5.0d  Fan-out alignment: when an exclusive gateway fans out to 3+ targets,
  //        snap those targets to the same x-column, and their direct successors
  //        (typically end events) to a second aligned x-column.
  //        This prevents ELK's slight horizontal offsets on parallel branches.
  for (const proc of allProcesses) {
    const edges = proc.edges || [];
    const nodes = proc.nodes || [];
    const outgoing = {};
    for (const e of edges) (outgoing[e.source] ||= []).push(e.target);

    for (const node of nodes) {
      if (node.type !== 'exclusiveGateway') continue;
      const targets = (outgoing[node.id] || []).filter(id => coords[id]);
      if (targets.length < 3) continue;

      // Align targets to rightmost x
      const maxX = Math.max(...targets.map(id => coords[id].x));
      for (const id of targets) coords[id].x = maxX;

      // Align their successors (end events) to a second column
      const succs = targets.flatMap(id => (outgoing[id] || []).filter(s => coords[s]));
      if (succs.length >= 2) {
        const maxSX = Math.max(...succs.map(id => coords[id].x));
        for (const id of succs) coords[id].x = maxSX;
      }
    }
  }

  // §5.0e  Edge route compaction: replace extreme ELK detour routes.
  //        ELK sometimes routes loop-back edges far outside pool bounds.
  //        Detect these and replace with simple orthogonal routes.
  for (const proc of allProcesses) {
    const procEdges = proc.edges || [];
    const poolC = poolCoords[proc.id] || poolCoords['_singlePool'];
    if (!poolC) continue;

    const margin = 120;
    const poolMinY = poolC.y - margin;
    const poolMaxY = poolC.y + poolC.h + margin;
    const poolMinX = poolC.x - margin;
    const poolMaxX = poolC.x + poolC.w + margin;

    for (const edge of procEdges) {
      const pts = edgeCoords[edge.id];
      if (!pts || pts.length < 3) continue;

      // Check if any waypoint is outside pool bounds + margin
      const hasDetour = pts.some(p =>
        p.y < poolMinY || p.y > poolMaxY || p.x < poolMinX || p.x > poolMaxX
      );
      if (!hasDetour) continue;

      const srcC = coords[edge.source];
      const tgtC = coords[edge.target];
      if (!srcC || !tgtC) continue;

      const srcCx = srcC.x + srcC.w / 2;
      const srcCy = srcC.y + srcC.h / 2;
      const tgtCx = tgtC.x + tgtC.w / 2;
      const tgtCy = tgtC.y + tgtC.h / 2;

      const dx = Math.abs(tgtCx - srcCx);
      const dy = Math.abs(tgtCy - srcCy);

      if (dy > dx) {
        // Primarily vertical connection
        const srcExit  = { x: srcCx, y: srcCy > tgtCy ? srcC.y : srcC.y + srcC.h };
        const tgtEntry = { x: tgtCx, y: srcCy > tgtCy ? tgtC.y + tgtC.h : tgtC.y };
        const midY = (srcExit.y + tgtEntry.y) / 2;
        edgeCoords[edge.id] = [srcExit, { x: srcCx, y: midY }, { x: tgtCx, y: midY }, tgtEntry];
      } else {
        // Primarily horizontal connection
        const goRight = tgtCx > srcCx;
        const srcExit  = { x: goRight ? srcC.x + srcC.w : srcC.x, y: srcCy };
        const tgtEntry = { x: goRight ? tgtC.x : tgtC.x + tgtC.w, y: tgtCy };
        const midX = (srcExit.x + tgtEntry.x) / 2;
        edgeCoords[edge.id] = [srcExit, { x: midX, y: srcCy }, { x: midX, y: tgtCy }, tgtEntry];
      }
    }
  }

  // §5.0f  Cross-lane edge deconfliction: detect overlapping horizontal segments
  //         of cross-lane edges and nudge them apart to reduce visual confusion.
  if (CFG.layout?.crossLaneDeconflict !== false) {
    // Build set of lane-id per node for cross-lane detection
    const nodeLane = {};
    for (const proc of allProcesses) {
      for (const lane of (proc.lanes || [])) {
        for (const nid of (lane.nodeIds || [])) nodeLane[nid] = lane.id;
        // Format A: node.lane
        for (const n of (proc.nodes || [])) {
          if (n.lane && !nodeLane[n.id]) nodeLane[n.id] = n.lane;
        }
      }
    }

    // Collect cross-lane edges that have orthogonal routes with horizontal segments
    const crossLaneEdges = [];
    for (const proc of allProcesses) {
      for (const edge of (proc.edges || [])) {
        const pts = edgeCoords[edge.id];
        if (!pts || pts.length < 3) continue;
        const srcLane = nodeLane[edge.source];
        const tgtLane = nodeLane[edge.target];
        if (!srcLane || !tgtLane || srcLane === tgtLane) continue;

        // Find horizontal segments (same Y)
        const hSegments = [];
        for (let i = 0; i < pts.length - 1; i++) {
          if (Math.abs(pts[i].y - pts[i + 1].y) < 1) {
            const minX = Math.min(pts[i].x, pts[i + 1].x);
            const maxX = Math.max(pts[i].x, pts[i + 1].x);
            hSegments.push({ y: pts[i].y, minX, maxX, ptIdx: i, edgeId: edge.id });
          }
        }
        if (hSegments.length) crossLaneEdges.push({ edge, hSegments });
      }
    }

    // Compare all pairs for overlap
    const nudgeOffset = 12;
    const nudged = new Set();
    for (let i = 0; i < crossLaneEdges.length; i++) {
      for (let j = i + 1; j < crossLaneEdges.length; j++) {
        for (const segA of crossLaneEdges[i].hSegments) {
          for (const segB of crossLaneEdges[j].hSegments) {
            // Overlapping Y within threshold and overlapping X range?
            if (Math.abs(segA.y - segB.y) < 8 &&
                segA.minX < segB.maxX && segA.maxX > segB.minX) {
              // Nudge the second edge's segment
              if (!nudged.has(segB.edgeId)) {
                const pts = edgeCoords[segB.edgeId];
                pts[segB.ptIdx].y += nudgeOffset;
                pts[segB.ptIdx + 1].y += nudgeOffset;
                nudged.add(segB.edgeId);
              }
            }
          }
        }
      }
    }
  }

  // §5.1  Orthogonal edge endpoint clipping
  //
  // ELK produces orthogonal routes (90° bends). We must preserve this when
  // clipping endpoints to the actual (smaller) shape boundaries.
  // Strategy: detect whether the first/last segment is horizontal or vertical,
  // then project the endpoint onto the shape boundary along that axis only.
  //
  const allProcessNodes = allProcesses.flatMap(p => p.nodes || []);
  const allProcessEdges = allProcesses.flatMap(p => p.edges || []);
  for (const edge of allProcessEdges) {
    const eid = edge.id;
    const pts = edgeCoords[eid];
    if (!pts || pts.length < 2) continue;

    const srcCoord = coords[edge.source];
    const tgtCoord = coords[edge.target];
    const srcNode  = allProcessNodes.find(n => n.id === edge.source);
    const tgtNode  = allProcessNodes.find(n => n.id === edge.target);

    if (srcCoord && srcNode) {
      pts[0] = clipOrthogonal(srcCoord, srcNode.type, pts[0], pts[1], 'source');
    }
    if (tgtCoord && tgtNode) {
      const last = pts.length - 1;
      pts[last] = clipOrthogonal(tgtCoord, tgtNode.type, pts[last], pts[last - 1], 'target');
    }
  }

  // §5.2  Synthetic routing for edges without ELK routing data
  //        (cross-lane edges in rectpacking mode have no sections)
  for (const edge of allProcessEdges) {
    const eid = edge.id;
    const pts = edgeCoords[eid];
    if (pts && pts.length >= 2) continue;  // already routed

    const srcC = coords[edge.source];
    const tgtC = coords[edge.target];
    if (!srcC || !tgtC) continue;

    const srcCx = srcC.x + srcC.w / 2;
    const srcCy = srcC.y + srcC.h / 2;
    const tgtCx = tgtC.x + tgtC.w / 2;
    const tgtCy = tgtC.y + tgtC.h / 2;

    const dx = Math.abs(tgtCx - srcCx);
    const dy = Math.abs(tgtCy - srcCy);

    if (dy > dx) {
      // Primarily vertical (cross-lane): go down from source bottom, horizontal, up to target
      const srcExit = { x: srcCx, y: srcCy > tgtCy ? srcC.y : srcC.y + srcC.h };
      const tgtEntry = { x: tgtCx, y: srcCy > tgtCy ? tgtC.y + tgtC.h : tgtC.y };
      const midY = (srcExit.y + tgtEntry.y) / 2;
      edgeCoords[eid] = [
        srcExit,
        { x: srcCx, y: midY },
        { x: tgtCx, y: midY },
        tgtEntry,
      ];
    } else {
      // Primarily horizontal: right side → horizontal → up/down → horizontal → left side
      const srcExit = { x: srcC.x + srcC.w, y: srcCy };
      const tgtEntry = { x: tgtC.x, y: tgtCy };
      const midX = (srcExit.x + tgtEntry.x) / 2;
      edgeCoords[eid] = [
        srcExit,
        { x: midX, y: srcCy },
        { x: midX, y: tgtCy },
        tgtEntry,
      ];
    }
  }

  // §5.3  Force orthogonal: any remaining diagonal segments get converted
  //        to horizontal-then-vertical (or vice versa) dog-legs.
  for (const eid of Object.keys(edgeCoords)) {
    const pts = edgeCoords[eid];
    if (!pts || pts.length < 2) continue;
    edgeCoords[eid] = enforceOrthogonal(pts);
  }

  // §5.4  Association routing.
  //       Associations connect an artifact to the element it annotates. ELK
  //       never saw either end (both are filtered out of the graph), so like
  //       message flows they used to be improvised at render time — by svg.js
  //       and bpmn-xml.js independently, both drawing centre-to-centre, which
  //       runs the line into the middle of both shapes. Here they get a route
  //       clipped to the shape borders, from the same source both renderers read.
  for (const assoc of (lc.associations || [])) {
    const s = coords[assoc.source];
    const t = coords[assoc.target];
    if (!s || !t) continue;
    edgeCoords[assoc.id] = clipStraight(s, t);
  }

  // §5.5  Final zigzag cleanup: detect and replace routes that zigzag excessively.
  //        Runs AFTER clipping (§5.1) + orthogonal enforcement (§5.3) because those
  //        steps can introduce zigzags when ELK routes start far from the source node
  //        (common for cross-lane edges).
  //        Skip happy-path edges — ELK's layout for these is usually correct.
  for (const proc of allProcesses) {
    for (const edge of (proc.edges || [])) {
      if (edge.isHappyPath) continue;

      const pts = edgeCoords[edge.id];
      if (!pts || pts.length < 3) continue;

      const srcC = coords[edge.source];
      const tgtC = coords[edge.target];
      if (!srcC || !tgtC) continue;

      const srcCx = srcC.x + srcC.w / 2;
      const srcCy = srcC.y + srcC.h / 2;
      const tgtCx = tgtC.x + tgtC.w / 2;
      const tgtCy = tgtC.y + tgtC.h / 2;

      // Criterion 1: route length vs direct Manhattan distance
      let routeLength = 0;
      for (let i = 1; i < pts.length; i++) {
        routeLength += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
      }
      const directDist = Math.abs(tgtCx - srcCx) + Math.abs(tgtCy - srcCy);

      // Criterion 2: Y-range exceedance
      const routeYs = pts.map(p => p.y);
      const routeYRange = Math.max(...routeYs) - Math.min(...routeYs);
      const nodeYRange = Math.abs(tgtCy - srcCy);

      const isZigzag =
        (directDist > 20 && routeLength > 3 * directDist) ||
        (routeYRange > nodeYRange + 200);

      if (!isZigzag) continue;

      // Replace with clean orthogonal route
      const dx = Math.abs(tgtCx - srcCx);
      const dy = Math.abs(tgtCy - srcCy);

      if (dy > dx) {
        const srcExit  = { x: srcCx, y: srcCy > tgtCy ? srcC.y : srcC.y + srcC.h };
        const tgtEntry = { x: tgtCx, y: srcCy > tgtCy ? tgtC.y + tgtC.h : tgtC.y };
        const midY = (srcExit.y + tgtEntry.y) / 2;
        edgeCoords[edge.id] = [srcExit, { x: srcCx, y: midY }, { x: tgtCx, y: midY }, tgtEntry];
      } else {
        const goRight = tgtCx > srcCx;
        const srcExit  = { x: goRight ? srcC.x + srcC.w : srcC.x, y: srcCy };
        const tgtEntry = { x: goRight ? tgtC.x : tgtC.x + tgtC.w, y: tgtCy };
        const midX = (srcExit.x + tgtEntry.x) / 2;
        edgeCoords[edge.id] = [srcExit, { x: midX, y: srcCy }, { x: midX, y: tgtCy }, tgtEntry];
      }
    }
  }

  // §5.6  Edge label positions (absolute ELK coordinates, -5px offset stored so
  //        svg.js can apply ty(L.y) - 5 to preserve the original render position).
  //        Algorithm mirrors svg.js renderSequenceFlow exactly so existing goldens
  //        remain byte-identical when visual refinement is OFF.
  const edgeLabels = {};

  // Sequence-flow labels
  for (const proc of allProcesses) {
    for (const e of (proc.edges || [])) {
      if (!e.label) continue;
      const eid = e.id;
      const pts = edgeCoords[eid];
      if (!pts || pts.length < 2) {
        // Fallback: midpoint between source and target node centers
        const s = coords[e.source], t = coords[e.target];
        if (!s || !t) continue;
        edgeLabels[eid] = {
          text: e.label,
          x: (s.x + s.w / 2 + t.x + t.w / 2) / 2,
          y: (s.y + s.h / 2 + t.y + t.h / 2) / 2,
        };
        continue;
      }
      // Find first horizontal segment (dy < 1) — mirrors svg.js renderSequenceFlow
      let labelX = null, labelY = null;
      let placed = false;
      for (let i = 0; i < pts.length - 1; i++) {
        const dy = Math.abs(pts[i + 1].y - pts[i].y);
        if (dy < 1) {
          labelX = (pts[i].x + pts[i + 1].x) / 2;
          labelY = pts[i].y;
          placed = true;
          break;
        }
      }
      if (!placed) {
        // No horizontal segment: 30% from source — mirrors svg.js fallback
        const p0 = pts[0], p1 = pts[pts.length - 1];
        labelX = p0.x + (p1.x - p0.x) * 0.3;
        labelY = p0.y + (p1.y - p0.y) * 0.3;
      }
      edgeLabels[eid] = { text: e.label, x: labelX, y: labelY };
    }
  }

  // Message-flow routes and labels are NOT computed here — see routeMessageFlows(),
  // which runs after visual refinement because it depends on final participant
  // geometry.

  return { coords, laneCoords, poolCoords, edgeCoords, edgeLabels };
}

/**
 * Force all segments in a polyline to be either horizontal or vertical.
 * Diagonal segments are converted to L-shaped dog-legs:
 *   - If the segment is more horizontal than vertical: go horizontal first, then vertical
 *   - If more vertical: go vertical first, then horizontal
 */
function enforceOrthogonal(pts) {
  if (pts.length < 2) return pts;
  const result = [pts[0]];

  for (let i = 1; i < pts.length; i++) {
    const prev = result[result.length - 1];
    const cur  = pts[i];
    const dx   = Math.abs(cur.x - prev.x);
    const dy   = Math.abs(cur.y - prev.y);

    // Already orthogonal (within tolerance)
    if (dx < 1 || dy < 1) {
      // Snap to exact axis
      if (dx < 1) {
        result.push({ x: prev.x, y: cur.y });
      } else {
        result.push({ x: cur.x, y: prev.y });
      }
      continue;
    }

    // Diagonal — insert a bend point to make it orthogonal
    // Prefer horizontal-first for left→right flow direction
    if (dx >= dy) {
      // Go horizontal to target x, then vertical to target y
      result.push({ x: cur.x, y: prev.y });
      result.push(cur);
    } else {
      // Go vertical to target y, then horizontal to target x
      result.push({ x: prev.x, y: cur.y });
      result.push(cur);
    }
  }
  return result;
}

/**
 * Place artifacts (text annotations, data objects, data stores, groups).
 *
 * They are kept out of the ELK graph on purpose: an artifact without an
 * association is disconnected, and ELK then hands it the first layer — measured
 * on a test graph, an unattached data store pushed the start event 184 px to the
 * right. So they are positioned here instead, against the element they annotate,
 * which is also where BPMN convention puts them.
 *
 * Anchor: the associated element, stacked below it. Below rather than above,
 * because §5.0 derives the lane band from node positions afterwards and grows
 * it downwards — placing an artifact above its anchor would push it out of the
 * top of the pool. Artifacts without any association go below the process,
 * left-aligned, in declaration order.
 */
function placeArtifacts(coords, allProcesses, lc) {
  const associations = lc.associations || [];
  const partnerOf = {};
  for (const a of associations) {
    // An association may point either way; the partner is whichever end is not
    // the artifact itself.
    partnerOf[a.source] ??= a.target;
    partnerOf[a.target] ??= a.source;
  }

  const placedBelow = {};   // anchorId → how many artifacts already sit below it
  const orphans = [];

  for (const proc of allProcesses) {
    for (const node of flattenProcessNodes(proc.nodes)) {
      if (!isArtifact(node.type) || coords[node.id]) continue;
      const sz = SHAPE[node.type] || SHAPE._textAnnotation || { w: 100, h: 80 };
      const anchor = coords[partnerOf[node.id]];
      if (!anchor) { orphans.push({ node, sz }); continue; }

      const anchorId = partnerOf[node.id];
      const slot = placedBelow[anchorId] = (placedBelow[anchorId] ?? -1) + 1;
      coords[node.id] = {
        x: anchor.x + anchor.w / 2 - sz.w / 2,
        y: anchor.y + anchor.h + ARTIFACT_GAP + slot * (sz.h + ARTIFACT_GAP),
        w: sz.w,
        h: sz.h,
      };
    }
  }

  if (orphans.length === 0) return;
  const placed = Object.values(coords);
  let x = placed.length ? Math.min(...placed.map(c => c.x)) : 0;
  const y = (placed.length ? Math.max(...placed.map(c => c.y + c.h)) : 0) + ARTIFACT_GAP;
  for (const { node, sz } of orphans) {
    coords[node.id] = { x, y, w: sz.w, h: sz.h };
    x += sz.w + ARTIFACT_GAP;
  }
}

/**
 * Straight connection between two shapes, clipped to both borders.
 * Associations are drawn as straight lines in BPMN, so this is a plain
 * centre-to-centre segment cut back to where it meets each rectangle.
 */
function clipStraight(a, b) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  return [clipToRect(ac, bc, a), clipToRect(bc, ac, b)];
}

/** Move `from` (a shape centre) onto the border of `rect`, along from→towards. */
function clipToRect(from, towards, rect) {
  const dx = towards.x - from.x;
  const dy = towards.y - from.y;
  if (dx === 0 && dy === 0) return { x: from.x, y: from.y };
  const halfW = rect.w / 2;
  const halfH = rect.h / 2;
  const scale = Math.min(
    dx === 0 ? Infinity : halfW / Math.abs(dx),
    dy === 0 ? Infinity : halfH / Math.abs(dy),
  );
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}

function messageFlowKey(mf) {
  return mf.id || `mf_${mf.source}_${mf.target}`;
}

/**
 * Orthogonal route for a message flow: out of the source shape, across in the
 * corridor between two participants, into the target shape.
 *
 * The horizontal leg deliberately runs in the POOL_GAP corridor and not at the
 * midpoint between the two shapes — a midpoint leg would cut horizontally
 * through a pool body, which reads as a participation that does not exist.
 */
function routeMessageFlow(srcCoord, tgtCoord, poolCoords, corridorUse = {}) {
  const { sx, sy, ex, ey } = messageFlowPorts(srcCoord, tgtCoord);
  if (Math.abs(sx - ex) < 2) return [{ x: sx, y: sy }, { x: ex, y: ey }];

  const corridorY = fanOut(participantGapY(sy, ey, poolCoords), corridorUse);
  return [
    { x: sx, y: sy },
    { x: sx, y: corridorY },
    { x: ex, y: corridorY },
    { x: ex, y: ey },
  ];
}

/**
 * Spread flows that land in the same corridor, so their horizontal legs do not
 * coincide. Offsets alternate around the corridor centre (0, +14, -14, +28, …)
 * and stay inside the POOL_GAP, so a fanned-out leg never enters a pool.
 */
function fanOut(corridorY, corridorUse) {
  const key = Math.round(corridorY);
  const n = corridorUse[key] = (corridorUse[key] ?? -1) + 1;
  if (n === 0) return corridorY;

  const step = Math.ceil(n / 2) * MESSAGE_FLOW_FAN;
  const maxOffset = POOL_GAP / 2 - MESSAGE_FLOW_FAN / 2;
  const offset = Math.min(step, maxOffset) * (n % 2 === 1 ? 1 : -1);
  return corridorY + offset;
}

/**
 * y of the gap between the participant the flow leaves and the next one in the
 * direction of travel. Falls back to the midpoint when no gap can be identified
 * (single participant, or a flow that stays inside one band).
 */
function participantGapY(fromY, toY, poolCoords) {
  const bands = Object.values(poolCoords)
    .filter(p => Number.isFinite(p.y) && Number.isFinite(p.h))
    .map(p => ({ top: p.y, bottom: p.y + p.h }))
    .sort((a, b) => a.top - b.top);

  const downward = toY > fromY;
  const idx = bands.findIndex(b => fromY >= b.top - 1 && fromY <= b.bottom + 1);
  if (idx === -1) return (fromY + toY) / 2;

  const neighbour = downward ? bands[idx + 1] : bands[idx - 1];
  if (!neighbour) return (fromY + toY) / 2;

  return downward
    ? (bands[idx].bottom + neighbour.top) / 2
    : (neighbour.bottom + bands[idx].top) / 2;
}

/**
 * Lane a node belongs to, across both Logic-Core lane formats.
 * A boundary event inherits the lane of the activity it is attached to — it has
 * no lane of its own and must never drift into a different band than its host.
 */
function laneOfNode(node, proc) {
  if (!node) return undefined;
  const direct = resolveLaneId(proc, node);
  if (direct) return direct;
  if (node.attachedTo) {
    const host = (proc.nodes || []).find(n => n.id === node.attachedTo);
    if (host) return resolveLaneId(proc, host);
  }
  return undefined;
}

function flattenProcessNodes(nodes) {
  const out = [];
  for (const n of nodes || []) {
    out.push(n);
    if (n.nodes) out.push(...flattenProcessNodes(n.nodes));
  }
  return out;
}

function flattenProcessEdges(proc) {
  const out = [...(proc.edges || [])];
  for (const n of flattenProcessNodes(proc.nodes)) {
    if (n.edges) out.push(...n.edges);
  }
  return out;
}

function findNodeInAllProcesses(nodeId, processes) {
  for (const p of processes) {
    for (const n of (p.nodes || [])) {
      if (n.id === nodeId) return n;
      // Search inside expanded subprocesses (1 level)
      if (n.isExpanded && n.nodes) {
        const child = n.nodes.find(c => c.id === nodeId);
        if (child) return child;
      }
    }
  }
  return null;
}

/**
 * Position boundary events on the border of their host activity.
 *
 * ELK never sees boundary events (layout.js filters them out and re-anchors
 * their sequence flows on the host), so nothing has assigned them coordinates
 * yet. BPMN convention — and bpmn.io's own behaviour — is to place them
 * straddling the host's bottom edge; several events on the same host are
 * spread evenly across that edge.
 *
 * Mutates `coords` in place. Hosts without coordinates are skipped, which
 * leaves the boundary event unplaced rather than placing it at (0,0).
 *
 * @returns Set of ids of the boundary events that were placed
 */
function placeBoundaryEvents(coords, allProcesses) {
  const byHost = {};
  const collect = (nodes) => {
    for (const n of nodes || []) {
      if (isBoundaryEvent(n) && n.attachedTo) (byHost[n.attachedTo] ||= []).push(n);
      if (n.nodes) collect(n.nodes);
    }
  };
  for (const p of allProcesses) collect(p.nodes);

  const placed = new Set();
  for (const [hostId, events] of Object.entries(byHost)) {
    const host = coords[hostId];
    if (!host) continue;
    events.forEach((ev, i) => {
      const sz = SHAPE[ev.type] || { w: 36, h: 36 };
      coords[ev.id] = {
        x: host.x + (host.w * (i + 1)) / (events.length + 1) - sz.w / 2,
        y: host.y + host.h - sz.h / 2,
        w: sz.w,
        h: sz.h,
      };
      placed.add(ev.id);
    });
  }
  return placed;
}

/**
 * Orthogonal clipping: project endpoint onto shape boundary while keeping
 * the segment axis (horizontal or vertical) intact.
 *
 * @param shape   {x,y,w,h} of the actual BPMN shape
 * @param type    BPMN element type
 * @param edgePt  the endpoint to clip (start or end of the path)
 * @param nextPt  the adjacent point (determines segment direction)
 * @param role    'source' or 'target'
 */
function clipOrthogonal(shape, type, edgePt, nextPt, role) {
  const cx = shape.x + shape.w / 2;
  const cy = shape.y + shape.h / 2;

  // Determine if segment is horizontal or vertical
  const dx = Math.abs(nextPt.x - edgePt.x);
  const dy = Math.abs(nextPt.y - edgePt.y);
  const isHorizontal = dx >= dy;

  if (isEvent(type)) {
    const r = shape.w / 2;
    return clipCircleOrthogonal(cx, cy, r, nextPt, isHorizontal);
  }
  if (isGateway(type)) {
    return clipDiamondOrthogonal(shape, nextPt, isHorizontal);
  }
  // Activity / rectangle
  return clipRectOrthogonal(shape, nextPt, isHorizontal);
}

/**
 * Circle: for horizontal approach, place point at cx ± r on the y-level of nextPt.
 * For vertical approach, place at cy ± r on the x-level of nextPt.
 */
function clipCircleOrthogonal(cx, cy, r, nextPt, isHorizontal) {
  if (isHorizontal) {
    // Horizontal segment: keep y from nextPt, compute x on circle boundary
    const y = nextPt.y;
    const dyc = y - cy;
    // Clamp: if nextPt.y is outside the circle, snap to center height
    if (Math.abs(dyc) >= r) {
      return { x: nextPt.x > cx ? cx + r : cx - r, y: cy };
    }
    const xOffset = Math.sqrt(r * r - dyc * dyc);
    const x = nextPt.x > cx ? cx + xOffset : cx - xOffset;
    return { x, y };
  } else {
    // Vertical segment: keep x from nextPt, compute y on circle boundary
    const x = nextPt.x;
    const dxc = x - cx;
    if (Math.abs(dxc) >= r) {
      return { x: cx, y: nextPt.y > cy ? cy + r : cy - r };
    }
    const yOffset = Math.sqrt(r * r - dxc * dxc);
    const y = nextPt.y > cy ? cy + yOffset : cy - yOffset;
    return { x, y };
  }
}

/**
 * Diamond: for horizontal approach, find x where the diamond edge crosses the y-level.
 * For vertical, find y where the diamond edge crosses the x-level.
 * Diamond with center (cx,cy) and half-widths (hw,hh):
 *   |x-cx|/hw + |y-cy|/hh = 1
 */
function clipDiamondOrthogonal(shape, nextPt, isHorizontal) {
  const cx = shape.x + shape.w / 2;
  const cy = shape.y + shape.h / 2;
  const hw = shape.w / 2, hh = shape.h / 2;

  if (isHorizontal) {
    const y = nextPt.y;
    const dyc = Math.abs(y - cy);
    if (dyc >= hh) {
      // Outside diamond vertically, snap to tip
      return { x: cx, y: nextPt.y > cy ? cy + hh : cy - hh };
    }
    const xOffset = hw * (1 - dyc / hh);
    const x = nextPt.x > cx ? cx + xOffset : cx - xOffset;
    return { x, y };
  } else {
    const x = nextPt.x;
    const dxc = Math.abs(x - cx);
    if (dxc >= hw) {
      return { x: nextPt.x > cx ? cx + hw : cx - hw, y: cy };
    }
    const yOffset = hh * (1 - dxc / hw);
    const y = nextPt.y > cy ? cy + yOffset : cy - yOffset;
    return { x, y };
  }
}

/**
 * Rectangle: for horizontal approach, x = left or right edge, y stays.
 * For vertical, y = top or bottom edge, x stays.
 */
function clipRectOrthogonal(shape, nextPt, isHorizontal) {
  if (isHorizontal) {
    const y = nextPt.y;
    // Clamp y to be within the rect
    const clampedY = Math.max(shape.y, Math.min(shape.y + shape.h, y));
    const x = nextPt.x > shape.x + shape.w / 2 ? shape.x + shape.w : shape.x;
    return { x, y: clampedY };
  } else {
    const x = nextPt.x;
    const clampedX = Math.max(shape.x, Math.min(shape.x + shape.w, x));
    const y = nextPt.y > shape.y + shape.h / 2 ? shape.y + shape.h : shape.y;
    return { x: clampedX, y };
  }
}

/**
 * Pick natural endpoint ports for a message flow based on the relative position
 * of source and target shapes. Returns { sx, sy, ex, ey } in absolute coords.
 *
 * Convention (matching bpmn.io):
 * - If source is ABOVE target: exit source bottom, enter target top (downward)
 * - If source is BELOW target: exit source top, enter target bottom (upward)
 *
 * Used by message-flow rendering in svg.js and bpmn-xml.js, and by
 * coordinates.js for message-flow label positioning. Falling back to the
 * legacy bottom→top behavior would be wrong for upward flows (e.g., a
 * service-pool merge gateway sending a response back to a customer pool).
 */
export function messageFlowPorts(srcCoord, tgtCoord) {
  const sCenterY = (srcCoord.y || 0) + (srcCoord.h || 0) / 2;
  const tCenterY = (tgtCoord.y || 0) + (tgtCoord.h || 0) / 2;
  const sxCenter = (srcCoord.x || 0) + (srcCoord.w || 0) / 2;
  const exCenter = (tgtCoord.x || 0) + (tgtCoord.w || 0) / 2;
  const downward = sCenterY < tCenterY;
  return {
    sx: sxCenter,
    sy: downward ? (srcCoord.y || 0) + (srcCoord.h || 0) : (srcCoord.y || 0),
    ex: exCenter,
    ey: downward ? (tgtCoord.y || 0) : (tgtCoord.y || 0) + (tgtCoord.h || 0),
  };
}

/**
 * Route message flows and place their labels. MUTATES coordMap.
 *
 * Deliberately NOT part of buildCoordinateMap: a message flow's horizontal leg
 * has to lie in the gap between two participants, and that gap is only final
 * once every pass that moves participants has run — including the opt-in
 * visual-refinement ones. Routed any earlier, a later pass silently invalidates
 * the invariant: measured with lane compaction on, three of eight legs ended up
 * inside a pool body.
 *
 * Message flows depend on final participant and node geometry, and nothing
 * except the two renderers depends on them. They are a leaf of the dependency
 * chain, so they belong at its end.
 */
function routeMessageFlows(coordMap, lc) {
  const { coords, poolCoords, edgeCoords, edgeLabels } = coordMap;
  const corridorUse = {};

  for (const mf of (lc.messageFlows || [])) {
    // Fall back to poolCoords: a message flow may end on a black-box
    // participant, which has no entry in `coords`.
    const srcCoord = coords[mf.source] || poolCoords[mf.source];
    const tgtCoord = coords[mf.target] || poolCoords[mf.target];
    if (!srcCoord || !tgtCoord) continue;

    const key = messageFlowKey(mf);
    const pts = routeMessageFlow(srcCoord, tgtCoord, poolCoords, corridorUse);
    edgeCoords[key] = pts;

    if (!mf.name) continue;
    // Label on the horizontal leg. Deriving it from the shapes instead (and
    // without the poolCoords fallback) used to drop every black-box flow's
    // label at the same phantom position, far from the flow it belongs to.
    const [a, b] = pts.length >= 4 ? [pts[1], pts[2]] : [pts[0], pts[pts.length - 1]];
    edgeLabels[key] = { text: mf.name, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  return coordMap;
}

export { buildCoordinateMap, enforceOrthogonal, findNodeInAllProcesses, clipOrthogonal, routeMessageFlows };
