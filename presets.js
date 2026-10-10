import { newLayer, clamp } from './renderer.js';
import { normalizeLayer, THICKNESS_LIMIT, PROJECT_VERSION } from './model.js';
import { BALLOON_LIMITS } from './balloons.js';
import { CAPTION_LIMITS } from './captions.js';
import { PLACEMENT_DEFAULTS, PLACEMENT_LIMITS } from './glyph-layout.js';
import { BRUSH_LIMITS } from './brush-stroke.js';
export const PREFS_KEY = 'serifu.preferences.v1';
export const PRESET_KINDS = Object.freeze(['dialogue','sfx','balloon','caption']);
export const MAX_USER_PRESETS = 100;
const styleKeys = ['vertical','rotation','color','effect','font','warp','distortion','skew','stretchX','stretchY','blurStrength','inkCore','roughness','dryInk','brushTails','inkTexture','grungeAmount','scratchLength','scratchAngle','spatterAmount','sizeVariation','horizontalJitter','taperRate',...Object.keys(PLACEMENT_DEFAULTS).filter(key=>key!=='minimumGlyphGap'),'glyphSeed'];
const ratioKeys = {x:'xRatio',y:'yRatio',w:'wRatio',h:'hRatio',size:'sizeRatio',thickness:'thicknessRatio',outline:'outlineRatio',blur:'blurRatio',motionBlur:'motionRatio',blurX:'blurXRatio',blurY:'blurYRatio',minimumGlyphGap:'minimumGlyphGapRatio'};
const dimension = (key,width,height) => ['y','h','blurY'].includes(key)?height:width;
const boxRatioKeys={x:'xRatio',y:'yRatio',w:'wRatio',h:'hRatio',borderWidth:'borderWidthRatio'};
const boxStyles={
  balloon:['shape','shapeSeed','spikeCount','distortion','rotation','color','borderColor','textColor','textOutlineColor','shadowEnabled','shadowColor','shadowOpacity','borderStyle','brushEngine','brushSeed',...Object.keys(BRUSH_LIMITS),'transparency','tail','tailAngle','sfxOrder','vertical','lineAlign','font'],
  caption:['borderStyle','brushEngine','brushSeed',...Object.keys(BRUSH_LIMITS),'rotation','color','borderColor','transparency','textColor','textOutlineColor','font','vertical','autoFit','alignX','alignY','shape','distortion'],
};
function presetFields(kind) {
  if(kind==='balloon')return {styles:boxStyles.balloon,ratios:{...boxRatioKeys,size:'sizeRatio',outline:'outlineRatio',thickness:'thicknessRatio',tailX:'tailXRatio',tailY:'tailYRatio',tailWidth:'tailWidthRatio',shadowBlur:'shadowBlurRatio',shadowOffsetX:'shadowOffsetXRatio',shadowOffsetY:'shadowOffsetYRatio'}};
  if(kind==='caption')return {styles:boxStyles.caption,ratios:{...boxRatioKeys,size:'sizeRatio',padding:'paddingRatio',textOutlineWidth:'textOutlineWidthRatio'}};
  return {styles:[...styleKeys,'blurAngle',...(kind==='dialogue'?['textColor','textOutlineColor']:[])],ratios:ratioKeys};
}
function presetDimension(kind,key,width,height) {
  if(['balloon','caption'].includes(kind)){
    if(['borderWidth','tailWidth','size','outline','thickness','padding','textOutlineWidth'].includes(key))return Math.min(width,height);
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
function builtin(id,name,kind,changes={}) { const layer={...newLayer(kind,1000,750),...changes},style=styleFromLayer(layer,1000,750);delete style.glyphSeed;delete style.brushSeed;if(kind==='balloon')delete style.shapeSeed;return {id,name,kind,builtin:true,style}; }
export function defaultPreferences() {
  const presets=[
    builtin('dialogue-standard','縦書き・標準セリフ','dialogue'),
    builtin('dialogue-large','縦書き・大きめセリフ','dialogue',{size:58,outline:8}),
    builtin('sfx-impact','縦書き・極太インパクト','sfx',{effect:'burst',font:'comic',distortion:45,warp:'taper',skew:-16,stretchX:115,stretchY:110,roughness:25,dryInk:35,brushTails:35}),
    builtin('sfx-speed','縦書き・流れる効果音','sfx',{effect:'speed',font:'comic',motionBlur:60,blurAngle:90,blurY:28,blurStrength:240,inkCore:85,distortion:40,warp:'wave',skew:-18,stretchY:135}),
    builtin('sfx-rumble','縦書き・ゴゴゴ','sfx',{effect:'rumble',font:'comic',distortion:45,warp:'wave',skew:-7,stretchX:85}),
    builtin('sfx-tension','縦書き・感情／緊張の掠れ','sfx',{effect:'tension',font:'brush',size:110,outline:3,rotation:-7,distortion:35,warp:'wave',skew:-10,stretchX:85,stretchY:115,roughness:50,dryInk:75,brushTails:60,blurY:24,blurStrength:280,inkCore:90}),
    builtin('sfx-vertical-blur','縦書き・強い縦ブラー','sfx',{effect:'tension',font:'brush',size:110,outline:3,rotation:0,distortion:30,warp:'taper',skew:-10,roughness:45,dryInk:65,brushTails:70,blurY:65,blurStrength:350,inkCore:65}),
    builtin('sfx-grunge-print','かすれ印刷・荒れインク（参考画像風）','sfx',{effect:'none',inkTexture:'grunge',color:'#14305f',outline:0,font:'comic',grungeAmount:70,scratchLength:60,scratchAngle:90,spatterAmount:35,roughness:15,dryInk:10,brushTails:5}),
    builtin('sfx-dense','密集レタリング','sfx',{effect:'none',distortion:12,skew:-5,kerningMode:'optical',kerningStrength:85,minimumGlyphGap:2,sizeVariation:5,horizontalJitter:2,rotationJitter:4,verticalJitter:2,spacingJitter:3}),
    builtin('sfx-handwritten','荒々しい手描き配置','sfx',{effect:'none',font:'brush',distortion:20,kerningMode:'optical',kerningStrength:90,minimumGlyphGap:1,overlapAllowance:18,glyphOverlap:15,sizeVariation:18,horizontalJitter:12,verticalJitter:8,rotationJitter:18,spacingJitter:15}),
    builtin('balloon-pen','手描きペン','balloon',{borderStyle:'brush',brushRoughness:25,brushPressureVariation:40,brushTexture:15,brushOpacityVariation:10}),
    builtin('balloon-dry-brush','掠れ筆','balloon',{borderStyle:'dry-brush',borderWidth:7,brushRoughness:55,brushPressureVariation:65,brushTexture:75,brushOpacityVariation:35}),
    builtin('caption-handwritten','手描き枠線','caption',{borderStyle:'brush',borderWidth:4,brushRoughness:30,brushPressureVariation:45,brushTexture:25,brushOpacityVariation:15}),
    builtin('balloon-standard','標準の吹き出し','balloon'),
    builtin('caption-standard','標準のキャプション','caption'),
  ];
  return {version:1,presets,defaults:{dialogue:'dialogue-standard',sfx:'sfx-impact',balloon:'balloon-standard',caption:'caption-standard'},autosave:{enabled:true,minutes:2}};
}
export function applyPreset(layer,preset,width,height) {
  if(!preset||preset.kind!==layer.kind) return layer;
  const {styles,ratios}=presetFields(layer.kind);
  const next={...layer,...Object.fromEntries(styles.map(k=>[k,preset.style[k]===undefined&&(layer.kind==='balloon'||['textColor','textOutlineColor','glyphSeed','brushSeed'].includes(k))?layer[k]:preset.style[k]])),presetId:preset.id};
  for(const [key,ratio] of Object.entries(ratios)){
    const value=preset.style[ratio]??(layer.kind==='balloon'?layer[key]/presetDimension(layer.kind,key,width,height):key==='minimumGlyphGap'?2/width:['thickness','blurX','blurY'].includes(key)?0:NaN);
    if(!Number.isFinite(value))throw new Error('プリセットの寸法が不正');
    next[key]=value*presetDimension(layer.kind,key,width,height);
  }
  if(['balloon','caption'].includes(layer.kind)&&preset.style.brushEngine===undefined)next.brushEngine=layer.kind==='balloon'?'legacy':'pressure';
  next.w=clamp(next.w,30,30000);next.h=clamp(next.h,30,30000);
  if(layer.kind==='balloon'||layer.kind==='caption'){
    const limits=layer.kind==='balloon'?BALLOON_LIMITS:CAPTION_LIMITS;
    for(const key of Object.keys(ratios))if(limits[key])next[key]=clamp(next[key],...limits[key]);
    if(layer.kind==='balloon'){next.size=clamp(next.size,8,500);next.outline=clamp(next.outline,0,80);next.thickness=clamp(next.thickness,...THICKNESS_LIMIT);}
  }else{
    next.size=clamp(next.size,8,500);next.outline=clamp(next.outline,0,80);next.blur=clamp(next.blur,0,30);next.motionBlur=clamp(next.motionBlur,0,300);next.blurX=clamp(next.blurX,0,150);next.blurY=clamp(next.blurY,0,300);
    next.thickness=clamp(next.thickness,...THICKNESS_LIMIT);
    next.minimumGlyphGap=clamp(next.minimumGlyphGap,...PLACEMENT_LIMITS.minimumGlyphGap);
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
