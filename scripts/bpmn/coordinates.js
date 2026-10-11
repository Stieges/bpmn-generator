/**
 * BPMN Coordinates — ELK Result → Coordinate Maps + Edge Clipping
 * Translates raw ELK layout output into absolute coordinates for rendering.
 */

import { isEvent, isGateway, isBoundaryEvent, isArtifact } from './types.js';
import { SHAPE, LANE_HEADER_W, LANE_PADDING, EXTERNAL_LABEL_H, POOL_GAP, MESSAGE_FLOW_FAN, ARTIFACT_GAP, artifactSize } from './constants.js';
import { CFG } from '../shared/utils.js';
import { identifyHappyPathNodes, resolveLaneId, assignEdgeIds } from './topology.js';
import { clipStraight } from '../shared/geometry.js';

/**
 * Public entry: fills MISSING edge ids on the caller's object (in place, idempotent, deterministic via
 * `assignEdgeIds`); `runPipeline` instead works on a copy.
 */
function buildCoordinateMap(elkResult, lc) {
  // Public entry: complete any id-less edge so geometry, XML and SVG all key on the same id (#64).
  assignEdgeIds(lc);
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

  // containerId → the band at the bottom of an expanded subprocess that layout.js kept free for
  // the artifacts it declares (see artifactReserveHeight there). placeArtifacts fills it.
  const artifactBands = {};

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
      if (node._artifactReserve > 0) {
        // 20 = the container's left/right/bottom ELK padding in layout.js, outside the band.
        artifactBands[node.id] = {
          x: ax + 20, y: ay + node.height - 20 - node._artifactReserve,
          w: node.width - 40, h: node._artifactReserve,
        };
      }
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
  const boundaryHosts = placeBoundaryEvents(coords, allProcesses);
  placeArtifacts(coords, allProcesses, lc, artifactBands);

  //        Their sequence flows were routed by ELK from the HOST, so the stored
  //        route starts at the wrong shape and keeps a backtracking bend.
  //        Drop it — §5.2 re-routes them cleanly from the boundary event.
  //        flattenProcessEdges, not proc.edges: a boundary event inside an
  //        expanded subprocess is just as attached to its host, and walking only
  //        the top level left those flows starting at the host shape.
  if (boundaryHosts.size > 0) {
    for (const proc of allProcesses) {
      for (const e of flattenProcessEdges(proc)) {
        if (boundaryHosts.has(e.source)) delete edgeCoords[e.id];
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
          if (laneOfNode(n, proc) !== laneId) continue;
          // An expanded subprocess carries its children and their edges with it:
          // collectNodes gave them their own ABSOLUTE entries, so moving only the
          // parent box would leave the children behind — a whole lane band away.
          for (const inner of flattenProcessNodes([n])) {
            if (coords[inner.id]) coords[inner.id].y += delta;
          }
          for (const inner of flattenProcessEdges(n)) {
            for (const p of (edgeCoords[inner.id] || [])) p.y += delta;
          }
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

      edgeCoords[edge.id] = orthogonalConnect(srcC, tgtC, {
        hostC: coords[boundaryHosts.get(edge.source)],
      });
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
  // Flattened, so that §5.2 can also re-route a boundary flow nested inside an
  // expanded subprocess. Edges that already carry an ELK route are skipped
  // there, so widening this set is a no-op for everything except the routes
  // §5.0- just deleted.
  const allProcessEdges = allProcesses.flatMap(p => flattenProcessEdges(p));
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

    edgeCoords[eid] = orthogonalConnect(srcC, tgtC, {
      hostC: coords[boundaryHosts.get(edge.source)],
      // This section has always exited right and entered left, whatever the
      // direction — see orthogonalConnect's doc for why that is preserved.
      directionalHorizontal: false,
    });
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
  //        Skip boundary flows too: leaving away from the host and coming back
  //        round is long with a wide Y-range by construction, which is exactly
  //        what the zigzag test looks for, so this section would undo the
  //        detour that keeps the flow out of its own host.
  for (const proc of allProcesses) {
    for (const edge of (proc.edges || [])) {
      if (edge.isHappyPath) continue;
      if (boundaryHosts.has(edge.source)) continue;

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

      edgeCoords[edge.id] = orthogonalConnect(srcC, tgtC);
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
      const label = computeSequenceFlowLabel(e, edgeCoords[e.id], coords);
      if (label) edgeLabels[e.id] = label;
    }
  }

  // Message-flow routes and labels are NOT computed here — see routeMessageFlows(),
  // which runs after visual refinement because it depends on final participant
  // geometry.

  return { coords, laneCoords, poolCoords, edgeCoords, edgeLabels };
}

/**
 * Where a sequence flow's label sits, given its route. Returns null when the
 * edge has no label (or the fallback has nothing to work with).
 *
 * Extracted from §5.6 so that a pass which re-routes an edge after
 * buildCoordinateMap has returned can refresh that edge's label instead of
 * leaving it stranded on a segment the route no longer has — see
 * pipeline.js's crossing-repair step. Behaviour is unchanged; the algorithm
 * still mirrors svg.js renderSequenceFlow exactly, which is what keeps the
 * two renderers in agreement.
 */
function computeSequenceFlowLabel(edge, pts, coords) {
  if (!edge.label) return null;
  if (!pts || pts.length < 2) {
    // Fallback: midpoint between source and target node centers
    const s = coords[edge.source], t = coords[edge.target];
    if (!s || !t) return null;
    return {
      text: edge.label,
      x: (s.x + s.w / 2 + t.x + t.w / 2) / 2,
      y: (s.y + s.h / 2 + t.y + t.h / 2) / 2,
    };
  }
  // Find first horizontal segment (dy < 1) — mirrors svg.js renderSequenceFlow
  for (let i = 0; i < pts.length - 1; i++) {
    if (Math.abs(pts[i + 1].y - pts[i].y) < 1) {
      return { text: edge.label, x: (pts[i].x + pts[i + 1].x) / 2, y: pts[i].y };
    }
  }
  // No horizontal segment: 30% from source — mirrors svg.js fallback
  const p0 = pts[0], p1 = pts[pts.length - 1];
  return {
    text: edge.label,
    x: p0.x + (p1.x - p0.x) * 0.3,
    y: p0.y + (p1.y - p0.y) * 0.3,
  };
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
 * left-aligned, in declaration order — unless an expanded subprocess declares
 * them: then they go into the band layout.js kept free at that subprocess's
 * bottom, so they stay inside the container that owns them (DI06). Stacking
 * below the whole collaboration put them outside both the subprocess and the
 * participant.
 */
function placeArtifacts(coords, allProcesses, lc, artifactBands = {}) {
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
  const bandOrphans = [];   // unassociated artifacts that go into their container's band

  // Which expanded subprocess, if any, directly declares each node.
  const containerOf = {};
  const indexContainers = (nodes, containerId) => {
    for (const n of nodes || []) {
      if (containerId) containerOf[n.id] = containerId;
      if (n.nodes?.length) indexContainers(n.nodes, n.id);
    }
  };
  for (const proc of allProcesses) indexContainers(proc.nodes, null);

  for (const proc of allProcesses) {
    for (const node of flattenProcessNodes(proc.nodes)) {
      if (!isArtifact(node.type) || coords[node.id]) continue;
      const sz = artifactSize(node.type);
      const anchor = coords[partnerOf[node.id]];
      const containerId = containerOf[node.id];
      if (!anchor && artifactBands[containerId]) { bandOrphans.push({ node, sz, containerId }); continue; }
      if (!anchor) { orphans.push({ node, sz }); continue; }

      const anchorId = partnerOf[node.id];
      // An artifact belongs to the lane of what it annotates. Without this it
      // has no lane at all, so §5.0 leaves it out of the band's bounding box and
      // §5.0a does not move it when the band shifts — it stays at the anchor's
      // OLD position, up to a full band away from it.
      node.lane ??= laneOfNode(proc.nodes.find(n => n.id === anchorId), proc);
      const slot = placedBelow[anchorId] = (placedBelow[anchorId] ?? -1) + 1;
      coords[node.id] = {
        x: anchor.x + anchor.w / 2 - sz.w / 2,
        y: anchor.y + anchor.h + ARTIFACT_GAP + slot * (sz.h + ARTIFACT_GAP),
        w: sz.w,
        h: sz.h,
      };
    }
  }

  // Band artifacts last: an associated artifact whose anchor sits near the container's bottom
  // hangs into the band, so the band's free slots are only known once every anchored one is down.
  // Row by row, left to right, skipping anything already there. The band holds one row per
  // artifact the container declares, so it has room for every one of them.
  const cursor = {};        // containerId → { x, y, rowH }
  const collides = (r) => Object.values(coords).some(c =>
    r.x < c.x + c.w && c.x < r.x + r.w && r.y < c.y + c.h && c.y < r.y + r.h
    // a container (the band's own subprocess and its ancestors) encloses the slot — not a collision
    && !(c.x <= r.x && c.y <= r.y && c.x + c.w >= r.x + r.w && c.y + c.h >= r.y + r.h));
  for (const { node, sz, containerId } of bandOrphans) {
    const band = artifactBands[containerId];
    const cur = cursor[containerId] ??= { x: band.x, y: band.y + ARTIFACT_GAP, rowH: 0 };
    let slot;
    for (let guard = 0; guard < 1000; guard++) {
      if (cur.x > band.x && cur.x + sz.w > band.x + band.w) {
        cur.x = band.x; cur.y += Math.max(cur.rowH, sz.h) + ARTIFACT_GAP; cur.rowH = 0;
      }
      const candidate = { x: cur.x, y: cur.y, w: sz.w, h: sz.h };
      if (!collides(candidate)) { slot = candidate; break; }
      cur.x += ARTIFACT_GAP;
    }
    coords[node.id] = slot ?? { x: cur.x, y: cur.y, w: sz.w, h: sz.h };
    cur.x += sz.w + ARTIFACT_GAP;
    cur.rowH = Math.max(cur.rowH, sz.h);
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

// clipStraight/clipToRect moved to scripts/shared/geometry.js — a second notation (DMN's DRD)
// needs the same straight-line clip. See that file's header comment for the shared/ boundary rule.

function messageFlowKey(mf) {
  return mf.id || `mf_${mf.source}_${mf.target}`;
}

/**
 * Spread the flows sharing a corridor evenly across it, so their horizontal legs
 * do not coincide.
 *
 * `total` is counted up front rather than assigned as flows arrive: an
 * incremental ±step saturates against the POOL_GAP bound, and from the sixth
 * flow in one corridor the offsets started repeating — legs coincided again,
 * which is exactly what this is here to prevent. With the count known, the
 * spacing simply shrinks to fit.
 */
function fanOut(corridorY, index, total) {
  if (total <= 1) return corridorY;
  const span = POOL_GAP - MESSAGE_FLOW_FAN;             // usable width, gap edges kept clear
  const step = Math.min(MESSAGE_FLOW_FAN, span / (total - 1));
  return corridorY + (index - (total - 1) / 2) * step;
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

/**
 * Does this polyline pass through the OPEN interior of a box?
 *
 * Strict on purpose: a segment lying exactly on an edge of the box only touches
 * it. That distinction is what lets a boundary event's flow run along its
 * host's outline (fine, and the common case) while catching a flow that cuts
 * across the host's body (not fine — see orthogonalConnect).
 */
function entersInterior(pts, box) {
  if (!box) return false;
  const EPS = 1e-9;
  // Does [lo,hi] reach into the OPEN interval (min,max)? A zero-length span —
  // which is what an axis-aligned segment gives on its constant axis — counts
  // only when the point itself lies strictly between min and max.
  const overlapsOpen = (lo, hi, min, max) => (hi - lo < EPS)
    ? (lo > min + EPS && lo < max - EPS)
    : (Math.max(lo, min) < Math.min(hi, max) - EPS);

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const insideX = overlapsOpen(Math.min(a.x, b.x), Math.max(a.x, b.x), box.x, box.x + box.w);
    const insideY = overlapsOpen(Math.min(a.y, b.y), Math.max(a.y, b.y), box.y, box.y + box.h);
    if (insideX && insideY) return true;
  }
  return false;
}

/**
 * Which way is "away from the host" for a boundary event sitting on its outline?
 * Derived from the two centers rather than hard-coded to 'down', so that if
 * placeBoundaryEvents ever stops using the bottom edge the routing follows
 * instead of silently staying wrong.
 */
function outwardFromHost(evC, hostC) {
  const dx = (evC.x + evC.w / 2) - (hostC.x + hostC.w / 2);
  const dy = (evC.y + evC.h / 2) - (hostC.y + hostC.h / 2);
  if (Math.abs(dy) >= Math.abs(dx)) return dy >= 0 ? 'down' : 'up';
  return dx >= 0 ? 'right' : 'left';
}

/**
 * The orthogonal connection used wherever a route has to be built from scratch:
 * leave the source, cross over on a mid-line, enter the target. Three sections
 * (§5.0e detour compaction, §5.2 synthetic routing, §5.5 zigzag cleanup) all
 * need this, and all three used to carry their own copy of it.
 *
 * @param {object} srcC   source box {x,y,w,h}
 * @param {object} tgtC   target box
 * @param {object} [opts]
 * @param {object} [opts.hostC]  host box, when the source is a boundary event
 * @param {number} [opts.clearance]  how far past the event to run before
 *   turning. Must stay BELOW visual-refinement.js's LANE_COMPACT_PADDING:
 *   `compactLanes` shrinks a lane to its content plus that padding and pins any
 *   waypoint caught in the vanishing strip to the new edge, while the nodes
 *   move by the full delta. A corridor further out than the padding is exactly
 *   such a waypoint, and the route would be left hanging off its own source.
 * @param {boolean} [opts.directionalHorizontal=true]  leave from the side that
 *   faces the target. §5.2 passes false because it has always exited right and
 *   entered left regardless of direction; that asymmetry predates this helper
 *   and changing it would move edges in fixtures that have golden files, so it
 *   is preserved deliberately rather than quietly "fixed" here.
 */
function orthogonalConnect(srcC, tgtC, opts = {}) {
  const {
    hostC = null,
    clearance = CFG.layout?.boundaryExitClearance ?? 12,
    directionalHorizontal = true,
  } = opts;

  const srcCx = srcC.x + srcC.w / 2;
  const srcCy = srcC.y + srcC.h / 2;
  const tgtCx = tgtC.x + tgtC.w / 2;
  const tgtCy = tgtC.y + tgtC.h / 2;

  const dx = Math.abs(tgtCx - srcCx);
  const dy = Math.abs(tgtCy - srcCy);

  let route;
  if (dy > dx) {
    const srcExit  = { x: srcCx, y: srcCy > tgtCy ? srcC.y : srcC.y + srcC.h };
    const tgtEntry = { x: tgtCx, y: srcCy > tgtCy ? tgtC.y + tgtC.h : tgtC.y };
    const midY = (srcExit.y + tgtEntry.y) / 2;
    route = [srcExit, { x: srcCx, y: midY }, { x: tgtCx, y: midY }, tgtEntry];
  } else {
    const goRight = directionalHorizontal ? tgtCx > srcCx : true;
    const srcExit  = { x: goRight ? srcC.x + srcC.w : srcC.x, y: srcCy };
    const tgtEntry = { x: goRight ? tgtC.x : tgtC.x + tgtC.w, y: tgtCy };
    const midX = (srcExit.x + tgtEntry.x) / 2;
    route = [srcExit, { x: midX, y: srcCy }, { x: midX, y: tgtCy }, tgtEntry];
  }

  // A boundary event straddles its host's outline, so half of it is inside the
  // host. The side-choice above only asks where the target is, which for a
  // target on the far side of the host means leaving through the host's body —
  // the flow then reads as if it came out of the activity itself. Only rebuild
  // when that actually happened: running ALONG the outline is normal, and the
  // space directly outward is often occupied by the host's own artifacts.
  if (hostC && entersInterior(route, hostC)) {
    route = boundaryOutwardRoute(srcC, tgtC, hostC, clearance);
  }
  return route;
}

/**
 * Leave the boundary event on the side facing away from its host, then work
 * back towards the target.
 *
 * Only the vertical case is built out, because `placeBoundaryEvents` puts every
 * boundary event on its host's bottom edge; `outwardFromHost` still derives the
 * direction rather than assuming it, so a future change of placement produces a
 * wrong-but-obvious route here instead of a silently wrong one elsewhere.
 */
function boundaryOutwardRoute(srcC, tgtC, hostC, clearance) {
  const srcCx = srcC.x + srcC.w / 2;
  const tgtCx = tgtC.x + tgtC.w / 2;
  const tgtCy = tgtC.y + tgtC.h / 2;
  const down = outwardFromHost(srcC, hostC) !== 'up';

  const exitY = down ? srcC.y + srcC.h : srcC.y;
  const corridorY = down ? exitY + clearance : exitY - clearance;

  // Target on the same side we just left towards: one turn is enough.
  if (down ? tgtCy > corridorY : tgtCy < corridorY) {
    const entryX = tgtCx >= srcCx ? tgtC.x : tgtC.x + tgtC.w;
    return [{ x: srcCx, y: exitY }, { x: srcCx, y: tgtCy }, { x: entryX, y: tgtCy }];
  }

  // Target lies back past the host. Coming straight back up would re-enter the
  // host — and when the target sits directly above the event the "detour" would
  // collapse into a line retracing itself. Step clear of the host sideways
  // first. Only needed while the return column still overlaps the host.
  const overlapsHost = tgtCx > hostC.x && tgtCx < hostC.x + hostC.w;
  const entryY = down ? tgtC.y + tgtC.h : tgtC.y;
  if (!overlapsHost) {
    return [
      { x: srcCx, y: exitY },
      { x: srcCx, y: corridorY },
      { x: tgtCx, y: corridorY },
      { x: tgtCx, y: entryY },
    ];
  }

  const viaLeft = tgtCx <= hostC.x + hostC.w / 2;
  const columnX = viaLeft ? hostC.x - clearance : hostC.x + hostC.w + clearance;
  const entryX = viaLeft ? tgtC.x : tgtC.x + tgtC.w;
  return [
    { x: srcCx, y: exitY },
    { x: srcCx, y: corridorY },
    { x: columnX, y: corridorY },
    { x: columnX, y: tgtCy },
    { x: entryX, y: tgtCy },
  ];
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

  // Maps each placed event to its host. A Set of ids would be enough to know
  // WHICH routes to discard, but routing them again also needs to know what to
  // stay out of, so the host travels with the id.
  const placed = new Map();
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
      placed.set(ev.id, hostId);
    });
  }
  return placed;
}

// clipOrthogonal and its three helpers below (clipCircleOrthogonal, clipDiamondOrthogonal,
// clipRectOrthogonal) stay here rather than moving to shared/geometry.js with clipStraight and
// clipToRect, even though they know no more about BPMN's semantics than those two did — the
// dispatcher branches on isEvent(type)/isGateway(type), but the three helpers it dispatches to are
// themselves plain shape maths. They stay anyway: shared/ takes what a second notation
// demonstrably imports, not everything that could be phrased format-independently. DMN's
// requirement connections are straight lines (DMN 1.3 §6.2.2 prescribes arrowheads and line style,
// not routing), so DMN only ever needed the straight clip. A diamond is, in this repository, a
// BPMN gateway and nothing else — DMN has none, ArchiMate has none — so under the broader rule
// clipDiamondOrthogonal would sit in shared/ unused forever. See
// docs/superpowers/specs/2026-07-31-dmn-drd-and-serialisation-design.md, "Where the boundary
// actually runs, and why it leaves pure code behind".

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

// ─── Message flows and the shapes they pass ────────────────────────────────
// Tunables in config.json → layout.messageFlowAvoidance. The clearance is config.json →
// layout.shapeClearance, the same one edge-simplify.js keeps for sequence flows (NODE_PADDING).
const MF_AVOID = {
  portInset: CFG.layout?.messageFlowAvoidance?.portInset ?? 10,
  columnStep: CFG.layout?.messageFlowAvoidance?.columnStep ?? 10,
  detourReach: CFG.layout?.messageFlowAvoidance?.detourReach ?? 600,
};
const MF_CLEARANCE = CFG.layout?.shapeClearance ?? 4;

/**
 * Shapes a message flow must not run through: every node box but its own two endpoints, except a
 * group (drawn to be overlapped) and a box containing an endpoint (the expanded subprocess a flow
 * starts or ends in — entering it is unavoidable).
 */
function messageFlowObstacles(mf, coords, srcCoord, tgtCoord, typeOf) {
  const contains = (o, i) => !!i && o.x <= i.x && o.y <= i.y && o.x + o.w >= i.x + i.w && o.y + o.h >= i.y + i.h;
  return Object.entries(coords)
    .filter(([id, b]) => id !== mf.source && id !== mf.target && typeOf[id] !== 'group'
      && !contains(b, srcCoord) && !contains(b, tgtCoord))
    .map(([, b]) => b);
}

function verticalClear(x, y0, y1, obstacles) {
  const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
  return obstacles.every(b =>
    x <= b.x - MF_CLEARANCE || x >= b.x + b.w + MF_CLEARANCE || hi <= b.y || lo >= b.y + b.h);
}

/**
 * Port x positions on a shape's top/bottom edge, centre first, then outward one step at a time.
 * Only an activity offers more than its centre: on a circle or a diamond any other x is off the
 * outline, and a black-box participant has no entry in `coords`.
 */
function portColumns(x0, shape, movable) {
  const out = [x0];
  if (!movable) return out;
  const lo = shape.x + MF_AVOID.portInset;
  const hi = shape.x + shape.w - MF_AVOID.portInset;
  for (let k = 1; x0 - k * MF_AVOID.columnStep >= lo || x0 + k * MF_AVOID.columnStep <= hi; k++) {
    for (const x of [x0 - k * MF_AVOID.columnStep, x0 + k * MF_AVOID.columnStep]) {
      if (x >= lo && x <= hi) out.push(x);
    }
  }
  return out;
}

/** Nearest x to x0 (left first at equal distance) whose span y0..y1 is clear, or null. */
function nearestClearColumn(x0, y0, y1, obstacles) {
  for (let d = 0; d <= MF_AVOID.detourReach; d += MF_AVOID.columnStep) {
    for (const x of (d === 0 ? [x0] : [x0 - d, x0 + d])) {
      if (verticalClear(x, y0, y1, obstacles)) return x;
    }
  }
  return null;
}

function horizontalClear(y, x0, x1, obstacles) {
  const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
  return obstacles.every(b =>
    y <= b.y - MF_CLEARANCE || y >= b.y + b.h + MF_CLEARANCE || hi <= b.x || lo >= b.x + b.w);
}

/**
 * A leg from a port at (px, py) to farY that no port column clears, because a shape of the flow's
 * own participant sits in every column (the task in the next lane below the sender). Step to
 * halfway between the port and that shape, across to the nearest column clear from there to
 * farY, then on. Returns the leg's points (the last one at farY) or null. The jog lies inside the
 * endpoint's own participant by construction: the first blocking shape is the nearest one.
 */
function jogLeg(px, py, farY, obstacles) {
  const dir = Math.sign(farY - py);
  const blockers = obstacles.filter(b => px > b.x - MF_CLEARANCE && px < b.x + b.w + MF_CLEARANCE
    && Math.max(py, farY) > b.y && Math.min(py, farY) < b.y + b.h);
  if (!blockers.length) return null;
  const first = dir > 0 ? Math.min(...blockers.map(b => b.y)) : Math.max(...blockers.map(b => b.y + b.h));
  const jogY = (py + first) / 2;
  if ((jogY - py) * dir <= 0 || !verticalClear(px, py, jogY, obstacles)) return null;
  for (let d = MF_AVOID.columnStep; d <= MF_AVOID.detourReach; d += MF_AVOID.columnStep) {
    for (const x of [px - d, px + d]) {
      if (horizontalClear(jogY, px, x, obstacles) && verticalClear(x, jogY, farY, obstacles)) {
        return [{ x: px, y: py }, { x: px, y: jogY }, { x, y: jogY }, { x, y: farY }];
      }
    }
  }
  return null;
}

/**
 * Where a message flow's legs go, before fan-out. A point on a corridor carries `corridor`
 * (its un-fanned y) instead of `y`; routeMessageFlows resolves it once every flow's corridors are
 * known.
 *  - straight and clear: one vertical segment, as before;
 *  - otherwise out of the source in the first port column that clears the source leg, across in
 *    the corridor next to the source's participant, into the target in the first column that
 *    clears the target leg;
 *  - if no target column clears it, the leg crosses a shape of a participant in between: detour —
 *    across to the nearest clear column, down to the corridor next to the TARGET's participant,
 *    across, and in. Both horizontal legs lie in participant gaps, never in a pool body;
 *  - a leg that no column clears because of a shape in the endpoint's OWN participant jogs inside
 *    that participant (jogLeg) — the one place a horizontal leg may lie in a pool body;
 *  - a leg nothing clears keeps today's centre column (not made worse; the bench reports it).
 */
function planMessageFlow(mf, srcCoord, tgtCoord, poolCoords, obstacles, movable) {
  const { sx, sy, ex, ey } = messageFlowPorts(srcCoord, tgtCoord);
  if (Math.abs(sx - ex) < 2 && verticalClear(sx, sy, ey, obstacles)) {
    return { corridors: [], points: [{ x: sx, y: sy }, { x: ex, y: ey }] };
  }
  const c = participantGapY(sy, ey, poolCoords);
  const sCols = portColumns(sx, srcCoord, movable.source);
  const sCol = sCols.find(x => verticalClear(x, sy, c, obstacles));
  let head;
  if (sCol !== undefined) head = [{ x: sCol, y: sy }, { x: sCol, corridor: c }];
  else {
    const jog = sCols.map(x => jogLeg(x, sy, c, obstacles)).find(Boolean);
    head = jog
      ? [...jog.slice(0, -1), { x: jog[jog.length - 1].x, corridor: c }]
      : [{ x: sx, y: sy }, { x: sx, corridor: c }];
  }
  const tCols = portColumns(ex, tgtCoord, movable.target);
  const direct = tCols.find(x => verticalClear(x, c, ey, obstacles));
  if (direct !== undefined) {
    // Down one column (a centre-aligned pair that a shifted port column clears): the corridor
    // point is collinear and drops out, so the flow takes no fan slot in the corridor.
    const straight = Math.abs(head[head.length - 1].x - direct) < 1e-6;
    return { corridors: straight ? [] : [c], points: [...head, { x: direct, corridor: c }, { x: direct, y: ey }] };
  }
  const t = participantGapY(ey, sy, poolCoords);
  if (Math.abs(t - c) > 1) {
    const tCol = tCols.find(x => verticalClear(x, t, ey, obstacles));
    const dx = tCol === undefined ? null : nearestClearColumn(tCol, c, t, obstacles);
    if (dx !== null) {
      return { corridors: [c, t], points: [...head,
        { x: dx, corridor: c }, { x: dx, corridor: t }, { x: tCol, corridor: t }, { x: tCol, y: ey }] };
    }
  }
  // The target's own participant blocks every column between the corridor next to the source and
  // the target (or the detour corridor and the target): jog inside the target's participant.
  const t2 = participantGapY(ey, sy, poolCoords);
  const jogFrom = Math.abs(t2 - c) > 1 ? t2 : c;
  const tailJog = tCols.map(x => jogLeg(x, ey, jogFrom, obstacles)).find(Boolean);
  if (tailJog) {
    const back = tailJog.slice().reverse();                      // from jogFrom down to the port
    const entry = { x: back[0].x, corridor: jogFrom };
    if (jogFrom === c) return { corridors: [c], points: [...head, entry, ...back.slice(1)] };
    const dx = nearestClearColumn(back[0].x, c, jogFrom, obstacles);
    if (dx !== null) {
      return { corridors: [c, jogFrom], points: [...head, { x: dx, corridor: c }, { x: dx, corridor: jogFrom }, entry, ...back.slice(1)] };
    }
  }
  return { corridors: [c], points: [...head, { x: ex, corridor: c }, { x: ex, y: ey }] };
}

/** Drops repeated points and the middle one of three collinear points. */
function withoutRedundantPoints(pts) {
  const same = (a, b) => Math.abs(a - b) < 1e-6;
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && same(last.x, p.x) && same(last.y, p.y)) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      if ((same(a.x, last.x) && same(last.x, p.x)) || (same(a.y, last.y) && same(last.y, p.y))) out.pop();
    }
    out.push(p);
  }
  return out;
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
 *
 * It also keeps a flow out of the shapes of the participants it passes — see planMessageFlow.
 */
function routeMessageFlows(coordMap, lc) {
  const { coords, poolCoords, edgeCoords, edgeLabels } = coordMap;

  // Fall back to poolCoords: a message flow may end on a black-box participant,
  // which has no entry in `coords`.
  const shapes = (mf) => [
    coords[mf.source] || poolCoords[mf.source],
    coords[mf.target] || poolCoords[mf.target],
  ];
  const typeOf = {};
  for (const proc of (lc.pools || [lc])) {
    for (const n of flattenProcessNodes(proc.nodes)) typeOf[n.id] = n.type;
  }
  const movable = (id) => !!coords[id] && !!typeOf[id] && !isEvent(typeOf[id]) && !isGateway(typeOf[id]);

  // First pass: every flow's plan and the corridors it uses — needed before routing, so that the
  // fan-out spacing can shrink to fit instead of saturating. A detoured flow uses two corridors.
  const plans = new Map();
  const perCorridor = {};
  for (const mf of (lc.messageFlows || [])) {
    const [s, t] = shapes(mf);
    if (!s || !t) continue;
    const key = messageFlowKey(mf);
    const plan = planMessageFlow(mf, s, t, poolCoords,
      messageFlowObstacles(mf, coords, s, t, typeOf),
      { source: movable(mf.source), target: movable(mf.target) });
    plans.set(key, plan);
    for (const c of plan.corridors) (perCorridor[Math.round(c)] ??= []).push(key);
  }
  const fanned = (y, key) => {
    const group = perCorridor[Math.round(y)];
    return group ? fanOut(y, group.indexOf(key), group.length) : y;
  };
  const resolve = (p, key) => ('corridor' in p ? { x: p.x, y: fanned(p.corridor, key) } : p);

  for (const mf of (lc.messageFlows || [])) {
    const key = messageFlowKey(mf);
    const plan = plans.get(key);
    if (!plan) continue;
    const pts = withoutRedundantPoints(plan.points.map(p => resolve(p, key)));
    edgeCoords[key] = pts;

    if (!mf.name) continue;
    // Label on the first leg that runs along a corridor. Deriving it from the shapes instead (and
    // without the poolCoords fallback) used to drop every black-box flow's label at the same
    // phantom position, far from the flow it belongs to.
    const k = plan.points.findIndex((p, i) => 'corridor' in p && plan.points[i + 1]
      && 'corridor' in plan.points[i + 1] && plan.points[i + 1].corridor === p.corridor);
    const [a, b] = k >= 0
      ? [resolve(plan.points[k], key), resolve(plan.points[k + 1], key)]
      : [pts[0], pts[pts.length - 1]];
    edgeLabels[key] = { text: mf.name, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  return coordMap;
}

export { buildCoordinateMap, enforceOrthogonal, findNodeInAllProcesses, clipOrthogonal, routeMessageFlows, computeSequenceFlowLabel, flattenProcessNodes, flattenProcessEdges };
