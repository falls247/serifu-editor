import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultMaskEffect, PROJECT_VERSION } from '../src/model.js';
import { decodeMask, encodeMask } from '../src/mask-codec.js';
import { MAX_PROJECT_MASK_COMPRESSED_BYTES, MAX_PROJECT_MASK_DECODED_BYTES, projectBlob, readProject } from '../src/project-io.js';

const pixels = Uint8Array.from([1,1,0,0, 1,1,0,0, 0,0,0,0]);

function page(asset) {
  const image = new Blob([Uint8Array.from([0x89,0x50,0x4e,0x47])], { type: 'image/png' });
  const mask = { ...asset, id: 'mask-1' };
  return {
    id: 'page-1', name: 'test.png', src: 'data:image/png;base64,iVBORw==', assetBlob: image,
    img: { width: 4, height: 3 }, layers: [], imageEdit: null, done: false, edited: true,
    maskEffects: [defaultMaskEffect(mask, { id: 'effect-1', createdOrder: 0 })], maskAssets: { 'mask-1': mask },
  };
}

test('project JSON round-trips mask effects and checksummed payloads', async () => {
  const source = page(await encodeMask(pixels, 4, 3));
  const blob = await projectBlob([source], { theme: 'dark' }, { format: 'json' });
  const project = await readProject(blob);
  assert.equal(project.version, PROJECT_VERSION);
  assert.deepEqual(project.pages[0].expectedSize, { width: 4, height: 3 });
  assert.equal(project.pages[0].maskEffects[0].id, 'effect-1');
  assert.deepEqual([...decodeMask(project.pages[0].maskAssets['mask-1'])], [1,1,1,1]);

  const data = JSON.parse(await blob.text());
  data.pages[0].maskAssets['mask-1'].imageWidth = 5;
  await assert.rejects(readProject(new Blob([JSON.stringify(data)])), /寸法/);
});

test('shared text-mask ordering survives JSON and container saves, with v12 compatibility',async()=>{
  const source=page(await encodeMask(pixels,4,3));
  source.layers=[{id:'text',kind:'dialogue',layoutOrder:0}];source.maskEffects[0].layoutOrder=1;
  for(const format of ['json','serifu']){
    const restored=await readProject(await projectBlob([source],{},{format}));
    assert.equal(restored.pages[0].layers[0].layoutOrder,0);assert.equal(restored.pages[0].maskEffects[0].layoutOrder,1);
  }
  const old=JSON.parse(await (await projectBlob([source],{},{format:'json'})).text());old.version=12;
  await assert.rejects(readProject(new Blob([JSON.stringify(old)])),/未対応の重なり順/);
  delete old.pages[0].layers[0].layoutOrder;delete old.pages[0].maskEffects[0].layoutOrder;
  const restored=await readProject(new Blob([JSON.stringify(old)]));assert.equal(restored.version,12);assert.equal(restored.pages[0].maskEffects.length,1);
});

test('project export rejects asset map keys that disagree with asset IDs', async () => {
  const source = page(await encodeMask(pixels, 4, 3));
  source.maskAssets['mask-1'] = { ...source.maskAssets['mask-1'], id: 'different-id' };
  for (const format of ['json', 'serifu']) await assert.rejects(projectBlob([source], {}, { format }), /map keyとIDが一致/);
});

test('serifu container v2 keeps mask bytes outside the manifest and rejects corruption', async () => {
  const source = page(await encodeMask(pixels, 4, 3));
  const blob = await projectBlob([source], { theme: 'dark' });
  const project = await readProject(blob);
  assert.equal(project.pages[0].maskEffects[0].assetId, 'mask-1');
  assert.deepEqual([...decodeMask(project.pages[0].maskAssets['mask-1'])], [1,1,1,1]);

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const manifestLength = new DataView(bytes.buffer).getUint32(8, true);
  const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + manifestLength)));
  assert.equal(manifest.containerVersion, 2);
  assert.ok(!JSON.stringify(manifest).includes(maskAssetData(source.maskAssets['mask-1'])));
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(readProject(new Blob([bytes])), /checksum|bitpack|RLE/);
});

function maskAssetData(asset) { return Array.from(asset.data).join(','); }

test('legacy JSON versions load without mask state', async () => {
  const legacy = new Blob([JSON.stringify({ version: 11, preferences: {}, pages: [{ name: 'old.png', src: 'data:image/png;base64,iVBORw==', layers: [], done: true }] })], { type: 'application/json' });
  const project = await readProject(legacy);
  assert.deepEqual(project.pages[0].maskEffects, []);
  assert.deepEqual(project.pages[0].maskAssets, {});
  const silentDrop = new Blob([JSON.stringify({ version: 11, preferences: {}, pages: [{ name: 'old.png', src: 'data:image/png;base64,iVBORw==', layers: [], maskEffects: [] }] })], { type: 'application/json' });
  await assert.rejects(readProject(silentDrop), /未対応のマスク情報/);
});

test('project import enforces a decoded-mask aggregate cap before expansion', async () => {
  const assets = {};
  const count = Math.floor(MAX_PROJECT_MASK_DECODED_BYTES / 1_000_000) + 1;
  for (let index = 0; index < count; index++) assets[`mask-${index}`] = {
    id: `mask-${index}`, imageWidth: 1000, imageHeight: 1000, bbox: { x: 0, y: 0, width: 1000, height: 1000 },
    codec: 'rle32le-v1', byteLength: 8, sha256: 'a'.repeat(64), dataBase64: 'AAAAAAAAAAA=',
  };
  const input = new Blob([JSON.stringify({ version: PROJECT_VERSION, preferences: {}, pages: [{
    name: 'large.png', src: 'data:image/png;base64,iVBORw==', imageWidth: 1000, imageHeight: 1000, layers: [], maskEffects: [], maskAssets: assets,
  }] })]);
  await assert.rejects(readProject(input), /展開済みマスク総量が上限/);
});

test('project export preflights the referenced decoded-mask aggregate cap', async () => {
  const assets = {}, effects = [], count = Math.floor(MAX_PROJECT_MASK_DECODED_BYTES / 1_000_000) + 1;
  for (let index = 0; index < count; index++) {
    const id = `mask-${index}`;
    assets[id] = { id, imageWidth: 1000, imageHeight: 1000, bbox: { x: 0, y: 0, width: 1000, height: 1000 },
      codec: 'rle32le-v1', byteLength: 8, sha256: 'a'.repeat(64), data: new Uint8Array(8) };
    effects.push({ id: `effect-${index}`, kind: 'mask-effect', assetId: id, name: 'mask', createdOrder: index,
      visible: true, effect: 'fill-black', blockSize: 1, blurRadius: 0, marginPx: 0, x: 0, y: 0, w: 1000, h: 1000 });
  }
  const page = { name: 'large.png', src: 'data:image/png;base64,iVBORw==', assetBlob: new Blob(['png'], { type: 'image/png' }),
    img: { width: 1000, height: 1000 }, layers: [], maskEffects: effects, maskAssets: assets };
  await assert.rejects(projectBlob([page], {}, { format: 'json' }), /展開済みマスク総量が上限/);
});

test('project export preflights compressed-mask total before touching payloads', async () => {
  const assets = {}, effects = [], count = Math.floor(MAX_PROJECT_MASK_COMPRESSED_BYTES / (32 * 1024 ** 2)) + 1;
  for (let index = 0; index < count; index++) {
    const id = `mask-${index}`;
    assets[id] = { id, imageWidth: 10000, imageHeight: 1000, bbox: { x: 0, y: 0, width: 10000, height: 1000 },
      codec: 'rle32le-v1', byteLength: 32 * 1024 ** 2, sha256: 'a'.repeat(64), data: new Uint8Array(0) };
    effects.push({ id: `effect-${index}`, kind: 'mask-effect', assetId: id, name: 'mask', createdOrder: index,
      visible: true, effect: 'fill-black', blockSize: 1, blurRadius: 0, marginPx: 0, x: 0, y: 0, w: 10000, h: 1000 });
  }
  const page = { name: 'large.png', src: 'data:image/png;base64,iVBORw==', img: { width: 10000, height: 1000 }, layers: [], maskEffects: effects, maskAssets: assets };
  await assert.rejects(projectBlob([page], {}, { format: 'json' }), /圧縮マスク総量が上限/);
});

test('project import enforces a compressed-mask aggregate cap before decoding', async () => {
  const assets = {}, count = Math.floor(MAX_PROJECT_MASK_COMPRESSED_BYTES / (32 * 1024 ** 2)) + 1;
  for (let index = 0; index < count; index++) {
    const id = `mask-${index}`;
    assets[id] = { id, imageWidth: 10000, imageHeight: 1000, bbox: { x: 0, y: 0, width: 10000, height: 1000 },
      codec: 'rle32le-v1', byteLength: 32 * 1024 ** 2, sha256: 'a'.repeat(64), dataBase64: 'AA==' };
  }
  const input = new Blob([JSON.stringify({ version: PROJECT_VERSION, preferences: {}, pages: [{
    name: 'large.png', src: 'data:image/png;base64,iVBORw==', imageWidth: 10000, imageHeight: 1000,
    layers: [], maskEffects: [], maskAssets: assets,
  }] })]);
  await assert.rejects(readProject(input), /圧縮マスク総量が上限/);
});
