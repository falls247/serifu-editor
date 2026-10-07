import test from 'node:test';
import assert from 'node:assert/strict';
import { hit, handleAt, exportName, newLayer } from '../renderer.js';
import { normalizeLayer, checkpoint, restore, swapText, copyToNext } from '../model.js';

const page = layers => ({ layers, done: false, selectedId: layers[0]?.id || null, undo: [], redo: [] });
test('rotation preserves pointer selection and handle coordinates', () => {
  const l = { x: 100, y: 100, w: 200, h: 40, rotation: 90 };
  assert.equal(hit(l, 100, 180), true);
  assert.equal(hit(l, 180, 100), false);
  assert.equal(handleAt(l, 80, 200), 'resize');
  assert.equal(handleAt(l, 144, 100), 'rotate');
});
test('exports distinguish identical basenames and sanitize filenames', () => {
  assert.equal(exportName('a:b.jpg', 0), '001_a_b.png');
  assert.notEqual(exportName('image.jpg', 0), exportName('image.png', 1));
});
test('old bubble projects become outlined male dialogue without losing text or position', () => {
  const old = { ...newLayer('dialogue', 1000, 800), kind: 'bubble', text: '旧セリフ', shape: 'ellipse', fill: '#ffffff', tailX: 80, tailY: 160 };
  const l = normalizeLayer(old, 1);
  assert.equal(l.kind, 'dialogue'); assert.equal(l.speaker, 'male');
  assert.equal(l.text, '旧セリフ'); assert.equal(l.x, old.x); assert.equal(l.y, old.y);
  assert.ok(l.outline > 0); assert.equal('shape' in l, false);
});
test('project validation rejects unknown speakers, effects, nonfinite coordinates and invalid outlines', () => {
  const l = newLayer('dialogue', 1000, 800, 'female');
  for (const invalid of [{ speaker: '__proto__' }, { effect: 'other' }, { x: NaN }, { outline: 0 }]) assert.throws(() => normalizeLayer({ ...l, ...invalid }));
  assert.equal(normalizeLayer(l).speaker, 'female');
});
test('swapping dialogue changes only text while preserving roles and positions', () => {
  const male = newLayer('dialogue', 1000, 800), female = newLayer('dialogue', 1000, 800, 'female');
  male.text = '男性'; female.text = '女性'; female.x = 800;
  const p = page([male, female]); assert.equal(swapText(p, male.id, female.id), true);
  assert.equal(male.text, '女性'); assert.equal(female.text, '男性');
  assert.equal(male.speaker, 'male'); assert.equal(female.speaker, 'female'); assert.equal(female.x, 800);
  restore(p, 'undo'); assert.equal(p.layers[0].text, '男性');
  restore(p, 'redo'); assert.equal(p.layers[0].text, '女性');
});
test('history remains independent when multiple images are edited consecutively', () => {
  const first = page([newLayer('dialogue', 1000, 800)]), second = page([newLayer('sfx', 1000, 800)]);
  checkpoint(first); first.layers[0].text = '一枚目';
  checkpoint(second); second.layers[0].x = 123;
  restore(first, 'undo'); assert.equal(first.layers[0].text, ''); assert.equal(second.layers[0].x, 123);
});
test('copying to a different image scales positions without sharing mutable layers', () => {
  const source = page([newLayer('dialogue', 1000, 800, 'female')]), target = page([]);
  source.layers[0].text = '続き'; copyToNext(source, target, 1000, 800, 2000, 1600);
  assert.equal(target.layers[0].x, source.layers[0].x * 2);
  assert.notEqual(target.layers[0].id, source.layers[0].id);
  target.layers[0].text = '変更'; assert.equal(source.layers[0].text, '続き');
  restore(target, 'undo'); assert.equal(target.layers.length, 0);
});

test('new dialogue and effects default to vertical writing',()=>{
  assert.equal(newLayer('dialogue',1000,750).vertical,true);
  assert.equal(newLayer('sfx',1000,750).vertical,true);
});
test('blur and distortion survive project restoration with range validation',()=>{
  const l={...newLayer('sfx',1000,750),blur:7,motionBlur:60,warp:'wave',distortion:80,skew:-25,stretchX:140};
  const restored=normalizeLayer(JSON.parse(JSON.stringify(l)),3);
  for(const key of ['blur','motionBlur','warp','distortion','skew','stretchX'])assert.equal(restored[key],l[key]);
  assert.throws(()=>normalizeLayer({...l,blur:100}));
});
test('directional blur and brush texture restore from projects, with backward-compatible defaults',()=>{
  const l={...newLayer('sfx',1000,750),font:'brush',effect:'tension',blurX:14,blurY:140,blurStrength:350,inkCore:65,roughness:60,dryInk:85,brushTails:90};
  const restored=normalizeLayer(JSON.parse(JSON.stringify(l)),3);
  for(const key of ['font','effect','blurX','blurY','blurStrength','inkCore','roughness','dryInk','brushTails'])assert.equal(restored[key],l[key]);
  for(const invalid of [{blurY:301},{dryInk:-1},{blurStrength:401}])assert.throws(()=>normalizeLayer({...l,...invalid}));
  const old={...l};for(const key of ['blurX','blurY','blurStrength','inkCore','roughness','dryInk','brushTails'])delete old[key];
  assert.equal(normalizeLayer(old,3).blurY,0);assert.equal(normalizeLayer(old,3).dryInk,0);
});
