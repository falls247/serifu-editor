import { inkSeed, distressMask, printDistressMask, directionalBlur, dilateMask, adjustInkThickness, glyphVariation } from './ink.js';
import { fontDescription } from './fonts.js';
import { newBalloon, balloonHit, paintBalloon, clipBalloon, paintOrder } from './balloons.js';
import { newCaption, paintCaption } from './captions.js';
import { graphemes, verticalRotation, verticalPunctuationOffset } from './typography.js';
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
    id, kind, speaker,
    text: kind === 'sfx' ? 'ドーン！' : '',
    lineAlign:'top',
    x: width * .5, y: height * .4,
    w: clamp(width * (kind === 'sfx' ? .34 : .28), 30, 30000), h: clamp(height * (kind === 'sfx' ? .75 : .62), 30, 30000),
    size: clamp(Math.round(width * (kind === 'sfx' ? .09 : .055)), 16, 500),
    rotation: kind === 'sfx' ? -12 : 0, thickness:0, outline: clamp(Math.round(width * .006), 2, 80),
    vertical: true, color: '#111111', effect: 'burst', taperRate:10,
    ...(kind==='dialogue'?{textColor:null,textOutlineColor:'#ffffff'}:{}),
    font: kind === 'sfx' ? 'comic' : 'sans', blur: 0, motionBlur: 0, blurAngle: 90,
    distortion: kind === 'sfx' ? 25 : 0, warp: 'taper', skew: kind === 'sfx' ? -10 : 0, stretchX: 100, stretchY: 100, presetId: null,
    blurX: 0, blurY: 0, blurStrength: 200, inkCore: 80,
    roughness: kind === 'sfx' ? 18 : 0, dryInk: kind === 'sfx' ? 22 : 0, brushTails: kind === 'sfx' ? 25 : 0,
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
let cachePixels = 0;
export function clearGlyphCache() { glyphCache.clear(); cachePixels = 0; }
function createSurface(ctx, width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = width; c.height = height; return c; }
  return new ctx.canvas.constructor(width, height);
}
function fontFamily(l) {
  return fontDescription(l).family;
}
function drawInk(ctx, l, char, x, y) {
  if (l.kind === 'sfx' && !['none','taper','tension'].includes(l.effect)) {
    const depth = l.size * (l.effect === 'impact' || l.effect === 'burst' ? .13 : .05);
    ctx.strokeStyle = '#111111'; ctx.fillStyle = '#111111'; ctx.lineWidth = l.outline * 2 + l.size * .05;
    ctx.strokeText(char, x + depth, y + depth); ctx.fillText(char, x + depth, y + depth);
  }
  if(l.outline>0){ctx.strokeStyle=l.textOutlineColor??'#ffffff';ctx.lineWidth=l.outline*2;ctx.strokeText(char,x,y);}
  ctx.fillStyle = l.kind === 'sfx' ? l.color : dialogueColor(l); ctx.fillText(char, x, y);
}
function tintedMask(ctx, alpha, width, height, color, strength=1) {
  const surface=createSurface(ctx,width,height),c=surface.getContext('2d'),pixels=c.createImageData(width,height);
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
  if (glyphCache.has(key)) { const value = glyphCache.get(key); glyphCache.delete(key); glyphCache.set(key,value); return value; }
  const sx=l.stretchX/100,sy=l.stretchY/100,shear=Math.tan(l.skew*Math.PI/180);
  const reach=l.size*(l.brushTails||0)/100*.65;
  const base=l.size*(2.5*Math.max(sx,sy)+Math.abs(shear)*sy)+l.outline*6+Math.max(0,l.thickness||0)*6+reach*2;
  const drawWidth=Math.ceil(base+(l.blurX||0)*3.5),drawHeight=Math.ceil(base+(l.blurY||0)*3.5);
  // Bound intermediate allocations at extreme font/blur/stretch settings.
  const quality=Math.min(1,Math.sqrt(2000000/(drawWidth*drawHeight)));
  l={...l,size:l.size*quality,thickness:(l.thickness||0)*quality,outline:l.outline*quality,blurX:(l.blurX||0)*quality,blurY:(l.blurY||0)*quality};
  const width=Math.max(1,Math.round(drawWidth*quality)),height=Math.max(1,Math.round(drawHeight*quality));
  const ink = createSurface(ctx, width, height), c = ink.getContext('2d');
  c.font = `${fontDescription(l).weight} ${l.size}px ${fontFamily(l)}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
  const corner=verticalPunctuationOffset(c,char,l.size,l.vertical);
  c.translate(width/2,height/2);c.transform(1,0,shear,1,0,0);c.scale(sx,sy);c.rotate(glyphAngle);c.fillStyle='#ffffff';c.fillText(char,corner.x,corner.y);c.setTransform(1,0,0,1,0,0);
  let warped = ink;
  if (l.distortion > 0) {
    warped = createSurface(ctx, width, height); const out = warped.getContext('2d'), amount = l.distortion / 100;
    for (let y = 0; y < height; y += 2) {
      const t = clamp((y-height/2)/(l.size*.8),-1,1), slice = Math.min(2,height-y);
      let offset=0, stretch=1;
      if (l.warp === 'wave') offset = Math.sin(t*Math.PI*2) * l.size * .2 * amount;
      if (l.warp === 'bulge') stretch = 1 + (1-t*t) * .6 * amount;
      if (l.warp === 'taper') { stretch = 1 + t * .5 * amount; offset = t * l.size * .06 * amount; }
      out.drawImage(ink,0,y,width,slice,(width-width*stretch)/2+offset,y,width*stretch,slice);
    }
  }
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
  const value={surface:result,drawWidth,drawHeight,width,height};
  if(width*height>5000000)return value;
  glyphCache.set(key,value); cachePixels += width*height;
  while (cachePixels > 5000000 && glyphCache.size > 1) { const first= glyphCache.keys().next().value, old=glyphCache.get(first); cachePixels-=old.width*old.height; glyphCache.delete(first); }
  return value;
}
export function glyphFontSize(layer,index) {
  return layer.kind==='sfx'&&layer.effect==='taper'?Math.max(8,layer.size*(1-index*(layer.taperRate??10)/100)):layer.size;
}

// Pack variable-size letters using their own advances; shrinking letters do not leave full-size gaps.
export function textGlyphs(ctx,layer) {
  ctx.save();
  try {
    const sfx=layer.kind==='sfx',sx=sfx?layer.stretchX/100:1,sy=sfx?layer.stretchY/100:1,description=fontDescription(layer);
    let index=0;
    const lines=layer.text.split('\n').map(line=>graphemes(line).map(char=>{
      const i=index++,baseSize=glyphFontSize(layer,i),variation=sfx?glyphVariation(layer.glyphSeed??inkSeed(layer.text),i,layer.sizeVariation||0,layer.horizontalJitter||0):{scale:1,shift:0};
      ctx.font=`${description.weight} ${baseSize}px ${description.family}`;
      return {char,index:i,baseSize,size:layer.effect==='taper'&&sfx?Math.max(8,baseSize*variation.scale):baseSize*variation.scale,shift:variation.shift,angle:layer.vertical?verticalRotation(char):0,width:ctx.measureText(char).width*sx};
    }));
    const glyphs=[];
    const topAligned=layer.lineAlign!=='center';
    if(layer.vertical){
      const columns=[];
      for(const line of lines){
        let column=[],height=0;
        for(const glyph of line){const advance=glyph.baseSize*1.12*sy;if(column.length&&height+advance>layer.h*.88+.001){columns.push(column);column=[];height=0;}column.push({...glyph,advance});height+=advance;}
        columns.push(column);
      }
      const widths=columns.map(column=>Math.max(column.length?0:glyphFontSize(layer,0),...column.map(glyph=>glyph.baseSize))*1.3*sx);
      let x=widths.reduce((a,b)=>a+b,0)/2;
      columns.forEach((column,i)=>{x-=widths[i]/2;let y=columns.length>1&&topAligned?-layer.h*.44:-column.reduce((sum,glyph)=>sum+glyph.advance,0)/2;for(const glyph of column){glyphs.push({...glyph,x,y:y+glyph.advance/2});y+=glyph.advance;}x-=widths[i]/2;});
    }else{
      const rows=[];
      for(const line of lines){let row=[],width=0;for(const glyph of line){if(row.length&&width+glyph.width>layer.w*.88){rows.push(row);row=[];width=0;}row.push(glyph);width+=glyph.width;}rows.push(row);}
      const heights=rows.map(row=>Math.max(row.length?0:layer.size,...row.map(glyph=>glyph.baseSize))*1.3*sy);
      let y=rows.length>1&&topAligned?-layer.h*.44:-heights.reduce((a,b)=>a+b,0)/2;
      rows.forEach((row,i)=>{let x=-row.reduce((sum,glyph)=>sum+glyph.width,0)/2;for(const glyph of row){glyphs.push({...glyph,x:x+glyph.width/2,y:y+heights[i]/2});x+=glyph.width;}y+=heights[i];});
    }
    return glyphs;
  } finally {ctx.restore();}
}

function paintText(ctx, l) {
  const sfx=l.kind==='sfx';
  ctx.textAlign='center';ctx.textBaseline='middle';ctx.lineJoin='round';
  for(const letter of textGlyphs(ctx,l)){
    const {char,index:i,x,y,size,baseSize,shift,angle}=letter,layer=size===l.size?l:{...l,size};
    ctx.font=`${fontDescription(layer).weight} ${size}px ${fontFamily(layer)}`;
    if(!sfx&&!l.thickness){const corner=verticalPunctuationOffset(ctx,char,size,l.vertical);ctx.save();ctx.translate(x,y);ctx.rotate(angle);drawInk(ctx,layer,char,corner.x,corner.y);ctx.restore();continue;}
    const glyph=warpedGlyph(ctx,layer,char,angle,i),image=glyph.surface;
    // Jitter follows the text box's horizontal axis, including rotated vertical punctuation.
    ctx.save();ctx.translate(x+(sfx?shift*baseSize*l.stretchX/100:0),y);
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

export function draw(ctx, img, layers, selected = null, scale = 1, selectionScale = scale) {
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.scale(scale, scale); ctx.drawImage(img, 0, 0);
  for (const l of paintOrder(layers)) {
    ctx.save(); ctx.translate(l.x, l.y); ctx.rotate(l.rotation * Math.PI / 180);
    if(l.kind==='balloon'){
      paintBalloon(ctx,l);
      if(l.text){ctx.save();clipBalloon(ctx,l);paintText(ctx,{...l,w:l.w*(l.shape==='spiky'?.70:.84),h:l.h*(l.shape==='spiky'?.70:.84)});ctx.restore();}
    }
    else if(l.kind==='caption')paintCaption(ctx,l);
    else {ornament(ctx, l); paintText(ctx, l);}
    ctx.restore();
  }
  const l=layers.find(layer=>layer.id===selected);
  if(l){
      ctx.save();ctx.translate(l.x,l.y);ctx.rotate(l.rotation*Math.PI/180);
      ctx.strokeStyle = '#b2dd78'; ctx.fillStyle = '#c8ee91'; ctx.lineWidth = 1.5 / selectionScale;
      ctx.setLineDash([5 / selectionScale, 4 / selectionScale]); ctx.strokeRect(-l.w / 2, -l.h / 2, l.w, l.h); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(0, -l.h / 2); ctx.lineTo(0, -l.h / 2 - 24 / selectionScale); ctx.stroke();
      ctx.fillRect(l.w / 2 - 5 / selectionScale, l.h / 2 - 5 / selectionScale, 10 / selectionScale, 10 / selectionScale);
      ctx.beginPath(); ctx.arc(0, -l.h / 2 - 24 / selectionScale, 5 / selectionScale, 0, Math.PI * 2); ctx.fill();
      if(l.kind==='balloon'&&l.tail){ctx.fillStyle='#80d7ee';ctx.beginPath();ctx.arc(l.tailX,l.tailY,6/selectionScale,0,Math.PI*2);ctx.fill();}
      ctx.restore();
  }
  ctx.restore();
}

export function exportName(name, index) {
  return `${String(index + 1).padStart(3, '0')}_${name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.png`;
}
