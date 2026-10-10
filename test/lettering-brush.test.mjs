import test from 'node:test';
import assert from 'node:assert/strict';
import { newLayer, textGlyphs, clearGlyphCache } from '../renderer.js';
import { glyphVariation } from '../ink.js';
import { glyphBounds, measureGlyph, contourAdvance, PLACEMENT_DEFAULTS } from '../glyph-layout.js';
import { sampleClosedPath, brushDynamics, brushNoise, BRUSH_LIMITS } from '../brush-stroke.js';
import { balloonOutline, balloonGeometry } from '../balloons.js';
import { captionOutline } from '../captions.js';
import { normalizeLayer, scaledCopy, copyLayers, pasteLayers, checkpoint, restore, PROJECT_VERSION } from '../model.js';
import { createPreset, applyPreset, defaultPreferences } from '../presets.js';
import { projectBlob, readProject } from '../project-io.js';
const context=()=>({save(){},restore(){},measureText(char){const size=Number(this.font.match(/([\d.]+)px/)[1]),width=size*(char==='I'?.28:1);return {width,actualBoundingBoxLeft:width*.4,actualBoundingBoxRight:width*.4,actualBoundingBoxAscent:size*.4,actualBoundingBoxDescent:size*.4};}});
const base=()=>({...newLayer('sfx',2000,1500),text:'カIカIカ',size:100,w:1800,h:1000,effect:'none',vertical:false,skew:0,distortion:0,outline:0,sizeVariation:0,horizontalJitter:0,kerningMode:'optical',glyphSeed:123});

test('optical metrics reduce occupied length progressively with strength in both directions',()=>{
  for(const vertical of [true,false]){
    const l={...base(),vertical},lengths=[5,15,30].map(kerningStrength=>{const b=glyphBounds(textGlyphs(context(),{...l,kerningStrength}));return vertical?b.height:b.width;});
    assert.ok(lengths[0]>lengths[1]&&lengths[1]>lengths[2]);
  }
});
test('strength zero preserves the exact standard layout and zero jitter is seed independent',()=>{
  const l=base();assert.deepEqual(textGlyphs(context(),l),textGlyphs(context(),{...l,kerningMode:'standard'}));
  const first=textGlyphs(context(),{...l,kerningStrength:25});assert.deepEqual(first,textGlyphs(context(),{...l,kerningStrength:25,glyphSeed:321}));
  assert.ok(first.every(g=>g.dx===0&&g.dy===0&&g.angle===0));
});
test('correlated jitter is deterministic, continuous, parameter-specific, and includes seed zero',()=>{
  const settings={correlated:true,rotationJitter:20,verticalJitter:10,spacingJitter:10};
  const values=Array.from({length:20},(_,i)=>glyphVariation(0,i,15,10,settings));assert.deepEqual(values,Array.from({length:20},(_,i)=>glyphVariation(0,i,15,10,settings)));
  assert.notDeepEqual(values,Array.from({length:20},(_,i)=>glyphVariation(1,i,15,10,settings)));
  assert.ok(values.every((v,i)=>!i||Math.abs(v.rotation-values[i-1].rotation)<.3));
  assert.deepEqual(glyphVariation(0,2,0,0,{correlated:true}),{scale:1,shift:0,rotation:0,vertical:0,spacing:0});
});
test('contour profiles close shape-dependent whitespace while bounding nesting and intentional overlap',()=>{
  clearGlyphCache();const ctx=context(),l=base(),previous={char:'カ',size:100,angle:0},current={char:'I',size:100,angle:0};
  for(const g of [previous,current]){g.geometry=measureGlyph(ctx,l,g.char,0);g.geometry.profiles={step:1,horizontal:[{cross:0,start:-20,end:20}],vertical:[]};}
  const normal=contourAdvance(ctx,{...l,kerningStrength:100},previous,current);
  const boxes=contourAdvance(ctx,{...l,kerningStrength:30},previous,current);
  assert.ok(normal<boxes);assert.ok(normal>=boxes-80*.22);
  const overlap=contourAdvance(ctx,{...l,kerningStrength:100,overlapAllowance:20,glyphOverlap:20},previous,current);
  assert.ok(overlap<normal);assert.equal(contourAdvance(ctx,{...l,kerningStrength:100,overlapAllowance:0,glyphOverlap:20},previous,current),normal);
});
test('transformed layout fits as a group and retains graphemes, taper, line breaks and symbol rotation',()=>{
  const ctx=context(),l={...base(),text:'あ\u3099ー「カ」\nI、。',vertical:true,effect:'taper',taperRate:12,kerningStrength:20,sizeVariation:20,rotationJitter:20,verticalJitter:10,spacingJitter:10,horizontalJitter:10,distortion:40,skew:25,w:150,h:250};
  const a=textGlyphs(ctx,l),b=textGlyphs(ctx,l);assert.deepEqual(a,b);assert.equal(a[0].char,'あ\u3099');assert.equal(a.length,8);assert.ok(a[1].angle>1);assert.ok(a[0].size>a.at(-1).size);
  const bounds=glyphBounds(a);assert.ok(bounds.width<=l.w*.88+.001&&bounds.height<=l.h*.88+.001);assert.ok(a.every(g=>Number.isFinite(g.x+g.y+g.size)));
});
test('intentional overlap works with standard spacing and is limited by its separate allowance',()=>{
  const l={...base(),kerningMode:'standard',overlapAllowance:30},ctx=context(),wide=textGlyphs(ctx,l);
  const close=textGlyphs(ctx,{...l,glyphOverlap:30});assert.ok(close.at(-1).x-close[0].x<wide.at(-1).x-wide[0].x);
});
test('path sampling preserves sharp tips, cumulative arc length and bounded samples',()=>{
  const l={...newLayer('balloon',1000,750),shape:'spiky',tail:true,tailX:0,tailY:600,tailAngle:90,shapeSeed:12},outline=balloonOutline(l),samples=sampleClosedPath(outline,7);
  assert.ok(samples.some(p=>Math.hypot(p.x,p.y-600)<.0001));assert.ok(samples.every((p,i)=>!i||p.s>samples[i-1].s));assert.ok(samples.length<=8192);
  assert.ok(samples.every(p=>Math.abs(Math.hypot(p.nx,p.ny)-1)<1e-5));
  const before=balloonGeometry(l);brushDynamics(samples,{...l,brushRoughness:100});assert.deepEqual(before,balloonGeometry(l));
  assert.equal(captionOutline({...newLayer('caption',1000,750),shape:'spiky'}).length,15);
});
test('continuous periodic pressure changes width without a closed-path seam',()=>{
  const samples=sampleClosedPath([{x:-100,y:-100},{x:100,y:-100},{x:100,y:100},{x:-100,y:100}],2),l={borderWidth:8,brushSeed:0,brushRoughness:0,brushPressureVariation:80,brushOpacityVariation:40};
  const dynamics=brushDynamics(samples,l);assert.ok(Math.max(...dynamics.map(p=>p.width))-Math.min(...dynamics.map(p=>p.width))>2);
  assert.ok(dynamics.every(p=>p.width>0&&p.opacity>=.6&&p.opacity<=1));
  assert.ok(brushDynamics(samples,{...l,brushPressureVariation:0}).every(p=>p.width===8));
  for(let channel=0;channel<5;channel++){assert.ok(Math.abs(brushNoise(0,0,channel)-brushNoise(1,0,channel))<1e-12);assert.ok(Math.abs(brushNoise(.00001,0,channel)-brushNoise(.99999,0,channel))<.001);}
});
test('v1-v8 defaults preserve standard placement, solid borders and the legacy fibre brush',()=>{
  for(const kind of ['sfx','balloon','caption']){
    const old=newLayer(kind,1000,750);for(const key of [...Object.keys(PLACEMENT_DEFAULTS),...Object.keys(BRUSH_LIMITS),'brushSeed','brushEngine'])delete old[key];
    if(kind==='balloon')old.borderStyle='brush';else delete old.borderStyle;
    const normalized=normalizeLayer(old,8);
    if(kind==='sfx'){assert.equal(normalized.kerningMode,'standard');assert.equal(normalized.kerningStrength,0);}else {assert.equal(normalized.borderStyle,kind==='balloon'?'brush':'solid');assert.equal(normalized.brushEngine,kind==='balloon'?'legacy':'pressure');}
  }
  const l=base();for(const changes of [{rotationJitter:NaN},{kerningMode:'bad'},{minimumGlyphGap:-1},{glyphSeed:-1},{kerningStrength:101},{overlapAllowance:31}])assert.throws(()=>normalizeLayer({...l,...changes}));
  for(const kind of ['balloon','caption'])for(const changes of [{brushSeed:-1},{brushSeed:1.5},{brushTexture:101},{brushPressureVariation:NaN},{borderStyle:'bad'}])assert.throws(()=>normalizeLayer({...newLayer(kind,1000,750),...changes}));
});
test('copy, all-layer paste, preset and undo preserve parameters/seeds with gap scaling',()=>{
  const l={...base(),kerningStrength:90,minimumGlyphGap:4},b={...newLayer('caption',1000,750),borderStyle:'dry-brush',brushSeed:123,brushTexture:80},copy=scaledCopy(l,1000,750,500,1500);
  assert.equal(copy.minimumGlyphGap,2);assert.equal(copy.kerningStrength,90);assert.equal(copy.glyphSeed,123);
  const page={layers:[],undo:[],redo:[]};pasteLayers(copyLayers([l,b],1000,750),page,500,1500);assert.equal(page.layers[1].brushSeed,123);checkpoint(page);page.layers[1].brushTexture=0;restore(page,'undo');assert.equal(page.layers[1].brushTexture,80);restore(page,'redo');assert.equal(page.layers[1].brushTexture,0);
  for(const layer of [l,b]){const p=createPreset('新配置',layer,1000,750),target=applyPreset(newLayer(layer.kind,500,1500),p,500,1500);assert.equal(target[layer.kind==='sfx'?'glyphSeed':'brushSeed'],123);}
  const large=applyPreset(newLayer('sfx',30000,30000),createPreset('大判',l,1000,750),30000,30000);assert.equal(large.minimumGlyphGap,100);
  assert.ok(defaultPreferences().presets.some(p=>p.id==='sfx-dense'));assert.equal(defaultPreferences().defaults.sfx,'sfx-impact');
});
test('JSON and binary projects round-trip new placement and brush settings',async()=>{
  for(const format of ['json','serifu']){
    const layers=[{...base(),kerningStrength:90,rotationJitter:20},{...newLayer('balloon',1000,750),borderStyle:'dry-brush',brushSeed:0,brushTexture:85}],page={name:'test.png',img:{width:1000,height:750},file:new Blob(['png bytes'],{type:'image/png'}),src:'data:image/png;base64,AA==',layers,done:false};
    const result=await readProject(await projectBlob([page],defaultPreferences(),{format}));assert.equal(result.version,PROJECT_VERSION);
    assert.equal(result.pages[0].layers[0].rotationJitter,20);assert.equal(result.pages[0].layers[1].brushSeed,0);assert.equal(result.pages[0].layers[1].brushTexture,85);
  }
});
