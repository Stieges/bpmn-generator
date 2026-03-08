# Inline Mode Template

## Overview

When Claude Code is not available (e.g., Claude.ai web interface), use this template
to generate a self-contained HTML artifact with ElkJS running in the browser.

The template embeds ElkJS from CDN, runs the full layout algorithm client-side,
and renders the SVG — NO manual coordinate estimation needed.

## Usage in Claude.ai

1. Extract the Logic-Core JSON from the user's text
2. Show the JSON to the user for confirmation
3. Create an **HTML artifact** using the template below
4. Replace `__LOGIC_CORE_JSON__` with the actual JSON

## Template

```html
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>BPMN Diagram</title>
<style>
  body { margin: 0; font-family: Arial, sans-serif; background: #f5f5f5; }
  #svg-container { padding: 20px; overflow: auto; }
  #status { padding: 10px 20px; color: #666; font-size: 13px; }
  svg { background: #fafafa; border: 1px solid #ddd; }
</style>
<script src="https://cdn.jsdelivr.net/npm/elkjs@0.9.3/lib/elk.bundled.min.js"></script>
</head>
<body>
<div id="status">Berechne Layout...</div>
<div id="svg-container"></div>
<script>
// ── Logic-Core JSON (injected by Claude) ──
const LC = __LOGIC_CORE_JSON__;

// ── Constants (bpmn-js/OMG) ──
const SHAPE={startEvent:{w:36,h:36},endEvent:{w:36,h:36},intermediateCatchEvent:{w:36,h:36},
  intermediateThrowEvent:{w:36,h:36},boundaryEvent:{w:36,h:36},
  task:{w:100,h:80},userTask:{w:100,h:80},serviceTask:{w:100,h:80},
  scriptTask:{w:100,h:80},sendTask:{w:100,h:80},receiveTask:{w:100,h:80},
  manualTask:{w:100,h:80},businessRuleTask:{w:100,h:80},
  callActivity:{w:100,h:80},subProcess:{w:100,h:80},
  exclusiveGateway:{w:50,h:50},parallelGateway:{w:50,h:50},
  inclusiveGateway:{w:50,h:50},eventBasedGateway:{w:50,h:50},
  dataObjectReference:{w:36,h:50},dataStoreReference:{w:50,h:50},
  textAnnotation:{w:100,h:30}};

const SW={startEvent:2,endEvent:4,intermediate:1.5,task:2,callActivity:5,
  gateway:2,pool:1.5,lane:1.5,connection:1.5};
const CLR={fill:'#fff',stroke:'#000',label:'#000'};
const LANE_HEADER=30,LANE_PAD=30,EXT_LABEL_H=25;

const isEvent=t=>t?.includes('Event')||false;
const isGateway=t=>t?.includes('Gateway')||false;
const isArtifact=t=>['dataObjectReference','dataStoreReference','textAnnotation','group'].includes(t);
const rn=n=>Math.round(n*10)/10;
const esc=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// ── ELK Graph Builder ──
function buildElk(lc){
  const nodes=lc.nodes||[],edges=lc.edges||[],lanes=lc.lanes||[];
  const mkNode=n=>{
    const sz=SHAPE[n.type]||SHAPE.task;
    const ext=isEvent(n.type)||isGateway(n.type);
    return{id:n.id,width:sz.w,height:sz.h+(ext?EXT_LABEL_H:0),_shapeH:sz.h};
  };
  const mkEdge=(e,i)=>({id:e.id||`e${i}`,sources:[e.source],targets:[e.target],
    properties:{'elk.priority':e.isHappyPath?'10':'1'}});
  const defaults={'elk.algorithm':'layered','elk.direction':'RIGHT',
    'elk.spacing.nodeNode':'40','elk.layered.spacing.nodeNodeBetweenLayers':'60',
    'elk.edgeRouting':'ORTHOGONAL','elk.layered.crossingMinimization.strategy':'LAYER_SWEEP'};

  if(lanes.length>0){
    const laneMap={};
    for(const l of lanes){laneMap[l.id]={...l,nodeIds:[]};}
    for(const n of nodes){if(n.lane&&laneMap[n.lane])laneMap[n.lane].nodeIds.push(n.id);}
    const poolChildren=lanes.map(l=>({
      id:l.id,labels:[{text:l.name||l.id}],
      properties:{...defaults,'elk.padding':`[top=${LANE_PAD},left=${LANE_PAD+LANE_HEADER},bottom=${LANE_PAD},right=${LANE_PAD}]`},
      children:laneMap[l.id].nodeIds.map(id=>nodes.find(n=>n.id===id)).filter(Boolean).filter(n=>!isArtifact(n.type)).map(mkNode),
      edges:edges.filter(e=>{const s=nodes.find(n=>n.id===e.source),t=nodes.find(n=>n.id===e.target);return s?.lane===l.id&&t?.lane===l.id;}).map(mkEdge)
    }));
    const crossEdges=edges.filter(e=>{const s=nodes.find(n=>n.id===e.source),t=nodes.find(n=>n.id===e.target);return s?.lane!==t?.lane;}).map((e,i)=>mkEdge(e,i+10000));
    return{id:'pool',properties:{'elk.algorithm':'rectpacking','elk.rectpacking.desiredAspectRatio':'0.1','elk.padding':'[top=0,left=0,bottom=0,right=0]','elk.spacing.nodeNode':'5'},children:poolChildren,edges:crossEdges};
  }
  return{id:'root',properties:defaults,children:nodes.filter(n=>!isArtifact(n.type)).map(mkNode),edges:edges.map(mkEdge)};
}

// ── Coordinate Collection ──
function collectCoords(elkResult,lc){
  const coords={},laneCoords={},edgeCoords={};
  const laneIds=new Set((lc.lanes||[]).map(l=>l.id));
  const collect=(node,ox=0,oy=0)=>{
    const ax=(node.x||0)+ox,ay=(node.y||0)+oy;
    if(node.id==='pool'||node.id==='root'){for(const c of node.children||[])collect(c,ax,ay);for(const e of node.edges||[])collectE(e,ax,ay);return;}
    if(laneIds.has(node.id)){laneCoords[node.id]={x:ax,y:ay,w:node.width,h:node.height};for(const c of node.children||[])collect(c,ax,ay);for(const e of node.edges||[])collectE(e,ax,ay);return;}
    const lcN=(lc.nodes||[]).find(n=>n.id===node.id);
    const sz=SHAPE[lcN?.type]||{w:node.width,h:node._shapeH||node.height};
    coords[node.id]={x:ax,y:ay,w:sz.w,h:sz.h};
    for(const c of node.children||[])collect(c,ax,ay);for(const e of node.edges||[])collectE(e,ax,ay);
  };
  const collectE=(edge,ox=0,oy=0)=>{
    const pts=[];
    for(const sec of edge.sections||[]){pts.push({x:sec.startPoint.x+ox,y:sec.startPoint.y+oy});for(const bp of sec.bendPoints||[])pts.push({x:bp.x+ox,y:bp.y+oy});pts.push({x:sec.endPoint.x+ox,y:sec.endPoint.y+oy});}
    edgeCoords[edge.id]=pts;
  };
  collect(elkResult);
  // Equalize lane widths
  const lcs=Object.values(laneCoords);
  if(lcs.length>1){const maxW=Math.max(...lcs.map(l=>l.w)),minX=Math.min(...lcs.map(l=>l.x));for(const l of lcs){l.x=minX;l.w=maxW;}}
  // Synthetic routing for unrouted edges
  for(const e of(lc.edges||[])){const eid=e.id;if(edgeCoords[eid]?.length>=2)continue;const sc=coords[e.source],tc=coords[e.target];if(!sc||!tc)continue;
    const scx=sc.x+sc.w/2,scy=sc.y+sc.h/2,tcx=tc.x+tc.w/2,tcy=tc.y+tc.h/2;
    if(Math.abs(tcy-scy)>Math.abs(tcx-scx)){const sy2=scy>tcy?sc.y:sc.y+sc.h,ty2=scy>tcy?tc.y+tc.h:tc.y,my=(sy2+ty2)/2;edgeCoords[eid]=[{x:scx,y:sy2},{x:scx,y:my},{x:tcx,y:my},{x:tcx,y:ty2}];}
    else{const sx2=sc.x+sc.w,tx2=tc.x,mx=(sx2+tx2)/2;edgeCoords[eid]=[{x:sx2,y:scy},{x:mx,y:scy},{x:mx,y:tcy},{x:tx2,y:tcy}];}
  }
  // Enforce orthogonal
  for(const eid of Object.keys(edgeCoords)){const pts=edgeCoords[eid];if(!pts||pts.length<2)continue;
    const result=[pts[0]];for(let i=1;i<pts.length;i++){const prev=result[result.length-1],cur=pts[i],dx=Math.abs(cur.x-prev.x),dy=Math.abs(cur.y-prev.y);
      if(dx<1){result.push({x:prev.x,y:cur.y});}else if(dy<1){result.push({x:cur.x,y:prev.y});}
      else if(dx>=dy){result.push({x:cur.x,y:prev.y});result.push(cur);}else{result.push({x:prev.x,y:cur.y});result.push(cur);}}
    edgeCoords[eid]=result;}
  return{coords,laneCoords,edgeCoords};
}

// ── SVG Renderer ──
function renderSvg(lc,coords,laneCoords,edgeCoords){
  const nodes=lc.nodes||[],edges=lc.edges||[],lanes=lc.lanes||[];
  const PAD=50;
  const allPts=[...Object.values(coords).flatMap(c=>[{x:c.x,y:c.y},{x:c.x+c.w,y:c.y+c.h+30}]),
    ...Object.values(laneCoords).flatMap(l=>[{x:l.x-LANE_HEADER,y:l.y},{x:l.x+l.w,y:l.y+l.h}]),
    ...Object.values(edgeCoords).flatMap(pts=>pts)];
  if(!allPts.length)return'<svg xmlns="http://www.w3.org/2000/svg"><text y="20">No elements</text></svg>';
  const minX=Math.min(...allPts.map(p=>p.x))-PAD,minY=Math.min(...allPts.map(p=>p.y))-PAD;
  const maxX=Math.max(...allPts.map(p=>p.x))+PAD,maxY=Math.max(...allPts.map(p=>p.y))+PAD;
  const W=maxX-minX,H=maxY-minY;
  const tx=v=>rn(v-minX),ty=v=>rn(v-minY);
  let svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${rn(W)}" height="${rn(H)}" viewBox="0 0 ${rn(W)} ${rn(H)}" font-family="Arial,sans-serif">`;
  svg+=`<defs><marker id="seq-end" viewBox="0 0 20 20" refX="11" refY="10" markerWidth="10" markerHeight="10" orient="auto"><path d="M 1 5 L 11 10 L 1 15 Z" fill="#000" stroke="#000" stroke-width="1"/></marker></defs>`;
  svg+=`<rect width="${rn(W)}" height="${rn(H)}" fill="#fafafa"/>`;
  // Pools/lanes
  if(lanes.length>0){
    const lcs=lanes.map(l=>laneCoords[l.id]).filter(Boolean);
    if(lcs.length){const px=Math.min(...lcs.map(l=>l.x))-LANE_HEADER,py=Math.min(...lcs.map(l=>l.y)),pw=Math.max(...lcs.map(l=>l.x+l.w))-px,ph=Math.max(...lcs.map(l=>l.y+l.h))-py;
      svg+=`<rect x="${tx(px)}" y="${ty(py)}" width="${pw}" height="${ph}" fill="#fff" stroke="#000" stroke-width="1.5"/>`;
      svg+=`<rect x="${tx(px)}" y="${ty(py)}" width="30" height="${ph}" fill="#e8e8e8" stroke="#000" stroke-width="1.5"/>`;
      const pcx=tx(px)+15,pcy=ty(py)+ph/2;
      svg+=`<text x="${pcx}" y="${pcy}" text-anchor="middle" dominant-baseline="middle" font-size="12" font-weight="bold" transform="rotate(-90,${pcx},${pcy})">${esc(lc.name||'')}</text>`;}
    for(const lane of lanes){const l=laneCoords[lane.id];if(!l)continue;
      svg+=`<rect x="${tx(l.x)}" y="${ty(l.y)}" width="${l.w}" height="${l.h}" fill="#fff" fill-opacity="0.25" stroke="#000" stroke-width="1.5"/>`;
      svg+=`<rect x="${tx(l.x-LANE_HEADER)}" y="${ty(l.y)}" width="30" height="${l.h}" fill="#f0f0f0" stroke="#000" stroke-width="1.5"/>`;
      const lcx=tx(l.x-LANE_HEADER)+15,lcy=ty(l.y)+l.h/2;
      svg+=`<text x="${lcx}" y="${lcy}" text-anchor="middle" dominant-baseline="middle" font-size="11" transform="rotate(-90,${lcx},${lcy})">${esc(lane.name||lane.id)}</text>`;}}
  // Edges
  for(const edge of edges){const eid=edge.id||`f_${edge.source}_${edge.target}`;const pts=edgeCoords[eid]||[];
    if(pts.length>=2){const d=`M ${tx(pts[0].x)} ${ty(pts[0].y)} `+pts.slice(1).map(p=>`L ${tx(p.x)} ${ty(p.y)}`).join(' ');
      svg+=`<path d="${d}" stroke="#000" stroke-width="1.5" fill="none" marker-end="url(#seq-end)"/>`;
      if(edge.label){const mi=Math.min(1,pts.length-1);const lx=tx(pts[mi].x),ly=ty(pts[mi].y);
        const w=edge.label.length*6.5+8;svg+=`<rect x="${rn(lx-w/2)}" y="${rn(ly-8)}" width="${rn(w)}" height="16" rx="2" fill="white" fill-opacity="0.9"/>`;
        svg+=`<text x="${rn(lx)}" y="${rn(ly+4)}" text-anchor="middle" font-size="10">${esc(edge.label)}</text>`;}}}
  // Nodes
  for(const node of nodes){const c=coords[node.id];if(!c)continue;const x=tx(c.x),y=ty(c.y),w=c.w,h=c.h,cx=x+w/2,cy=y+h/2;
    if(isEvent(node.type)){const r=w/2;const sw2=node.type==='endEvent'?4:node.type==='startEvent'?2:1.5;
      svg+=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" stroke="#000" stroke-width="${sw2}"/>`;
      if(node.type.includes('intermediate')||node.type==='boundaryEvent')svg+=`<circle cx="${cx}" cy="${cy}" r="${r-3}" fill="none" stroke="#000" stroke-width="1.5"/>`;
      if(node.name){const ly=ty(c.y+c.h)+10;const lines=wrapText(node.name,15);
        svg+=lines.map((l,i)=>`<text x="${cx}" y="${rn(ly+i*13+10)}" text-anchor="middle" font-size="11">${esc(l)}</text>`).join('');}}
    else if(isGateway(node.type)){svg+=`<polygon points="${cx},${y} ${x+w},${cy} ${cx},${y+h} ${x},${cy}" fill="#fff" stroke="#000" stroke-width="2"/>`;
      const d=9;if(node.type==='exclusiveGateway'){svg+=`<line x1="${cx-d}" y1="${cy-d}" x2="${cx+d}" y2="${cy+d}" stroke="#000" stroke-width="3" stroke-linecap="round"/>`;svg+=`<line x1="${cx+d}" y1="${cy-d}" x2="${cx-d}" y2="${cy+d}" stroke="#000" stroke-width="3" stroke-linecap="round"/>`;}
      else if(node.type==='parallelGateway'){svg+=`<line x1="${cx}" y1="${cy-d}" x2="${cx}" y2="${cy+d}" stroke="#000" stroke-width="3.5" stroke-linecap="round"/>`;svg+=`<line x1="${cx-d}" y1="${cy}" x2="${cx+d}" y2="${cy}" stroke="#000" stroke-width="3.5" stroke-linecap="round"/>`;}
      else if(node.type==='inclusiveGateway'){svg+=`<circle cx="${cx}" cy="${cy}" r="${rn(h*0.24)}" fill="none" stroke="#000" stroke-width="2.5"/>`;}
      if(node.name){const ly=ty(c.y+c.h)+10;const lines=wrapText(node.name,15);
        svg+=lines.map((l,i)=>`<text x="${cx}" y="${rn(ly+i*13+10)}" text-anchor="middle" font-size="11">${esc(l)}</text>`).join('');}}
    else if(!isArtifact(node.type)){const sw2=node.type==='callActivity'?5:2;
      svg+=`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" ry="10" fill="#fff" stroke="#000" stroke-width="${sw2}"/>`;
      const lines=wrapText(node.name||'',Math.floor(w/6.5)),lh=14,sy=cy-((lines.length-1)*lh)/2;
      svg+=lines.map((l,i)=>`<text x="${cx}" y="${rn(sy+i*lh)}" text-anchor="middle" dominant-baseline="middle" font-size="12">${esc(l)}</text>`).join('');}}
  svg+=`</svg>`;return svg;
}
function wrapText(text,maxChars){if(!text)return[''];if(text.length<=maxChars)return[text];const words=text.split(' '),lines=[];let cur='';
  for(const w of words){const c=cur?`${cur} ${w}`:w;if(c.length>maxChars){if(cur)lines.push(cur);cur=w;}else cur=c;}if(cur)lines.push(cur);return lines.length?lines:[text];}

// ── Main ──
(async()=>{
  try{
    const elkGraph=buildElk(LC);
    const elk=new ELK();
    const result=await elk.layout(elkGraph);
    const{coords,laneCoords,edgeCoords}=collectCoords(result,LC);
    const svg=renderSvg(LC,coords,laneCoords,edgeCoords);
    document.getElementById('svg-container').innerHTML=svg;
    document.getElementById('status').textContent=
      `✓ Layout berechnet: ${(LC.nodes||[]).length} Elemente, ${(LC.edges||[]).length} Verbindungen`;
  }catch(err){
    document.getElementById('status').textContent='✗ Fehler: '+err.message;
    console.error(err);
  }
})();
</script>
</body>
</html>
```

## Notes for Claude

- Replace `__LOGIC_CORE_JSON__` with the actual Logic-Core JSON
- The template works in Claude.ai HTML artifacts because it loads ElkJS from CDN
- The renderer is simplified compared to pipeline.js (no task type icons, no event markers)
  but produces correct orthogonal layouts with proper BPMN shapes
- For full rendering fidelity, recommend Claude Code with the pipeline script
