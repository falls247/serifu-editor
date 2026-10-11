import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const port = 5226, server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Shortcut server did not start')), 10000);
    server.stdout.once('data', () => { clearTimeout(timer); resolve(); }); server.once('error', reject);
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`); await page.uncheck('#autosaveEnabled');
  const fixture = await page.evaluate(async () => {
    const { newLayer } = await import('./src/renderer.js');
    const { defaultPreferences, createPreset, applyPreset } = await import('./src/presets.js');
    const preferences = defaultPreferences(), kinds = ['dialogue', 'sfx', 'balloon', 'caption'];
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 650;
    canvas.getContext('2d').fillRect(0, 0, 800, 650);
    const layers = kinds.map((kind, i) => {
      const layer = { ...newLayer(kind, 800, 650), text: '中央\n上揃え', x: 130 + i * 90, y: 180 + i * 35 };
      preferences.presets.push(createPreset(`保存済み${kind}`, { ...layer, font: 'round', size: 55 }, 800, 650));
      return applyPreset(layer, preferences.presets.find(preset => preset.kind === kind), 800, 650);
    });
    return { version: 10, preferences, pages: [{ name: 'shortcuts.png', src: canvas.toDataURL(), layers }, { name: 'empty.png', src: canvas.toDataURL(), layers: [] }] };
  });
  await page.locator('#projectInput').setInputFiles({ name: 'shortcuts.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  await page.waitForFunction(() => document.querySelectorAll('.image-row').length === 2 && !document.querySelector('#projectLoad').disabled);
  const row = page.locator('.image-row').first(), canvas = row.locator('canvas.preview');
  const field = name => row.locator(`.position-controls [data-field=${name}]`);
  const xy = async () => [await field('x').inputValue(), await field('y').inputValue()];
  const shortcut = async key => { await canvas.focus(); await page.keyboard.press(key); };
  for (const kind of ['dialogue', 'sfx', 'balloon', 'caption']) {
    const card = row.locator(`[data-kind=${kind}]`), menu = card.locator('[data-preset-select]');
    if (!await card.evaluate(c => c.classList.contains('selected'))) await card.locator('.layer-summary').click();
    const presets = fixture.preferences.presets.filter(preset => preset.kind === kind), originalXY = await xy();
    const others = row.locator('.layer-card:not(.selected) [data-preset-select]');
    const otherPresets = await others.evaluateAll(menus => menus.map(menu => menu.value));
    await shortcut('f'); assert.equal(await menu.inputValue(), presets[1].id, `${kind}: F selects next preset`);
    await shortcut('Control+z'); assert.equal(await menu.inputValue(), presets[0].id);
    await shortcut('Control+Shift+z'); assert.equal(await menu.inputValue(), presets[1].id);
    await shortcut('b'); assert.equal(await menu.inputValue(), presets[0].id);
    await shortcut('b'); assert.equal(await menu.inputValue(), presets.at(-1).id, `${kind}: B wraps to last saved preset`);
    assert.equal(await field('font').inputValue(), 'round', 'saved preset styling is applied');
    await shortcut('f'); assert.equal(await menu.inputValue(), presets[0].id, `${kind}: F wraps to first preset`);
    for (const preset of [...presets.slice(1), presets[0]]) {
      await shortcut('f'); assert.equal(await menu.inputValue(), preset.id, 'cycling follows menu order');
    }
    assert.deepEqual(await xy(), originalXY, 'preset shortcuts preserve object position');
    assert.equal(await card.locator('textarea').inputValue(), '中央\n上揃え', 'preset shortcuts preserve text');
    const defaults = await page.evaluate(() => JSON.parse(localStorage.getItem('serifu.preferences.v1')).defaults);
    assert.equal(defaults[kind], presets[0].id, 'shortcut uses the same default memory as menu selection');
    if (kind === 'balloon' || kind === 'caption') {
      await field('textOffsetX').fill('25'); await field('textOffsetY').fill('-18');
    }
    if (kind === 'caption') { await field('alignX').selectOption('right'); await field('alignY').selectOption('bottom'); }
    await page.evaluate(() => document.fonts.ready);
    await shortcut('c');
    assert.equal(await field(kind === 'caption' ? 'alignY' : 'lineAlign').inputValue(), 'center');
    if (kind === 'caption') assert.equal(await field('alignX').inputValue(), 'center');
    if (kind === 'balloon' || kind === 'caption') {
      assert.equal(await field('textOffsetX').inputValue(), '0'); assert.equal(await field('textOffsetY').inputValue(), '0');
    }
    assert.deepEqual(await xy(), originalXY, 'C centers text without moving the object');
    if (kind === 'balloon' || kind === 'caption') {
      await field('textOffsetX').fill('25'); await field('textOffsetY').fill('-18');
    }
    const centered = await canvas.evaluate(c => c.toDataURL());
    await shortcut('u');
    assert.equal(await field(kind === 'caption' ? 'alignY' : 'lineAlign').inputValue(), 'top');
    if (kind === 'balloon' || kind === 'caption') {
      assert.equal(await field('textOffsetX').inputValue(), '25', 'U preserves horizontal text offset');
      assert.equal(await field('textOffsetY').inputValue(), '0', 'U resets vertical text offset');
    }
    assert.notEqual(await canvas.evaluate(c => c.toDataURL()), centered, `${kind}: U visibly changes text alignment`);
    assert.deepEqual(await xy(), originalXY, 'U preserves object position');
    await shortcut('Control+z'); assert.equal(await field(kind === 'caption' ? 'alignY' : 'lineAlign').inputValue(), 'center');
    await shortcut('Control+Shift+z'); assert.equal(await field(kind === 'caption' ? 'alignY' : 'lineAlign').inputValue(), 'top');
    assert.equal(await menu.inputValue(), '', 'alignment changes become a custom style');
    await shortcut('f'); assert.equal(await menu.inputValue(), presets[0].id, 'F from custom chooses first preset');
    await shortcut('Control+z'); assert.equal(await menu.inputValue(), '');
    await shortcut('b'); assert.equal(await menu.inputValue(), presets.at(-1).id, 'B from custom chooses last preset');
    await shortcut('Control+z'); assert.equal(await menu.inputValue(), '');
    assert.deepEqual(await others.evaluateAll(menus => menus.map(menu => menu.value)), otherPresets, 'other objects are unchanged');
  }
  const caption = row.locator('[data-kind=caption]'), menu = caption.locator('[data-preset-select]');
  const state = async () => [await menu.inputValue(), await field('alignX').inputValue(), await field('alignY').inputValue(), ...await xy()];
  const before = await state();
  for (const target of [caption.locator('textarea'), field('x'), menu]) {
    await target.focus();
    for (const key of ['f', 'b', 'c', 'u']) {
      assert.equal(await target.evaluate((el, key) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); el.dispatchEvent(event); return event.defaultPrevented;
      }, key), false, 'editable controls keep their keyboard behavior');
    }
    assert.deepEqual(await state(), before);
  }
  await caption.locator('textarea').focus(); await page.keyboard.type('fbcu');
  assert.match(await caption.locator('textarea').inputValue(), /fbcu/); assert.deepEqual(await state(), before);
  await canvas.focus();
  for (const key of ['Control+f', 'Control+b', 'Control+u', 'Meta+f', 'Alt+b']) {
    await page.keyboard.press(key); assert.deepEqual(await state(), before, 'modified shortcuts do not change style');
  }
  await page.keyboard.press('Control+c'); assert.deepEqual(await state(), before);
  assert.match(await page.locator('#status').textContent(), /コピーした/, 'Ctrl+C still copies objects');
  for (const key of ['f', 'b', 'c', 'u']) {
    await canvas.evaluate((el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, isComposing: true })), key);
  }
  assert.deepEqual(await state(), before, 'IME composition is ignored');
  await row.locator('[data-action=preview-full]').click(); await page.locator('#fullPreviewCanvas').waitFor({ state: 'visible' });
  for (const key of ['f', 'b', 'c', 'u']) await page.keyboard.press(key);
  assert.deepEqual(await state(), before, 'preview modal blocks editing shortcuts');
  await page.locator('#fullPreviewClose').click();
  await row.locator('[data-action=crop-image]').click();
  for (const key of ['f', 'b', 'c', 'u']) await shortcut(key);
  assert.deepEqual(await state(), before, 'crop mode blocks style shortcuts'); await page.keyboard.press('Escape');
  const empty = page.locator('.image-row').nth(1);
  await page.locator('#jump').selectOption(await empty.getAttribute('data-page-id')); await empty.locator('canvas.preview').focus();
  for (const key of ['f', 'b', 'c', 'u']) await page.keyboard.press(key);
  assert.equal(await empty.locator('.layer-card').count(), 0, 'no selection is a no-op');
  assert.deepEqual(errors, []);
  console.log('F/B preset order, wrapping, saved presets, default memory, C/U text alignment, fixed object positions, undo/redo, input/IME/modifier/modal/crop guards and Ctrl+C passed for all four object kinds');
} finally { await browser?.close(); server.kill(); }
