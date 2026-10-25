import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpoint, defaultMaskEffect, hasEdits, normalizeMaskEffects, normalizeLayer, pruneMaskAssets, restore, setSelection, syncSelection, reorderPageObjects, duplicateLayer, scaleMaskEffect, maskScaleLimit } from '../src/model.js';
import {newLayer,paintOrder} from '../src/renderer.js';
import { encodeMask } from '../src/mask-codec.js';

test('mask percentage scaling uses original dimensions, preserves center and clamps without stretching', () => {
  const asset = { bbox: { x: 30, y: 40, width: 80, height: 40 } };
  const effect = { x: 100, y: 100, w: 80, h: 40, marginPx: 7 };
  const large = scaleMaskEffect(effect, asset, 150, 400, 300);
  assert.deepEqual(large, { x: 80, y: 90, w: 120, h: 60, marginPx: 7 });
  assert.deepEqual(scaleMaskEffect(large, asset, 100, 400, 300), effect);
  assert.deepEqual(scaleMaskEffect(effect, asset, 50, 400, 300), { x: 120, y: 110, w: 40, h: 20, marginPx: 7 });
  const edge = scaleMaskEffect({ ...effect, x: 320, y: 260 }, asset, 200, 400, 300);
  assert.deepEqual(edge, { x: 240, y: 220, w: 160, h: 80, marginPx: 7 });
  assert.equal(maskScaleLimit(asset, 400, 300), 500);
  assert.deepEqual(scaleMaskEffect(effect, asset, 9999, 400, 300), { x: 0, y: 20, w: 400, h: 200, marginPx: 7 });
  const distorted = scaleMaskEffect({ ...effect, w: 120, h: 20 }, asset, 100, 400, 300);
  assert.equal(distorted.w, 80); assert.equal(distorted.h, 40);
  assert.throws(() => scaleMaskEffect(effect, asset, NaN, 400, 300), /倍率/);
});

test('mask scaling preserves integer dimensions and decoded area limit at extreme sizes', () => {
  for (const [width, height] of [[1, 1], [3, 7], [173, 129], [30000, 1]]) {
    const asset = { bbox: { width, height } }, effect = { x: 0, y: 0, w: width, h: height };
    for (const percent of [0, 1, 99.5, 100, 123.4, 1e9]) {
      const result = scaleMaskEffect(effect, asset, percent, 30000, 30000);
      assert.ok([result.x, result.y, result.w, result.h].every(Number.isSafeInteger));
      assert.ok(result.w > 0 && result.h > 0 && result.w * result.h <= 100_000_000);
      assert.ok(result.x >= 0 && result.x + result.w <= 30000 && result.y >= 0 && result.y + result.h <= 30000);
    }
  }
});

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
