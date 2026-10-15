import {graphemes} from './typography.js';
import {defaultGlyph,replaceLetteringText,normalizeLettering,startLettering,duplicateLetteringGlyphs} from './sfx-lettering-model.js';

export const glyphSelection=mode=>[...new Set(mode.indices??[mode.selected])].filter(Number.isInteger);
const glyphLayoutShift=(layer,item)=>(item.letter?.shift??0)*(item.letter?.baseSize??0)*((layer.stretchX??100)/100);
export function selectGlyph(mode,index,{toggle=false,range=false,visible=[]}={}){
  const current=new Set(glyphSelection(mode));
  if(range&&Number.isInteger(mode.selected)){const lo=Math.min(index,mode.selected),hi=Math.max(index,mode.selected);for(const i of visible)if(i>=lo&&i<=hi)current.add(i);}
  else if(toggle){if(current.has(index))current.delete(index);else current.add(index);}
  else{current.clear();current.add(index);}
  mode.indices=[...current].sort((a,b)=>a-b);mode.selected=current.has(index)?index:mode.indices.at(-1)??null;
}
export function freezeGlyphOrigins(layer,scene,indices=null){
  const selected=indices==null?null:new Set(indices);
  for(const item of scene.glyphs){if(selected&&!selected.has(item.index))continue;const glyph=layer.lettering.glyphs.find(g=>g.index===item.index);if(!glyph.origin)glyph.origin={x:item.x-glyph.dx-glyphLayoutShift(layer,item),y:item.y-glyph.dy};}
}
export function copyLetteringSelection(layer,mode,scene){
  const indices=new Set(glyphSelection(mode));
  for(const stroke of layer.lettering.strokes)if((mode.strokeRuns||[]).includes(stroke.runStart))for(let i=0;i<stroke.runLength;i++)indices.add(stroke.runStart+i);
  const chars=graphemes(layer.text),sorted=[...indices].sort((a,b)=>a-b),members=scene.glyphs.filter(g=>indices.has(g.index));
  if(!sorted.length)return null;
  const base=members[0]??{x:0,y:0};
  const mapping=new Map(sorted.map((index,i)=>[index,i]));
  return {sourceId:layer.id,text:sorted.map(i=>chars[i]).join(''),glyphs:sorted.map(index=>{
    const g=structuredClone(layer.lettering.glyphs.find(g=>g.index===index)),item=members.find(i=>i.index===index);return {...g,index:mapping.get(index),origin:null,dx:(item?.x??0)-base.x,dy:(item?.y??0)-base.y};
  }),strokes:layer.lettering.strokes.filter(s=>Array.from({length:s.runLength},(_,i)=>s.runStart+i).every(i=>indices.has(i))).map(s=>({...structuredClone(s),runStart:mapping.get(s.runStart)}))};
}
export function pasteLetteringSelection(layer,clipboard,{after=null,position={x:0,y:0},strokePart='all'}={}){
  if(!clipboard?.text||graphemes(clipboard.text).length>1024)return {layer,indices:[]};
  const chars=graphemes(layer.text),insert=after==null?chars.length:Math.min(chars.length,Math.max(0,after+1));
  const text=[...chars.slice(0,insert),clipboard.text,...chars.slice(insert)].join(''),next=replaceLetteringText(layer,text,'character'),same=clipboard.sourceId===layer.id;
  for(const original of clipboard.glyphs){
    const index=insert+original.index,g=next.lettering.glyphs.find(g=>g.index===index);if(!g)continue;
    Object.assign(g,structuredClone(original),{index,origin:{...position},manual:{position:true,transform:true,style:same,z:true}});
    if(!same){g.overrides=defaultGlyph(index).overrides;g.inkVariantSeed=defaultGlyph(index,next.lettering.inkSeed).inkVariantSeed;}
  }
  for(const original of clipboard.strokes){
    const run=next.lettering.strokes.find(s=>s.runStart===insert+original.runStart);if(!run)continue;
    const value=structuredClone(original);
    if(strokePart==='all'||strokePart==='shape'){run.mode=value.mode;run.path=value.path;run.shape=value.shape;run.start=value.start;run.end=value.end;delete run.start.fixedPosition;delete run.end.fixedPosition;run.start.detached=false;run.end.detached=false;}
    if(strokePart==='all'||strokePart==='width')run.widths=value.widths;
    if(same&&(strokePart==='all'||strokePart==='look'))run.lookOverride=value.lookOverride;
    else run.lookOverride=null;
  }
  next.lettering=normalizeLettering(next.lettering,text,next);
  return {layer:next,indices:clipboard.glyphs.map(g=>insert+g.index)};
}
export function duplicateSelectedGlyphs(layer,indices,scene,{offset=20}={}){
  const base=structuredClone(layer);freezeGlyphOrigins(base,scene);for(const g of base.lettering.glyphs){const item=scene.glyphs.find(i=>i.index===g.index);if(item&&indices.includes(g.index))g.sizeRatio=item.letter.size/layer.size;}
  return duplicateLetteringGlyphs(base,indices,{offset});
}
export function rotateLetteringOrientation(layer,vertical){
  if(layer.vertical===vertical)return layer;
  const next=structuredClone(layer),s=vertical?1:-1;
  next.vertical=vertical;next.lettering.orientation=vertical?'vertical':'horizontal';
  if(next.lettering.baseBox)next.lettering.baseBox={w:next.lettering.baseBox.h,h:next.lettering.baseBox.w};
  for(const g of next.lettering.glyphs){[g.dx,g.dy]=[-s*g.dy,s*g.dx];if(g.origin)[g.origin.x,g.origin.y]=[-s*g.origin.y,s*g.origin.x];}
  for(const stroke of next.lettering.strokes)for(const side of ['start','end']){const p=stroke[side].fixedPosition;if(p)[p.x,p.y]=[-s*p.y,s*p.x];}
  return next;
}
export function transformGlyphSelection(layer,indices,scene,{dx=0,dy=0,rotation=0,scaleX=1,scaleY=1}={}){
  const chosen=scene.glyphs.filter(item=>indices.includes(item.index));if(!chosen.length)return;
  const center={x:chosen.reduce((s,g)=>s+g.x,0)/chosen.length,y:chosen.reduce((s,g)=>s+g.y,0)/chosen.length};
  const a=rotation*Math.PI/180,c=Math.cos(a),s=Math.sin(a);freezeGlyphOrigins(layer,scene,indices);
  for(const item of chosen){const g=layer.lettering.glyphs.find(g=>g.index===item.index),x=(item.x-center.x)*scaleX,y=(item.y-center.y)*scaleY;
    g.dx=center.x+x*c-y*s+dx-g.origin.x-glyphLayoutShift(layer,item);g.dy=center.y+x*s+y*c+dy-g.origin.y;
    g.rotation+=rotation;g.scaleX=Math.max(.01,Math.min(20,g.scaleX*scaleX));g.scaleY=Math.max(.01,Math.min(20,g.scaleY*scaleY));g.manual.position=true;g.manual.transform=rotation!==0||scaleX!==1||scaleY!==1||g.manual.transform;
  }
}
export function pointInPolygon(point,polygon){let inside=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const a=polygon[i],b=polygon[j];if((a.y>point.y)!==(b.y>point.y)&&point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x)inside=!inside;}return inside;}
export function selectionRegion(items,polygon,{contain=false,hit=()=>true}={}){
  if(polygon.length<3)return [];
  const xs=polygon.map(p=>p.x),ys=polygon.map(p=>p.y),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  return items.filter(item=>{const b=item.bounds;
    if(contain)return [{x:b.minX,y:b.minY},{x:b.maxX,y:b.minY},{x:b.maxX,y:b.maxY},{x:b.minX,y:b.maxY}].every(p=>pointInPolygon(p,polygon));
    const x0=Math.max(minX,b.minX),x1=Math.min(maxX,b.maxX),y0=Math.max(minY,b.minY),y1=Math.min(maxY,b.maxY),step=Math.max(1,Math.sqrt(Math.max(0,(x1-x0)*(y1-y0))/10000));
    for(let y=y0;y<=y1;y+=step)for(let x=x0;x<=x1;x+=step){const p={x,y};if(pointInPolygon(p,polygon)&&hit(item,p))return true;}return false;
  });
}

export function scaleLetteringData(layer,sx,sy){
  const l=layer.lettering;if(!l)return;
  const factor=Math.min(sx,sy);if(l.baseBox){l.baseBox.w=Math.max(30,Math.min(30000,l.baseBox.w*sx));l.baseBox.h=Math.max(30,Math.min(30000,l.baseBox.h*sy));}
  for(const g of l.glyphs){g.dx*=sx;g.dy*=sy;if(g.origin){g.origin.x*=sx;g.origin.y*=sy;}if(g.pivot.preset==='custom'){g.pivot.x*=sx;g.pivot.y*=sy;}}
  for(const stroke of l.strokes){if(stroke.lockedLength)stroke.lockedLength*=factor;for(const knot of stroke.widths){knot.w=Math.min(500,knot.w*factor);if(knot.distance)knot.distance*=factor;}for(const side of ['start','end']){const p=stroke[side].fixedPosition;if(p){p.x*=sx;p.y*=sy;}}}
}
