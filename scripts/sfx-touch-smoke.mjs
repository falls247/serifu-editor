import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const port=5292,server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','inherit']});
let browser;
try{
 await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);});
 for(const engine of [chromium,webkit]){
  browser=await engine.launch({headless:true});
  for(const viewport of [{width:390,height:844},{width:1024,height:1366}]){
   const context=await browser.newContext({viewport,isMobile:true,hasTouch:true,deviceScaleFactor:2,acceptDownloads:true}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://localhost:${port}`);await page.uncheck('#autosaveEnabled');
   const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=1000;c.height=750;c.getContext('2d').fillStyle='#777777';c.getContext('2d').fillRect(0,0,1000,750);return c.toDataURL().split(',')[1];});await page.locator('#fileInput').setInputFiles({name:'mobile.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});await page.waitForFunction(()=>document.querySelector('.image-row')&&!document.querySelector('#projectLoad').disabled);
   const row=page.locator('.image-row'),card=row.locator('[data-kind=sfx]');await row.locator('[data-action=add-sfx]').click();await card.locator('textarea').fill('ボコッ');await row.locator('.position-controls [data-field=rotation]').fill('0');await row.locator('.position-controls [data-field=rotation]').press('Tab');await row.locator('.position-controls [data-field=x]').fill('500');await row.locator('.position-controls [data-field=x]').press('Tab');await row.locator('.position-controls [data-field=y]').fill('375');await row.locator('.position-controls [data-field=y]').press('Tab');await card.locator('[data-action=sfx-glyph-enter]').click();
   await card.locator('[data-glyph-index="1"]').tap();await card.locator('[data-glyph-field=dx]').fill('15');await card.locator('[data-glyph-field=dx]').press('Tab');assert.equal(await card.locator('[data-glyph-field=dx]').inputValue(),'15');
   await row.locator('canvas.preview').scrollIntoViewIfNeeded();const point=await row.locator('canvas.preview').evaluate(canvas=>{const b=canvas.getBoundingClientRect();return {x:b.x+b.width*.5,y:b.y+b.height*.5,width:b.width};});await page.touchscreen.tap(point.x,point.y);
   if(engine===chromium){
    const cdp=await context.newCDPSession(page);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y}]});await page.waitForTimeout(600);assert.equal(await row.locator('.preview-magnifier').isVisible(),true,'long press opens native lens');await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await row.locator('.magnifier-close').click();
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x-15,y:point.y,id:1},{x:point.x+15,y:point.y,id:2}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x-30,y:point.y,id:1},{x:point.x+30,y:point.y,id:2}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(100);assert.ok(await row.locator('canvas.preview').evaluate(c=>c.getBoundingClientRect().width)>point.width*1.5,'two-finger zoom persists through resize callbacks');
   }
   await page.click('#temporarySave');await page.waitForFunction(()=>document.querySelector('#draftStatus').textContent.includes('保存済'));await page.reload();await page.locator('#draftNotice:not([hidden])').waitFor();await page.click('#restoreDraft');await page.waitForFunction(()=>document.querySelector('[data-kind=sfx]')&&!document.querySelector('#projectLoad').disabled);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);await context.close();
   console.log(engine.name(),viewport.width,'touch numeric/lens/pinch/storage PASS');
  }
  await browser.close();browser=null;
 }
}finally{await browser?.close();server.kill('SIGTERM');}
