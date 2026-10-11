import { inkSeed } from './ink.js';
import { createSurface } from './glyph-layout.js';

export const BRUSH_LIMITS=Object.freeze({brushRoughness:[0,100],brushPressureVariation:[0,100],brushTexture:[0,100],brushOpacityVariation:[0,100]});
export const BRUSH_MODES=Object.freeze({solid:'通常線',brush:'手描きペン','dry-brush':'掠れ筆'});
export function brushDefaults(id){return {borderStyle:'solid',brushEngine:'pressure',brushRoughness:35,brushPressureVariation:35,brushTexture:20,brushOpacityVariation:15,brushSeed:inkSeed(String(id)+':brush')};}
export function normalizeBrush(input){
  const defaults=brushDefaults(input.id),values={...defaults};
  // The previous fibre renderer remains available for old saved balloon brushes.
  values.brushEngine=input.brushEngine??(input.kind==='balloon'?'legacy':'pressure');
  if(values.brushEngine==='legacy')values.brushRoughness=50;
  for(const key of ['borderStyle','brushSeed',...Object.keys(BRUSH_LIMITS)])if(input[key]!==undefined)values[key]=input[key];
  if(input.brushSeed===undefined)values.brushSeed=input.shapeSeed??defaults.brushSeed;
  if(!Object.hasOwn(BRUSH_MODES,values.borderStyle)||!['legacy','pressure'].includes(values.brushEngine)||!Number.isInteger(values.brushSeed)||values.brushSeed<0||values.brushSeed>4294967295)throw new Error('ブラシの方式・seedが不正');
  for(const [key,[min,max]] of Object.entries(BRUSH_LIMITS))if(!Number.isFinite(values[key])||values[key]<min||values[key]>max)throw new Error('ブラシの設定が範囲外');
  return values;
}
function hash(seed,index){let n=seed^Math.imul(index+1,374761393);n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967296;}
// Periodic harmonics have identical values and derivatives at the closed-path seam.
export function brushNoise(t,seed,channel=0,frequency=1){
  let sum=0,weight=0;for(let i=0;i<4;i++){const w=1/(i+1)**1.5,phase=hash(seed^Math.imul(channel+1,668265263),i)*Math.PI*2;sum+=Math.sin(t*Math.PI*2*(i+1)*frequency+phase)*w;weight+=w;}
  return sum/weight;
}
export function sampleClosedPath(source,step=2,maxSamples=8192){
  const points=source.filter((p,i)=>!i||Math.hypot(p.x-source[i-1].x,p.y-source[i-1].y)>1e-7).map(p=>({...p}));
  if(points.length<2)return [];
  if(Math.hypot(points[0].x-points.at(-1).x,points[0].y-points.at(-1).y)>1e-7)points.push({...points[0]});
  const distances=[0];for(let i=1;i<points.length;i++)distances.push(distances[i-1]+Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y));
  const total=distances.at(-1);if(!total)return [];
  const count=Math.min(maxSamples-points.length,Math.max(12,Math.ceil(total/Math.max(.5,step)))),marks=[];
  for(let i=0;i<count;i++)marks.push(total*i/count);
  // Retain geometric corners even when an equal-distance sample would miss a tail tip.
  for(let i=0;i<points.length-1;i++){
    const p=points[i],a=points[(i+points.length-2)%(points.length-1)],b=points[i+1],u={x:p.x-a.x,y:p.y-a.y},v={x:b.x-p.x,y:b.y-p.y};
    const cosine=(u.x*v.x+u.y*v.y)/(Math.hypot(u.x,u.y)*Math.hypot(v.x,v.y));
    if(cosine<.975)marks.push(distances[i]);
  }
  marks.sort((a,b)=>a-b);let segment=1;
  const samples=[];for(const s of marks){
    if(samples.length&&s-samples.at(-1).s<1e-5)continue;
    while(segment<points.length-1&&distances[segment]<s)segment++;
    const a=points[segment-1],b=points[segment],f=(s-distances[segment-1])/(distances[segment]-distances[segment-1]);
    samples.push({x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f,s,t:s/total,total});
  }
  return samples.map((p,i)=>{
    const a=samples[(i+samples.length-1)%samples.length],b=samples[(i+1)%samples.length],u={x:p.x-a.x,y:p.y-a.y},v={x:b.x-p.x,y:b.y-p.y},ul=Math.hypot(u.x,u.y)||1,vl=Math.hypot(v.x,v.y)||1;
    const nx1=-u.y/ul,ny1=u.x/ul,nx2=-v.y/vl,ny2=v.x/vl,bisector=Math.hypot(nx1+nx2,ny1+ny2)||1,nx=(nx1+nx2)/bisector,ny=(ny1+ny2)/bisector;
    const join=Math.min(4,1/Math.max(.01,nx*nx2+ny*ny2)),corner=Math.max(0,1-(u.x*v.x+u.y*v.y)/(ul*vl));
    return {...p,tx:ny,ty:-nx,nx,ny,join,corner};
  });
}
export function brushDynamics(samples,layer){
  const seed=layer.brushSeed??layer.shapeSeed??1,pressure=(layer.brushPressureVariation??35)/100,rough=(layer.brushRoughness??35)/100,opacity=(layer.brushOpacityVariation??15)/100;
  return samples.map(p=>{
    const inkPressure=1+brushNoise(p.t,seed,1)*pressure*.8,width=layer.borderWidth*inkPressure;
    const wobble=brushNoise(p.t,seed,2,7)*rough*layer.borderWidth*.22/(1+p.corner*16);
    return {...p,x:p.x+p.nx*wobble,y:p.y+p.ny*wobble,pressure:inkPressure,width,opacity:1-opacity*(.5+.5*brushNoise(p.t,seed,3)),nibAngle:Math.atan2(p.ty,p.tx)+brushNoise(p.t,seed,4)*.12};
  });
}
const masks=new Map();let maskPixels=0;
export function clearBrushCache(){masks.clear();maskPixels=0;}
export function brushCacheStats(){return {entries:masks.size,pixels:maskPixels};}
function polygon(ctx,points){ctx.moveTo(points[0].x,points[0].y);for(const p of points.slice(1))ctx.lineTo(p.x,p.y);ctx.closePath();}
function edges(p,offset=0,half=.5){
  return [{x:p.x+p.nx*p.width*(offset-half)*p.join,y:p.y+p.ny*p.width*(offset-half)*p.join},{x:p.x+p.nx*p.width*(offset+half)*p.join,y:p.y+p.ny*p.width*(offset+half)*p.join}];
}
function paintBand(ctx,samples,offset=0,half=.5,accept=()=>true){
  ctx.beginPath();for(let i=0;i<samples.length;i++)if(accept(samples[i],i)){
    const a=edges(samples[i],offset,half),b=edges(samples[(i+1)%samples.length],offset,half);polygon(ctx,[a[0],a[1],b[1],b[0]]);
  }ctx.fill();
}
export function paintBrushStroke(ctx,outline,layer){
  if(!(layer.borderWidth>0)||outline.length<3)return;
  const key=JSON.stringify([outline,layer.borderWidth,layer.borderColor,layer.borderStyle,layer.brushRoughness,layer.brushPressureVariation,layer.brushTexture,layer.brushOpacityVariation,layer.brushSeed]);
  let entry=masks.get(key);
  if(!entry){
    const points=brushDynamics(sampleClosedPath(outline,Math.max(.8,layer.borderWidth*.18)),layer),margin=layer.borderWidth*4+3;
    const left=Math.floor(Math.min(...outline.map(p=>p.x))-margin),top=Math.floor(Math.min(...outline.map(p=>p.y))-margin),w=Math.ceil(Math.max(...outline.map(p=>p.x))+margin-left),h=Math.ceil(Math.max(...outline.map(p=>p.y))+margin-top);
    const quality=Math.min(1,Math.sqrt(2000000/(w*h))),width=Math.max(1,Math.ceil(w*quality)),height=Math.max(1,Math.ceil(h*quality)),surface=createSurface(ctx,width,height),c=surface.getContext('2d');
    c.scale(quality,quality);c.translate(-left,-top);c.fillStyle='#ffffff';paintBand(c,points);
    // Texture is cut from a private stroke mask. Fill, text and background are never erased.
    c.globalCompositeOperation='destination-out';const seed=layer.brushSeed??1,texture=(layer.brushTexture??20)/100*(layer.borderStyle==='dry-brush'?1:.5),opacity=(layer.brushOpacityVariation??15)/100;
    if(opacity){
      // Small opacity steps avoid seams from repeatedly compositing neighbouring polygons.
      for(let bucket=0;bucket<12;bucket++){c.globalAlpha=opacity*(bucket+.5)/12;paintBand(c,points,0,.5,p=>Math.min(11,Math.floor((1-p.opacity)/opacity*12))===bucket);}
    }
    if(texture){
      const strands=11;
      for(let strand=0;strand<strands;strand++){
        const offset=(strand/(strands-1)-.5)*.96,edge=Math.abs(offset)*2,phase=hash(seed,strand+30),frequency=Math.max(2,Math.round(points[0].total/Math.max(8,layer.borderWidth*6)));
        c.globalAlpha=.72+texture*.28;
        paintBand(c,points,offset,texture*(.015+edge*.022),p=>brushNoise((p.t+phase)%1,seed,strand+5,frequency)>(.5-texture*.9));
      }
      // Short broken patches follow stroke travel, without removing the full stroke width.
      c.globalAlpha=texture*.7;paintBand(c,points,.22,texture*.11,p=>brushNoise(p.t,seed,24,13)>.42);
    }
    if(layer.brushRoughness>0){
      c.globalCompositeOperation='source-over';c.globalAlpha=(layer.brushRoughness/100)*.22;
      for(const side of [-1,1])paintBand(c,points,side*.54,.012,p=>brushNoise(p.t,seed,26,17)>.2);
    }
    c.globalCompositeOperation='source-in';c.globalAlpha=1;c.fillStyle=layer.borderColor;c.fillRect(left,top,w,h);
    c.globalCompositeOperation='source-over';
    entry={surface,left,top,w,h,width,height};masks.set(key,entry);maskPixels+=width*height;
    while((maskPixels>6000000||masks.size>32)&&masks.size>1){const first=masks.keys().next().value,old=masks.get(first);maskPixels-=old.width*old.height;masks.delete(first);}
  }else{masks.delete(key);masks.set(key,entry);}
  ctx.drawImage(entry.surface,entry.left,entry.top,entry.w,entry.h);
}
