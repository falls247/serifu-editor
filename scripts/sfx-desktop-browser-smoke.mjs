import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {release} from 'node:os';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {sfxTest,exportJson,exportPng,pointPosition,assertPng} from './sfx-test-support.mjs';
import {waitForAsync} from './browser-wait.mjs';

const {chromium,webkit,firefox}=createRequire(import.meta.url)('playwright');
const engines=process.env.SFX_DESKTOP_ENGINE
  ? [chromium,webkit,firefox].filter(engine=>engine.name()===process.env.SFX_DESKTOP_ENGINE)
  : [chromium,webkit,firefox];
assert.ok(engines.length,'unknown SFX_DESKTOP_ENGINE');
const results=[];
await mkdir('artifacts',{recursive:true});
for(const [index,engine] of engines.entries()){
  const port=5306+index;
  console.log(engine.name()+': starting desktop fixture');
  try{await sfxTest(port,async({page:a,row,card,browser,errors:mainErrors})=>{
    a.setDefaultTimeout(30000);
    const result={engine:engine.name(),version:browser.version(),host:{platform:process.platform,osRelease:release(),node:process.version},headless:true,
      runtimeOverrides:{hostValidationSkipped:process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS==='1',firefoxSandboxOverrides:engine===firefox?['MOZ_DISABLE_CONTENT_SANDBOX','MOZ_DISABLE_GMP_SANDBOX','MOZ_DISABLE_RDD_SANDBOX','MOZ_DISABLE_SOCKET_PROCESS_SANDBOX','MOZ_DISABLE_UTILITY_SANDBOX'].filter(name=>process.env[name]==='1'):[]},checks:[]};
    results.push(result);
    console.log(engine.name()+': fixture ready');
    let diagnosticPage=a;
    try{
      result.browser=await a.evaluate(()=>({userAgent:navigator.userAgent,viewport:{width:innerWidth,height:innerHeight},devicePixelRatio,offscreenCanvas:typeof OffscreenCanvas!=='undefined'}));
      a.on('dialog',dialog=>dialog.accept());
      await card.locator('[data-glyph-index="0"]').click();
      for(const [field,value] of Object.entries({dx:12,dy:-8,rotation:9})){
        await card.locator(`[data-glyph-field=${field}]`).fill(String(value));
        await card.locator(`[data-glyph-field=${field}]`).press('Tab');
      }
      const source=(await exportJson(a)).pages[0].layers[0];
      assert.equal(source.lettering.glyphs[0].dx,12);
      assert.equal(source.lettering.glyphs[0].dy,-8);
      assert.equal(source.lettering.glyphs[0].rotation,9);
      await card.locator('textarea').fill('取り消す本文');
      await card.locator('textarea').press('Escape');
      assert.equal(await card.locator('textarea').inputValue(),source.text);
      await row.locator('canvas.preview').focus();
      await a.keyboard.press('Control+d');
      const duplicate=(await exportJson(a)).pages[0].layers[0];
      assert.equal(duplicate.text,'ザザーーーーッ');
      assert.equal(duplicate.lettering.glyphs.length,source.lettering.glyphs.length+1);
      await row.locator('[data-action=undo]').click();
      assert.deepEqual((await exportJson(a)).pages[0].layers[0].lettering,source.lettering);
      result.checks.push('glyph numeric edit, Escape draft cancellation, Ctrl+D and Undo');
      console.log(engine.name()+': glyph keyboard/edit PASS');

      await card.locator('.sfx-stroke-panel summary').click();
      await card.locator('[data-glyph-stroke-shape]').selectOption('s');
      await card.locator('.sfx-advanced-panel summary').click();
      await card.locator('[data-sfx-editor=editMode]').selectOption('curve');
      const before=(await exportJson(a)).pages[0].layers[0];
      const local=await a.evaluate(async layer=>{
        const {sfxScene}=await import('/src/renderer.js');
        const {strokeFrame,pathToLocal}=await import('/src/sfx-stroke-geometry.js');
        const scene=sfxScene(document.querySelector('canvas.preview').getContext('2d'),layer);
        const run=layer.lettering.strokes[0];
        return pathToLocal(strokeFrame(run,scene.positions,{size:layer.size,vertical:layer.vertical}),run.path.points[1]);
      },before);
      await row.locator('canvas.preview').scrollIntoViewIfNeeded();
      const point=await pointPosition(a,before,local);
      await a.mouse.move(point.x,point.y);
      await a.mouse.down();
      await a.mouse.move(point.x,point.y+30,{steps:4});
      await a.mouse.up();
      const dragged=(await exportJson(a)).pages[0].layers[0];
      assert.notEqual(dragged.lettering.strokes[0].path.points[1].y,before.lettering.strokes[0].path.points[1].y);
      await card.locator('[data-sfx-editor-action=width-add]').click();
      await card.locator('[data-sfx-editor=widthIndex]').selectOption('1');
      await card.locator('[data-sfx-editor=widthW]').fill('39');
      await card.locator('[data-sfx-editor=widthW]').dispatchEvent('change');
      await card.locator('[data-glyph-index="5"]').click();
      await card.locator('[data-sfx-editor=font]').selectOption('hand');
      await a.waitForFunction(()=>document.fonts.status==='loaded');
      assert.equal(await a.evaluate(async()=>{
        const {FONT_CATALOG}=await import('/src/fonts.js');
        return Array.from(document.fonts).some(face=>face.family===FONT_CATALOG.hand.family&&face.status==='loaded');
      }),true,'the requested per-glyph font is actually loaded');
      const project=await exportJson(a),lettering=project.pages[0].layers[0].lettering;
      assert.equal(lettering.strokes[0].widths[1].w,39);
      assert.equal(lettering.glyphs[5].overrides.font,'hand');
      const png=await exportPng(a,row);
      await assertPng(a,project,png);
      result.checks.push('native curve drag, variable width, per-glyph font and exact renderer/PNG pixels');
      console.log(engine.name()+': curve/font/PNG PASS');

      await a.selectOption('#projectFormat','serifu');
      const download=a.waitForEvent('download');
      await a.click('#projectSave');
      const container=await download;
      const bytes=await readFile(await container.path());
      assert.ok(container.suggestedFilename().endsWith('.serifu'));
      await a.waitForFunction(()=>!document.querySelector('#projectLoad').disabled);
      await a.locator('#projectOpenInput').setInputFiles({name:'desktop.serifu',mimeType:'application/octet-stream',buffer:bytes});
      await a.waitForFunction(()=>document.querySelector('[data-kind=sfx]')&&!document.querySelector('#projectLoad').disabled);
      assert.deepEqual((await exportJson(a)).pages[0].layers[0].lettering,lettering);
      await a.click('#temporarySave');
      await waitForAsync(a,async()=>{
        const {getDraftMeta}=await import('/src/storage.js');
        return (await getDraftMeta())?.pages[0].layers[0].lettering.glyphs[5].overrides.font==='hand';
      });
      await a.reload();
      await a.locator('#draftNotice:not([hidden])').waitFor();
      await a.click('#restoreDraft');
      await a.waitForFunction(()=>document.querySelector('[data-kind=sfx]')&&!document.querySelector('#projectLoad').disabled);
      assert.deepEqual((await exportJson(a)).pages[0].layers[0].lettering,lettering);
      assert.equal(await exportPng(a,a.locator('.image-row').first()),png);
      assert.equal(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await a.screenshot({path:`artifacts/sfx-desktop-${engine.name()}.png`,fullPage:true});
      result.checks.push('JSON/.serifu round trip, IndexedDB reload, identical PNG and no horizontal overflow');
      console.log(engine.name()+': file/storage reload PASS');

      const id=project.projectId;
      const owner=await a.evaluate(async id=>{
        const {inspectProjectLease}=await import('/src/project-lock.js');
        return inspectProjectLease(id);
      },id);
      const b=await a.context().newPage(),c=await a.context().newPage(),errors=[];
      for(const viewer of [b,c]){
        viewer.setDefaultTimeout(30000);
        viewer.on('pageerror',error=>errors.push(error.message));
        await viewer.goto(`http://localhost:${port}`);
        await viewer.locator('#draftNotice:not([hidden])').waitFor();
        await viewer.click('#restoreDraft');
        await viewer.waitForFunction(()=>document.querySelector('.image-row')&&!document.querySelector('#projectLoad').disabled);
        assert.equal(await viewer.locator('#projectAccess').getAttribute('data-readonly'),'true');
        assert.equal(await viewer.locator('#temporarySave').isDisabled(),true);
      }
      await b.locator('canvas.preview').focus();
      await b.keyboard.press('Control+d');
      assert.equal(await b.locator('[data-kind=sfx] textarea').inputValue(),project.pages[0].layers[0].text);
      assert.equal(await b.locator('.layer-card').count(),project.pages[0].layers.length,'read-only shortcuts must not duplicate layers');
      await b.click('#projectAccess');
      await b.waitForTimeout(600);
      await c.click('#projectAccess');
      await a.close();diagnosticPage=c;
      await c.waitForFunction(()=>document.querySelector('#projectAccess').dataset.readonly==='false');
      assert.equal(await b.locator('#projectAccess').getAttribute('data-readonly'),'true');
      const fenced=await b.evaluate(async({id,owner})=>{
        const {latestProjectSnapshot,saveProjectSnapshot,deleteStoredProject}=await import('/src/project-history.js');
        const {inspectProjectLease}=await import('/src/project-lock.js');
        const before=await latestProjectSnapshot(id),meta=structuredClone(before.meta);
        meta.pages[0].name='STALE WRITER';
        let denied=0;
        for(const action of [()=>saveProjectSnapshot(meta,[],{fence:owner}),()=>deleteStoredProject(id,{fence:owner})]){
          try{await action();}catch{denied++;}
        }
        return {denied,name:(await latestProjectSnapshot(id)).meta.pages[0].name,lock:await inspectProjectLease(id)};
      },{id,owner});
      assert.equal(fenced.denied,2);
      assert.equal(fenced.name,project.pages[0].name);
      assert.ok(fenced.lock.token>owner.token);
      assert.deepEqual((await exportJson(c)).pages[0].layers[0].lettering,lettering);
      assert.deepEqual(errors,[]);
      assert.deepEqual(mainErrors,[]);
      result.checks.push('three-tab read-only mode, explicit-input takeover, old-token save/delete rejection');
      result.status='passed';
      console.log(`${engine.name()} ${result.version}: desktop SFX editing/PNG/storage/three-tab lease PASS`);
    }catch(error){
      result.status='failed';result.error=error.stack;
      if(!diagnosticPage.isClosed())await diagnosticPage.screenshot({path:`artifacts/sfx-desktop-${engine.name()}-failed.png`,fullPage:true}).catch(()=>{});
      throw error;
    }finally{
      await writeFile('artifacts/sfx-desktop-results.json',JSON.stringify(results,null,2)+'\n');
    }
  },{engine,onStage:stage=>console.log(engine.name()+': '+stage)});}
  catch(error){
    let result=results.find(entry=>entry.engine===engine.name());
    if(!result){result={engine:engine.name(),checks:[]};results.push(result);}
    result.status='failed';result.error=error.stack;
    await writeFile('artifacts/sfx-desktop-results.json',JSON.stringify(results,null,2)+'\n');
    throw error;
  }
}
