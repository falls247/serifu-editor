import { sfxVisibleIndices } from './sfx-lettering-model.js';
import { strokeGeometry, strokePolygon, strokeBounds } from './sfx-stroke-geometry.js';
import {unionOuterContour,glyphGroupBounds,resolveOutlineGroups} from './sfx-outline-groups.js';
import { inkSeed, distressMask, printDistressMask, directionalBlur, dilateMask, adjustInkThickness, glyphVariation } from './ink.js';
import { glyphFontDescription, clearFontCache } from './fonts.js';
import { newBalloon, balloonHit, balloonOutline, paintBalloon, paintOrder, balloonContentBox } from './balloons.js';
import { newCaption, captionOutline, paintCaption } from './captions.js';
import { graphemes, verticalRotation, verticalPunctuationOffset } from './typography.js';
import { PLACEMENT_DEFAULTS, opticalTextGlyphs, glyphInkSurface, clearLayoutCache, createSurface } from './glyph-layout.js';
import { imageMatrix } from './image-edit.js';
import { applyMaskEffectsToImageData, maskEffectPatch } from './mask-effects.js';
import { TRANSPARENT } from './colors.js';
export { paintOrder } from './balloons.js';
export { FONT_CHOICES } from './fonts.js';
export const DIALOGUE_COLORS = Object.freeze({ male: '#111111', female: '#ef4b91' });
export const dialogueColor = layer => layer.textColor??DIALOGUE_COLORS[layer.speaker];
export const EFFECTS = Object.freeze({ none:'なし', taper:'先細り', impact: 'ドン！／立体', burst: 'バン！／集中線', speed: 'シュッ／スピード', rumble: 'ゴゴゴ／震え', tension: 'ゾワッ／感情・緊張' });
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function newLayer(kind, width, height, speaker = 'male') {
  if(kind==='balloon')return newBalloon(width,height,speaker);
  if(kind==='caption')return newCaption(width,height);
  const id=crypto.randomUUID();
  return {
    id, kind, speaker, ...(kind==='sfx'?{autoFit:false}:{}),
    text: kind === 'sfx' ? 'ドーン！' : '',
    lineAlign:'top',
    x: width * .5, y: height * .4,
    w: clamp(width * (kind === 'sfx' ? .34 : .28), 30, 30000), h: clamp(height * (kind === 'sfx' ? .75 : .62), 30, 30000),
    size: clamp(Math.round(width * (kind === 'sfx' ? .09 : .055)), 16, 500),
    rotation: kind === 'sfx' ? -12 : 0, thickness:0, outline: clamp(Math.round(width * .006), 2, 80),
    vertical: true, color: '#111111', effect: 'burst', taperRate:10,
    textOutlineColor:'#ffffff', ...(kind==='dialogue'?{textColor:null}:{}),
    font: kind === 'sfx' ? 'comic' : 'sans', blur: 0, motionBlur: 0, blurAngle: 90,
    distortion: kind === 'sfx' ? 25 : 0, warp: 'taper', skew: kind === 'sfx' ? -10 : 0, stretchX: 100, stretchY: 100, presetId: null,
    blurX: 0, blurY: 0, blurStrength: 200, inkCore: 80,
    roughness: kind === 'sfx' ? 18 : 0, dryInk: kind === 'sfx' ? 22 : 0, brushTails: kind === 'sfx' ? 25 : 0,
    ...PLACEMENT_DEFAULTS,
    sizeVariation:kind==='sfx'?5:0, horizontalJitter:kind==='sfx'?3:0, glyphSeed:inkSeed(id),
    inkTexture:'none',grungeAmount:65,scratchLength:55,scratchAngle:90,spatterAmount:40,textureSeed:inkSeed(id+':texture'),
  };
}

export function localPoint(layer, x, y) {
  const angle = -layer.rotation * Math.PI / 180;
  const dx = x - layer.x, dy = y - layer.y;
  return { x: dx * Math.cos(angle) - dy * Math.sin(angle), y: dx * Math.sin(angle) + dy * Math.cos(angle) };
}

export function hit(layer, x, y) {
  const p = localPoint(layer, x, y);
  if(layer.kind==='balloon')return balloonHit(layer,p);
  return Math.abs(p.x) <= layer.w / 2 && Math.abs(p.y) <= layer.h / 2;
}

export function handleAt(layer, x, y, scale = 1) {
  const p = localPoint(layer, x, y), radius = 12 / scale;
  if(layer.kind==='balloon'&&layer.tail&&Math.hypot(p.x-layer.tailX,p.y-layer.tailY)<=radius)return 'tail';
  if (Math.hypot(p.x - layer.w / 2, p.y - layer.h / 2) <= radius) return 'resize';
  if (Math.hypot(p.x, p.y + layer.h / 2 + 24 / scale) <= radius) return 'rotate';
  return null;
}

function ornament(ctx, l) {
  if (l.kind !== 'sfx') return;
  const w = l.w, h = l.h;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#111111';
  if (l.effect === 'burst') {
    // Deterministic tapered strokes: the exported image matches the live preview.
    for (let i = 0; i < 18; i++) {
      const a = i * Math.PI * 2 / 18;
      const inner = .38 + (i % 3) * .03, outer = .5;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * w * inner, Math.sin(a) * h * inner);
      ctx.lineTo(Math.cos(a - .015) * w * outer, Math.sin(a - .015) * h * outer);
      ctx.lineTo(Math.cos(a + .015) * w * outer, Math.sin(a + .015) * h * outer);
      ctx.closePath(); ctx.fillStyle = '#111111'; ctx.fill();
    }
  } else if (l.effect === 'speed') {
    for (let i = 0; i < 5; i++) {
      const y = (i - 2) * h * .14;
      ctx.beginPath(); ctx.moveTo(-w * .49, y + h * .07); ctx.lineTo(-w * (.13 + (i % 2) * .08), y);
      ctx.lineWidth = l.size * (.018 + (i % 3) * .008); ctx.stroke();
    }
  } else if (l.effect === 'rumble') {
    for (const side of [-1, 1]) {
      ctx.beginPath();
      for (let i = 0; i < 7; i++) {
        const x = side * (w * .45 + (i % 2) * l.size * .05), y = (i - 3) * h * .1;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.lineWidth = Math.max(1, l.size * .025); ctx.stroke();
    }
  }
  ctx.restore();
}

export const WARP_CHOICES = Object.freeze({ wave: '波打ち', bulge: '膨張', taper: '先細り' });
const glyphCache = new Map();
const sfxFitCache = new Map();
let cachePixels = 0,cacheHits=0,cacheMisses=0,cacheEvictions=0,uncachedGlyphs=0;
export function glyphCacheStats(){return Object.freeze({entries:glyphCache.size,pixels:cachePixels,limitPixels:5000000,hits:cacheHits,misses:cacheMisses,evictions:cacheEvictions,uncached:uncachedGlyphs});}
export function clearGlyphCache() { glyphCache.clear(); sfxFitCache.clear(); cachePixels = 0; cacheHits=cacheMisses=cacheEvictions=uncachedGlyphs=0; clearLayoutCache(); clearFontCache(); }
function storeGlyph(key,value){
  glyphCache.set(key,value);cachePixels+=value.width*value.height;
  while(cachePixels>5000000&&glyphCache.size>1){const first=glyphCache.keys().next().value,old=glyphCache.get(first);cachePixels-=old.width*old.height;glyphCache.delete(first);cacheEvictions++;}
}
function drawInk(ctx, l, char, x, y) {
  const color=l.kind==='sfx'?l.color:dialogueColor(l);
  if(color===TRANSPARENT){
    if(l.outline<=0)return;
    const size=Math.ceil((l.size*3+l.outline*4)/2)*2,surface=createSurface(ctx,size,size),c=surface.getContext('2d');
    c.font=ctx.font;c.textAlign=ctx.textAlign;c.textBaseline=ctx.textBaseline;c.lineJoin='round';
    c.strokeStyle=l.textOutlineColor??'#ffffff';c.lineWidth=l.outline*2;
    c.strokeText(char,size/2,size/2);
    c.globalCompositeOperation='destination-out';c.fillText(char,size/2,size/2);
    ctx.drawImage(surface,x-size/2,y-size/2);return;
  }
  if (l.kind === 'sfx' && !['none','taper','tension'].includes(l.effect)) {
    const depth = l.size * (l.effect === 'impact' || l.effect === 'burst' ? .13 : .05);
    ctx.strokeStyle = '#111111'; ctx.fillStyle = '#111111'; ctx.lineWidth = l.outline * 2 + l.size * .05;
    ctx.strokeText(char, x + depth, y + depth); ctx.fillText(char, x + depth, y + depth);
  }
  if(l.outline>0){ctx.strokeStyle=l.textOutlineColor??'#ffffff';ctx.lineWidth=l.outline*2;ctx.strokeText(char,x,y);}
  ctx.fillStyle = color; ctx.fillText(char, x, y);
}
function tintedMask(ctx, alpha, width, height, color, strength=1) {
  const surface=createSurface(ctx,width,height);
  if(color===TRANSPARENT)return surface;
  const c=surface.getContext('2d'),pixels=c.createImageData(width,height);
  const rgb=[1,3,5].map(start=>parseInt(color.slice(start,start+2),16));
  for(let i=0;i<alpha.length;i++){pixels.data[i*4]=rgb[0];pixels.data[i*4+1]=rgb[1];pixels.data[i*4+2]=rgb[2];pixels.data[i*4+3]=Math.min(255,alpha[i]*strength);}
  c.putImageData(pixels,0,0);return surface;
}
function warpedGlyph(ctx, l, char, glyphAngle=0, glyphIndex=0) {
  if(l.kind!=='sfx')l={...l,color:dialogueColor(l),effect:'tension',stretchX:100,stretchY:100,skew:0,distortion:0,roughness:0,dryInk:0,brushTails:0,blurX:0,blurY:0};
  const outlineColor=l.textOutlineColor??'#ffffff';
  const textured=l.kind==='sfx'&&l.inkTexture==='grunge'&&(l.grungeAmount>0||l.spatterAmount>0);
  const textureKey=textured?[l.inkTexture,l.grungeAmount,l.scratchLength,l.scratchAngle,l.spatterAmount,l.textureSeed,glyphIndex]:[];
  const key = [char,glyphAngle,l.vertical,l.kind,l.size,l.thickness??0,l.outline,outlineColor,l.color,l.effect,l.font,l.distortion,l.warp,l.skew,l.stretchX,l.stretchY,l.roughness,l.dryInk,l.brushTails,l.blurX,l.blurY,l.blurStrength,l.inkCore,...textureKey].join('|');
  if (glyphCache.has(key)) { cacheHits++;const value = glyphCache.get(key); glyphCache.delete(key); glyphCache.set(key,value); return value; }
  cacheMisses++;
  const sx=l.stretchX/100,sy=l.stretchY/100,shear=Math.tan(l.skew*Math.PI/180);
  const reach=l.size*(l.brushTails||0)/100*.65;
  const base=l.size*(2.5*Math.max(sx,sy)+Math.abs(shear)*sy)+l.outline*6+Math.max(0,l.thickness||0)*6+reach*2;
  const drawWidth=Math.ceil(base+(l.blurX||0)*3.5),drawHeight=Math.ceil(base+(l.blurY||0)*3.5);
  // Bound intermediate allocations at extreme font/blur/stretch settings.
  const quality=Math.min(1,Math.sqrt(2000000/(drawWidth*drawHeight)));
  l={...l,size:l.size*quality,thickness:(l.thickness||0)*quality,outline:l.outline*quality,blurX:(l.blurX||0)*quality,blurY:(l.blurY||0)*quality};
  const width=Math.max(1,Math.round(drawWidth*quality)),height=Math.max(1,Math.round(drawHeight*quality));
  const warped=glyphInkSurface(ctx,l,char,glyphAngle,width,height);
  const pixels=warped.getContext('2d').getImageData(0,0,width,height).data,source=new Uint8ClampedArray(width*height);
  for(let i=0;i<source.length;i++)source[i]=pixels[i*4+3];
  const thickened=adjustInkThickness(source,width,height,l.thickness);
  const body=distressMask(thickened,width,height,{size:l.size,roughness:l.roughness,dryInk:l.dryInk,seed:inkSeed(char)});
  const texture=textured?printDistressMask(body,width,height,{size:l.size,grungeAmount:l.grungeAmount,scratchLength:l.scratchLength,scratchAngle:l.scratchAngle,spatterAmount:l.spatterAmount,seed:inkSeed(String(l.textureSeed??0)+':'+glyphIndex+':'+char)}):null;
  const texturedBody=texture?.body??body;
  const alpha=distressMask(texturedBody,width,height,{size:l.size,brushTails:l.brushTails,seed:inkSeed(char)});
  if(texture)for(let i=0;i<alpha.length;i++)alpha[i]=Math.max(alpha[i],texture.speckles[i]);
  const edge=dilateMask(texturedBody,width,height,l.outline),fibreEdge=dilateMask(alpha,width,height,Math.min(l.outline,1));
  for(let i=0;i<edge.length;i++)edge[i]=Math.max(edge[i],fibreEdge[i]);
  const foreground=tintedMask(ctx,alpha,width,height,l.color),border=tintedMask(ctx,edge,width,height,outlineColor);
  const result=createSurface(ctx,width,height),out=result.getContext('2d'),hasBlur=l.blurX>0||l.blurY>0;
  if(hasBlur){
    const strength=(l.blurStrength??200)/100;
    if(l.outline>0)out.drawImage(tintedMask(ctx,directionalBlur(edge,width,height,l.blurX,l.blurY),width,height,outlineColor,strength),0,0);
    out.drawImage(tintedMask(ctx,directionalBlur(alpha,width,height,l.blurX,l.blurY),width,height,l.color,strength),0,0);
    out.globalAlpha=(l.inkCore??80)/100;
  }
  const depth=l.size*((l.effect==='impact'||l.effect==='burst')?.13:['none','taper','tension'].includes(l.effect)?0:.05);
  if(depth)out.drawImage(tintedMask(ctx,edge,width,height,'#111111'),depth,depth);
  if(l.outline>0)out.drawImage(border,0,0);out.drawImage(foreground,0,0);
  if(texture){
    // Carve ink defects through keyline and cast shadow, never paint them white.
    out.globalCompositeOperation='destination-out';out.globalAlpha=1;
    out.drawImage(tintedMask(ctx,texture.knockout,width,height,'#000000'),0,0);
    out.globalCompositeOperation='source-over';
  }
  if(l.color===TRANSPARENT){
    out.globalCompositeOperation='destination-out';out.globalAlpha=1;
    out.drawImage(tintedMask(ctx,thickened,width,height,'#000000'),0,0);
    out.globalCompositeOperation='source-over';
  }
  const value={surface:result,drawWidth,drawHeight,width,height};
  if(width*height>5000000){uncachedGlyphs++;return value;}
  storeGlyph(key,value);
  return value;
}
export function glyphFontSize(layer,index) {
  return layer.kind==='sfx'&&layer.effect==='taper'?Math.max(8,layer.size*(1-index*(layer.taperRate??10)/100)):layer.size;
}

// Pack variable-size letters using their own advances; shrinking letters do not leave full-size gaps.
export function textGlyphs(ctx,layer) {
  if(layer.kind==='sfx'&&layer.autoFit)layer=sfxNaturalLayer(layer);
  ctx.save();
  try {
    if(layer.kind==='sfx'&&((layer.kerningMode==='optical'&&layer.kerningStrength>0)||layer.rotationJitter||layer.verticalJitter||layer.spacingJitter||layer.glyphOverlap))return opticalTextGlyphs(ctx,layer,glyphFontSize);
    const sfx=layer.kind==='sfx',sx=sfx?layer.stretchX/100:1,sy=sfx?layer.stretchY/100:1;
    const balloon=layer.kind==='balloon',box=balloon?balloonContentBox(layer):{width:layer.w*.88,height:layer.h*.88};
    let index=0,sourceIndex=0;
    const lines=layer.text.split('\n').map(line=>{const letters=graphemes(line).map(char=>{
      const i=index++,baseSize=glyphFontSize(layer,i),variation=sfx?glyphVariation(layer.glyphSeed??inkSeed(layer.text),i,layer.sizeVariation||0,layer.horizontalJitter||0):{scale:1,shift:0};
      const description=glyphFontDescription(ctx,layer,char);ctx.font=`${description.weight} ${baseSize}px ${description.family}`;
      return {char,sourceIndex:sourceIndex++,index:i,baseSize,size:layer.effect==='taper'&&sfx?Math.max(8,baseSize*variation.scale):baseSize*variation.scale,shift:variation.shift,angle:layer.vertical?verticalRotation(char):0,width:ctx.measureText(char).width*sx};
    });sourceIndex++;return letters;});
    const glyphs=[];
    const topAligned=layer.lineAlign!=='center';
    if(layer.vertical){
      const columns=[];
      for(const line of lines){
        let column=[],height=0;
        for(const glyph of line){const advance=glyph.baseSize*1.12*sy;if(column.length&&height+advance>box.height+.001){columns.push(column);column=[];height=0;}column.push({...glyph,advance});height+=advance;}
        columns.push(column);
      }
      const widths=columns.map(column=>Math.max(column.length?0:glyphFontSize(layer,0),...column.map(glyph=>glyph.baseSize))*1.3*sx);
      let x=widths.reduce((a,b)=>a+b,0)/2;
      columns.forEach((column,i)=>{x-=widths[i]/2;let y=(balloon||columns.length>1)&&topAligned?-box.height/2:-column.reduce((sum,glyph)=>sum+glyph.advance,0)/2;for(const glyph of column){glyphs.push({...glyph,x,y:y+glyph.advance/2});y+=glyph.advance;}x-=widths[i]/2;});
    }else{
      const rows=[];
      for(const line of lines){let row=[],width=0;for(const glyph of line){if(row.length&&width+glyph.width>box.width){rows.push(row);row=[];width=0;}row.push(glyph);width+=glyph.width;}rows.push(row);}
      const heights=rows.map(row=>Math.max(row.length?0:layer.size,...row.map(glyph=>glyph.baseSize))*1.3*sy);
      let y=(balloon||rows.length>1)&&topAligned?-box.height/2:-heights.reduce((a,b)=>a+b,0)/2;
      rows.forEach((row,i)=>{let x=-row.reduce((sum,glyph)=>sum+glyph.width,0)/2;for(const glyph of row){glyphs.push({...glyph,x:x+glyph.width/2,y:y+heights[i]/2});x+=glyph.width;}y+=heights[i];});
    }
    if(balloon)for(const glyph of glyphs){glyph.x+=layer.textOffsetX??0;glyph.y+=layer.textOffsetY??0;}
    return glyphs;
  } finally {ctx.restore();}
}

function paintText(ctx, l) {
  const sfx=l.kind==='sfx';
  ctx.textAlign='center';ctx.textBaseline='middle';ctx.lineJoin='round';
  for(const letter of textGlyphs(ctx,l)){
    const {char,index:i,x,y,size,baseSize,shift,angle}=letter,layer=size===l.size?l:{...l,size};
    const description=glyphFontDescription(ctx,layer,char);ctx.font=`${description.weight} ${size}px ${description.family}`;
    if(!sfx&&!l.thickness){const corner=verticalPunctuationOffset(ctx,char,size,l.vertical);ctx.save();ctx.translate(x,y);ctx.rotate(angle);drawInk(ctx,layer,char,corner.x,corner.y);ctx.restore();continue;}
    const glyph=warpedGlyph(ctx,layer,char,angle,i),image=glyph.surface;
    // Jitter follows the text box's horizontal axis, including rotated vertical punctuation.
    ctx.save();ctx.translate(x+(sfx?shift*baseSize*l.stretchX/100:0),y);
    if(letter.drawScale)ctx.scale(letter.drawScale,letter.drawScale);
    if(sfx&&l.effect==='rumble'){ctx.translate(Math.sin(i*2.3)*l.size*.06,Math.cos(i*1.9)*l.size*.04);ctx.rotate((i%2?1:-1)*.07);}
    const matrix=ctx.getTransform(),pixelScale=Math.min(Math.hypot(matrix.a,matrix.b),Math.hypot(matrix.c,matrix.d));
    ctx.filter=sfx&&l.blur>0?`blur(${l.blur*pixelScale}px)`:'none';
    if(sfx&&l.motionBlur>0){
      const blurAngle=l.blurAngle*Math.PI/180,steps=Math.min(160,Math.max(12,Math.ceil(l.motionBlur/2)));
      for(let step=steps;step>0;step--){const distance=l.motionBlur*step/steps;ctx.globalAlpha=(.2+(1-step/steps)*.8)/Math.sqrt(steps);ctx.drawImage(image,-glyph.drawWidth/2-Math.cos(blurAngle)*distance,-glyph.drawHeight/2-Math.sin(blurAngle)*distance,glyph.drawWidth,glyph.drawHeight);}
    }
    ctx.globalAlpha=1;ctx.drawImage(image,-glyph.drawWidth/2,-glyph.drawHeight/2,glyph.drawWidth,glyph.drawHeight);ctx.restore();
  }
}


function paintSfxStroke(ctx,item,positions,layer,{withoutOutline=false,silhouette=false}={}){
  const s=item.stroke,polygon=item.polygon??strokePolygon(strokeGeometry(s,positions,{vertical:layer.vertical,size:layer.size}),s);
  if(polygon.length<3)return;
  const style=s.lookOverride||{},outline=withoutOutline?0:style.outlineWidth??layer.outline,color=style.fill??layer.color;
  if(silhouette){ctx.save();ctx.beginPath();polygon.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.fillStyle='#ffffff';ctx.fill();ctx.restore();return;}
  const bounds=strokeBounds(polygon),pad=Math.max(outline*3,layer.size*.7*(layer.brushTails||0)/100,(layer.blurX||0)*4,(layer.blurY||0)*4,8),left=Math.floor(bounds.minX-pad),top=Math.floor(bounds.minY-pad),drawWidth=Math.ceil(bounds.maxX-left+pad),drawHeight=Math.ceil(bounds.maxY-top+pad);
  const quality=Math.min(1,Math.sqrt(2000000/(drawWidth*drawHeight))),width=Math.max(1,Math.ceil(drawWidth*quality)),height=Math.max(1,Math.ceil(drawHeight*quality));
  const key='stroke:'+JSON.stringify([s,polygon,...['size','color','outline','textOutlineColor','inkTexture','grungeAmount','scratchLength','scratchAngle','spatterAmount','roughness','dryInk','brushTails','blurX','blurY','blurStrength','inkCore'].map(k=>layer[k]),withoutOutline]);
  let value=glyphCache.get(key);
  if(value)cacheHits++;else cacheMisses++;
  if(!value){
    const canvas=createSurface(ctx,width,height),c=canvas.getContext('2d',{willReadFrequently:true});c.scale(quality,quality);c.translate(-left,-top);c.beginPath();polygon.forEach((p,i)=>i?c.lineTo(p.x,p.y):c.moveTo(p.x,p.y));c.closePath();c.fill();
    const data=c.getImageData(0,0,width,height).data,body=new Uint8ClampedArray(width*height);for(let i=0;i<body.length;i++)body[i]=data[i*4+3];
    const seed=s.inkVariantSeed??layer.lettering.inkSeed,distressed=distressMask(body,width,height,{size:layer.size*quality,roughness:layer.roughness,dryInk:layer.dryInk,brushTails:layer.brushTails,seed});
    const texture=layer.inkTexture==='grunge'?printDistressMask(distressed,width,height,{size:layer.size*quality,grungeAmount:layer.grungeAmount,scratchLength:layer.scratchLength,scratchAngle:layer.scratchAngle,spatterAmount:layer.spatterAmount,seed}):null,alpha=texture?.body??distressed;
    if(texture)for(let i=0;i<alpha.length;i++)alpha[i]=Math.max(alpha[i],texture.speckles[i]);
    c.setTransform(1,0,0,1,0,0);c.clearRect(0,0,width,height);
    if(outline>0)c.drawImage(tintedMask(ctx,dilateMask(body,width,height,Math.min(80,outline*quality)),width,height,style.outlineColor??layer.textOutlineColor??'#ffffff'),0,0);
    if(layer.blurX||layer.blurY)c.drawImage(tintedMask(ctx,directionalBlur(alpha,width,height,layer.blurX*quality,layer.blurY*quality),width,height,color,(layer.blurStrength??200)/100),0,0);
    c.drawImage(tintedMask(ctx,alpha,width,height,color),0,0);
    if(color===TRANSPARENT){c.globalCompositeOperation='destination-out';c.drawImage(tintedMask(ctx,body,width,height,'#000000'),0,0);c.globalCompositeOperation='source-over';}
    value={surface:canvas,width,height};storeGlyph(key,value);
  }
  ctx.save();if(layer.blur>0)ctx.filter=`blur(${layer.blur}px)`;ctx.drawImage(value.surface,left,top,width/quality,height/quality);ctx.restore();
}
function editedGlyphSurface(ctx,layer,item){
  const g=item.glyph,letter=item.letter,style={...layer,size:letter.size,font:g.overrides.font??layer.font,color:g.overrides.fill??layer.color,textOutlineColor:g.overrides.outlineColor??layer.textOutlineColor};
  const key='edited:'+JSON.stringify([letter.char,letter.angle,...['size','font','color','textOutlineColor','outline','stretchX','stretchY','thickness','effect','distortion','skew','warp','roughness','dryInk','brushTails','inkTexture','grungeAmount','spatterAmount','scratchLength','scratchAngle','blurX','blurY','blurStrength','inkCore'].map(k=>style[k]),g.scaleX,g.scaleY,g.shear,g.inkVariantSeed,layer.lettering.outlineScale,g.overrides.outlineWidth]);
  if(glyphCache.has(key)){cacheHits++;return glyphCache.get(key);}cacheMisses++;
  const source=warpedGlyph(ctx,{...style,color:'#ffffff',outline:0,roughness:0,dryInk:0,brushTails:0,inkTexture:'none',blurX:0,blurY:0},letter.char,letter.angle,0);
  const outline=(g.overrides.outlineWidth??layer.outline)*(layer.lettering.outlineScale?Math.min(g.scaleX,g.scaleY):1);
  const pad=Math.max(outline*3,letter.size*.8*(layer.brushTails||0)/100,(layer.blurX||0)*4,(layer.blurY||0)*4,8);
  const drawWidth=Math.ceil(source.drawWidth*g.scaleX+source.drawHeight*Math.abs(g.shear)+pad*2),drawHeight=Math.ceil(source.drawHeight*g.scaleY+pad*2);
  const quality=Math.min(1,Math.sqrt(2000000/(drawWidth*drawHeight))),width=Math.max(1,Math.ceil(drawWidth*quality)),height=Math.max(1,Math.ceil(drawHeight*quality));
  const raw=createSurface(ctx,width,height),r=raw.getContext('2d',{willReadFrequently:true});
  r.translate(width/2,height/2);r.scale(quality,quality);r.transform(g.scaleX,0,g.shear,g.scaleY,0,0);
  r.drawImage(source.surface,-source.drawWidth/2,-source.drawHeight/2,source.drawWidth,source.drawHeight);
  const rgba=r.getImageData(0,0,width,height).data,body=new Uint8ClampedArray(width*height);
  let minX=width,minY=height,maxX=0,maxY=0;
  for(let i=0;i<body.length;i++){body[i]=rgba[i*4+3];if(body[i]>16){const x=i%width,y=Math.floor(i/width);minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}}
  const seed=g.inkVariantSeed,distressed=distressMask(body,width,height,{size:letter.size*quality,roughness:layer.roughness,dryInk:layer.dryInk,brushTails:layer.brushTails,seed});
  const texture=layer.inkTexture==='grunge'?printDistressMask(distressed,width,height,{size:letter.size*quality,grungeAmount:layer.grungeAmount,scratchLength:layer.scratchLength,scratchAngle:layer.scratchAngle,spatterAmount:layer.spatterAmount,seed}):null;
  const alpha=texture?.body??distressed;
  if(texture)for(let i=0;i<alpha.length;i++)alpha[i]=Math.max(alpha[i],texture.speckles[i]);
  const edge=dilateMask(body,width,height,Math.min(80,outline*quality));
  const surface=createSurface(ctx,width,height),out=surface.getContext('2d');
  if(layer.blurX||layer.blurY){out.drawImage(tintedMask(ctx,directionalBlur(alpha,width,height,layer.blurX*quality,layer.blurY*quality),width,height,style.color,(layer.blurStrength??200)/100),0,0);}
  out.drawImage(tintedMask(ctx,alpha,width,height,style.color),0,0);
  const fill=surface,border=tintedMask(ctx,edge,width,height,style.textOutlineColor??'#ffffff');
  if(style.color===TRANSPARENT){const b=border.getContext('2d');b.globalCompositeOperation='destination-out';b.drawImage(tintedMask(ctx,body,width,height,'#000000'),0,0);b.globalCompositeOperation='source-over';}
  const value={surface,fill,border,body,width,height,drawWidth:width/quality,drawHeight:height/quality,quality,outline,
    bounds:{minX:(minX-width/2)/quality,minY:(minY-height/2)/quality,maxX:(maxX-width/2+1)/quality,maxY:(maxY-height/2+1)/quality}};
  storeGlyph(key,value);
  raw.width=raw.height=1;return value;
}
function glyphPivot(item){
  const g=item.glyph,parts=g.pivot.preset.split('-'),size=item.letter.size;
  return g.pivot.preset==='custom'?{x:g.pivot.x,y:g.pivot.y}:{x:parts.includes('left')?-size/2:parts.includes('right')?size/2:0,y:parts.includes('top')?-size/2:parts.includes('bottom')?size/2:0};
}
function itemToLocal(item,p){const pivot=glyphPivot(item),a=item.glyph.rotation*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return {x:item.x+pivot.x+(p.x-pivot.x)*c-(p.y-pivot.y)*s,y:item.y+pivot.y+(p.x-pivot.x)*s+(p.y-pivot.y)*c};}
function localToItem(item,p){const pivot=glyphPivot(item),a=-item.glyph.rotation*Math.PI/180,c=Math.cos(a),s=Math.sin(a),x=p.x-item.x-pivot.x,y=p.y-item.y-pivot.y;return {x:pivot.x+x*c-y*s,y:pivot.y+x*s+y*c};}
function glyphBodyHit(item,point){const p=localToItem(item,point),surface=item.surface,x=Math.floor(p.x*surface.quality+surface.width/2),y=Math.floor(p.y*surface.quality+surface.height/2);return x>=0&&x<surface.width&&y>=0&&y<surface.height&&surface.body[y*surface.width+x]>16;}
function renderSfxGlyph(ctx,layer,item,{withoutOutline=false,silhouette=false}={}){
  const img=item.surface??editedGlyphSurface(ctx,layer,item),pivot=glyphPivot(item);
  ctx.save();ctx.translate(item.x+pivot.x,item.y+pivot.y);ctx.rotate(item.glyph.rotation*Math.PI/180);ctx.translate(-pivot.x,-pivot.y);
  if(!silhouette&&layer.blur>0)ctx.filter=`blur(${layer.blur}px)`;
  if(!silhouette&&layer.motionBlur>0){const a=layer.blurAngle*Math.PI/180,steps=Math.min(80,Math.max(12,Math.ceil(layer.motionBlur/2)));for(let i=steps;i>0;i--){const distance=layer.motionBlur*i/steps;ctx.globalAlpha=(.2+(1-i/steps)*.8)/Math.sqrt(steps);ctx.drawImage(img.fill,-img.drawWidth/2-Math.cos(a)*distance,-img.drawHeight/2-Math.sin(a)*distance,img.drawWidth,img.drawHeight);}}
  ctx.globalAlpha=1;
  if(silhouette)ctx.drawImage(tintedMask(ctx,img.body,img.width,img.height,'#ffffff'),-img.drawWidth/2,-img.drawHeight/2,img.drawWidth,img.drawHeight);
  else{if(!withoutOutline&&img.outline>0)ctx.drawImage(img.border,-img.drawWidth/2,-img.drawHeight/2,img.drawWidth,img.drawHeight);ctx.drawImage(img.fill,-img.drawWidth/2,-img.drawHeight/2,img.drawWidth,img.drawHeight);}
  ctx.restore();
}
function drawSharedSfxContour(ctx,layer,group,ordered,positions){
  const width=Math.ceil(group.styleOverride?.width??layer.outline);
  if(width<=0)return null;
  const memberSet=new Set(group.members);
  const selected=ordered.filter(item=>item.type==='stroke'
    ?Array.from({length:item.stroke.runLength},(_,i)=>item.stroke.runStart+i).some(i=>memberSet.has(i))
    :memberSet.has(item.index));
  if(!selected.length)return null;
  const areas=selected.map(item=>({x:(item.bounds.minX+item.bounds.maxX)/2,y:(item.bounds.minY+item.bounds.maxY)/2,extent:Math.max(item.bounds.maxX-item.bounds.minX,item.bounds.maxY-item.bounds.minY)/2}));
  if(!areas.length)return null;
  let bounds=glyphGroupBounds(areas,Math.ceil(width+layer.blur+layer.motionBlur+5));
  if(!bounds){const minX=Math.floor(Math.min(...areas.map(a=>a.x-a.extent))-width-5),minY=Math.floor(Math.min(...areas.map(a=>a.y-a.extent))-width-5),maxX=Math.ceil(Math.max(...areas.map(a=>a.x+a.extent))+width+5),maxY=Math.ceil(Math.max(...areas.map(a=>a.y+a.extent))+width+5);bounds={minX,minY,width:maxX-minX,height:maxY-minY};}
  const quality=Math.min(1,Math.sqrt(4900000/(bounds.width*bounds.height)),8192/bounds.width,8192/bounds.height),maskWidth=Math.max(1,Math.ceil(bounds.width*quality)),maskHeight=Math.max(1,Math.ceil(bounds.height*quality));
  const mask=createSurface(ctx,maskWidth,maskHeight),m=mask.getContext('2d',{willReadFrequently:true});
  m.scale(quality,quality);m.translate(-bounds.minX,-bounds.minY);
  for(const item of selected){
    if(item.type==='stroke')paintSfxStroke(m,item,positions,layer,{withoutOutline:true,silhouette:true});
    else renderSfxGlyph(m,layer,item,{withoutOutline:true,silhouette:true});
  }
  const data=m.getImageData(0,0,maskWidth,maskHeight).data,alpha=new Uint8ClampedArray(maskWidth*maskHeight);
  for(let i=0;i<alpha.length;i++)alpha[i]=data[i*4+3];
  const outside=unionOuterContour(alpha,maskWidth,maskHeight,Math.min(80,width*quality));
  const color=group.styleOverride?.color??layer.textOutlineColor??'#ffffff';
  ctx.drawImage(tintedMask(ctx,outside,maskWidth,maskHeight,color),bounds.minX,bounds.minY,maskWidth/quality,maskHeight/quality);
  mask.width=mask.height=1;
  return selected;
}
export function sfxScene(ctx,layer){
  const lettering=layer.lettering,box=lettering.baseBox,base=textGlyphs(ctx,box?{...layer,w:box.w,h:box.h}:layer);
  const glyphMap=new Map(lettering.glyphs.map(g=>[g.index,g])),positions=new Map(),items=[];
  for(const sourceLetter of base){const letter={...sourceLetter};
    const index=letter.sourceIndex,glyph=glyphMap.get(index);if(!glyph)continue;
    if(glyph.sizeRatio)letter.size=layer.size*glyph.sizeRatio;
    const random=(lettering.layoutSeed^Math.imul(index+1,2654435761))>>>0,amount=lettering.layoutMode==='overlap'?lettering.overlapIntensity/100:0;
    const x=(glyph.origin?.x??letter.x)+glyph.dx+(letter.shift??0)*letter.baseSize*(layer.stretchX/100),y=(glyph.origin?.y??letter.y)+glyph.dy;
    const item={index,glyph,letter,x:glyph.manual.position?x:x*(1-amount*.4)+(random%17-8)*amount,y:glyph.manual.position?y:y*(1-amount*.4)+((random>>>8)%17-8)*amount,z:glyph.z,type:'glyph',members:[index]};
    if(glyph.orientationOverride==='upright'||glyph.orientationOverride==='tate-chu-yoko')item.letter={...letter,angle:0};
    if(glyph.orientationOverride==='sideways')item.letter={...letter,angle:Math.PI/2};
    item.surface=editedGlyphSurface(ctx,layer,item);
    const b=item.surface.bounds,corners=[{x:b.minX,y:b.minY},{x:b.minX,y:b.maxY},{x:b.maxX,y:b.minY},{x:b.maxX,y:b.maxY}].map(p=>itemToLocal(item,p));
    item.bounds={minX:Math.min(...corners.map(p=>p.x)),maxX:Math.max(...corners.map(p=>p.x)),minY:Math.min(...corners.map(p=>p.y)),maxY:Math.max(...corners.map(p=>p.y))};
    const axis=layer.vertical?'y':'x',cross=layer.vertical?'x':'y',edgeKey=JSON.stringify([axis,glyph.rotation,glyph.pivot]),edges={},cached=item.surface.edgeCache?.get(edgeKey);
    if(cached){for(const side of ['forward','backward'])edges[side]={x:cached[side].x+item.x,y:cached[side].y+item.y};}
    else for(const side of ['forward','backward']){
      let best=null,score=Infinity;const data=item.surface;
      for(let py=0;py<data.height;py+=Math.max(1,Math.floor(data.height/256)))for(let px=0;px<data.width;px+=Math.max(1,Math.floor(data.width/256))){
        if(data.body[py*data.width+px]<128)continue;
        const p=itemToLocal(item,{x:(px-data.width/2)/data.quality,y:(py-data.height/2)/data.quality});
        const value=Math.abs(p[cross]-item[cross])*3+(side==='forward'?-p[axis]:p[axis]);
        if(value<score){score=value;best=p;}
      }
      if(best)edges[side]=best;
    }
    if(!cached&&edges.forward&&edges.backward){item.surface.edgeCache??=new Map();if(item.surface.edgeCache.size>8)item.surface.edgeCache.clear();item.surface.edgeCache.set(edgeKey,Object.fromEntries(Object.entries(edges).map(([side,p])=>[side,{x:p.x-item.x,y:p.y-item.y}])));}
    positions.set(index,{x:item.x,y:item.y,size:letter.size,edges});items.push(item);
  }
  const omitted=new Set();
  for(const s of lettering.strokes)if(s.mode==='continuous')for(let k=0;k<s.runLength;k++)omitted.add(s.runStart+k);
  const ordered=items.filter(g=>!omitted.has(g.index));
  for(const stroke of lettering.strokes.filter(s=>s.mode==='continuous')){
    const polygon=strokePolygon(strokeGeometry(stroke,positions,{vertical:layer.vertical,size:layer.size}),stroke),bounds=strokeBounds(polygon);if(!bounds)continue;
    ordered.push({type:'stroke',index:stroke.runStart,stroke,polygon,bounds,z:glyphMap.get(stroke.runStart)?.z??stroke.runStart,members:Array.from({length:stroke.runLength},(_,i)=>stroke.runStart+i)});
  }
  ordered.sort((a,b)=>a.z-b.z||a.index-b.index);
  return {items:ordered,glyphs:items,positions};
}
export function sfxItemHit(item,point){
  if(item.type==='glyph')return glyphBodyHit(item,point);
  let inside=false;const polygon=item.polygon;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const a=polygon[i],b=polygon[j];if((a.y>point.y)!==(b.y>point.y)&&point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x)inside=!inside;}
  return inside;
}
export function sfxResolvedGroups(scene,lettering){
  return resolveOutlineGroups(scene.items,lettering.outlineGroups,{enabled:lettering.outlineMode==='union',overlaps:(a,b)=>{
    const minX=Math.max(a.bounds.minX,b.bounds.minX),maxX=Math.min(a.bounds.maxX,b.bounds.maxX),minY=Math.max(a.bounds.minY,b.bounds.minY),maxY=Math.min(a.bounds.maxY,b.bounds.maxY);
    const step=Math.max(1,Math.sqrt(Math.max(0,(maxX-minX)*(maxY-minY))/10000));
    for(let y=minY;y<=maxY;y+=step)for(let x=minX;x<=maxX;x+=step)if(sfxItemHit(a,{x,y})&&sfxItemHit(b,{x,y}))return true;
    return false;
  }});
}
export function paintEditedSfx(ctx,layer){
  const scene=sfxScene(ctx,layer),joined=new Set();
  for(const group of sfxResolvedGroups(scene,layer.lettering)){
    const eligible=drawSharedSfxContour(ctx,layer,group,scene.items,scene.positions);
    if(eligible)for(const item of eligible)joined.add(item);
  }
  for(const item of scene.items){if(item.type==='stroke')paintSfxStroke(ctx,item,scene.positions,layer,{withoutOutline:joined.has(item)});else renderSfxGlyph(ctx,layer,item,{withoutOutline:joined.has(item)});}
}

function emptyBounds(){return {minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};}
function includePoint(bounds,x,y){bounds.minX=Math.min(bounds.minX,x);bounds.minY=Math.min(bounds.minY,y);bounds.maxX=Math.max(bounds.maxX,x);bounds.maxY=Math.max(bounds.maxY,y);}
function includeRect(bounds,x,y,width,height,angle=0){
  const c=Math.cos(angle),s=Math.sin(angle);
  for(const dx of [-width/2,width/2])for(const dy of [-height/2,height/2])includePoint(bounds,x+dx*c-dy*s,y+dx*s+dy*c);
}
function includePoints(bounds,points){for(const point of points)includePoint(bounds,point.x,point.y);}
function includeBounds(bounds,other){if(other)includePoint(bounds,other.minX,other.minY),includePoint(bounds,other.maxX,other.maxY);}
function inflateBounds(bounds,padX,padY=padX){if(!Number.isFinite(bounds.minX))return;bounds.minX-=padX;bounds.maxX+=padX;bounds.minY-=padY;bounds.maxY+=padY;}
function captionBorderPad(layer,points){
  const width=layer.borderWidth??0;if(width<=0)return 0;
  if(['brush','dry-brush'].includes(layer.borderStyle))return width*4+3;
  const half=width/2,vertices=points.slice(0,-1);let pad=half;
  for(let i=0;i<vertices.length;i++){
    const previous=vertices[(i+vertices.length-1)%vertices.length],point=vertices[i],next=vertices[(i+1)%vertices.length];
    const ax=point.x-previous.x,ay=point.y-previous.y,bx=next.x-point.x,by=next.y-point.y,al=Math.hypot(ax,ay)||1,bl=Math.hypot(bx,by)||1;
    const turn=Math.acos(clamp((ax*bx+ay*by)/(al*bl),-1,1));
    pad=Math.max(pad,Math.min(half*10,half/Math.max(.0001,Math.cos(turn/2))));
  }
  return pad+2;
}
function rotateBounds(bounds,angle){
  const rotated=emptyBounds(),c=Math.cos(angle),s=Math.sin(angle);
  for(const x of [bounds.minX,bounds.maxX])for(const y of [bounds.minY,bounds.maxY])includePoint(rotated,x*c-y*s,x*s+y*c);
  return rotated;
}
function textMetrics(ctx,layer,glyph){
  const sized=layer.size===glyph.size?layer:{...layer,size:glyph.size};
  const description=glyphFontDescription(ctx,sized,glyph.char);ctx.font=`${description.weight} ${glyph.size}px ${description.family}`;
  ctx.textAlign='center';ctx.textBaseline='middle';
  const metrics=ctx.measureText(glyph.char),width=metrics.width||glyph.size,height=glyph.size;
  return {left:-(metrics.actualBoundingBoxLeft??width/2),right:metrics.actualBoundingBoxRight??width/2,top:-(metrics.actualBoundingBoxAscent??height*.8),bottom:metrics.actualBoundingBoxDescent??height*.2};
}
function includeTextGlyph(bounds,ctx,layer,glyph){
  const metrics=textMetrics(ctx,layer,glyph),corner=verticalPunctuationOffset(ctx,glyph.char,glyph.size,layer.vertical);
  const pad=Math.max(0,layer.outline??0)+Math.max(0,layer.thickness??0),angle=glyph.angle??0,c=Math.cos(angle),s=Math.sin(angle);
  for(const x of [metrics.left-pad,metrics.right+pad])for(const y of [metrics.top-pad,metrics.bottom+pad]){
    const px=corner.x+x,py=corner.y+y;
    includePoint(bounds,glyph.x+px*c-py*s,glyph.y+px*s+py*c);
  }
}
function sfxGlyphEnvelope(layer,glyph){
  const size=glyph.size??layer.size,sx=Math.abs((layer.stretchX??100)/100),sy=Math.abs((layer.stretchY??100)/100),shear=Math.abs(Math.tan((layer.skew??0)*Math.PI/180));
  const tails=size*(layer.brushTails??0)/100*.65;
  const base=size*(2.5*Math.max(sx,sy)+shear*sy)+Math.max(0,layer.outline??0)*6+Math.max(0,layer.thickness??0)*6+tails*2;
  return {width:Math.ceil(base+Math.max(0,layer.blurX??0)*3.5),height:Math.ceil(base+Math.max(0,layer.blurY??0)*3.5)};
}
function includeEditedSfx(bounds,ctx,layer){
  const scene=sfxScene(ctx,layer);
  for(const item of scene.items){
    if(item.type==='stroke')includeBounds(bounds,item.bounds);
    else{
      const width=item.surface.drawWidth,height=item.surface.drawHeight;
      const corners=[{x:-width/2,y:-height/2},{x:-width/2,y:height/2},{x:width/2,y:-height/2},{x:width/2,y:height/2}];
      for(const point of corners){const local=itemToLocal(item,point);includePoint(bounds,local.x,local.y);}
    }
  }
  if(!scene.items.length)return;
  const strokePad=Math.max(0,...layer.lettering.strokes.map(stroke=>Math.max(stroke.lookOverride?.outlineWidth??layer.outline,0)*3));
  const unionWidth=Math.max(layer.outline,...layer.lettering.outlineGroups.map(group=>group.styleOverride?.width??layer.outline));
  const unionPad=layer.lettering.outlineMode==='union'?Math.ceil(unionWidth+layer.blur+layer.motionBlur+5):0;
  const pad=Math.max(strokePad,unionPad,layer.blur*3+layer.motionBlur,layer.blurX*4,layer.blurY*4,layer.size*.8*(layer.brushTails||0)/100,8);
  inflateBounds(bounds,pad);
}

// Fit the painted text, including outlines and trails, independently of the box.
// Keep editable glyph/stroke coordinates in their original space.
function sfxNaturalLayer(layer){
  const extent=Math.max(30,layer.size*(graphemes(layer.text).length+2)*8);
  const box=layer.lettering?.enabled?layer.lettering.baseBox:null;
  return {...layer,autoFit:false,w:box?.w??extent,h:box?.h??extent,
    lineAlign:layer.lettering?.enabled?layer.lineAlign:'center'};
}
function paintSfxText(ctx,layer){
  if(layer.lettering?.enabled)paintEditedSfx(ctx,layer);else paintText(ctx,layer);
}
export function sfxAutoFitTransform(ctx,layer){
  const identity={scaleX:1,scaleY:1,x:0,y:0};
  if(layer.kind!=='sfx'||!layer.autoFit||!layer.text.trim())return identity;
  const natural=sfxNaturalLayer(layer),key=JSON.stringify({...natural,id:null,x:0,y:0,rotation:0,presetId:null,layoutOrder:0});
  let bounds=sfxFitCache.get(key);
  if(!bounds){
    const area=layerBounds(ctx,{...natural,rotation:0},{includeBox:false}),width=Math.ceil(area.maxX-area.minX),height=Math.ceil(area.maxY-area.minY);
    if(!(width>0&&height>0))return identity;
    const quality=Math.min(1,Math.sqrt(1000000/(width*height)),4096/width,4096/height);
    const canvas=createSurface(ctx,Math.max(1,Math.ceil(width*quality)),Math.max(1,Math.ceil(height*quality))),c=canvas.getContext('2d',{willReadFrequently:true});
    c.scale(quality,quality);c.translate(-area.minX,-area.minY);paintSfxText(c,natural);
    const pixels=c.getImageData(0,0,canvas.width,canvas.height).data;
    let minX=canvas.width,minY=canvas.height,maxX=-1,maxY=-1;
    for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++)if(pixels[(y*canvas.width+x)*4+3]){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
    canvas.width=canvas.height=1;
    bounds=maxX<minX?null:{minX:area.minX+minX/quality,minY:area.minY+minY/quality,maxX:area.minX+(maxX+1)/quality,maxY:area.minY+(maxY+1)/quality};
    if(!bounds)return identity;
    if(sfxFitCache.size>=32)sfxFitCache.delete(sfxFitCache.keys().next().value);
    sfxFitCache.set(key,bounds);
  }
  const scaleX=layer.w/(bounds.maxX-bounds.minX),scaleY=layer.h/(bounds.maxY-bounds.minY);
  return {scaleX,scaleY,x:-(bounds.minX+bounds.maxX)/2*scaleX,y:-(bounds.minY+bounds.maxY)/2*scaleY};
}
export function sfxTextPoint(ctx,layer,x,y){
  const point=localPoint(layer,x,y),fit=sfxAutoFitTransform(ctx,layer);
  return {x:(point.x-fit.x)/fit.scaleX,y:(point.y-fit.y)/fit.scaleY};
}

// Returns painted content bounds relative to the layer origin, after its rotation.
// Selection handles stay out of this measurement; the selection box itself remains included.
export function layerBounds(ctx,layer,{includeBox=true}={}){
  ctx.save();
  try{
    const bounds=emptyBounds();
    if(includeBox)includeRect(bounds,0,0,layer.w,layer.h);
    if(layer.kind==='sfx'&&layer.autoFit){
      includeRect(bounds,0,0,layer.w,layer.h);
    }else if(layer.kind==='balloon'){
      const outline=balloonOutline(layer);includePoints(bounds,outline);
      const borderPad=layer.borderStyle==='brush'||layer.borderStyle==='dry-brush'?(layer.borderWidth??0)*4+3:(layer.borderWidth??0)/2+2;
      inflateBounds(bounds,borderPad);
      if(layer.shadowEnabled){
        const shadow=emptyBounds();includePoints(shadow,outline.map(p=>({x:p.x+(layer.shadowOffsetX??0),y:p.y+(layer.shadowOffsetY??0)})));
        inflateBounds(shadow,Math.max(1,(layer.shadowBlur??0)*3));includeBounds(bounds,shadow);
      }
      if(layer.text)for(const glyph of textGlyphs(ctx,layer))includeTextGlyph(bounds,ctx,layer,glyph);
    }else if(layer.kind==='caption'){
      const outline=captionOutline(layer);includePoints(bounds,outline);
      inflateBounds(bounds,captionBorderPad(layer,outline));
    }else if(layer.kind==='sfx'&&layer.lettering?.enabled){
      includeEditedSfx(bounds,ctx,layer);
    }else{
      const glyphs=textGlyphs(ctx,layer);
      if(layer.kind==='sfx'){
        const filterPad=(layer.motionBlur??0)+Math.max(0,layer.blur??0)*3;
        for(const glyph of glyphs){
          const envelope=sfxGlyphEnvelope(layer,glyph),shift=(glyph.shift??0)*glyph.baseSize*(layer.stretchX/100),rumble=layer.effect==='rumble';
          const x=glyph.x+shift+(rumble?Math.sin(glyph.index*2.3)*layer.size*.06:0),y=glyph.y+(rumble?Math.cos(glyph.index*1.9)*layer.size*.04:0);
          const angle=(glyph.angle??0)+(rumble?(glyph.index%2?1:-1)*.07:0),scale=glyph.drawScale??1;
          includeRect(bounds,x,y,envelope.width*scale+filterPad*2,envelope.height*scale+filterPad*2,angle);
        }
      }else{
        for(const glyph of glyphs)includeTextGlyph(bounds,ctx,layer,glyph);
      }
    }
    if(layer.kind==='sfx'&&['burst','speed','rumble'].includes(layer.effect))inflateBounds(bounds,Math.max(2,layer.size*.07));
    return rotateBounds(bounds,(layer.rotation??0)*Math.PI/180);
  }finally{
    ctx.restore();
  }
}

function hasMaskWork(options) {
  return (options?.maskEffects?.some(effect => effect.visible !== false) ?? false)
    || (options?.draft?.candidates?.some(candidate => candidate?.selected && candidate.mask) ?? false);
}

function maskCompositeCanvas(img, width, height, options) {
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const sourceContext = canvas.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) throw new Error('マスク加工Canvasを作成できない');
  sourceContext.drawImage(img, 0, 0, width, height);
  const source = sourceContext.getImageData(0, 0, width, height);
  const pixels = applyMaskEffectsToImageData(source, width, height, options.maskEffects ?? [], options.maskAssets ?? {}, { draft: options.draft ?? null });
  const rendered=sourceContext.createImageData(width,height);rendered.data.set(pixels);sourceContext.putImageData(rendered,0,0);
  return {canvas,source};
}

function paintMaskPatch(ctx,source,width,height,effect,assets) {
  const patch=maskEffectPatch(source,width,height,effect,assets[effect.assetId]);if(!patch)return;
  const canvas=createSurface(ctx,patch.width,patch.height),surface=canvas.getContext('2d');
  const coverage=surface.createImageData(patch.width,patch.height);
  for(let index=0;index<patch.mask.length;index++)coverage.data[index*4+3]=patch.mask[index]?255:0;
  surface.putImageData(coverage,0,0);
  ctx.save();ctx.globalCompositeOperation='destination-out';ctx.drawImage(canvas,patch.x,patch.y);ctx.restore();
  coverage.data.set(patch.pixels);surface.putImageData(coverage,0,0);
  ctx.drawImage(canvas,patch.x,patch.y);canvas.width=canvas.height=1;
}

export function draw(ctx, img, layers, selected = null, scale = 1, selectionScale = scale, imageEdit = null, originalSize = null, options = {}) {
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.scale(scale, scale);
  if (imageEdit) ctx.transform(...imageMatrix(originalSize?.width ?? img.width, originalSize?.height ?? img.height, imageEdit));
  const imageWidth = originalSize?.width ?? img.width, imageHeight = originalSize?.height ?? img.height;
  const ordered=paintOrder(layers,options.maskEffects??[]),firstText=ordered.findIndex(object=>object.kind!=='mask-effect');
  const leading=firstText<0?ordered:ordered.slice(0,firstText),baseOptions={...options,maskEffects:leading};
  let source;
  if (hasMaskWork(baseOptions)) {
    const composite = maskCompositeCanvas(img, imageWidth, imageHeight, baseOptions);
    ctx.drawImage(composite.canvas, 0, 0, imageWidth, imageHeight);source=composite.source;
    composite.canvas.width = composite.canvas.height = 1;
  } else if (originalSize) ctx.drawImage(img, 0, 0, originalSize.width, originalSize.height);
  else ctx.drawImage(img, 0, 0);
  for (const l of firstText<0?[]:ordered.slice(firstText)) {
    if(l.kind==='mask-effect'){
      if(l.visible===false)continue;
      if(!source){const canvas=createSurface(ctx,imageWidth,imageHeight),surface=canvas.getContext('2d');surface.drawImage(img,0,0,imageWidth,imageHeight);source=surface.getImageData(0,0,imageWidth,imageHeight);canvas.width=canvas.height=1;}
      paintMaskPatch(ctx,source,imageWidth,imageHeight,l,options.maskAssets??{});continue;
    }
    ctx.save(); ctx.translate(l.x, l.y); ctx.rotate(l.rotation * Math.PI / 180);
    if(l.kind==='balloon'){
      paintBalloon(ctx,l);
      if(l.text)paintText(ctx,l);
    }
    else if(l.kind==='caption')paintCaption(ctx,l);
    else {
      ornament(ctx,l);
      if(l.kind==='sfx'&&l.autoFit){
        const fit=sfxAutoFitTransform(ctx,l);ctx.translate(fit.x,fit.y);ctx.scale(fit.scaleX,fit.scaleY);paintSfxText(ctx,sfxNaturalLayer(l));
      }else if(l.kind==='sfx'&&l.lettering?.enabled)paintEditedSfx(ctx,l);else paintText(ctx,l);
    }
    ctx.restore();
  }
  const ids = Array.isArray(selected) ? selected : [selected];
  for(const l of layers.filter(layer => ids.includes(layer.id))){
      ctx.save();ctx.translate(l.x,l.y);ctx.rotate(l.rotation*Math.PI/180);
      ctx.strokeStyle = '#b2dd78'; ctx.fillStyle = '#c8ee91'; ctx.lineWidth = 1.5 / selectionScale;
      ctx.setLineDash([5 / selectionScale, 4 / selectionScale]); ctx.strokeRect(-l.w / 2, -l.h / 2, l.w, l.h); ctx.setLineDash([]);
      if (l.id !== ids[0]) { ctx.restore(); continue; }
      ctx.beginPath(); ctx.moveTo(0, -l.h / 2); ctx.lineTo(0, -l.h / 2 - 24 / selectionScale); ctx.stroke();
      ctx.fillRect(l.w / 2 - 5 / selectionScale, l.h / 2 - 5 / selectionScale, 10 / selectionScale, 10 / selectionScale);
      ctx.beginPath(); ctx.arc(0, -l.h / 2 - 24 / selectionScale, 5 / selectionScale, 0, Math.PI * 2); ctx.fill();
      if(l.kind==='balloon'&&l.tail){ctx.fillStyle='#80d7ee';ctx.beginPath();ctx.arc(l.tailX,l.tailY,6/selectionScale,0,Math.PI*2);ctx.fill();}
      ctx.restore();
  }
  const mask = options?.maskSelection;
  if (mask && [mask.x, mask.y, mask.w, mask.h].every(Number.isFinite) && mask.w > 0 && mask.h > 0) {
    const x = mask.x, y = mask.y, w = mask.w, h = mask.h, handle = 9 / selectionScale;
    ctx.save(); ctx.strokeStyle = '#66e0c2'; ctx.fillStyle = '#9af0d9'; ctx.lineWidth = 1.5 / selectionScale;
    ctx.setLineDash([5 / selectionScale, 4 / selectionScale]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
    for (const [hx, hy] of [[x,y],[x+w/2,y],[x+w,y],[x+w,y+h/2],[x+w,y+h],[x+w/2,y+h],[x,y+h],[x,y+h/2]]) {
      ctx.fillRect(hx - handle / 2, hy - handle / 2, handle, handle);
    }
    ctx.restore();
  }
  ctx.restore();
}

export function exportName(name, index) {
  return `${String(index + 1).padStart(3, '0')}_${name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.png`;
}
