import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpoint, defaultMaskEffect, hasEdits, normalizeMaskEffects, normalizeLayer, pruneMaskAssets, restore, setSelection, syncSelection, reorderPageObjects, duplicateLayer } from '../src/model.js';
import {newLayer,paintOrder} from '../src/renderer.js';
import { encodeMask } from '../src/mask-codec.js';

test('mask effect metadata is validated and counts as an edit', async () => {
  const asset = await encodeMask(Uint8Array.from([1,0,0,0]), 2, 2, { id: 'asset' });
  const effect = defaultMaskEffect(asset, { id: 'effect', createdOrder: 0 });
  assert.deepEqual(normalizeMaskEffects([effect], 2, 2, new Set(['asset'])), [effect]);
  assert.throws(() => normalizeMaskEffects([{ ...effect, marginPx: 101 }], 2, 2, new Set(['asset'])), /範囲外/);
  assert.throws(() => normalizeMaskEffects([effect, effect], 2, 2, new Set(['asset'])), /重複/);
  assert.equal(hasEdits({ layers: [], imageEdit: null, maskEffects: [effect] }), true);
  assert.equal(hasEdits({ layers: [], imageEdit: null, maskEffects: [] }), false);
});

test('masks and text share all four ordering actions and undo selection',async()=>{
  const asset=await encodeMask(Uint8Array.from([1,0,0,0]),2,2,{id:'asset'});
  const mask=defaultMaskEffect(asset,{id:'mask'}),other=defaultMaskEffect(asset,{id:'other',createdOrder:1});
  const text={...newLayer('dialogue',100,100),id:'text'},caption={...newLayer('caption',100,100),id:'caption'};
  const page={layers:[text,caption],maskEffects:[mask,other],selectedMaskId:'mask',selectedId:null,selectedIds:[],undo:[],redo:[],maskAssets:{asset}};
  const order=p=>paintOrder(p.layers,p.maskEffects).map(object=>object.id);
  assert.deepEqual(order(page),['mask','other','text','caption'],'legacy masks remain behind text');
  for(const [action,expected] of [['forward',['other','mask','text','caption']],['frontmost',['other','text','caption','mask']],['backmost',['mask','other','text','caption']]]){
    const updated=reorderPageObjects(page,['mask'],action);
    if(updated)Object.assign(page,updated);assert.deepEqual(order(page),expected);
  }
  checkpoint(page);Object.assign(page,reorderPageObjects(page,['text'],'backmost'));
  assert.deepEqual(order(page),['text','mask','other','caption']);
  Object.assign(page,reorderPageObjects(page,['mask'],'backward'));
  assert.deepEqual(order(page),['mask','text','other','caption']);
  assert.equal(reorderPageObjects(page,['mask'],'backmost'),null,'endpoint does not add undo state');
  assert.equal(restore(page,'undo'),true);assert.deepEqual(order(page),['mask','other','text','caption']);assert.equal(page.selectedMaskId,'mask');
  assert.equal(restore(page,'redo'),true);assert.deepEqual(order(page),['mask','text','other','caption']);
  const copy=duplicateLayer(page.layers[0]);assert.equal(Object.hasOwn(copy,'layoutOrder'),false);
  page.layers.push(copy);assert.equal(paintOrder(page.layers,page.maskEffects).at(-1).id,copy.id,'copies are inserted at the front');
});

test('layout ranks survive normalization and reject invalid or older formats',async()=>{
  const text={...newLayer('dialogue',100,100),layoutOrder:7};
  assert.equal(normalizeLayer(text).layoutOrder,7);
  assert.throws(()=>normalizeLayer(text,12),/重なり順/);
  const asset=await encodeMask(Uint8Array.from([1,0,0,0]),2,2,{id:'asset'});
  const effect={...defaultMaskEffect(asset),layoutOrder:3};
  assert.equal(normalizeMaskEffects([effect],2,2,new Set(['asset']))[0].layoutOrder,3);
  for(const layoutOrder of [-1,NaN,0.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>normalizeMaskEffects([{...effect,layoutOrder}],2,2,new Set(['asset'])),/重なり順/);
  assert.throws(()=>normalizeMaskEffects([effect],2,2,new Set(['asset']),12),/重なり順/);
});

test('undo and redo restore only metadata, preserve referenced assets, and keep mask selection exclusive', async () => {
  const asset = await encodeMask(Uint8Array.from([1,0,0,0]), 2, 2, { id: 'asset' });
  const effect = defaultMaskEffect(asset, { id: 'effect', createdOrder: 0 });
  const page = { layers: [], maskEffects: [], maskAssets: {}, imageEdit: null, done: true, edited: false,
    selectedId: null, selectedIds: [], selectedMaskId: null, undo: [], redo: [] };
  checkpoint(page); page.maskAssets.asset = asset; page.maskEffects = [effect]; page.selectedMaskId = 'effect'; page.edited = hasEdits(page);
  assert.equal(JSON.stringify(page.undo).includes('decoded'), false);
  assert.equal(restore(page, 'undo'), true);
  assert.deepEqual(page.maskEffects, []); assert.equal(page.selectedMaskId, null); assert.ok(page.maskAssets.asset);
  assert.equal(restore(page, 'redo'), true);
  assert.deepEqual(page.maskEffects, [effect]); assert.equal(page.selectedMaskId, 'effect');
  syncSelection(page); assert.equal(page.selectedMaskId, 'effect'); assert.deepEqual(page.selectedIds, []);
  setSelection(page, []); assert.equal(page.selectedMaskId, null);

  checkpoint(page); page.maskEffects = []; page.selectedMaskId = null;
  assert.deepEqual(pruneMaskAssets(page), []); // undo snapshot still references the asset
  assert.equal(restore(page, 'undo'), true); assert.ok(page.maskAssets.asset);
});
