import test from 'node:test';import assert from 'node:assert/strict';
import {newLayer} from '../src/renderer.js';import {defaultPreferences,createPreset,applyPreset,normalizePreferences} from '../src/presets.js';
test('presets scale dimensions and typography while preserving XY and text and applying the saved speaker',()=>{
  const source={...newLayer('dialogue',1000,750),x:200,y:300,size:66,text:'保存しない文字'};
  const preset=createPreset('設定',source,1000,750),target={...newLayer('dialogue',2000,1500,'female'),x:123,y:456};target.text='今のセリフ';
  applyPreset(target,preset,2000,1500);assert.equal(target.x,123);assert.equal(target.y,456);assert.equal(target.size,132);assert.equal(target.text,'今のセリフ');assert.equal(target.speaker,'male');
});
test('all preset kinds omit XY, ignore legacy positions and strip them when preferences are restored',()=>{
  for(const kind of ['dialogue','sfx','balloon','caption']){
    const source={...newLayer(kind,1000,750),x:110,y:220},preset=createPreset('位置を保存しない',source,1000,750);
    for(const key of ['x','y','xRatio','yRatio'])assert.equal(Object.hasOwn(preset.style,key),false);
    preset.style.xRatio=.11;preset.style.yRatio=.22;preset.style.x=110;preset.style.y=220;
    const target={...newLayer(kind,2000,1500),x:-12.25,y:987.75,text:'現在の本文'};
    applyPreset(target,preset,2000,1500);assert.equal(target.x,-12.25);assert.equal(target.y,987.75);assert.equal(target.text,'現在の本文');
    const prefs=defaultPreferences();prefs.presets.push(preset);
    const restored=normalizePreferences(prefs).presets.find(p=>p.id===preset.id);
    assert.ok(restored);for(const key of ['x','y','xRatio','yRatio'])assert.equal(Object.hasOwn(restored.style,key),false);
    assert.equal(preset.style.xRatio,.11,'normalization does not mutate supplied preferences');
    for(const builtin of defaultPreferences().presets.filter(p=>p.kind===kind)){
      applyPreset(target,builtin,2000,1500);assert.equal(target.x,-12.25);assert.equal(target.y,987.75);
    }
  }
});
test('custom presets and selected defaults round-trip without losing autosave interval',()=>{
  const prefs=defaultPreferences(),preset=createPreset('歪み', {...newLayer('sfx',1000,750),blur:4,distortion:70},1000,750);
  prefs.presets.push(preset);prefs.defaults.sfx=preset.id;prefs.autosave.minutes=.5;
  const restored=normalizePreferences(JSON.parse(JSON.stringify(prefs)));assert.equal(restored.defaults.sfx,preset.id);assert.equal(restored.autosave.minutes,.5);
  const applied=applyPreset(newLayer('sfx',1000,750),restored.presets.find(p=>p.id===preset.id),1000,750);assert.equal(applied.blur,4);assert.equal(applied.distortion,70);
});
test('font size memory defaults to 70px and normalizes saved settings without requiring legacy fields',()=>{
  assert.equal(defaultPreferences().fontSizePreset,70);
  assert.equal(normalizePreferences({version:1}).fontSizePreset,70);
  assert.equal(normalizePreferences({...defaultPreferences(),fontSizePreset:82}).fontSizePreset,82);
  assert.equal(normalizePreferences({...defaultPreferences(),fontSizePreset:82.4}).fontSizePreset,82);
  for(const value of [null,'70',NaN,Infinity,7,501])assert.equal(normalizePreferences({...defaultPreferences(),fontSizePreset:value}).fontSizePreset,70);
  for(const value of [8,500])assert.equal(normalizePreferences({...defaultPreferences(),fontSizePreset:value}).fontSizePreset,value);
});
test('fresh settings enable autosave every two minutes and ignore malformed presets',()=>{
  const prefs=normalizePreferences({version:1,presets:[null,{id:'bad',name:'bad',kind:'sfx',style:{}}],defaults:{sfx:'bad'}});
  assert.equal(prefs.autosave.enabled,true);assert.equal(prefs.autosave.minutes,2);assert.equal(prefs.defaults.sfx,'sfx-impact');
});
test('brush presets retain texture and scale directional blur independently on non-square images',()=>{
  const source={...newLayer('sfx',1000,750),font:'brush',blurX:20,blurY:40,dryInk:85,brushTails:75,inkCore:65};
  const preset=createPreset('筆の掠れ',source,1000,750),target=newLayer('sfx',2000,750);
  applyPreset(target,preset,2000,750);
  assert.equal(target.blurX,40);assert.equal(target.blurY,40);
  for(const key of ['font','dryInk','brushTails','inkCore'])assert.equal(target[key],source[key]);
  const legacy=createPreset('旧プリセット',source,1000,750);
  for(const key of ['blurXRatio','blurYRatio','blurStrength','inkCore','roughness','dryInk','brushTails'])delete legacy.style[key];
  applyPreset(target,legacy,1000,750);assert.equal(target.blurY,0);assert.equal(target.dryInk,0);
});
test('balloon presets scale text styling and apply the saved speaker while keeping the current speech',()=>{
  const source={...newLayer('balloon',1000,750),text:'残すセリフ',speaker:'male',size:60,outline:8,thickness:2.5,font:'hand',vertical:false};
  const preset=createPreset('吹き出し文字',source,1000,750),target={...newLayer('balloon',2000,1500),text:'貼付先のセリフ',speaker:'female'};
  applyPreset(target,preset,2000,1500);
  assert.equal(target.text,'貼付先のセリフ');assert.equal(target.speaker,'male');assert.equal(target.size,120);assert.equal(target.outline,16);assert.equal(target.thickness,5);assert.equal(target.font,'hand');assert.equal(target.vertical,false);
});
test('older balloon presets without speech styles remain valid and preserve current speech settings',()=>{
  const old={...createPreset('旧吹き出し',newLayer('balloon',1000,750),1000,750)};
  for(const key of ['sizeRatio','outlineRatio','thicknessRatio'])delete old.style[key];delete old.style.font;delete old.style.vertical;delete old.style.speaker;
  const prefs=defaultPreferences();prefs.presets.push(old);
  const remembered=normalizePreferences(JSON.parse(JSON.stringify(prefs))).presets.find(p=>p.id===old.id);
  assert.ok(remembered);
  const target={...newLayer('balloon',1000,750),text:'現在のセリフ',speaker:'female',size:73,font:'round',vertical:false};
  applyPreset(target,remembered,1000,750);
  assert.equal(target.text,'現在のセリフ');assert.equal(target.speaker,'female');assert.equal(target.size,73);assert.equal(target.font,'round');assert.equal(target.vertical,false);
});
test('balloon presets clamp text settings for very small and very large pages',()=>{
  const source={...newLayer('balloon',1000,750),size:100,outline:3,thickness:20};
  const preset=createPreset('寸法範囲外の吹き出し',source,1000,750);
  const small=newLayer('balloon',30,30);applyPreset(small,preset,30,30);
  assert.equal(small.size,8);assert.equal(small.outline,.12);assert.ok(small.thickness>=-10&&small.thickness<=30);
  const large=newLayer('balloon',30000,30000);applyPreset(large,preset,30000,30000);
  assert.equal(large.size,500);assert.equal(large.outline,80);assert.equal(large.thickness,30);
});
test('numeric ink thickness is a preset setting with compatible defaults and bounded scaling',()=>{
  const source={...newLayer('dialogue',1000,750),thickness:-2.5},preset=createPreset('細いセリフ',source,1000,750);
  const target=applyPreset(newLayer('dialogue',2000,1500),preset,2000,1500);assert.equal(target.thickness,-5);
  delete preset.style.thicknessRatio;applyPreset(target,preset,1000,750);assert.equal(target.thickness,0);
  source.thickness=20;const thick=createPreset('太いセリフ',source,1000,750);applyPreset(target,thick,4000,3000);assert.equal(target.thickness,30);
});
test('user lettering presets save variation percentages and the fixed layout seed',()=>{
  const source={...newLayer('sfx',1000,750),sizeVariation:8.5,horizontalJitter:3.5,glyphSeed:123456};
  const preset=createPreset('手描き',source,1000,750),prefs=defaultPreferences();prefs.presets.push(preset);prefs.defaults.sfx=preset.id;
  const remembered=normalizePreferences(JSON.parse(JSON.stringify(prefs))).presets.find(p=>p.id===preset.id);
  const target={...newLayer('sfx',2000,1500),glyphSeed:654321};applyPreset(target,remembered,2000,1500);
  assert.equal(target.sizeVariation,8.5);assert.equal(target.horizontalJitter,3.5);assert.equal(target.glyphSeed,123456);
  delete remembered.style.sizeVariation;delete remembered.style.horizontalJitter;applyPreset(target,remembered,1000,750);
  assert.equal(target.sizeVariation,0);assert.equal(target.horizontalJitter,0);
});
test('male and female speech presets retain their speaker and automatic color through preference round-trips',()=>{
  for(const kind of ['dialogue','balloon'])for(const speaker of ['male','female']){
    const source={...newLayer(kind,1000,750,speaker),text:'保存元の本文'},preset=createPreset('話者',source,1000,750);
    const prefs=defaultPreferences();prefs.presets.push(preset);prefs.defaults[kind]=preset.id;
    const restored=normalizePreferences(JSON.parse(JSON.stringify(prefs))),remembered=restored.presets.find(p=>p.id===preset.id);
    assert.equal(restored.defaults[kind],preset.id);assert.equal(remembered.style.speaker,speaker);
    const target={...newLayer(kind,1000,750,speaker==='male'?'female':'male'),text:'適用先の本文'};
    applyPreset(target,remembered,1000,750);assert.equal(target.speaker,speaker);assert.equal(target.text,'適用先の本文');assert.equal(target.textColor,null);
    remembered.style.speaker='unknown';assert.equal(normalizePreferences(restored).presets.some(p=>p.id===preset.id),false);
  }
});
test('built-in and legacy speech presets preserve the current speaker',()=>{
  for(const kind of ['dialogue','balloon']){
    const target=newLayer(kind,1000,750,'female'),prefs=defaultPreferences();
    for(const preset of prefs.presets.filter(p=>p.kind===kind)){
      assert.equal(preset.style.speaker,undefined);applyPreset(target,preset,1000,750);assert.equal(target.speaker,'female');
    }
    const legacy=createPreset('旧設定',newLayer(kind,1000,750),1000,750);delete legacy.style.speaker;
    prefs.presets.push(legacy);const remembered=normalizePreferences(JSON.parse(JSON.stringify(prefs))).presets.find(p=>p.id===legacy.id);
    assert.ok(remembered);applyPreset(target,remembered,1000,750);assert.equal(target.speaker,'female');
  }
});
