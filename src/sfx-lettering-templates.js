import {startLettering,normalizeLettering,sfxRuns} from './sfx-lettering-model.js';

export const TEMPLATE_VERSION=1;
export const SFX_TEMPLATE_KEY='serifu.sfx.templates.v1';
const STYLE_KEYS=['font','size','color','outline','textOutlineColor','effect','stretchX','stretchY','thickness','blur','motionBlur','blurAngle','grungeAmount','textureSeed','kerningMode','kerningStrength','glyphOverlap'];
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
const safeObject=value=>value&&typeof value==='object'&&!Array.isArray(value);
export function validateSfxTemplate(template){
  if(!safeObject(template)||template.version!==TEMPLATE_VERSION||typeof template.id!=='string'||!/^[a-zA-Z0-9-]{6,80}$/.test(template.id)
     ||typeof template.name!=='string'||!template.name.trim()||template.name.length>100)throw new Error('SFXテンプレートのID/名前/版が不正');
  const data=template.design;
  if(!safeObject(data)||!Number.isFinite(data.width)||data.width<30||data.width>30000
    ||!Number.isFinite(data.height)||data.height<30||data.height>30000
    ||!Number.isFinite(data.baseSize)||data.baseSize<8||data.baseSize>500
    ||!Array.isArray(data.glyphs)||data.glyphs.length>1024||!Array.isArray(data.strokes)||data.strokes.length>256
    ||!safeObject(data.style))throw new Error('SFXテンプレートの形状が不正');
  for(const field of Object.keys(data.style))if(!STYLE_KEYS.includes(field))throw new Error('SFXテンプレートに未対応のstyle');
  for(const glyph of data.glyphs){
    if(!safeObject(glyph)||!Number.isFinite(glyph.dx)||Math.abs(glyph.dx)>1000||!Number.isFinite(glyph.dy)||Math.abs(glyph.dy)>1000||
       !Number.isFinite(glyph.rotation)||Math.abs(glyph.rotation)>3600||!Number.isFinite(glyph.scaleX)||glyph.scaleX<=0||glyph.scaleX>20||
       !Number.isFinite(glyph.scaleY)||glyph.scaleY<=0||glyph.scaleY>20||!Number.isFinite(glyph.shear)||Math.abs(glyph.shear)>5||
       !safeObject(glyph.overrides))throw new Error('SFXテンプレートのグリフが不正');
  }
  for(const stroke of data.strokes){
    if(!safeObject(stroke)||!Number.isFinite(stroke.relativeIndex)||stroke.relativeIndex<0||stroke.relativeIndex>1||
       !safeObject(stroke.value)||!Array.isArray(stroke.value.path?.points)||!Array.isArray(stroke.value.widths)||
       stroke.value.path.points.length>64||stroke.value.widths.length>64)throw new Error('SFXテンプレートの長音線が不正');
  }
  return structuredClone(template);
}
export function createSfxTemplate(layer,name){
  if(layer?.kind!=='sfx'||typeof name!=='string'||!name.trim()||name.length>100)throw new Error('テンプレート名または対象が不正');
  const lettering=startLettering(layer),glyphs=lettering.glyphs,strokes=lettering.strokes;
  const design={width:layer.w,height:layer.h,baseSize:layer.size,
    style:Object.fromEntries(STYLE_KEYS.filter(k=>layer[k]!==undefined).map(k=>[k,structuredClone(layer[k])])),
    arrangement:{layoutMode:lettering.layoutMode,overlapIntensity:lettering.overlapIntensity,orientation:lettering.orientation},
    glyphs:glyphs.map(g=>({dx:g.dx/layer.w,dy:g.dy/layer.h,rotation:g.rotation,scaleX:g.scaleX,scaleY:g.scaleY,shear:g.shear,z:g.z,overrides:structuredClone(g.overrides)})),
    strokes:strokes.map((s,i)=>({relativeIndex:strokes.length===1?0:i/(strokes.length-1),value:structuredClone(s)}))};
  return validateSfxTemplate({version:TEMPLATE_VERSION,id:crypto.randomUUID(),name:name.trim(),design});
}
const interpolate=(a,b,t)=>a+(b-a)*t;
function mappedGlyph(source,position){
  if(source.length===0)return null;
  if(source.length===1)return structuredClone(source[0]);
  const ix=position*(source.length-1),low=Math.floor(ix),high=Math.ceil(ix),factor=ix-low;
  if(low===high)return structuredClone(source[low]);
  const from=source[low],to=source[high];
  return {...structuredClone(from),dx:interpolate(from.dx,to.dx,factor),dy:interpolate(from.dy,to.dy,factor),
    rotation:interpolate(from.rotation,to.rotation,factor),scaleX:interpolate(from.scaleX,to.scaleX,factor),
    scaleY:interpolate(from.scaleY,to.scaleY,factor),shear:interpolate(from.shear,to.shear,factor),
    z:Math.round(interpolate(from.z,to.z,factor)),overrides:structuredClone(factor<.5?from.overrides:to.overrides)};
}
export function applySfxTemplate(layer,template,{mode='all',reuseSeed=false}={}){
  const valid=validateSfxTemplate(template);
  if(layer?.kind!=='sfx'||!['all','style','layout'].includes(mode))throw new Error('SFXテンプレートの適用先/モードが不正');
  const base=structuredClone(layer),design=valid.design;
  const style=mode!=='layout',layout=mode!=='style';
  if(style)for(const key of STYLE_KEYS)if(Object.hasOwn(design.style,key))base[key]=structuredClone(design.style[key]);
  let lettering=startLettering(base);
  if(layout){
    const oldWidth=layer.w,oldHeight=layer.h;
    base.w=design.width;base.h=design.height;
    lettering.layoutMode=design.arrangement?.layoutMode??lettering.layoutMode;
    lettering.overlapIntensity=clamp(design.arrangement?.overlapIntensity??lettering.overlapIntensity,0,100);
    const n=lettering.glyphs.length;
    for(let i=0;i<n;i++){
      const target=lettering.glyphs[i],example=mappedGlyph(design.glyphs,n<2?0:i/(n-1));
      if(!example)continue;
      Object.assign(target,{dx:example.dx*base.w,dy:example.dy*base.h,rotation:example.rotation,
        scaleX:example.scaleX,scaleY:example.scaleY,shear:example.shear,z:example.z});
      target.manual.position=true;target.manual.transform=true;target.manual.z=true;
      if(style){target.overrides=structuredClone(example.overrides);target.manual.style=true;}
    }
    const runs=sfxRuns(base.text);
    for(let i=0;i<runs.length;i++){
      if(!design.strokes.length)break;
      const sample=design.strokes[Math.min(design.strokes.length-1,Math.round((runs.length<2?0:i/(runs.length-1))*(design.strokes.length-1)))].value;
      lettering.strokes[i]={...structuredClone(sample),runStart:runs[i].runStart,runLength:runs[i].runLength,
        widths:sample.widths.map(p=>({...p,w:clamp(p.w*base.size/design.baseSize,0,500)}))};
    }
    if(!reuseSeed){
      lettering.layoutSeed=crypto.getRandomValues(new Uint32Array(1))[0];
      lettering.inkSeed=crypto.getRandomValues(new Uint32Array(1))[0];
    }
    // Text, page position and layer ID are never stored in or copied from templates.
    void oldWidth;void oldHeight;
  }
  base.lettering=normalizeLettering(lettering,base.text,base);
  return base;
}
export function decodeSfxTemplates(text){
  if(typeof text!=='string'||text.length>1024*1024)throw new Error('テンプレートJSONが大きすぎる');
  const input=JSON.parse(text);
  if(!safeObject(input)||input.format!=='serifu-sfx-templates'||input.version!==TEMPLATE_VERSION||!Array.isArray(input.templates)||input.templates.length>100)throw new Error('未対応のSFXテンプレート形式');
  return input.templates.map(validateSfxTemplate);
}
export function encodeSfxTemplates(templates){
  const checked=templates.map(validateSfxTemplate);
  if(checked.length>100)throw new Error('テンプレート件数が上限を超える');
  return JSON.stringify({format:'serifu-sfx-templates',version:TEMPLATE_VERSION,templates:checked},null,2);
}
export function mergeSfxTemplates(current,incoming,{conflict='skip'}={}){
  if(!['skip','overwrite','rename'].includes(conflict))throw new Error('競合ルールが不正');
  const byId=new Map(current.map(p=>[p.id,validateSfxTemplate(p)]));
  const names=new Set([...byId.values()].map(x=>x.name));
  for(const original of incoming){
    const template=validateSfxTemplate(original);
    if(byId.has(template.id)||names.has(template.name)){
      if(conflict==='skip')continue;
      if(conflict==='rename'){
        template.id=crypto.randomUUID();
        let i=2,name=template.name;
        while(names.has(name))name=template.name+' ('+(i++)+')';
        template.name=name;
      }else for(const [id,t] of byId)if(id===template.id||t.name===template.name){byId.delete(id);names.delete(t.name);}
    }
    byId.set(template.id,template);names.add(template.name);
  }
  if(byId.size>100)throw new Error('テンプレート件数が上限を超える');
  return [...byId.values()];
}
