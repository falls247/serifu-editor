import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
const port=5213,server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','inherit']});
let browser,page;
try{
  await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',code=>reject(new Error(`server exited: ${code}`)));});
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1680,height:1100}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);await page.uncheck('#autosaveEnabled');
  const images=await page.evaluate(()=>[[1000,750],[500,1200],[1600,400]].map(([width,height])=>{
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');
    const gradient=ctx.createLinearGradient(0,0,width,height);gradient.addColorStop(0,'#173d46');gradient.addColorStop(1,'#82aa70');ctx.fillStyle=gradient;ctx.fillRect(0,0,width,height);
    ctx.strokeStyle='#e5e7d0';ctx.lineWidth=5;ctx.strokeRect(width*.08,height*.08,width*.84,height*.84);ctx.font=`bold ${Math.min(width,height)*.09}px monospace`;ctx.fillStyle='#e5e7d0';ctx.fillText(`${width} × ${height}`,width*.12,height*.23);
    return canvas.toDataURL().split(',')[1];
  }));
  await page.locator('#fileInput').setInputFiles(images.map((base64,index)=>({name:`0${index+1}-comparison.png`,mimeType:'image/png',buffer:Buffer.from(base64,'base64')})));
  await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===3&&[...document.querySelectorAll('.original')].every(img=>img.complete&&img.naturalWidth>0));
  const results=[];
  const checkLayout=async(width,sidebar)=>{
    await page.setViewportSize({width,height:1100});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const rows=await page.locator('.image-row').evaluateAll(rows=>rows.map(row=>{
      const rect=selector=>{const box=row.querySelector(selector).getBoundingClientRect();return {x:box.x,y:box.y,width:box.width,height:box.height};};
      const img=row.querySelector('.original'),title=row.querySelector('.original-toolbar .preview-label');
      return {name:row.querySelector('.page-name').textContent,title:title?.textContent,original:rect('.original'),preview:rect('canvas.preview'),originalFrame:rect('.original-frame'),previewFrame:rect('.preview-frame'),aspect:img.naturalWidth/img.naturalHeight};
    }));
    results.push({width,sidebar,rows});await mkdir('artifacts',{recursive:true});await writeFile('artifacts/preview-layout-results.json',JSON.stringify(results,null,2));
    for(const row of rows){
      assert.equal(row.title,'ORIGINAL');
      assert.ok(Math.abs(row.original.height-row.preview.height)<1,`paired image heights at ${width}px: ${JSON.stringify(row)}`);
      assert.ok(Math.abs(row.originalFrame.height-row.previewFrame.height)<1);
      for(const image of [row.original,row.preview])assert.ok(Math.abs(image.width/image.height-row.aspect)<.02,'image aspect ratio must remain intact');
      if(width>850){assert.ok(Math.abs(row.original.y-row.preview.y)<1,'side-by-side images must start at the same height');assert.ok(Math.abs(row.originalFrame.y-row.previewFrame.y)<1);}
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  };
  for(const width of [1680,1440,1100,850,640,420])await checkLayout(width,true);
  await page.setViewportSize({width:1680,height:1100});await page.click('#toggleThumbnails');await checkLayout(1680,false);
  await page.locator('.image-row').first().scrollIntoViewIfNeeded();await page.screenshot({path:'artifacts/preview-layout-desktop.png'});
  await checkLayout(420,false);await page.locator('.image-row').first().scrollIntoViewIfNeeded();await page.screenshot({path:'artifacts/preview-layout-mobile.png'});
  assert.deepEqual(errors,[]);console.log(`Preview layout browser smoke passed: ${results.length*3} landscape/portrait/panorama layouts, ORIGINAL titles, matching image/frame heights and desktop top edges, preserved aspect ratios, sidebar resize and mobile without horizontal overflow.`);
}catch(error){if(page){await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/preview-layout-failure.png',fullPage:true}).catch(()=>{});}throw error;}
finally{await browser?.close();server.kill();}
