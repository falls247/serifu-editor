import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMask } from '../src/mask-codec.js';
import { adjustMaskMargin, transformMask } from '../src/mask-geometry.js';

test('mask transform uses original image coordinates and nearest-neighbor sampling', async () => {
  const source = Uint8Array.from([
    1,0, 0,1,
    0,1, 1,0,
  ]);
  const asset = await encodeMask(source, 4, 2);
  const same = transformMask(asset, { x: 0, y: 0, w: 4, h: 2 }, 4, 2);
  assert.deepEqual([...same.data], [...source]);
  const enlarged = transformMask(asset, { x: 1, y: 0, w: 8, h: 4 }, 10, 5);
  assert.equal(enlarged.x, 1); assert.equal(enlarged.y, 0); assert.equal(enlarged.width, 8); assert.equal(enlarged.height, 4);
  assert.deepEqual([...enlarged.data], [1,1,0,0,0,0,1,1, 1,1,0,0,0,0,1,1, 0,0,1,1,1,1,0,0, 0,0,1,1,1,1,0,0]);
});

test('Euclidean margin adjusts every time from immutable source and respects holes', () => {
  const mask = { x: 1, y: 1, width: 5, height: 5, data: Uint8Array.from({ length: 25 }, (_, index) => {
    const x = index % 5, y = Math.floor(index / 5);
    return x === 0 || x === 4 || y === 0 || y === 4 ? 1 : 0;
  }) };
  const expanded = adjustMaskMargin(mask, 1, 7, 7);
  assert.equal(expanded.data[(3 - expanded.y) * expanded.width + (3 - expanded.x)], 0);
  const reduced = adjustMaskMargin(mask, -1, 7, 7);
  assert.equal(reduced.data.length, 0);
  assert.deepEqual([...mask.data], Array.from({ length: 25 }, (_, index) => {
    const x = index % 5, y = Math.floor(index / 5); return x === 0 || x === 4 || y === 0 || y === 4 ? 1 : 0;
  }));
  assert.deepEqual(adjustMaskMargin(mask, 0, 7, 7).data, mask.data);
  const square = { x: 2, y: 2, width: 3, height: 3, data: new Uint8Array(9).fill(1) };
  const reducedSquare = adjustMaskMargin(square, -1, 7, 7);
  assert.deepEqual([reducedSquare.x, reducedSquare.y, reducedSquare.width, reducedSquare.height], [3,3,1,1]);
  assert.equal(reducedSquare.data[0], 1);
});

test('margin is bounded and rejects invalid bbox input', () => {
  assert.throws(() => adjustMaskMargin({ x: 0, y: 0, width: 1, height: 1, data: new Uint8Array([1]) }, 101, 2, 2), /範囲外/);
  assert.throws(() => adjustMaskMargin({ x: -1, y: 0, width: 1, height: 1, data: new Uint8Array([1]) }, 1, 2, 2), /bbox/);
});
