import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const port = 5339;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
let browser;
const near = (actual, expected, message, tolerance = 0.1) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} / ${expected}`);
const paint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const leaveImage = page => page.mouse.move(5, page.viewportSize().height - 1);

async function geometry(row) {
  return row.evaluate(node => {
    const image = node.querySelector('.original'), overlay = node.querySelector('.sam3-overlay'), frame = node.querySelector('.original-frame');
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    return { image: rect(image), overlay: rect(overlay), frame: rect(frame), raster: [overlay.width, overlay.height], active: frame.classList.contains('original-focus-active') };
  });
}

try {
  await new Promise((resolve, reject) => {
    server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(new Error(`server exited: ${code}`)));
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const errors = [], inferenceRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/sam3/**', route => {
    if (route.request().url().endsWith('/health')) return route.fulfill({ json: { status: 'ready', modelLoaded: true, gpuAvailable: true, modelPath: '/mock/sam3.pt' } });
    inferenceRequests.push(route.request().url());
    return route.fulfill({ status: 503, json: { error: { code: 'UNEXPECTED_REQUEST', message: 'focus must not trigger inference' } } });
  });
  await page.goto(`http://127.0.0.1:${port}`); await page.uncheck('#autosaveEnabled');
  const fixture = await page.evaluate(async () => {
    const { PROJECT_VERSION } = await import('/src/model.js');
    const pages = [[1600, 1000], [300, 1200], [1600, 240], [6000, 800]].map(([width, height]) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#607685'; ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = '#c8ee91'; ctx.lineWidth = 2;
      for (let x = 0; x < width; x += 100) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
      for (let y = 0; y < height; y += 100) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
      return { name: `sam3-focus-${width}-${height}.png`, src: canvas.toDataURL(), imageWidth: width, imageHeight: height, layers: [] };
    });
    return { version: PROJECT_VERSION, pages };
  });
  await page.locator('#projectInput').setInputFiles({ name: 'sam3-focus.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  await page.waitForFunction(() => document.querySelectorAll('.image-row').length === 4 && !document.querySelector('#projectLoad').disabled);
  await mkdir('artifacts', { recursive: true });

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 }); await paint(page);
    for (const [index, record] of fixture.pages.entries()) {
      const row = page.locator('.image-row').nth(index), frame = row.locator('.original-frame'), focus = row.locator('[data-sam3-focus]');
      assert.equal(await focus.getAttribute('aria-pressed'), 'true', 'FOCUS defaults ON for every page');
      await row.locator('[data-interaction=exclude]').click();
      for (const fraction of [0.05, 0.5, 0.95]) {
        await leaveImage(page); await frame.scrollIntoViewIfNeeded(); await paint(page);
        const before = await geometry(row);
        const target = { x: before.image.x + before.image.width * fraction, y: before.image.y + before.image.height * fraction };
        await page.mouse.move(target.x, target.y, { steps: 8 });
        try { await row.locator('.original-focus-active').waitFor({ timeout: 5000 }); }
        catch (error) {
          console.error('FOCUS target:', { width, index, fraction, before, target }, await page.evaluate(point => ({
            hit: document.elementFromPoint(point.x, point.y)?.outerHTML.slice(0, 300), scrollY,
            tool: document.querySelector('.image-row.active [data-interaction][aria-pressed=true]')?.dataset.interaction,
          }), target));
          await page.screenshot({ path: 'artifacts/sam3-focus-failed.png' }); throw error;
        }
        const focused = await geometry(row);
        near(focused.image.width, record.imageWidth, '100% source width'); near(focused.image.height, record.imageHeight, '100% source height');
        near(focused.frame.width, before.frame.width, 'fixed frame width'); near(focused.frame.height, before.frame.height, 'fixed frame height');
        near(target.x - focused.image.x, record.imageWidth * fraction, 'cursor source X'); near(target.y - focused.image.y, record.imageHeight * fraction, 'cursor source Y');
        near(focused.overlay.x, focused.image.x, 'overlay X'); near(focused.overlay.y, focused.image.y, 'overlay Y');
        near(focused.overlay.width, focused.image.width, 'overlay width'); near(focused.overlay.height, focused.image.height, 'overlay height');
        assert.ok(Math.max(...focused.raster) <= 4096, 'large source overlays have bounded raster dimensions');
        const delta = fraction > 0.5 ? -3 : 3;
        await row.locator('.sam3-overlay').evaluate(canvas => {
          const ctx = canvas.getContext('2d'), clear = ctx.clearRect;
          canvas.focusMoveRedraws = 0;
          ctx.clearRect = function (...args) { canvas.focusMoveRedraws++; return clear.apply(this, args); };
        });
        await page.mouse.move(target.x + delta, target.y + delta, { steps: 4 });
        const moved = await geometry(row);
        const expectedPoint = {
          x: Math.min(record.imageWidth - 1, Math.max(0, record.imageWidth * (fraction + delta / before.image.width))),
          y: Math.min(record.imageHeight - 1, Math.max(0, record.imageHeight * (fraction + delta / before.image.height))),
        };
        near(target.x + delta - moved.image.x, expectedPoint.x, 'moving cursor source X');
        near(target.y + delta - moved.image.y, expectedPoint.y, 'moving cursor source Y');
        near(moved.image.width, record.imageWidth, 'moving FOCUS maintains 100% width');
        near(moved.image.height, record.imageHeight, 'moving FOCUS maintains 100% height');
        near(moved.overlay.x, moved.image.x, 'moving overlay X'); near(moved.overlay.y, moved.image.y, 'moving overlay Y');
        assert.equal(await row.locator('.sam3-overlay').evaluate(canvas => canvas.focusMoveRedraws), 0, 'following the cursor reuses the overlay raster');
        await page.mouse.click(target.x + delta, target.y + delta);
        const text = await row.locator('.sam3-point-chip').last().innerText(), match = text.match(/−\s*(\d+),\s*(\d+)/);
        assert.ok(match, `background point chip: ${text}`);
        // Browser click coordinates and stored source points each round to integer pixels.
        near(Number(match[1]), expectedPoint.x, 'source point X', 1.5);
        near(Number(match[2]), expectedPoint.y, 'source point Y', 1.5);
        if (index === 0 && fraction === 0.5) await page.screenshot({ path: `artifacts/sam3-focus-${width}.png` });
        await leaveImage(page);
        const restored = await geometry(row);
        assert.equal(restored.active, false, 'leaving restores fit display');
        near(restored.image.width, before.image.width, 'restored image width'); near(restored.image.height, before.image.height, 'restored image height');
      }
      await focus.click(); await frame.scrollIntoViewIfNeeded();
      const off = await geometry(row);
      await page.mouse.move(off.image.x + off.image.width / 2, off.image.y + off.image.height / 2); await paint(page);
      assert.equal((await geometry(row)).active, false, 'FOCUS OFF keeps the fit image');
      await focus.click();
      await row.locator('[data-interaction=candidate]').click();
    }
  }

  const row = page.locator('.image-row').first(), frame = row.locator('.original-frame');
  const enter = async () => {
    await frame.scrollIntoViewIfNeeded(); const { image } = await geometry(row);
    await page.mouse.move(image.x + image.width / 2, image.y + image.height / 2);
    await row.locator('.original-focus-active').waitFor();
  };
  await row.locator('[data-interaction=include]').click(); await enter();
  await page.setViewportSize({ width: 1100, height: 900 }); await paint(page);
  assert.equal((await geometry(row)).active, false, 'resize clears stale zoom transforms');
  await enter();
  await row.locator('[data-sam3-action=cancel]').evaluate(button => button.click());
  assert.equal((await geometry(row)).active, false, 'discard resets FOCUS while the cursor is still inside');
  assert.equal(await row.locator('[data-sam3-focus]').getAttribute('aria-pressed'), 'true', 'discard preserves the FOCUS preference');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'FOCUS creates no page-wide overflow');
  assert.deepEqual(inferenceRequests, [], 'FOCUS changes do not submit inference');
  assert.deepEqual(errors, []);
  console.log('SAM3 ORIGINAL FOCUS: desktop/mobile, portrait/wide/large images, edge anchors, exact scale, point coordinates, toggle, resize and discard PASS');
} finally {
  await browser?.close(); server.kill('SIGTERM');
}
