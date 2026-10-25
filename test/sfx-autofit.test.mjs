import test from 'node:test';
import assert from 'node:assert/strict';
import {newLayer} from '../src/renderer.js';
import {normalizeLayer,PROJECT_VERSION,duplicateLayer} from '../src/model.js';

test('効果音のAutoFitは既定OFF、旧データを維持しONを保存復元する',()=>{
  const layer=newLayer('sfx',1000,750);
  assert.equal(layer.autoFit,false);
  const legacy={...layer};delete legacy.autoFit;
  assert.equal(normalizeLayer(legacy,PROJECT_VERSION).autoFit,false);
  const restored=normalizeLayer(JSON.parse(JSON.stringify({...layer,autoFit:true})),PROJECT_VERSION);
  assert.equal(restored.autoFit,true);
  assert.equal(restored.size,layer.size);
  assert.equal(duplicateLayer(restored).autoFit,true);
  for(const autoFit of ['true',1,null])assert.throws(()=>normalizeLayer({...layer,autoFit},PROJECT_VERSION));
});

test('セリフの描画設定に効果音のAutoFitを追加しない',()=>{
  const dialogue=newLayer('dialogue',1000,750);
  assert.equal(Object.hasOwn(dialogue,'autoFit'),false);
  assert.equal(Object.hasOwn(normalizeLayer({...dialogue,autoFit:true},PROJECT_VERSION),'autoFit'),false);
});
