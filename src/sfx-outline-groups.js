import {dilateMask} from './ink.js';
// The union is computed from all members' rendered alpha channels before outlining.
// This prevents visible seams where individually outlined glyphs overlap.
export function unionOuterContour(alpha,width,height,radius){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>5000000||
    !(alpha instanceof Uint8ClampedArray||alpha instanceof Uint8Array)||alpha.length!==width*height||
    !Number.isFinite(radius)||radius<0||radius>80)throw new Error('SFX グループ輪郭が不正');
  const expanded=dilateMask(alpha,width,height,radius),out=new Uint8ClampedArray(alpha.length);
  for(let i=0;i<out.length;i++)out[i]=Math.max(0,expanded[i]-alpha[i]);
  return out;
}
export function glyphGroupBounds(items,padding=0){
  if(!Array.isArray(items)||!items.length)return null;
  const minX=Math.floor(Math.min(...items.map(x=>x.x-x.extent))-padding);
  const minY=Math.floor(Math.min(...items.map(x=>x.y-x.extent))-padding);
  const maxX=Math.ceil(Math.max(...items.map(x=>x.x+x.extent))+padding);
  const maxY=Math.ceil(Math.max(...items.map(x=>x.y+x.extent))+padding);
  const width=maxX-minX,height=maxY-minY;
  if(width<1||height<1||width*height>5000000)return null;
  return {minX,minY,width,height};
}
