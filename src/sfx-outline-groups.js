import {dilateMask} from './ink.js';
// The union is computed from all members' rendered alpha channels before outlining.
// This prevents visible seams where individually outlined glyphs overlap.
export function unionOuterContour(alpha,width,height,radius){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>5000000||
    !(alpha instanceof Uint8ClampedArray||alpha instanceof Uint8Array)||alpha.length!==width*height||
    !Number.isFinite(radius)||radius<0||radius>80)throw new Error('SFX グループ輪郭が不正');
  // Flood exterior transparency, then fill enclosed counters before taking outside-only contour.
  const outside=new Uint8Array(alpha.length),queue=new Uint32Array(alpha.length);let head=0,tail=0;
  const enqueue=i=>{if(!outside[i]&&alpha[i]<128){outside[i]=1;queue[tail++]=i;}};
  for(let x=0;x<width;x++){enqueue(x);enqueue((height-1)*width+x);}for(let y=0;y<height;y++){enqueue(y*width);enqueue(y*width+width-1);}
  while(head<tail){const i=queue[head++],x=i%width,y=Math.floor(i/width);if(x)enqueue(i-1);if(x+1<width)enqueue(i+1);if(y)enqueue(i-width);if(y+1<height)enqueue(i+width);}
  const filled=new Uint8ClampedArray(alpha);for(let i=0;i<filled.length;i++)if(!outside[i]&&alpha[i]<128)filled[i]=255;
  const expanded=dilateMask(filled,width,height,radius),out=new Uint8ClampedArray(alpha.length);
  for(let i=0;i<out.length;i++)out[i]=Math.max(0,expanded[i]-filled[i]);
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

export function resolveOutlineGroups(items,groups,{enabled=true,overlaps=(a,b)=>a.bounds.minX<=b.bounds.maxX&&a.bounds.maxX>=b.bounds.minX&&a.bounds.minY<=b.bounds.maxY&&a.bounds.maxY>=b.bounds.minY}={}){
  const fixed=groups.filter(g=>g.locked||g.mode==='manual'),reserved=new Set(fixed.flatMap(g=>g.members));
  if(!enabled)return groups;
  const available=items.filter(item=>!item.members.some(index=>reserved.has(index))),parent=available.map((_,i)=>i);
  const root=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  const sorted=available.map((item,i)=>({item,i})).sort((a,b)=>a.item.bounds.minX-b.item.bounds.minX);
  for(let i=0;i<sorted.length;i++)for(let j=i+1;j<sorted.length&&sorted[j].item.bounds.minX<=sorted[i].item.bounds.maxX;j++){
    if(overlaps(sorted[i].item,sorted[j].item))parent[root(sorted[j].i)]=root(sorted[i].i);
  }
  const components=new Map();
  available.forEach((item,i)=>{const key=root(i);if(!components.has(key))components.set(key,[]);components.get(key).push(...item.members);});
  return [...fixed,...[...components.values()].map(members=>{const previous=groups.find(g=>!g.locked&&g.members.some(i=>members.includes(i)));return {members:[...new Set(members)],mode:'auto',locked:false,styleOverride:previous?.styleOverride??null};})];
}
