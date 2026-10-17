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
      await field('padding').fill('30');
    }
    if (kind === 'caption') { await field('alignX').selectOption('right'); await field('alignY').selectOption('bottom'); }
    await page.evaluate(() => document.fonts.ready);
    await shortcut('c');
    assert.equal(await field(kind === 'caption' ? 'alignY' : 'lineAlign').inputValue(), 'center');
    if (kind === 'caption') assert.equal(await field('alignX').inputValue(), 'center');
    if (kind === 'balloon' || kind === 'caption') {
      assert.equal(await field('textOffsetX').inputValue(), '0'); assert.equal(await field('textOffsetY').inputValue(), '0');
      assert.equal(await field('padding').inputValue(), '0', 'C clears inner padding');
      assert.equal(await card.locator('[data-field=padding]').inputValue(), '0', 'card padding stays synchronized');
      await shortcut('Control+z');
      assert.equal(await field('padding').inputValue(), '30', 'undo restores inner padding together with alignment');
      assert.equal(await field('textOffsetX').inputValue(), '25'); assert.equal(await field('textOffsetY').inputValue(), '-18');
      await shortcut('Control+Shift+z'); assert.equal(await field('padding').inputValue(), '0');
      await field('padding').fill('30'); await shortcut('c');
      assert.equal(await field('padding').inputValue(), '0', 'C also clears padding when text is already centered');
    }
    assert.deepEqual(await xy(), originalXY, 'C centers text without moving the object');
    if (kind === 'balloon' || kind === 'caption') {
      await field('textOffsetX').fill('25'); await field('textOffsetY').fill('-18');
      await field('padding').fill('20');
    }
    const centered = await canvas.evaluate(c => c.toDataURL());
    await shortcut('u');
    assert.equal(await field(kind === 'caption' ? 'alignY' : 'lineAlign').inputValue(), 'top');
    if (kind === 'balloon' || kind === 'caption') {
      assert.equal(await field('textOffsetX').inputValue(), '25', 'U preserves horizontal text offset');
      assert.equal(await field('textOffsetY').inputValue(), '0', 'U resets vertical text offset');
      assert.equal(await field('padding').inputValue(), '20', 'U preserves inner padding');
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
    if (kind === 'balloon') {
      await shortcut('f');
      const shapes = await field('shape').evaluate(select => [...select.options].filter(option => !option.hidden).map(option => option.value));
      assert.deepEqual(shapes, ['ellipse', 'distorted-rect', 'spiky', 'polygon']);
      const initialShape = await field('shape').inputValue(), initialIndex = shapes.indexOf(initialShape);
      const unchangedFields = ['x', 'y', 'w', 'h', 'size', 'distortion', 'shapeSeed', 'spikeCount', 'textOffsetX', 'textOffsetY'];
      const settings = () => Promise.all(unchangedFields.map(name => field(name).inputValue()));
      const initialSettings = await settings(), initialText = await card.locator('textarea').inputValue();
      await page.evaluate(() => document.fonts.ready);
      const initialPixels = await canvas.evaluate(c => c.toDataURL());
      await shortcut('e'); assert.equal(await field('shape').inputValue(), shapes[(initialIndex + 1) % shapes.length]);
      assert.equal(await menu.inputValue(), '', 'E marks the changed shape as a custom style');
      assert.notEqual(await canvas.evaluate(c => c.toDataURL()), initialPixels, 'E redraws the balloon shape');
      await shortcut('Control+z'); assert.equal(await field('shape').inputValue(), initialShape);
      assert.equal(await menu.inputValue(), presets[0].id, 'undo restores the preset reference');
      await shortcut('Control+Shift+z'); assert.equal(await field('shape').inputValue(), shapes[(initialIndex + 1) % shapes.length]);
      for (let step = 2; step <= shapes.length; step++) {
        await shortcut(step === shapes.length ? 'Shift+E' : 'e');
        const shape = shapes[(initialIndex + step) % shapes.length];
        assert.equal(await field('shape').inputValue(), shape, 'E follows menu order and wraps');
        assert.equal(await card.locator('.balloon-seed-controls').isVisible(), shape !== 'ellipse');
        assert.equal(await card.locator('.balloon-spike-count-control').isVisible(), shape === 'spiky');
      }
      assert.deepEqual(await settings(), initialSettings, 'E preserves dimensions, text offsets, distortion and shape seeds');
      assert.equal(await card.locator('textarea').inputValue(), initialText, 'E preserves balloon text');
      assert.deepEqual(await others.evaluateAll(menus => menus.map(menu => menu.value)), otherPresets);
    } else {
      const initial = [await menu.inputValue(), ...await xy(), await field('shape').inputValue()];
      await shortcut('e');
      assert.deepEqual([await menu.inputValue(), ...await xy(), await field('shape').inputValue()], initial, 'E ignores other object kinds');
    }
  }
  const balloon = row.locator('[data-kind=balloon]'); await balloon.locator('.layer-summary').click();
  const menu = balloon.locator('[data-preset-select]');
  const state = async () => [await menu.inputValue(), await field('shape').inputValue(), await field('lineAlign').inputValue(), ...await xy()];
  const before = await state();
  for (const target of [balloon.locator('textarea'), field('x'), menu]) {
    await target.focus();
    for (const key of ['f', 'b', 'c', 'u', 'e']) {
      assert.equal(await target.evaluate((el, key) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); el.dispatchEvent(event); return event.defaultPrevented;
      }, key), false, 'editable controls keep their keyboard behavior');
    }
    assert.deepEqual(await state(), before);
  }
  await balloon.locator('textarea').focus(); await page.keyboard.type('fbcue');
  assert.match(await balloon.locator('textarea').inputValue(), /fbcue/); assert.deepEqual(await state(), before);
  await canvas.focus();
  for (const key of ['Control+f', 'Control+b', 'Control+u', 'Meta+f', 'Alt+b', 'Control+e', 'Meta+e', 'Alt+e']) {
    await page.keyboard.press(key); assert.deepEqual(await state(), before, 'modified shortcuts do not change style');
  }
  await page.keyboard.press('Control+c'); assert.deepEqual(await state(), before);
  assert.match(await page.locator('#status').textContent(), /コピーした/, 'Ctrl+C still copies objects');
  for (const key of ['f', 'b', 'c', 'u', 'e']) {
    await canvas.evaluate((el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, isComposing: true })), key);
  }
  assert.deepEqual(await state(), before, 'IME composition is ignored');
  await row.locator('[data-action=preview-full]').click(); await page.locator('#fullPreviewCanvas').waitFor({ state: 'visible' });
  for (const key of ['f', 'b', 'c', 'u', 'e']) await page.keyboard.press(key);
  assert.deepEqual(await state(), before, 'preview modal blocks editing shortcuts');
  await page.locator('#fullPreviewClose').click();
  await row.locator('[data-action=crop-image]').click();
  for (const key of ['f', 'b', 'c', 'u', 'e']) await shortcut(key);
  assert.deepEqual(await state(), before, 'crop mode blocks style shortcuts'); await page.keyboard.press('Escape');
  const empty = page.locator('.image-row').nth(1);
  await page.locator('#jump').selectOption(await empty.getAttribute('data-page-id')); await empty.locator('canvas.preview').focus();
  for (const key of ['f', 'b', 'c', 'u', 'e']) await page.keyboard.press(key);
  assert.equal(await empty.locator('.layer-card').count(), 0, 'no selection is a no-op');
  assert.deepEqual(errors, []);
  console.log('F/B presets, C/U text alignment, E balloon shape order/wrapping/redraw/controls, preserved settings, undo/redo, input/IME/modifier/modal/crop guards and Ctrl+C passed');
} finally { await browser?.close(); server.kill(); }
