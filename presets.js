import { newLayer, clamp } from './renderer.js';
import { normalizeLayer, THICKNESS_LIMIT, PROJECT_VERSION } from './model.js';
import { BALLOON_LIMITS } from './balloons.js';
import { CAPTION_LIMITS } from './captions.js';
export const PREFS_KEY = 'serifu.preferences.v1';
export const PRESET_KINDS = Object.freeze(['dialogue','sfx','balloon','caption']);
export const MAX_USER_PRESETS = 100;
const styleKeys = ['vertical','rotation','color','effect','font','warp','distortion','skew','stretchX','stretchY','blurStrength','inkCore','roughness','dryInk','brushTails','sizeVariation','horizontalJitter','taperRate'];
const ratioKeys = {x:'xRatio',y:'yRatio',w:'wRatio',h:'hRatio',size:'sizeRatio',thickness:'thicknessRatio',outline:'outlineRatio',blur:'blurRatio',motionBlur:'motionRatio',blurX:'blurXRatio',blurY:'blurYRatio'};
const dimension = (key,width,height) => ['y','h','blurY'].includes(key)?height:width;
const boxRatioKeys={x:'xRatio',y:'yRatio',w:'wRatio',h:'hRatio',borderWidth:'borderWidthRatio'};
const boxStyles={
  balloon:['shape','distortion','rotation','color','borderColor','transparency','tail','tailAngle','sfxOrder'],
  caption:['rotation','color','borderColor','transparency','textColor','textOutlineColor','font','vertical','autoFit','alignX','alignY'],
};
function presetFields(kind) {
  if(kind==='balloon')return {styles:boxStyles.balloon,ratios:{...boxRatioKeys,tailX:'tailXRatio',tailY:'tailYRatio',tailWidth:'tailWidthRatio'}};
  if(kind==='caption')return {styles:boxStyles.caption,ratios:{...boxRatioKeys,size:'sizeRatio',padding:'paddingRatio',textOutlineWidth:'textOutlineWidthRatio'}};
  return {styles:[...styleKeys,'blurAngle'],ratios:ratioKeys};
}
function presetDimension(kind,key,width,height) {
  if(['balloon','caption'].includes(kind)){
    if(['borderWidth','tailWidth','size','padding','textOutlineWidth'].includes(key))return Math.min(width,height);
    if(key==='tailY')return height;
  }
  return dimension(key,width,height);
}
export function styleFromLayer(layer,width,height) {
  const {styles,ratios}=presetFields(layer.kind),style={};
  for(const key of styles)style[key]=layer[key];
  for(const [key,ratio] of Object.entries(ratios))style[ratio]=(key==='thickness'?(layer[key]??0):layer[key])/presetDimension(layer.kind,key,width,height);
  return style;
}
function builtin(id,name,kind,changes={}) { const layer={...newLayer(kind,1000,750),...changes}; return {id,name,kind,builtin:true,style:styleFromLayer(layer,1000,750)}; }
export function defaultPreferences() {
  const presets=[
    builtin('dialogue-standard','縦書き・標準セリフ','dialogue'),
    builtin('dialogue-large','縦書き・大きめセリフ','dialogue',{size:58,outline:8}),
    builtin('sfx-impact','縦書き・極太インパクト','sfx',{effect:'burst',font:'comic',distortion:45,warp:'taper',skew:-16,stretchX:115,stretchY:110,roughness:25,dryInk:35,brushTails:35}),
    builtin('sfx-speed','縦書き・流れる効果音','sfx',{effect:'speed',font:'comic',motionBlur:60,blurAngle:90,blurY:28,blurStrength:240,inkCore:85,distortion:40,warp:'wave',skew:-18,stretchY:135}),
    builtin('sfx-rumble','縦書き・ゴゴゴ','sfx',{effect:'rumble',font:'comic',distortion:45,warp:'wave',skew:-7,stretchX:85}),
    builtin('sfx-tension','縦書き・感情／緊張の掠れ','sfx',{effect:'tension',font:'brush',size:110,outline:3,rotation:-7,distortion:35,warp:'wave',skew:-10,stretchX:85,stretchY:115,roughness:50,dryInk:75,brushTails:60,blurY:24,blurStrength:280,inkCore:90}),
    builtin('sfx-vertical-blur','縦書き・強い縦ブラー','sfx',{effect:'tension',font:'brush',size:110,outline:3,rotation:0,distortion:30,warp:'taper',skew:-10,roughness:45,dryInk:65,brushTails:70,blurY:65,blurStrength:350,inkCore:65}),
    builtin('balloon-standard','標準の吹き出し','balloon'),
    builtin('caption-standard','標準のキャプション','caption'),
  ];
  return {version:1,presets,defaults:{dialogue:'dialogue-standard',sfx:'sfx-impact',balloon:'balloon-standard',caption:'caption-standard'},autosave:{enabled:true,minutes:2}};
}
export function applyPreset(layer,preset,width,height) {
  if(!preset||preset.kind!==layer.kind) return layer;
  const {styles,ratios}=presetFields(layer.kind);
  const next={...layer,...Object.fromEntries(styles.map(k=>[k,layer.kind==='balloon'&&['shape','distortion'].includes(k)&&preset.style[k]===undefined?layer[k]:preset.style[k]])),presetId:preset.id};
  for(const [key,ratio] of Object.entries(ratios)){
    const value=preset.style[ratio]??(['thickness','blurX','blurY'].includes(key)?0:NaN);
    if(!Number.isFinite(value))throw new Error('プリセットの寸法が不正');
    next[key]=value*presetDimension(layer.kind,key,width,height);
  }
  next.w=clamp(next.w,30,30000);next.h=clamp(next.h,30,30000);
  if(layer.kind==='balloon'||layer.kind==='caption'){
    const limits=layer.kind==='balloon'?BALLOON_LIMITS:CAPTION_LIMITS;
    for(const key of Object.keys(ratios))if(limits[key])next[key]=clamp(next[key],...limits[key]);
  }else{
    next.size=clamp(next.size,8,500);next.outline=clamp(next.outline,1,80);next.blur=clamp(next.blur,0,30);next.motionBlur=clamp(next.motionBlur,0,300);next.blurX=clamp(next.blurX,0,150);next.blurY=clamp(next.blurY,0,300);
    next.thickness=clamp(next.thickness,...THICKNESS_LIMIT);
  }
  Object.assign(layer,normalizeLayer(next,PROJECT_VERSION),{id:layer.id});return layer;
}
export function normalizePreferences(input) {
  const result=defaultPreferences(),builtinCount=result.presets.length;
  if(!input||input.version!==1) return result;
  for(const p of Array.isArray(input.presets)?input.presets:[]) {
    if(!p||p.builtin||!PRESET_KINDS.includes(p.kind)||typeof p.id!=='string'||!p.id||result.presets.some(existing=>existing.id===p.id)||typeof p.name!=='string'||!p.name.trim()||p.name.length>60)continue;
    try { const probe=newLayer(p.kind,1000,750);applyPreset(probe,p,1000,750);result.presets.push({...p,name:p.name.trim(),builtin:false}); } catch {}
  }
  result.presets=result.presets.slice(0,builtinCount+MAX_USER_PRESETS);
  for(const kind of PRESET_KINDS) if(result.presets.some(p=>p.id===input.defaults?.[kind]&&p.kind===kind))result.defaults[kind]=input.defaults[kind];
  if(typeof input.autosave?.enabled==='boolean')result.autosave.enabled=input.autosave.enabled;
  if(Number.isFinite(input.autosave?.minutes))result.autosave.minutes=clamp(input.autosave.minutes,.1,1440);
  return result;
}
export function createPreset(name,layer,width,height) {
  return {id:crypto.randomUUID(),name:name.trim().slice(0,60),kind:layer.kind,builtin:false,style:styleFromLayer(layer,width,height)};
}
