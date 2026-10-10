const limit=(value,min,max)=>Math.max(min,Math.min(max,value));
const FULL_TURN=Math.PI*2;

export const BALLOON_LIMITS=Object.freeze({transparency:[0,100],borderWidth:[0,80],distortion:[0,100],tailX:[-30000,30000],tailY:[-30000,30000],tailAngle:[-180,180],tailWidth:[1,1000],shadowBlur:[0,100],shadowOffsetX:[-100,100],shadowOffsetY:[-100,100],shadowOpacity:[0,100],brushRoughness:[0,100]});
export const BALLOON_SHAPES=Object.freeze({ellipse:'楕円', 'distorted-rect':'歪み長方形',spiky:'尖り形'});

export function balloonSeedFromId(id) {
  let hash=2166136261;
  for(const char of String(id??'')){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619);}
  return hash>>>0;
}

export function newBalloon(width,height) {
  const w=limit(width*.64,30,30000),h=limit(height*.56,30,30000);
  const id=crypto.randomUUID();
  return {
    id,kind:'balloon',presetId:null,x:width*.88,y:height*.16,w,h,rotation:0,
    text:'',speaker:'male',size:limit(width*.055,8,500),outline:limit(width*.006,1,80),thickness:0,vertical:true,lineAlign:'top',font:'sans',
    color:'#ffffff',transparency:25,borderColor:'#111111',borderWidth:limit(width*.003,.5,80),
    shadowEnabled:false,shadowColor:'#222222',shadowBlur:12,shadowOffsetX:6,shadowOffsetY:6,shadowOpacity:45,borderStyle:'solid',brushRoughness:50,
    shape:'distorted-rect',shapeSeed:balloonSeedFromId(id),distortion:50,tail:false,tailX:0,tailY:h*.85,tailAngle:90,tailWidth:limit(width*.08,1,1000),sfxOrder:'behind',
  };
}

function boundaryScale(layer,angle) {
  const phase=(layer.shapeSeed>>>0)/4294967296*FULL_TURN;
  const amount=(layer.distortion??50)/100;
  if(layer.shape==='spiky'){
    // Narrow radial peaks create distinct sharp points; valleys retain a large
    // central core so vertical or horizontal dialogue remains readable.
    const count=9,period=FULL_TURN/count;
    const phaseAngle=((angle-phase)/period)%1;
    const fraction=Math.abs(phaseAngle-Math.round(phaseAngle));
    const peak=Math.max(0,1-fraction*2);
    const irregular=1+amount*.035*Math.sin(3*angle+phase);
    return (1-amount*.14+amount*.36*peak)*irregular;
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

function balloonPath(ctx,layer,brushPass=0) {
  const g=balloonGeometry(layer);
  ctx.beginPath();
  if(layer.shape==='distorted-rect'||layer.shape==='spiky'||brushPass){
    const from=g.hasTail?g.start:0,to=g.hasTail?g.end:FULL_TURN,steps=Math.max(2,Math.ceil((to-from)/(FULL_TURN/360)));
    for(let index=0;index<=steps;index++){
      const angle=from+(to-from)*index/steps,point=balloonBoundaryPoint(layer,angle);
      if(index===0)ctx.moveTo(point.x,point.y);else ctx.lineTo(point.x,point.y);
    }
    if(g.hasTail){ctx.lineTo(g.tip.x,g.tip.y);ctx.lineTo(g.a.x,g.a.y);}
  }else if(g.hasTail){ctx.ellipse(0,0,g.rx,g.ry,0,g.start,g.end);ctx.lineTo(g.tip.x,g.tip.y);ctx.lineTo(g.a.x,g.a.y);}
  else ctx.ellipse(0,0,g.rx,g.ry,0,0,FULL_TURN);
  ctx.closePath();
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
    if(layer.borderStyle==='brush'){
      for(let pass=1;pass<=3;pass++){
        ctx.save();ctx.globalAlpha=[0,.7,.4,.3][pass];
        ctx.lineWidth=layer.borderWidth*[0,1.05,.7,.38][pass];
        balloonPath(ctx,layer,pass);ctx.stroke();ctx.restore();
      }
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
