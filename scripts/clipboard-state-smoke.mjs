import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const port = 5206;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, page;
async function ready(target) {
  await target.waitForFunction(() => document.querySelectorAll('.image-row').length > 0 && !document.querySelector('#projectLoad').disabled);
}
async function selectCard(card) {
  const summary = card.locator('.layer-summary');
  if (await summary.isVisible()) await summary.click();
  await card.locator('[data-action=save-preset]').focus();
}
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test server did not start')), 10000);
    server.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    server.once('error', reject); server.stderr.on('data', chunk => process.stderr.write(chunk));
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  const errors = []; context.on('page', target => target.on('pageerror', error => errors.push(error.message)));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  const fixture = await page.evaluate(async () => {
    const { newLayer } = await import('./src/renderer.js');
    const image = (width, height) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ccbbaa'; ctx.fillRect(0, 0, width, height); return canvas.toDataURL();
    };
    const layers = ['dialogue', 'sfx', 'balloon', 'caption'].map(kind => ({ ...newLayer(kind, 400, 300, 'female'), text: `コピー-${kind}`, x: 100, y: 90 }));
    const small = image(400, 300), large = image(800, 600);
    return { version: 9, pages: Array.from({ length: 52 }, (_, i) => ({ name: `${i}.png`, src: i === 51 ? large : small, layers: i === 0 ? layers : [], edited: i === 51, done: i === 51 })) };
  });
  await page.locator('#projectInput').setInputFiles({ name: 'clipboard.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  await ready(page);
  const thumbs = page.locator('.thumbnail'), sourceId = await thumbs.first().getAttribute('data-page-id');
  const targetId = await thumbs.nth(51).getAttribute('data-page-id');
  const row = () => page.locator('.image-row.active');
  assert.equal(await thumbs.first().locator('.thumbnail-state').textContent(), '編集済み', 'objects override a stale unedited flag');
  assert.equal(await thumbs.nth(51).locator('.thumbnail-state').textContent(), '✓ 確認済み', 'an empty confirmed page must not remain edited');
  for (const [index, layer] of fixture.pages[0].layers.entries()) {
    const source = row().locator(`[data-kind=${layer.kind}]`);
    await selectCard(source);
    const command = index % 2 ? 'Meta' : 'Control';
    await page.keyboard.press(`${command}+c`);
    await source.locator('textarea').fill(`コピー元で変更-${layer.kind}`);
    const native = await source.locator('textarea').evaluate(input => ['c', 'v'].map(key => {
      const event = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true });
      input.dispatchEvent(event); return event.defaultPrevented;
    }));
    assert.deepEqual(native, [false, false], 'text editing keeps native copy/paste');
    if (index % 2) await page.locator('#jump').selectOption(targetId);
    else await thumbs.nth(51).click();
    assert.equal(await page.locator('#viewRange').textContent(), '51–52 / 52枚');
    assert.equal(await row().locator('.layer-card').count(), 0);
    await page.keyboard.press(`${command}+v`);
    const pasted = row().locator('.layer-card');
    assert.equal(await pasted.getAttribute('data-kind'), layer.kind); assert.equal(await pasted.locator('textarea').inputValue(), layer.text);
    assert.equal(await row().locator('.position-controls [data-field=x]').inputValue(), '220');
    assert.equal(await row().locator('.position-controls [data-field=y]').inputValue(), '200');
    if (['dialogue', 'balloon'].includes(layer.kind)) assert.equal(await pasted.getAttribute('data-speaker'), 'female');
    const firstId = await pasted.getAttribute('data-layer-id');
    await page.keyboard.press(`${command}+v`);
    assert.equal(await pasted.count(), 2); assert.notEqual(await pasted.last().getAttribute('data-layer-id'), firstId);
    assert.equal(await row().locator('.position-controls [data-field=x]').inputValue(), '240');
    await page.keyboard.press(`${command}+z`); assert.equal(await pasted.count(), 1);
    await page.keyboard.press(`${command}+z`); assert.equal(await pasted.count(), 0);
    assert.equal(await thumbs.nth(51).locator('.thumbnail-state').textContent(), '✓ 確認済み');
    await page.keyboard.press(`${command}+Shift+z`); assert.equal(await pasted.count(), 1);
    await page.keyboard.press(`${command}+z`);
    await page.locator('#jump').selectOption(sourceId);
    assert.equal(await row().locator('canvas').evaluate(canvas => canvas === document.activeElement), true);
    assert.equal(await source.locator('textarea').inputValue(), `コピー元で変更-${layer.kind}`);
  }
  const balloon = row().locator('[data-kind=balloon]');
  await selectCard(balloon);
  page.once('dialog', dialog => dialog.accept('女性の吹き出し'));
  await balloon.locator('[data-action=save-preset]').click();
  const femalePreset = await balloon.locator('[data-preset-select]').inputValue();
  assert.equal(await page.evaluate(id => JSON.parse(localStorage.getItem('serifu.preferences.v1')).presets.find(p => p.id === id).style.speaker, femalePreset), 'female');
  await balloon.locator('[data-action=speaker-male]').click();
  assert.equal(await balloon.locator('[data-preset-select]').inputValue(), '', 'changing the speaker clears the preset selection');
  await balloon.locator('[data-preset-select]').selectOption(femalePreset);
  assert.equal(await balloon.getAttribute('data-speaker'), 'female'); assert.equal(await balloon.locator('[data-field=textColor]').inputValue(), '#ef4b91');
  assert.equal(await balloon.locator('textarea').inputValue(), 'コピー元で変更-balloon');
  await row().locator('[data-action=undo]').click(); assert.equal(await balloon.getAttribute('data-speaker'), 'male');
  await row().locator('[data-action=redo]').click(); assert.equal(await balloon.getAttribute('data-speaker'), 'female');
  await row().locator('[data-action=add-balloon]').click();
  assert.equal(await row().locator('[data-kind=balloon]').last().getAttribute('data-speaker'), 'female', 'new balloons use the saved speaker');
  await row().locator('[data-kind=balloon]').last().locator('[data-action=drop-layer]').click();
  const dialogue = row().locator('[data-kind=dialogue]');
  await selectCard(dialogue); await dialogue.locator('[data-action=speaker-male]').click();
  page.once('dialog', dialog => dialog.accept('男性のセリフ'));
  await dialogue.locator('[data-action=save-preset]').click();
  const malePreset = await dialogue.locator('[data-preset-select]').inputValue();
  await row().locator('[data-action=add-female]').click();
  const freshDialogue = row().locator('[data-kind=dialogue]').last();
  assert.equal(await freshDialogue.getAttribute('data-speaker'), 'female', 'an explicit female addition overrides a male default preset');
  assert.equal(await freshDialogue.locator('[data-preset-select]').inputValue(), '');
  await freshDialogue.locator('textarea').fill('本文は維持');
  await freshDialogue.locator('[data-preset-select]').selectOption(malePreset);
  assert.equal(await freshDialogue.getAttribute('data-speaker'), 'male'); assert.equal(await freshDialogue.locator('textarea').inputValue(), '本文は維持');
  await freshDialogue.locator('[data-action=drop-layer]').click();
  // 高速形式でも古い編集済みフラグを補正し、プリセットの話者を読み戻す。
  const binary = await page.evaluate(async data => {
    const { projectBlob } = await import('./src/project-io.js');
    const pages = [data.pages[0], data.pages[51]].map(p => ({ ...p, img: { width: p.name === '0.png' ? 400 : 800, height: p.name === '0.png' ? 300 : 600 } }));
    const prefs = JSON.parse(localStorage.getItem('serifu.preferences.v1'));
    return Array.from(new Uint8Array(await (await projectBlob(pages, prefs)).arrayBuffer()));
  }, fixture);
  const imported = await context.newPage(); await imported.goto(`http://127.0.0.1:${port}`);
  await imported.locator('#projectInput').setInputFiles({ name: 'clipboard.serifu', mimeType: 'application/octet-stream', buffer: Buffer.from(binary) });
  await ready(imported);
  assert.equal(await imported.locator('.thumbnail').first().locator('.thumbnail-state').textContent(), '編集済み');
  assert.equal(await imported.locator('.thumbnail').last().locator('.thumbnail-state').textContent(), '✓ 確認済み');
  await imported.locator('.image-row').first().locator('[data-action=add-balloon]').click();
  assert.equal(await imported.locator('[data-kind=balloon]').last().getAttribute('data-speaker'), 'female');
  await imported.close();
  // 残るオブジェクトがある間は編集済み、最後の削除で未編集。
  while (await row().locator('.layer-card').count() > 1) {
    await selectCard(row().locator('.layer-card').first());
    await row().locator('canvas').focus(); await page.keyboard.press('Delete');
    assert.equal(await row().locator('.edited-badge').isVisible(), true);
  }
  await selectCard(row().locator('.layer-card').first());
  await row().locator('.layer-card').first().locator('[data-action=drop-layer]').click();
  assert.equal(await row().locator('.edited-badge').isVisible(), false); assert.equal(await page.locator('#saveEdited').isDisabled(), true);
  await row().locator('[data-action=undo]').click(); assert.equal(await row().locator('.edited-badge').isVisible(), true);
  await row().locator('[data-action=redo]').click(); assert.equal(await page.locator('#saveEdited').isDisabled(), true);
  await row().locator('[data-action=add-balloon]').click();
  await row().locator('[data-action=cut-all]').click(); await ready(page);
  assert.equal(await page.locator('#saveEdited').isDisabled(), true);
  await row().locator('[data-action=undo]').click(); assert.equal(await row().locator('.edited-badge').isVisible(), true);
  await row().locator('[data-action=redo]').click(); assert.equal(await page.locator('#saveEdited').isDisabled(), true);
  await page.click('#temporarySave');
  await page.waitForFunction(() => document.querySelector('#draftStatus').textContent.includes('保存済'));
  assert.equal(await page.evaluate(async () => {
    const { getDraftMeta } = await import('./src/storage.js'); return (await getDraftMeta()).pages.every(p => !p.edited && !p.layers.length);
  }), true);
  await page.reload(); await page.waitForSelector('#draftNotice:not([hidden])'); await page.click('#restoreDraft'); await ready(page);
  assert.equal(await page.locator('#saveEdited').isDisabled(), true);
  assert.equal(await thumbs.nth(51).locator('.thumbnail-state').textContent(), '✓ 確認済み');
  await row().locator('[data-action=add-balloon]').click();
  assert.equal(await row().locator('[data-kind=balloon]').getAttribute('data-speaker'), 'female', 'the saved speaker survives reload and draft restoration');
  assert.deepEqual(errors, []);
  console.log('全4種類の画像間コピペ、表示範囲を跨ぐ切替、通常の文字コピペ、削除・カット・Undo/Redoの未編集判定、JSON・高速形式・一時保存、話者プリセットの復元と明示的な男性／女性の追加を確認した');
} catch (error) {
  if (page) console.error(await page.evaluate(() => ({ status: document.querySelector('#status').textContent, cards: document.querySelectorAll('.layer-card').length })));
  throw error;
} finally {
  await browser?.close(); server.kill();
}
