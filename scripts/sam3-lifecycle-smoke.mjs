import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { encodeMask, maskBytesToBase64 } from '../src/mask-codec.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const port = 5349;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
let browser;
const pixels = new Uint8Array(160 * 120);
for (let y = 20; y < 30; y++) pixels.fill(1, y * 160 + 20, y * 160 + 30);
const asset = await encodeMask(pixels, 160, 120);
const candidate = { candidateId: 'mock-candidate', score: 0.9, bbox: asset.bbox,
  mask: { codec: asset.codec, byteLength: asset.byteLength, dataBase64: maskBytesToBase64(asset.data), sha256: asset.sha256 } };
try {
  await new Promise((resolve, reject) => {
    server.stdout.once('data', resolve); server.once('error', reject);
    server.once('exit', code => reject(new Error(`server exited: ${code}`)));
  });
  browser = await chromium.launch({ headless: true });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: mobile });
    const page = await context.newPage(), errors = [], jobs = new Map(), deleted = [];
    let status = 'loading', elapsed = 12, healthRequests = 0, inferences = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/sam3/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path.endsWith('/health')) {
        healthRequests++;
        return route.fulfill({ json: { status, modelLoaded: status === 'ready', modelPath: '/mock/sam3.pt', gpuAvailable: true, loadElapsedSeconds: status === 'loading' ? elapsed : null } });
      }
      if (path.endsWith('/images')) return route.fulfill({ json: { imageId: 'mock-image', width: 160, height: 120 } });
      if (path.endsWith('/infer')) {
        const jobId = `job-${++inferences}`, payload = request.postDataJSON();
        jobs.set(jobId, payload);
        return route.fulfill({ status: 202, json: { jobId, requestId: payload.requestId, status: 'queued' } });
      }
      if (path.includes('/jobs/')) {
        const jobId = path.split('/').at(-1);
        if (request.method() === 'DELETE') { deleted.push(jobId); return route.fulfill({ json: { cancelled: true } }); }
        return route.fulfill({ json: { jobId, requestId: jobs.get(jobId).requestId, status: status === 'loading' ? 'loading' : 'ready', candidates: [candidate] } });
      }
      return route.fulfill({ json: { deleted: true } });
    });
    await page.goto(`http://127.0.0.1:${port}`);
    await page.uncheck('#autosaveEnabled');
    const fixture = await page.evaluate(async () => {
      const { PROJECT_VERSION } = await import('/src/model.js');
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 120;
      canvas.getContext('2d').fillRect(0, 0, 160, 120);
      return { version: PROJECT_VERSION, pages: Array.from({ length: 51 }, (_, index) => ({ name: `page-${index + 1}.png`, src: canvas.toDataURL(), imageWidth: 160, imageHeight: 120, layers: [] })) };
    });
    await page.locator('#projectInput').setInputFiles({ name: 'sam3-lifecycle.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
    await page.waitForFunction(() => document.querySelectorAll('.thumbnail').length === 51 && !document.querySelector('#projectLoad').disabled);
    const ids = await page.locator('.thumbnail').evaluateAll(nodes => nodes.map(node => node.dataset.pageId));
    const activePanel = () => page.locator('.image-row.active .sam3-panel');
    const choose = async index => {
      const thumbnail = page.locator(`.thumbnail[data-page-id="${ids[index]}"]`);
      if (mobile) await thumbnail.tap(); else await thumbnail.click();
      await page.waitForFunction(id => document.querySelector('.image-row.active')?.dataset.pageId === id, ids[index]);
    };
    await activePanel().locator('.sam3-connection').filter({ hasText: '経過12秒' }).waitFor();
    assert.equal(inferences, 0, 'initial loading and mounting do not infer');
    // Keep edits and keyboard focus through a shared periodic health update.
    const input = activePanel().locator('[data-sam3-prompt]');
    await input.fill('画像A'); await input.focus();
    await activePanel().locator('[data-sam3-model-path]').fill('/unsaved/path.pt');
    await input.focus(); elapsed = 13;
    await activePanel().locator('.sam3-connection').filter({ hasText: '経過13秒' }).waitFor();
    assert.equal(await input.evaluate(node => node === document.activeElement), true);
    assert.equal(await activePanel().locator('[data-sam3-model-path]').inputValue(), '/unsaved/path.pt');
    const beforePoll = healthRequests;
    elapsed = 14;
    await activePanel().locator('.sam3-connection').filter({ hasText: '経過14秒' }).waitFor();
    assert.ok(healthRequests - beforePoll <= 2, '50 mounted panels share one periodic health request');
    await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('.image-row.active [data-sam3-request-status]').textContent === 'モデルの準備待ち');
    await choose(1);
    await page.waitForFunction(() => document.querySelector('.image-row.active .sam3-connection').textContent.includes('モデル読込中'));
    assert.equal(await activePanel().locator('[data-sam3-request-status]').innerText(), '待機中');
    await page.waitForFunction(() => !document.querySelector('.image-row.active .sam3-candidate'));
    await choose(50); // Unmount A and B; the shared load continues on the next display range.
    await activePanel().locator('.sam3-connection').filter({ hasText: 'モデル読込中' }).waitFor();
    assert.equal(inferences, 1, 'thumbnail navigation does not start another inference');
    status = 'ready';
    await activePanel().locator('.sam3-connection').filter({ hasText: 'SAM3準備完了' }).waitFor();
    await activePanel().locator('[data-sam3-prompt]').fill('画像C');
    if (mobile) await activePanel().locator('[data-sam3-action=detect]').tap();
    else await activePanel().locator('[data-sam3-prompt]').press('Enter');
    await page.waitForFunction(() => document.querySelector('.image-row.active [data-sam3-request-status]').textContent === '候補を確認可能');
    assert.equal(jobs.get('job-2').prompt, '画像C');
    assert.ok(deleted.includes('job-1'), 'old image job was cancelled');
    await choose(0); // Remount previously discarded panels with current shared state.
    await activePanel().locator('.sam3-connection').filter({ hasText: 'SAM3準備完了' }).waitFor();
    if (!mobile) {
      await page.locator('.image-row.active [data-interaction=include]').click();
      await page.locator('.image-row.active .sam3-overlay').hover();
      await page.waitForFunction(() => document.querySelector('.image-row.active .original-frame').classList.contains('original-focus-active'));
      await activePanel().locator('[data-sam3-action=health]').click();
      assert.equal(inferences, 2, 'health refresh in ORIGINAL FOCUS does not infer');
    }
    await page.locator('.image-row.active [data-action=preview-full]').click();
    assert.equal(await page.locator('#fullPreview').evaluate(node => node.open), true);
    await page.locator('#fullPreviewClose').click();
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('SAM3 shared lifecycle: 51 images, cancelled reload, range switch/remount, one monitor, input/focus retention, desktop/touch/keyboard and full preview PASS');
} finally {
  await browser?.close(); server.kill();
}
