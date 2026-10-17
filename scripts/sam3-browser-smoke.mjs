import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { encodeMask, maskBytesToBase64 } from '../src/mask-codec.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const port = 5239;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
const inferRequests = [], deletedJobs = [], jobs = new Map(), latestByRequestScope = new Map();
const imageWidth = 400, imageHeight = 300;
let healthErrorMode = false;
let modelPath = '/models/sam3.pt', settingsFailure = false;
const modelPathSaves = [];

function solidMask(x, y, width = 50, height = 50) {
  const pixels = new Uint8Array(imageWidth * imageHeight);
  for (let row = y; row < y + height; row++) pixels.fill(1, row * imageWidth + x, row * imageWidth + x + width);
  return pixels;
}

const fixtureMasks = [];
for (const [x, y] of [[30, 30], [110, 30], [190, 30], [270, 30]]) {
  const asset = await encodeMask(solidMask(x, y), imageWidth, imageHeight);
  fixtureMasks.push({
    candidateId: `candidate-${fixtureMasks.length + 1}`, score: 0.98 - fixtureMasks.length * 0.03,
    bbox: asset.bbox,
    mask: { codec: asset.codec, byteLength: asset.byteLength, dataBase64: maskBytesToBase64(asset.data), sha256: asset.sha256 },
  });
}
const scrollCandidates = Array.from({ length: 24 }, (_, index) => ({
  ...fixtureMasks[index % fixtureMasks.length], candidateId: `scroll-candidate-${index + 1}`,
}));

async function afterPaint(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function candidateViewport(page) {
  return page.evaluate(() => {
    const list = document.querySelector('[data-sam3-candidates]');
    return { documentTop: document.scrollingElement.scrollTop, paneTop: list.closest('.original-pane').scrollTop, listTop: list.scrollTop };
  });
}

async function checkCandidateScroll(page, panel) {
  const list = panel.locator('[data-sam3-candidates]');
  assert.equal(await list.evaluate(node => node.scrollHeight > node.clientHeight), true, 'candidate list overflows before selection');
  for (const index of [18, 23, 10]) {
    const checkbox = list.locator('input').nth(index);
    await checkbox.scrollIntoViewIfNeeded();
    await checkbox.focus();
    await afterPaint(page);
    const before = await candidateViewport(page), checked = await checkbox.isChecked();
    await checkbox.click();
    await afterPaint(page);
    assert.equal(await checkbox.isChecked(), !checked, 'candidate click updates selection');
    assert.deepEqual(await candidateViewport(page), before, `candidate ${index + 1} preserves document, pane and list scroll`);
    assert.equal(await checkbox.evaluate(node => document.activeElement === node), true, 'candidate retains keyboard focus after clicking');
    await page.keyboard.press('Space');
    await afterPaint(page);
    assert.equal(await checkbox.isChecked(), checked, 'Space toggles the same candidate after clicking');
    assert.deepEqual(await candidateViewport(page), before, 'keyboard selection preserves scroll');
  }
}

async function waitForServer() {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SAM3 browser smoke server did not start')), 10000);
    server.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    server.once('error', reject); server.stderr.on('data', chunk => process.stderr.write(chunk));
  });
}

async function waitForInferCount(page, count) {
  const deadline = Date.now() + 10000;
  while (inferRequests.length < count && Date.now() < deadline) await page.waitForTimeout(20);
  if (inferRequests.length < count) {
    const state = await page.locator('.sam3-panel').innerText();
    const overlayState=await page.locator('.sam3-overlay').evaluate(node=>{const rect=node.getBoundingClientRect(),point=document.elementFromPoint(rect.left+rect.width*.24,rect.top+rect.height*.34);return {rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},pointerEvents:getComputedStyle(node).pointerEvents,pointClass:point?.className};});
    throw new Error(`SAM3 request ${count} did not start; saw ${inferRequests.length}; overlay:${JSON.stringify(overlayState)}; UI: ${state}`);
  }
}

async function makeImage(page) {
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 300;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'rgb(90,120,150)'; ctx.fillRect(0, 0, 400, 300);
    for (let y = 30; y < 80; y += 5) for (let x = 30; x < 80; x += 5) {
      ctx.fillStyle = ((x + y) / 5) % 2 ? 'rgb(240,20,20)' : 'rgb(20,30,240)'; ctx.fillRect(x, y, 5, 5);
    }
    ctx.fillStyle = 'rgb(245,10,10)'; ctx.fillRect(122, 42, 8, 8);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.locator('#fileInput').setInputFiles({ name: 'sam3-fixture.png', mimeType: 'image/png', buffer: Buffer.from(encoded, 'base64') });
  await page.waitForFunction(() => document.querySelectorAll('.image-row').length === 1 && !document.querySelector('#projectLoad').disabled);
}

async function fulfillApi(route) {
  const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
  if (pathname === '/api/sam3/health') return route.fulfill({ json: healthErrorMode
    ? { status: 'error', modelLoaded: false, gpuAvailable: true, modelPath, error: { code: 'MODEL_NOT_FOUND', message: 'SAM3モデルが見つからない' } }
    : { status: 'ready', modelLoaded: true, gpuAvailable: true, modelPath } });
  if (pathname === '/api/sam3/settings' && request.method() === 'POST') {
    if (settingsFailure) return route.fulfill({ status: 500, json: { error: { code: 'SETTINGS_SAVE_FAILED', message: '保存先の権限を確認' } } });
    modelPath = request.postDataJSON().modelPath;
    modelPathSaves.push(modelPath);
    return route.fulfill({ json: { modelPath } });
  }
  if (pathname === '/api/sam3/images' && request.method() === 'POST') return route.fulfill({ json: { imageId: 'mock-image', width: imageWidth, height: imageHeight, expiresAt: '2099-01-01T00:00:00Z' } });
  if (pathname === '/api/sam3/infer' && request.method() === 'POST') {
    const payload = request.postDataJSON(), split = payload.requestId?.lastIndexOf(':') ?? -1;
    if (!/^[A-Za-z0-9_-]{1,96}:[0-9]{1,12}$/.test(payload.requestId || '')) return route.fulfill({ status: 422, json: { error: { code: 'INVALID_REQUEST_ID', message: 'bad request id' } } });
    const scope = payload.requestId.slice(0, split), sequence = Number(payload.requestId.slice(split + 1));
    if (sequence <= (latestByRequestScope.get(scope) ?? -1)) return route.fulfill({ status: 409, json: { error: { code: 'SUPERSEDED', message: 'stale sequence' } } });
    latestByRequestScope.set(scope, sequence);
    const jobId = `mock-job-${jobs.size + 1}`;
    inferRequests.push(payload); jobs.set(jobId, { payload, polls: 0 });
    return route.fulfill({ status: 202, json: { jobId, status: 'queued', requestId: payload.requestId } });
  }
  if (pathname.startsWith('/api/sam3/jobs/') && request.method() === 'GET') {
    const jobId = decodeURIComponent(pathname.slice('/api/sam3/jobs/'.length)), job = jobs.get(jobId);
    if (!job) return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'missing' } } });
    job.polls++;
    if (job.payload.prompt === 'キャンセル用') return route.fulfill({ json: { jobId, status: 'running', requestId: job.payload.requestId } });
    if (job.payload.mode === 'refine' && job.payload.requestId.endsWith(':2')) {
      return route.fulfill({ json: { jobId, status: 'running', requestId: job.payload.requestId } });
    }
    const candidates = job.payload.mode === 'refine'
      ? [fixtureMasks[0]]
      : job.payload.prompt === 'スクロール確認' ? scrollCandidates : fixtureMasks;
    return route.fulfill({ json: { jobId, status: 'ready', requestId: job.payload.requestId, candidates,
      ...(job.payload.prompt === '標識' ? { warnings: ['一部候補は応答上限により省略'] } : {}) } });
  }
  if (pathname.startsWith('/api/sam3/jobs/') && request.method() === 'DELETE') {
    deletedJobs.push(decodeURIComponent(pathname.slice('/api/sam3/jobs/'.length)));
    return route.fulfill({ json: { cancelled: true } });
  }
  if (pathname.startsWith('/api/sam3/images/') && request.method() === 'DELETE') return route.fulfill({ json: { deleted: true } });
  return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: pathname } } });
}

try {
  await waitForServer();
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 2, acceptDownloads: true });
  const page = await context.newPage(), errors = [];
  await page.addInitScript(() => { Object.defineProperty(window, 'Worker', { configurable: true, value: undefined }); });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/sam3/**', fulfillApi);
  await page.goto(`http://localhost:${port}`, { waitUntil: 'domcontentloaded' });
  await makeImage(page);
  const row = page.locator('.image-row.active'), panel = row.locator('.sam3-panel'), overlay = row.locator('.sam3-overlay');
  await page.waitForFunction(() => document.querySelector('.sam3-connection')?.textContent.includes('接続済み'));

  const pathInput = panel.locator('[data-sam3-model-path]'), savePath = panel.locator('[data-sam3-action=save-model-path]');
  assert.equal(await pathInput.inputValue(), '/models/sam3.pt');
  assert.equal(await savePath.isDisabled(), true);
  assert.equal(await panel.locator('[data-sam3-model-path-status]').isHidden(), true, 'initial model path does not show a saved notice');
  assert.equal(await panel.locator('text=ピクセレートとぼかしは').count(), 0);
  assert.equal(await pathInput.evaluate(input => !!input.closest('.original-pane')?.querySelector('.preview-label')), true);
  await pathInput.fill('/models/new sam3.pt');
  assert.deepEqual(modelPathSaves, [], 'editing path alone does not save');
  assert.equal(modelPath, '/models/sam3.pt');
  assert.match(await panel.locator('[data-sam3-model-path-status]').innerText(), /未保存/);
  await panel.locator('[data-sam3-action=health]').click();
  await page.waitForFunction(() => document.querySelector('.sam3-connection')?.textContent.includes('接続済み'));
  assert.equal(await pathInput.inputValue(), '/models/new sam3.pt', 'health refresh preserves unsaved edits');
  await savePath.click();
  await page.waitForFunction(() => document.querySelector('[data-sam3-model-path-status]')?.textContent.startsWith('保存済み'));
  assert.deepEqual(modelPathSaves, ['/models/new sam3.pt']);
  assert.equal(await savePath.isDisabled(), true);
  await panel.locator('[data-sam3-action=health]').click();
  await page.waitForFunction(() => document.querySelector('.sam3-connection')?.textContent.includes('接続済み'));
  assert.equal(await panel.locator('[data-sam3-model-path-status]').isHidden(), true, 'health check does not show a saved notice');
  settingsFailure = true;
  await pathInput.fill('/models/failed.pt');
  await savePath.click();
  await page.waitForFunction(() => document.querySelector('[data-sam3-model-path-status]')?.textContent.includes('保存に失敗'));
  assert.equal(await pathInput.inputValue(), '/models/failed.pt', 'failed save preserves edited path');
  assert.equal(modelPath, '/models/new sam3.pt');
  assert.equal(await savePath.isEnabled(), true);
  settingsFailure = false;
  await pathInput.fill(modelPath);
  assert.equal(await panel.locator('[data-sam3-model-path-status]').isHidden(), true, 'reverting an unsaved path hides the status');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await makeImage(page);
  await page.waitForFunction(() => document.querySelector('[data-sam3-model-path]')?.value === '/models/new sam3.pt');
  assert.equal(await panel.locator('[data-sam3-model-path-status]').isHidden(), true, 'loading a stored path does not show a saved notice');

  const promptInput=panel.locator('[data-sam3-prompt]');
  await page.evaluate(()=>{window.__sam3DetectClicks=0;document.querySelector('[data-sam3-action=detect]').addEventListener('click',()=>window.__sam3DetectClicks++);});
  await promptInput.fill('   ');await promptInput.press('Enter');
  assert.equal(await page.evaluate(()=>window.__sam3DetectClicks),0,'Enter ignores a disabled empty-prompt detect button');
  await promptInput.fill('標識');
  const ignoredEnterClicks=await promptInput.evaluate(input=>{
    for(const options of [{isComposing:true},{keyCode:229},{repeat:true}])input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...options}));
    return window.__sam3DetectClicks;
  });
  assert.equal(ignoredEnterClicks,0,'IME confirmation and repeated Enter must not trigger detection');
  await promptInput.press('Enter');
  try { await page.waitForFunction(() => document.querySelectorAll('.sam3-candidate').length === 4, { timeout: 12000 }); }
  catch (error) { console.error('SAM3 UI state:', await panel.innerText(), 'infer requests:', inferRequests); throw error; }
  assert.equal(await page.evaluate(()=>window.__sam3DetectClicks),1,'Enter activates exactly the same detect button');
  assert.equal(inferRequests[0].mode,'text');assert.equal(inferRequests[0].prompt,'標識');
  assert.match(await panel.locator('[data-sam3-warning]').innerText(), /一部候補は応答上限により省略/);
  const newest = inferRequests[0].requestId, split = newest.lastIndexOf(':'), staleRequestId = `${newest.slice(0, split)}:${newest.slice(split + 1)}`;
  const staleResponse = await page.evaluate(async requestId => {
    const response = await fetch('/api/sam3/infer', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageId: 'mock-image', requestId, mode: 'text', prompt: 'stale', threshold: 0.5 }) });
    return { status: response.status, body: await response.json() };
  }, staleRequestId);
  assert.equal(staleResponse.status, 409, 'mock API rejects a repeated or older sequence for the same request scope');
  assert.equal(staleResponse.body.error.code, 'SUPERSEDED');
  await panel.locator('[data-sam3-action=none]').click();
  await overlay.scrollIntoViewIfNeeded();
  const candidateBox = await overlay.boundingBox();
  await page.mouse.click(candidateBox.x + candidateBox.width * 135 / imageWidth, candidateBox.y + candidateBox.height * 55 / imageHeight);
  assert.equal(await panel.locator('input[data-candidate-id="candidate-2"]').isChecked(), true, 'ORIGINAL overlay selects a candidate at source-image coordinates');
  await panel.locator('input[data-candidate-id="candidate-2"]').uncheck();
  await panel.locator('input[data-candidate-id="candidate-1"]').check();
  await panel.locator('[data-interaction=include]').click();
  await overlay.scrollIntoViewIfNeeded();
  const overlayBox = await overlay.boundingBox();
  await page.mouse.click(overlayBox.x + overlayBox.width * 0.24, overlayBox.y + overlayBox.height * 0.34);
  await waitForInferCount(page, 2);
  await panel.locator('[data-interaction=exclude]').click();
  await overlay.scrollIntoViewIfNeeded();
  const negativePointBox = await overlay.boundingBox();
  await page.mouse.click(negativePointBox.x + negativePointBox.width * 0.31, negativePointBox.y + negativePointBox.height * 0.48);
  await waitForInferCount(page, 3);
  await page.waitForFunction(() => document.querySelector('[data-sam3-request-status]')?.textContent === '候補を確認可能' && !document.querySelector('[data-sam3-action=commit]').disabled);
  assert.equal(inferRequests[2].mode, 'refine');
  assert.equal(inferRequests[2].candidateId, 'candidate-1');
  assert.deepEqual(inferRequests[2].points.map(({ positive }) => positive), [true, false]);
  await panel.locator('[data-interaction=candidate]').click();
  const displayToggle = panel.locator('[data-sam3-display]');
  await displayToggle.uncheck();
  assert.equal(await overlay.evaluate(node => getComputedStyle(node).pointerEvents), 'none');
  const visiblePointPixels = await overlay.evaluate(node => {
    const pixels = node.getContext('2d').getImageData(0, 0, node.width, node.height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 126 && pixels[i + 1] === 226 && pixels[i + 2] === 147 && pixels[i + 3] > 0) count++;
    return count;
  });
  assert.ok(visiblePointPixels > 0, 'foreground points remain visible when candidate masks are hidden');
  await displayToggle.check();
  for (let attempt = 0; attempt < 100 && !deletedJobs.includes('mock-job-2'); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(deletedJobs.includes('mock-job-2'), 'superseded in-flight point request must be cancelled');

  await panel.locator('[data-sam3-action=all]').click();
  await panel.locator('[data-sam3-action=commit]').click();
  await page.waitForFunction(() => document.querySelectorAll('.mask-effect-card').length === 4);
  await panel.locator('[data-sam3-prompt]').fill('次の標識');
  await panel.locator('[data-sam3-action=detect]').click();
  await page.waitForFunction(() => document.querySelectorAll('.sam3-candidate').length === 4 && document.querySelector('[data-sam3-request-status]')?.textContent === '候補を確認可能');
  assert.equal(await panel.locator('[data-sam3-warning]').isHidden(), true, 'warnings from older responses must not remain on later results');
  await panel.locator('[data-sam3-action=cancel]').click();
  assert.equal(await panel.locator('[data-sam3-action=detect]').count(), 1, 'committing and cancelling a draft must leave SAM3 controls available');
  assert.equal(await panel.locator('.sam3-candidate').count(), 0);
  await panel.locator('[data-sam3-prompt]').fill('キャンセル用');
  const nextRequest = inferRequests.length + 1, previousDeletes = deletedJobs.length;
  await panel.locator('[data-sam3-action=detect]').click();
  await waitForInferCount(page, nextRequest);
  await page.waitForFunction(() => document.querySelector('[data-sam3-request-status]')?.textContent === 'SAM3推論中');
  const clicksWhileRunning=await page.evaluate(()=>window.__sam3DetectClicks);
  await promptInput.press('Enter');assert.equal(await page.evaluate(()=>window.__sam3DetectClicks),clicksWhileRunning,'Enter ignores detection while the button is disabled for inference');
  await panel.locator('[data-sam3-action=cancel]').click();
  for (let attempt = 0; attempt < 100 && deletedJobs.length === previousDeletes; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(deletedJobs.length > previousDeletes, 'cancelling a running draft must delete its pending backend job');
  const effectTypes = ['pixelate', 'blur', 'fill-black', 'fill-white'];
  for (const [index, effect] of effectTypes.entries()) {
    const card=row.locator('.mask-effect-card').nth(index);
    if(!await card.locator('[data-mask-field=effect]').isVisible())await card.locator('.mask-effect-summary').click();
    await card.locator('[data-mask-field=effect]').selectOption(effect);
  }
  await row.locator('.mask-effect-card').nth(0).locator('.mask-effect-summary').click();
  await row.locator('.mask-effect-card').nth(0).locator('[data-mask-field=blockSize]').fill('16');
  await row.locator('.mask-effect-card').nth(0).locator('[data-mask-field=blockSize]').dispatchEvent('change');
  await row.locator('.mask-effect-card').nth(1).locator('.mask-effect-summary').click();
  await row.locator('.mask-effect-card').nth(1).locator('[data-mask-field=blurRadius]').fill('14');
  await row.locator('.mask-effect-card').nth(1).locator('[data-mask-field=blurRadius]').dispatchEvent('change');
  assert.deepEqual(await row.locator('.mask-effect-card').evaluateAll(cards => cards.map(card => card.querySelector('[data-mask-field=effect]').value)), effectTypes);
  assert.deepEqual(await row.locator('.mask-effect-card').first().locator('[data-mask-field]').evaluateAll(inputs => inputs.slice(-4).map(input => Number(input.value))), [30, 30, 50, 50]);

  const cards = row.locator('.mask-effect-card'), canvas = row.locator('canvas.preview');
  assert.equal(await row.locator('.mask-effect-card.selected').count(),1);
  assert.equal(await cards.first().locator('[data-mask-field=effect]').isVisible(),false,'unselected masks hide editing controls');
  assert.match(await cards.first().locator('.mask-effect-summary').innerText(),/マスク加工 1：ピクセレート/);
  await cards.first().locator('.mask-effect-summary').click();
  assert.equal(await cards.first().locator('[data-mask-field=effect]').isVisible(),true,'selecting a compact mask expands its settings');
  assert.equal(await cards.nth(1).locator('[data-mask-field=effect]').isVisible(),false,'previous mask collapses when selection changes');
  await canvas.scrollIntoViewIfNeeded();
  let box = await canvas.boundingBox();
  await canvas.hover({position:{x:box.width*55/imageWidth,y:box.height*55/imageHeight}});
  box=await canvas.boundingBox();
  const center = { x: box.x + box.width * 55 / imageWidth, y: box.y + box.height * 55 / imageHeight };
  await page.mouse.move(center.x, center.y); await page.mouse.down();
  await page.mouse.move(center.x + box.width * 20 / imageWidth, center.y + box.height * 10 / imageHeight, { steps: 4 }); await page.mouse.up();
  assert.equal(Number(await cards.first().locator('[data-mask-field=x]').inputValue()), 50, 'canvas drag must change source-image X');
  assert.equal(Number(await cards.first().locator('[data-mask-field=y]').inputValue()), 40, 'canvas drag must change source-image Y');
  box = await canvas.boundingBox();
  const current = await cards.first().locator('[data-mask-field]').evaluateAll(inputs => Object.fromEntries(inputs.map(input => [input.dataset.maskField, Number(input.value)])));
  const edge = { x: box.x + box.width * (current.x + current.w) / imageWidth, y: box.y + box.height * (current.y + current.h / 2) / imageHeight };
  await page.mouse.move(edge.x, edge.y); await page.mouse.down(); await page.mouse.move(edge.x + box.width * 15 / imageWidth, edge.y, { steps: 3 }); await page.mouse.up();
  assert.ok(Number(await cards.first().locator('[data-mask-field=w]').inputValue()) > current.w, 'canvas resize handle must change source-image width');
  await canvas.focus(); await page.keyboard.press('ArrowRight');
  assert.equal(Number(await cards.first().locator('[data-mask-field=x]').inputValue()), 51, 'arrow key must nudge selected mask by one source pixel');
  await page.keyboard.press('Delete'); assert.equal(await row.locator('.mask-effect-card').count(), 3, 'Delete removes selected mask effect');
  await page.keyboard.press('Control+z'); assert.equal(await row.locator('.mask-effect-card').count(), 4, 'undo restores removed mask');

  await row.locator('[data-action=crop-image]').click();
  const crop = row.locator('[data-crop-field]');
  for (const [field, value] of Object.entries({ x: 10, y: 10, width: 350, height: 250 })) await row.locator(`[data-crop-field=${field}]`).fill(String(value));
  await row.locator('[data-action=apply-crop]').click();
  assert.deepEqual(await canvas.evaluate(node => [node.width, node.height]), [350, 250]);

  await page.locator('#temporarySave').click();
  await page.waitForFunction(() => document.querySelector('#draftStatus').textContent.includes('保存済'));
  const saved = await page.evaluate(async () => {
    const { getDraftMeta, getDraftMasks } = await import('./src/storage.js');
    const meta = await getDraftMeta(), masks = await getDraftMasks(meta.pages.map(item => item.id));
    return { effects: meta.pages[0].maskEffects, maskCount: masks.length, imageSize: [meta.pages[0].imageEdit?.crop.width, meta.pages[0].imageEdit?.crop.height] };
  });
  assert.equal(saved.effects.length, 4); assert.equal(saved.maskCount, 4); assert.deepEqual(saved.imageSize, [350, 250]);
  await page.waitForFunction(() => {
    const thumbnail = document.querySelector('.thumbnail img');
    return thumbnail?.complete && thumbnail.naturalWidth === 320 && thumbnail.naturalHeight === 229;
  });
  const thumbnailComparison = await page.evaluate(async () => {
    const { getDraftMeta, getDraftImages, getDraftMasks } = await import('./src/storage.js');
    const { draw } = await import('./src/renderer.js');
    const { imageSize } = await import('./src/image-edit.js');
    const meta = await getDraftMeta(), pageMeta = meta.pages[0], imageRecord = (await getDraftImages([pageMeta.id]))[0];
    const imageUrl = URL.createObjectURL(imageRecord.blob), original = new Image(); original.src = imageUrl; await original.decode();
    const masks = await getDraftMasks([pageMeta.id]), maskAssets = Object.fromEntries(masks.map(record => [record.id, record.asset]));
    const size = imageSize(original.naturalWidth, original.naturalHeight, pageMeta.imageEdit), ratio = Math.min(1, 320 / Math.max(size.width, size.height));
    const expected = document.createElement('canvas'); expected.width = Math.max(1, Math.round(size.width * ratio)); expected.height = Math.max(1, Math.round(size.height * ratio));
    draw(expected.getContext('2d'), original, pageMeta.layers, null, ratio, ratio, pageMeta.imageEdit,
      { width: original.naturalWidth, height: original.naturalHeight }, { maskEffects: pageMeta.maskEffects, maskAssets });
    const expectedBlob = await new Promise(resolve => expected.toBlob(resolve, 'image/webp', 0.8));
    const referenceUrl = URL.createObjectURL(expectedBlob), reference = new Image(); reference.src = referenceUrl; await reference.decode();
    const thumbnail = document.querySelector(`.thumbnail[data-page-id="${pageMeta.id}"] img`); await thumbnail.decode();
    const actualCanvas = document.createElement('canvas'); actualCanvas.width = thumbnail.naturalWidth; actualCanvas.height = thumbnail.naturalHeight;
    const expectedCanvas = document.createElement('canvas'); expectedCanvas.width = reference.naturalWidth; expectedCanvas.height = reference.naturalHeight;
    actualCanvas.getContext('2d').drawImage(thumbnail, 0, 0); expectedCanvas.getContext('2d').drawImage(reference, 0, 0);
    const actual = actualCanvas.getContext('2d').getImageData(0, 0, actualCanvas.width, actualCanvas.height).data;
    const wanted = expectedCanvas.getContext('2d').getImageData(0, 0, expectedCanvas.width, expectedCanvas.height).data;
    let firstDifference = -1, maxDifference = 0;
    if (actual.length === wanted.length) for (let index = 0; index < actual.length; index++) {
      const difference = Math.abs(actual[index] - wanted[index]); maxDifference = Math.max(maxDifference, difference);
      if (difference && firstDifference < 0) firstDifference = index;
    }
    URL.revokeObjectURL(imageUrl); URL.revokeObjectURL(referenceUrl);
    return { workerDisabled: typeof Worker === 'undefined', dimensions: [actualCanvas.width, actualCanvas.height], expectedDimensions: [expectedCanvas.width, expectedCanvas.height],
      samePixels: firstDifference < 0, firstDifference, maxDifference };
  });
  assert.equal(thumbnailComparison.workerDisabled, true, 'thumbnail rendering must work with Web Worker disabled');
  assert.deepEqual(thumbnailComparison.dimensions, thumbnailComparison.expectedDimensions);
  assert.equal(thumbnailComparison.samePixels, true,
    `mask thumbnail must match PNG original-pixel shrink; first difference ${thumbnailComparison.firstDifference}, max ${thumbnailComparison.maxDifference}`);

  const projectDownloadPromise = page.waitForEvent('download');
  await page.locator('#projectSave').click();
  const projectDownload = await projectDownloadPromise, projectBytes = await readFile(await projectDownload.path());
  const restoredProject = await context.newPage(); await restoredProject.route('**/api/sam3/**', fulfillApi); await restoredProject.goto(`http://localhost:${port}`, { waitUntil: 'domcontentloaded' });
  await restoredProject.locator('#projectInput').setInputFiles({ name: 'sam3.json', mimeType: 'application/json', buffer: projectBytes });
  await restoredProject.waitForFunction(() => document.querySelectorAll('.mask-effect-card').length === 4 && !document.querySelector('#projectLoad').disabled);
  assert.deepEqual(await restoredProject.locator('.mask-effect-card').evaluateAll(cards => cards.map(card => card.querySelector('[data-mask-field=effect]').value)), effectTypes);
  assert.deepEqual(await restoredProject.locator('.image-row.active canvas.preview').evaluate(node => [node.width, node.height]), [350, 250]);

  const pngPromise = restoredProject.waitForEvent('download');
  await restoredProject.locator('.image-row.active [data-action=save-image]').click();
  const png = await pngPromise, pngBase64 = (await readFile(await png.path())).toString('base64');
  const pixelSamples = await restoredProject.evaluate(async encoded => {
    const image = new Image(); image.src = `data:image/png;base64,${encoded}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    return { size: [image.width, image.height], black: [...ctx.getImageData(185, 45, 1, 1).data], white: [...ctx.getImageData(265, 45, 1, 1).data] };
  }, pngBase64);
  assert.deepEqual(pixelSamples.size, [350, 250]);
  assert.deepEqual(pixelSamples.black, [0, 0, 0, 255]);
  assert.deepEqual(pixelSamples.white, [255, 255, 255, 255]);

  healthErrorMode = true;
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#restoreDraft').disabled);
  await page.locator('#restoreDraft').click();
  await page.waitForFunction(() => document.querySelectorAll('.mask-effect-card').length === 4 && !document.querySelector('#projectLoad').disabled);
  assert.deepEqual(await page.locator('.image-row.active canvas.preview').evaluate(node => [node.width, node.height]), [350, 250]);
  assert.deepEqual(await page.locator('.mask-effect-card').evaluateAll(cards => cards.map(card => card.querySelector('[data-mask-field=effect]').value)), effectTypes);
  const restoredPanel = page.locator('.image-row.active .sam3-panel');
  await page.waitForFunction(() => document.querySelector('.sam3-connection')?.textContent.includes('MODEL_NOT_FOUND'));
  await restoredPanel.locator('[data-sam3-prompt]').fill('復元後の検出');
  assert.equal(await restoredPanel.locator('[data-sam3-action=detect]').isDisabled(), false, 'health model errors still allow an explicit inference retry');
  const previousRequest = inferRequests.at(-1).requestId;
  await restoredPanel.locator('[data-sam3-action=detect]').click();
  await page.waitForFunction(() => document.querySelector('[data-sam3-request-status]')?.textContent === '候補を確認可能');
  const remountedRequest = inferRequests.at(-1).requestId;
  assert.notEqual(remountedRequest.slice(0, remountedRequest.lastIndexOf(':')), previousRequest.slice(0, previousRequest.lastIndexOf(':')),
    'restoring the same page starts a fresh backend sequence namespace');
  const restoredPageId = await page.locator('.image-row.active').getAttribute('data-page-id');
  await page.locator('.image-row.active [data-action=duplicate-image]').click();
  await page.waitForFunction(id => document.querySelectorAll('.image-row').length === 2 && document.querySelector('.image-row.active')?.dataset.pageId !== id, restoredPageId);
  const retainedPanel = page.locator(`.image-row[data-page-id="${restoredPageId}"] .sam3-panel`);
  assert.equal(await retainedPanel.locator('[data-sam3-action=detect]').count(), 1, 'switching pages keeps mounted SAM3 controls available');
  assert.equal(await retainedPanel.locator('.sam3-candidate').count(), 0, 'switching pages clears the previous draft');
  await page.locator('#jump').selectOption(restoredPageId);
  await page.waitForFunction(id => document.querySelector('.image-row.active')?.dataset.pageId === id, restoredPageId);
  await retainedPanel.locator('[data-sam3-prompt]').fill('ページ切替後の検出');
  await retainedPanel.locator('[data-sam3-action=detect]').click();
  await page.waitForFunction(() => document.querySelector('.sam3-candidate') && document.querySelector('[data-sam3-request-status]')?.textContent === '候補を確認可能');
  await retainedPanel.locator('[data-sam3-prompt]').fill('スクロール確認');
  await retainedPanel.locator('[data-sam3-action=detect]').click();
  await page.waitForFunction(() => document.querySelectorAll('.sam3-candidate').length === 24);
  for (const viewport of [{ width: 1440, height: 700 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await checkCandidateScroll(page, retainedPanel);
  }
  assert.deepEqual(errors, []);
  console.log('SAM3 mock API stale-sequence rejection, loading/retry handling, four effects, Worker-disabled original-pixel thumbnails, source coordinates, crop/drag/resize, autosave/project restore and PNG export passed');
} finally {
  await browser?.close(); server.kill();
}
