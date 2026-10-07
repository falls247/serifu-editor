import { inkSeed, distressMask, directionalBlur, dilateMask } from './ink.js';
import { fontDescription } from './fonts.js';
export { FONT_CHOICES } from './fonts.js';
export const DIALOGUE_COLORS = Object.freeze({ male: '#111111', female: '#ef4b91' });
export const EFFECTS = Object.freeze({ impact: 'ドン！／立体', burst: 'バン！／集中線', speed: 'シュッ／スピード', rumble: 'ゴゴゴ／震え', tension: 'ゾワッ／感情・緊張' });
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function newLayer(kind, width, height, speaker = 'male') {
  return {
    id: crypto.randomUUID(), kind, speaker,
    text: kind === 'sfx' ? 'ドーン！' : '',
    x: width * .5, y: height * .4,
    w: clamp(width * (kind === 'sfx' ? .34 : .36), 30, 30000), h: clamp(height * (kind === 'sfx' ? .75 : .46), 30, 30000),
    size: clamp(Math.round(width * (kind === 'sfx' ? .09 : .04)), 16, 500),
    rotation: kind === 'sfx' ? -12 : 0, outline: clamp(Math.round(width * .006), 2, 80),
    vertical: true, color: '#111111', effect: 'burst',
    font: kind === 'sfx' ? 'comic' : 'sans', blur: 0, motionBlur: 0, blurAngle: 90,
    distortion: kind === 'sfx' ? 25 : 0, warp: 'taper', skew: kind === 'sfx' ? -10 : 0, stretchX: 100, stretchY: 100, presetId: null,
    blurX: 0, blurY: 0, blurStrength: 200, inkCore: 80,
    roughness: kind === 'sfx' ? 18 : 0, dryInk: kind === 'sfx' ? 22 : 0, brushTails: kind === 'sfx' ? 25 : 0,
  };
}

export function localPoint(layer, x, y) {
  const angle = -layer.rotation * Math.PI / 180;
  const dx = x - layer.x, dy = y - layer.y;
  return { x: dx * Math.cos(angle) - dy * Math.sin(angle), y: dx * Math.sin(angle) + dy * Math.cos(angle) };
}

export function hit(layer, x, y) {
  const p = localPoint(layer, x, y);
  return Math.abs(p.x) <= layer.w / 2 && Math.abs(p.y) <= layer.h / 2;
}

export function handleAt(layer, x, y, scale = 1) {
  const p = localPoint(layer, x, y), radius = 12 / scale;
  if (Math.hypot(p.x - layer.w / 2, p.y - layer.h / 2) <= radius) return 'resize';
  if (Math.hypot(p.x, p.y + layer.h / 2 + 24 / scale) <= radius) return 'rotate';
  return null;
}

function textRows(ctx, text, maxWidth) {
  const rows = [];
  for (const line of text.split('\n')) {
    let row = '';
    for (const char of line) {
      if (row && ctx.measureText(row + char).width > maxWidth) { rows.push(row); row = ''; }
      row += char;
    }
    rows.push(row);
  }
  return rows;
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
  if (l.kind === 'sfx') {
    const depth = l.size * (l.effect === 'impact' || l.effect === 'burst' ? .13 : .05);
    ctx.strokeStyle = '#111111'; ctx.fillStyle = '#111111'; ctx.lineWidth = l.outline * 2 + l.size * .05;
    ctx.strokeText(char, x + depth, y + depth); ctx.fillText(char, x + depth, y + depth);
  }
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = l.outline * 2; ctx.strokeText(char, x, y);
  ctx.fillStyle = l.kind === 'sfx' ? l.color : DIALOGUE_COLORS[l.speaker]; ctx.fillText(char, x, y);
}
function tintedMask(ctx, alpha, width, height, color, strength=1) {
  const surface=createSurface(ctx,width,height),c=surface.getContext('2d'),pixels=c.createImageData(width,height);
  const rgb=[1,3,5].map(start=>parseInt(color.slice(start,start+2),16));
  for(let i=0;i<alpha.length;i++){pixels.data[i*4]=rgb[0];pixels.data[i*4+1]=rgb[1];pixels.data[i*4+2]=rgb[2];pixels.data[i*4+3]=Math.min(255,alpha[i]*strength);}
  c.putImageData(pixels,0,0);return surface;
}
function warpedGlyph(ctx, l, char, glyphAngle=0) {
  const key = [char,glyphAngle,l.size,l.outline,l.color,l.effect,l.font,l.distortion,l.warp,l.skew,l.stretchX,l.stretchY,l.roughness,l.dryInk,l.brushTails,l.blurX,l.blurY,l.blurStrength,l.inkCore].join('|');
  if (glyphCache.has(key)) { const value = glyphCache.get(key); glyphCache.delete(key); glyphCache.set(key,value); return value; }
  const sx=l.stretchX/100,sy=l.stretchY/100,shear=Math.tan(l.skew*Math.PI/180);
  const reach=l.size*(l.brushTails||0)/100*.65;
  const base=l.size*(2.5*Math.max(sx,sy)+Math.abs(shear)*sy)+l.outline*6+reach*2;
  const drawWidth=Math.ceil(base+(l.blurX||0)*3.5),drawHeight=Math.ceil(base+(l.blurY||0)*3.5);
  // Bound intermediate allocations at extreme font/blur/stretch settings.
  const quality=Math.min(1,Math.sqrt(2000000/(drawWidth*drawHeight)));
  l={...l,size:l.size*quality,outline:l.outline*quality,blurX:(l.blurX||0)*quality,blurY:(l.blurY||0)*quality};
  const width=Math.max(1,Math.round(drawWidth*quality)),height=Math.max(1,Math.round(drawHeight*quality));
  const ink = createSurface(ctx, width, height), c = ink.getContext('2d');
  c.font = `${fontDescription(l).weight} ${l.size}px ${fontFamily(l)}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
  c.translate(width/2,height/2);c.transform(1,0,shear,1,0,0);c.scale(sx,sy);c.rotate(glyphAngle);c.fillStyle='#ffffff';c.fillText(char,0,0);c.setTransform(1,0,0,1,0,0);
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
  const body=distressMask(source,width,height,{size:l.size,roughness:l.roughness,dryInk:l.dryInk,seed:inkSeed(char)});
  const alpha=distressMask(body,width,height,{size:l.size,brushTails:l.brushTails,seed:inkSeed(char)});
  const edge=dilateMask(body,width,height,l.outline),fibreEdge=dilateMask(alpha,width,height,Math.min(l.outline,1));
  for(let i=0;i<edge.length;i++)edge[i]=Math.max(edge[i],fibreEdge[i]);
  const foreground=tintedMask(ctx,alpha,width,height,l.color),border=tintedMask(ctx,edge,width,height,'#ffffff');
  const result=createSurface(ctx,width,height),out=result.getContext('2d'),hasBlur=l.blurX>0||l.blurY>0;
  if(hasBlur){
    const strength=(l.blurStrength??200)/100;
    out.drawImage(tintedMask(ctx,directionalBlur(edge,width,height,l.blurX,l.blurY),width,height,'#ffffff',strength),0,0);
    out.drawImage(tintedMask(ctx,directionalBlur(alpha,width,height,l.blurX,l.blurY),width,height,l.color,strength),0,0);
    out.globalAlpha=(l.inkCore??80)/100;
  }
  const depth=l.size*((l.effect==='impact'||l.effect==='burst')?.13:l.effect==='tension'?0:.05);
  if(depth)out.drawImage(tintedMask(ctx,edge,width,height,'#111111'),depth,depth);
  out.drawImage(border,0,0);out.drawImage(foreground,0,0);
  const value={surface:result,drawWidth,drawHeight,width,height};
  glyphCache.set(key,value); cachePixels += width*height;
  while (cachePixels > 5000000 && glyphCache.size > 1) { const first= glyphCache.keys().next().value, old=glyphCache.get(first); cachePixels-=old.width*old.height; glyphCache.delete(first); }
  return value;
}
function paintText(ctx, l) {
  const sfx = l.kind === 'sfx';
  ctx.font = `${fontDescription(l).weight} ${l.size}px ${fontFamily(l)}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  let sequence=0;
  const paint = (char,x,y,glyphAngle=0) => {
    if (!sfx) {ctx.save();ctx.translate(x,y);ctx.rotate(glyphAngle);drawInk(ctx,l,char,0,0);ctx.restore();return;}
    const i=sequence++, glyph=warpedGlyph(ctx,l,char,glyphAngle),image=glyph.surface;
    ctx.save(); ctx.translate(x,y);
    if (l.effect === 'rumble') { ctx.translate(Math.sin(i*2.3)*l.size*.06,Math.cos(i*1.9)*l.size*.04); ctx.rotate((i%2?1:-1)*.07); }
    const matrix=ctx.getTransform(), pixelScale=Math.min(Math.hypot(matrix.a,matrix.b),Math.hypot(matrix.c,matrix.d));
    ctx.filter=l.blur>0 ? `blur(${l.blur*pixelScale}px)` : 'none';
    if (l.motionBlur>0) {
      const angle=l.blurAngle*Math.PI/180;
      const steps=Math.min(160,Math.max(12,Math.ceil(l.motionBlur/2)));
      for (let step=steps;step>0;step--) { const distance=l.motionBlur*step/steps; ctx.globalAlpha=(.2+(1-step/steps)*.8)/Math.sqrt(steps); ctx.drawImage(image,-glyph.drawWidth/2-Math.cos(angle)*distance,-glyph.drawHeight/2-Math.sin(angle)*distance,glyph.drawWidth,glyph.drawHeight); }
    }
    ctx.globalAlpha=1; ctx.drawImage(image,-glyph.drawWidth/2,-glyph.drawHeight/2,glyph.drawWidth,glyph.drawHeight); ctx.restore();
  };
  if (l.vertical) {
    const columns=[], advance=l.size*1.12*(sfx?l.stretchY/100:1), count=Math.max(1,Math.floor(l.h*.88/advance));
    for (const line of l.text.split('\n')) { const chars=Array.from(line); if(!chars.length)columns.push([]); for(let i=0;i<chars.length;i+=count)columns.push(chars.slice(i,i+count)); }
    const columnWidth=l.size*1.3*(sfx?l.stretchX/100:1);
    columns.forEach((col,i)=>col.forEach((char,j)=>{
      ctx.save(); ctx.translate(((columns.length-1)/2-i)*columnWidth,(j-(col.length-1)/2)*advance);
      paint(char,0,0,'ー―…‥（）「」『』【】〈〉《》'.includes(char)?Math.PI/2:0); ctx.restore();
    }));
  } else {
    const rows=textRows(ctx,l.text,l.w/(sfx?l.stretchX/100:1)*.88);
    rows.forEach((text,row)=>{
      const chars=Array.from(text), widths=chars.map(char=>ctx.measureText(char).width*(sfx?l.stretchX/100:1));
      let x=-widths.reduce((a,b)=>a+b,0)/2;
      chars.forEach((char,i)=>{ paint(char,x+widths[i]/2,(row-(rows.length-1)/2)*l.size*1.3*(sfx?l.stretchY/100:1)); x+=widths[i]; });
    });
  }
}

export function draw(ctx, img, layers, selected = null, scale = 1, selectionScale = scale) {
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.scale(scale, scale); ctx.drawImage(img, 0, 0);
  for (const l of layers) {
    ctx.save(); ctx.translate(l.x, l.y); ctx.rotate(l.rotation * Math.PI / 180);
    ornament(ctx, l); paintText(ctx, l);
    if (l.id === selected) {
      ctx.strokeStyle = '#b2dd78'; ctx.fillStyle = '#c8ee91'; ctx.lineWidth = 1.5 / selectionScale;
      ctx.setLineDash([5 / selectionScale, 4 / selectionScale]); ctx.strokeRect(-l.w / 2, -l.h / 2, l.w, l.h); ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(0, -l.h / 2); ctx.lineTo(0, -l.h / 2 - 24 / selectionScale); ctx.stroke();
      ctx.fillRect(l.w / 2 - 5 / selectionScale, l.h / 2 - 5 / selectionScale, 10 / selectionScale, 10 / selectionScale);
      ctx.beginPath(); ctx.arc(0, -l.h / 2 - 24 / selectionScale, 5 / selectionScale, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
}

export function exportName(name, index) {
  return `${String(index + 1).padStart(3, '0')}_${name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.png`;
}
