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
  if(endpoint.detached||endpoint.attach==='none'||!neighbor)return origin;
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
  const end=connection(stroke,'end',{x:last.x,y:last.y},after,axis,size);
  const length=Math.hypot(end.x-start.x,end.y-start.y);
  const fallback=stroke.runLength*size*.65;
  if(length<size*.1){end.x=start.x+axis.x*fallback;end.y=start.y+axis.y*fallback;}
  const vx=end.x-start.x,vy=end.y-start.y,dist=Math.hypot(vx,vy),nx=-vy/dist,ny=vx/dist;
  const n=Math.max(16,Math.min(128,Math.round(samples))),result=[];
  for(let i=0;i<=n;i++){
    const t=i/n,p=bezierPoint(stroke.path.points,t);
    // x: interpolation along line, y: perpendicular deviation measured in line lengths
    const x=start.x+vx*p.x+nx*dist*p.y,y=start.y+vy*p.x+ny*dist*p.y;
    let w=sampleWidth(stroke.widths,t);
    w*=capWeight(t,stroke.start.cap,'start')*capWeight(t,stroke.end.cap,'end');
    result.push({x:finite(x),y:finite(y),w:finite(w)});
  }
  return result;
}
export function strokePolygon(samples){
  if(samples.length<2)return [];
  const left=[],right=[];
  for(let i=0;i<samples.length;i++){
    const before=samples[Math.max(0,i-1)],after=samples[Math.min(samples.length-1,i+1)],dx=after.x-before.x,dy=after.y-before.y,len=Math.hypot(dx,dy)||1;
    const x=-dy/len*samples[i].w/2,y=dx/len*samples[i].w/2;
    left.push({x:samples[i].x+x,y:samples[i].y+y});
    right.push({x:samples[i].x-x,y:samples[i].y-y});
  }
  return [...left,...right.reverse()];
}
export function strokeBounds(polygon){
  if(!polygon.length)return null;
  return {minX:Math.min(...polygon.map(p=>p.x)),minY:Math.min(...polygon.map(p=>p.y)),maxX:Math.max(...polygon.map(p=>p.x)),maxY:Math.max(...polygon.map(p=>p.y))};
}
