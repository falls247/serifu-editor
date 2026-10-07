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
  await page.clock.install();
  await page.goto(`http://127.0.0.1:${port}`);
  assert.equal(await page.locator('#autosaveMinutes').inputValue(),'2');
  assert.equal(await page.locator('#autosaveEnabled').isChecked(),true);
  await page.evaluate(()=>document.fonts.ready);
  await page.click('#demo');
  await page.waitForFunction(() => document.querySelectorAll('.image-row').length === 3 && !document.querySelector('#deck').inert);
  const rows = page.locator('.image-row'), first = rows.nth(0), second = rows.nth(1);
  const bounds = await first.locator('.row-columns > section').evaluateAll(items => items.map(item => item.getBoundingClientRect().left));
  assert.ok(bounds[0] < bounds[1] && bounds[1] < bounds[2], 'original, dialogue and preview must appear left to right');
  assert.ok(await page.locator('textarea').evaluateAll(items=>items.every(input=>input.rows===1&&input.getBoundingClientRect().height<60)),'single-line dialogue and effects must start compact');
  const oneLineHeight=await first.locator('textarea').first().evaluate(input=>input.getBoundingClientRect().height);
  await first.locator('textarea').first().fill('一行目\n二行目\n三行目');
  assert.ok(await first.locator('textarea').first().evaluate(input=>input.getBoundingClientRect().height)>oneLineHeight*2,'newlines must grow the input');
  await first.locator('textarea').first().fill('長いセリフ'.repeat(100));
  assert.equal(await first.locator('textarea').first().evaluate(input=>input.getBoundingClientRect().height),oneLineHeight,'removing newlines must shrink the input even for long text');
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
  assert.equal(await first.locator('.position-controls [data-field=vertical]').inputValue(),'true');
  await first.locator('textarea').first().focus();
  await first.locator('.position-controls [data-field=size]').fill('66');
  await first.locator('.position-controls [data-field=size]').blur();
  page.once('dialog',d=>d.accept('お気に入り縦セリフ'));await page.click('#savePreset');
  const dialoguePreset=await page.locator('#defaultDialogue').inputValue();
  await first.locator('[data-action=add-male]').click();
  assert.equal(await first.locator('.position-controls [data-field=size]').inputValue(),'66');
  assert.equal(await first.locator('.position-controls [data-field=vertical]').inputValue(),'true');
  await second.locator('[data-action=add-female]').click();
  assert.equal(await second.locator('.position-controls [data-field=size]').inputValue(),'66');
  assert.equal(await second.locator('.layer-card').last().locator('[data-preset-select]').inputValue(),dialoguePreset);
  const effectCard=first.locator('.layer-card').nth(2);await effectCard.locator('textarea').focus();
  await effectCard.locator('summary').click();
  const beforeBlur=await first.locator('canvas').evaluate(c=>c.toDataURL());
  await effectCard.locator('[data-field=blur]').fill('4');await effectCard.locator('[data-field=distortion]').fill('70');await effectCard.locator('[data-field=motionBlur]').fill('30');
  assert.notEqual(await first.locator('canvas').evaluate(c=>c.toDataURL()),beforeBlur,'blur/warp must change rasterized preview');
  page.once('dialog',d=>d.accept('ぼかし漫画'));await page.click('#savePreset');
  const effectPreset=await page.locator('#defaultSfx').inputValue();
  await second.locator('[data-action=add-sfx]').click();
  assert.equal(await second.locator('.layer-card').last().locator('[data-field=blur]').inputValue(),'4');
  assert.equal(await second.locator('.layer-card').last().locator('[data-preset-select]').inputValue(),effectPreset);
  const third=rows.nth(2),tensionCard=third.locator('.layer-card').nth(2);
  await tensionCard.locator('[data-preset-select]').selectOption('sfx-tension');
  await page.evaluate(()=>document.fonts.ready);
  assert.equal(await page.evaluate(()=>document.fonts.check('400 110px MangaBrush')),true,'bundled Japanese brush font must load');
  await third.locator('.layer-card').nth(2).locator('summary').click();
  const tension=third.locator('.layer-card').nth(2);
  await tension.locator('[data-field=blurY]').fill('96');
  await tension.locator('[data-field=dryInk]').fill('90');
  await tension.locator('[data-field=brushTails]').fill('90');
  await tension.locator('textarea').fill('ゾワッ');
  await third.screenshot({path:'artifacts/tension.png'});
  await third.locator('canvas').screenshot({path:'artifacts/tension-preview.png'});
  await page.locator('#defaultSfx').selectOption(effectPreset);
  const downloadPromise = page.waitForEvent('download'); await page.click('#projectSave');
  const download = await downloadPromise; await download.saveAs('artifacts/project.json');
  const project = JSON.parse(await readFile('artifacts/project.json', 'utf8'));
  assert.equal(project.version, 3); assert.equal(project.pages.length, 3); assert.equal(project.pages[0].layers[0].speaker, 'male');
  assert.equal(project.pages[2].layers[2].font,'brush');assert.equal(project.pages[2].layers[2].blurY,96);assert.equal(project.pages[2].layers[2].dryInk,90);assert.equal(project.pages[2].layers[2].brushTails,90);
  await first.locator('.layer-card').first().click();
  const expectedPreview=await third.locator('canvas').evaluate(canvas=>canvas.toDataURL());
  const repeated=await page.evaluate(async p=>{
    const {draw}=await import('./renderer.js'),img=new Image();img.src=p.src;await img.decode();
    const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
    draw(canvas.getContext('2d'),img,p.layers);const first=canvas.toDataURL();draw(canvas.getContext('2d'),img,p.layers);return [first,canvas.toDataURL()];
  },project.pages[2]);
  assert.equal(repeated[0],repeated[1],'brush texture must stay fixed on repaint');
  assert.equal(repeated[0],expectedPreview,'export must match unselected live preview, including directional blur and dry brush');
  await page.locator('#projectInput').setInputFiles('artifacts/project.json');
  await page.waitForFunction(() => document.querySelectorAll('.image-row').length === 6 && !document.querySelector('#deck').inert);
  assert.equal(await rows.nth(3).locator('textarea').first().inputValue(), 'MEN');
  assert.equal(await rows.nth(5).locator('.layer-card').nth(2).locator('[data-field=blurY]').inputValue(),'96');
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
  assert.equal(Object.keys(saved).length, 8); assert.equal(saved['serifu-project.json'].version, 3);
  for (const [name, image] of Object.entries(saved)) if (name.endsWith('.png')) { assert.equal(image.width, 1000); assert.equal(image.height, 750); }
  await page.click('#temporarySave');
  await page.waitForFunction(()=>document.querySelector('#draftStatus').textContent.includes('保存済'));
  await first.locator('textarea').first().fill('自動保存テスト');
  await page.clock.fastForward(121000);
  await page.waitForFunction(async()=>{const {getDraftMeta}=await import('./storage.js');return (await getDraftMeta())?.pages[0].layers[0].text==='自動保存テスト';});
  await page.locator('#autosaveMinutes').fill('0.1');await page.locator('#autosaveMinutes').blur();
  await first.locator('textarea').first().fill('短周期の保存');await page.clock.fastForward(6000);
  await page.waitForFunction(async()=>{const {getDraftMeta}=await import('./storage.js');return (await getDraftMeta())?.pages[0].layers[0].text==='短周期の保存';});
  await page.waitForFunction(()=>document.querySelector('#draftStatus').textContent.includes('保存済')&&!document.querySelector('#draftStatus').textContent.includes('変更あり'));
  await page.reload();await page.waitForSelector('#draftNotice:not([hidden])');
  assert.equal(await page.locator('.image-row').count(),0);
  assert.equal(await page.locator('#defaultDialogue').inputValue(),dialoguePreset);
  assert.equal(await page.locator('#defaultSfx').inputValue(),effectPreset);
  assert.equal(await page.locator('#autosaveMinutes').inputValue(),'0.1');
  await page.click('#restoreDraft');
  await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===7&&!document.querySelector('#deck').inert);
  assert.equal(await page.locator('.image-row').first().locator('textarea').first().inputValue(),'短周期の保存');
  assert.equal(await page.locator('.image-row').nth(2).locator('.layer-card').nth(2).locator('[data-field=brushTails]').inputValue(),'90');
  await page.locator('#autosaveEnabled').uncheck();
  const savedAt=await page.evaluate(async()=>{const {getDraftMeta}=await import('./storage.js');return (await getDraftMeta()).savedAt;});
  await page.locator('.image-row').first().locator('textarea').first().fill('自動保存OFF');await page.clock.fastForward(120000);
  assert.equal(await page.evaluate(async()=>{const {getDraftMeta}=await import('./storage.js');return (await getDraftMeta()).savedAt;}),savedAt,'disabled autosave must not write');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: 'artifacts/mobile.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'mobile layout must not overflow horizontally');
  assert.deepEqual(errors, [], 'browser runtime errors');
  console.log('Browser smoke passed: compact/auto-height inputs, brush font, directional blur/dry-brush preview-export parity, presets/draft recovery, 3-column layout, continuous editing, undo, drag, source deletion and original-size export.');
} catch (error) {
  if (page) { await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/failure.png', fullPage: true }).catch(() => {}); }
  throw error;
} finally {
  await browser?.close(); server.kill();
}
