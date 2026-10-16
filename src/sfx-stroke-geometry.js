// SFX continuous ー geometry. Coordinates are relative to the owning layer.
// No image-size changes: callers render through the original page canvas.
const capWeight=(t,cap,edge)=>{
  if(!['taper','brush'].includes(cap))return 1;
  const amount=Math.min(1,(edge==='start'?t:1-t)*20);
  return cap==='brush'?Math.sqrt(amount):amount;
};
const finite=(x,otherwise=0)=>Number.isFinite(x)?x:otherwise;
function sampleWidth(knots,t){
  let right=knots.findIndex(x=>x.t>=t);if(right<=0)return knots[0].w;
  const a=knots[right-1],b=knots[right],u=(t-a.t)/(b.t-a.t);
  if(a.interpolation==='step')return a.w;
  const v=a.interpolation==='smooth'?u*u*(3-2*u):u;
  return a.w+(b.w-a.w)*v;
}
export function strokeWidthScale(stroke,size=40){
  const reference=Number.isFinite(stroke?.sizeReference)&&stroke.sizeReference>0?stroke.sizeReference:size;
  const multiplier=Number.isFinite(stroke?.widthMultiplier)&&stroke.widthMultiplier>0?stroke.widthMultiplier:1;
  return size/reference*multiplier;
}
export function bezierPoint(points,t){
  if(points.length===4){
    const s=1-t;return {x:s*s*s*points[0].x+3*s*s*t*points[1].x+3*s*t*t*points[2].x+t*t*t*points[3].x,
      y:s*s*s*points[0].y+3*s*s*t*points[1].y+3*s*t*t*points[2].y+t*t*t*points[3].y};
  }
  if(points.length%3===1){const count=(points.length-1)/3,i=Math.min(count-1,Math.floor(t*count));return bezierPoint(points.slice(3*i,3*i+4),Math.min(1,t*count-i));}
  const fraction=t*(points.length-1),i=Math.min(points.length-2,Math.floor(fraction)),v=fraction-i;
  return {x:points[i].x+(points[i+1].x-points[i].x)*v,y:points[i].y+(points[i+1].y-points[i].y)*v};
}
function connection(stroke,side,origin,neighbor,axis,size){
  const endpoint=stroke[side],sign=side==='start'?1:-1;
  if(endpoint.detached)return endpoint.fixedPosition??origin;
  if(endpoint.attach==='none'||!neighbor)return origin;
  const edge=neighbor.edges?.[side==='start'?'forward':'backward'];
  if(edge){const gap=(endpoint.relation==='inside'?-.15*size:endpoint.relation==='gap'?.15*size:0)+endpoint.offset;return {x:edge.x+axis.x*sign*gap,y:edge.y+axis.y*sign*gap};}
  const extent=(neighbor.size??size)*.38;
  const overlap=endpoint.relation==='inside'?-.15*size:endpoint.relation==='gap'?.15*size:0;
  return {x:neighbor.x+axis.x*(extent*sign+overlap*sign+endpoint.offset),
    y:neighbor.y+axis.y*(extent*sign+overlap*sign+endpoint.offset)};
}
export function strokeGeometry(stroke,positions,{vertical=false,size=40,samples=40}={}){
  const axis=vertical?{x:0,y:1}:{x:1,y:0};
  const first=positions.get(stroke.runStart),last=positions.get(stroke.runStart+stroke.runLength-1);
  if(!first||!last)return [];
  const before=positions.get(stroke.runStart-1),after=positions.get(stroke.runStart+stroke.runLength);
  const start=connection(stroke,'start',{x:first.x,y:first.y},before,axis,size);
  let end=connection(stroke,'end',{x:last.x,y:last.y},after,axis,size);
  if(stroke.manualLengthLocked&&stroke.lockedLength&&(!after||stroke.end.detached||stroke.end.attach==='none')&&!stroke.end.fixedPosition){end={x:start.x+axis.x*stroke.lockedLength,y:start.y+axis.y*stroke.lockedLength};}
  const length=Math.hypot(end.x-start.x,end.y-start.y);
  const fallback=stroke.runLength*size*.65;
  if(length<size*.1){end.x=start.x+axis.x*fallback;end.y=start.y+axis.y*fallback;}
  const vx=end.x-start.x,vy=end.y-start.y,dist=Math.hypot(vx,vy),nx=-vy/dist,ny=vx/dist;
  const widthScale=strokeWidthScale(stroke,size),n=Math.max(16,Math.min(128,Math.round(samples))),result=[];
  for(let i=0;i<=n;i++){
    const t=i/n,p=bezierPoint(stroke.path.points,t);
    // x: interpolation along line, y: perpendicular deviation measured in line lengths
    let x=start.x+vx*p.x+nx*dist*p.y,y=start.y+vy*p.x+ny*dist*p.y;
    for(const side of ['start','end']){const cap=stroke[side],u=Math.min(1,(side==='start'?t:1-t)*dist/Math.max(1,cap.length||dist*.05));const shift=u*(1-u)*Math.sin((cap.angle||0)*Math.PI/180)*(cap.length||size*.15);x+=nx*shift;y+=ny*shift;}
    const knots=stroke.widths.map(p=>({...p,w:p.w*widthScale,...(p.fixed&&Number.isFinite(p.distance)?{t:Math.min(1,p.distance/dist)}:{})})).sort((a,b)=>a.t-b.t);
    let w=sampleWidth(knots,t);
    for(const side of ['start','end']){const cap=stroke[side],u=Math.min(1,(side==='start'?t:1-t)*dist/Math.max(1,cap.length||dist*.05));if(['taper','brush'].includes(cap.cap)){w*=Math.pow(u,cap.cap==='brush'?.5+(cap.sharpness??50)/200:1+(cap.sharpness??50)/50);} }
    w*=1;
    result.push({x:finite(x),y:finite(y),w:finite(w)});
  }
  return result;
}
export function strokePolygon(samples,stroke=null){
  if(samples.length<2)return [];
  const left=[],right=[];
  for(let i=0;i<samples.length;i++){
    const before=samples[Math.max(0,i-1)],after=samples[Math.min(samples.length-1,i+1)],dx=after.x-before.x,dy=after.y-before.y,len=Math.hypot(dx,dy)||1;
    const x=-dy/len*samples[i].w/2,y=dx/len*samples[i].w/2;
    left.push({x:samples[i].x+x,y:samples[i].y+y});
    right.push({x:samples[i].x-x,y:samples[i].y-y});
  }
  const capArc=(point,before,side,cap)=>{if(cap!=='round')return [];const angle=Math.atan2(point.y-before.y,point.x-before.x),start=angle-Math.PI/2;return Array.from({length:12},(_,i)=>({x:point.x+Math.cos(start+Math.PI*(i+1)/13)*point.w/2,y:point.y+Math.sin(start+Math.PI*(i+1)/13)*point.w/2}));};
  return [...left,...capArc(samples.at(-1),samples.at(-2),'end',stroke?.end.cap),...right.reverse(),...capArc(samples[0],samples[1],'start',stroke?.start.cap)];
}
export function strokeBounds(polygon){
  if(!polygon.length)return null;
  return {minX:Math.min(...polygon.map(p=>p.x)),minY:Math.min(...polygon.map(p=>p.y)),maxX:Math.max(...polygon.map(p=>p.x)),maxY:Math.max(...polygon.map(p=>p.y))};
}

export function strokeFrame(stroke,positions,{vertical=false,size=40}={}){
  const sampled=strokeGeometry({...stroke,path:{type:'bezier',points:[{x:0,y:0},{x:1/3,y:0},{x:2/3,y:0},{x:1,y:0}]}},positions,{vertical,size,samples:16});
  if(!sampled.length)return null;
  const start=sampled[0],end=sampled.at(-1),vx=end.x-start.x,vy=end.y-start.y,length=Math.hypot(vx,vy)||1;
  return {start,end,vx,vy,length,nx:-vy/length,ny:vx/length};
}
export function pathToLocal(frame,p){return {x:frame.start.x+frame.vx*p.x+frame.nx*frame.length*p.y,y:frame.start.y+frame.vy*p.x+frame.ny*frame.length*p.y};}
export function localToPath(frame,p){const dx=p.x-frame.start.x,dy=p.y-frame.start.y;return {x:(dx*frame.vx+dy*frame.vy)/(frame.length**2),y:(dx*frame.nx+dy*frame.ny)/frame.length};}
const mix=(a,b,t)=>({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
export function splitCubic(p,t){
  const a=mix(p[0],p[1],t),b=mix(p[1],p[2],t),c=mix(p[2],p[3],t),d=mix(a,b,t),e=mix(b,c,t),f=mix(d,e,t);
  return [[p[0],a,d,f],[f,e,c,p[3]]];
}
export function addCurvePoint(stroke,t=.5){
  if(stroke.path.points.length+3>64)throw new Error('制御点は64点まで');
  const points=stroke.path.points,n=(points.length-1)/3,index=Math.min(n-1,Math.floor(t*n)),u=Math.max(.01,Math.min(.99,t*n-index));
  const [left,right]=splitCubic(points.slice(index*3,index*3+4),u),next=structuredClone(stroke);
  next.path.points.splice(index*3,4,...left,...right.slice(1));next.shape='custom';return next;
}
export function removeCurvePoint(stroke,index){
  const next=structuredClone(stroke),p=next.path.points;
  const anchor=Math.round(index/3)*3;
  if(p.length<=4||anchor<=0||anchor>=p.length-1)return next;
  // Retain each neighbouring outer handle; remove only this knot and its two handles.
  p.splice(anchor-1,3);next.shape='custom';return next;
}
export function moveCurvePoint(stroke,index,point,{mode='independent'}={}){
  const next=structuredClone(stroke),p=next.path.points,old=p[index];if(!old)return next;
  const dx=point.x-old.x,dy=point.y-old.y;p[index]={...point};
  if(index%3===0){if(index>0)p[index-1]=mix(p[index-1],{x:p[index-1].x+dx,y:p[index-1].y+dy},1);if(index+1<p.length)p[index+1]={x:p[index+1].x+dx,y:p[index+1].y+dy};}
  else if(mode==='smooth'){
    const knot=index%3===1?index-1:index+1,opposite=index%3===1?knot-1:knot+1;
    if(p[opposite]){const length=Math.hypot(p[opposite].x-p[knot].x,p[opposite].y-p[knot].y),len=Math.hypot(point.x-p[knot].x,point.y-p[knot].y)||1;p[opposite]={x:p[knot].x-(point.x-p[knot].x)*length/len,y:p[knot].y-(point.y-p[knot].y)*length/len};}
  }
  next.shape='custom';return next;
}
export function addWidthPoint(stroke,t=.5){
  if(stroke.widths.length>=64)throw new Error('線幅点は64点まで');
  const next=structuredClone(stroke);t=Math.max(.001,Math.min(.999,t));
  if(next.widths.some(p=>Math.abs(p.t-t)<.0001))return next;
  next.widths.push({t,w:sampleWidth(stroke.widths,t),interpolation:'smooth',fixed:false});next.widths.sort((a,b)=>a.t-b.t);return next;
}
export function removeWidthPoint(stroke,index){const next=structuredClone(stroke);if(index>0&&index<next.widths.length-1)next.widths.splice(index,1);return next;}
export function sliceStroke(stroke,a=0,b=1){
  const points=stroke.path.points,n=(points.length-1)/3,segments=[];
  for(let i=0;i<n;i++){
    const lo=Math.max(0,a*n-i),hi=Math.min(1,b*n-i);if(lo>=hi)continue;
    let curve=points.slice(i*3,i*3+4);if(hi<1)curve=splitCubic(curve,hi)[0];if(lo>0)curve=splitCubic(curve,lo/hi)[1];segments.push(curve);
  }
  const span=Math.max(.0001,b-a),next=structuredClone(stroke);
  next.path.points=segments.flatMap((p,i)=>(i?p.slice(1):p)).map(p=>({x:(p.x-a)/span,y:p.y/span}));
  next.widths=[{t:0,w:sampleWidth(stroke.widths,a),interpolation:stroke.widths[0].interpolation},...stroke.widths.filter(p=>p.t>a&&p.t<b).map(p=>({...p,t:(p.t-a)/span})),{t:1,w:sampleWidth(stroke.widths,b),interpolation:stroke.widths.at(-1).interpolation}];
  if(a>0)next.start={...next.start,attach:'previous',detached:false,cap:'flat'};
  if(b<1)next.end={...next.end,attach:'next',detached:false,cap:'flat'};
  return next;
}
export function joinStrokes(first,second,fraction=.5){
  const f=Math.max(.001,Math.min(.999,fraction)),next=structuredClone(first);
  const left=first.path.points.map(p=>({x:p.x*f,y:p.y*f})),right=second.path.points.map(p=>({x:f+p.x*(1-f),y:p.y*(1-f)}));
  const join=mix(left.at(-1),right[0],.5);left[left.length-1]=join;right[0]=join;
  const handle=left.at(-2),after=right[1],dx=after.x-handle.x,dy=after.y-handle.y,len=Math.hypot(dx,dy)||1;
  const a=Math.hypot(join.x-handle.x,join.y-handle.y),b=Math.hypot(after.x-join.x,after.y-join.y);
  left[left.length-2]={x:join.x-dx/len*a,y:join.y-dy/len*a};right[1]={x:join.x+dx/len*b,y:join.y+dy/len*b};
  next.path.points=[...left,...right.slice(1)];
  next.widths=[...first.widths.slice(0,-1).map(p=>({...p,t:p.t*f})),{t:f,w:(first.widths.at(-1).w+second.widths[0].w)/2,interpolation:'smooth'},...second.widths.slice(1).map(p=>({...p,t:f+p.t*(1-f)}))];
  if(next.path.points.length>64||next.widths.length>64)throw new Error('結合後の制御点が上限を超える');
  next.end=structuredClone(second.end);next.shape='custom';return next;
}
