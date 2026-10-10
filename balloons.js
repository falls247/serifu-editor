import { brushDefaults, paintBrushStroke } from './brush-stroke.js';
const limit=(value,min,max)=>Math.max(min,Math.min(max,value));
const FULL_TURN=Math.PI*2;
const spikeCache=new Map();

function seededRandom(seed) {
  let state=seed>>>0;
  return ()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
}

function grain(seed,index,strand=0) {
  let value=seed^Math.imul(index+1,374761393)^Math.imul(strand+1,668265263);
  value=Math.imul(value^(value>>>13),1274126177);
  return ((value^(value>>>16))>>>0)/4294967296;
}

function spikeShape(layer) {
  const seed=layer.shapeSeed>>>0,amount=(layer.distortion??50)/100,count=layer.spikeCount??defaultSpikeCount(seed),key=seed+':'+amount+':'+count;
  if(spikeCache.has(key))return spikeCache.get(key);
  const random=seededRandom(seed),phase=random()*FULL_TURN;random();
  const gaps=Array.from({length:count},()=>.55+random()*.95),sum=gaps.reduce((a,b)=>a+b,0);
  let angle=0;
  const tips=gaps.map(gap=>{
    const radius=1+amount*(.12+random()*.18);
    const tip={angle,x:radius*Math.cos(angle),y:radius*Math.sin(angle)};
    angle+=gap/sum*FULL_TURN;return tip;
  });
  tips.push({...tips[0],angle:FULL_TURN});
  const segments=tips.slice(0,-1).map((a,index)=>{
    const b=tips[index+1],mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
    // Put each control point toward the centre: every span bends inward
    // from its tip-to-tip chord, including when distortion is low.
    const depth=Math.min((.05+amount*.17)*(.65+random()*.65),Math.hypot(mx,my)*.3),inset=1-2*depth/Math.hypot(mx,my);
    return {a,b,c:{x:mx*inset,y:my*inset}};
  });
  const shape={phase,tips,segments};spikeCache.set(key,shape);
  if(spikeCache.size>64)spikeCache.delete(spikeCache.keys().next().value);
  return shape;
}

function spikeRadius(layer,angle) {
  const {phase,segments}=spikeShape(layer),relative=((angle-phase)%FULL_TURN+FULL_TURN)%FULL_TURN;
  let low=0,high=segments.length-1;
  while(low<high){const middle=(low+high)>>>1;if(relative<segments[middle].b.angle)high=middle;else low=middle+1;}
  const {a,b,c}=segments[low],cosine=Math.cos(relative),sine=Math.sin(relative);
  const cross=p=>p.x*sine-p.y*cosine;
  const ca=cross(a),cb=cross(b),cc=cross(c),linear=2*(cc-ca),quadratic=ca-2*cc+cb;
  // Intersect the same quadratic curve with the requested radial ray.
  // This root is stable even when the quadratic coefficient approaches zero.
  const t=limit(2*ca/(-linear+Math.sqrt(Math.max(0,linear*linear-4*quadratic*ca))),0,1),u=1-t;
  return (u*u*a.x+2*u*t*c.x+t*t*b.x)*cosine+(u*u*a.y+2*u*t*c.y+t*t*b.y)*sine;
}

export const BALLOON_LIMITS=Object.freeze({transparency:[0,100],borderWidth:[0,80],distortion:[0,100],spikeCount:[6,60],tailX:[-30000,30000],tailY:[-30000,30000],tailAngle:[-180,180],tailWidth:[1,1000],shadowBlur:[0,100],shadowOffsetX:[-100,100],shadowOffsetY:[-100,100],shadowOpacity:[0,100],brushRoughness:[0,100]});
export const BALLOON_SHAPES=Object.freeze({ellipse:'楕円', 'distorted-rect':'歪み長方形',spiky:'尖り形'});

export function balloonSeedFromId(id) {
  let hash=2166136261;
  for(const char of String(id??'')){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619);}
  return hash>>>0;
}

export function defaultSpikeCount(seed) {
  const random=seededRandom(seed);random();return 10+Math.floor(random()*5);
}

export function newBalloon(width,height,speaker='male') {
  const w=limit(width*.64,30,30000),h=limit(height*.56,30,30000);
  const id=crypto.randomUUID();
  return {
    id,kind:'balloon',presetId:null,x:width*.88,y:height*.16,w,h,rotation:0,
    text:'',speaker,textColor:null,textOutlineColor:'#ffffff',size:limit(width*.055,8,500),outline:limit(width*.006,1,80),thickness:0,vertical:true,lineAlign:'top',font:'sans',
    color:'#ffffff',transparency:25,borderColor:'#111111',borderWidth:limit(width*.003,.5,80),
    ...brushDefaults(id),shadowEnabled:false,shadowColor:'#222222',shadowBlur:12,shadowOffsetX:6,shadowOffsetY:6,shadowOpacity:45,borderStyle:'solid',brushRoughness:50,
    shape:'distorted-rect',shapeSeed:balloonSeedFromId(id),spikeCount:12,distortion:50,tail:false,tailX:0,tailY:h*.85,tailAngle:90,tailWidth:limit(width*.08,1,1000),sfxOrder:'behind',
  };
}

function boundaryScale(layer,angle) {
  const phase=grain(layer.shapeSeed>>>0,0,71)*FULL_TURN;
  const amount=(layer.distortion??50)/100;
  if(layer.shape==='spiky'){
    return spikeRadius(layer,angle);
  }
  if(layer.shape!=='distorted-rect')return 1;
  const cosine=Math.cos(angle),sine=Math.sin(angle),power=5;
  const roundedRect=(Math.abs(cosine)**power+Math.abs(sine)**power)**(-1/power);
  const wobble=1+amount*(.07*Math.sin(3*angle+phase)+.04*Math.sin(7*angle-phase*1.3)+.02*Math.sin(11*angle+phase*.7));
  return roundedRect*wobble;
}

export function balloonBoundaryPoint(layer,angle) {
  const radius=boundaryScale(layer,angle);
  return {x:layer.w/2*radius*Math.cos(angle),y:layer.h/2*radius*Math.sin(angle)};
}

function containsBase(layer,point) {
  const nx=point.x/(layer.w/2),ny=point.y/(layer.h/2),radius=Math.hypot(nx,ny);
  return radius===0||radius<=boundaryScale(layer,Math.atan2(ny,nx));
}

function boundaryRate(layer,angle) {
  const step=.001,before=balloonBoundaryPoint(layer,angle-step),after=balloonBoundaryPoint(layer,angle+step);
  return Math.hypot(after.x-before.x,after.y-before.y)/(step*2);
}

export function balloonGeometry(layer) {
  const rx=layer.w/2,ry=layer.h/2,angle=layer.tailAngle*Math.PI/180;
  const half=limit(layer.tailWidth/(2*Math.max(.001,boundaryRate(layer,angle))),.01,Math.PI*.4);
  const start=angle+half,end=angle-half+FULL_TURN;
  return {rx,ry,start,end,a:balloonBoundaryPoint(layer,start),b:balloonBoundaryPoint(layer,end),
    tip:{x:layer.tailX,y:layer.tailY},hasTail:layer.tail&&!containsBase(layer,{x:layer.tailX,y:layer.tailY})};
}

export function balloonHit(layer,point) {
  const g=balloonGeometry(layer);
  if(containsBase(layer,point))return true;
  if(!g.hasTail)return false;
  const cross=(a,b)=>(point.x-b.x)*(a.y-b.y)-(a.x-b.x)*(point.y-b.y);
  const sides=[cross(g.a,g.b),cross(g.b,g.tip),cross(g.tip,g.a)];
  return sides.every(value=>value>=0)||sides.every(value=>value<=0);
}

export function balloonOutline(layer) {
  const g=balloonGeometry(layer);
  const from=g.hasTail?g.start:0,to=g.hasTail?g.end:FULL_TURN,steps=Math.max(2,Math.ceil((to-from)/(FULL_TURN/360)));
  const angles=Array.from({length:steps+1},(_,index)=>from+(to-from)*index/steps);
  if(layer.shape==='spiky'){
    const {phase,tips}=spikeShape(layer);
    for(const tip of tips.slice(0,-1)){
      const wrapped=(tip.angle+phase)%FULL_TURN,angle=wrapped+Math.ceil((from-wrapped)/FULL_TURN)*FULL_TURN;
      if(angle>from&&angle<to)angles.push(angle);
    }
    angles.sort((a,b)=>a-b);
  }
  const points=angles.map(angle=>balloonBoundaryPoint(layer,angle));
  if(g.hasTail)points.push(g.tip,g.a);
  // Use the exact first point to avoid a seam from trigonometric rounding.
  points[points.length-1]=points[0];
  return points;
}

function balloonPath(ctx,layer) {
  const g=balloonGeometry(layer);
  ctx.beginPath();
  if(layer.shape==='distorted-rect'||layer.shape==='spiky'){
    const points=balloonOutline(layer);ctx.moveTo(points[0].x,points[0].y);
    for(const point of points.slice(1))ctx.lineTo(point.x,point.y);
  }else if(g.hasTail){ctx.ellipse(0,0,g.rx,g.ry,0,g.start,g.end);ctx.lineTo(g.tip.x,g.tip.y);ctx.lineTo(g.a.x,g.a.y);}
  else ctx.ellipse(0,0,g.rx,g.ry,0,0,FULL_TURN);
  ctx.closePath();
}

function brushSamples(layer) {
  const points=balloonOutline(layer),lengths=[0];
  for(let i=1;i<points.length;i++)lengths.push(lengths[i-1]+Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y));
  const total=lengths[lengths.length-1],amount=(layer.brushRoughness??50)/100;
  const count=limit(Math.ceil(total/Math.max(.8,layer.borderWidth*(.45+amount*.5))),12,8192),samples=[];
  let segment=1;
  for(let i=0;i<count;i++){
    const distance=total*i/count;
    while(segment<points.length-1&&lengths[segment]<distance)segment++;
    const a=points[segment-1],b=points[segment],length=lengths[segment]-lengths[segment-1];
    const t=length?(distance-lengths[segment-1])/length:0;
    samples.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});
  }
  return samples.map((point,index)=>{
    const before=samples[(index+count-1)%count],after=samples[(index+1)%count],dx=after.x-before.x,dy=after.y-before.y,length=Math.hypot(dx,dy)||1;
    return {...point,nx:dy/length,ny:-dx/length};
  });
}

function paintBrushBorder(ctx,layer) {
  const amount=(layer.brushRoughness??50)/100;
  if(!amount){ctx.lineWidth=layer.borderWidth;ctx.stroke();return;}
  const samples=brushSamples(layer),seed=layer.shapeSeed>>>0,width=layer.borderWidth,strands=7;
  const patches=Array.from({length:4},()=>[]);
  // Independent ink fibres leave genuine gaps, rather than painting light
  // speckles over the fill or erasing pixels belonging to other layers.
  const edges=(point,index,strand)=>{
    const pressure=1+amount*(grain(seed,Math.floor(index/5),17)-.5)*.65;
    const offset=((strand/(strands-1)-.5)*.95+amount*(grain(seed,index,strand)-.5)*.22)*width*pressure;
    const half=width/(strands-1)*(.62+amount*(grain(seed,index,strand+31)-.5)*.55)*pressure;
    return [point.x+point.nx*(offset-half),point.y+point.ny*(offset-half),point.x+point.nx*(offset+half),point.y+point.ny*(offset+half)];
  };
  for(let strand=0;strand<strands;strand++){
    const edge=Math.abs(strand/(strands-1)-.5)*2;
    for(let index=0;index<samples.length;index++){
      if(grain(seed^0x9e3779b9,index,strand)<amount*(.12+edge*.2))continue;
      const next=(index+1)%samples.length,a=edges(samples[index],index,strand),b=edges(samples[next],next,strand);
      const bucket=limit(Math.floor(3-amount*(edge*.8+grain(seed^0x85ebca6b,index,strand)*2.2)),0,3);
      patches[bucket].push([...a,...b]);
    }
  }
  ctx.save();ctx.fillStyle=layer.borderColor;
  for(let bucket=0;bucket<patches.length;bucket++){
    ctx.save();ctx.globalAlpha*=[.45,.65,.85,1][bucket];ctx.beginPath();
    for(const [ax,ay,bx,by,cx,cy,dx,dy] of patches[bucket]){
      ctx.moveTo(ax,ay);ctx.lineTo(bx,by);ctx.lineTo(dx,dy);ctx.lineTo(cx,cy);ctx.closePath();
    }
    ctx.fill();ctx.restore();
  }
  ctx.restore();
}

export function clipBalloon(ctx,layer) {
  balloonPath(ctx,layer);
  ctx.clip();
}

export function paintBalloon(ctx,layer) {
  balloonPath(ctx,layer);
  ctx.save();
  ctx.globalAlpha*=1-layer.transparency/100;
  if(layer.shadowEnabled){
    const rgb=[1,3,5].map(i=>parseInt(layer.shadowColor.slice(i,i+2),16));
    ctx.shadowColor='rgba('+rgb.join(',')+','+layer.shadowOpacity/100+')';
    ctx.shadowBlur=layer.shadowBlur;ctx.shadowOffsetX=layer.shadowOffsetX;ctx.shadowOffsetY=layer.shadowOffsetY;
  }
  ctx.fillStyle=layer.color;ctx.fill();ctx.restore();
  if(layer.borderWidth>0){
    ctx.strokeStyle=layer.borderColor;ctx.lineJoin='round';
    if(layer.borderStyle==='brush'||layer.borderStyle==='dry-brush'){
      if((layer.brushEngine??'legacy')==='legacy'&&layer.borderStyle==='brush')paintBrushBorder(ctx,layer);
      else paintBrushStroke(ctx,balloonOutline(layer),layer);
    }else{ctx.lineWidth=layer.borderWidth;ctx.stroke();}
  }
}

// Every balloon stays below dialogue and captions. Front balloons also require SFX below them.
export function paintOrder(layers) {
  const behind=layers.filter(layer=>layer.kind==='balloon'&&layer.sfxOrder!=='above');
  const above=layers.filter(layer=>layer.kind==='balloon'&&layer.sfxOrder==='above');
  const text=layers.filter(layer=>layer.kind!=='balloon');
  return above.length?[...behind,...text.filter(layer=>layer.kind==='sfx'),...above,...text.filter(layer=>layer.kind!=='sfx')]:[...behind,...text];
}
