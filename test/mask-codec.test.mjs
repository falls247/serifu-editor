import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assetFromEncoded, decodeMask, encodeMask, verifyMaskAsset } from '../src/mask-codec.js';

function deterministicMask(width, height) {
  const mask = new Uint8Array(width * height);
  let value = 0x12345678;
  for (let index = 0; index < mask.length; index++) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    mask[index] = (value >>> 29) === 0 ? 1 : 0;
  }
  return mask;
}

test('mask codec round-trips sparse, solid, and irregular bbox masks', async () => {
  for (const [width, height, source] of [
    [9, 7, Uint8Array.from({ length: 63 }, (_, i) => i === 31 ? 1 : 0)],
    [32, 32, new Uint8Array(1024).fill(1)],
    [37, 29, deterministicMask(37, 29)],
  ]) {
    const asset = await encodeMask(source, width, height);
    assert.deepEqual(decodeMask(asset), asset.decoded);
    assert.equal((await verifyMaskAsset(asset)).length, asset.bbox.width * asset.bbox.height);
    assert.equal(asset.sha256.length, 64);
  }
  assert.equal((await encodeMask(new Uint8Array(1024).fill(1), 32, 32)).codec, 'rle32le-v1');
  assert.equal((await encodeMask(Uint8Array.from({ length: 9 }, (_, i) => i === 4 ? 1 : 0), 3, 3)).bbox.width, 1);
});

test('mask codec rejects empty masks, corrupt payloads, checksum errors, and bad dimensions', async () => {
  await assert.rejects(encodeMask(new Uint8Array(16), 4, 4), /空マスク/);
  const asset = await encodeMask(Uint8Array.from({ length: 64 }, (_, i) => i % 7 === 0 ? 1 : 0), 8, 8);
  const corrupt = { ...asset, data: asset.data.slice() };
  corrupt.data[0] ^= 0x80;
  await assert.rejects(verifyMaskAsset(corrupt), /checksum|bitpack|RLE/);
  await assert.rejects(verifyMaskAsset(asset, { imageWidth: 9 }), /寸法/);
  assert.throws(() => decodeMask({ ...asset, bbox: { ...asset.bbox, width: 30001 } }), /幅/);
  const looseBbox = { ...asset, bbox: { x: 0, y: 0, width: 2, height: 2 }, codec: 'bitpack-lsb-v1', byteLength: 1, data: Uint8Array.of(1) };
  assert.throws(() => decodeMask(looseBbox), /bbox.*tight/);

  const bitpack = await encodeMask(Uint8Array.from({ length: 9 }, (_, i) => i === 0 ? 1 : 0), 3, 3);
  const badTail = { ...bitpack, data: bitpack.data.slice(), decoded: undefined };
  badTail.data[badTail.data.length - 1] |= 0x80;
  assert.throws(() => decodeMask(badTail), /未使用bit/);
});

test('JS codec matches the shared JS/Python bitpack and RLE fixtures', async () => {
  const fixtures = JSON.parse(await readFile(new URL('./fixtures/mask-codec.json', import.meta.url), 'utf8'));
  for (const fixture of fixtures) {
    const asset = await assetFromEncoded(fixture);
    assert.deepEqual([...decodeMask(asset)], fixture.decoded);
    assert.equal(asset.codec, fixture.codec);
    assert.equal(asset.sha256, fixture.sha256);
  }
});
