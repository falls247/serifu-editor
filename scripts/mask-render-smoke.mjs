import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';

const { chromium } = createRequire(import.meta.url)('playwright');
const port = 5251;
const server = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'],
});
let browser;

function comparePixels(reference, actual, label) {
  assert.deepEqual([actual.width, actual.height], [reference.width, reference.height], `${label}: dimensions`);
  assert.equal(actual.data.length, reference.data.length, `${label}: RGBA length`);
  let firstDifference = -1;
  for (let index = 0; index < reference.data.length; index++) {
    if (reference.data[index] !== actual.data[index]) { firstDifference = index; break; }
  }
  assert.equal(firstDifference, -1, `${label}: first differing byte ${firstDifference}`);
}

try {
  await Promise.race([
    once(server.stdout, 'data'),
    once(server, 'exit').then(() => { throw new Error('Mask render server failed to start'); }),
  ]);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  await page.uncheck('#autosaveEnabled');

  const projectText = await page.evaluate(async () => {
    const width = 64, height = 48;
    const { encodeMask, maskAssetMetadata, maskBytesToBase64 } = await import('/src/mask-codec.js');
    const { applyMaskEffectsToImageData } = await import('/src/mask-effects.js');
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      rgba.set([(x * 31 + y * 13) & 255, (x * 7 + y * 47) & 255, ((x * 17) ^ (y * 29)) & 255, 255], (y * width + x) * 4);
    }
    const source = document.createElement('canvas'); source.width = width; source.height = height;
    source.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
    const src = source.toDataURL('image/png');
    const makeAsset = async (id, included) => {
      const bits = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (included(x, y)) bits[y * width + x] = 1;
      return encodeMask(bits, width, height, { id });
    };
    const assets = {
      pixel: await makeAsset('pixel', (x, y) => x >= 3 && x <= 12 && y >= 3 && y <= 12),
      blur: await makeAsset('blur', (x, y) => x >= 30 && x <= 40 && y >= 3 && y <= 13),
      black: await makeAsset('black', (x, y) => x >= 3 && x <= 49 && y >= 24 && y <= 42
        && !(x >= 8 && x <= 12 && y >= 33 && y <= 37)),
      white: await makeAsset('white', (x, y) => x >= 43 && x <= 62 && y >= 22 && y <= 42),
    };
    const effect = (id, asset, fields) => ({ id: `${id}-effect`, kind: 'mask-effect', assetId: asset.id,
      name: id, createdOrder: fields.createdOrder, visible: true, effect: fields.effect,
      blockSize: fields.blockSize ?? 3, blurRadius: fields.blurRadius ?? 4, marginPx: fields.marginPx ?? 0,
      x: fields.x ?? asset.bbox.x, y: fields.y ?? asset.bbox.y, w: fields.w ?? asset.bbox.width, h: fields.h ?? asset.bbox.height });
    const effects = [
      effect('pixel', assets.pixel, { effect: 'pixelate', createdOrder: 0, x: 18, y: 3, w: 10, h: 10, marginPx: 1 }),
      effect('blur', assets.blur, { effect: 'blur', createdOrder: 1 }),
      effect('black', assets.black, { effect: 'fill-black', createdOrder: 2 }),
      effect('white', assets.white, { effect: 'fill-white', createdOrder: 3, marginPx: -1 }),
    ];
    const assetJSON = Object.fromEntries(Object.entries(assets).map(([id, asset]) => [id,
      { ...maskAssetMetadata(asset), dataBase64: maskBytesToBase64(asset.data) }]));
    const crop = { x: 3, y: 2, width: 58, height: 44 };
    window.__maskRenderFixture = { width, height, rgba: Array.from(rgba), src, assets, effects, crop };
    const semanticInput = new ImageData(new Uint8ClampedArray(rgba), width, height), sourceBytesBefore = Array.from(semanticInput.data);
    const semantic = applyMaskEffectsToImageData(semanticInput, width, height, effects, assets);
    const pixelAt = (data, x, y) => Array.from(data.slice((y * width + x) * 4, (y * width + x) * 4 + 4));
    const same = (a, b) => a.every((value, index) => value === b[index]);
    const blurChanged = (() => { for (let y = 3; y <= 13; y++) for (let x = 30; x <= 40; x++) if (!same(pixelAt(semantic, x, y), pixelAt(rgba, x, y))) return true; return false; })();
    const checks = {
      movedOldLocationUnchanged: same(pixelAt(semantic, 5, 5), pixelAt(rgba, 5, 5)),
      movedTargetChanged: !same(pixelAt(semantic, 20, 5), pixelAt(rgba, 20, 5)),
      pixelatedTileUniform: same(pixelAt(semantic, 18, 3), pixelAt(semantic, 20, 5)),
      positiveMarginNeighborChanged: !same(pixelAt(semantic, 17, 7), pixelAt(rgba, 17, 7)),
      holePreserved: same(pixelAt(semantic, 10, 35), pixelAt(rgba, 10, 35)),
      blurChanged,
      black: same(pixelAt(semantic, 4, 25), [0, 0, 0, 255]),
      white: same(pixelAt(semantic, 60, 30), [255, 255, 255, 255]),
      overlapLaterWins: same(pixelAt(semantic, 45, 30), [255, 255, 255, 255]),
      sourceRetained: semanticInput.data.every((value, index) => value === sourceBytesBefore[index]),
    };
    for (const [name, passed] of Object.entries(checks)) if (!passed) throw new Error(`Semantic compositor assertion failed: ${name}`);
    const pages = [0, 90, 180, 270].map(rotation => ({ name: `mask-${rotation}.png`, src, imageWidth: width, imageHeight: height,
      layers: [], done: false, edited: true, imageEdit: { rotation, crop }, maskEffects: effects, maskAssets: assetJSON }));
    return JSON.stringify({ version: 12, preferences: {}, pages });
  });

  await page.locator('#projectInput').setInputFiles({ name: 'mask-render.json', mimeType: 'application/json', buffer: Buffer.from(projectText) });
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.image-row')];
    const dimensions = [[58,44],[44,58],[58,44],[44,58]];
    return rows.length === 4 && rows.every((row,index) => {
      const canvas = row.querySelector('canvas.preview'), image = row.querySelector('img.original');
      return canvas?.width === dimensions[index][0] && canvas?.height === dimensions[index][1] && image?.complete && image.naturalWidth === 64;
    });
  });
  await page.evaluate(() => document.fonts.ready);

  const renderDirect = async index => page.evaluate(async index => {
    const fixture = window.__maskRenderFixture;
    const { draw } = await import('/src/renderer.js');
    const { imageSize } = await import('/src/image-edit.js');
    const image = new Image(); image.src = fixture.src; await image.decode();
    const imageEdit = { rotation: [0, 90, 180, 270][index], crop: fixture.crop };
    const size = imageSize(fixture.width, fixture.height, imageEdit), canvas = document.createElement('canvas');
    canvas.width = size.width; canvas.height = size.height;
    draw(canvas.getContext('2d'), image, [], null, 1, 1, imageEdit, { width: fixture.width, height: fixture.height },
      { maskEffects: fixture.effects, maskAssets: fixture.assets });
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, data: Array.from(pixels.data) };
  }, index);

  const renderWorker = async (index, draft = null) => page.evaluate(async ({ index, draft }) => {
    const fixture = window.__maskRenderFixture;
    const { ImagePool } = await import('/src/bulk-pool.js');
    const pool = window.__maskRenderPool ??= new ImagePool({ size: 1 });
    const blob = await (await fetch(fixture.src)).blob();
    const png = await pool.run('render-png', { blob, width: fixture.width, height: fixture.height, layers: [],
      imageEdit: { rotation: [0, 90, 180, 270][index], crop: fixture.crop }, maskEffects: fixture.effects, maskAssets: fixture.assets, draft }, undefined,
    () => { throw new Error(`Image Worker unavailable: ${pool.metrics.reasons.join('; ')}`); });
    const bitmap = await createImageBitmap(png), canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, data: Array.from(pixels.data), jobs: pool.metrics.jobs, fallbackJobs: pool.metrics.fallbackJobs };
  }, { index, draft });

  const outputs = [];
  for (let index = 0; index < 4; index++) {
    const row = page.locator('.image-row').nth(index);
    await row.scrollIntoViewIfNeeded();
    const main = await row.locator('canvas.preview').evaluate(canvas => {
      const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      return { width: canvas.width, height: canvas.height, data: Array.from(image.data) };
    });
    const direct = await renderDirect(index);
    comparePixels(direct, main, `main renderer rotation ${[0, 90, 180, 270][index]}`);
    const worker = await renderWorker(index);
    comparePixels(direct, worker, `Image Worker PNG rotation ${[0, 90, 180, 270][index]}`);
    assert.ok(worker.jobs > 0 && worker.fallbackJobs === 0, 'PNG output must come from image-worker');

    await row.locator('[data-action=preview-full]').click();
    await page.waitForFunction(() => { const canvas = document.querySelector('#fullPreviewCanvas'); return canvas && !canvas.hidden; });
    const preview = await page.locator('#fullPreviewCanvas').evaluate(canvas => {
      const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      return { width: canvas.width, height: canvas.height, data: Array.from(image.data) };
    });
    comparePixels(direct, preview, `full preview rotation ${[0, 90, 180, 270][index]}`);
    outputs.push({ rotation: [0, 90, 180, 270][index], width: direct.width, height: direct.height, comparedBytes: direct.data.length });
    await page.locator('#fullPreviewClose').click();
  }

  const draftResult = await page.evaluate(async () => {
    const fixture = window.__maskRenderFixture;
    const { draw } = await import('/src/renderer.js');
    const { encodeMask } = await import('/src/mask-codec.js');
    const bits = new Uint8Array(fixture.width * fixture.height);
    for (let y = 0; y < fixture.height; y++) for (let x = 0; x < 7; x++) bits[y * fixture.width + x] = 1;
    const mask = await encodeMask(bits, fixture.width, fixture.height, { id: 'draft-only' });
    fixture.draft = { candidates: [{ id: 'candidate', score: 1, selected: true, mask }], effect: 'fill-white', blockSize: 3, blurRadius: 4 };
    const imageEdit = { rotation: 270, crop: fixture.crop }, { width, height } = fixture;
    const image = new Image(); image.src = fixture.src; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = fixture.crop.height; canvas.height = fixture.crop.width;
    const drawPixels = draft => {
      const out = document.createElement('canvas'); out.width = canvas.width; out.height = canvas.height;
      draw(out.getContext('2d'), image, [], null, 1, 1, imageEdit, { width, height }, { maskEffects: fixture.effects, maskAssets: fixture.assets, draft });
      return Array.from(out.getContext('2d').getImageData(0, 0, out.width, out.height).data);
    };
    return { mask, draftPixels: drawPixels(fixture.draft), savedPixels: drawPixels(null), page: {
      name: 'draft-exclusion.png', src: fixture.src, img: { width, height }, layers: [], imageEdit, maskEffects: fixture.effects,
      maskAssets: fixture.assets, sam3Draft: fixture.draft,
    }};
  });
  assert.notDeepEqual(draftResult.draftPixels, draftResult.savedPixels, 'live main renderer must include selected draft masks');

  const workerWithDraft = await renderWorker(3, await page.evaluate(() => window.__maskRenderFixture.draft));
  comparePixels(outputs[3] && await renderDirect(3), workerWithDraft, 'Image Worker PNG must exclude draft masks');
  assert.equal(workerWithDraft.fallbackJobs, 0);

  const previewWithDraft = await page.evaluate(async pageData => {
    const { openFullPreview } = await import('/src/preview-modal.js');
    const trigger = document.querySelector('.image-row [data-action=preview-full]');
    await openFullPreview(pageData, trigger);
    const canvas = document.querySelector('#fullPreviewCanvas'), image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const result = { width: canvas.width, height: canvas.height, data: Array.from(image.data) };
    document.querySelector('#fullPreviewClose').click();
    return result;
  }, draftResult.page);
  comparePixels(await renderDirect(3), previewWithDraft, 'full preview must exclude draft masks');

  const textFront = await page.evaluate(async () => {
    const fixture = window.__maskRenderFixture;
    const { draw } = await import('/src/renderer.js');
    const { newCaption } = await import('/src/captions.js');
    const image = new Image(); image.src = fixture.src; await image.decode();
    const caption = { ...newCaption(fixture.width, fixture.height), text: 'X', x: 33, y: 33, w: 22, h: 16,
      rotation: 0, vertical: false, autoFit: false, size: 12, font: 'sans', color: '#ff00ff', transparency: 100,
      borderWidth: 0, textColor: '#00ff00', textOutlineWidth: 0, alignX: 'center', alignY: 'center', padding: 0 };
    const canvas = document.createElement('canvas'); canvas.width = fixture.width; canvas.height = fixture.height;
    const source = document.createElement('canvas'); source.width = fixture.width; source.height = fixture.height;
    source.getContext('2d').drawImage(image, 0, 0);
    const sourceBefore = Array.from(source.getContext('2d').getImageData(0, 0, fixture.width, fixture.height).data);
    draw(canvas.getContext('2d'), image, [caption], null, 1, 1, null, { width: fixture.width, height: fixture.height },
      { maskEffects: fixture.effects, maskAssets: fixture.assets });
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const raw = new Uint8ClampedArray(fixture.rgba), maskOnly = (await import('/src/mask-effects.js')).applyMaskEffectsToImageData(
      new ImageData(new Uint8ClampedArray(raw), fixture.width, fixture.height), fixture.width, fixture.height, fixture.effects, fixture.assets);
    let textPixels = 0;
    for (let y = 24; y <= 42; y++) for (let x = 22; x <= 43; x++) {
      const offset = (y * fixture.width + x) * 4;
      const isGreen = pixels[offset + 1] > pixels[offset] * 1.5 && pixels[offset + 1] > pixels[offset + 2] * 1.5 && pixels[offset + 1] > 50;
      const wasMasked = maskOnly[offset] === 0 && maskOnly[offset + 1] === 0 && maskOnly[offset + 2] === 0;
      if (isGreen && wasMasked) textPixels++;
    }
    source.getContext('2d').clearRect(0, 0, fixture.width, fixture.height); source.getContext('2d').drawImage(image, 0, 0);
    const sourceAfter = Array.from(source.getContext('2d').getImageData(0, 0, fixture.width, fixture.height).data);
    return { textPixels, sourceRetained: sourceAfter.every((value, index) => value === sourceBefore[index]) };
  });
  assert.ok(textFront.textPixels > 0, 'caption text must paint in front of a covering black mask');
  assert.equal(textFront.sourceRetained, true, 'drawing must preserve original source pixels');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ rotations: outputs, draftExcluded: true, textPixels: textFront.textPixels, sourceRetained: true,
    semanticCases: ['hole', 'move', 'margin', 'pixelate', 'blur', 'fill-black', 'fill-white', 'overlap'] }));
} finally {
  if (browser) {
    for (const context of browser.contexts()) for (const page of context.pages()) await page.evaluate(() => window.__maskRenderPool?.close()).catch(() => {});
    await browser.close();
  }
  server.kill('SIGTERM');
}
