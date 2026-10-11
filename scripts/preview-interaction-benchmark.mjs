import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {chromium}=createRequire(import.meta.url)('playwright');
const root=process.env.SERIFU_PROFILE_ROOT || fileURLToPath(new URL('../',import.meta.url));
const port=5264,server=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','inherit']});
let browser; const measurements=[];
try{
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Preview benchmark server did not start')),10000);server.stdout.once('data',()=>{clearTimeout(timer);resolve();});server.once('error',error=>{clearTimeout(timer);reject(error);});});
browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
await page.addInitScript(()=>{
 window.previewProfile={live:[],full:[],tasks:[]};
 const clear=CanvasRenderingContext2D.prototype.clearRect;
 CanvasRenderingContext2D.prototype.clearRect=function(...args){const p=window.previewProfile;if(this.canvas.classList?.contains('preview'))p.live.push({time:performance.now(),open:document.querySelector('#fullPreview')?.open});if(this.canvas.id==='fullPreviewCanvas')p.full.push(performance.now());return clear.apply(this,args);};
 new PerformanceObserver(list=>{window.previewProfile.tasks.push(...list.getEntries().map(t=>({start:t.startTime,ms:t.duration})));}).observe({type:'longtask',buffered:true});
});
await page.goto(`http://127.0.0.1:${port}`);await page.uncheck('#autosaveEnabled');
const fixture=await page.evaluate(async()=>{
const {newLayer}=await import('./src/renderer.js');const c=document.createElement('canvas');c.width=3000;c.height=4200;const ctx=c.getContext('2d');ctx.fillStyle='#426985';ctx.fillRect(0,0,c.width,c.height);
const src=c.toDataURL('image/jpeg');return {version:10,pages:Array.from({length:3},(_,index)=>({name:`${index}.jpg`,src,layers:Array.from({length:4},(_,i)=>({...newLayer('sfx',3000,4200),text:'スクロール',font:'sans',size:70+i,w:600,h:1800,x:500+i*550,y:1600,roughness:25,dryInk:30,blurX:7,blurY:8}))}))};
});
await page.locator('#projectInput').setInputFiles({name:'profile.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===3&&!document.querySelector('#projectLoad').disabled);await page.evaluate(()=>document.fonts.ready);
for(const mode of ['cold','cached']){
await page.evaluate(()=>{window.previewProfile={live:[],full:[],tasks:[]};window.profileStart=performance.now();});
await page.locator('[data-action=preview-full]').first().click();await page.locator('#fullPreviewCanvas').waitFor({state:'visible'});const shown=await page.evaluate(()=>performance.now()-window.profileStart);
await page.locator('#fullPreviewViewport').hover();const begin=performance.now();await page.mouse.wheel(0,500);await page.waitForFunction(()=>document.querySelector('#fullPreviewViewport').scrollTop>0);const scrollMs=performance.now()-begin;const firstScrollMs=await page.evaluate(()=>performance.now()-window.profileStart);
await page.setViewportSize({width:1410,height:1000});await page.waitForTimeout(200);
const data=await page.evaluate(()=>({...window.previewProfile,top:document.querySelector('#fullPreviewViewport').scrollTop}));const measured={mode,shownMs:shown,wheelMs:scrollMs,firstScrollMs,liveBeforeOpen:data.live.filter(x=>!x.open).length,liveDuringOpen:data.live.filter(x=>x.open).length,fullDraws:data.full.length,longTasks:data.tasks,scrollTop:data.top};measurements.push(measured);console.log(JSON.stringify(measured));
await page.locator('#fullPreviewClose').click();await page.waitForTimeout(100);
}
await mkdir('artifacts',{recursive:true});await writeFile('artifacts/preview-interaction-performance.json',JSON.stringify({fixture:{pages:3,width:3000,height:4200,sfxPerPage:4},measurements},null,2));
}finally{await browser?.close();server.kill();}
