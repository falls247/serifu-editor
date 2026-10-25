import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { encodeMask, maskBytesToBase64 } from '../src/mask-codec.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const port = 5341;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
let browser, idleSeconds = 125, revision = 0, failSave = false, delayResult = false;
let releaseResult;
const jobs = new Map(), requests = [], activities = [];
const bits = new Uint8Array(400 * 300);
for (let y = 40; y < 130; y++) bits.fill(1, y * 400 + 80, y * 400 + 200);
const encoded = await encodeMask(bits, 400, 300);
const candidate = { candidateId: 'candidate-1', score: 0.9, bbox: encoded.bbox,
  mask: { codec: encoded.codec, byteLength: encoded.byteLength, dataBase64: maskBytesToBase64(encoded.data), sha256: encoded.sha256 } };
const health = () => ({ status: 'ready', modelLoaded: true, gpuAvailable: true, modelPath: '/models/sam3.pt',
  modelIdleSeconds: idleSeconds, settingsRevision: revision, activityEpoch: 'abc123', activityWindow: 100,
  idleElapsedSeconds: 0, idleRemainingSeconds: idleSeconds, modelGeneration: 'same', loadCount: 1 });
const paint = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const preview = row => row.locator('canvas.preview').evaluate(c => c.toDataURL());
const overlayPixels = row => row.locator('.sam3-overlay').evaluate(c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v));
const ready = page => page.waitForFunction(() => document.querySelector('[data-sam3-request-status]')?.textContent === '候補を確認可能');

try {
  await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
  await context.route('**/api/sam3/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path.endsWith('/health')) return route.fulfill({ json: health() });
    if (path.endsWith('/activity')) { activities.push(req.postDataJSON()); return route.fulfill({ json: { accepted: true } }); }
    if (path.endsWith('/settings')) {
      if (failSave) return route.fulfill({ status: 500, json: { error: { message: '保存失敗のテスト' } } });
      const body = req.postDataJSON(); assert.deepEqual(Object.keys(body), ['modelIdleSeconds']);
      idleSeconds = body.modelIdleSeconds; revision++;
      return route.fulfill({ json: health() });
    }
    if (path.endsWith('/images')) return route.fulfill({ json: { imageId: 'mock-image', width: 400, height: 300 } });
    if (path.endsWith('/infer')) {
      const payload = req.postDataJSON(), jobId = `job-${requests.length + 1}`;
      requests.push(payload); jobs.set(jobId, payload);
      return route.fulfill({ status: 202, json: { jobId, requestId: payload.requestId, status: 'queued' } });
    }
    if (path.includes('/jobs/') && req.method() === 'GET') {
      if (delayResult) await new Promise(resolve => { releaseResult = resolve; });
      const jobId = path.split('/').at(-1);
      return route.fulfill({ json: { jobId, requestId: jobs.get(jobId).requestId, status: 'ready', candidates: [candidate] } });
    }
    return route.fulfill({ json: { deleted: true } });
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  await page.uncheck('#autosaveEnabled');
  const fixture = await page.evaluate(async () => {
    const { PROJECT_VERSION } = await import('/src/model.js');
    const c = document.createElement('canvas'); c.width = 400; c.height = 300;
    const ctx = c.getContext('2d');
    for (let y = 0; y < 300; y += 5) for (let x = 0; x < 400; x += 5) {
      ctx.fillStyle = (x + y) % 10 ? '#abc5de' : '#e45a91'; ctx.fillRect(x, y, 5, 5);
    }
    return { version: PROJECT_VERSION, pages: [1, 2].map(n => ({ name: `fixture-${n}.png`, src: c.toDataURL(), imageWidth: 400, imageHeight: 300, layers: [] })) };
  });
  const openFixture = async target => {
    await target.locator('#projectInput').setInputFiles({ name: 'fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
    await target.waitForFunction(() => document.querySelectorAll('.image-row').length === 2 && !document.querySelector('#projectLoad').disabled);
  };
  await openFixture(page);
  const row = page.locator('.image-row').first(), panel = row.locator('.sam3-panel');
  const input = panel.locator('[data-sam3-idle-minutes]'), save = panel.locator('[data-sam3-action=save-idle]');
  await page.waitForFunction(() => document.querySelector('[data-sam3-idle-minutes]')?.value === String(125 / 60));
  assert.match(await panel.locator('[data-sam3-idle-status]').innerText(), /125秒/);
  assert.equal(await save.isDisabled(), true, 'fractional environment setting is displayed, never silently rounded');
  for (const value of ['', '0', '241', '1.5']) { await input.fill(value); assert.equal(await save.isDisabled(), true); }
  await input.fill('1'); assert.equal(idleSeconds, 125, 'input alone does not apply');
  failSave = true; await save.click();
  await page.waitForFunction(() => document.querySelector('[data-sam3-idle-status]')?.textContent.includes('保存に失敗'));
  assert.equal(idleSeconds, 125);
  assert.equal(await input.inputValue(), '1');
  failSave = false; await save.click();
  await page.waitForFunction(() => document.querySelector('[data-sam3-idle-status]')?.textContent.includes('60秒'));
  assert.equal(idleSeconds, 60);
  const other = await context.newPage();
  await other.goto(`http://127.0.0.1:${port}`); await other.uncheck('#autosaveEnabled'); await openFixture(other);
  await other.locator('[data-sam3-idle-minutes]').first().fill('2');
  await other.locator('[data-sam3-action=save-idle]').first().click();
  await other.waitForFunction(() => document.querySelector('[data-sam3-idle-status]')?.textContent.includes('120秒'));
  await panel.locator('[data-sam3-action=health]').click();
  await page.waitForFunction(() => document.querySelector('[data-sam3-idle-minutes]')?.value === '2');
  await other.close();
  assert.ok(activities.length > 0, 'real key, pointer and input operations are aggregated');
  await panel.locator('[data-sam3-prompt]').fill('face'); await panel.locator('[data-sam3-action=detect]').click(); await ready(page);
  assert.equal(await overlayPixels(row), true, 'new candidates are initially visible');
  const baseline = await preview(row);
  for (const effect of ['pixelate', 'blur', 'fill-black', 'fill-white']) {
    await panel.locator('[data-sam3-effect]').selectOption(effect);
    await panel.locator('[data-sam3-action=all]').click(); await paint(page);
    assert.notEqual(await preview(row), baseline, `${effect} draft preview is applied`);
    for (let i = 0; i < 2; i++) await panel.locator('[data-sam3-action=none]').click();
    await paint(page);
    assert.equal(await preview(row), baseline, `${effect} draft is fully removed`);
    assert.equal(await overlayPixels(row), false);
    assert.equal(await panel.locator('[data-sam3-action=commit]').isDisabled(), true);
    assert.equal(await panel.locator('.sam3-candidate').count(), 1, 'candidate data survives clear');
    await row.locator('.original').hover({ force: true }); await paint(page);
    assert.equal(await overlayPixels(row), false, 'hover cannot restore a cleared mask');
    await panel.locator('input[data-candidate-id]').check();
    assert.equal(await overlayPixels(row), true, 'list reselection restores preview');
    await panel.locator('[data-sam3-action=none]').click();
  }
  // In-flight results started before clear must stay unselected and invisible.
  delayResult = true; releaseResult = null;
  await panel.locator('[data-sam3-action=detect]').click();
  while (!releaseResult) await new Promise(resolve => setTimeout(resolve, 10));
  await panel.locator('[data-sam3-action=none]').click();
  delayResult = false; releaseResult(); await ready(page);
  assert.equal(await overlayPixels(row), false);
  assert.equal(await preview(row), baseline);
  const countAfterDelayed = requests.length;
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await panel.locator('[data-interaction=exclude]').click();
    await row.locator('.original').hover({ force: true }); await paint(page);
    assert.equal(await overlayPixels(row), false, 'original FOCUS and resize preserve clear state');
    await row.locator('[data-action=preview-focus]').click(); await paint(page);
    assert.equal(await overlayPixels(row), false, 'live FOCUS does not restore candidates');
    await row.locator('[data-action=preview-full]').click();
    await page.waitForFunction(() => document.querySelector('#fullPreview').open);
    assert.equal(await page.locator('#fullPreviewCanvas').evaluate(c => c.toDataURL()), baseline, 'original-size view excludes unconfirmed masks');
    await page.locator('#fullPreviewClose').click();
    const idleBox = await input.boundingBox();
    assert.ok(idleBox.width >= 40);
    await input.focus(); assert.equal(await input.evaluate(n => n === document.activeElement), true);
  }
  assert.equal(requests.length, countAfterDelayed, 'clear, focus and resize add no inference');
  await panel.locator('[data-sam3-action=detect]').click(); await ready(page);
  assert.equal(await overlayPixels(row), true, 'explicit detection restores initial display');
  await panel.locator('[data-sam3-action=all]').click(); await panel.locator('[data-sam3-action=commit]').click();
  await page.waitForFunction(() => document.querySelector('.mask-effect-card'));
  const committed = await preview(row);
  await panel.locator('[data-sam3-action=detect]').click(); await ready(page);
  await panel.locator('[data-sam3-action=all]').click(); await panel.locator('[data-sam3-action=none]').click();
  assert.equal(await preview(row), committed, 'clear preserves committed masks');
  assert.equal(await row.locator('.mask-effect-card').count(), 1);
  await panel.locator('[data-interaction=exclude]').click();
  await row.locator('[data-sam3-focus]').click();
  await row.locator('.sam3-overlay').click({ position: { x: 10, y: 10 } });
  const pointOnly = await row.locator('.sam3-overlay').evaluate(c => c.toDataURL());
  assert.equal(await panel.locator('.sam3-point-chip').count(), 1);
  await panel.locator('[data-sam3-action=all]').click(); await panel.locator('[data-sam3-action=none]').click();
  assert.equal(await row.locator('.sam3-overlay').evaluate(c => c.toDataURL()), pointOnly, 'clear preserves foreground/background point layer exactly');
  await panel.locator('[data-sam3-action=clear-points]').click();
  await panel.locator('[data-interaction=candidate]').click();
  await panel.locator('input[data-candidate-id]').tap();
  await panel.locator('[data-sam3-action=none]').focus(); await panel.locator('[data-sam3-action=none]').press('Enter');
  assert.equal(await overlayPixels(row), false, 'touch selection and keyboard clear');
  assert.deepEqual(errors, []);
  console.log('SAM3 idle settings, cross-tab updates, four clear-all effects, delayed results, focus/resize/full-size, committed masks and real activity: PASS');
} finally { await browser?.close(); server.kill('SIGTERM'); }
