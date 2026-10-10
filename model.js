import { DIALOGUE_COLORS, EFFECTS, FONT_CHOICES, WARP_CHOICES, clamp } from './renderer.js';
import { inkSeed } from './ink.js';
import { BALLOON_LIMITS, BALLOON_SHAPES, balloonSeedFromId, defaultSpikeCount } from './balloons.js';
import { CAPTION_LIMITS, CAPTION_ALIGNMENTS } from './captions.js';
import { PLACEMENT_DEFAULTS, PLACEMENT_LIMITS } from './glyph-layout.js';
import { normalizeBrush } from './brush-stroke.js';
export const PROJECT_VERSION=9;
export const THICKNESS_LIMIT = Object.freeze([-10,30]);
export const EFFECT_LIMITS = Object.freeze({ ...PLACEMENT_LIMITS, taperRate:[0,100], sizeVariation:[0,30], horizontalJitter:[0,20], blur: [0,30], motionBlur: [0,300], blurAngle: [-180,180], blurX:[0,150], blurY:[0,300], blurStrength:[0,400], inkCore:[0,100], roughness:[0,100], dryInk:[0,100], brushTails:[0,100], grungeAmount:[0,100], scratchLength:[0,100], scratchAngle:[-180,180], spatterAmount:[0,100], distortion: [0,100], skew: [-45,45], stretchX: [30,250], stretchY: [30,250] });

function speechColors(input) {
  const textColor=input.textColor===undefined?null:input.textColor,textOutlineColor=input.textOutlineColor===undefined?'#ffffff':input.textOutlineColor;
  const validColor=value=>typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value);
  if(textColor!==null&&!validColor(textColor)||!validColor(textOutlineColor))throw new Error('セリフの文字色・輪郭色が不正');
  return {textColor,textOutlineColor};
}

export function normalizeLayer(input, version = PROJECT_VERSION) {
  if(input?.kind==='caption'){
    input={...input,...normalizeBrush(input),textOutlineWidth:input.textOutlineWidth===undefined?0:input.textOutlineWidth,textOutlineColor:input.textOutlineColor===undefined?'#ffffff':input.textOutlineColor,shape:input.shape??'rect',shapeSeed:input.shapeSeed??0,distortion:input.distortion??55};
    if(version<5)throw new Error('キャプションはバージョン5以降の編集データに対応');
    for(const key of ['x','y','w','h','rotation'])if(!Number.isFinite(input[key]))throw new Error('キャプションの座標・サイズが不正');
    if(input.w<30||input.w>30000||input.h<30||input.h>30000||Math.abs(input.rotation)>180)throw new Error('キャプションの座標・サイズが範囲外');
    for(const key of ['color','borderColor','textColor','textOutlineColor'])if(!/^#[0-9a-f]{6}$/i.test(input[key]))throw new Error('キャプションの色が不正');
    for(const [key,[min,max]] of Object.entries(CAPTION_LIMITS))if(!Number.isFinite(input[key])||input[key]<min||input[key]>max)throw new Error('キャプションの設定が範囲外');
    if(typeof input.text!=='string'||typeof input.autoFit!=='boolean'||typeof input.vertical!=='boolean'||!Object.hasOwn(FONT_CHOICES,input.font))throw new Error('キャプションの本文・書体設定が不正');
    const alignX=input.alignX===undefined?(version<6?'right':'center'):input.alignX,alignY=input.alignY===undefined?(version<6?'top':'center'):input.alignY;
    if(!Object.hasOwn(CAPTION_ALIGNMENTS.alignX,alignX)||!Object.hasOwn(CAPTION_ALIGNMENTS.alignY,alignY))throw new Error('キャプションの揃える方向が不正');
    if(!['rect','spiky'].includes(input.shape)||!Number.isInteger(input.shapeSeed)||input.shapeSeed<0||input.shapeSeed>4294967295||!Number.isFinite(input.distortion)||input.distortion<0||input.distortion>100)throw new Error('キャプションの形状設定が不正');
    return {id:crypto.randomUUID(),kind:'caption',presetId:typeof input.presetId==='string'?input.presetId:null,alignX,alignY,...normalizeBrush(input),shape:input.shape,shapeSeed:input.shapeSeed,distortion:input.distortion,...Object.fromEntries(['x','y','w','h','rotation','text','color','borderColor','textColor','textOutlineColor','font','vertical','autoFit',...Object.keys(CAPTION_LIMITS)].map(key=>[key,input[key]]))};
  }
  if(input?.kind==='balloon'){
    const shapeSeed=input.shapeSeed??balloonSeedFromId(input.id);
    input={...input,...normalizeBrush(input),distortion:input.distortion===undefined?50:input.distortion,text:input.text===undefined?'':input.text,speaker:input.speaker===undefined?'male':input.speaker,lineAlign:input.lineAlign??'top',
      spikeCount:input.spikeCount===undefined?defaultSpikeCount(shapeSeed):input.spikeCount,...speechColors(input),
      size:input.size===undefined?40:input.size,outline:input.outline===undefined?4:input.outline,thickness:input.thickness===undefined?0:input.thickness,
      vertical:input.vertical===undefined?true:input.vertical,font:input.font===undefined?'sans':input.font,shadowEnabled:input.shadowEnabled??false,shadowColor:input.shadowColor??'#222222',shadowBlur:input.shadowBlur??12,shadowOffsetX:input.shadowOffsetX??6,shadowOffsetY:input.shadowOffsetY??6,shadowOpacity:input.shadowOpacity??45,borderStyle:input.borderStyle??'solid',brushRoughness:input.brushRoughness??50};
    if(version<4)throw new Error('吹き出しはバージョン4以降の編集データに対応');
    for(const key of ['x','y','w','h','rotation'])if(!Number.isFinite(input[key]))throw new Error('吹き出しの座標・サイズが不正');
    if(input.w<30||input.w>30000||input.h<30||input.h>30000||Math.abs(input.rotation)>180)throw new Error('吹き出しの座標・サイズが範囲外');
    for(const key of ['color','borderColor','shadowColor'])if(!/^#[0-9a-f]{6}$/i.test(input[key]))throw new Error('吹き出しの色が不正');
    for(const [key,[min,max]] of Object.entries(BALLOON_LIMITS))if(!Number.isFinite(input[key])||input[key]<min||input[key]>max)throw new Error('吹き出しの設定が範囲外');
    if(typeof input.shadowEnabled!=='boolean'||!['solid','brush','dry-brush'].includes(input.borderStyle))throw new Error('吹き出しの影・ブラシ設定が不正');
    if(typeof input.tail!=='boolean'||!['behind','above'].includes(input.sfxOrder))throw new Error('吹き出しのテール・重なり設定が不正');
    const shape=input.shape??'ellipse';
    if(!Object.hasOwn(BALLOON_SHAPES,shape)||!Number.isInteger(shapeSeed)||shapeSeed<0||shapeSeed>4294967295||!Number.isInteger(input.spikeCount))throw new Error('吹き出しの形状が不正');
    if(typeof input.text!=='string'||!Object.hasOwn(DIALOGUE_COLORS,input.speaker)||typeof input.vertical!=='boolean'||!Object.hasOwn(FONT_CHOICES,input.font)||!['top','center'].includes(input.lineAlign))throw new Error('吹き出しのセリフ設定が不正');
    if(!Number.isFinite(input.size)||input.size<8||input.size>500||!Number.isFinite(input.outline)||input.outline<0||input.outline>80||!Number.isFinite(input.thickness)||input.thickness<THICKNESS_LIMIT[0]||input.thickness>THICKNESS_LIMIT[1])throw new Error('吹き出しの文字設定が範囲外');
    return {id:crypto.randomUUID(),kind:'balloon',presetId:typeof input.presetId==='string'?input.presetId:null,shape,shapeSeed,...normalizeBrush(input),shadowEnabled:input.shadowEnabled,shadowColor:input.shadowColor,borderStyle:input.borderStyle,text:input.text,speaker:input.speaker,...speechColors(input),size:input.size,outline:input.outline,thickness:input.thickness,vertical:input.vertical,lineAlign:input.lineAlign,font:input.font,...Object.fromEntries(['x','y','w','h','rotation','color','borderColor','tail','sfxOrder',...Object.keys(BALLOON_LIMITS)].map(key=>[key,input[key]]))};
  }
  if (!input || typeof input.text !== 'string' || typeof input.vertical !== 'boolean') throw new Error('文字設定が不正');
  const legacy = version === 1;
  const kind = legacy && input.kind === 'bubble' ? 'dialogue' : input.kind;
  if (!['dialogue', 'sfx'].includes(kind)) throw new Error('文字の種類が不正');
  for (const key of ['x', 'y', 'w', 'h', 'size', 'rotation']) {
    if (!Number.isFinite(input[key])) throw new Error('座標またはサイズが不正');
  }
  if (input.w < 30 || input.w > 30000 || input.h < 30 || input.h > 30000 || input.size < 8 || input.size > 500 || Math.abs(input.rotation) > 180) throw new Error('座標またはサイズが範囲外');
  const speaker = legacy ? 'male' : input.speaker;
  const effect = legacy ? 'impact' : input.effect;
  const outline = legacy ? Math.max(2, Math.round(input.size * .15)) : input.outline;
  if (!Object.hasOwn(DIALOGUE_COLORS, speaker) || !Object.hasOwn(EFFECTS, effect)) throw new Error('話者または効果音設定が不正');
  if (!Number.isFinite(outline) || outline < 0 || outline > 80) throw new Error('文字の輪郭の太さが不正');
  if (!/^#[0-9a-f]{6}$/i.test(input.color)) throw new Error('文字色が不正');
  const extras = { ...PLACEMENT_DEFAULTS, taperRate:10, sizeVariation:0, horizontalJitter:0, thickness:0, lineAlign:'top', font: kind==='sfx'?'comic':'sans', warp:'taper', blur:0, motionBlur:0, blurAngle:90, blurX:0, blurY:0, blurStrength:200, inkCore:80, roughness:0, dryInk:0, brushTails:0, grungeAmount:65, scratchLength:55, scratchAngle:90, spatterAmount:40, distortion:0, skew:0, stretchX:100, stretchY:100 };
  for (const key of Object.keys(extras)) if (input[key] !== undefined) extras[key] = input[key];
  if(!['standard','optical'].includes(extras.kerningMode))throw new Error('文字配置方式が不正');
  if(!['top','center'].includes(extras.lineAlign))throw new Error('改行の配置設定が不正');
  if (!Object.hasOwn(FONT_CHOICES,extras.font) || !Object.hasOwn(WARP_CHOICES,extras.warp)) throw new Error('書体または歪み設定が不正');
  if (!Number.isFinite(extras.thickness) || extras.thickness<THICKNESS_LIMIT[0] || extras.thickness>THICKNESS_LIMIT[1]) throw new Error('文字の太さが範囲外');
  for (const [key,[min,max]] of Object.entries(EFFECT_LIMITS)) if (!Number.isFinite(extras[key]) || extras[key]<min || extras[key]>max) throw new Error('効果音の設定が範囲外');
  const inkTexture=input.inkTexture??'none',textureSeed=input.textureSeed??inkSeed((input.id??input.text)+':texture');
  if(!['none','grunge'].includes(inkTexture)||!Number.isInteger(textureSeed)||textureSeed<0||textureSeed>4294967295)throw new Error('インク質感の設定が不正');
  const glyphSeed=input.glyphSeed??inkSeed(input.text);
  if (!Number.isInteger(glyphSeed) || glyphSeed<0 || glyphSeed>4294967295) throw new Error('文字のばらつき設定が不正');
  return {
    id: crypto.randomUUID(), kind, speaker, text: input.text,
    x: input.x, y: input.y, w: input.w, h: input.h, size: input.size,
    rotation: input.rotation, vertical: input.vertical, lineAlign:extras.lineAlign, outline, effect, color: input.color,
    ...(kind==='dialogue'?speechColors(input):{}),
    ...extras, glyphSeed, inkTexture, textureSeed, presetId: typeof input.presetId==='string' ? input.presetId : null,
  };
}

export function checkpoint(page) {
  page.undo.push(JSON.stringify({ layers: page.layers, done: page.done, edited:page.edited===true }));
  if (page.undo.length > 100) page.undo.shift();
  page.redo = []; page.done = false;page.edited=true;
}

export function restore(page, direction) {
  const from = direction === 'undo' ? page.undo : page.redo;
  const to = direction === 'undo' ? page.redo : page.undo;
  if (!from.length) return false;
  to.push(JSON.stringify({ layers: page.layers, done: page.done, edited:page.edited===true }));
  const state = JSON.parse(from.pop());
  page.layers = state.layers; page.done = state.done;page.edited=state.edited===true;
  page.selectedId = page.layers.some(l => l.id === page.selectedId) ? page.selectedId : page.layers[0]?.id || null;
  return true;
}

export function duplicateLayer(layer) {
  return { ...layer, id: crypto.randomUUID(), x: layer.x + 20, y: layer.y + 20 };
}

export function copySelection(layer, width, height) {
  return { layer:structuredClone(layer), width, height };
}

export function scaledCopy(layer, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const sx=targetWidth/sourceWidth,sy=targetHeight/sourceHeight,scale=Math.min(sx,sy);
  if(layer.kind==='balloon')return {...structuredClone(layer),id:crypto.randomUUID(),x:layer.x*sx,y:layer.y*sy,w:clamp(layer.w*sx,30,30000),h:clamp(layer.h*sy,30,30000),
    size:clamp(layer.size*scale,8,500),outline:clamp(layer.outline*scale,0,80),thickness:clamp((layer.thickness??0)*scale,...THICKNESS_LIMIT),borderWidth:clamp(layer.borderWidth*scale,0,80),shadowBlur:clamp((layer.shadowBlur??12)*scale,0,100),shadowOffsetX:clamp((layer.shadowOffsetX??6)*sx,-100,100),shadowOffsetY:clamp((layer.shadowOffsetY??6)*sy,-100,100),tailX:clamp(layer.tailX*sx,...BALLOON_LIMITS.tailX),tailY:clamp(layer.tailY*sy,...BALLOON_LIMITS.tailY),tailWidth:clamp(layer.tailWidth*scale,...BALLOON_LIMITS.tailWidth)};
  if(layer.kind==='caption')return {...structuredClone(layer),id:crypto.randomUUID(),x:layer.x*sx,y:layer.y*sy,w:clamp(layer.w*sx,30,30000),h:clamp(layer.h*sy,30,30000),
    size:clamp(layer.size*scale,...CAPTION_LIMITS.size),padding:clamp(layer.padding*scale,...CAPTION_LIMITS.padding),borderWidth:clamp(layer.borderWidth*scale,...CAPTION_LIMITS.borderWidth),textOutlineWidth:clamp((layer.textOutlineWidth??0)*scale,...CAPTION_LIMITS.textOutlineWidth)};
  return {
    ...structuredClone(layer), id:crypto.randomUUID(), x:layer.x*sx, y:layer.y*sy,
    w:clamp(layer.w*sx,30,30000), h:clamp(layer.h*sy,30,30000),
    size:clamp(layer.size*scale,8,500), outline:clamp(layer.outline*scale,0,80),
    thickness:clamp((layer.thickness??0)*scale,...THICKNESS_LIMIT),
    minimumGlyphGap:clamp((layer.minimumGlyphGap??2)*scale,...PLACEMENT_LIMITS.minimumGlyphGap),
    blur:clamp(layer.blur*scale,0,30), motionBlur:clamp(layer.motionBlur*scale,0,300),
    blurX:clamp((layer.blurX||0)*sx,0,150),blurY:clamp((layer.blurY||0)*sy,0,300),
  };
}

export function pasteSelection(clipboard, width, height, offset=20) {
  const layer=scaledCopy(clipboard.layer,clipboard.width,clipboard.height,width,height);
  layer.x+=offset;layer.y+=offset;layer.presetId=null;
  return layer;
}

export function copyLayers(layers, width, height) {
  return { layers:structuredClone(layers), width, height };
}

export function cutLayers(source, width, height) {
  if (!source?.layers.length) return null;
  const clipboard=copyLayers(source.layers,width,height);
  checkpoint(source);
  source.layers=[];source.selectedId=null;
  return clipboard;
}

export function pasteLayers(clipboard, target, width, height) {
  if (!target || !clipboard?.layers?.length) return [];
  const copies=clipboard.layers.map(layer=>scaledCopy(layer,clipboard.width,clipboard.height,width,height));
  checkpoint(target);
  target.layers.push(...copies);
  return copies;
}

export function swapText(page, firstId, secondId) {
  const first = page.layers.find(l => l.id === firstId), second = page.layers.find(l => l.id === secondId);
  if (!first || !second || first === second || !['dialogue','sfx'].includes(first.kind) || !['dialogue','sfx'].includes(second.kind)) return false;
  checkpoint(page); [first.text, second.text] = [second.text, first.text]; return true;
}

export function copyToNext(source, target, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  if (!source) return false;
  return pasteLayers(copyLayers(source.layers,sourceWidth,sourceHeight),target,targetWidth,targetHeight).length>0;
}
