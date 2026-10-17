import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const {chromium}=createRequire(import.meta.url)('playwright');
const root=process.env.SERIFU_PROFILE_ROOT||fileURLToPath(new URL('../',import.meta.url));
const port=Number(process.env.SERIFU_NAVIGATION_BENCH_PORT||5292);
const samples=Number(process.env.SERIFU_BENCH_SAMPLES||5);
assert.ok(Number.isInteger(samples)&&samples>0&&samples<=20,'samples must be 1..20');
const output=process.env.SERIFU_BENCH_OUTPUT||join(tmpdir(),'serifu-navigation-menu-results');
const server=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','inherit']});
const results={root,samples,viewport:'1440x1000',menu:[],navigation:[],errors:[]};
let browser,context;
const summary=values=>{const ordered=values.toSorted((a,b)=>a-b);return {n:ordered.length,median:ordered[Math.floor(ordered.length/2)],max:ordered.at(-1)};};

async function newPage(){
  await context?.close();
  context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();
  page.on('pageerror',error=>results.errors.push(error.message));
  await page.addInitScript(()=>{
    const probe=window.__navigationProbe={draws:[],focus:[],clicks:[]};
    const clear=CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect=function(...args){
      if(this.canvas.matches?.('canvas.preview'))probe.draws.push(performance.now());
      return clear.apply(this,args);
    };
    document.addEventListener('focusin',event=>{
      if(event.target.matches('[data-preset-select]'))probe.focusStart={at:performance.now(),draws:probe.draws.length};
    },true);
    window.addEventListener('focusin',event=>{
      if(!event.target.matches('[data-preset-select]')||!probe.focusStart)return;
      probe.focus.push({ms:performance.now()-probe.focusStart.at,draws:probe.draws.length-probe.focusStart.draws,
        focused:document.activeElement===event.target,visible:event.target.getClientRects().length>0});
    });
    document.addEventListener('click',event=>{
      const button=event.target.closest('.thumbnail');
      if(button)probe.clickStart={at:performance.now(),pageId:button.dataset.pageId};
    },true);
    window.addEventListener('click',event=>{
      if(!event.target.closest('.thumbnail')||!probe.clickStart)return;
      probe.clicks.push({...probe.clickStart,syncMs:performance.now()-probe.clickStart.at,
        top:document.querySelector('.image-row.active')?.getBoundingClientRect().top});
    });
    window.addEventListener('keydown',event=>{probe.lastKey={key:event.key,trusted:event.isTrusted};},true);
  });
  await page.route('**/src/app.js',async route=>{
    const response=await route.fetch(),source=await response.text();
    await route.fulfill({response,body:`${source}\n
      window.__navigationReady=()=>pages.filter(p=>p.row).every(p=>p.mountReady&&p.img.complete&&p.img.naturalWidth>0);
      window.__holdNavigation=()=>{
        const p=pages[69];activate(p,p.selectedId,true);
        clearTimeout(pageMountTimer);pageMountTimer=null;
        p.row.scrollIntoView({behavior:'instant',block:'start'});p.canvas.focus({preventScroll:true});
        return {pending:pageMountQueue.length,anchor:typeof thumbnailNavigationAnchor!=='undefined'&&!!thumbnailNavigationAnchor};
      };
      window.__resumeNavigation=()=>schedulePageMounts(pageMountQueue,pageMountGeneration);
    `});
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.uncheck('#autosaveEnabled');
  return page;
}

async function loadFixture(page,kind){
  const fixture=await page.evaluate(async kind=>{
    const {newLayer}=await import('./src/renderer.js'),{PROJECT_VERSION}=await import('./src/model.js');
    const {defaultPreferences}=await import('./src/presets.js');
    const width=kind==='menu'?3000:400,height=kind==='menu'?2000:300;
    const image=document.createElement('canvas');image.width=width;image.height=height;
    const ctx=image.getContext('2d');ctx.fillStyle='#b9c5c1';ctx.fillRect(0,0,width,height);
    const src=image.toDataURL('image/jpeg',.82);
    const pages=Array.from({length:kind==='menu'?1:120},(_,i)=>{
      const layer={...newLayer(kind==='menu'?'sfx':'dialogue',width,height),text:kind==='menu'?'ドォォン！衝撃音':`ページ${i+1}`,
        font:kind==='menu'?'comic':'sans',size:kind==='menu'?280:42,x:width/2,y:height/2,w:width*.7,h:height*.6,
        glyphSeed:12345,textureSeed:23456,brushSeed:34567,shapeSeed:45678};
      if(kind==='menu')Object.assign(layer,{effect:'burst',outline:18,distortion:45,roughness:25,dryInk:35,brushTails:35});
      return {name:`${String(i+1).padStart(3,'0')}.png`,src,imageWidth:width,imageHeight:height,layers:[layer]};
    });
    return {version:PROJECT_VERSION,preferences:defaultPreferences(),pages};
  },kind);
  await page.locator('#projectInput').setInputFiles({name:'navigation-menu.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  await page.waitForFunction(count=>document.querySelectorAll('.thumbnail').length===count&&!document.querySelector('#projectLoad').disabled,fixture.pages.length);
  await page.waitForFunction(()=>window.__navigationReady());
  await page.evaluate(()=>document.fonts.ready);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}

try{
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('server startup timed out')),10000);
    server.stdout.once('data',()=>{clearTimeout(timer);resolve();});
    server.once('error',error=>{clearTimeout(timer);reject(error);});
    server.once('exit',code=>{clearTimeout(timer);reject(Error(`server exited: ${code}`));});
  });
  browser=await chromium.launch({headless:true});results.chromium=browser.version();
  let page=await newPage();await loadFixture(page,'menu');
  for(let i=0;i<samples;i++){
    const measurement=await page.evaluate(async()=>{
      const menu=document.querySelector('.image-row.active .layer-card.selected[data-kind=sfx] [data-preset-select]');
      if(!menu||!menu.getClientRects().length)throw Error('selected SFX menu must be visible');
      document.querySelector('#projectFormat').focus();
      (await import('./src/renderer.js')).clearGlyphCache();
      window.__navigationProbe.focus.length=0;
      const start=performance.now();menu.focus({preventScroll:true});
      return {ms:performance.now()-start,event:window.__navigationProbe.focus.at(-1),focused:document.activeElement===menu};
    });
    assert.equal(measurement.focused,true);assert.equal(measurement.event?.focused,true);assert.equal(measurement.event.visible,true);
    results.menu.push(measurement);
  }
  // A real click validates the native select path; its popup paint time is not measured.
  await page.locator('#projectFormat').focus();
  const menu=page.locator('.image-row.active .layer-card.selected[data-kind=sfx] [data-preset-select]');
  await menu.scrollIntoViewIfNeeded();
  await page.evaluate(async()=>{(await import('./src/renderer.js')).clearGlyphCache();window.__navigationProbe.focus.length=0;});
  await menu.click();await page.keyboard.press('Escape');
  results.nativeClick=await page.evaluate(()=>window.__navigationProbe.focus.at(-1));
  assert.equal(results.nativeClick?.focused,true);assert.equal(results.nativeClick.visible,true);

  page=await newPage();await loadFixture(page,'navigation');
  for(let trial=0;trial<samples;trial++){
    for(const index of [69,19]){
      await page.locator('.thumbnail').nth(index).click();
      const measurement=await page.evaluate(async()=>{
        const start=window.__navigationProbe.clicks.at(-1),row=document.querySelector('.image-row.active');
        if(row.dataset.pageId!==start.pageId)throw Error('wrong active page');
        const expected=(parseFloat(getComputedStyle(row).scrollMarginTop)||0)+(parseFloat(getComputedStyle(document.scrollingElement).scrollPaddingTop)||0);
        const initialTop=start.top;
        let firstAlignedMs=Math.abs(initialTop-expected)<=8?start.syncMs:null,stable=0;
        while(performance.now()-start.at<3000){
          await new Promise(requestAnimationFrame);
          const aligned=Math.abs(row.getBoundingClientRect().top-expected)<=8;
          if(aligned&&firstAlignedMs===null)firstAlignedMs=performance.now()-start.at;
          stable=aligned&&window.__navigationReady()?stable+1:0;
          if(stable>=3)break;
        }
        return {name:row.querySelector('.page-name').textContent,syncMs:start.syncMs,initialTop,
          finalTop:row.getBoundingClientRect().top,expectedTop:expected,firstAlignedMs,
          ready:window.__navigationReady(),elapsedMs:performance.now()-start.at,aligned:stable>=3};
      });
      results.navigation.push({trial:trial+1,...measurement});
    }
  }
  const held=await page.evaluate(()=>window.__holdNavigation());
  assert.ok(held.pending>0,'manual-scroll comparison needs pending background preparation');
  const beforeKeyY=await page.evaluate(()=>window.scrollY);
  await page.keyboard.press('PageDown');
  await page.waitForFunction(before=>Math.abs(window.scrollY-before)>20,beforeKeyY);
  const manualTop=await page.evaluate(async()=>{
    let previous=window.scrollY,stable=0;
    for(let i=0;i<90&&stable<3;i++){
      await new Promise(requestAnimationFrame);
      stable=Math.abs(window.scrollY-previous)<.5?stable+1:0;previous=window.scrollY;
    }
    return document.querySelector('.image-row.active').getBoundingClientRect().top;
  });
  const key=await page.evaluate(()=>window.__navigationProbe.lastKey);
  assert.equal(key.key,'PageDown');assert.equal(key.trusted,true);
  await page.evaluate(()=>window.__resumeNavigation());
  await page.waitForFunction(()=>window.__navigationReady());
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  results.manualKeyboard={...held,key,manualTop,finalTop:await page.locator('.image-row.active').evaluate(row=>row.getBoundingClientRect().top)};
  assert.deepEqual(results.errors,[]);
  results.summary={menuFocusMs:summary(results.menu.map(s=>s.ms)),menuFocusDraws:summary(results.menu.map(s=>s.event.draws)),
    navigationSyncMs:summary(results.navigation.map(s=>s.syncMs)),navigationAligned:results.navigation.filter(s=>s.aligned).length,
    navigationTotal:results.navigation.length};
  await mkdir(output,{recursive:true});const artifact=join(output,`navigation-menu-${Date.now()}.json`);
  await writeFile(artifact,JSON.stringify(results,null,2));
  console.log(JSON.stringify({artifact,summary:results.summary,nativeClick:results.nativeClick,navigation:results.navigation,manualKeyboard:results.manualKeyboard},null,2));
}finally{
  await context?.close().catch(()=>{});await browser?.close().catch(()=>{});
  if(server.exitCode===null){server.kill();await Promise.race([new Promise(resolve=>server.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,3000))]);}
}
