import { spawn } from 'node:child_process';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const label=process.argv[2]||'after', count=Number(process.env.BULK_COUNT)||500, runs=Number(process.env.BULK_RUNS)||3;
const port=5199, server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','inherit']});
let browser,fixtureDirectory;
try {
  await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',code=>reject(new Error(`server exit ${code}`)));});
  fixtureDirectory=await mkdtemp(join(tmpdir(),'serifu-bulk-benchmark-'));
  browser=await chromium.launch({headless:true});
  const results=[],fixtures=new Map();
  for(const [kind,width,height] of [['small',240,180],['medium',1280,1920],['heavy',1920,2560]])for(let run=0;run<runs;run++){
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    await page.goto(`http://127.0.0.1:${port}`);await page.evaluate(()=>document.fonts.ready);
    let fixture=fixtures.get(kind);if(!fixture){fixture=await page.evaluate(async({count,width,height,kind})=>{
      const {newLayer}=await import('./renderer.js');
      const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d');
      const g=ctx.createLinearGradient(0,0,width,height);g.addColorStop(0,'#153852');g.addColorStop(.5,'#bd8668');g.addColorStop(1,'#e8d7ad');ctx.fillStyle=g;ctx.fillRect(0,0,width,height);
      for(let i=0;i<80;i++){ctx.fillStyle=`hsla(${i*37%360},45%,45%,.4)`;ctx.fillRect((i*139)%width,(i*197)%height,100+i*3,60+i*2);}
      const marker=()=>{ctx.fillStyle='#17293b';ctx.fillRect(0,height-40,Math.min(width,200),40);ctx.fillStyle='#ffffff';ctx.font='16px monospace';};
      return JSON.stringify({version:6,pages:Array.from({length:count},(_,i)=>{marker();ctx.fillText(`fixture ${i+1}`,4,height-12);const src=c.toDataURL('image/jpeg',.9);const layers=[];if(i%5===0){const l=newLayer(kind==='heavy'?'sfx':'dialogue',width,height);Object.assign(l,{text:'速度の検証！',font:'sans',size:80,w:400,h:300,glyphSeed:1234});if(kind==='heavy')Object.assign(l,{blurX:8,blurY:12,roughness:30,dryInk:15});layers.push(l);}if(i%5===1)layers.push({...newLayer('caption',width,height),text:'検証用のキャプション',font:'sans'});return {name:`${i+1}.jpg`,src,layers};})});
    },{count,width,height,kind});fixtures.set(kind,fixture);}
    await page.evaluate(()=>{window.delays=[];let last=performance.now();window.sample=setInterval(()=>{const now=performance.now();window.delays.push(Math.max(0,now-last-20));last=now;},20);window.saved=0;window.showDirectoryPicker=async()=>({getDirectoryHandle:async()=>({getFileHandle:async()=>({createWritable:async()=>({write:async()=>{await new Promise(r=>setTimeout(r,2));},close:async()=>{window.saved++;},abort:async()=>{}})})})});document.querySelector('#autosaveEnabled').click();});
    await mkdir('artifacts/bulk-benchmark',{recursive:true});const fixturePath=join(fixtureDirectory,`fixture-${kind}.json`);await writeFile(fixturePath,fixture);
    const started=Date.now();await page.locator('#projectInput').setInputFiles(fixturePath);
    await page.waitForFunction(n=>document.querySelector('#count').textContent===`${n} 枚`&&!document.querySelector('#projectLoad').disabled,count,{timeout:300000});
    const loadMs=Date.now()-started,loadMetrics=await page.evaluate(()=>window.serifuMetrics||null);
    await page.evaluate(()=>{window.loadDelays=[...window.delays];});
    // Baseline and after both use legacy JSON here to compare PNG paths under same format.
    if(await page.locator('#projectFormat').count())await page.selectOption('#projectFormat','json');
    const editResponse=await page.evaluate(async()=>{const input=document.querySelector('.layer-card textarea'),samples=[];for(let i=0;i<50;i++){const started=performance.now();input.value='編集'+i;input.dispatchEvent(new Event('input',{bubbles:true}));input.getBoundingClientRect();samples.push(performance.now()-started);await new Promise(requestAnimationFrame);}samples.sort((a,b)=>a-b);return {medianMs:samples[25],p95Ms:samples[47]};});
    await page.evaluate(()=>{window.saveDelayStart=window.delays.length;});
    const savedAt=Date.now();await page.click('#save');await page.waitForFunction(()=>!document.querySelector('#save').disabled,null,{timeout:300000});
    const saveMs=Date.now()-savedAt;
    const measurements=await page.evaluate(()=>{clearInterval(window.sample);const p95=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length*.95)]||0;};return {files:window.saved,responseP95Ms:p95(window.delays),loadResponseP95Ms:p95(window.loadDelays),saveResponseP95Ms:p95(window.delays.slice(window.saveDelayStart)),metrics:window.serifuMetrics||null,memory:performance.memory?{usedJSHeapSize:performance.memory.usedJSHeapSize}:null};});
    const imagePage=await browser.newPage({viewport:{width:1440,height:1000}});await imagePage.goto(`http://127.0.0.1:${port}`);await imagePage.evaluate(()=>document.fonts.ready);
    await imagePage.evaluate(({fixture,count})=>{const originals=JSON.parse(fixture).pages.map(p=>Uint8Array.from(atob(p.src.split(',')[1]),c=>c.charCodeAt(0)));window.showDirectoryPicker=async()=>({async *values(){for(let i=0;i<count;i++)yield {name:`${i+1}.jpg`,kind:'file',getFile:async()=>new File([originals[i]],`${i+1}.jpg`,{type:'image/jpeg'})};}});document.querySelector('#autosaveEnabled').click();},{fixture,count});
    await imagePage.evaluate(()=>{window.imageDelays=[];let last=performance.now();window.imageSample=setInterval(()=>{const now=performance.now();window.imageDelays.push(Math.max(0,now-last-20));last=now;},20);});
    const imageStarted=Date.now();await imagePage.click('#open');await imagePage.waitForFunction(n=>document.querySelector('#count').textContent===`${n} 枚`&&!document.querySelector('#projectLoad').disabled,count,{timeout:300000});
    const imageLoadMs=Date.now()-imageStarted,imageLoadMetrics=await imagePage.evaluate(()=>window.serifuMetrics||null),imageResponseP95Ms=await imagePage.evaluate(()=>{clearInterval(window.imageSample);const sorted=window.imageDelays.sort((a,b)=>a-b);return sorted[Math.floor(sorted.length*.95)]||0;});await imagePage.close();
    const result={kind,run,count,width,height,editResponse,imageLoadMs,imageLoadMetrics,imageResponseP95Ms,loadMs,saveMs,loadMetrics,...measurements};results.push(result);console.log(JSON.stringify(result));await writeFile(`artifacts/bulk-benchmark/${label}.json`,JSON.stringify({label,browser:browser.version(),fixture:'unique numbered JPEG gradients with 80 colored rectangles; 20% text/effects, 20% captions',results},null,2));await page.close();
  }
  await mkdir('artifacts/bulk-benchmark',{recursive:true});await writeFile(`artifacts/bulk-benchmark/${label}.json`,JSON.stringify({label,browser:browser.version(),fixture:'unique numbered JPEG gradients with 80 colored rectangles; 20% text/effects, 20% captions',results},null,2));
}finally{await browser?.close();server.kill();if(fixtureDirectory)await rm(fixtureDirectory,{recursive:true,force:true});}
