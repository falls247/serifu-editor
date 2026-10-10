const limit=(value,min,max)=>Math.max(min,Math.min(max,value));

export const BALLOON_LIMITS=Object.freeze({transparency:[0,100],borderWidth:[0,80],tailX:[-30000,30000],tailY:[-30000,30000],tailAngle:[-180,180],tailWidth:[1,1000]});

export function newBalloon(width,height) {
  const w=limit(width*.64,30,30000),h=limit(height*.56,30,30000);
  return {
    id:crypto.randomUUID(),kind:'balloon',x:width*.88,y:height*.16,w,h,rotation:0,
    color:'#ffffff',transparency:25,borderColor:'#111111',borderWidth:limit(width*.003,.5,80),
    tail:false,tailX:0,tailY:h*.85,tailAngle:90,tailWidth:limit(width*.08,1,1000),sfxOrder:'behind',
  };
}

export function balloonGeometry(layer) {
  const rx=layer.w/2,ry=layer.h/2,angle=layer.tailAngle*Math.PI/180;
  const half=limit(layer.tailWidth/(2*Math.hypot(rx*Math.sin(angle),ry*Math.cos(angle))),.01,Math.PI*.4);
  const start=angle+half,end=angle-half+Math.PI*2;
  return {rx,ry,start,end,a:{x:rx*Math.cos(start),y:ry*Math.sin(start)},b:{x:rx*Math.cos(end),y:ry*Math.sin(end)},
    tip:{x:layer.tailX,y:layer.tailY},hasTail:layer.tail&&(layer.tailX/rx)**2+(layer.tailY/ry)**2>1};
}

export function balloonHit(layer,point) {
  const g=balloonGeometry(layer);
  if((point.x/g.rx)**2+(point.y/g.ry)**2<=1)return true;
  if(!g.hasTail)return false;
  const cross=(a,b)=>(point.x-b.x)*(a.y-b.y)-(a.x-b.x)*(point.y-b.y);
  const sides=[cross(g.a,g.b),cross(g.b,g.tip),cross(g.tip,g.a)];
  return sides.every(value=>value>=0)||sides.every(value=>value<=0);
}

export function paintBalloon(ctx,layer) {
  const g=balloonGeometry(layer);
  ctx.beginPath();
  if(g.hasTail){ctx.ellipse(0,0,g.rx,g.ry,0,g.start,g.end);ctx.lineTo(g.tip.x,g.tip.y);ctx.lineTo(g.a.x,g.a.y);}
  else ctx.ellipse(0,0,g.rx,g.ry,0,0,Math.PI*2);
  ctx.closePath();
  ctx.save();ctx.globalAlpha*=1-layer.transparency/100;ctx.fillStyle=layer.color;ctx.fill();ctx.restore();
  if(layer.borderWidth>0){ctx.strokeStyle=layer.borderColor;ctx.lineWidth=layer.borderWidth;ctx.lineJoin='round';ctx.stroke();}
}

// Every balloon stays below dialogue and captions. Front balloons also require SFX below them.
export function paintOrder(layers) {
  const behind=layers.filter(layer=>layer.kind==='balloon'&&layer.sfxOrder!=='above');
  const above=layers.filter(layer=>layer.kind==='balloon'&&layer.sfxOrder==='above');
  const text=layers.filter(layer=>layer.kind!=='balloon');
  return above.length?[...behind,...text.filter(layer=>layer.kind==='sfx'),...above,...text.filter(layer=>layer.kind!=='sfx')]:[...behind,...text];
}
