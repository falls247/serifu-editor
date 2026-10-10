import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const port = 5199;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
let browser, testPage;
try {
  await new Promise((resolve, reject) => {
    server.stdout.once('data', resolve);
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`Test server exited: ${code}`)));
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Tokyo' });
  const page = testPage = await context.newPage(), errors = [];
  context.on('page', p => p.on('pageerror', error => errors.push(error.message)));
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.clock.setFixedTime(new Date('2026-10-10T04:35:02.007Z'));
  await page.goto(`http://127.0.0.1:${port}`);
  const ready = p => p.waitForFunction(() => !document.querySelector('#projectLoad').disabled && document.querySelectorAll('.thumbnail').length > 0);
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 300;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#103050'; ctx.fillRect(0, 0, 400, 300);
    const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c => c.charCodeAt(0));
    window.source = { name: '作業フォルダ', async *values() {
      for (const name of ['01.png', '02.png']) yield { kind: 'file', name, getFile: async () => new File([bytes], name, { type: 'image/png' }) };
    } };
    window.outputs = [];
    window.destination = { name: '保存先', getDirectoryHandle: async name => {
      const output = { name, files: {} }; window.outputs.push(output);
      return { getFileHandle: async filename => ({ createWritable: async () => {
        const parts = [];
        return { write: async value => parts.push(value), close: async () => { output.files[filename] = new Blob(parts); }, abort: async () => {} };
      } }) };
    } };
    window.showDirectoryPicker = async () => window.saving ? window.destination : window.source;
  });
  await page.click('#open'); await ready(page);
  const row = page.locator('.image-row').first(), controls = row.locator('.position-controls');
  await row.locator('[data-action=add-balloon]').click();
  const balloon = row.locator('[data-kind=balloon]');
  await balloon.locator('textarea').fill('吹き出しの台詞～');
  await balloon.locator('[data-action=speaker-female]').click();
  for (const [field, value] of Object.entries({ x: 200, y: 150, w: 180, h: 240, size: 24, padding: 16 })) await controls.locator(`[data-field=${field}]`).fill(String(value));
  // Font/PNG parity uses fully visible text; frame-edge clipping is tested separately.
  await controls.locator('[data-field=lineAlign]').selectOption('center');
  await controls.locator('[data-field=font]').selectOption('round');
  await controls.locator('[data-field=shape]').selectOption('distorted-rect');
  await controls.locator('[data-field=distortion]').evaluate(input => { input.value = '70'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.match(await balloon.locator('.layer-summary').textContent(), /女性吹き出し.*吹き出しの台詞～/);
  let downloading = page.waitForEvent('download'); await page.click('#projectSave');
  const project = await downloading; await ready(page);
  assert.equal(project.suggestedFilename(), '作業フォルダ_20261010_133502_007.serifu');
  const projectBytes = await readFile(await project.path());
  await page.evaluate(() => window.saving = true);
  for (const [button, suffix] of [['save', ''], ['saveEdited', '_edited']]) {
    await page.click(`#${button}`); await ready(page);
    const output = await page.evaluate(() => {
      const output = window.outputs.at(-1); return { name: output.name, files: Object.keys(output.files) };
    });
    assert.equal(output.name, `作業フォルダ_20261010_133502_007${suffix}`);
    assert.equal(output.files.filter(name => name.endsWith('.serifu'))[0], '作業フォルダ_20261010_133502_007.serifu');
    assert.equal(output.files.filter(name => name.endsWith('.png')).length, button === 'save' ? 2 : 1);
    assert.equal(await page.evaluate(async () => {
      const { readProject } = await import('./project-io.js'), { draw } = await import('./renderer.js');
      const files = window.outputs.at(-1).files, projectName = Object.keys(files).find(name => name.endsWith('.serifu'));
      const data = await readProject(files[projectName]), original = await createImageBitmap(data.pages[0].blob);
      const actual = await createImageBitmap(files[Object.keys(files).find(name => name.endsWith('.png'))]);
      const a = document.createElement('canvas'), b = document.createElement('canvas'); a.width = b.width = 400; a.height = b.height = 300;
      draw(a.getContext('2d'), original, data.pages[0].layers); b.getContext('2d').drawImage(actual, 0, 0);
      const expected = a.getContext('2d').getImageData(0, 0, 400, 300).data, pixels = b.getContext('2d').getImageData(0, 0, 400, 300).data;
      original.close(); actual.close(); return expected.every((value, i) => value === pixels[i]);
    }), true, 'balloon-only worker PNG must use the selected font and match the main renderer');
  }
  await page.evaluate(() => window.showDirectoryPicker = undefined);
  for (const [button, suffix] of [['save', ''], ['saveEdited', '_edited']]) {
    downloading = page.waitForEvent('download'); await page.click(`#${button}`);
    const archive = await downloading; await ready(page);
    assert.equal(archive.suggestedFilename(), `作業フォルダ_20261010_133502_007${suffix}.zip`);
    const bytes = await readFile(await archive.path());
    assert.ok(bytes.includes(Buffer.from('作業フォルダ_20261010_133502_007.serifu')));
    assert.ok(!bytes.includes(Buffer.from('_edited.serifu')));
  }
  const imported = await context.newPage(); await imported.goto(`http://127.0.0.1:${port}`);
  await imported.locator('#projectInput').setInputFiles({ name: project.suggestedFilename(), mimeType: 'application/octet-stream', buffer: projectBytes });
  await ready(imported);
  assert.equal(await imported.locator('[data-kind=balloon] textarea').inputValue(), '吹き出しの台詞～');
  assert.equal(await imported.locator('.image-row').first().locator('.position-controls [data-field=distortion]').inputValue(), '70');
  assert.equal(await imported.locator('.thumbnail').first().locator('.thumbnail-state').textContent(), '編集済み');
  await imported.locator('.thumbnail').nth(1).click(); await imported.locator('.thumbnail').first().click();
  assert.equal(await imported.locator('[data-kind=balloon] textarea').inputValue(), '吹き出しの台詞～');
  const fixture = await page.evaluate(async () => {
    const { newLayer } = await import('./renderer.js'), { projectBlob } = await import('./project-io.js');
    const file = await (await window.source.values().next()).value.getFile();
    const layer = { ...newLayer('balloon', 400, 300), x: 200, y: 150, w: 180, h: 240, text: '読込済みの台詞～', speaker: 'female', size: 24, shape: 'distorted-rect', distortion: 70 };
    const pages = Array.from({ length: 52 }, (_, i) => ({ name: `${i}.png`, file, img: { width: 400, height: 300 }, layers: i === 0 || i === 51 ? [{ ...layer, id: crypto.randomUUID() }] : [], done: i === 51, edited: false }));
    const blob = await projectBlob(pages, {}, { sourceFolderName: '復元フォルダ' });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  const restored = await context.newPage(); await restored.goto(`http://127.0.0.1:${port}`);
  await restored.locator('#projectInput').setInputFiles({ name: '復元フォルダ_20261010_133502_007.serifu', mimeType: 'application/octet-stream', buffer: Buffer.from(fixture) });
  await ready(restored);
  const thumbs = restored.locator('.thumbnail');
  assert.match(await thumbs.nth(51).locator('.thumbnail-state').textContent(), /編集済み.*確認済み/);
  // 未マウントの最終ページにも、元画像にはない白い吹き出しを描画する。
  const lightPixels = img => img.evaluate(async image => {
    await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0); const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 120 && pixels[i + 1] > 120 && pixels[i + 2] > 120) count++;
    return count;
  });
  await restored.waitForFunction(() => document.querySelectorAll('.thumbnail img')[51]?.complete);
  assert.ok(await lightPixels(thumbs.nth(51).locator('img')) > 1000);
  assert.equal(await lightPixels(thumbs.nth(50).locator('img')), 0);
  await thumbs.nth(51).click();
  assert.equal(await restored.locator('.image-row').last().locator('textarea').inputValue(), '読込済みの台詞～');
  await thumbs.first().click(); await thumbs.nth(51).click();
  assert.equal(await restored.locator('.image-row').last().locator('textarea').inputValue(), '読込済みの台詞～');
  const thumbnailSource = await thumbs.nth(51).locator('img').getAttribute('src');
  await restored.locator('.image-row').last().locator('canvas').focus(); await restored.keyboard.press('Delete');
  await restored.waitForFunction(previous => document.querySelectorAll('.thumbnail img')[51].src !== previous, thumbnailSource);
  assert.equal(await lightPixels(thumbs.nth(51).locator('img')), 0, 'deleting the balloon must also remove it from the thumbnail');
  const deletedSource = await thumbs.nth(51).locator('img').getAttribute('src');
  await restored.keyboard.press('Control+z');
  await restored.waitForFunction(previous => document.querySelectorAll('.thumbnail img')[51].src !== previous, deletedSource);
  assert.ok(await lightPixels(thumbs.nth(51).locator('img')) > 1000, 'undo must restore the balloon in the thumbnail');
  await restored.click('#temporarySave'); await restored.waitForFunction(() => document.querySelector('#draftStatus').textContent.includes('保存済'));
  await restored.reload(); await restored.waitForSelector('#draftNotice:not([hidden])');
  await restored.click('#restoreDraft'); await ready(restored);
  assert.match(await restored.locator('.thumbnail').nth(51).locator('.thumbnail-state').textContent(), /編集済み.*確認済み/);
  assert.ok(await lightPixels(restored.locator('.thumbnail').nth(51).locator('img')) > 1000);
  assert.deepEqual(errors, []);
  console.log('実フォルダ名とミリ秒を含む全保存経路、吹き出し台詞、未マウントのサムネイル合成、確認状態、読込・ページ切替・一時保存復元を確認した');
} catch (error) {
  if (testPage) console.error(await testPage.evaluate(() => ({ status: document.querySelector('#status').textContent, cards: document.querySelectorAll('.layer-card').length })));
  throw error;
} finally {
  await browser?.close(); server.kill();
}
