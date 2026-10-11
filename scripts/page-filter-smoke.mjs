import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const port = 5219;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
let browser, page;
try {
  await new Promise((resolve, reject) => {
    server.stdout.once('data', resolve);server.once('error', reject);
    server.once('exit', code => reject(new Error(`server exited: ${code}`)));
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);await page.uncheck('#autosaveEnabled');
  const fixture = await page.evaluate(async () => {
    const { newLayer } = await import('./src/renderer.js');
    const canvas = document.createElement('canvas');canvas.width = 160;canvas.height = 120;
    canvas.getContext('2d').fillRect(0, 0, 160, 120);
    return { version: 6, pages: Array.from({ length: 108 }, (_, i) => ({
      name: `${String(i + 1).padStart(3, '0')}.png`, src: canvas.toDataURL(), done: false,
      layers: i % 2 ? [{ ...newLayer('dialogue', 160, 120, 'female'), text: `台詞${i + 1}`, font: 'sans' }] : [],
    })) };
  });
  await page.locator('#projectInput').setInputFiles({ name: 'filter-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  const ready = () => page.waitForFunction(() => !document.querySelector('#projectLoad').disabled);
  await page.waitForFunction(() => document.querySelectorAll('.thumbnail').length === 108 && !document.querySelector('#projectLoad').disabled);
  const rows = page.locator('.image-row'), thumbs = page.locator('.thumbnail:visible');
  const filter = name => page.locator(`[data-page-filter="${name}"]`).click();
  const names = () => thumbs.locator('.thumbnail-name').allTextContents();
  const activeName = () => page.locator('.image-row.active .page-name').textContent();
  assert.equal(await rows.count(), 50);assert.equal(await thumbs.count(), 108);
  await filter('unedited');
  assert.equal(await thumbs.count(), 54);assert.equal(await rows.count(), 50);
  assert.equal(await page.locator('[data-page-filter=unedited]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#thumbnailFilterCount').textContent(), '54 / 108枚');
  assert.equal(await page.locator('#viewRange').textContent(), '1–50 / 54枚');
  assert.equal(await activeName(), '001.png');
  await page.click('#next');assert.equal(await activeName(), '003.png');
  await page.click('#previous');assert.equal(await activeName(), '001.png');
  await page.click('#nextBatch');assert.equal(await activeName(), '101.png');
  assert.equal(await page.locator('#viewRange').textContent(), '51–54 / 54枚');assert.equal(await rows.count(), 4);
  assert.deepEqual(await rows.locator('.page-number').allTextContents(), ['101', '103', '105', '107']);
  assert.equal(await page.locator('#nextBatch').isDisabled(), true);
  await page.selectOption('#pageSize', '100');assert.equal(await rows.count(), 54);
  await page.selectOption('#pageSize', 'all');assert.equal(await rows.count(), 54);
  await page.selectOption('#pageSize', '50');
  await filter('edited');assert.equal(await thumbs.count(), 54);assert.equal(await activeName(), '002.png');
  assert.equal(await page.locator('#jump option').count(), 54);
  assert.equal(await page.locator('#jump option').first().textContent(), '2. 002.png');
  assert.ok((await names()).every(name => Number(name.slice(0, 3)) % 2 === 0));
  await page.click('#next');assert.equal(await activeName(), '004.png');

  // D&D uses global page positions even when intervening pages are hidden.
  const source = thumbs.filter({ has: page.locator('.thumbnail-name', { hasText: '002.png' }) });
  const target = thumbs.filter({ has: page.locator('.thumbnail-name', { hasText: '006.png' }) });
  const box = await target.boundingBox();
  await source.dragTo(target, { targetPosition: { x: box.width - 12, y: 20 } });
  assert.deepEqual((await names()).slice(0, 3), ['004.png', '006.png', '002.png']);
  const globalNames = await page.locator('.thumbnail .thumbnail-name').allTextContents();
  assert.deepEqual(globalNames.slice(0, 6), ['001.png', '003.png', '004.png', '005.png', '006.png', '002.png']);

  await filter('done');assert.equal(await thumbs.count(), 0);assert.equal(await rows.count(), 0);
  assert.equal(await page.locator('#filteredEmpty').isVisible(), true);
  assert.equal(await page.locator('#thumbnailFilterEmpty').isVisible(), true);
  assert.equal(await page.locator('#viewRange').textContent(), '0 / 0枚');
  assert.equal(await page.locator('#jump').isDisabled(), true);
  assert.equal(await page.locator('#save').isDisabled(), false);
  await filter('pending');assert.equal(await thumbs.count(), 108);
  await page.locator('.image-row.active [data-action=complete]').click();
  assert.equal(await activeName(), '003.png');assert.equal(await thumbs.count(), 107);
  await filter('done');assert.equal(await thumbs.count(), 1);assert.equal(await activeName(), '001.png');
  await page.locator('.image-row.active [data-action=add-female]').click();
  assert.equal(await rows.count(), 1, 'editing must retain the active page when it leaves the filter');
  await page.locator('.image-row.active textarea').fill('編集中のページを保持');
  assert.match(await page.locator('#thumbnailFilterCount').textContent(), /0 \/ 108枚.*編集中/);
  await page.locator('.image-row.active [data-action=undo]').click();
  await page.locator('.image-row.active [data-action=undo]').click();
  assert.equal(await page.locator('.image-row.active').evaluate(node => node.classList.contains('done')), true);
  assert.equal(await page.locator('#thumbnailFilterCount').textContent(), '1 / 108枚');

  await filter('unedited');
  await page.locator('.image-row.active [data-action=add-female]').click();
  await page.locator('.image-row.active textarea').fill('未編集から編集中');
  assert.equal(await activeName(), '001.png');assert.equal(await thumbs.count(), 54);
  assert.match(await page.locator('#thumbnailFilterCount').textContent(), /53 \/ 108枚.*編集中/);
  await page.click('#next');assert.equal(await activeName(), '003.png');assert.equal(await thumbs.count(), 53);
  assert.equal(await thumbs.filter({ has: page.locator('.thumbnail-name', { hasText: '001.png' }) }).count(), 0);

  // A filtered view never narrows the project or text export.
  await page.selectOption('#projectFormat', 'json');
  let pending = page.waitForEvent('download');await page.click('#projectSave');
  let download = await pending;const saved = JSON.parse(await readFile(await download.path(), 'utf8'));await ready();
  assert.equal(saved.pages.length, 108);assert.deepEqual(saved.pages.map(p => p.name), globalNames);
  assert.equal(saved.pages[0].layers[0].text, '未編集から編集中');
  pending = page.waitForEvent('download');await page.click('#textSave');download = await pending;
  const text = await readFile(await download.path(), 'utf8');await ready();
  assert.ok(text.includes('台詞2'));assert.ok(text.includes('未編集から編集中'));
  await page.click('#temporarySave');await page.waitForFunction(() => document.querySelector('#draftStatus').textContent.includes('保存済'));
  await filter('edited');
  await page.reload();await page.waitForSelector('#draftNotice:not([hidden])');
  assert.equal(await page.locator('[data-page-filter=edited]').getAttribute('aria-pressed'), 'true');
  await page.click('#restoreDraft');await ready();
  assert.equal(await thumbs.count(), 55);assert.equal(await rows.count(), 50);
  assert.ok((await rows.locator('.edited-badge').evaluateAll(nodes => nodes.every(node => !node.hidden))));
  await filter('all');assert.equal(await thumbs.count(), 108);
  await page.setViewportSize({ width: 390, height: 844 });await filter('unedited');
  assert.equal(await thumbs.count(), 53);assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('Page filter browser smoke passed: five filters, paging/navigation, global numbering, filtered D&D, empty state, active editing/Undo, full exports, filter persistence and mobile.');
} catch (error) {
  if (page) { await mkdir('artifacts', { recursive: true });await page.screenshot({ path: 'artifacts/page-filter-failure.png', fullPage: true }).catch(() => {}); }
  throw error;
} finally { await browser?.close();server.kill(); }
