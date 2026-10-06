import { newLayer, clamp } from './renderer.js';
import { normalizeLayer } from './model.js';
export const PREFS_KEY = 'serifu.preferences.v1';
const styleKeys = ['vertical','rotation','color','effect','font','warp','distortion','skew','stretchX','stretchY'];
const ratioKeys = {x:'xRatio',y:'yRatio',w:'wRatio',h:'hRatio',size:'sizeRatio',outline:'outlineRatio',blur:'blurRatio',motionBlur:'motionRatio'};
export function styleFromLayer(layer,width,height) {
  const style={}; for(const key of styleKeys) style[key]=layer[key]; style.blurAngle=layer.blurAngle;
  for(const [key,ratio] of Object.entries(ratioKeys)) style[ratio]=layer[key]/(['y','h'].includes(key)?height:width);
  return style;
}
function builtin(id,name,kind,changes={}) { const layer={...newLayer(kind,1000,750),...changes}; return {id,name,kind,builtin:true,style:styleFromLayer(layer,1000,750)}; }
export function defaultPreferences() {
  const presets=[
    builtin('dialogue-standard','縦書き・標準セリフ','dialogue'),
    builtin('dialogue-large','縦書き・大きめセリフ','dialogue',{size:58,outline:8}),
    builtin('sfx-impact','縦書き・極太インパクト','sfx',{effect:'burst',font:'comic',distortion:35,warp:'taper',skew:-12,stretchX:115,stretchY:110}),
    builtin('sfx-speed','縦書き・流れる効果音','sfx',{effect:'speed',font:'comic',motionBlur:35,blurAngle:90,distortion:30,warp:'wave',skew:-18,stretchY:135}),
    builtin('sfx-rumble','縦書き・ゴゴゴ','sfx',{effect:'rumble',font:'comic',distortion:45,warp:'wave',skew:-7,stretchX:85}),
  ];
  return {version:1,presets,defaults:{dialogue:'dialogue-standard',sfx:'sfx-impact'},autosave:{enabled:true,minutes:2}};
}
export function applyPreset(layer,preset,width,height) {
  if(!preset||preset.kind!==layer.kind) return layer;
  const next={...layer,...Object.fromEntries(styleKeys.map(k=>[k,preset.style[k]])),blurAngle:preset.style.blurAngle,presetId:preset.id};
  for(const [key,ratio] of Object.entries(ratioKeys)) next[key]=preset.style[ratio]*(['y','h'].includes(key)?height:width);
  next.w=clamp(next.w,30,30000);next.h=clamp(next.h,30,30000);next.size=clamp(next.size,8,500);next.outline=clamp(next.outline,1,80);next.blur=clamp(next.blur,0,30);next.motionBlur=clamp(next.motionBlur,0,150);
  normalizeLayer(next,3); Object.assign(layer,next); return layer;
}
export function normalizePreferences(input) {
  const result=defaultPreferences();
  if(!input||input.version!==1) return result;
  for(const p of Array.isArray(input.presets)?input.presets:[]) {
    if(!p||p.builtin||!['dialogue','sfx'].includes(p.kind)||typeof p.id!=='string'||typeof p.name!=='string'||p.name.length>60)continue;
    try { const probe=newLayer(p.kind,1000,750);applyPreset(probe,p,1000,750);result.presets.push({...p,builtin:false}); } catch {}
  }
  result.presets=result.presets.slice(0,105);
  for(const kind of ['dialogue','sfx']) if(result.presets.some(p=>p.id===input.defaults?.[kind]&&p.kind===kind))result.defaults[kind]=input.defaults[kind];
  if(typeof input.autosave?.enabled==='boolean')result.autosave.enabled=input.autosave.enabled;
  if(Number.isFinite(input.autosave?.minutes))result.autosave.minutes=clamp(input.autosave.minutes,.1,1440);
  return result;
}
export function createPreset(name,layer,width,height) {
  return {id:crypto.randomUUID(),name:name.trim().slice(0,60),kind:layer.kind,builtin:false,style:styleFromLayer(layer,width,height)};
}
