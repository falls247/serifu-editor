import test from 'node:test';import assert from 'node:assert/strict';
import {newLayer} from '../renderer.js';import {defaultPreferences,createPreset,applyPreset,normalizePreferences} from '../presets.js';
test('presets scale placement and typography while preserving text and speaker',()=>{
  const source={...newLayer('dialogue',1000,750),x:200,y:300,size:66,text:'保存しない文字'};
  const preset=createPreset('設定',source,1000,750),target=newLayer('dialogue',2000,1500,'female');target.text='今のセリフ';
  applyPreset(target,preset,2000,1500);assert.equal(target.x,400);assert.equal(target.y,600);assert.equal(target.size,132);assert.equal(target.text,'今のセリフ');assert.equal(target.speaker,'female');
});
test('custom presets and selected defaults round-trip without losing autosave interval',()=>{
  const prefs=defaultPreferences(),preset=createPreset('歪み', {...newLayer('sfx',1000,750),blur:4,distortion:70},1000,750);
  prefs.presets.push(preset);prefs.defaults.sfx=preset.id;prefs.autosave.minutes=.5;
  const restored=normalizePreferences(JSON.parse(JSON.stringify(prefs)));assert.equal(restored.defaults.sfx,preset.id);assert.equal(restored.autosave.minutes,.5);
  const applied=applyPreset(newLayer('sfx',1000,750),restored.presets.find(p=>p.id===preset.id),1000,750);assert.equal(applied.blur,4);assert.equal(applied.distortion,70);
});
test('fresh settings enable autosave every two minutes and ignore malformed presets',()=>{
  const prefs=normalizePreferences({version:1,presets:[null,{id:'bad',name:'bad',kind:'sfx',style:{}}],defaults:{sfx:'bad'}});
  assert.equal(prefs.autosave.enabled,true);assert.equal(prefs.autosave.minutes,2);assert.equal(prefs.defaults.sfx,'sfx-impact');
});
