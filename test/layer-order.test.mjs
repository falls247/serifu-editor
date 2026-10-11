import test from 'node:test';
import assert from 'node:assert/strict';
import {newLayer,paintOrder,hit} from '../src/renderer.js';
import {PROJECT_VERSION,normalizeLayers,reorderLayers,checkpoint,restore,copyLayers,pasteSelectedLayers} from '../src/model.js';
import {createPreset,applyPreset,defaultPreferences,normalizePreferences} from '../src/presets.js';

const ids=layers=>layers.map(layer=>layer.id);
const kinds=layers=>layers.map(layer=>layer.kind);
const objects=()=>['balloon','sfx','dialogue','caption'].map(kind=>({...newLayer(kind,1000,750),id:kind,x:400,y:300}));

test('sound effects move above and below balloons, dialogue and captions',()=>{
  const layers=objects();
  assert.deepEqual(ids(reorderLayers(layers,['sfx'],'backward')),['sfx','balloon','dialogue','caption']);
  assert.deepEqual(ids(reorderLayers(layers,['balloon'],'forward')),['sfx','balloon','dialogue','caption']);
  const front=reorderLayers(layers,['sfx'],'frontmost');
  assert.deepEqual(ids(front),['balloon','dialogue','caption','sfx']);
  assert.equal(paintOrder(front).reverse().find(layer=>hit(layer,400,300)).id,'sfx');
  assert.deepEqual(ids(reorderLayers(front,['sfx'],'backmost')),['sfx','balloon','dialogue','caption']);
  assert.deepEqual(ids(layers),['balloon','sfx','dialogue','caption']);
});

test('multiple selections preserve relative order while moving one step or to either end',()=>{
  const layers=['a','b','c','d','e','f'].map(id=>({id}));
  const check=(selection,action,expected)=>assert.deepEqual(ids(reorderLayers(layers,selection,action)),expected.split(''));
  check(['b','c'],'forward','adbcef');
  check(['b','c'],'backward','bcadef');
  check(['b','d'],'forward','acbedf');
  check(['b','d'],'backward','badcef');
  check(['b','d'],'frontmost','acefbd');
  check(['b','d'],'backmost','bdacef');
  check(['e','f'],'forward','abcdef');
  check(['a','b'],'backward','abcdef');
  check([],'frontmost','abcdef');
});

test('ordering is restored with selection by undo/redo and retained by copying',()=>{
  const layers=objects(),page={layers,selectedId:'sfx',selectedIds:['sfx','caption'],undo:[],redo:[],done:true};
  checkpoint(page);page.layers=reorderLayers(page.layers,page.selectedIds,'backmost');
  assert.deepEqual(ids(page.layers),['sfx','caption','balloon','dialogue']);
  assert.equal(restore(page,'undo'),true);assert.deepEqual(ids(page.layers),ids(layers));assert.equal(page.done,true);
  assert.equal(restore(page,'redo'),true);assert.deepEqual(ids(page.layers),['sfx','caption','balloon','dialogue']);
  assert.deepEqual(page.selectedIds,['sfx','caption']);
  const copies=pasteSelectedLayers(copyLayers(page.layers,1000,750),500,1000);
  assert.deepEqual(kinds(copies),kinds(page.layers));
});

test('legacy pages migrate the effective drawing order once and drop sfxOrder',()=>{
  const [back,sfx,dialogue,caption]=objects(),front={...back,id:'front',sfxOrder:'above'};
  back.sfxOrder='behind';
  const layers=[caption,front,dialogue,sfx,back];
  for(const version of [5,9,10]){
    const migrated=normalizeLayers(layers,version);
    assert.deepEqual(kinds(migrated),['balloon','sfx','balloon','caption','dialogue']);
    assert.ok(migrated.every(layer=>!Object.hasOwn(layer,'sfxOrder')));
    const saved=JSON.parse(JSON.stringify(migrated));
    assert.deepEqual(kinds(normalizeLayers(saved,PROJECT_VERSION)),kinds(migrated));
  }
  assert.deepEqual(kinds(normalizeLayers([dialogue,back,sfx,caption],10)),['balloon','dialogue','sfx','caption']);
  assert.deepEqual(kinds(normalizeLayers(layers)),kinds(layers),'new projects must not apply legacy constraints');
  assert.equal(layers[1].sfxOrder,'above','migration must not mutate imported data');
  assert.throws(()=>normalizeLayers([{...back,sfxOrder:'invalid'}],10));
});

test('all legacy permutations preserve both relative ordering within groups and object count',()=>{
  const [back,sfx,dialogue,caption]=objects();back.shapeSeed=0;
  const front={...back,id:'front',shapeSeed:1,sfxOrder:'above'};
  const permutations=items=>items.length?items.flatMap((item,i)=>permutations(items.filter((_,j)=>i!==j)).map(rest=>[item,...rest])):[[]];
  const rank=layer=>layer===back?0:layer.kind==='sfx'?1:layer===front?2:3;
  for(const layers of permutations([back,front,sfx,dialogue,caption])){
    const expected=[...layers].sort((a,b)=>rank(a)-rank(b));
    assert.deepEqual(normalizeLayers(layers,10).map(layer=>[layer.kind,layer.shapeSeed]),expected.map(layer=>[layer.kind,layer.shapeSeed]));
  }
});

test('legacy presets ignore and discard obsolete ordering preferences',()=>{
  const balloon=newLayer('balloon',1000,750),preset=createPreset('旧吹き出し',balloon,1000,750);
  assert.equal(Object.hasOwn(preset.style,'sfxOrder'),false);
  preset.style.sfxOrder='above';
  applyPreset(balloon,preset,1000,750);assert.equal(Object.hasOwn(balloon,'sfxOrder'),false);
  const prefs=defaultPreferences();prefs.presets.push(preset);
  const restored=normalizePreferences(prefs).presets.find(p=>p.id===preset.id);
  assert.ok(restored);assert.equal(Object.hasOwn(restored.style,'sfxOrder'),false);
});
