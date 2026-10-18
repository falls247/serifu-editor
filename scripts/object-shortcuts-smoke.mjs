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
    const text = card.locator('textarea[data-field=text]'), originalText = await text.inputValue();
    const undoDisabled = await row.locator('[data-action=undo]').isDisabled();
    await shortcut('Enter');
    assert.equal(await text.evaluate(input => document.activeElement === input), true, `${kind}: Enter opens the selected object's text input`);
    assert.deepEqual(await text.evaluate(input => [input.selectionStart, input.selectionEnd]), [originalText.length, originalText.length], 'caret starts at the end without selecting existing text');
    assert.equal(await text.inputValue(), originalText, 'entering input mode preserves existing text');
    assert.equal(await row.locator('[data-action=undo]').isDisabled(), undoDisabled, 'entering input mode adds no undo checkpoint');
    await page.keyboard.type('追記'); await page.keyboard.press('Enter'); await page.keyboard.type('次行');
    assert.equal(await text.inputValue(), `${originalText}追記\n次行`, `${kind}: typing appends and Enter inside the input inserts a newline`);
    await text.fill(originalText);
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
    if (kind === 'balloon') await field('shape').selectOption('polygon');
    await shortcut('c');
    assert.equal(await field(kind === 'caption' ? 'alignY' : 'lineAlign').inputValue(), 'center');
    if (kind === 'balloon' || kind === 'caption') {
      if (kind === 'balloon') assert.equal(await field('shape').inputValue(), 'polygon', 'C preserves the balloon shape');
      if (kind === 'caption') assert.equal(await field('alignX').inputValue(), 'center');
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
      const unchangedFields = ['x', 'y', 'w', 'h', 'rotation', 'size', 'distortion', 'shapeSeed', 'spikeCount', 'polygonCount', 'tailX', 'tailY', 'tailWidth', 'lineAlign', 'padding', 'textOffsetX', 'textOffsetY'];
      const settings = () => Promise.all(unchangedFields.map(name => field(name).inputValue()));
      const initialText = await card.locator('textarea').inputValue();
      await menu.selectOption(presets[0].id);
      const presetShape = await field('shape').inputValue();
      const shapeKeys = { ellipse: 'e', 'distorted-rect': 'r', spiky: 'v', polygon: 'm' };
      await shortcut(shapeKeys[presetShape]);
      assert.equal(await menu.inputValue(), presets[0].id, 'selecting the current shape preserves the preset reference');
      await field('lineAlign').selectOption('top');
      await field('textOffsetX').fill('25'); await field('textOffsetY').fill('-18'); await field('padding').fill('20');
      await field('shape').selectOption('ellipse');
      const directSettings = await settings();
      const shapeShortcuts = [['r', 'distorted-rect'], ['v', 'spiky'], ['m', 'polygon'], ['e', 'ellipse']];
      for (const [key, shape] of [...shapeShortcuts, ...shapeShortcuts.map(([key, shape]) => [`Shift+${key.toUpperCase()}`, shape])]) {
        const previousShape = await field('shape').inputValue(), previousPixels = await canvas.evaluate(c => c.toDataURL());
        await shortcut(key);
        assert.equal(await field('shape').inputValue(), shape, `${key} directly selects ${shape}`);
        assert.equal(await menu.inputValue(), '', 'shape changes become a custom style');
        assert.ok(await canvas.evaluate(c => c.toDataURL()) !== previousPixels, `${key} redraws the balloon`);
        assert.deepEqual(await settings(), directSettings, `${key} preserves geometry, text alignment, padding and shape parameters`);
        assert.equal(await card.locator('textarea').inputValue(), initialText);
        assert.equal(await card.locator('.balloon-seed-controls').isVisible(), shape !== 'ellipse');
        assert.equal(await card.locator('.balloon-spike-count-control').isVisible(), shape === 'spiky');
        assert.equal(await card.locator('[data-field=polygonCount]').isVisible(), shape === 'polygon');
        await shortcut(key);
        await shortcut('Control+z'); assert.equal(await field('shape').inputValue(), previousShape, 'repeating the current shape does not add an undo entry');
        await shortcut('Control+Shift+z'); assert.equal(await field('shape').inputValue(), shape, 'redo restores the selected shape');
      }
      await field('shape').selectOption('spiky');
      await row.locator('[data-action=preview-focus]').click();
      await shortcut('Shift+C');
      assert.equal(await field('lineAlign').inputValue(), 'center', 'C centers balloon text in live FOCUS');
      assert.equal(await field('shape').inputValue(), 'spiky', 'C preserves the balloon shape in live FOCUS');
      await shortcut('e');
      assert.equal(await field('shape').inputValue(), 'ellipse', 'E directly selects ellipse in live FOCUS');
      assert.equal(await field('lineAlign').inputValue(), 'center', 'E preserves text alignment in live FOCUS');
      await row.locator('[data-action=preview-focus]').click();
      assert.deepEqual(await others.evaluateAll(menus => menus.map(menu => menu.value)), otherPresets);
    } else {
      const initial = [await menu.inputValue(), ...await xy(), await field('shape').inputValue()];
      for (const key of ['e', 'r', 'v', 'm']) {
        await shortcut(key);
        assert.deepEqual([await menu.inputValue(), ...await xy(), await field('shape').inputValue()], initial, `${key} ignores other object kinds`);
      }
    }
  }
  await row.locator('[data-kind=balloon] .layer-summary').click();
  await row.locator('[data-kind=caption] .layer-summary').click({ modifiers: ['Shift'] });
  assert.equal(await row.locator('.layer-card.multi-selected').count(), 2);
  await shortcut('Enter');
  assert.equal(await row.locator('[data-kind=caption] textarea').evaluate(input => document.activeElement === input), true, 'multiple selection edits the primary object');
  assert.equal(await row.locator('.layer-card.multi-selected').count(), 2, 'entering input mode preserves multiple selection');
  await row.locator('[data-action=preview-focus]').click();
  await shortcut('Enter');
  assert.equal(await row.locator('[data-kind=caption] textarea').evaluate(input => document.activeElement === input), true, 'Enter also works with live preview FOCUS enabled');
  await row.locator('[data-action=preview-focus]').click();
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }]) {
    await canvas.focus();
    assert.equal(await canvas.evaluate((el, options) => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options });
      el.dispatchEvent(event); return event.defaultPrevented;
    }, options), false, 'modified, repeating or IME Enter does not activate text input');
    assert.equal(await canvas.evaluate(el => document.activeElement === el), true);
  }
  const actionButton = row.locator('[data-action=save-image]');
  assert.equal(await actionButton.evaluate(el => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    el.dispatchEvent(event); return event.defaultPrevented;
  }), false, 'Enter outside the live canvas keeps native behavior');
  const balloon = row.locator('[data-kind=balloon]'); await balloon.locator('.layer-summary').click();
  const menu = balloon.locator('[data-preset-select]');
  const state = async () => [await menu.inputValue(), await field('shape').inputValue(), await field('lineAlign').inputValue(), ...await xy()];
  const before = await state();
  for (const target of [balloon.locator('textarea'), field('x'), menu]) {
    await target.focus();
    for (const key of ['f', 'b', 'c', 'u', 'e', 'r', 'v', 'm']) {
      assert.equal(await target.evaluate((el, key) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); el.dispatchEvent(event); return event.defaultPrevented;
      }, key), false, 'editable controls keep their keyboard behavior');
    }
    assert.deepEqual(await state(), before);
  }
  await balloon.locator('textarea').focus(); await page.keyboard.type('fbc uervm');
  assert.match(await balloon.locator('textarea').inputValue(), /fbc uervm/); assert.deepEqual(await state(), before);
  await canvas.focus();
  for (const key of ['Control+f', 'Control+b', 'Control+u', 'Meta+f', 'Alt+b', 'Control+e', 'Meta+e', 'Alt+e']) {
    await page.keyboard.press(key); assert.deepEqual(await state(), before, 'modified shortcuts do not change style');
  }
  for (const key of ['c', 'e', 'r', 'v', 'm']) {
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
      if (modifier !== 'altKey' && ['c', 'v'].includes(key)) continue;
      assert.equal(await canvas.evaluate((el, { key, modifier }) => {
        const event = new KeyboardEvent('keydown', { key, [modifier]: true, bubbles: true, cancelable: true });
        el.dispatchEvent(event); return event.defaultPrevented;
      }, { key, modifier }), false, 'modified shape keys keep browser behavior');
      assert.deepEqual(await state(), before);
    }
  }
  await page.keyboard.press('Control+c'); assert.deepEqual(await state(), before);
  assert.match(await page.locator('#status').textContent(), /コピーした/, 'Ctrl+C still copies objects');
  for (const key of ['f', 'b', 'c', 'u', 'e', 'r', 'v', 'm']) {
    await canvas.evaluate((el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, isComposing: true })), key);
  }
  assert.deepEqual(await state(), before, 'IME composition is ignored');
  await row.locator('[data-action=preview-full]').click(); await page.locator('#fullPreviewCanvas').waitFor({ state: 'visible' });
  await page.locator('#fullPreviewViewport').focus();
  for (const key of ['Enter', 'f', 'b', 'c', 'u', 'e', 'r', 'v', 'm']) await page.keyboard.press(key);
  assert.deepEqual(await state(), before, 'preview modal blocks editing shortcuts');
  await page.locator('#fullPreviewClose').click();
  await row.locator('[data-action=crop-image]').click();
  for (const key of ['Enter', 'f', 'b', 'c', 'u', 'e', 'r', 'v', 'm']) await shortcut(key);
  assert.equal(await canvas.evaluate(el => document.activeElement === el), true, 'crop mode does not open text input');
  assert.deepEqual(await state(), before, 'crop mode blocks style shortcuts'); await page.keyboard.press('Escape');
  const empty = page.locator('.image-row').nth(1);
  await page.locator('#jump').selectOption(await empty.getAttribute('data-page-id')); await empty.locator('canvas.preview').focus();
  for (const key of ['Enter', 'f', 'b', 'c', 'u', 'e', 'r', 'v', 'm']) await page.keyboard.press(key);
  assert.equal(await empty.locator('canvas.preview').evaluate(el => document.activeElement === el), true, 'Enter with no selected object does nothing');
  assert.equal(await empty.locator('.layer-card').count(), 0, 'no selection is a no-op');
  await empty.locator('[data-action=add-balloon]').click();
  const emptyCanvas = empty.locator('canvas.preview'), emptyShape = empty.locator('.position-controls [data-field=shape]');
  await emptyCanvas.scrollIntoViewIfNeeded();
  const rect = await emptyCanvas.boundingBox();
  await emptyCanvas.click({ position: { x: rect.width * .05, y: rect.height * .9 } });
  await empty.locator('.layer-summary').click();
  const directKeys = [['v', 'spiky'], ['m', 'polygon'], ['e', 'ellipse'], ['r', 'distorted-rect']];
  for (const [key, shape] of directKeys) {
    await page.keyboard.press(key);
    assert.equal(await emptyShape.inputValue(), shape, `${key} works immediately after clicking the balloon card`);
  }
  await emptyCanvas.click({ position: { x: rect.width * .05, y: rect.height * .9 } });
  await emptyCanvas.click({ position: { x: rect.width * .88, y: rect.height * .16 } });
  assert.equal(await empty.locator('.layer-card.selected').getAttribute('data-kind'), 'balloon');
  for (const [key, shape] of directKeys) {
    await page.keyboard.press(key);
    assert.equal(await emptyShape.inputValue(), shape, `${key} works immediately after clicking the balloon in the preview`);
  }
  assert.deepEqual(errors, []);
  console.log('Enter text input for all object kinds, multiple selection, live FOCUS, typing/newlines, F/B presets, C/U alignment, E/R/V/M balloon shapes, undo/redo, input/IME/modifier/modal/crop guards and Ctrl+C passed');
} finally { await browser?.close(); server.kill(); }
