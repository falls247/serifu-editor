import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const port = 5227;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
let browser, page;
try {
  await new Promise((resolve, reject) => {
    server.stdout.once('data', resolve);server.once('error', reject);
    server.once('exit', code => reject(new Error(`server exited: ${code}`)));
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);await page.uncheck('#autosaveEnabled');
  const fixture = await page.evaluate(async () => {
    const { newLayer } = await import('./src/renderer.js');
    const canvas = document.createElement('canvas');canvas.width = 160;canvas.height = 120;
    canvas.getContext('2d').fillRect(0, 0, 160, 120);
    return { version: 6, pages: Array.from({ length: 55 }, (_, i) => ({
      name: `${String(i + 1).padStart(3, '0')}.png`, src: canvas.toDataURL(), done: i === 0,
      layers: i % 2 ? [] : [{ ...newLayer('dialogue', 160, 120), text: `本文${i + 1}`, font: 'sans' }],
    })) };
  });
  await page.locator('#projectInput').setInputFiles({ name: 'selection.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  await page.waitForFunction(() => document.querySelectorAll('.thumbnail').length === 55 && !document.querySelector('#projectLoad').disabled);
  const thumb = name => page.locator('.thumbnail').filter({ has: page.locator('.thumbnail-name', { hasText: name }) });
  const names = () => page.locator('.thumbnail-name').allTextContents();
  const selected = () => page.locator('.thumbnail[aria-pressed=true] .thumbnail-name').allTextContents();
  const dialog = page.locator('#removePagesDialog');
  const openRemoval = async () => { await page.keyboard.press('Delete');await dialog.waitFor({ state: 'visible' }); };
  const confirmRemoval = async count => {
    await dialog.getByRole('button', { name: 'はい', exact: true }).click();
    await page.waitForFunction(count => document.querySelectorAll('.thumbnail').length === count, count);
  };
  await thumb('001.png').click();await thumb('003.png').click({ modifiers: ['Shift'] });
  assert.deepEqual(await selected(), ['001.png', '002.png', '003.png']);
  await thumb('005.png').click({ modifiers: ['Shift'] });
  assert.equal((await selected()).length, 5, 'repeated Shift-click keeps the original anchor');
  await thumb('005.png').click();await thumb('002.png').click({ modifiers: ['Shift'] });
  assert.deepEqual(await selected(), ['002.png', '003.png', '004.png', '005.png'], 'reverse ranges work');
  await thumb('007.png').click({ modifiers: ['Control'] });
  await thumb('003.png').click({ modifiers: ['Control'] });
  assert.deepEqual(await selected(), ['002.png', '004.png', '005.png', '007.png']);
  await thumb('009.png').click({ modifiers: ['Meta'] });
  assert.equal((await selected()).at(-1), '009.png', 'Command-click adds a page');
  await thumb('009.png').click({ modifiers: ['Meta'] });
  assert.equal((await selected()).length, 4, 'Command-click also deselects');
  await thumb('008.png').click();await thumb('008.png').click({ modifiers: ['Control'] });
  assert.deepEqual(await selected(), []);
  await page.keyboard.press('Delete');assert.equal(await dialog.isVisible(), false, 'empty selection does nothing');

  await thumb('002.png').click();await thumb('052.png').click({ modifiers: ['Shift'] });
  const selection = fixture.pages.slice(1, 52).map(p => p.name);
  assert.deepEqual(await selected(), selection, 'selection spans mounted batches');
  assert.equal(await page.locator('#thumbnailSelectionCount').textContent(), '51枚を選択中');
  for (const options of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
    await thumb('052.png').evaluate((el, options) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true, ...options })), options);
    assert.equal(await dialog.isVisible(), false, 'repeating, IME and modified Delete are ignored');
  }
  await openRemoval();
  assert.match(await page.locator('#removePagesSummary').textContent(), /51枚/);
  assert.deepEqual(await dialog.locator('li').allTextContents(), selection);
  assert.equal((await names()).length, 55, 'opening confirmation does not remove pages');
  assert.equal(await dialog.getByRole('button', { name: 'いいえ' }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(await selected(), selection, 'default answer cancels without changing selection');
  await openRemoval();await page.keyboard.press('Escape');await dialog.waitFor({ state: 'hidden' });
  assert.equal((await names()).length, 55, 'Escape cancels');
  await openRemoval();await dialog.getByRole('button', { name: 'いいえ' }).click();
  assert.equal((await names()).length, 55, 'No cancels');
  await openRemoval();await page.keyboard.press('Delete');
  assert.equal((await names()).length, 55, 'Delete inside confirmation does not execute it');
  await confirmRemoval(4);
  assert.deepEqual(await names(), ['001.png', '053.png', '054.png', '055.png']);
  assert.equal(await page.locator('.thumbnail.active .thumbnail-name').textContent(), '053.png');
  assert.equal(await page.locator('.thumbnail.active').evaluate(el => el === document.activeElement), true, 'focus moves to a surviving thumbnail');
  assert.equal(await page.locator('.image-row.active textarea').inputValue(), '本文53');

  await page.selectOption('#projectFormat', 'json');
  const pending = page.waitForEvent('download');await page.click('#projectSave');
  const download = await pending, saved = JSON.parse(await readFile(await download.path(), 'utf8'));
  await page.waitForFunction(() => !document.querySelector('#projectLoad').disabled);
  assert.deepEqual(saved.pages.map(p => p.name), await names(), 'removed pages are absent from the saved project');
  assert.equal(saved.pages[0].done, true);assert.equal(saved.pages[0].layers[0].text, '本文1');

  await page.locator('[data-page-filter=edited]').click();
  await thumb('001.png').click();await thumb('055.png').click({ modifiers: ['Shift'] });
  assert.deepEqual(await selected(), ['001.png', '053.png', '055.png'], 'filtered-out images are excluded from ranges');
  await openRemoval();
  assert.deepEqual(await dialog.locator('li').allTextContents(), ['001.png', '053.png', '055.png']);
  await page.keyboard.press('Escape');
  await page.locator('[data-page-filter=all]').click();
  assert.deepEqual(await selected(), ['055.png'], 'changing the filter clears the previous multi-selection');

  await thumb('001.png').click();await thumb('053.png').click({ modifiers: ['Control'] });
  const row = page.locator('.image-row.active');
  await row.locator('textarea').focus();await page.keyboard.press('Delete');
  assert.equal(await dialog.isVisible(), false);assert.equal((await names()).length, 4, 'editing text never removes images');
  await row.locator('[data-action=preview-focus]').click();
  await row.locator('canvas.preview').focus();await page.keyboard.press('Delete');
  assert.equal(await row.locator('.layer-card').count(), 0, 'preview Delete still removes an object');
  assert.equal(await dialog.isVisible(), false);assert.equal((await names()).length, 4);
  await page.keyboard.press('Control+z');
  assert.equal(await row.locator('.layer-card').count(), 1);
  await row.locator('[data-action=preview-full]').click();
  await page.locator('#fullPreviewViewport').focus();await page.keyboard.press('Delete');
  assert.equal(await dialog.isVisible(), false);assert.equal((await names()).length, 4, 'full preview keeps editing shortcuts disabled');
  await page.locator('#fullPreviewClose').click();
  await thumb('001.png').click();await thumb('055.png').click({ modifiers: ['Shift'] });
  await openRemoval();await confirmRemoval(0);
  assert.equal(await page.locator('#empty').isVisible(), true);
  assert.equal(await page.locator('#thumbnailSelectionCount').isVisible(), false);
  assert.equal(await page.locator('#projectSave').isDisabled(), true);

  // Use mock folder handles: removing pages must never invoke original-file deletion.
  const folderPage = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  folderPage.on('pageerror', error => errors.push(error.message));
  await folderPage.goto(`http://127.0.0.1:${port}`);await folderPage.uncheck('#autosaveEnabled');
  await folderPage.evaluate(async () => {
    const canvas = document.createElement('canvas');canvas.width = 160;canvas.height = 120;
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    const files = ['元画像1.png', '元画像2.png'].map(name => new File([blob], name, { type: 'image/png' }));
    window.removedOriginals = [];
    window.showDirectoryPicker = async () => ({
      name: 'mock-folder',
      async *values() { for (const file of files) yield { kind: 'file', name: file.name, getFile: async () => file }; },
      removeEntry: async name => window.removedOriginals.push(name),
    });
  });
  await folderPage.click('#open');
  await folderPage.waitForFunction(() => document.querySelectorAll('.thumbnail').length === 2 && !document.querySelector('#files').disabled);
  const folderThumbs = folderPage.locator('.thumbnail');
  await folderThumbs.first().tap();await folderThumbs.last().click({ modifiers: ['Control'] });
  await folderPage.keyboard.press('Delete');
  const folderDialog = folderPage.locator('#removePagesDialog');await folderDialog.waitFor({ state: 'visible' });
  assert.equal(await folderPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('artifacts', { recursive: true });
  await folderPage.screenshot({ path: 'artifacts/thumbnail-selection-mobile.png' });
  await folderDialog.getByRole('button', { name: 'はい', exact: true }).tap();
  await folderPage.waitForFunction(() => !document.querySelector('.thumbnail'));
  assert.deepEqual(await folderPage.evaluate(() => window.removedOriginals), [], 'original files remain untouched');
  assert.deepEqual(errors, []);
  console.log('Thumbnail multi-selection passed: Shift/Ctrl/Command, reverse and filtered ranges, paging, Yes/No/Escape confirmation, saved project, input/preview guards, empty state, touch dialog and untouched original files.');
} catch (error) {
  if (page) { await mkdir('artifacts', { recursive: true });await page.screenshot({ path: 'artifacts/thumbnail-selection-failure.png', fullPage: true }).catch(() => {}); }
  throw error;
} finally { await browser?.close();server.kill(); }
