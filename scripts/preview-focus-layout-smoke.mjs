import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
const port=5327,server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','inherit']});
let browser,page;
try{
  await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',code=>reject(Error('server exited '+code)));});
  browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);await page.uncheck('#autosaveEnabled');
  const fixture=await page.evaluate(async()=>{
    const {newLayer}=await import('/src/renderer.js'),{defaultMaskEffect,PROJECT_VERSION}=await import('/src/model.js');
    const {encodeMask,maskBytesToBase64}=await import('/src/mask-codec.js');
    const pages=[];
    for(const [width,height] of [[1600,240],[400,1200],[1000,750]]){
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#607685';ctx.fillRect(0,0,width,height);
      const record={name:`focus-${width}-${height}.png`,src:canvas.toDataURL(),imageWidth:width,imageHeight:height,layers:[]};
      if(width===1000){
        record.layers=[{...newLayer('caption',width,height),text:'FOCUS',x:70,y:65,w:100,h:60,size:20,rotation:0}];
        record.imageEdit={rotation:90,crop:{x:50,y:40,width:800,height:600}};
        const bits=new Uint8Array(width*height);for(let y=70;y<120;y++)bits.fill(1,y*width+100,y*width+180);
        const asset=await encodeMask(bits,width,height,{id:'focus-mask'});
        record.maskAssets={[asset.id]:{...asset,data:undefined,decoded:undefined,dataBase64:maskBytesToBase64(asset.data)}};
        record.maskEffects=[{...defaultMaskEffect(asset,{id:'focus-mask-effect'}),effect:'fill-black'}];
      }
      pages.push(record);
    }
    return {version:PROJECT_VERSION,pages};
  });
  await page.locator('#projectInput').setInputFiles({name:'focus-layout.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
  await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===3&&!document.querySelector('#projectLoad').disabled);
  const settled=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const dimensions=async(row,record,target=null)=>row.locator('canvas.preview').evaluate(async(canvas,{record,target})=>{
    const {imageSize,imagePoint}=await import('/src/image-edit.js');
    const original=canvas.closest('.image-row').querySelector('.original'),size=imageSize(original.naturalWidth,original.naturalHeight,record.imageEdit);
    const rect=canvas.getBoundingClientRect(),frame=canvas.parentElement,b=frame.getBoundingClientRect();
    const source=target?imagePoint(target,original.naturalWidth,original.naturalHeight,record.imageEdit):{x:size.width/2,y:size.height/2};
    return {width:b.width,height:b.height,canvasX:rect.x-b.x,canvasY:rect.y-b.y,canvasWidth:rect.width,
      centerError:Math.hypot(rect.x+source.x*rect.width/size.width-(b.x+frame.clientLeft+frame.clientWidth/2),rect.y+source.y*rect.height/size.height-(b.y+frame.clientTop+frame.clientHeight/2)),imageWidth:size.width};
  },{record,target});
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:1000});await settled();
    for(let i=0;i<fixture.pages.length;i++){
      const row=page.locator('.image-row').nth(i),record=fixture.pages[i],target=record.layers[0]?{x:70,y:65}:null;
      const before=await dimensions(row,record,target);
      await row.locator('[data-action=preview-focus]').click();await settled();
      let focused=await dimensions(row,record,target);
      assert.ok(Math.abs(before.width-focused.width)<1&&Math.abs(before.height-focused.height)<1,`FOCUS preserves ${width}px frame for ${record.name}: ${before.height} -> ${focused.height}`);
      assert.ok(focused.centerError<1,`${record.name}: selection/image center remains correct through crop and rotation`);
      const zoom=row.locator('[data-focus-zoom]');await zoom.fill('137.5');await zoom.press('Tab');await settled();
      focused=await dimensions(row,record,target);
      assert.ok(Math.abs(focused.canvasWidth-focused.imageWidth*1.375)<1,'fractional zoom uses original image pixels');
      assert.ok(focused.centerError<1,'changing zoom recenters the selected object');
      const pan=row.locator('[data-focus-pan]');await pan.focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('Shift+ArrowDown');
      const panned=await dimensions(row,record,target);
      assert.ok(Math.abs(panned.canvasX-focused.canvasX-1)<1&&Math.abs(panned.canvasY-focused.canvasY-10)<1,'handle arrow keys pan the preview');
      await zoom.fill('');await zoom.press('Tab');assert.equal(await zoom.inputValue(),'137.5','blank zoom restores the previous value');
      if(i===2){
        await row.locator('.mask-effect-summary').click();await zoom.fill('200');await zoom.press('Tab');await settled();
        const centeredMask=await dimensions(row,record,{x:140,y:95});assert.ok(centeredMask.centerError<1,'selected mask center accounts for crop and image rotation');
        await row.locator('.layer-summary').click();
      }
      await row.locator('[data-action=preview-focus]').click();await settled();
      const restored=await dimensions(row,record,target);
      assert.ok(Math.abs(before.width-restored.width)<1&&Math.abs(before.height-restored.height)<1,'FOCUS OFF restores the original frame size');
    }
  }
  const first=page.locator('.image-row').first(),wide=fixture.pages[0];
  await page.setViewportSize({width:1440,height:1000});await settled();
  await first.locator('[data-action=preview-focus]').click();
  await page.setViewportSize({width:390,height:1000});await settled();
  const resized=await dimensions(first,wide);
  await first.locator('[data-action=preview-focus]').click();await settled();
  const normal=await dimensions(first,wide);
  assert.ok(Math.abs(resized.width-normal.width)<1&&Math.abs(resized.height-normal.height)<1,'viewport resize keeps the normal frame dimensions while FOCUS is active');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile FOCUS has no page-wide horizontal overflow');
  assert.deepEqual(errors,[]);
  console.log('FOCUS layout: mobile/wide/portrait frames, resize, blank zoom, keyboard pan and cropped/rotated layer+mask centers PASS');
}catch(error){
  if(page)console.error('FOCUS layout status:',await page.locator('#status').textContent());
  throw error;
}finally{await browser?.close();server.kill('SIGTERM');}
