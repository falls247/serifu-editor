import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpoint, defaultMaskEffect, hasEdits, normalizeMaskEffects, pruneMaskAssets, restore, setSelection, syncSelection } from '../src/model.js';
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
