import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMask } from '../src/mask-codec.js';
import { applyMaskEffectsToImageData } from '../src/mask-effects.js';

function rgba(width, height, colorAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([...colorAt(x, y), 255], (y * width + x) * 4);
  return data;
}
function effect(id, asset, fields) {
  return { id, kind: 'mask-effect', assetId: asset.id, createdOrder: 0, visible: true, effect: 'fill-black',
    blockSize: 20, blurRadius: 12, marginPx: 0, x: asset.bbox.x, y: asset.bbox.y, w: asset.bbox.width, h: asset.bbox.height, ...fields };
}

test('overlapping effects use original pixels and later effects win only inside their masks', async () => {
  const width = 4, height = 2, source = rgba(width, height, (x, y) => [x * 40, y * 80, 17]);
  const firstBits = Uint8Array.from([1,1,0,0, 1,1,0,0]), secondBits = Uint8Array.from([0,1,0,0, 0,1,0,0]);
  const first = await encodeMask(firstBits, width, height), second = await encodeMask(secondBits, width, height);
  const firstEffect = effect('a', first, { effect: 'fill-black', createdOrder: 1 });
  const secondEffect = effect('b', second, { effect: 'fill-white', createdOrder: 2 });
  const output = applyMaskEffectsToImageData(source, width, height, [secondEffect, firstEffect], { [first.id]: first, [second.id]: second });
  assert.deepEqual([...output.slice(0, 4)], [0, 0, 0, 255]);
  assert.deepEqual([...output.slice(4, 8)], [255, 255, 255, 255]);
  assert.deepEqual([...output.slice(8, 12)], [...source.slice(8, 12)]);
  assert.deepEqual([...source.slice(0, 12)], [0,0,17,255,40,0,17,255,80,0,17,255]);
});

test('pixelation follows the original image grid and leaves pixels outside the mask unchanged', async () => {
  const width = 4, source = rgba(width, 2, x => [x * 30, x * 30, x * 30]);
  const bits = Uint8Array.from([0,0,1,0, 0,0,1,0]), asset = await encodeMask(bits, width, 2);
  const pixels = applyMaskEffectsToImageData(source, width, 2, [effect('pixel', asset, { effect: 'pixelate', blockSize: 2 })], { [asset.id]: asset });
  assert.deepEqual([...pixels.slice(8, 12)], [75, 75, 75, 255]);
  assert.deepEqual([...pixels.slice(4, 8)], [...source.slice(4, 8)]);
});

test('blur radius zero is a no-op; positive blur changes only masked pixels', async () => {
  const width = 5, height = 3, source = rgba(width, height, (x, y) => [x === 2 && y === 1 ? 255 : 0, 0, 0]);
  const bits = Uint8Array.from({ length: width * height }, (_, i) => i === 7 ? 1 : 0), asset = await encodeMask(bits, width, height);
  const base = effect('blur', asset, { effect: 'blur', blurRadius: 0 });
  assert.deepEqual(applyMaskEffectsToImageData(source, width, height, [base], { [asset.id]: asset }), source);
  const blurred = applyMaskEffectsToImageData(source, width, height, [{ ...base, blurRadius: 1 }], { [asset.id]: asset });
  assert.notDeepEqual([...blurred.slice(7 * 4, 7 * 4 + 4)], [...source.slice(7 * 4, 7 * 4 + 4)]);
  for (let i = 0; i < width * height; i++) if (i !== 7) assert.deepEqual([...blurred.slice(i * 4, i * 4 + 4)], [...source.slice(i * 4, i * 4 + 4)]);
});

test('zero-radius blur restores moved and expanded mask pixels from source after earlier effects', async () => {
  const width = 7, height = 1, source = rgba(width, height, x => [20 + x * 20, 90 - x * 7, 170 - x * 11]);
  source.set([41, 52, 63, 73], 3 * 4);
  source.set([200, 80, 30, 0], 5 * 4);
  const blackBits = Uint8Array.from([0,1,1,1,1,0,0]);
  const movedBits = Uint8Array.from([1,0,1]);
  const hiddenBits = Uint8Array.from([1]);
  const black = await encodeMask(blackBits, width, height), moved = await encodeMask(movedBits, 3, height), hidden = await encodeMask(hiddenBits, 1, height);
  const effects = [
    effect('black-first', black, { effect: 'fill-black', createdOrder: 1 }),
    effect('restore-second', moved, { effect: 'blur', blurRadius: 0, createdOrder: 2, x: 3, y: 0, w: 3, h: 1, marginPx: 1 }),
    effect('hidden-third', hidden, { effect: 'blur', blurRadius: 0, createdOrder: 3, visible: false, x: 1, y: 0, w: 1, h: 1 }),
  ];
  const output = applyMaskEffectsToImageData(source, width, height, effects,
    { [black.id]: black, [moved.id]: moved, [hidden.id]: hidden });

  assert.deepEqual([...output.slice(1 * 4, 1 * 4 + 4)], [0, 0, 0, 255], 'B hole and hidden effect leave A visible');
  for (const x of [2, 3, 4, 5, 6]) {
    assert.deepEqual([...output.slice(x * 4, x * 4 + 4)], [...source.slice(x * 4, x * 4 + 4)], `blur zero restores source RGBA at x=${x}`);
  }
});

test('blur and pixelation average transparent pixels in premultiplied alpha', async () => {
  const width = 2, height = 1, source = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]);
  const bits = Uint8Array.from([1, 0]), asset = await encodeMask(bits, width, height);
  for (const [name, fields] of [['blur', { effect: 'blur', blurRadius: 1 }], ['pixelate', { effect: 'pixelate', blockSize: 2 }]]) {
    const output = applyMaskEffectsToImageData(source, width, height, [effect(name, asset, fields)], { [asset.id]: asset });
    assert.deepEqual([...output.slice(0, 4)], [255, 0, 0, 128], `${name} should keep red saturated at half alpha`);
    assert.deepEqual([...output.slice(4, 8)], [...source.slice(4, 8)], `${name} must leave pixels outside the mask unchanged`);
  }
});

test('blur at image edges does not introduce a dark halo', async () => {
  const source = rgba(3, 3, () => [120, 80, 40]), bits = Uint8Array.from([1,0,0, 0,0,0, 0,0,0]);
  const asset = await encodeMask(bits, 3, 3), maskEffect = effect('edge-blur', asset, { effect: 'blur', blurRadius: 5 });
  const result = applyMaskEffectsToImageData(source, 3, 3, [maskEffect], { [asset.id]: asset });
  assert.deepEqual([...result.slice(0, 4)], [120, 80, 40, 255]);
});

test('selected draft candidates render after committed effects and hidden masks are skipped', async () => {
  const source = rgba(2, 1, () => [30, 40, 50]);
  const bits = Uint8Array.from([1,0]), asset = await encodeMask(bits, 2, 1);
  const committed = effect('saved', asset, { effect: 'fill-black', visible: false });
  const result = applyMaskEffectsToImageData(source, 2, 1, [committed], {}, {
    draft: { candidates: [{ id: 'candidate', selected: true, mask: asset }], effect: 'fill-white', blockSize: 20, blurRadius: 12 },
  });
  assert.deepEqual([...result.slice(0, 4)], [255,255,255,255]);
  assert.deepEqual([...result.slice(4, 8)], [...source.slice(4, 8)]);
});
