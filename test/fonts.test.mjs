import test from 'node:test';import assert from 'node:assert/strict';
import { FONT_CATALOG, fontDescription } from '../fonts.js';
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
