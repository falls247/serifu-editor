import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const port = 5207;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Image edit test server did not start')), 10000);
    server.stdout.once('data', () => { clearTimeout(timer); resolve(); }); server.once('error', reject);
    server.stderr.on('data', chunk => process.stderr.write(chunk));
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  const fixture = await page.evaluate(async () => {
    const { newLayer } = await import('./src/renderer.js');
    const image = document.createElement('canvas'); image.width = 400; image.height = 300;
    const ctx = image.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 200, 300); ctx.fillStyle = '#0000ff'; ctx.fillRect(200, 0, 200, 300);
    const points = [[60, 60], [180, 60], [60, 190], [250, 200]];
    const layers = ['dialogue', 'sfx', 'balloon', 'caption'].map((kind, i) => ({ ...newLayer(kind, 400, 300, 'female'), text: '', x: points[i][0], y: points[i][1], w: 50, h: 50, tail: false }));
    const large = document.createElement('canvas'); large.width = 800; large.height = 600;
    return { version: 9, pages: [{ name: 'source.png', src: image.toDataURL(), layers }, { name: 'target.png', src: large.toDataURL(), layers: [] }] };
  });
  await page.locator('#projectInput').setInputFiles({ name: 'test.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  await page.waitForFunction(() => document.querySelectorAll('.image-row').length === 2 && !document.querySelector('#projectLoad').disabled);
  const row = () => page.locator('.image-row.active'), canvas = () => row().locator('canvas.preview');
  const thumbs = page.locator('.thumbnail'), sourceId = await thumbs.first().getAttribute('data-page-id'), targetId = await thumbs.last().getAttribute('data-page-id');
  const clickPoint = async (x, y, width, height, shift = false) => {
    await canvas().scrollIntoViewIfNeeded(); const box = await canvas().boundingBox();
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.click(box.x + x * box.width / width, box.y + y * box.height / height);
    if (shift) await page.keyboard.up('Shift');
  };
  const cropValues = () => row().locator('[data-crop-field]').evaluateAll(inputs => Object.fromEntries(inputs.map(input => [input.dataset.cropField, Number(input.value)])));
  const dragCrop = async (start, end, width = 400, height = 300) => {
    await canvas().scrollIntoViewIfNeeded(); const box = await canvas().boundingBox();
    await page.mouse.move(box.x + start.x * box.width / width, box.y + start.y * box.height / height); await page.mouse.down();
    await page.mouse.move(box.x + end.x * box.width / width, box.y + end.y * box.height / height, { steps: 4 }); await page.mouse.up();
  };
  const state = () => page.evaluate(async () => {
    const { getDraftMeta } = await import('./src/storage.js'); return (await getDraftMeta()).pages;
  });
  const saveDraft = async () => {
    const previous=await page.evaluate(()=>window.serifuDraftMetrics?.operationId);
    await page.locator('#temporarySave').click(); await page.waitForFunction(id => window.serifuDraftMetrics?.operationId !== id && document.querySelector('#draftStatus').textContent.includes('保存済'),previous); return state();
  };
  await clickPoint(60, 60, 400, 300); await clickPoint(180, 60, 400, 300, true); await clickPoint(60, 190, 400, 300, true);
  assert.equal(await row().locator('.multi-selected').count(), 3);
  await clickPoint(180, 60, 400, 300, true); assert.equal(await row().locator('.multi-selected').count(), 2);
  await row().locator('[data-kind=caption] .layer-summary').click({ modifiers: ['Shift'] });
  assert.equal(await row().locator('.multi-selected').count(), 3);
  await row().locator('[data-kind=caption] .kind-label').click({ modifiers: ['Shift'] });assert.equal(await row().locator('.multi-selected').count(),2);
  await row().locator('[data-kind=caption] .layer-summary').click({ modifiers: ['Shift'] });
  await page.keyboard.press('Control+c'); await page.keyboard.press('ArrowRight');
  await page.locator('#jump').selectOption(targetId); await page.keyboard.press('Control+v');
  assert.equal(await row().locator('.layer-card').count(), 3); assert.equal(await row().locator('.multi-selected').count(), 3);
  let saved = await saveDraft(), pasted = saved[1].layers;
  assert.deepEqual(pasted.map(l => l.kind), ['dialogue', 'balloon', 'caption']);
  assert.deepEqual(pasted.map(l => [l.x, l.y]), [[140, 140], [140, 400], [520, 420]]);
  assert.equal(pasted[1].speaker, 'female');
  await canvas().scrollIntoViewIfNeeded();let groupBox=await canvas().boundingBox();
  await page.mouse.move(groupBox.x+140*groupBox.width/800,groupBox.y+140*groupBox.height/600);await page.mouse.down();
  await page.mouse.move(groupBox.x+180*groupBox.width/800,groupBox.y+170*groupBox.height/600,{steps:3});await page.mouse.up();
  saved=await saveDraft();assert.deepEqual(saved[1].layers.map(l=>[l.x,l.y]),[[180,170],[180,430],[560,450]]);
  await canvas().focus();await page.keyboard.press('Control+z');await page.keyboard.press('Control+z'); assert.equal(await row().locator('.layer-card').count(), 0);
  await page.keyboard.press('Control+Shift+z'); assert.equal(await row().locator('.multi-selected').count(), 3);
  await page.keyboard.press('Control+v'); assert.equal(await row().locator('.layer-card').count(), 6);
  await page.keyboard.press('Delete'); assert.equal(await row().locator('.layer-card').count(), 3);
  await page.keyboard.press('Control+z'); assert.equal(await row().locator('.multi-selected').count(), 3);

  // Duplicate from an edited page. Only the original pixels enter the new page.
  await page.locator('#jump').selectOption(sourceId); await row().locator('[data-action=rotate-right]').click();
  await row().locator('[data-action=duplicate-image]').click();
  await page.waitForFunction(() => document.querySelectorAll('.thumbnail').length === 3 && !document.querySelector('#projectLoad').disabled);
  assert.equal(await row().locator('.page-name').textContent(), 'source_copy1.png'); assert.equal(await row().locator('.layer-card').count(), 0);
  assert.equal(await row().locator('.edited-badge').isVisible(), false);
  assert.deepEqual(await canvas().evaluate(c => [c.width, c.height]), [400, 300]);
  assert.equal(await row().locator('[data-action=delete]').isDisabled(), true);
  saved = await saveDraft(); assert.equal(saved[1].imageEdit, undefined); assert.equal(saved[1].layers.length, 0);
  await page.locator('#jump').selectOption(sourceId); await row().locator('[data-action=duplicate-image]').click();
  await page.waitForFunction(() => document.querySelectorAll('.thumbnail').length === 4 && !document.querySelector('#projectLoad').disabled);
  assert.equal(await row().locator('.page-name').textContent(), 'source_copy2.png');
  await page.locator('#jump').selectOption(sourceId); await row().locator('[data-action=cut-all]').click();
  await page.waitForFunction(() => document.querySelector('.image-row.active .layer-cards').children.length === 0 && !document.querySelector('#projectLoad').disabled);
  assert.equal(await row().locator('.edited-badge').isVisible(), true, 'rotation is an edit without objects');
  await row().locator('[data-action=reset-image]').click(); assert.equal(await row().locator('.edited-badge').isVisible(), false);

  // Crop is reversible, supports drag and numeric input, and composes after rotation.
  await row().locator('[data-action=crop-image]').click(); await canvas().scrollIntoViewIfNeeded();
  let box = await canvas().boundingBox(); await page.mouse.move(box.x + box.width * .8, box.y + box.height * .8); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .1, box.y + box.height * .1, { steps: 3 }); await page.mouse.up();
  assert.equal(await row().locator('[data-crop-field=width]').inputValue(), '280');
  await dragCrop({ x: 180, y: 135 }, { x: 220, y: 155 });
  assert.deepEqual(await cropValues(), { x: 80, y: 50, width: 280, height: 210 });
  await dragCrop({ x: 360, y: 260 }, { x: 380, y: 280 });
  assert.deepEqual(await cropValues(), { x: 80, y: 50, width: 300, height: 230 });
  await dragCrop({ x: 80, y: 165 }, { x: 60, y: 165 });
  assert.deepEqual(await cropValues(), { x: 60, y: 50, width: 320, height: 230 });
  // Captured movement beyond the canvas clamps at the image edges without changing size.
  await dragCrop({ x: 220, y: 165 }, { x: 500, y: 350 });
  assert.deepEqual(await cropValues(), { x: 80, y: 70, width: 320, height: 230 });
  // Outside the frame selects a fresh rectangle.
  await dragCrop({ x: 20, y: 15 }, { x: 200, y: 150 });
  assert.deepEqual(await cropValues(), { x: 20, y: 15, width: 180, height: 135 });
  // Interrupted captured drags restore the draft without changing persisted image edits.
  box=await canvas().boundingBox();await page.mouse.move(box.x+100*box.width/400,box.y+80*box.height/300);await page.mouse.down();
  await page.mouse.move(box.x+120*box.width/400,box.y+100*box.height/300);
  assert.deepEqual(await cropValues(), { x: 40, y: 35, width: 180, height: 135 });
  await canvas().dispatchEvent('pointercancel',{pointerId:1});await page.mouse.up();
  assert.deepEqual(await cropValues(), { x: 20, y: 15, width: 180, height: 135 });
  assert.equal(await row().locator('.edited-badge').isVisible(), false);
  await page.keyboard.press('Escape'); assert.equal(await row().locator('.crop-controls').isVisible(), false); assert.equal(await row().locator('.edited-badge').isVisible(), false);
  await row().locator('[data-action=add-caption]').click();
  const caption = row().locator('[data-kind=caption]'); await caption.locator('textarea').fill('');
  for (const [field, value] of Object.entries({ x: 80, y: 80, w: 60, h: 60, color: '#00ff00', borderWidth: 0 })) {
    const control = field === 'color' ? caption.locator('[data-field=color]') : row().locator(`.position-controls [data-field=${field}]`);
    await control.fill(String(value)); await control.blur();
  }
  await row().locator('[data-action=rotate-right]').click(); assert.deepEqual(await canvas().evaluate(c => [c.width, c.height]), [300, 400]);
  const originalSize = await row().locator('.original').evaluate(img => [img.naturalWidth, img.naturalHeight]); assert.deepEqual(originalSize, [400, 300]);
  await row().locator('[data-action=crop-image]').click();
  await dragCrop({ x: 140, y: 20 }, { x: 260, y: 180 }, 300, 400);
  await dragCrop({ x: 200, y: 100 }, { x: 220, y: 120 }, 300, 400);
  await dragCrop({ x: 220, y: 40 }, { x: 220, y: 20 }, 300, 400);
  assert.deepEqual(await cropValues(), { x: 160, y: 20, width: 120, height: 180 });
  await row().locator('[data-action=apply-crop]').click(); assert.deepEqual(await canvas().evaluate(c => [c.width, c.height]), [120, 180]);
  saved = await saveDraft(); assert.deepEqual(saved[0].imageEdit, { rotation: 90, crop: { x: 20, y: 20, width: 180, height: 120 } });
  await canvas().focus(); await page.keyboard.press('Control+z'); assert.deepEqual(await canvas().evaluate(c => [c.width, c.height]), [300, 400]);
  await page.keyboard.press('Control+Shift+z'); assert.deepEqual(await canvas().evaluate(c => [c.width, c.height]), [120, 180]);
  // Hit testing and movement follow the transformed image; source coordinates remain intact.
  await clickPoint(60, 60, 120, 180); assert.equal(await row().locator('.layer-card.selected').getAttribute('data-kind'), 'caption');
  await page.keyboard.press('ArrowRight'); assert.equal(await row().locator('.position-controls [data-field=y]').inputValue(), '79');
  await page.keyboard.press('Control+z');
  await canvas().scrollIntoViewIfNeeded();box=await canvas().boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/3);await page.mouse.down();
  await page.mouse.move(box.x+box.width/2+10*box.width/120,box.y+box.height/3+15*box.height/180,{steps:3});await page.mouse.up();
  assert.equal(await row().locator('.position-controls [data-field=x]').inputValue(),'95');assert.equal(await row().locator('.position-controls [data-field=y]').inputValue(),'70');
  await page.keyboard.press('Control+z');

  const downloadPNG = async () => {
    const promise = page.waitForEvent('download'); await row().locator('[data-action=save-image]').click(); const download = await promise;
    await page.waitForFunction(() => !document.querySelector('#projectLoad').disabled); return readFile(await download.path());
  };
  const png = await downloadPNG();
  const pixels = await page.evaluate(async base64 => {
    const img = new Image(); img.src = `data:image/png;base64,${base64}`; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); return { size: [img.width, img.height], corner: [...ctx.getImageData(10, 10, 1, 1).data], object: [...ctx.getImageData(60, 60, 1, 1).data] };
  }, png.toString('base64'));
  assert.deepEqual(pixels, { size: [120, 180], corner: [255, 0, 0, 255], object: [64, 191, 0, 255] });
  const parity = await page.evaluate(async () => {
    const { ImagePool } = await import('./src/bulk-pool.js'), { draw } = await import('./src/renderer.js'), { getDraftMeta, getDraftImages } = await import('./src/storage.js');
    const record = (await getDraftMeta()).pages[0], blob = (await getDraftImages([record.id]))[0].blob;
    const payload = { blob, width: 400, height: 300, layers: record.layers, imageEdit: record.imageEdit }, pool = new ImagePool();
    const output = await pool.run('render-png', payload, null, () => { throw new Error('Worker unexpectedly unavailable'); });
    const bitmap = await createImageBitmap(blob), actual = await createImageBitmap(output), a = document.createElement('canvas'), b = document.createElement('canvas');
    a.width = b.width = 120; a.height = b.height = 180; draw(a.getContext('2d'), bitmap, record.layers, null, 1, 1, record.imageEdit); b.getContext('2d').drawImage(actual, 0, 0);
    const aa = a.getContext('2d').getImageData(0, 0, 120, 180).data, bb = b.getContext('2d').getImageData(0, 0, 120, 180).data;
    let differences = 0; for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) differences++;
    bitmap.close(); actual.close(); return differences;
  }); assert.equal(parity, 0);
  await page.waitForFunction(() => { const img = document.querySelector('.thumbnail img'); return img.naturalWidth === 120 && img.naturalHeight === 180; });

  // JSON and binary round trips retain transform, pixels, and original image dimensions.
  for (const format of ['json', 'serifu']) {
    await page.locator('#projectFormat').selectOption(format); const pending = page.waitForEvent('download'); await page.locator('#projectSave').click(); const download = await pending;
    await page.waitForFunction(() => !document.querySelector('#projectLoad').disabled);
    const restored = await context.newPage(); await restored.goto(`http://127.0.0.1:${port}`);
    await restored.locator('#projectInput').setInputFiles({ name: `test.${format}`, mimeType: format === 'json' ? 'application/json' : 'application/octet-stream', buffer: await readFile(await download.path()) });
    await restored.waitForFunction(() => document.querySelectorAll('.thumbnail').length === 4 && !document.querySelector('#projectLoad').disabled);
    assert.deepEqual(await restored.locator('.image-row.active canvas').evaluate(c => [c.width, c.height]), [120, 180]);
    assert.deepEqual(await restored.locator('.image-row.active .original').evaluate(img => [img.naturalWidth, img.naturalHeight]), [400, 300]); await restored.close();
  }
  await saveDraft(); page.on('dialog', dialog => dialog.accept()); await page.reload(); await page.locator('#restoreDraft').click();
  await page.waitForFunction(() => document.querySelectorAll('.thumbnail').length === 4 && !document.querySelector('#projectLoad').disabled);
  assert.deepEqual(await canvas().evaluate(c => [c.width, c.height]), [120, 180]);
  await row().locator('[data-action=cut-all]').click(); await page.waitForFunction(() => !document.querySelector('#projectLoad').disabled);
  assert.equal(await row().locator('.edited-badge').isVisible(), true); await row().locator('[data-action=reset-image]').click();
  assert.equal(await row().locator('.edited-badge').isVisible(), false); await row().locator('[data-action=rotate-left]').click();
  for (let i = 0; i < 3; i++) await row().locator('[data-action=rotate-left]').click(); assert.equal(await row().locator('.edited-badge').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('Shift group copy/paste, original duplication, reversible crop/rotation, transformed hit testing, PNG pixels and Worker parity, thumbnails and project/draft restore passed');
} finally { await browser?.close(); server.kill(); }
