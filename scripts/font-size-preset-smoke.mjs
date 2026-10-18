import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const port = 5215, server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore','pipe','inherit'] });
let browser, page;
try {
  await new Promise((resolve,reject) => { const timer=setTimeout(()=>reject(new Error('Size preset server did not start')),10000);server.stdout.once('data',()=>{clearTimeout(timer);resolve();});server.once('error',reject); });
  browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);await page.uncheck('#autosaveEnabled');
  const fixture=await page.evaluate(async()=>{
    const {newLayer}=await import('./src/renderer.js'),{defaultPreferences,createPreset}=await import('./src/presets.js');
    const kinds=['dialogue','sfx','balloon','caption'],preferences=defaultPreferences();delete preferences.fontSizePreset;
    for(const kind of kinds){const preset=createPreset(`旧${kind}`,{...newLayer(kind,800,650),font:'round',size:88},800,650);preset.style.xRatio=.01;preset.style.yRatio=.02;preferences.presets.push(preset);}
    return {version:10,preferences,pages:[[800,650],[1200,400],[400,300]].map(([width,height],index)=>{
      const c=document.createElement('canvas');c.width=width;c.height=height;c.getContext('2d').fillRect(0,0,width,height);
      return {name:`size-${index}.png`,src:c.toDataURL(),layers:index===2?[]:kinds.map((kind,i)=>({...newLayer(kind,width,height,'female'),text:'位置を保持',x:120+i*90,y:160+i*25,size:55,autoFit:kind==='caption'}))};
    })};
  });
  await page.locator('#projectInput').setInputFiles({name:'sizes.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===3&&!document.querySelector('#projectLoad').disabled);
  const rows=page.locator('.image-row'),source=rows.nth(0),target=rows.nth(1),empty=rows.nth(2);
  const field=(row,name)=>row.locator(`.position-controls [data-field=${name}]`),remember=row=>row.locator('[data-action=remember-font-size]'),apply=row=>row.locator('[data-action=apply-font-size]');
  const shortcut=async(row,key='s')=>{await row.locator('canvas.preview').focus();await page.keyboard.press(key);};
  const select=async(row,kind)=>{
    await page.locator('#jump').selectOption(await row.getAttribute('data-page-id'));
    const card=row.locator(`[data-kind=${kind}]`);
    if(!await card.evaluate(c=>c.classList.contains('selected')))await card.locator('.layer-summary').click();
  };
  const memory=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('serifu.preferences.v1'))?.fontSizePreset);
  assert.equal(await remember(empty).isDisabled(),true);assert.equal(await apply(empty).isDisabled(),true);
  assert.match(await apply(source).getAttribute('title'),/70px/);
  await apply(source).click();assert.equal(await field(source,'size').inputValue(),'70');
  await source.locator('[data-action=undo]').click();assert.equal(await field(source,'size').inputValue(),'55');
  await field(source,'size').fill('70');await remember(source).click();assert.equal(await memory(),70);
  await source.locator('[data-action=undo]').click();assert.equal(await field(source,'size').inputValue(),'55','remembering adds no object history');
  assert.equal(await memory(),70);
  for(const kind of ['dialogue','sfx','balloon','caption']){
    await select(target,kind);
    if(kind==='caption'){
      assert.equal(await remember(target).isDisabled(),true);assert.equal(await apply(target).isDisabled(),true);
      await shortcut(target);assert.equal(await field(target,'size').inputValue(),'55','S leaves auto-fit captions unchanged');
      await target.locator('.position-controls [data-field=autoFit]').uncheck();
    }
    const xy=[await field(target,'x').inputValue(),await field(target,'y').inputValue()];
    const otherPresets=await target.locator('.layer-card:not(.selected) [data-preset-select]').evaluateAll(menus=>menus.map(menu=>menu.value));
    await shortcut(target);assert.equal(await field(target,'size').inputValue(),'70',`${kind}: S applies the remembered size`);
    assert.deepEqual([await field(target,'x').inputValue(),await field(target,'y').inputValue()],xy);
    assert.equal(await target.locator(`[data-kind=${kind}] textarea`).inputValue(),'位置を保持');
    assert.equal(await target.locator(`[data-kind=${kind}] [data-preset-select]`).inputValue(),'','applying a size becomes a custom style');
    assert.deepEqual(await target.locator('.layer-card:not(.selected) [data-preset-select]').evaluateAll(menus=>menus.map(menu=>menu.value)),otherPresets,'S leaves other objects unchanged');
    await shortcut(target);
    await target.locator('[data-action=undo]').click();assert.equal(await field(target,'size').inputValue(),'55');
    await target.locator('[data-action=redo]').click();assert.equal(await field(target,'size').inputValue(),'70');
    const card=target.locator(`[data-kind=${kind}]`),preset=fixture.preferences.presets.find(p=>p.name===`旧${kind}`);
    await card.locator('[data-preset-select]').selectOption(preset.id);
    assert.deepEqual([await field(target,'x').inputValue(),await field(target,'y').inputValue()],xy,'legacy presets leave XY fixed');
    assert.equal(await field(target,'font').inputValue(),'round');
    const builtin=fixture.preferences.presets.find(p=>p.kind===kind&&p.builtin);await card.locator('[data-preset-select]').selectOption(builtin.id);
    assert.deepEqual([await field(target,'x').inputValue(),await field(target,'y').inputValue()],xy,'built-in presets leave XY fixed');
  }
  await select(source,'dialogue');await field(source,'size').fill('82');await remember(source).click();assert.equal(await memory(),82);
  await select(target,'dialogue');
  assert.match(await apply(target).getAttribute('title'),/82px/);
  await target.locator('[data-action=preview-focus]').click();
  await shortcut(target,'Shift+S');assert.equal(await field(target,'size').inputValue(),'82','S uses the updated memory in live FOCUS');
  await target.locator('[data-action=undo]').click();
  await target.locator('[data-action=preview-focus]').click();
  await select(source,'dialogue');
  page.once('dialog',dialog=>dialog.accept('位置なしの新プリセット'));await source.locator('[data-kind=dialogue] [data-action=save-preset]').click();
  const downloadProject=async format=>{
    await page.selectOption('#projectFormat',format);const pending=page.waitForEvent('download');await page.locator('#projectSave').click();const download=await pending;
    await page.waitForFunction(()=>!document.querySelector('#projectLoad').disabled);return readFile(await download.path());
  };
  const json=await downloadProject('json'),project=JSON.parse(json);assert.equal(project.preferences.fontSizePreset,82);
  for(const preset of project.preferences.presets)for(const key of ['x','y','xRatio','yRatio'])assert.equal(Object.hasOwn(preset.style,key),false);
  await page.locator('#temporarySave').click();await page.waitForFunction(()=>document.querySelector('#draftStatus').textContent.includes('保存済'));
  await page.reload();await page.waitForSelector('#draftNotice:not([hidden])');assert.equal(await memory(),82);
  await page.locator('#restoreDraft').click();await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===3&&!document.querySelector('#projectLoad').disabled);
  await select(target,'dialogue');await apply(target).click();assert.equal(await field(target,'size').inputValue(),'82');
  // Both project formats carry the size memory; importing old projects does not reset it.
  for(const format of ['json','serifu']){
    const bytes=format==='json'?json:await downloadProject(format);
    await page.evaluate(()=>{const key='serifu.preferences.v1',prefs=JSON.parse(localStorage.getItem(key));prefs.fontSizePreset=90;localStorage.setItem(key,JSON.stringify(prefs));});
    const restored=await page.context().newPage();await restored.goto(`http://127.0.0.1:${port}`);assert.equal(await memory(),90);
    await restored.locator('#projectInput').setInputFiles({name:`sizes.${format}`,mimeType:format==='json'?'application/json':'application/octet-stream',buffer:bytes});
    await restored.waitForFunction(()=>document.querySelectorAll('.image-row').length===3&&!document.querySelector('#projectLoad').disabled);assert.equal(await memory(),82);await restored.close();
  }
  const legacy=await page.context().newPage();await legacy.goto(`http://127.0.0.1:${port}`);
  await legacy.locator('#projectInput').setInputFiles({name:'legacy.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  await legacy.waitForFunction(()=>document.querySelectorAll('.image-row').length===3&&!document.querySelector('#projectLoad').disabled);assert.equal(await memory(),82);await legacy.close();
  // Buttons and shortened inputs fit their existing column at every breakpoint.
  await select(source,'dialogue');await mkdir('artifacts',{recursive:true});
  for(const width of [1680,1440,1200,1151,1100,850,640,420,390]){
    await page.setViewportSize({width,height:1000});await field(source,'size').scrollIntoViewIfNeeded();
    const bounds=await source.locator('.font-size-input').evaluate(line=>({line:line.getBoundingClientRect().toJSON(),children:[...line.children].map(c=>c.getBoundingClientRect().toJSON())}));
    assert.ok(bounds.children[0].width<=61&&bounds.children[0].width>=30,`input width at ${width}: ${bounds.children[0].width}`);
    for(const box of bounds.children)assert.ok(box.x>=bounds.line.x-.5&&box.right<=bounds.line.right+.5,`size controls overflow at ${width}`);
    const rowBounds=await source.boundingBox();
    for(const box of bounds.children)assert.ok(box.right<=rowBounds.x+rowBounds.width,`size controls clipped by the image row at ${width}: ${JSON.stringify(bounds)}`);
    if(width===1440||width===390)await page.screenshot({path:`artifacts/font-size-preset-${width}.png`});
  }
  assert.deepEqual(errors,[]);console.log('Font size memory/apply, S shortcut across all kinds and live FOCUS, fixed pixels, undo/no-op history, auto-fit, reload/project/draft restore, preset XY preservation and responsive layouts passed');
}catch(error){if(page){await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/font-size-preset-failure.png'}).catch(()=>{});}throw error;}
finally{await browser?.close();server.kill();}
