import {sliceStroke,joinStrokes} from './sfx-stroke-geometry.js';
import {graphemes} from './typography.js';

const MAX_GRAPHEMES=1024,MAX_STROKES=256,MAX_POINTS=64;
const COLOR=/^#[0-9a-f]{6}$/i;
const MODES=['readable','overlap'],ORIENTATIONS=['vertical','horizontal'];
const ROTATION_MODES=['auto','upright','sideways','tate-chu-yoko'];
const CAPS=['round','flat','taper','brush'];
const INTERPOLATIONS=['smooth','linear','step'];
const OWN=Object.hasOwn;
const has=(o,k)=>o&&OWN(o,k);
const finite=(v,min,max,label)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw new Error('SFX '+label+'が不正');return v;};
const integer=(v,min,max,label)=>{if(!Number.isSafeInteger(v)||v<min||v>max)throw new Error('SFX '+label+'が不正');return v;};
const enumValue=(v,values,label)=>{if(!values.includes(v))throw new Error('SFX '+label+'が不正');return v;};
const color=(v,label)=>{if(v!==null&&(typeof v!=='string'||!COLOR.test(v)))throw new Error('SFX '+label+'が不正');return v;};
const plain=(v,label)=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('SFX '+label+'が不正');return v;};
const uint=v=>v>>>0;
const glyphText=text=>{if(typeof text!=='string')throw new Error('SFX 本文が不正');const chars=graphemes(text);if(chars.length>MAX_GRAPHEMES)throw new Error('SFX 本文は1024字まで');return chars;};
export const sfxVisibleIndices=text=>glyphText(text).flatMap((ch,i)=>ch==='\n'?[]:[i]);
export function sfxRuns(text,{single=false}={}){
  const chars=glyphText(text),result=[];
  for(let i=0;i<chars.length;){
    if(chars[i]!=='ー'){i++;continue;}
    let j=i+1;while(j<chars.length&&chars[j]==='ー')j++;
    if(j-i>=2||single)result.push({runStart:i,runLength:j-i});
    i=j;
  }
  return result;
}
export function defaultGlyph(index,seed=0){
  return {index,dx:0,dy:0,rotation:0,scaleX:1,scaleY:1,shear:0,
    pivot:{preset:'center',x:0,y:0},z:index,
    overrides:{font:null,fill:null,outlineColor:null,outlineWidth:null},
    manual:{position:false,transform:false,style:false,z:false},
    orientationOverride:'auto',inkVariantSeed:uint(seed+Math.imul(index+1,2654435761))};
}
export function defaultStroke(runStart,runLength,size=40){
  return {runStart,runLength,mode:runLength===1?'font':'continuous',shape:'straight',
    path:{type:'bezier',points:[{x:0,y:0},{x:1/3,y:0},{x:2/3,y:0},{x:1,y:0}]},
    widths:[{t:0,w:size*.3,interpolation:'smooth'},{t:1,w:size*.08,interpolation:'smooth'}],
    start:{attach:'previous',relation:'touch',offset:0,detached:false,cap:'round',sharpness:50,angle:0,length:0},
    end:{attach:'next',relation:'touch',offset:0,detached:false,cap:'taper',sharpness:50,angle:0,length:0},
    lookOverride:null,manualLengthLocked:false};
}
function normalizeGlyph(value,expected){
  plain(value,'文字');
  const index=integer(value.index,0,MAX_GRAPHEMES-1,'文字index');
  if(index!==expected)throw new Error('SFX 文字indexが重複または範囲外');
  const def=defaultGlyph(index);
  const overrides={...def.overrides,...plain(value.overrides??{},'文字style')};
  for(const k of ['fill','outlineColor'])color(overrides[k],k);
  if(overrides.originalFont!==undefined&&(typeof overrides.originalFont!=='string'||overrides.originalFont.length>128))throw new Error('SFX 元書体が不正');
  if(overrides.font!==null&&(typeof overrides.font!=='string'||overrides.font.length>128))throw new Error('SFX 書体が不正');
  if(overrides.outlineWidth!==null)finite(overrides.outlineWidth,0,80,'輪郭幅');
  const manual={...def.manual,...plain(value.manual??{},'手動フラグ')};
  for(const key of Object.keys(def.manual))if(typeof manual[key]!=='boolean')throw new Error('SFX 手動フラグが不正');
  const pivot={...def.pivot,...plain(value.pivot??{},'pivot')};
  enumValue(pivot.preset,['center','top-left','top','top-right','left','right','bottom-left','bottom','bottom-right','custom'],'pivot');
  return {
    sizeRatio:value.sizeRatio==null?null:finite(value.sizeRatio,.01,20,'文字サイズ比'),
    origin:value.origin==null?null:{x:finite(value.origin.x,-30000,30000,'originX'),y:finite(value.origin.y,-30000,30000,'originY')},
    index,dx:finite(value.dx??0,-30000,30000,'dx'),dy:finite(value.dy??0,-30000,30000,'dy'),
    rotation:finite(value.rotation??0,-3600,3600,'rotation'),
    scaleX:finite(value.scaleX??1,.01,20,'scaleX'),scaleY:finite(value.scaleY??1,.01,20,'scaleY'),
    shear:finite(value.shear??0,-5,5,'shear'),
    pivot:{preset:pivot.preset,x:finite(pivot.x,-30000,30000,'pivotX'),y:finite(pivot.y,-30000,30000,'pivotY')},
    z:integer(value.z??index,-100000,100000,'z'),overrides,manual,
    orientationOverride:enumValue(value.orientationOverride??'auto',ROTATION_MODES,'縦組み指定'),
    inkVariantSeed:integer(value.inkVariantSeed??def.inkVariantSeed,0,4294967295,'文字seed')
  };
}
function normalizeEndpoint(value,def){
  const v={...def,...plain(value??{},'端点')};
  return {...(v.fixedPosition?{fixedPosition:{x:finite(v.fixedPosition.x,-30000,30000,'固定端x'),y:finite(v.fixedPosition.y,-30000,30000,'固定端y')}}:{}),attach:enumValue(v.attach,['previous','next','none'],'接続先'),
    relation:enumValue(v.relation,['touch','inside','gap'],'接続形態'),
    offset:finite(v.offset,-30000,30000,'端点offset'),detached:typeof v.detached==='boolean'?v.detached:(()=>{throw new Error('SFX 端点detachが不正')})(),
    cap:enumValue(v.cap,CAPS,'筆先'),sharpness:finite(v.sharpness,0,100,'尖り度'),
    angle:finite(v.angle,-360,360,'筆先角度'),length:finite(v.length,0,30000,'筆先長さ')};
}
function normalizeStroke(input,expected,size,inkSeed=0){
  plain(input,'長音線');
  const base=defaultStroke(expected.runStart,expected.runLength,size);
  const runStart=integer(input.runStart,0,MAX_GRAPHEMES-1,'runStart');
  const runLength=integer(input.runLength,1,MAX_GRAPHEMES,'runLength');
  if(runStart!==expected.runStart||runLength!==expected.runLength)throw new Error('SFX 長音線と原文の対応が不正');
  const mode=enumValue(input.mode??'continuous',['continuous','font'],'長音線mode');
  const shape=enumValue(input.shape??'straight',['straight','arc','s','wave','custom'],'線形状');
  const raw=plain(input.path??base.path,'線path');
  if(raw.type!=='bezier'||!Array.isArray(raw.points)||raw.points.length<4||raw.points.length>MAX_POINTS||(raw.points.length-1)%3!==0)throw new Error('SFX 制御点が不正');
  const points=raw.points.map(p=>{plain(p,'制御点');return {x:finite(p.x,-10,10,'制御点x'),y:finite(p.y,-10,10,'制御点y')};});
  if(!Array.isArray(input.widths??base.widths)||(input.widths??base.widths).length<2||(input.widths??base.widths).length>MAX_POINTS)throw new Error('SFX 線幅点が不正');
  const widths=(input.widths??base.widths).map(p=>{plain(p,'線幅点');return {t:finite(p.t,0,1,'線幅t'),w:finite(p.w,0,500,'線幅w'),interpolation:enumValue(p.interpolation??'smooth',INTERPOLATIONS,'線幅補間'),fixed:!!p.fixed,...(p.distance!=null?{distance:finite(p.distance,0,30000,'固定幅距離')}:{})};});
  if(widths[0].t!==0||widths.at(-1).t!==1||widths.some((p,i)=>i&&p.t<=widths[i-1].t))throw new Error('SFX 線幅点の順序が不正');
  const look=input.lookOverride??null;
  if(look!==null){plain(look,'線style');color(look.fill??null,'線色');color(look.outlineColor??null,'線輪郭色');if(look.outlineWidth!=null)finite(look.outlineWidth,0,80,'線輪郭幅');}
  return {inkVariantSeed:integer(input.inkVariantSeed??((inkSeed+Math.imul(runStart+1,2654435761))>>>0),0,4294967295,'線seed'),runStart,runLength,mode,shape,path:{type:'bezier',points,handleMode:enumValue(raw.handleMode??'independent',['smooth','sharp','independent'],'ハンドル')},widths,
    start:normalizeEndpoint(input.start,base.start),end:normalizeEndpoint(input.end,base.end),
    lookOverride:look===null?null:{fill:look.fill??null,outlineColor:look.outlineColor??null,outlineWidth:look.outlineWidth??null},
    manualLengthLocked:!!input.manualLengthLocked,lockedLength:input.lockedLength==null?null:finite(input.lockedLength,0,30000,'固定長')};
}
export function normalizeLettering(value,text,{size=40,vertical=true}={}){
  if(value==null)return null;
  plain(value,'lettering');
  if(value.schemaVersion!==1||value.enabled!==true)throw new Error('SFX letteringの版または状態が不正');
  const chars=glyphText(text),visible=sfxVisibleIndices(text),provided=value.glyphs??[];
  if(!Array.isArray(provided)||provided.length>visible.length)throw new Error('SFX 文字一覧が不正');
  const lookup=new Map();
  for(const g of provided){const index=integer(g?.index,0,MAX_GRAPHEMES-1,'文字index');if(lookup.has(index)||!visible.includes(index))throw new Error('SFX 文字indexが重複または範囲外');lookup.set(index,g);}
  const layoutSeed=integer(value.layoutSeed??0,0,4294967295,'layoutSeed');
  const inkSeed=integer(value.inkSeed??0,0,4294967295,'inkSeed');
  const glyphs=visible.map(i=>normalizeGlyph(lookup.get(i)??defaultGlyph(i,inkSeed),i));
  const runs=sfxRuns(text,{single:true}),providedStrokes=value.strokes??[];
  if(runs.length>MAX_STROKES)throw new Error('SFX 長音線は256本まで');
  if(!Array.isArray(providedStrokes)||providedStrokes.length>MAX_STROKES)throw new Error('SFX 長音線一覧が不正');
  const byRun=new Map();
  for(const stroke of providedStrokes){
    const start=integer(stroke?.runStart,0,MAX_GRAPHEMES-1,'runStart');
    if(byRun.has(start)||!runs.some(run=>run.runStart===start&&run.runLength===stroke.runLength))throw new Error('SFX 長音線の重複または不一致');
    byRun.set(start,stroke);
  }
  const strokes=runs.map(run=>normalizeStroke(byRun.get(run.runStart)??run,run,size,inkSeed));
  const outlineGroups=value.outlineGroups??[];
  if(!Array.isArray(outlineGroups)||outlineGroups.length>MAX_GRAPHEMES)throw new Error('SFX 輪郭グループが不正');
  const valid=new Set(visible);
  const groups=outlineGroups.map(g=>{plain(g,'輪郭グループ');if(!Array.isArray(g.members)||!g.members.length||g.members.length>visible.length||new Set(g.members).size!==g.members.length||g.members.some(x=>!valid.has(x)))throw new Error('SFX 輪郭memberが不正');const style=g.styleOverride??null;if(style!==null){plain(style,'グループstyle');color(style.color??null,'グループ色');if(has(style,'width'))finite(style.width,0,80,'グループ幅');}return {members:[...g.members].sort((a,b)=>a-b),mode:enumValue(g.mode??'auto',['auto','manual'],'グループmode'),locked:!!g.locked,styleOverride:style};});
  return {baseBox:value.baseBox?{w:finite(value.baseBox.w,30,30000,'配置幅'),h:finite(value.baseBox.h,30,30000,'配置高さ')}:null,outlineMode:enumValue(value.outlineMode??'individual',['individual','union'],'輪郭mode'),outlineScale:!!value.outlineScale,schemaVersion:1,enabled:true,layoutMode:enumValue(value.layoutMode??'readable',MODES,'配置mode'),
    overlapIntensity:finite(value.overlapIntensity??0,0,100,'重なり強度'),
    orientation:enumValue(value.orientation??(vertical?'vertical':'horizontal'),ORIENTATIONS,'書字方向'),
    layoutSeed,inkSeed,glyphs,strokes,outlineGroups:groups};
}
export function startLettering(layer){
  if(layer?.kind!=='sfx')throw new Error('SFXのみ文字単位編集に対応');
  if(layer.lettering?.enabled)return normalizeLettering(layer.lettering,layer.text,layer);
  const value={baseBox:Number.isFinite(layer.w)&&Number.isFinite(layer.h)?{w:layer.w,h:layer.h}:null,schemaVersion:1,enabled:true,layoutMode:'readable',overlapIntensity:0,
    orientation:layer.vertical?'vertical':'horizontal',
    layoutSeed:layer.glyphSeed??0,inkSeed:layer.textureSeed??0};
  return normalizeLettering(value,layer.text,layer);
}
function lcsMap(oldChars,newChars){
  // 文字一致ルール。曖昧な繰返しは左優先で安定決定。
  const m=oldChars.length,n=newChars.length,dp=Array.from({length:m+1},()=>new Uint16Array(n+1));
  for(let i=m-1;i>=0;i--)for(let j=n-1;j>=0;j--)dp[i][j]=oldChars[i]===newChars[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
  const mapping=new Map();let i=0,j=0;
  while(i<m&&j<n){if(oldChars[i]===newChars[j]){mapping.set(j,i);i++;j++;}else if(dp[i+1][j]>=dp[i][j+1])i++;else j++;}
  return mapping;
}
export function replaceLetteringText(layer,newText,mode='position'){
  enumValue(mode,['position','character','reset'],'継承rule');
  const oldChars=glyphText(layer.text),next=glyphText(newText);
  const old=startLettering(layer);
  const map=mode==='reset'?new Map():mode==='position'?new Map(next.map((_,i)=>[i,i]).filter(([i])=>i<oldChars.length)):lcsMap(oldChars,next);
  const indexToGlyph=new Map(old.glyphs.map(g=>[g.index,g]));
  const layout={...old,orientation:old.orientation,glyphs:[],strokes:[],outlineGroups:[]};
  for(let i=0;i<next.length;i++){
    if(next[i]==='\n')continue;
    const source=map.get(i),original=indexToGlyph.get(source);
    layout.glyphs.push(original?{...structuredClone(original),index:i}:defaultGlyph(i,old.inkSeed));
  }
  for(const run of sfxRuns(newText,{single:true})){
    const inherited=[];
    for(let index=run.runStart;index<run.runStart+run.runLength;index++){
      const source=map.get(index),stroke=old.strokes.find(s=>source>=s.runStart&&source<s.runStart+s.runLength);
      if(!stroke)continue;
      let part=inherited.at(-1);
      if(!part||part.stroke!==stroke){part={stroke,start:source,end:source};inherited.push(part);}else part.end=source;
    }
    let combined=null,total=0;
    for(const part of inherited){
      const count=part.end-part.start+1,fragment=sliceStroke(part.stroke,(part.start-part.stroke.runStart)/part.stroke.runLength,(part.end-part.stroke.runStart+1)/part.stroke.runLength);
      combined=combined?joinStrokes(combined,fragment,total/(total+count)):fragment;total+=count;
    }
    const result=combined??defaultStroke(run.runStart,run.runLength,layer.size);
    result.runStart=run.runStart;result.runLength=run.runLength;
    if(run.runLength===1)result.mode='font';
    layout.strokes.push(result);
  }
  for(const group of old.outlineGroups){
    const oldMembers=new Set(group.members),members=[...map].filter(([j,i])=>next[j]!=='\n'&&oldMembers.has(i)).map(([j])=>j);
    if(members.length)layout.outlineGroups.push({...structuredClone(group),members});
  }
  return {...layer,text:newText,lettering:normalizeLettering(layout,newText,layer)};
}
export function duplicateLetteringGlyphs(layer,indices,{offset=20}={}){
  const old=startLettering(layer),chars=glyphText(layer.text),selection=new Set(indices);
  if(!selection.size||[...selection].some(i=>!Number.isInteger(i)||i<0||i>=chars.length||chars[i]==='\n'))return layer;
  const out=[],newGlyphs=[],oldGlyphs=new Map(old.glyphs.map(g=>[g.index,g]));
  for(let i=0;i<chars.length;i++){
    out.push(chars[i]);if(chars[i]!=='\n')newGlyphs.push({...structuredClone(oldGlyphs.get(i)),index:out.length-1});
    if(selection.has(i)){
      out.push(chars[i]);const original=oldGlyphs.get(i);
      newGlyphs.push({...structuredClone(original),index:out.length-1,dx:original.dx+offset,dy:original.dy+offset,manual:{...original.manual,position:true}});
    }
  }
  const text=out.join(''),next=replaceLetteringText(layer,text,'character');
  // 新しい本文のインデックスへ複製時の座標を確実に割り当てる。
  next.lettering.glyphs=newGlyphs;
  next.lettering=normalizeLettering(next.lettering,text,layer);
  return next;
}
export function removeLetteringGlyphs(layer,indices){
  const chars=glyphText(layer.text),excluded=new Set(indices);
  return replaceLetteringText(layer,chars.filter((_,i)=>!excluded.has(i)).join(''),'character');
}
