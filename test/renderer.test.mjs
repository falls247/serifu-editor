import test from 'node:test';
import assert from 'node:assert/strict';
import { hit, handleAt, exportName, newLayer } from '../renderer.js';
import { normalizeLayer, checkpoint, restore, swapText, copyToNext, copySelection, pasteSelection } from '../model.js';
import { glyphVariation } from '../ink.js';

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
test('selection clipboard keeps a snapshot and pastes independent styles at the target resolution',()=>{
  for(const kind of ['dialogue','sfx']){
    const original={...newLayer(kind,1000,750,'female'),text:'コピー',size:80,thickness:2.5,font:'train',blurX:12,blurY:40,dryInk:70};
    const clipboard=copySelection(original,1000,750);original.text='コピー後の変更';original.thickness=10;
    const target=page([]),copy=pasteSelection(clipboard,2000,750,20);
    checkpoint(target);target.layers.push(copy);
    assert.equal(copy.text,'コピー');assert.equal(copy.speaker,'female');assert.equal(copy.font,'train');assert.equal(copy.thickness,2.5);
    assert.equal(copy.x,clipboard.layer.x*2+20);assert.equal(copy.y,clipboard.layer.y+20);assert.equal(copy.w,clipboard.layer.w*2);
    assert.equal(copy.size,80);assert.equal(copy.blurX,24);assert.equal(copy.blurY,40);assert.equal(copy.dryInk,70);
    assert.notEqual(copy.id,original.id);copy.text='独立した編集';assert.equal(clipboard.layer.text,'コピー');
    const repeat=pasteSelection(clipboard,2000,750,40);assert.notEqual(repeat.id,copy.id);assert.equal(repeat.x,copy.x+20);
    restore(target,'undo');assert.equal(target.layers.length,0);restore(target,'redo');assert.equal(target.layers[0].text,'独立した編集');
  }
});
test('ink thickness restores, scales, and defaults to the original font for older projects',()=>{
  for(const thickness of [-1.5,0,4.5]){
    const layer={...newLayer('sfx',1000,750),thickness};
    assert.equal(normalizeLayer(JSON.parse(JSON.stringify(layer))).thickness,thickness);
    const source=page([layer]),target=page([]);copyToNext(source,target,1000,750,2000,1500);
    assert.equal(target.layers[0].thickness,thickness*2);
  }
  const old={...newLayer('dialogue',1000,750)};delete old.thickness;assert.equal(normalizeLayer(old,2).thickness,0);
  for(const thickness of [-11,31,NaN])assert.throws(()=>normalizeLayer({...old,thickness}));
});
test('letter variation and its seed survive restore, copy, and undo independently of regenerated layer IDs',()=>{
  const source={...newLayer('sfx',1000,750),sizeVariation:8.5,horizontalJitter:3.5,glyphSeed:123456};
  const pattern=layer=>Array.from({length:10},(_,i)=>glyphVariation(layer.glyphSeed,i,layer.sizeVariation,layer.horizontalJitter));
  const restored=normalizeLayer(JSON.parse(JSON.stringify(source)),3);
  assert.notEqual(restored.id,source.id);assert.deepEqual(pattern(restored),pattern(source));
  const pasted=pasteSelection(copySelection(source,1000,750),2000,1500);assert.deepEqual(pattern(pasted),pattern(source));
  const first=page([source]),next=page([]);copyToNext(first,next,1000,750,2000,1500);assert.deepEqual(pattern(next.layers[0]),pattern(source));
  checkpoint(first);first.layers[0].sizeVariation=12;restore(first,'undo');assert.deepEqual(pattern(first.layers[0]),pattern(restored));
  const old={...source};for(const key of ['sizeVariation','horizontalJitter','glyphSeed'])delete old[key];
  const a=normalizeLayer(old,2),b=normalizeLayer(old,2);assert.equal(a.sizeVariation,0);assert.equal(a.horizontalJitter,0);assert.equal(a.glyphSeed,b.glyphSeed);
  for(const change of [{sizeVariation:31},{horizontalJitter:-1},{horizontalJitter:21},{glyphSeed:1.2},{glyphSeed:-1},{glyphSeed:4294967296}])assert.throws(()=>normalizeLayer({...source,...change}));
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
