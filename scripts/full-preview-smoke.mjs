import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const port = 5214, server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
let browser, page;
try {
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Preview server did not start')), 10000); server.stdout.once('data', () => { clearTimeout(timer); resolve(); }); server.once('error', reject); });
  browser = await chromium.launch({ headless: true }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.previewWork = { decodes: 0, draws: 0 };
    window.previewBackgroundWork = { live: 0, thumbnails: 0 };
    const decode = HTMLImageElement.prototype.decode, clear = CanvasRenderingContext2D.prototype.clearRect;
    HTMLImageElement.prototype.decode = function (...args) { window.previewWork.decodes++; return decode.apply(this, args); };
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.id === 'fullPreviewCanvas') window.previewWork.draws++;
      if (document.querySelector('#fullPreview')?.open) {
        if (this.canvas.classList.contains('preview')) window.previewBackgroundWork.live++;
        else if (!this.canvas.id && !this.canvas.className && this.canvas.width <= 320 && this.canvas.height <= 320) window.previewBackgroundWork.thumbnails++;
      }
      return clear.apply(this, args);
    };
  });
  await page.goto(`http://127.0.0.1:${port}`); await page.uncheck('#autosaveEnabled');
  const fixture = await page.evaluate(async () => {
    const { newLayer } = await import('./src/renderer.js');
    const c = document.createElement('canvas'); c.width = 1600; c.height = 1000;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#882233'; ctx.fillRect(0, 0, 800, 1000); ctx.fillStyle = '#226688'; ctx.fillRect(800, 0, 800, 1000);
    const layers = ['dialogue', 'sfx', 'balloon', 'caption'].map((kind, i) => ({ ...newLayer(kind, 1600, 1000, 'female'),
      text: kind === 'dialogue' ? '原寸確認' : '', x: 250.123456789 + i * 240, y: 350.987654321, w: 280.23456789, h: 220.3456789, size: 40.12345, outline: 3.23456, textOffsetX: -17.75123, glyphSeed: 4294967295 }));
    return { version: 10, pages: [{ name: 'full-preview.png', src: c.toDataURL(), layers }, { name: 'second.png', src: c.toDataURL(), layers: [] }] };
  });
  await page.locator('#projectInput').setInputFiles({ name: 'preview.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  await page.waitForFunction(() => document.querySelectorAll('.image-row').length === 2 && !document.querySelector('#projectLoad').disabled);
  const row = page.locator('.image-row').first(), opener = row.locator('[data-action=preview-full]'), modal = page.locator('#fullPreview'), image = page.locator('#fullPreviewCanvas');
  assert.equal(await opener.evaluate(b => b.nextElementSibling.dataset.action), 'crop-image');
  const magnifier = row.locator('[data-action=preview-magnifier]'), lens = row.locator('.preview-magnifier'), detail = lens.locator('canvas');
  assert.equal(await magnifier.evaluate(b => b.nextElementSibling.dataset.action), 'preview-full');
  assert.equal(await page.locator('.shortcut-hint,.preview-hint').count(), 0);
  const dimensions = await row.evaluate(r => ({ original: r.querySelector('.original').getBoundingClientRect().width,
    preview: r.querySelector('canvas.preview').getBoundingClientRect().width, frame: r.querySelector('.preview-frame').clientWidth }));
  assert.ok(dimensions.preview > dimensions.original * 1.2); assert.ok(Math.abs(dimensions.preview - (dimensions.frame - 2)) < 1);
  await page.evaluate(() => { window.previewWork = { decodes: 0, draws: 0 }; });
  await magnifier.click(); await lens.locator('.magnifier-status').waitFor({ state: 'hidden' });
  assert.equal(await magnifier.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => window.previewWork.decodes), 0, 'magnifier reuses the mounted original');
  const checkDetail = async () => {
    const pixels = await detail.evaluate(c => {
      const source = document.querySelector('#fullPreviewCanvas'), x = Number(c.dataset.sourceX), y = Number(c.dataset.sourceY);
      const actual = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const expected = source.getContext('2d').getImageData(x, y, c.width, c.height).data;
      return { same: actual.every((byte, i) => byte === expected[i]), size: [c.width, c.height], css: [c.clientWidth, c.clientHeight] };
    });
    assert.deepEqual(pixels.size, pixels.css, 'one original pixel per CSS pixel'); assert.equal(pixels.same, true, 'lens preserves original-resolution edited pixels');
  };
  await checkDetail();
  const dragBy = async (target, dx, dy) => {
    const box = await target.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 5 }); await page.mouse.up();
  };
  const checkCorners = async () => {
    for (const [dx, dy, right, bottom] of [[-2000, -2000, false, false], [2000, -2000, true, false], [2000, 2000, true, true], [-2000, 2000, false, true]]) {
      await dragBy(lens.locator('.magnifier-header'), dx, dy);
      const actual = await detail.evaluate(c => ({ x: Number(c.dataset.sourceX), y: Number(c.dataset.sourceY),
        width: c.width, height: c.height, originalWidth: document.querySelector('#fullPreviewCanvas').width, originalHeight: document.querySelector('#fullPreviewCanvas').height }));
      assert.equal(actual.x, right ? actual.originalWidth - actual.width : 0, 'both horizontal image edges are reachable');
      assert.equal(actual.y, bottom ? actual.originalHeight - actual.height : 0, 'both vertical image edges are reachable');
      await checkDetail();
    }
  };
  await checkCorners(); await dragBy(lens.locator('.magnifier-header'), -2000, -2000);
  const initial = await lens.boundingBox();
  await dragBy(lens.locator('.magnifier-resize'), -70, -50);
  const smaller = await lens.boundingBox(); assert.ok(smaller.width < initial.width); assert.ok(smaller.height < initial.height); await checkDetail();
  await dragBy(lens.locator('.magnifier-header'), 60, 30);
  const moved = await lens.boundingBox(); assert.ok(moved.x > smaller.x); assert.ok(moved.y > smaller.y); await checkDetail();
  await lens.locator('.magnifier-resize').focus(); await page.keyboard.press('Shift+ArrowRight');
  assert.equal((await lens.boundingBox()).width, smaller.width + 10); await checkDetail();
  const touchBefore = await lens.boundingBox();
  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchBefore.x + 20, y: touchBefore.y + 14 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchBefore.x + 45, y: touchBefore.y + 39 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); await touch.detach();
  assert.ok((await lens.boundingBox()).x > touchBefore.x); await checkDetail();
  const beforeEdit = await image.evaluate(c => c.toDataURL());
  await row.locator('.position-controls [data-field=x]').fill('900');
  await page.waitForFunction(previous => document.querySelector('#fullPreviewCanvas').toDataURL() !== previous, beforeEdit);
  await page.waitForFunction(() => document.querySelector('.preview-magnifier').getAttribute('aria-busy') === 'false'); await checkDetail();
  await row.locator('[data-action=undo]').click();
  await page.waitForFunction(previous => document.querySelector('#fullPreviewCanvas').toDataURL() === previous, beforeEdit); await checkDetail();
  await lens.focus(); await page.keyboard.press('Escape'); assert.equal(await lens.count(), 0);
  assert.equal(await magnifier.evaluate(b => b === document.activeElement), true);
  await magnifier.click(); await lens.locator('.magnifier-status').waitFor({ state: 'hidden' });
  const secondRow = page.locator('.image-row').nth(1);
  await secondRow.locator('[data-action=preview-magnifier]').click();
  await secondRow.locator('.magnifier-status').waitFor({ state: 'hidden' });
  assert.equal(await lens.count(), 0); assert.equal(await page.locator('.preview-magnifier').count(), 1, 'only one magnifier is retained');
  await magnifier.click(); await lens.locator('.magnifier-status').waitFor({ state: 'hidden' });
  await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/preview-magnifier-desktop.png' });
  await page.evaluate(() => { window.previewWork = { decodes: 0, draws: 0 }; });
  const integerFields = ['shapeSeed','spikeCount','brushSeed','glyphSeed','x','y','w','h','size','thickness','outline','borderWidth','textOutlineWidth','textOffsetX','textOffsetY','padding','tailX','tailY','tailWidth','shadowBlur','shadowOffsetX','shadowOffsetY','minimumGlyphGap','blur','motionBlur','blurX','blurY'];
  const values = await row.locator('input[data-field][type=number],input[data-numeric-field][type=number]').evaluateAll(inputs => inputs.map(i => ({ field: i.dataset.field ?? i.dataset.numericField, value: i.value, step: i.step })));
  for (const input of values) {
    if (!input.value) continue;
    assert.match(input.value, integerFields.includes(input.field) ? /^-?\d+$/ : /^-?\d+(\.\d)?$/);
    assert.equal(input.step, integerFields.includes(input.field) ? '1' : '0.1');
  }
  await row.locator('.position-controls [data-field=x]').focus();
  await opener.click(); await image.waitFor({ state: 'visible' });
  assert.equal(await lens.count(), 0, 'modal replaces the magnifier');
  assert.deepEqual(await page.evaluate(() => window.previewWork), { decodes: 0, draws: 0 }, 'modal shares the already rendered magnifier surface');
  assert.equal(await modal.isVisible(), true); assert.deepEqual(await image.evaluate(c => [c.width, c.height]), [1600, 1000]);
  assert.deepEqual(await image.evaluate(c => [c.getBoundingClientRect().width, c.getBoundingClientRect().height]), [1600, 1000]);
  assert.equal(await page.locator('#fullPreviewZoomValue').textContent(), '100%');
  assert.equal(await page.locator('#fullPreviewClose').evaluate(b => b === document.activeElement), true);
  const modalPixels = await image.evaluate(c => c.toDataURL());
  const deviceScale=await page.evaluate(()=>devicePixelRatio);
  await page.locator('#fullPreviewViewport').hover();await page.keyboard.down('Control');await page.mouse.wheel(0,-100);
  await page.waitForFunction(()=>document.querySelector('#fullPreviewZoom').value==='110');await page.keyboard.up('Control');
  assert.equal(await page.evaluate(()=>devicePixelRatio),deviceScale,'Ctrl-wheel must zoom the image instead of the browser');await page.locator('#fullPreviewActual').click();
  await page.locator('#fullPreviewZoomIn').click(); assert.equal(await page.locator('#fullPreviewZoom').inputValue(), '110');
  assert.equal(await image.evaluate(c => c.getBoundingClientRect().width), 1760);
  await page.locator('#fullPreviewZoomOut').click(); assert.equal(await page.locator('#fullPreviewZoom').inputValue(), '100');
  await page.locator('#fullPreviewZoom').fill('200'); assert.equal(await image.evaluate(c => c.getBoundingClientRect().width), 3200);
  assert.equal(await page.locator('#fullPreviewZoomIn').isDisabled(), true);
  const wheel = async deltaY => page.locator('#fullPreviewViewport').evaluate((v, deltaY) => {
    const box = v.getBoundingClientRect(), event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY, clientX: box.x + 150, clientY: box.y + 150 });
    v.dispatchEvent(event); return event.defaultPrevented;
  }, deltaY);
  assert.equal(await wheel(-100), true); assert.equal(await page.locator('#fullPreviewZoom').inputValue(), '200');
  await wheel(100); assert.equal(await page.locator('#fullPreviewZoom').inputValue(), '190');
  await page.locator('#fullPreviewActual').click(); assert.equal(await page.locator('#fullPreviewZoom').inputValue(), '100');
  const viewport = page.locator('#fullPreviewViewport');
  await viewport.evaluate(v => { v.scrollLeft = 300; v.scrollTop = 200; });
  const before = await image.boundingBox(), viewBox = await viewport.boundingBox();
  const anchor = { x: viewBox.x + 200, y: viewBox.y + 200 }, source = { x: anchor.x - before.x, y: anchor.y - before.y };
  await viewport.evaluate((v, anchor) => v.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, clientX: anchor.x, clientY: anchor.y })), anchor);
  const after = await image.boundingBox(); assert.ok(Math.abs((anchor.x - after.x) / 1.1 - source.x) < 2); assert.ok(Math.abs((anchor.y - after.y) / 1.1 - source.y) < 2);
  const nativeWheel = await viewport.evaluate(v => { const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 }); v.dispatchEvent(event); return event.defaultPrevented; }); assert.equal(nativeWheel, false);
  await viewport.evaluate(v => { v.scrollTop = 0; }); await viewport.hover(); await page.mouse.wheel(0, 250);
  await page.waitForFunction(() => document.querySelector('#fullPreviewViewport').scrollTop > 0);
  // ResizeObserver and font completion must not repaint the covered editor.
  const thumbnailBefore = await page.locator('.thumbnail img').first().getAttribute('src');
  await page.setViewportSize({ width: 1410, height: 1000 });
  await page.evaluate(() => document.fonts.dispatchEvent(new FontFaceSetLoadEvent('loadingdone', { fontfaces: [] })));
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
  assert.deepEqual(await page.evaluate(() => window.previewBackgroundWork), { live: 0, thumbnails: 0 }, 'scrolling stays free of background live/thumbnail drawing');
  await page.locator('#fullPreviewZoom').fill('10'); assert.equal(await page.locator('#fullPreviewZoomOut').isDisabled(), true); await wheel(100); assert.equal(await page.locator('#fullPreviewZoom').inputValue(), '10');
  await viewport.focus(); await page.keyboard.press('Control+z'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Delete');
  await page.keyboard.press('Escape'); assert.equal(await modal.isVisible(), false); assert.equal(await opener.evaluate(b => b === document.activeElement), true);
  await page.evaluate(() => { window.previewWork = { decodes: 0, draws: 0 }; });
  const reopenMs = await opener.evaluate(async button => {
    const start = performance.now(); button.click();
    while (document.querySelector('#fullPreviewCanvas').hidden) await new Promise(requestAnimationFrame);
    return performance.now() - start;
  });
  assert.deepEqual(await page.evaluate(() => window.previewWork), { decodes: 0, draws: 0 }, 'unchanged reopen skips decode and rendering');
  console.log(`Cached 100% preview: ${reopenMs.toFixed(1)} ms`);
  await page.locator('#fullPreviewClose').click();
  await page.waitForFunction(previous => {
    const img = document.querySelector('.thumbnail img'); return img.src !== previous && img.complete;
  }, thumbnailBefore);
  assert.equal(await row.locator('.layer-card').count(), 4);
  let pending = page.waitForEvent('download'); await row.locator('[data-action=save-image]').click(); let download = await pending;
  await page.waitForFunction(() => !document.querySelector('#projectLoad').disabled);
  const png = await readFile(await download.path());
  const parity = await page.evaluate(async ([png, modalPixels]) => {
    const images = await Promise.all([`data:image/png;base64,${png}`, modalPixels].map(async src => { const img = new Image(); img.src = src; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').drawImage(img, 0, 0); return c; }));
    const bytes = images.map(c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data); let diff = 0; for (let i = 0; i < bytes[0].length; i++) if (bytes[0][i] !== bytes[1][i]) diff++; return diff;
  }, [png.toString('base64'), modalPixels]); assert.equal(parity, 0, 'original-resolution modal includes all edits without selection handles');
  await page.locator('#projectFormat').selectOption('json'); pending = page.waitForEvent('download'); await page.locator('#projectSave').click(); download = await pending;
  const project = JSON.parse(await readFile(await download.path()));
  for (const original of fixture.pages[0].layers) {
    const saved = project.pages[0].layers.find(layer => layer.kind === original.kind);
    assert.ok(saved, `legacy migration retains ${original.kind}`);
    assert.equal(saved.x, original.x, `${original.kind} display rounding and modal opening do not mutate source precision`);
    assert.equal(saved.y, original.y);
  }
  await page.waitForFunction(() => !document.querySelector('#projectLoad').disabled);
  const sizeInput = row.locator('.position-controls [data-field=size]'); await sizeInput.fill('41.23456');
  assert.equal(await row.locator('.position-controls [data-numeric-field=size]').inputValue(), '41'); await sizeInput.blur(); assert.equal(await sizeInput.inputValue(), '41');
  await sizeInput.press('ArrowUp'); assert.equal(await sizeInput.inputValue(), '42'); await sizeInput.blur();
  await row.locator('[data-action=undo]').click(); assert.equal(await sizeInput.inputValue(), '41'); await row.locator('[data-action=undo]').click(); assert.equal(await sizeInput.inputValue(), '40');
  await row.locator('[data-action=rotate-right]').click(); await opener.click(); await image.waitFor({ state: 'visible' }); assert.deepEqual(await image.evaluate(c => [c.width, c.height]), [1000, 1600]);
  await page.locator('#fullPreviewClose').click(); await row.locator('[data-action=crop-image]').click();
  for (const [field, value] of Object.entries({ x: 100, y: 100, width: 700, height: 1000 })) await row.locator(`[data-crop-field=${field}]`).fill(String(value));
  await row.locator('[data-action=apply-crop]').click(); await opener.click(); await image.waitFor({ state: 'visible' });
  assert.deepEqual(await image.evaluate(c => [c.width, c.height]), [700, 1000]); assert.equal(await page.locator('#fullPreviewSize').textContent(), '700 × 1000 px');
  await page.locator('#fullPreviewZoom').fill('50'); await page.locator('#fullPreviewClose').click(); await opener.click(); await image.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#fullPreviewZoom').inputValue(), '100');
  await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/full-preview-desktop.png' });
  await page.setViewportSize({ width: 420, height: 900 }); await page.locator('#fullPreviewZoom').fill('200');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const bounds = await modal.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 421);
  await page.screenshot({ path: 'artifacts/full-preview-mobile.png' }); await page.locator('#fullPreviewClose').click();
  await magnifier.click(); await lens.locator('.magnifier-status').waitFor({ state: 'hidden' }); await checkDetail();
  await dragBy(lens.locator('.magnifier-resize'), 1000, 1000);
  const frame = await row.locator('.preview-frame').boundingBox(), enlarged = await lens.boundingBox();
  assert.ok(enlarged.width <= frame.width && enlarged.height <= frame.height, 'resize stays inside the preview');
  await checkCorners();
  await lens.focus(); const panBefore = Number(await detail.getAttribute('data-source-x')); await page.keyboard.press('Shift+ArrowRight');
  assert.ok(Number(await detail.getAttribute('data-source-x')) > panBefore, 'keyboard pans when the window fills its frame'); await checkDetail();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: 'artifacts/preview-magnifier-mobile.png' });
  await lens.locator('.magnifier-close').click(); assert.equal(await magnifier.getAttribute('aria-pressed'), 'false');
  const cancelled = await page.evaluate(async src => {
    const { openFullPreview } = await import('./src/preview-modal.js');
    const image = new Image(); image.src = src; await image.decode();
    let finish;
    Object.defineProperty(image, 'naturalWidth', { value: 0 });
    image.decode = () => new Promise(resolve => { finish = resolve; });
    const modal = document.querySelector('#fullPreview'), opening = openFullPreview({ id: 'delayed', name: 'delayed', src, img: image, layers: [] }, document.querySelector('[data-action=preview-full]'));
    await new Promise(resolve => { modal.addEventListener('close', resolve, { once: true }); modal.close(); });
    finish(); await opening;
    const canvas = document.querySelector('#fullPreviewCanvas');
    return { hidden: canvas.hidden, size: [canvas.width, canvas.height], overflow: document.body.style.overflow };
  }, fixture.pages[0].src);
  assert.deepEqual(cancelled, { hidden: true, size: [1, 1], overflow: '' }, 'closing during preparation cancels stale rendering and frees the surface');
  assert.deepEqual(errors, []);
  console.log('Magnifier: original pixel parity, drag/resize/keyboard, mobile bounds and shared cache passed. Full-resolution modal, zoom/scroll/focus/Escape, crop/rotation, PNG parity and numeric precision passed');
} catch (error) { if (page) { await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/full-preview-failure.png' }).catch(() => {}); } throw error; }
finally { await browser?.close(); server.kill(); }
