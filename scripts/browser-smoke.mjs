import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const port = 5187;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, page;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test server did not start')), 10000);
    server.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    server.once('error', reject); server.stderr.on('data', chunk => process.stderr.write(chunk));
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  await page.click('#demo');
  await page.waitForFunction(() => document.querySelectorAll('.image-row').length === 3 && !document.querySelector('#deck').inert);
  const rows = page.locator('.image-row'), first = rows.nth(0), second = rows.nth(1);
  const bounds = await first.locator('.row-columns > section').evaluateAll(items => items.map(item => item.getBoundingClientRect().left));
  assert.ok(bounds[0] < bounds[1] && bounds[1] < bounds[2], 'original, dialogue and preview must appear left to right');
  await first.locator('textarea').nth(0).fill('男性の編集テスト');
  await second.locator('textarea').nth(0).fill('二枚目の編集');
  assert.equal(await first.locator('textarea').nth(0).inputValue(), '男性の編集テスト');
  const female = await first.locator('textarea').nth(1).inputValue();
  await first.locator('[data-action=swap]').first().click();
  assert.equal(await first.locator('textarea').nth(0).inputValue(), female);
  assert.equal(await first.locator('textarea').nth(1).inputValue(), '男性の編集テスト');
  await first.locator('[data-action=undo]').click();
  assert.equal(await first.locator('textarea').nth(0).inputValue(), '男性の編集テスト');
  assert.equal(await second.locator('textarea').nth(0).inputValue(), '二枚目の編集');
  await first.locator('.layer-card').first().click();
  const selectionRect = await first.locator('canvas').boundingBox();
  await page.mouse.click(selectionRect.x + selectionRect.width * .3, selectionRect.y + selectionRect.height * 170 / 750);
  assert.equal(await first.locator('[data-action=redo]').isEnabled(), true, 'selecting text must preserve redo history');
  await first.locator('[data-action=speaker-female]').first().click();
  assert.equal(await first.locator('.layer-card').first().getAttribute('data-speaker'), 'female');
  await first.locator('[data-action=speaker-male]').first().click();
  await first.locator('textarea').first().fill('MEN');
  await first.locator('textarea').nth(1).fill('WOMEN');
  await first.locator('.layer-card').first().click();
  const pixels = await first.locator('canvas').evaluate(canvas => {
    const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const counts = { male: 0, female: 0, white: 0 };
    for (let i = 0; i < bytes.length; i += 4) {
      if (bytes[i] === 17 && bytes[i + 1] === 17 && bytes[i + 2] === 17) counts.male++;
      if (bytes[i] === 239 && bytes[i + 1] === 75 && bytes[i + 2] === 145) counts.female++;
      if (bytes[i] === 255 && bytes[i + 1] === 255 && bytes[i + 2] === 255) counts.white++;
    }
    return counts;
  });
  assert.ok(pixels.male > 100 && pixels.female > 100 && pixels.white > 100, 'black male, pink female and white keylines must be painted');
  const xInput = first.locator('.position-controls [data-field=x]'), yInput = first.locator('.position-controls [data-field=y]');
  await xInput.fill('300'); await yInput.fill('170'); await yInput.blur();
  const canvas = first.locator('canvas'); await canvas.scrollIntoViewIfNeeded();
  const rect = await canvas.boundingBox(), initialX = Number(await xInput.inputValue());
  await page.mouse.move(rect.x + rect.width * .3, rect.y + rect.height * 170 / 750);
  await page.mouse.down(); await page.mouse.move(rect.x + rect.width * .35, rect.y + rect.height * 190 / 750, { steps: 6 }); await page.mouse.up();
  assert.ok(Number(await xInput.inputValue()) > initialX + 35, 'drag must update original-pixel coordinates');
  await xInput.fill('350'); await yInput.fill('350'); await yInput.blur();
  const wInput = first.locator('.position-controls [data-field=w]'), hInput = first.locator('.position-controls [data-field=h]');
  const handleRect = await canvas.boundingBox(), width = Number(await wInput.inputValue()), height = Number(await hInput.inputValue());
  const resizeX = handleRect.x + handleRect.width * (350 + width / 2) / 1000, resizeY = handleRect.y + handleRect.height * (350 + height / 2) / 750;
  await page.mouse.move(resizeX, resizeY); await page.mouse.down(); await page.mouse.move(resizeX + 15, resizeY + 15, { steps: 5 }); await page.mouse.up();
  assert.ok(Number(await wInput.inputValue()) > width, 'resize handle must update the layout width');
  const updatedHeight = Number(await hInput.inputValue()), centerX = handleRect.x + handleRect.width * .35, centerY = handleRect.y + handleRect.height * 350 / 750;
  const rotateY = centerY - handleRect.height * updatedHeight / 1500 - 24;
  await page.mouse.move(centerX, rotateY); await page.mouse.down(); await page.mouse.move(centerX + 35, rotateY + 10, { steps: 5 }); await page.mouse.up();
  assert.ok(Math.abs(Number(await first.locator('.position-controls [data-field=rotation]').inputValue())) > 5, 'rotation handle must update the angle');
  for (const effect of ['impact', 'burst', 'speed', 'rumble']) await first.locator('[data-field=effect]').selectOption(effect);
  await first.locator('[data-action=complete]').click();
  assert.ok((await page.locator('#progress').textContent()).includes('1 / 3'));
  await page.locator('#jump').selectOption(await first.getAttribute('data-page-id'));
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/desktop.png' });
  const downloadPromise = page.waitForEvent('download'); await page.click('#projectSave');
  const download = await downloadPromise; await download.saveAs('artifacts/project.json');
  const project = JSON.parse(await readFile('artifacts/project.json', 'utf8'));
  assert.equal(project.version, 2); assert.equal(project.pages.length, 3); assert.equal(project.pages[0].layers[0].speaker, 'male');
  await page.locator('#projectInput').setInputFiles('artifacts/project.json');
  await page.waitForFunction(() => document.querySelectorAll('.image-row').length === 6 && !document.querySelector('#deck').inert);
  assert.equal(await rows.nth(3).locator('textarea').first().inputValue(), 'MEN');
  const old = { version: 1, pages: [{ ...project.pages[0], layers: [{ ...project.pages[0].layers[0], kind: 'bubble', shape: 'ellipse', fill: '#ffffff', tailX: 0, tailY: 0 }] }] };
  await writeFile('artifacts/old.json', JSON.stringify(old)); await page.locator('#projectInput').setInputFiles('artifacts/old.json');
  await page.waitForFunction(() => document.querySelectorAll('.image-row').length === 7 && !document.querySelector('#deck').inert);
  assert.equal(await rows.nth(6).locator('.layer-card').first().getAttribute('data-speaker'), 'male');
  assert.equal(await rows.nth(6).locator('[data-action=delete]').isDisabled(), true);
  await page.evaluate(src => {
    window.removed = []; window.saved = {};
    const data = Uint8Array.from(atob(src.split(',')[1]), c => c.charCodeAt(0));
    const file = new File([data], 'original.png', { type: 'image/png' });
    const directory = {
      async *values() { yield { kind: 'file', getFile: async () => file }; },
      removeEntry: async name => window.removed.push(name),
      getDirectoryHandle: async () => directory,
      getFileHandle: async name => ({ createWritable: async () => ({
        write: async value => {
          if (value instanceof Blob) { const bitmap = await createImageBitmap(value); window.saved[name] = { width: bitmap.width, height: bitmap.height, bytes: value.size }; bitmap.close(); }
          else window.saved[name] = JSON.parse(value);
        }, close: async () => {}, abort: async () => {},
      }) }),
    };
    window.showDirectoryPicker = async () => directory;
  }, project.pages[0].src);
  await page.click('#open'); await page.waitForFunction(() => document.querySelectorAll('.image-row').length === 8 && !document.querySelector('#deck').inert);
  page.once('dialog', dialog => dialog.dismiss()); await rows.nth(7).locator('[data-action=delete]').click();
  assert.deepEqual(await page.evaluate(() => window.removed), []);
  page.once('dialog', dialog => dialog.accept()); await rows.nth(7).locator('[data-action=delete]').click();
  await page.waitForFunction(() => document.querySelectorAll('.image-row').length === 7 && !document.querySelector('#deck').inert);
  assert.deepEqual(await page.evaluate(() => window.removed), ['original.png']);
  await page.click('#save'); await page.waitForFunction(() => document.querySelector('#status').textContent.includes('7 枚と編集データ'));
  const saved = await page.evaluate(() => window.saved);
  assert.equal(Object.keys(saved).length, 8); assert.equal(saved['serifu-project.json'].version, 2);
  for (const [name, image] of Object.entries(saved)) if (name.endsWith('.png')) { assert.equal(image.width, 1000); assert.equal(image.height, 750); }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: 'artifacts/mobile.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'mobile layout must not overflow horizontally');
  assert.deepEqual(errors, [], 'browser runtime errors');
  console.log('Browser smoke passed: 3-column layout, continuous editing, role colors/keylines, swap, independent undo, drag, all effects, project/legacy import, source deletion confirm and original-size batch export.');
} catch (error) {
  if (page) { await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/failure.png', fullPage: true }).catch(() => {}); }
  throw error;
} finally {
  await browser?.close(); server.kill();
}
