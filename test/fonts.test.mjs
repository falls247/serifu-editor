import test from 'node:test';import assert from 'node:assert/strict';
import { FONT_CATALOG, fontDescription, fontKeys, fontLoadQueries, glyphFontDescription, clearFontCache } from '../fonts.js';
import { newLayer } from '../renderer.js';import { normalizeLayer } from '../model.js';
import { createPreset, applyPreset, normalizePreferences, defaultPreferences } from '../presets.js';
test('every selectable Japanese font survives project and default-preset restoration',()=>{
  for(const key of Object.keys(FONT_CATALOG)){
    const source={...newLayer('sfx',1000,750),font:key},restored=normalizeLayer(JSON.parse(JSON.stringify(source)),3);
    assert.equal(restored.font,key);
    const prefs=defaultPreferences(),preset=createPreset(key,source,1000,750);prefs.presets.push(preset);prefs.defaults.sfx=preset.id;
    const remembered=normalizePreferences(JSON.parse(JSON.stringify(prefs))),target=newLayer('sfx',1000,750);
    applyPreset(target,remembered.presets.find(p=>p.id===remembered.defaults.sfx),1000,750);assert.equal(target.font,key);
  }
  assert.throws(()=>normalizeLayer({...newLayer('sfx',1000,750),font:'missing-font'}));
});
test('bundled fonts use the actual static weight for preview and export',()=>{
  assert.equal(fontDescription({font:'hand',kind:'sfx'}).weight,600);
  assert.equal(fontDescription({font:'decorative',kind:'sfx'}).weight,700);
  assert.equal(fontDescription({font:'flowing',kind:'sfx'}).load,'400 64px MangaFlowing');
  assert.equal(fontDescription({font:'sans',kind:'dialogue'}).load,null);
});
test('bundled fonts prepare GEKIFUDE after the chosen font and before device fallbacks',()=>{
  for(const font of Object.keys(FONT_CATALOG).filter(key=>FONT_CATALOG[key].file&&key!=='gekifude')){
    assert.deepEqual(fontKeys({font}),[font,'gekifude']);
    assert.equal(fontLoadQueries({font}).at(-1),'400 64px MangaGekifude');
    assert.match(fontDescription({font}).family,/^"[^"]+", "MangaGekifude", /);
  }
  assert.deepEqual(fontKeys({font:'gekifude'}),['gekifude']);assert.deepEqual(fontKeys({font:'sans'}),[]);
});
test('visible mapped-but-empty glyphs use GEKIFUDE while supported characters and spaces retain their font',()=>{
  clearFontCache();let measurements=0;
  const ctx={font:'original',save(){this.previous=this.font;},restore(){this.font=this.previous;},measureText(char){measurements++;return {width:64,actualBoundingBoxLeft:0,actualBoundingBoxRight:char==='あ'?60:0,actualBoundingBoxAscent:char==='あ'?60:0,actualBoundingBoxDescent:0};}};
  const layer={font:'chikara',kind:'sfx'};
  for(const char of ['♥','♡'])assert.equal(glyphFontDescription(ctx,layer,char).family,fontDescription({...layer,font:'gekifude'}).family);
  assert.equal(glyphFontDescription(ctx,layer,'あ').family,fontDescription(layer).family);
  for(const char of [' ','\u200d','\ufe0f'])assert.equal(glyphFontDescription(ctx,layer,char).family,fontDescription(layer).family);
  assert.equal(ctx.font,'original');const count=measurements;glyphFontDescription(ctx,layer,'♥');assert.equal(measurements,count);
  clearFontCache();glyphFontDescription(ctx,layer,'♥');assert.equal(measurements,count+1);
});
