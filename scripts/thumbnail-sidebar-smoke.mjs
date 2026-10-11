import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const port = 5218;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
let browser, page;
try {
  await new Promise((resolve, reject) => {
    server.stdout.once('data', resolve);server.once('error', reject);
    server.once('exit', code => reject(new Error(`server exited: ${code}`)));
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1920, height: 1400 } });
  const errors = [];page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  await page.uncheck('#autosaveEnabled');
  const fixture = await page.evaluate(async () => {
    const { newLayer } = await import('./src/renderer.js');
    const canvas = document.createElement('canvas');canvas.width = 160;canvas.height = 120;
    canvas.getContext('2d').fillRect(0, 0, 160, 120);
    const layer = { ...newLayer('dialogue', 160, 120, 'female'), text: '順序を保つ台詞', font: 'sans' };
    return { version: 6, pages: Array.from({ length: 55 }, (_, i) => ({ name: `${String(i + 1).padStart(3, '0')}.png`, src: canvas.toDataURL(), layers: i === 0 ? [layer] : [], done: i === 0 })) };
  });
  await page.locator('#projectInput').setInputFiles({ name: 'thumbnail-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  const ready = () => page.waitForFunction(() => !document.querySelector('#projectLoad').disabled);
  await page.waitForFunction(() => document.querySelectorAll('.thumbnail').length === 55 && !document.querySelector('#projectLoad').disabled);
  const thumbs = page.locator('.thumbnail');
  const thumb = name => thumbs.filter({ has: page.locator('.thumbnail-name', { hasText: name }) });
  const names = () => thumbs.locator('.thumbnail-name').allTextContents();
  const width = () => page.locator('#thumbnailSidebar').evaluate(node => node.getBoundingClientRect().width);
  const handle = page.locator('#thumbnailResize');
  const resize = async target => {
    const box = await handle.boundingBox(), initial = await width();
    await page.mouse.move(box.x + box.width / 2, box.y + 60);await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + target - initial, box.y + 60, { steps: 8 });await page.mouse.up();
    assert.ok(Math.abs(await width() - target) < 1);
  };
  await resize(300);
  assert.equal(await handle.getAttribute('aria-valuenow'), '300');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('serifu.view.v1')).sidebarWidth), 300);
  const singleTarget = await thumb('003.png').boundingBox();
  await thumb('001.png').dragTo(thumb('003.png'), { targetPosition: { x: 30, y: singleTarget.height - 12 } });
  assert.deepEqual((await names()).slice(0, 4), ['002.png', '003.png', '001.png', '004.png']);
  assert.equal(await thumb('001.png').getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('.image-row.active textarea').inputValue(), '順序を保つ台詞');
  assert.match(await thumb('001.png').locator('.thumbnail-state').textContent(), /編集済み.*確認済み/);
  assert.equal(await page.locator('.image-row.active [data-action=undo]').isDisabled(), true);
  await thumb('001.png').dragTo(thumb('002.png'), { targetPosition: { x: 30, y: 10 } });
  assert.deepEqual((await names()).slice(0, 4), ['001.png', '002.png', '003.png', '004.png']);
  await resize(600);
  const target = await thumb('004.png').boundingBox();
  await thumb('001.png').dragTo(thumb('004.png'), { targetPosition: { x: target.width - 12, y: 35 } });
  assert.deepEqual((await names()).slice(0, 5), ['002.png', '003.png', '004.png', '001.png', '005.png']);
  await thumb('001.png').focus();await page.keyboard.press('Alt+ArrowUp');
  assert.deepEqual((await names()).slice(0, 4), ['002.png', '003.png', '001.png', '004.png']);
  await handle.focus();await page.keyboard.press('ArrowRight');assert.equal(await width(), 610);
  await page.keyboard.press('Shift+ArrowLeft');assert.equal(await width(), 560);

  // Move into an unmounted batch and retain the selected layer and confirmation state.
  await page.evaluate(() => {
    window.thumbnailTransfer = new DataTransfer();
    const source = [...document.querySelectorAll('.thumbnail')].find(node => node.querySelector('.thumbnail-name').textContent === '001.png');
    const box = source.getBoundingClientRect();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.thumbnailTransfer, clientX: box.x + 20, clientY: box.y + 20 }));
  });
  await thumb('055.png').scrollIntoViewIfNeeded();
  await thumb('055.png').evaluate(node => {
    const box = node.getBoundingClientRect();
    for (const type of ['dragover', 'drop']) node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: window.thumbnailTransfer, clientX: box.right - 12, clientY: box.y + 20 }));
  });
  assert.equal((await names()).at(-1), '001.png');
  assert.equal(await page.locator('#viewRange').textContent(), '51–55 / 55枚');
  assert.equal(await page.locator('.image-row.active textarea').inputValue(), '順序を保つ台詞');
  assert.equal(await page.locator('.image-row.active').evaluate(node => node.classList.contains('done')), true);
  assert.equal(await thumb('001.png').locator('.thumbnail-number').textContent(), '55');
  assert.equal(await page.locator('.dragging,.drop-before,.drop-after').count(), 0);
  const ordered = await names();
  // External drops must not reorder pages.
  await thumbs.first().evaluate(node => node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })));
  assert.deepEqual(await names(), ordered);
  await page.locator('#thumbnailList').evaluate(node => node.scrollTop = 0);
  await thumbs.first().evaluate(node => {
    const box = document.querySelector('#thumbnailList').getBoundingClientRect();
    node.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer(), clientY: box.bottom - 5 }));
  });
  await page.waitForFunction(() => document.querySelector('#thumbnailList').scrollTop > 20);
  await thumbs.first().dispatchEvent('dragend');
  assert.equal(await page.locator('.dragging,.drop-before,.drop-after').count(), 0);
  assert.deepEqual(await names(), ordered);

  await page.selectOption('#projectFormat', 'json');
  const pending = page.waitForEvent('download');await page.click('#projectSave');
  const download = await pending, saved = JSON.parse(await readFile(await download.path(), 'utf8'));await ready();
  assert.deepEqual(saved.pages.map(p => p.name), ordered);
  assert.equal(saved.pages.at(-1).layers[0].text, '順序を保つ台詞');assert.equal(saved.pages.at(-1).done, true);
  await page.click('#temporarySave');
  await page.waitForFunction(() => document.querySelector('#draftStatus').textContent.includes('保存済'));
  await page.reload();await page.waitForSelector('#draftNotice:not([hidden])');
  assert.equal(await width(), 560);
  await page.click('#restoreDraft');await ready();assert.deepEqual(await names(), ordered);
  await page.click('#toggleThumbnails');assert.equal(await handle.isVisible(), false);
  await page.click('#toggleThumbnails');assert.equal(await width(), 560);
  await resize(1200);
  assert.equal(await handle.getAttribute('aria-valuemax'), '1280');
  await page.reload();await page.waitForSelector('#draftNotice:not([hidden])');assert.equal(await width(), 1200);
  await page.click('#restoreDraft');await ready();assert.deepEqual(await names(), ordered);
  await page.setViewportSize({ width: 1100, height: 1080 });assert.ok(await width() <= 460);
  await page.setViewportSize({ width: 1920, height: 1080 });assert.equal(await width(), 1200);
  await handle.dblclick();assert.equal(await width(), 576);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('serifu.view.v1')).sidebarWidth), null);
  await resize(220);await handle.focus();await page.keyboard.press('ArrowLeft');assert.equal(await width(), 220);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await handle.isVisible(), false);assert.equal(await width(), 390);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);

  // File drops work on an empty sidebar and append without replacing existing pages.
  const dropPage = await browser.newPage();
  dropPage.on('pageerror', error => errors.push(error.message));
  await dropPage.goto(`http://127.0.0.1:${port}`);
  await dropPage.uncheck('#autosaveEnabled');
  const dropReady = () => dropPage.waitForFunction(() => !document.querySelector('#files').disabled);
  const dropNames = () => dropPage.locator('.thumbnail-name').allTextContents();
  await dropPage.evaluate(async () => {
    const canvas = document.createElement('canvas');canvas.width = 32;canvas.height = 24;
    window.dropImage = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    window.dropFiles = (selector, names) => {
      const transfer = new DataTransfer();
      for (const name of names) transfer.items.add(new File([window.dropImage], name));
      const node = document.querySelector(selector);
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer });
      node.dispatchEvent(over);
      const highlighted = document.querySelector('#thumbnailSidebar').classList.contains('file-drop');
      const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
      node.dispatchEvent(drop);
      return { prevented: over.defaultPrevented && drop.defaultPrevented, highlighted, effect: transfer.dropEffect };
    };
  });
  const firstDrop = await dropPage.evaluate(() => window.dropFiles('#thumbnailList', ['10.png', '2.png', 'notes.txt']));
  assert.equal(firstDrop.prevented, true);assert.equal(firstDrop.highlighted, true);
  await dropReady();assert.deepEqual(await dropNames(), ['2.png', '10.png']);
  const selectedId = await dropPage.locator('.thumbnail.active').getAttribute('data-page-id');
  assert.equal(await dropPage.locator('.file-drop').count(), 0);

  await dropPage.evaluate(() => {
    const sidebar = document.querySelector('#thumbnailSidebar');
    const transfer = new DataTransfer();transfer.items.add(new File([window.dropImage], 'hover.png'));
    const protectedOver = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(protectedOver, 'dataTransfer', { value: { types: ['Files'], files: [], dropEffect: 'none' } });
    sidebar.dispatchEvent(protectedOver);
    if (!protectedOver.defaultPrevented || !sidebar.classList.contains('file-drop')) throw new Error('Protected file drag was not accepted');
    sidebar.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: document.querySelector('.thumbnail'), dataTransfer: transfer }));
    if (!sidebar.classList.contains('file-drop')) throw new Error('Highlight cleared while moving within sidebar');
    sidebar.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: document.body, dataTransfer: transfer }));
  });
  assert.equal(await dropPage.locator('.file-drop').count(), 0);
  const busyDrop = await dropPage.evaluate(() => {
    window.dropFiles('.thumbnail img', ['extra.webp', 'extra.png']);
    return window.dropFiles('#thumbnailSidebar', ['blocked.png']);
  });
  assert.equal(busyDrop.prevented, true);assert.equal(busyDrop.highlighted, false);assert.equal(busyDrop.effect, 'none');
  await dropReady();assert.deepEqual(await dropNames(), ['2.png', '10.png', 'extra.png', 'extra.webp']);
  assert.equal(await dropPage.locator('.thumbnail.active').getAttribute('data-page-id'), selectedId);
  await dropPage.evaluate(() => window.dropFiles('.thumbnail', ['notes.txt']));
  assert.match(await dropPage.locator('#status').textContent(), /追加できる画像がない/);
  assert.deepEqual(await dropNames(), ['2.png', '10.png', 'extra.png', 'extra.webp']);
  assert.equal(await dropPage.locator('.file-drop').count(), 0);
  assert.deepEqual(errors, []);
  await dropPage.close();
  console.log('Thumbnail/sidebar browser smoke passed: reordering, persistence, auto-scroll, resizing, mobile layout, file drops into empty/existing lists, mixed files, protected drag data, highlight cleanup and busy rejection.');
} catch (error) {
  if (page) { await mkdir('artifacts', { recursive: true });await page.screenshot({ path: 'artifacts/thumbnail-sidebar-failure.png', fullPage: true }).catch(() => {}); }
  throw error;
} finally { await browser?.close();server.kill(); }
