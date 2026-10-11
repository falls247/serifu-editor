import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
const { chromium } = createRequire(import.meta.url)('playwright');
const url = process.argv[2] || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 }, acceptDownloads: true });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  const health = await page.evaluate(() => fetch('/api/sam3/health').then(response => response.json()));
  assert.equal(health.gpuAvailable, true, '実CUDA環境だけで実行する');
  assert.ok(!health.version.includes('mock'), 'モックを実GPU検証として扱わない');
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#4187b9'; ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#ecbc93'; ctx.beginPath(); ctx.ellipse(128, 128, 76, 92, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1e140f'; for (const x of [100, 156]) { ctx.beginPath(); ctx.arc(x, 106, 8, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillRect(100, 164, 57, 6); return canvas.toDataURL().split(',')[1];
  });
  await page.locator('#fileInput').setInputFiles({ name: 'real-gpu-face.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  const row = page.locator('.image-row').first(), panel = row.locator('.sam3-panel');
  await panel.locator('[data-sam3-prompt]').fill('face');
  await panel.locator('[data-sam3-action=detect]').click();
  const ready = () => panel.locator('[data-sam3-request-status]').filter({ hasText: '候補を確認可能' }).waitFor({ timeout: 300000 });
  await ready();
  const candidateCount = await panel.locator('.sam3-candidate').count(); assert.ok(candidateCount > 0);
  await panel.locator('.sam3-candidate input[type=checkbox]').first().check();
  const clickOriginal = async (x, y) => {
    const overlay = row.locator('.sam3-overlay'); await overlay.scrollIntoViewIfNeeded();
    const original = await overlay.boundingBox();
    await overlay.click({ position: { x: original.width * x / 256, y: original.height * y / 256 } });
  };
  await panel.locator('[data-interaction=include]').click();
  await clickOriginal(128, 128);
  await ready(); assert.equal(await panel.locator('.sam3-point-chip').count(), 1);
  await panel.locator('[data-interaction=exclude]').click();
  await clickOriginal(20, 230);
  await ready(); assert.equal(await panel.locator('.sam3-point-chip').count(), 2);
  await panel.locator('[data-sam3-effect]').selectOption('fill-black');
  await panel.locator('[data-sam3-action=commit]').click();
  assert.equal(await row.locator('.mask-effect-card').count(), 1);
  const downloadPending = page.waitForEvent('download'); await row.locator('[data-action=save-image]').click();
  const download = await downloadPending, saved = await readFile(await download.path());
  const pixels = await page.evaluate(async base64 => {
    const image = new Image(); image.src = 'data:image/png;base64,' + base64; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    return { center: [...ctx.getImageData(128, 128, 1, 1).data], outside: [...ctx.getImageData(10, 10, 1, 1).data] };
  }, saved.toString('base64'));
  assert.deepEqual(pixels.center, [0, 0, 0, 255]); assert.deepEqual(pixels.outside, [65, 135, 185, 255]);
  assert.deepEqual(errors, []);
  await mkdir('artifacts', { recursive: true }); await row.screenshot({ path: 'artifacts/sam3-real-gpu-browser.png' });
  console.log(JSON.stringify({ result: 'PASS', health, candidateCount, points: 2, pixels, pngBytes: saved.length }));
} finally { await browser.close(); }
