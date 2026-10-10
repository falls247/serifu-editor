import { fontDescription } from './fonts.js';
import { inkSeed, glyphVariation, adjustInkThickness } from './ink.js';
import { graphemes, verticalRotation, verticalPunctuationOffset, isCornerPunctuation } from './typography.js';

export const PLACEMENT_DEFAULTS=Object.freeze({kerningMode:'standard',kerningStrength:0,minimumGlyphGap:2,overlapAllowance:0,rotationJitter:0,verticalJitter:0,spacingJitter:0,glyphOverlap:0});
export const PLACEMENT_LIMITS=Object.freeze({kerningStrength:[0,100],minimumGlyphGap:[0,100],overlapAllowance:[0,30],rotationJitter:[0,45],verticalJitter:[0,30],spacingJitter:[0,30],glyphOverlap:[0,30]});
const cache=new Map(),layouts=new Map();let profileAnalyses=0,layoutGlyphs=0;
export function clearLayoutCache(){cache.clear();layouts.clear();profileAnalyses=0;layoutGlyphs=0;}
export function layoutCacheStats(){return {geometries:cache.size,layouts:layouts.size,glyphs:layoutGlyphs,profileAnalyses};}
export function createSurface(ctx,width,height){
  if(typeof OffscreenCanvas==='function')return new OffscreenCanvas(width,height);
  if(typeof document!=='undefined'){const c=document.createElement('canvas');c.width=width;c.height=height;return c;}
  return new ctx.canvas.constructor(width,height);
}

// Used by both optical analysis and the final ink renderer, including vertical punctuation.
export function glyphInkSurface(ctx,layer,char,angle,width,height){
  const ink=createSurface(ctx,width,height),c=ink.getContext('2d'),description=fontDescription(layer);
  c.font=`${description.weight} ${layer.size}px ${description.family}`;c.textAlign='center';c.textBaseline='middle';
  const corner=verticalPunctuationOffset(c,char,layer.size,layer.vertical);
  c.translate(width/2,height/2);c.transform(1,0,Math.tan(layer.skew*Math.PI/180),1,0,0);
  c.scale(layer.stretchX/100,layer.stretchY/100);c.rotate(angle);c.fillStyle='#ffffff';c.fillText(char,corner.x,corner.y);c.setTransform(1,0,0,1,0,0);
  if(!(layer.distortion>0))return ink;
  const warped=createSurface(ctx,width,height),out=warped.getContext('2d');
  for(let y=0;y<height;y+=2){
    const {offset,stretch}=warpAt(layer,y-height/2),slice=Math.min(2,height-y);
    out.drawImage(ink,0,y,width,slice,(width-width*stretch)/2+offset,y,width*stretch,slice);
  }
  return warped;
}
function warpAt(l,y){
  const t=Math.max(-1,Math.min(1,y/(l.size*.8))),amount=l.distortion/100;
  if(l.warp==='wave')return {offset:Math.sin(t*Math.PI*2)*l.size*.2*amount,stretch:1};
  if(l.warp==='bulge')return {offset:0,stretch:1+(1-t*t)*.6*amount};
  if(l.warp==='taper')return {offset:t*l.size*.06*amount,stretch:1+t*.5*amount};
  return {offset:0,stretch:1};
}

// Metrics first. Masks are only built on demand for pairs with intersecting cross-axis bounds.
export function measureGlyph(ctx,l,char,angle){
  const description=fontDescription(l),key=[description.family,description.weight,char,l.size,l.vertical,angle,l.stretchX,l.stretchY,l.skew,l.distortion,l.warp,l.thickness??0].join('|');
  if(cache.has(key)){const entry=cache.get(key);cache.delete(key);cache.set(key,entry);return entry;}
  ctx.font=`${description.weight} ${l.size}px ${description.family}`;ctx.textAlign='center';ctx.textBaseline='middle';
  const m=ctx.measureText(char),corner=verticalPunctuationOffset(ctx,char,l.size,l.vertical),sx=l.stretchX/100,sy=l.stretchY/100,shear=Math.tan(l.skew*Math.PI/180);
  const empty=/^\s+$/u.test(char),left=-(m.actualBoundingBoxLeft??m.width/2),right=m.actualBoundingBoxRight??m.width/2,
    top=-(m.actualBoundingBoxAscent??l.size*.5),bottom=m.actualBoundingBoxDescent??l.size*.5;
  const corners=[[left,top],[right,top],[right,bottom],[left,bottom]].map(([x,y])=>{
    x+=corner.x;y+=corner.y;const rx=(x*Math.cos(angle)-y*Math.sin(angle))*sx,ry=(x*Math.sin(angle)+y*Math.cos(angle))*sy;
    return {x:rx+shear*ry,y:ry};
  });
  let minX=Math.min(...corners.map(p=>p.x)),maxX=Math.max(...corners.map(p=>p.x)),minY=Math.min(...corners.map(p=>p.y)),maxY=Math.max(...corners.map(p=>p.y));
  if(l.distortion>0){
    const xs=[];for(let i=0;i<=32;i++){const y=minY+(maxY-minY)*i/32,{offset,stretch}=warpAt(l,y);xs.push(minX*stretch+offset,maxX*stretch+offset);}
    minX=Math.min(...xs);maxX=Math.max(...xs);
  }
  const thickness=l.thickness??0;
  const bounds={minX:minX-thickness,maxX:maxX+thickness,minY:minY-thickness,maxY:maxY+thickness};
  if(empty){bounds.minX=bounds.maxX=bounds.minY=bounds.maxY=0;}
  const entry={bounds,empty,advance:l.vertical?l.size*1.12*sy:m.width*sx,profiles:null,key};
  cache.set(key,entry);while(cache.size>512)cache.delete(cache.keys().next().value);return entry;
}
function profilesFor(ctx,l,g){
  const geometry=g.geometry;if(geometry.profiles)return geometry.profiles;
  profileAnalyses++;
  const b=geometry.bounds,pad=Math.max(3,Math.abs(l.thickness??0)+2),extentX=Math.max(Math.abs(b.minX),Math.abs(b.maxX))+pad,extentY=Math.max(Math.abs(b.minY),Math.abs(b.maxY))+pad;
  const quality=Math.min(1,128/Math.max(extentX*2,extentY*2)),scaled={...l,size:l.size*quality},width=Math.max(1,Math.ceil(extentX*2*quality)),height=Math.max(1,Math.ceil(extentY*2*quality));
  const pixels=glyphInkSurface(ctx,scaled,g.char,g.angle,width,height).getContext('2d').getImageData(0,0,width,height).data;
  const raw=new Uint8ClampedArray(width*height);for(let i=0;i<raw.length;i++)raw[i]=pixels[i*4+3];
  const alpha=adjustInkThickness(raw,width,height,(l.thickness??0)*quality);
  const rows=Array.from({length:height},()=>[Infinity,-Infinity]),columns=Array.from({length:width},()=>[Infinity,-Infinity]);
  let left=width,right=-1,top=height,bottom=-1;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(alpha[y*width+x]>64){rows[y][0]=Math.min(rows[y][0],x);rows[y][1]=x+1;columns[x][0]=Math.min(columns[x][0],y);columns[x][1]=y+1;left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
  const make=(array,crossCenter,axisCenter)=>array.flatMap(([a,b],i)=>Number.isFinite(a)?[{cross:(i+.5-crossCenter)/quality,start:(a-axisCenter)/quality,end:(b-axisCenter)/quality}]:[]);
  const bounds=right<left?geometry.bounds:{minX:(left-width/2)/quality,maxX:(right+1-width/2)/quality,minY:(top-height/2)/quality,maxY:(bottom+1-height/2)/quality};
  geometry.profiles={horizontal:make(rows,height/2,width/2),vertical:make(columns,width/2,height/2),step:1/quality,bounds};return geometry.profiles;
}

export function contourAdvance(ctx,layer,previous,current,crossDelta=0){
  const vertical=layer.vertical,a=previous.geometry.bounds,b=current.geometry.bounds;
  const maximum=vertical?'maxY':'maxX',minimum=vertical?'minY':'minX',crossMin=vertical?'minX':'minY',crossMax=vertical?'maxX':'maxY';
  const gap=(layer.minimumGlyphGap??2)+Math.max(0,layer.outline??0)*2;
  const boxDistance=a[maximum]-b[minimum]+gap;
  if(previous.geometry.empty||current.geometry.empty)return (previous.geometry.advance+current.geometry.advance)/2;
  let distance=boxDistance;
  // Punctuation keeps its em-cell placement and is never nested into its neighbour.
  if((layer.kerningStrength??0)>=35&&!isCornerPunctuation(previous.char)&&!isCornerPunctuation(current.char)&&a[crossMax]>=b[crossMin]+crossDelta&&b[crossMax]+crossDelta>=a[crossMin]){
    const pa=profilesFor(ctx,{...layer,size:previous.size},previous),pb=profilesFor(ctx,{...layer,size:current.size},current),direction=vertical?'vertical':'horizontal',step=Math.max(pa.step,pb.step);
    previous.inkBounds=pa.bounds;current.inkBounds=pb.bounds;
    let separation=-Infinity,j=0;
    for(const row of pa[direction]){
      while(j<pb[direction].length&&pb[direction][j].cross+crossDelta<row.cross-step)j++;
      for(let k=j;k<pb[direction].length&&pb[direction][k].cross+crossDelta<=row.cross+step;k++)separation=Math.max(separation,row.end-pb[direction][k].start);
    }
    if(Number.isFinite(separation))distance=Math.min(boxDistance,separation+gap);
    // Protect the body of the letters: contour nesting is capped at 22% of the smaller extent.
    distance=Math.max(distance,boxDistance-Math.min(a[maximum]-a[minimum],b[maximum]-b[minimum])*.22);
  }
  const allowance=Math.min(layer.overlapAllowance??0,layer.glyphOverlap??0)/100;
  const overlap=Math.min(a[maximum]-a[minimum],b[maximum]-b[minimum])*.35*allowance;
  return Math.max(Math.min(previous.size,current.size)*.2,distance-overlap);
}

export function glyphBounds(glyphs){
  if(!glyphs.length)return {minX:0,maxX:0,minY:0,maxY:0,width:0,height:0};
  const minX=Math.min(...glyphs.map(g=>g.x+(g.inkBounds??g.geometry.bounds).minX)),maxX=Math.max(...glyphs.map(g=>g.x+(g.inkBounds??g.geometry.bounds).maxX)),minY=Math.min(...glyphs.map(g=>g.y+(g.inkBounds??g.geometry.bounds).minY)),maxY=Math.max(...glyphs.map(g=>g.y+(g.inkBounds??g.geometry.bounds).maxY));
  return {minX,maxX,minY,maxY,width:maxX-minX,height:maxY-minY};
}

export function opticalTextGlyphs(ctx,layer,sizeAt){
  const description=fontDescription(layer),key=JSON.stringify([description,layer.text,layer.size,layer.effect,layer.taperRate,layer.vertical,layer.lineAlign,layer.w,layer.h,layer.thickness,layer.outline,layer.stretchX,layer.stretchY,layer.skew,layer.distortion,layer.warp,layer.sizeVariation,layer.horizontalJitter,layer.glyphSeed,...Object.keys(PLACEMENT_DEFAULTS).map(k=>layer[k])]);
  if(layouts.has(key)){const entry=layouts.get(key);layouts.delete(key);layouts.set(key,entry);return entry;}
  const vertical=layer.vertical,seed=layer.glyphSeed??inkSeed(layer.text),strength=layer.kerningMode==='optical'?(layer.kerningStrength??0)/100:0;
  let index=0;const lines=layer.text.split('\n').map(line=>graphemes(line).map(char=>{
    const i=index++,baseSize=sizeAt(layer,i),variation=glyphVariation(seed,i,layer.sizeVariation||0,layer.horizontalJitter||0,{rotationJitter:layer.rotationJitter,verticalJitter:layer.verticalJitter,spacingJitter:layer.spacingJitter,correlated:true}),size=Math.max(8,baseSize*variation.scale),angle=(vertical?verticalRotation(char):0)+variation.rotation;
    const glyph={char,index:i,baseSize,size,angle,shift:0,x:0,y:0,variation};
    glyph.geometry=measureGlyph(ctx,{...layer,size},char,angle);glyph.width=glyph.geometry.advance;
    glyph.dx=variation.shift*size*layer.stretchX/100;glyph.dy=variation.vertical*size*layer.stretchY/100;
    return glyph;
  }));
  const axis=vertical?'y':'x',cross=vertical?'x':'y',capacity=(vertical?layer.h:layer.w)*.88,runs=[];
  for(const line of lines){
    let run=[];
    for(const g of line){
      const prev=run.at(-1);g[cross]=vertical?g.dx:g.dy;
      if(prev){
        const standard=(prev.geometry.advance+g.geometry.advance)/2,crossDelta=g[cross]-prev[cross];
        const optical=contourAdvance(ctx,layer,prev,g,crossDelta),target=Math.min(standard,optical);
        let distance=standard+(target-standard)*strength;
        const extent=vertical?'Y':'X',overlap=Math.min(layer.overlapAllowance??0,layer.glyphOverlap??0)/100*.35*Math.min(prev.geometry.bounds['max'+extent]-prev.geometry.bounds['min'+extent],g.geometry.bounds['max'+extent]-g.geometry.bounds['min'+extent]);
        distance-=(1-strength)*Math.max(0,overlap);
        distance+=g.variation.spacing*Math.min(prev.size,g.size)+(vertical?g.dy-prev.dy:g.dx-prev.dx);
        // Only close gaps as far as the contour allows; offsets cannot make the body unreadable.
        if(strength||layer.rotationJitter||layer.spacingJitter||layer.verticalJitter||layer.horizontalJitter)distance=Math.max(distance,optical);
        g[axis]=prev[axis]+distance;g.advance=distance;
      }else{g[axis]=vertical?g.dy:g.dx;g.advance=g.geometry.advance;}
      const candidate=[...run,g],bounds=glyphBounds(candidate);
      if(run.length&&(vertical?bounds.height:bounds.width)>capacity+.001){runs.push(run);run=[];g[axis]=vertical?g.dy:g.dx;}
      run.push(g);
    }
    runs.push(run);
  }
  let crossCursor=0;const result=[];
  for(const run of runs){
    const bounds=glyphBounds(run),extent=vertical?bounds.width:bounds.height,advance=Math.max(extent,run.length?Math.max(...run.map(g=>g.size))*(vertical?layer.stretchX:layer.stretchY)/100:layer.size)*1.15;
    const start=vertical?bounds.minY:bounds.minX,end=vertical?bounds.maxY:bounds.maxX;
    const axisOffset=vertical&&runs.length>1&&layer.lineAlign!=='center'?-capacity/2-start:-(start+end)/2;
    const center=vertical?(bounds.minX+bounds.maxX)/2:(bounds.minY+bounds.maxY)/2;
    for(const g of run){g[axis]+=axisOffset;g[cross]+=(vertical?-1:1)*(crossCursor+advance/2)-center;result.push(g);}
    crossCursor+=advance;
  }
  const all=glyphBounds(result),crossCenter=vertical?(all.minX+all.maxX)/2:(all.minY+all.maxY)/2;
  for(const g of result)g[cross]-=crossCenter;
  if(!vertical&&runs.length>1&&layer.lineAlign!=='center')for(const g of result)g.y+=-layer.h*.44-(all.minY-crossCenter);
  // Fit new layouts as a group, including their rotated/warped ink, without changing legacy layout.
  const bounds=glyphBounds(result),fit=Math.min(1,layer.w*.88/Math.max(1,bounds.width),layer.h*.88/Math.max(1,bounds.height));
  if(fit<1)for(const g of result){g.x*=fit;g.y*=fit;g.drawScale=fit;g.geometry={...g.geometry,bounds:Object.fromEntries(Object.entries(g.geometry.bounds).map(([key,value])=>[key,value*fit]))};if(g.inkBounds)g.inkBounds=Object.fromEntries(Object.entries(g.inkBounds).map(([key,value])=>[key,value*fit]));}
  // Layout entries must not keep evicted geometry profiles alive through object references.
  for(const g of result)g.geometry={bounds:{...g.geometry.bounds},empty:g.geometry.empty,advance:g.geometry.advance,key:g.geometry.key};
  if(result.length>20000)return result;
  layouts.set(key,result);layoutGlyphs+=result.length;
  while((layouts.size>64||layoutGlyphs>20000)&&layouts.size>1){const first=layouts.keys().next().value;layoutGlyphs-=layouts.get(first).length;layouts.delete(first);}
  return result;
}
