import {hasSessionFont} from './fonts.js';
import { normalizeLettering } from './sfx-lettering-model.js';
import { DIALOGUE_COLORS, EFFECTS, FONT_CHOICES, WARP_CHOICES, clamp, paintOrder } from './renderer.js';
import { inkSeed } from './ink.js';
import { BALLOON_LIMITS, BALLOON_SHAPES, balloonSeedFromId, defaultSpikeCount } from './balloons.js';
import { CAPTION_LIMITS, CAPTION_ALIGNMENTS } from './captions.js';
import { PLACEMENT_DEFAULTS, PLACEMENT_LIMITS } from './glyph-layout.js';
import { normalizeBrush } from './brush-stroke.js';
export const PROJECT_VERSION=14;
export const THICKNESS_LIMIT = Object.freeze([-10,30]);
export const EFFECT_LIMITS = Object.freeze({ ...PLACEMENT_LIMITS, taperRate:[0,100], sizeVariation:[0,30], horizontalJitter:[0,20], blur: [0,30], motionBlur: [0,300], blurAngle: [-180,180], blurX:[0,150], blurY:[0,300], blurStrength:[0,400], inkCore:[0,100], roughness:[0,100], dryInk:[0,100], brushTails:[0,100], grungeAmount:[0,100], scratchLength:[0,100], scratchAngle:[-180,180], spatterAmount:[0,100], distortion: [0,100], skew: [-45,45], stretchX: [30,250], stretchY: [30,250] });

function speechColors(input) {
  const textColor=input.textColor===undefined?null:input.textColor,textOutlineColor=input.textOutlineColor===undefined?'#ffffff':input.textOutlineColor;
  const validColor=value=>typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value);
  if(textColor!==null&&!validColor(textColor)||!validColor(textOutlineColor))throw new Error('セリフの文字色・輪郭色が不正');
  return {textColor,textOutlineColor};
}

function normalizedLayoutOrder(input, version = PROJECT_VERSION) {
  if(input?.layoutOrder===undefined)return {};
  if(version<13||!Number.isSafeInteger(input.layoutOrder)||input.layoutOrder<0)throw new Error('重なり順が不正');
  return {layoutOrder:input.layoutOrder};
}

export function normalizeLayer(input, version = PROJECT_VERSION) {
  return {...normalizeTextLayer(input,version),...(typeof input?.originalFont==='string'&&input.originalFont.length<=128?{originalFont:input.originalFont}:{}),...normalizedLayoutOrder(input,version),...(version>=14&&typeof input?.id==='string'&&/^[a-f0-9-]{36}$/i.test(input.id)?{id:input.id}:{})};
}

function normalizeTextLayer(input, version) {
  if(input?.kind==='caption'){
    input={textOffsetX:0,textOffsetY:0,...input,...normalizeBrush(input),textOutlineWidth:input.textOutlineWidth===undefined?0:input.textOutlineWidth,textOutlineColor:input.textOutlineColor===undefined?'#ffffff':input.textOutlineColor,shape:input.shape??'rect',shapeSeed:input.shapeSeed??0,distortion:input.distortion??55};
    if(version<5)throw new Error('キャプションはバージョン5以降の編集データに対応');
    for(const key of ['x','y','w','h','rotation'])if(!Number.isFinite(input[key]))throw new Error('キャプションの座標・サイズが不正');
    if(input.w<30||input.w>30000||input.h<30||input.h>30000||Math.abs(input.rotation)>180)throw new Error('キャプションの座標・サイズが範囲外');
    for(const key of ['color','borderColor','textColor','textOutlineColor'])if(!/^#[0-9a-f]{6}$/i.test(input[key]))throw new Error('キャプションの色が不正');
    for(const [key,[min,max]] of Object.entries(CAPTION_LIMITS))if(!Number.isFinite(input[key])||input[key]<min||input[key]>max)throw new Error('キャプションの設定が範囲外');
    if(typeof input.text!=='string'||typeof input.autoFit!=='boolean'||typeof input.vertical!=='boolean'||!(Object.hasOwn(FONT_CHOICES,input.font)||hasSessionFont(input.font)))throw new Error('キャプションの本文・書体設定が不正');
    const alignX=input.alignX===undefined?(version<6?'right':'center'):input.alignX,alignY=input.alignY===undefined?(version<6?'top':'center'):input.alignY;
    if(!Object.hasOwn(CAPTION_ALIGNMENTS.alignX,alignX)||!Object.hasOwn(CAPTION_ALIGNMENTS.alignY,alignY))throw new Error('キャプションの揃える方向が不正');
    if(!['rect','spiky'].includes(input.shape)||!Number.isInteger(input.shapeSeed)||input.shapeSeed<0||input.shapeSeed>4294967295||!Number.isFinite(input.distortion)||input.distortion<0||input.distortion>100)throw new Error('キャプションの形状設定が不正');
    return {id:crypto.randomUUID(),kind:'caption',presetId:typeof input.presetId==='string'?input.presetId:null,alignX,alignY,...normalizeBrush(input),shape:input.shape,shapeSeed:input.shapeSeed,distortion:input.distortion,...Object.fromEntries(['x','y','w','h','rotation','text','color','borderColor','textColor','textOutlineColor','font','vertical','autoFit',...Object.keys(CAPTION_LIMITS)].map(key=>[key,input[key]]))};
  }
  if(input?.kind==='balloon'){
    const shapeSeed=input.shapeSeed??balloonSeedFromId(input.id);
    input={textOffsetX:0,textOffsetY:0,padding:0,...input,...normalizeBrush(input),distortion:input.distortion===undefined?50:input.distortion,text:input.text===undefined?'':input.text,speaker:input.speaker===undefined?'male':input.speaker,lineAlign:input.lineAlign??'top',
      spikeCount:input.spikeCount===undefined?defaultSpikeCount(shapeSeed):input.spikeCount,...speechColors(input),
      size:input.size===undefined?40:input.size,outline:input.outline===undefined?4:input.outline,thickness:input.thickness===undefined?0:input.thickness,
      vertical:input.vertical===undefined?true:input.vertical,font:input.font===undefined?'sans':input.font,shadowEnabled:input.shadowEnabled??false,shadowColor:input.shadowColor??'#222222',shadowBlur:input.shadowBlur??12,shadowOffsetX:input.shadowOffsetX??6,shadowOffsetY:input.shadowOffsetY??6,shadowOpacity:input.shadowOpacity??45,borderStyle:input.borderStyle??'solid',brushRoughness:input.brushRoughness??50};
    if(version<4)throw new Error('吹き出しはバージョン4以降の編集データに対応');
    for(const key of ['x','y','w','h','rotation'])if(!Number.isFinite(input[key]))throw new Error('吹き出しの座標・サイズが不正');
    if(input.w<30||input.w>30000||input.h<30||input.h>30000||Math.abs(input.rotation)>180)throw new Error('吹き出しの座標・サイズが範囲外');
    for(const key of ['color','borderColor','shadowColor'])if(!/^#[0-9a-f]{6}$/i.test(input[key]))throw new Error('吹き出しの色が不正');
    for(const [key,[min,max]] of Object.entries(BALLOON_LIMITS))if(!Number.isFinite(input[key])||input[key]<min||input[key]>max)throw new Error('吹き出しの設定が範囲外');
    if(typeof input.shadowEnabled!=='boolean'||!['solid','brush','dry-brush'].includes(input.borderStyle))throw new Error('吹き出しの影・ブラシ設定が不正');
    if(typeof input.tail!=='boolean')throw new Error('吹き出しのテール設定が不正');
    if(version<11&&input.sfxOrder!==undefined&&!['behind','above'].includes(input.sfxOrder))throw new Error('吹き出しの重なり設定が不正');
    const shape=input.shape??'ellipse';
    if(!Object.hasOwn(BALLOON_SHAPES,shape)||!Number.isInteger(shapeSeed)||shapeSeed<0||shapeSeed>4294967295||!Number.isInteger(input.spikeCount))throw new Error('吹き出しの形状が不正');
    if(typeof input.text!=='string'||!Object.hasOwn(DIALOGUE_COLORS,input.speaker)||typeof input.vertical!=='boolean'||!(Object.hasOwn(FONT_CHOICES,input.font)||hasSessionFont(input.font))||!['top','center'].includes(input.lineAlign))throw new Error('吹き出しのセリフ設定が不正');
    if(!Number.isFinite(input.size)||input.size<8||input.size>500||!Number.isFinite(input.outline)||input.outline<0||input.outline>80||!Number.isFinite(input.thickness)||input.thickness<THICKNESS_LIMIT[0]||input.thickness>THICKNESS_LIMIT[1])throw new Error('吹き出しの文字設定が範囲外');
    return {id:crypto.randomUUID(),kind:'balloon',presetId:typeof input.presetId==='string'?input.presetId:null,shape,shapeSeed,...normalizeBrush(input),shadowEnabled:input.shadowEnabled,shadowColor:input.shadowColor,borderStyle:input.borderStyle,text:input.text,speaker:input.speaker,...speechColors(input),size:input.size,outline:input.outline,thickness:input.thickness,vertical:input.vertical,lineAlign:input.lineAlign,font:input.font,...Object.fromEntries(['x','y','w','h','rotation','color','borderColor','tail',...Object.keys(BALLOON_LIMITS)].map(key=>[key,input[key]]))};
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
  const textOutlineColor=input.textOutlineColor===undefined?'#ffffff':input.textOutlineColor;
  if(typeof textOutlineColor!=='string'||!/^#[0-9a-f]{6}$/i.test(textOutlineColor))throw new Error('文字の輪郭色が不正');
  const extras = { ...PLACEMENT_DEFAULTS, taperRate:10, sizeVariation:0, horizontalJitter:0, thickness:0, lineAlign:'top', font: kind==='sfx'?'comic':'sans', warp:'taper', blur:0, motionBlur:0, blurAngle:90, blurX:0, blurY:0, blurStrength:200, inkCore:80, roughness:0, dryInk:0, brushTails:0, grungeAmount:65, scratchLength:55, scratchAngle:90, spatterAmount:40, distortion:0, skew:0, stretchX:100, stretchY:100 };
  for (const key of Object.keys(extras)) if (input[key] !== undefined) extras[key] = input[key];
  if(!['standard','optical'].includes(extras.kerningMode))throw new Error('文字配置方式が不正');
  if(!['top','center'].includes(extras.lineAlign))throw new Error('改行の配置設定が不正');
  if (!(Object.hasOwn(FONT_CHOICES,extras.font)||(input.kind==='sfx'&&hasSessionFont(extras.font))) || !Object.hasOwn(WARP_CHOICES,extras.warp)) throw new Error('書体または歪み設定が不正');
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
    ...(kind==='dialogue'?speechColors(input):{textOutlineColor}),
    ...extras, glyphSeed, inkTexture, textureSeed, ...(kind==='sfx'&&input.lettering!=null?{lettering:normalizeLettering(input.lettering,input.text,{size:input.size,vertical:input.vertical})}:{}), presetId: typeof input.presetId==='string' ? input.presetId : null,
  };
}

export const hasEdits = page => page.layers.length > 0 || !!page.imageEdit || (page.maskEffects?.length ?? 0) > 0;

export const MASK_EFFECT_TYPES = Object.freeze(['pixelate', 'blur', 'fill-black', 'fill-white']);

export function defaultMaskEffect(asset, { id = crypto.randomUUID(), effect = 'pixelate', createdOrder = 0, name } = {}) {
  if (!asset?.id || !asset.bbox) throw new Error('マスク素材が不正');
  return {
    id, kind: 'mask-effect', assetId: asset.id, name: name ?? `マスク加工 ${createdOrder + 1}`,
    createdOrder, visible: true, effect, blockSize: 20, blurRadius: 12, marginPx: 0,
    x: asset.bbox.x, y: asset.bbox.y, w: asset.bbox.width, h: asset.bbox.height,
  };
}

export function normalizeMaskEffect(input, imageWidth, imageHeight, assetIds, version = PROJECT_VERSION) {
  if (!input || typeof input !== 'object') throw new Error('マスク加工設定が不正');
  const id = input.id, assetId = input.assetId;
  if (typeof id !== 'string' || !id || id.length > 200 || ['__proto__','constructor','prototype'].includes(id)
      || typeof assetId !== 'string' || !assetId || assetId.length > 200 || ['__proto__','constructor','prototype'].includes(assetId)) throw new Error('マスク加工IDが不正');
  if (assetIds && !assetIds.has(assetId)) throw new Error('マスク素材の参照先が存在しない');
  if (input.kind !== undefined && input.kind !== 'mask-effect') throw new Error('マスク加工の種類が不正');
  const name = input.name ?? 'マスク加工';
  if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new Error('マスク加工名が不正');
  if (!Number.isSafeInteger(input.createdOrder) || input.createdOrder < 0 || typeof input.visible !== 'boolean') throw new Error('マスク加工の順序または表示設定が不正');
  if (!MASK_EFFECT_TYPES.includes(input.effect)) throw new Error('マスク加工方式が不正');
  if (!Number.isSafeInteger(input.blockSize) || input.blockSize < 1 || input.blockSize > 200
      || !Number.isSafeInteger(input.blurRadius) || input.blurRadius < 0 || input.blurRadius > 100
      || !Number.isSafeInteger(input.marginPx) || input.marginPx < -100 || input.marginPx > 100) throw new Error('マスク加工の強度が範囲外');
  if (![imageWidth, imageHeight].every(value => Number.isSafeInteger(value) && value > 0 && value <= 30000)) throw new Error('元画像の寸法が不正');
  if (![input.x, input.y, input.w, input.h].every(Number.isSafeInteger) || input.x < 0 || input.y < 0 || input.w < 1 || input.h < 1
      || input.w > imageWidth || input.h > imageHeight || input.x + input.w > imageWidth || input.y + input.h > imageHeight
      || input.w * input.h > 100_000_000) throw new Error('マスク加工の座標・サイズが範囲外');
  return { id, kind: 'mask-effect', assetId, name: name.trim(), createdOrder: input.createdOrder, visible: input.visible, effect: input.effect, ...normalizedLayoutOrder(input,version),
    blockSize: input.blockSize, blurRadius: input.blurRadius, marginPx: input.marginPx, x: input.x, y: input.y, w: input.w, h: input.h };
}

export function normalizeMaskEffects(effects = [], imageWidth, imageHeight, assetIds, version = PROJECT_VERSION) {
  if (!Array.isArray(effects)) throw new Error('マスク加工一覧が不正');
  const ids = new Set();
  return effects.map(effect => {
    const normalized = normalizeMaskEffect(effect, imageWidth, imageHeight, assetIds,version);
    if (ids.has(normalized.id)) throw new Error('マスク加工IDが重複している');
    ids.add(normalized.id);
    return normalized;
  });
}

function referencedMaskAssets(page) {
  const ids = new Set((page.maskEffects ?? []).map(effect => effect.assetId));
  for (const snapshot of [...(page.undo ?? []), ...(page.redo ?? [])]) {
    try { for (const effect of JSON.parse(snapshot).maskEffects ?? []) ids.add(effect.assetId); } catch { /* ignore invalid legacy snapshots */ }
  }
  return ids;
}

export function pruneMaskAssets(page) {
  if (!page.maskAssets || typeof page.maskAssets !== 'object') return [];
  const referenced = referencedMaskAssets(page), removed = [];
  for (const id of Object.keys(page.maskAssets)) if (!referenced.has(id)) {
    removed.push(page.maskAssets[id]); delete page.maskAssets[id];
  }
  return removed;
}

// Resolve legacy kind constraints once, before dropping the obsolete sfxOrder field.
export function normalizeLayers(layers, version = PROJECT_VERSION) {
  let ordered=layers;
  if(version<11){
    const behind=layers.filter(layer=>layer.kind==='balloon'&&layer.sfxOrder!=='above');
    const above=layers.filter(layer=>layer.kind==='balloon'&&layer.sfxOrder==='above');
    const text=layers.filter(layer=>layer.kind!=='balloon');
    ordered=above.length?[...behind,...text.filter(layer=>layer.kind==='sfx'),...above,...text.filter(layer=>layer.kind!=='sfx')]:[...behind,...text];
  }
  return ordered.map(layer=>normalizeLayer(layer,version));
}

export function reorderLayers(layers, ids, action) {
  const selected=new Set(ids),ordered=[...layers];
  if(action==='frontmost'||action==='backmost'){
    const chosen=ordered.filter(layer=>selected.has(layer.id)),others=ordered.filter(layer=>!selected.has(layer.id));
    return action==='frontmost'?[...others,...chosen]:[...chosen,...others];
  }
  if(action==='forward'){
    for(let i=ordered.length-2;i>=0;i--)if(selected.has(ordered[i].id)&&!selected.has(ordered[i+1].id)){
      [ordered[i],ordered[i+1]]=[ordered[i+1],ordered[i]];
    }
  }else if(action==='backward'){
    for(let i=1;i<ordered.length;i++)if(selected.has(ordered[i].id)&&!selected.has(ordered[i-1].id)){
      [ordered[i],ordered[i-1]]=[ordered[i-1],ordered[i]];
    }
  }
  return ordered;
}

export function reorderPageObjects(page, ids, action) {
  const before=paintOrder(page.layers,page.maskEffects??[]),ordered=reorderLayers(before,ids,action);
  if(ordered.every((object,index)=>object===before[index]))return null;
  const ranked=ordered.map((object,layoutOrder)=>({...object,layoutOrder}));
  return {layers:ranked.filter(object=>object.kind!=='mask-effect'),maskEffects:ranked.filter(object=>object.kind==='mask-effect')};
}

export function selectedLayers(page) {
  const ids = new Set(page.selectedIds ?? [page.selectedId]);
  return page.layers.filter(layer => ids.has(layer.id));
}

export function setSelection(page, ids, primary = ids[0]) {
  const valid = new Set(page.layers.map(layer => layer.id));
  page.selectedIds = [...new Set(ids)].filter(id => valid.has(id));
  page.selectedId = page.selectedIds.includes(primary) ? primary : page.selectedIds[0] ?? null;
  page.selectedMaskId = null;
}

export function syncSelection(page) {
  const maskId = page.selectedMaskId;
  if (maskId && page.maskEffects?.some(effect => effect.id === maskId)) {
    setSelection(page, []);
    page.selectedMaskId = maskId;
    return;
  }
  const ids = page.selectedId && page.selectedIds?.includes(page.selectedId) ? page.selectedIds : [page.selectedId];
  setSelection(page, ids, page.selectedId);
}

function historyState(page) {
  return JSON.stringify({ layers: page.layers, done: page.done, imageEdit: page.imageEdit ?? null,
    selectedId: page.selectedId, selectedIds: page.selectedIds ?? [page.selectedId],
    maskEffects: page.maskEffects ?? [], selectedMaskId: page.selectedMaskId ?? null,glyphEdit:page.glyphEdit?Object.fromEntries(['id','selected','indices','strokeRun','strokeRuns','strokePoint','widthIndex','pointSelection','inherit','editMode','priority','selectionTool','valueMode','snap','touch'].filter(k=>page.glyphEdit[k]!==undefined).map(k=>[k,page.glyphEdit[k]])):null });
}

export function checkpoint(page) {
  page.undo.push(historyState(page));
  if (page.undo.length > 100) page.undo.shift();
  page.redo = []; page.done = false;page.edited=true;
  pruneMaskAssets(page);
}

export function restore(page, direction) {
  const from = direction === 'undo' ? page.undo : page.redo;
  const to = direction === 'undo' ? page.redo : page.undo;
  if (!from.length) return false;
  to.push(historyState(page));
  const state = JSON.parse(from.pop());
  page.glyphEdit=state.glyphEdit??null;page.layers = state.layers; page.done = state.done; page.imageEdit = state.imageEdit ?? null;
  page.maskEffects = state.maskEffects ?? [];
  page.edited = hasEdits(page);
  setSelection(page, state.selectedIds ?? [state.selectedId ?? page.layers[0]?.id], state.selectedId);
  page.selectedMaskId = state.selectedMaskId && page.maskEffects.some(effect => effect.id === state.selectedMaskId) ? state.selectedMaskId : null;
  pruneMaskAssets(page);
  return true;
}

// Pointer coordinates and the drag anchor are in original-image pixels.
export function dragPlacement(start, point, anchor, constrain = false) {
  const dx = point.x - anchor.x, dy = point.y - anchor.y;
  const axis = constrain ? (Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical') : null;
  return {
    x: Math.round(start.x + (axis === 'vertical' ? 0 : dx)),
    y: Math.round(start.y + (axis === 'horizontal' ? 0 : dy)),
    axis,
  };
}

export function duplicateLayer(layer) {
  const {layoutOrder,...copy}=layer;
  return { ...copy, id: crypto.randomUUID(), x: layer.x + 20, y: layer.y + 20 };
}

export function copySelection(layer, width, height) {
  return { layer:structuredClone(layer), width, height };
}

export function scaledCopy(layer, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const {layoutOrder,...copy}=layer;layer=copy;
  const sx=targetWidth/sourceWidth,sy=targetHeight/sourceHeight,scale=Math.min(sx,sy);
  if(layer.kind==='balloon')return {...structuredClone(layer),id:crypto.randomUUID(),x:layer.x*sx,y:layer.y*sy,w:clamp(layer.w*sx,30,30000),h:clamp(layer.h*sy,30,30000),
    textOffsetX:clamp((layer.textOffsetX??0)*sx,...BALLOON_LIMITS.textOffsetX),textOffsetY:clamp((layer.textOffsetY??0)*sy,...BALLOON_LIMITS.textOffsetY),padding:clamp((layer.padding??0)*scale,...BALLOON_LIMITS.padding),
    size:clamp(layer.size*scale,8,500),outline:clamp(layer.outline*scale,0,80),thickness:clamp((layer.thickness??0)*scale,...THICKNESS_LIMIT),borderWidth:clamp(layer.borderWidth*scale,0,80),shadowBlur:clamp((layer.shadowBlur??12)*scale,0,100),shadowOffsetX:clamp((layer.shadowOffsetX??6)*sx,-100,100),shadowOffsetY:clamp((layer.shadowOffsetY??6)*sy,-100,100),tailX:clamp(layer.tailX*sx,...BALLOON_LIMITS.tailX),tailY:clamp(layer.tailY*sy,...BALLOON_LIMITS.tailY),tailWidth:clamp(layer.tailWidth*scale,...BALLOON_LIMITS.tailWidth)};
  if(layer.kind==='caption')return {...structuredClone(layer),id:crypto.randomUUID(),x:layer.x*sx,y:layer.y*sy,w:clamp(layer.w*sx,30,30000),h:clamp(layer.h*sy,30,30000),
    textOffsetX:clamp((layer.textOffsetX??0)*sx,...CAPTION_LIMITS.textOffsetX),textOffsetY:clamp((layer.textOffsetY??0)*sy,...CAPTION_LIMITS.textOffsetY),
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

export function pasteSelectedLayers(clipboard, width, height, offset = 20) {
  return clipboard.layers.map(layer => pasteSelection({ layer, width: clipboard.width, height: clipboard.height }, width, height, offset));
}

export function cutLayers(source, width, height) {
  if (!source?.layers.length) return null;
  const clipboard=copyLayers(source.layers,width,height);
  checkpoint(source);
  source.layers=[];setSelection(source, []);source.edited=hasEdits(source);
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
