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
  assert.equal(await page.locator('.shortcut-hint,.preview-hint').count(), 0);
  const dimensions = await row.evaluate(r => ({ original: r.querySelector('.original').getBoundingClientRect().width,
    preview: r.querySelector('canvas.preview').getBoundingClientRect().width, frame: r.querySelector('.preview-frame').clientWidth }));
  assert.ok(dimensions.preview > dimensions.original * 1.2); assert.ok(Math.abs(dimensions.preview - (dimensions.frame - 2)) < 1);
  const integerFields = ['shapeSeed','spikeCount','brushSeed','glyphSeed','x','y','w','h','size','thickness','outline','borderWidth','textOutlineWidth','textOffsetX','textOffsetY','padding','tailX','tailY','tailWidth','shadowBlur','shadowOffsetX','shadowOffsetY','minimumGlyphGap','blur','motionBlur','blurX','blurY'];
  const values = await row.locator('input[data-field][type=number],input[data-numeric-field][type=number]').evaluateAll(inputs => inputs.map(i => ({ field: i.dataset.field ?? i.dataset.numericField, value: i.value, step: i.step })));
  for (const input of values) {
    if (!input.value) continue;
    assert.match(input.value, integerFields.includes(input.field) ? /^-?\d+$/ : /^-?\d+(\.\d)?$/);
    assert.equal(input.step, integerFields.includes(input.field) ? '1' : '0.1');
  }
  await row.locator('.position-controls [data-field=x]').focus();
  await opener.click(); await image.waitFor({ state: 'visible' });
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
  await page.locator('#fullPreviewZoom').fill('10'); assert.equal(await page.locator('#fullPreviewZoomOut').isDisabled(), true); await wheel(100); assert.equal(await page.locator('#fullPreviewZoom').inputValue(), '10');
  await viewport.focus(); await page.keyboard.press('Control+z'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Delete');
  await page.keyboard.press('Escape'); assert.equal(await modal.isVisible(), false); assert.equal(await opener.evaluate(b => b === document.activeElement), true);
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
  assert.deepEqual(errors, []);
  console.log('Full-resolution edited modal, 10–200% zoom controls/Ctrl-wheel/anchor, scroll/focus/Escape, crop/rotation, PNG parity, integer pixel controls, one-decimal angles/percentages and precision preservation passed');
} catch (error) { if (page) { await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/full-preview-failure.png' }).catch(() => {}); } throw error; }
finally { await browser?.close(); server.kill(); }
