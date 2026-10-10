import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const port = 5195;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser, page;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test server did not start')), 10000);
    server.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    server.once('error', reject);
    server.stderr.on('data', chunk => process.stderr.write(chunk));
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  await page.selectOption('#projectFormat','json');
  assert.equal(await page.locator('#textSave').isDisabled(), true);
  assert.equal(await page.locator('#textTarget').inputValue(), 'female');
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 120;
    canvas.getContext('2d').fillRect(0, 0, 160, 120);
    const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), char => char.charCodeAt(0));
    window.makeSource = (name, names) => ({ name, async *values() {
      for (const filename of names) yield { kind: 'file', name: filename, getFile: async () => new File([bytes], filename, { type: 'image/png' }) };
    } });
    window.source = window.makeSource('読込フォルダ', ['a.png', 'b.png', 'c.png']);
    window.outputs = []; window.pickerOptions = [];
    window.destination = { name: '別の保存先', getDirectoryHandle: async name => {
      const output = { name, files: {} }; window.outputs.push(output);
      return { getFileHandle: async filename => ({ createWritable: async () => { const parts=[]; return ({
        write: async value => {
          if (window.failWrite) throw new Error('simulated write failure');
          if(value instanceof Blob)output.files[filename]={bytes:value.size};else parts.push(value);
        }, close: async () => {if(parts.length)output.files[filename]=JSON.parse(parts.join(''));}, abort: async () => {},
      });} }) };
    } };
    window.showDirectoryPicker = async options => {
      window.pickerOptions.push({ mode: options.mode, startsAtSource: options.startIn === window.source, hasStartIn: 'startIn' in options });
      if (window.cancelPicker) throw new DOMException('cancel', 'AbortError');
      return window.pickDestination ? window.destination : window.source;
    };
  });
  await page.click('#open');
  const ready = () => page.waitForFunction(() => !document.querySelector('#projectLoad').disabled);
  await ready();
  assert.equal(await page.locator('#bulkPanel').isHidden(),true,'finished image loading must hide progress');
  const rows = page.locator('.image-row');
  const row = name => rows.filter({ has: page.locator('.page-name', { hasText: name }) });
  const a = row('a.png'), b = row('b.png'), c = row('c.png');
  assert.equal(await a.locator('[data-action=move-up]').isDisabled(), true);
  assert.equal(await c.locator('[data-action=move-down]').isDisabled(), true);
  const names = () => rows.locator('.page-name').allTextContents();
  const moveAfter=async(row,destination,enter=false)=>{
    const input=row.locator('[data-page-destination]');await input.fill(String(destination));
    if(enter)await input.press('Enter');else await row.locator('[data-action=move-after]').click();
  };
  assert.equal(await a.locator('[data-page-destination]').getAttribute('max'),'3');
  await moveAfter(a,3);assert.deepEqual(await names(),['b.png','c.png','a.png']);assert.equal(await a.evaluate(row=>row.classList.contains('active')),true);
  await moveAfter(a,0,true);assert.deepEqual(await names(),['a.png','b.png','c.png']);
  await moveAfter(c,1);assert.deepEqual(await names(),['a.png','c.png','b.png']);await moveAfter(c,3);assert.deepEqual(await names(),['a.png','b.png','c.png']);
  for(const destination of [1,2]){await moveAfter(b,destination);assert.deepEqual(await names(),['a.png','b.png','c.png'],'self and immediately preceding targets must keep order');}
  for(const destination of ['',-1,4,1.5]){await moveAfter(b,destination);assert.equal(await b.locator('[data-page-destination]').evaluate(input=>input.checkValidity()),false);assert.deepEqual(await names(),['a.png','b.png','c.png'],'invalid destinations must keep order');}
  assert.equal(await b.locator('.edited-badge').isHidden(),true);assert.equal(await b.locator('[data-action=undo]').isDisabled(),true);
  for (const text of ['女性A1', '女性A2\n続き']) {
    await a.locator('[data-action=add-female]').click(); await a.locator('textarea').last().fill(text);
  }
  await a.locator('[data-action=add-male]').click(); await a.locator('textarea').last().fill('男性A');
  await a.locator('[data-action=add-caption]').click(); await a.locator('textarea').last().fill('説明A');
  await c.locator('[data-action=add-female]').click(); await c.locator('textarea').fill('女性C');
  await a.locator('[data-action=complete]').click();
  await c.locator('[data-action=move-up]').click();
  await c.locator('[data-action=move-up]').click();
  await a.locator('[data-action=move-down]').click();
  await moveAfter(c,3);assert.deepEqual(await names(),['b.png','a.png','c.png']);await moveAfter(c,0,true);
  assert.deepEqual(await names(), ['c.png', 'b.png', 'a.png']);
  assert.deepEqual(await rows.locator('.page-number').allTextContents(), ['01', '02', '03']);
  assert.deepEqual(await page.locator('#jump option').allTextContents(), ['1. c.png', '2. b.png', '3. a.png']);
  assert.equal(await b.locator('.edited-badge').isHidden(), true);
  assert.equal(await a.evaluate(node => node.classList.contains('done')), true);
  assert.equal(await a.locator('[data-action=move-down]').isDisabled(), true);
  assert.equal(await c.locator('[data-action=move-up]').isDisabled(), true);
  await mkdir('artifacts',{recursive:true});await c.locator('.row-header').screenshot({path:'artifacts/page-move-desktop.png',style:'.collection-bar,footer{visibility:hidden !important}'});
  await c.locator('[data-action=complete]').click();
  assert.equal(await b.evaluate(node => node.classList.contains('active')), true);
  await b.locator('[data-action=copy-next]').isDisabled().then(value => assert.equal(value, true));

  await mkdir('artifacts', { recursive: true });
  async function textDownload(target, expected) {
    await page.selectOption('#textTarget', target);
    const downloading = page.waitForEvent('download'); await page.click('#textSave');
    const download = await downloading; assert.equal(download.suggestedFilename(), `serifu-${target}.txt`);
    await download.saveAs(`artifacts/export-${target}.txt`); await ready();
    assert.equal(await readFile(`artifacts/export-${target}.txt`, 'utf8'), `\ufeff${expected}`);
  }
  await textDownload('female', '「女性C」\n「女性A1」\n「女性A2\n続き」\n');
  await textDownload('caption', '説明A\n');
  await textDownload('male', '「男性A」\n');
  await page.selectOption('#textTarget', 'sfx'); await page.click('#textSave'); await ready();
  assert.ok(await page.locator('#status').textContent().then(text => text.includes('本文がない')));

  await page.evaluate(() => window.pickDestination = true);
  await page.click('#save'); await ready();
  assert.deepEqual(await page.evaluate(() => Object.keys(window.outputs[0].files)), ['p1_c.png', 'p2_b.png', 'p3_a.png', 'serifu-project.json']);
  assert.deepEqual(await page.evaluate(() => window.outputs[0].files['serifu-project.json'].pages.map(p => p.name)), ['c.png', 'b.png', 'a.png']);
  assert.equal(await page.evaluate(() => window.pickerOptions.at(-1).startsAtSource), true);
  assert.equal(await page.locator('#bulkPanel').isHidden(),true,'finished export must hide progress');
  assert.ok((await page.locator('#status').textContent()).includes('別の保存先/読込フォルダ_'));

  await page.evaluate(()=>{window.originalPicker=window.showDirectoryPicker;window.showDirectoryPicker=()=>new Promise(resolve=>{window.resolvePicker=resolve;});});
  await page.click('#saveEdited');await page.waitForSelector('#bulkPanel:not([hidden])');assert.ok((await page.locator('#bulkStage').textContent()).includes('保存先の選択と準備'));
  assert.equal(await page.locator('#bulkPanel').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(28, 32, 40)');
  await page.screenshot({path:'artifacts/bulk-progress-dark.png'});await page.click('#bulkCancel');await page.waitForFunction(()=>!document.querySelector('#saveEdited').disabled,null,{timeout:5000});assert.equal(await page.locator('#bulkPanel').isHidden(),true);
  await page.evaluate(()=>{window.resolvePicker(window.destination);window.showDirectoryPicker=window.originalPicker;});assert.equal(await page.evaluate(()=>window.outputs.length),1,'late picker completion cannot start an export');
  await page.click('#saveEdited'); await ready();
  assert.deepEqual(await page.evaluate(() => Object.keys(window.outputs[1].files)), ['p1_c.png', 'p3_a.png', 'serifu-project.json']);
  assert.equal(await page.evaluate(() => window.pickerOptions.at(-1).startsAtSource), true);

  await page.evaluate(() => window.cancelPicker = true);
  await page.click('#save'); await ready();
  assert.equal(await page.evaluate(() => window.outputs.length), 2);
  assert.equal(await page.locator('#save').isEnabled(), true);
  assert.equal(await page.locator('#bulkPanel').isHidden(),true,'cancelled export must hide progress');
  await page.evaluate(() => { window.cancelPicker = false; window.failWrite = true; });
  await page.click('#save'); await ready();
  assert.ok((await page.locator('#status').textContent()).includes('0 枚保存済み。simulated write failure'));
  assert.equal(await page.locator('#bulkPanel').isHidden(),true,'failed export must hide progress');
  await page.evaluate(() => {
    window.failWrite = false; window.pickDestination = false;
    window.source = window.makeSource('追加フォルダ', Array.from({ length: 7 }, (_, i) => `extra${i}.png`));
  });
  await page.click('#open'); await ready();
  assert.equal(await rows.count(), 10);
  await page.evaluate(() => window.pickDestination = true);
  await page.click('#saveEdited'); await ready();
  assert.deepEqual(await page.evaluate(() => Object.keys(window.outputs[3].files)), ['p01_c.png', 'p03_a.png', 'serifu-project.json']);
  assert.equal(await page.evaluate(() => window.pickerOptions.at(-1).startsAtSource), true);

  const downloading = page.waitForEvent('download'); await page.click('#projectSave');
  const projectDownload = await downloading; await projectDownload.saveAs('artifacts/export-project.json'); await ready();
  await page.click('#temporarySave');
  await page.waitForFunction(() => document.querySelector('#draftStatus').textContent.includes('保存済'));
  await page.reload(); await page.waitForSelector('#draftNotice:not([hidden])');
  await page.click('#restoreDraft'); await ready();
  assert.deepEqual((await names()).slice(0, 3), ['c.png', 'b.png', 'a.png']);
  await page.evaluate(() => window.showDirectoryPicker = undefined);
  await page.selectOption('#projectFormat','json');
  const zipped=page.waitForEvent('download');await page.click('#saveEdited');const zipDownload=await zipped;assert.match(zipDownload.suggestedFilename(),/^追加フォルダ_\d{8}_\d{6}_\d{3}_edited\.zip$/);await zipDownload.saveAs('artifacts/brave-edited.zip');await ready();assert.equal(await page.evaluate(()=>window.serifuMetrics.pngPacked),2);assert.equal(await page.evaluate(()=>window.serifuMetrics.archiveEntries),3);assert.equal(await page.locator('#bulkPanel').isHidden(),true);
  const allZipped=page.waitForEvent('download');await page.click('#save');await (await allZipped).saveAs('artifacts/brave-all.zip');await ready();assert.equal(await page.evaluate(()=>window.serifuMetrics.pngPacked),10);assert.equal(await page.evaluate(()=>window.serifuMetrics.archiveEntries),11);
  await textDownload('female', '「女性C」\n「女性A1」\n「女性A2\n続き」\n');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile layout must not overflow');
  await page.screenshot({ path: 'artifacts/export-mobile.png' });
  const bounds = await rows.first().locator('[data-action=move-after],[data-action=move-up],[data-action=move-down]').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().left));
  assert.ok(bounds[0] < bounds[1] && bounds[1] < bounds[2],'direct move controls must appear left of the adjacent move buttons on mobile');
  await rows.first().locator('.row-header').screenshot({path:'artifacts/page-move-mobile.png',style:'.collection-bar,footer{visibility:hidden !important}'});

  const imported = await browser.newPage(); await imported.goto(`http://127.0.0.1:${port}`);
  await imported.locator('#projectInput').setInputFiles('artifacts/export-project.json');
  await imported.waitForFunction(() => document.querySelectorAll('.image-row').length === 10 && !document.querySelector('#projectLoad').disabled);
  assert.deepEqual((await imported.locator('.page-name').allTextContents()).slice(0, 3), ['c.png', 'b.png', 'a.png']);
  await imported.close();
  assert.deepEqual(errors, []);
  console.log('指定ページの後への移動・0で先頭・Enter・前後の移動・不正値と自己指定、編集状態維持、テキスト出力、ページ順、保存先の初期位置・変更・取消、連番、JSON・一時保存の順序保持、モバイル表示を確認した');
} catch (error) {
  if (page) { await mkdir('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/export-failure.png', fullPage: true }).catch(() => {}); }
  throw error;
} finally { await browser?.close(); server.kill(); }
