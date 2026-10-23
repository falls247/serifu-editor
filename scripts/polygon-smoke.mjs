import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {waitForAsync} from './browser-wait.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
const port=5238,server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let browser,page;
try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Test server did not start')),10000);server.stdout.once('data',()=>{clearTimeout(timer);resolve();});server.once('error',reject);server.stderr.on('data',chunk=>process.stderr.write(chunk));});
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  const image=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=800;canvas.height=650;const ctx=canvas.getContext('2d');ctx.fillStyle='#ccbbaa';ctx.fillRect(0,0,800,650);return canvas.toDataURL().split(',')[1];});
  await page.locator('#fileInput').setInputFiles([{name:'polygon.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')}]);
  await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===1&&!document.querySelector('#projectLoad').disabled);
  const source=page.locator('.image-row').first(),field=name=>source.locator(`.position-controls [data-field=${name}]`),balloon=source.locator('[data-kind=balloon]').first();
  await source.locator('[data-action=add-balloon]').click();
  await balloon.locator('[data-action=toggle-balloon-advanced]').click();
  assert.equal(await field('polygonCount').isVisible(),false);assert.equal(await balloon.locator('[data-action=randomize-polygon-count]').isVisible(),false);
  await field('shape').selectOption('polygon');assert.equal(await field('polygonCount').isVisible(),true);assert.equal(await field('spikeCount').isVisible(),false);
  assert.equal(await field('shapeSeed').isVisible(),true);assert.equal(await field('distortion').isVisible(),true);
  for(const [name,value] of Object.entries({x:400,y:310,w:440,h:320,size:40,shapeSeed:4321,polygonCount:3}))await field(name).fill(String(value));
  await balloon.locator('textarea').fill('多角形のセリフ');
  assert.equal(await balloon.locator('[data-field=polygonCount]').inputValue(),'3');
  await balloon.locator('[data-field=polygonCount]').fill('8.5');await balloon.locator('[data-field=polygonCount]').blur();assert.equal(await field('polygonCount').inputValue(),'9');
  const slider=balloon.locator('[data-numeric-field=polygonCount]');assert.equal(await slider.inputValue(),'9');
  await slider.press('ArrowRight');assert.equal(await field('polygonCount').inputValue(),'10');
  await source.locator('[data-action=undo]').click();assert.equal(await field('polygonCount').inputValue(),'9');
  for(const button of [source.locator('.position-controls [data-action=randomize-polygon-count]'),balloon.locator('[data-action=randomize-polygon-count]')]){
    await button.click();const count=Number(await field('polygonCount').inputValue());assert.ok(Number.isInteger(count)&&count>=3&&count<=60);assert.notEqual(count,9);
    assert.equal(await balloon.locator('[data-field=polygonCount]').inputValue(),String(count));assert.equal(await slider.inputValue(),String(count));
    await source.locator('[data-action=undo]').click();assert.equal(await field('polygonCount').inputValue(),'9');
    await source.locator('[data-action=redo]').click();assert.equal(await field('polygonCount').inputValue(),String(count));
    await source.locator('[data-action=undo]').click();
  }
  await source.locator('.position-controls [data-action=regenerate-shape]').click();assert.notEqual(await field('shapeSeed').inputValue(),'4321');assert.equal(await field('polygonCount').inputValue(),'9');
  await source.locator('[data-action=undo]').click();assert.equal(await field('shapeSeed').inputValue(),'4321');
  await field('shape').selectOption('ellipse');assert.equal(await field('polygonCount').isVisible(),false);assert.equal(await balloon.locator('[data-field=polygonCount]').isVisible(),false);
  await field('shape').selectOption('spiky');assert.equal(await field('polygonCount').isVisible(),false);assert.equal(await field('spikeCount').isVisible(),true);
  await field('shape').selectOption('polygon');assert.equal(await field('polygonCount').inputValue(),'9');
  await balloon.locator('[data-field=tail]').check();await field('tailY').fill('240');await field('tailWidth').fill('35');
  page.once('dialog',dialog=>dialog.accept('多角形9頂点'));await balloon.locator('[data-action=save-preset]').click();
  await source.locator('[data-action=add-balloon]').click();assert.equal(await field('shape').inputValue(),'polygon');assert.equal(await field('polygonCount').inputValue(),'9');assert.equal(await field('shapeSeed').inputValue(),'4321');
  await source.locator('[data-action=undo]').click();
  await source.locator('[data-action=add-caption]').click();assert.equal(await field('polygonCount').isVisible(),false);
  assert.equal(await field('shape').locator('option[value=polygon]').evaluate(option=>option.hidden),true);
  await source.locator('[data-action=undo]').click();
  const pixels=await page.evaluate(async()=>{
    const {newLayer,draw}=await import('./src/renderer.js'),{balloonOutline}=await import('./src/balloons.js');
    const base=document.createElement('canvas');base.width=base.height=500;base.getContext('2d').fillRect(0,0,500,500);
    const canvas=document.createElement('canvas');canvas.width=canvas.height=500;const ctx=canvas.getContext('2d',{willReadFrequently:true}),offscreen=new OffscreenCanvas(500,500),off=offscreen.getContext('2d',{willReadFrequently:true});
    const diff=(a,b)=>a.reduce((sum,value,i)=>sum+(value!==b[i]?1:0),0),render=layer=>{draw(ctx,base,[layer]);return ctx.getImageData(0,0,500,500).data;};
    // Keep the parity glyph inside even the triangle; clipping text at its edge
    // introduces platform antialiasing differences between Canvas implementations.
    const b={...newLayer('balloon',500,500),x:250,y:220,w:300,h:240,shape:'polygon',polygonCount:6,shapeSeed:4321,text:'声',lineAlign:'center',size:24,tailY:180};
    const first=render(b),seedDiff=diff(first,render({...b,shapeSeed:4322})),countDiff=diff(first,render({...b,polygonCount:3}));let offscreenDiff=0;
    for(const polygonCount of [3,6,60])for(const borderStyle of ['solid','brush','dry-brush'])for(const shadowEnabled of [false,true]){
      const layer={...b,polygonCount,borderStyle,tail:true,shadowEnabled},html=render(layer);draw(off,base,[layer]);offscreenDiff+=diff(html,off.getImageData(0,0,500,500).data);
    }
    return {seedDiff,countDiff,offscreenDiff,repeatDiff:diff(first,render(b)),vertices:balloonOutline(b).length-1};
  });
  assert.ok(pixels.seedDiff>100);assert.ok(pixels.countDiff>100);assert.equal(pixels.offscreenDiff,0);assert.equal(pixels.repeatDiff,0);assert.equal(pixels.vertices,6);
  await source.locator('[data-action=copy-all]').click();await source.locator('[data-action=paste-all]').click();assert.equal(await field('shape').inputValue(),'polygon');assert.equal(await field('polygonCount').inputValue(),'9');await source.locator('[data-action=undo]').click();
  await page.evaluate(()=>document.fonts.ready);await source.locator('canvas.preview').click({position:{x:2,y:2}});
  await page.waitForFunction(()=>!document.querySelector('.layer-card.selected'));
  const preview=await source.locator('canvas.preview').evaluate(canvas=>canvas.toDataURL());let saving=page.waitForEvent('download');await source.locator('[data-action=save-image]').click();
  const png=await saving,exported=await page.evaluate(async bytes=>{const img=new Image();img.src='data:image/png;base64,'+bytes;await img.decode();const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;canvas.getContext('2d').drawImage(img,0,0);return canvas.toDataURL();},(await readFile(await png.path())).toString('base64'));
  assert.ok(exported===preview,'多角形・テール・文字を含むPNGは選択枠のないプレビューに一致する');
  const projects=[];
  for(const format of ['json','serifu']){
    await page.waitForFunction(()=>!document.querySelector('#projectSave').disabled);await page.selectOption('#projectFormat',format);saving=page.waitForEvent('download');await page.click('#projectSave');const download=await saving;projects.push({name:`polygon.${format}`,mimeType:format==='json'?'application/json':'application/octet-stream',buffer:await readFile(await download.path())});
  }
  await page.waitForFunction(()=>!document.querySelector('#temporarySave').disabled);await page.click('#temporarySave');
  await waitForAsync(page,async()=>{const {getDraftMeta}=await import('./src/storage.js');const meta=await getDraftMeta();return meta?.pages[0].layers[0]?.polygonCount===9;});
  await page.reload();await page.click('#restoreDraft');await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===1&&!document.querySelector('#projectLoad').disabled);
  if(await balloon.locator('.layer-summary').isVisible())await balloon.locator('.layer-summary').click();assert.equal(await field('shape').inputValue(),'polygon');assert.equal(await field('polygonCount').inputValue(),'9');
  for(const project of projects){
    await page.reload();await page.locator('#projectInput').setInputFiles(project);await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===1&&!document.querySelector('#projectLoad').disabled);
    if(await balloon.locator('.layer-summary').isVisible())await balloon.locator('.layer-summary').click();assert.equal(await field('shape').inputValue(),'polygon');assert.equal(await field('polygonCount').inputValue(),'9');assert.equal(await field('shapeSeed').inputValue(),'4321');assert.equal(await balloon.locator('[data-field=tail]').isChecked(),true);
  }
  await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/polygon-desktop.png'});
  await page.setViewportSize({width:420,height:860});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await balloon.screenshot({path:'artifacts/polygon-mobile.png',style:'.collection-bar{visibility:hidden !important}'});
  assert.deepEqual(errors,[]);console.log('多角形ブラウザ検証 PASS: 頂点数・ランダム生成・同期・Undo/Redo・形状seed・プリセット・コピー・テール・Canvas/OffscreenCanvas・PNG・JSON/高速形式・一時保存・モバイル幅',pixels);
}catch(error){if(page){await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/polygon-failure.png',fullPage:true}).catch(()=>{});}throw error;}
finally{await browser?.close();server.kill();}
