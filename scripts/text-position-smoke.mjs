import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
const port=5201,server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let browser,page;
try {
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Test server did not start')),10000);server.stdout.once('data',()=>{clearTimeout(timer);resolve();});server.once('error',reject);server.stderr.on('data',chunk=>process.stderr.write(chunk));});
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);await page.selectOption('#projectFormat','json');
  const images=await page.evaluate(()=>[[800,600],[400,900]].map(([width,height])=>{const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d');ctx.fillStyle='#aabbcc';ctx.fillRect(0,0,width,height);return c.toDataURL().split(',')[1];}));
  await page.locator('#fileInput').setInputFiles(images.map((base64,i)=>({name:`0${i+1}-positions.png`,mimeType:'image/png',buffer:Buffer.from(base64,'base64')})));
  await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===2&&!document.querySelector('#projectLoad').disabled);
  const rows=page.locator('.image-row'),source=rows.nth(0),target=rows.nth(1),field=name=>source.locator(`.position-controls [data-field=${name}]`);
  for(const kind of ['balloon','caption']){
    await source.locator(`[data-action=add-${kind}]`).click();const card=source.locator(`[data-kind=${kind}]`).first(),cardField=name=>card.locator(`[data-field=${name}]`),slider=name=>card.locator(`[data-numeric-field=${name}]`);
    await card.locator('textarea').fill(kind==='balloon'?'吹き出しの本文\n上付き':'キャプションの本文\n位置調整');
    await field('x').fill('400');await field('y').fill(kind==='balloon'?'160':'450');await field('w').fill('420');await field('h').fill('230');
    for(const name of ['textOffsetX','textOffsetY']){assert.equal(await cardField(name).inputValue(),'0');assert.equal(await field(name).inputValue(),'0');assert.ok(await slider(name).isVisible());}
    await field('textOffsetX').fill('-25.5');assert.equal(await cardField('textOffsetX').inputValue(),'-25.5');assert.equal(await slider('textOffsetX').inputValue(),'-25.5');
    await cardField('textOffsetY').fill('33.5');assert.equal(await field('textOffsetY').inputValue(),'33.5');
    await slider('textOffsetY').press('ArrowLeft');assert.equal(await field('textOffsetY').inputValue(),'33');
    await source.locator('[data-action=undo]').click();assert.equal(await field('textOffsetY').inputValue(),'33.5');
    await source.locator('[data-action=redo]').click();assert.equal(await field('textOffsetY').inputValue(),'33');
    await field('textOffsetX').fill('12.25');await cardField('textOffsetY').fill('-17.75');
    assert.equal(await slider('textOffsetX').inputValue(),'12.25');assert.equal(await slider('textOffsetY').inputValue(),'-17.75');
    const padding=kind==='caption'?'60.5':'18.5';await field('padding').fill(padding);assert.equal(await cardField('padding').inputValue(),padding);assert.equal(await slider('padding').inputValue(),padding);
    await field('textOffsetX').fill('-25.5');await field('textOffsetY').fill('33.5');
    page.once('dialog',dialog=>dialog.accept(`${kind}の文字位置`));await card.locator('[data-action=save-preset]').click();
    await source.locator(`[data-action=add-${kind}]`).click();const fresh=source.locator(`[data-kind=${kind}]`).last();
    assert.equal(await fresh.locator('[data-field=textOffsetX]').inputValue(),'-25.5');assert.equal(await fresh.locator('[data-field=textOffsetY]').inputValue(),'33.5');assert.equal(await fresh.locator('[data-field=padding]').inputValue(),padding);
    await source.locator('[data-action=undo]').click();
  }
  await source.locator('[data-action=copy-all]').click();await target.locator('[data-action=paste-all]').click();
  for(const kind of ['balloon','caption']){
    const card=target.locator(`[data-kind=${kind}]`).first();
    assert.equal(await card.locator('[data-field=textOffsetX]').inputValue(),'-12.75');assert.equal(await card.locator('[data-field=textOffsetY]').inputValue(),'50.25');assert.equal(await card.locator('[data-field=padding]').inputValue(),kind==='caption'?'30.25':'9.25');
  }
  await source.locator('[data-action=add-male]').click();assert.equal(await field('textOffsetX').isVisible(),false);assert.equal(await field('padding').isVisible(),false);await source.locator('[data-action=undo]').click();
  const pixels=await page.evaluate(async()=>{
    const {newLayer,draw,textGlyphs}=await import('./renderer.js'),{captionLayout}=await import('./captions.js');
    const base=document.createElement('canvas');base.width=base.height=600;const bc=base.getContext('2d');bc.fillStyle='#ffffff';bc.fillRect(0,0,600,600);
    const canvas=document.createElement('canvas');canvas.width=canvas.height=600;const ctx=canvas.getContext('2d');
    await document.fonts.load('600 64px MangaSans');await document.fonts.ready;
    const render=layer=>{draw(ctx,base,[layer]);return ctx.getImageData(0,0,600,600).data;};
    const bounds=bytes=>{let left=600,right=-1,top=600,bottom=-1,count=0;for(let y=0;y<600;y++)for(let x=0;x<600;x++){const i=(y*600+x)*4;if(bytes[i]===204&&bytes[i+1]===51&&bytes[i+2]===0){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);count++;}}return {left,right,top,bottom,count};};
    const samples=[];
    for(const kind of ['balloon','caption'])for(const vertical of [true,false]){
      const layer={...newLayer(kind,600,600),x:300,y:300,w:300,h:300,size:40,text:'位置',vertical,lineAlign:'center',autoFit:false,padding:40,shape:kind==='balloon'?'distorted-rect':'rect',distortion:0,borderWidth:0,outline:0,thickness:0,textColor:'#cc3300',textOutlineWidth:0};
      const original=bounds(render(layer));
      for(const [textOffsetX,textOffsetY] of [[24,-18],[-24,18]])samples.push({kind,vertical,textOffsetX,textOffsetY,original,shifted:bounds(render({...layer,textOffsetX,textOffsetY}))});
    }
    const caption={...newLayer('caption',600,600),x:300,y:300,w:200,h:160,size:32,text:'余',vertical:false,autoFit:false,padding:50,borderWidth:0,textColor:'#cc3300'};
    const inPadding=bounds(render({...caption,textOffsetX:65}));
    const fitted=captionLayout(ctx,{...caption,autoFit:true}),shiftedFit=captionLayout(ctx,{...caption,autoFit:true,textOffsetX:30,textOffsetY:-20});
    const balloon={...newLayer('balloon',600,600),text:'あいうえおか',w:140,h:140,size:20,borderWidth:0,outline:0};
    const columns=new Set(textGlyphs(ctx,balloon).map(g=>g.x)).size,paddedColumns=new Set(textGlyphs(ctx,{...balloon,padding:10}).map(g=>g.x)).size;
    const workerLayers=[{...balloon,x:200,y:230,w:280,h:250,size:50,text:'位置',lineAlign:'center',textOffsetX:12,textOffsetY:10},{...caption,x:400,y:350,textOffsetX:-20,textOffsetY:15}];
    const html=render(workerLayers[0]);const offscreen=new OffscreenCanvas(600,600);draw(offscreen.getContext('2d'),base,[workerLayers[0]]);
    const offscreenBytes=offscreen.getContext('2d').getImageData(0,0,600,600).data;
    let offscreenDiff=0;for(let i=0;i<html.length;i++)if(html[i]!==offscreenBytes[i])offscreenDiff++;
    const blob=await new Promise(resolve=>base.toBlob(resolve,'image/png'));
    const worker=new Worker(new URL('./image-worker.js',location.href),{type:'module'});
    const png=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Worker timed out')),15000);worker.onmessage=({data})=>{clearTimeout(timer);data.error?reject(new Error(data.error)):resolve(data.value);};worker.onerror=reject;worker.postMessage({operationId:'positions',jobId:'positions',kind:'render-png',payload:{blob,width:600,height:600,layers:workerLayers}});}).finally(()=>worker.terminate());
    const bitmap=await createImageBitmap(png);offscreen.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
    draw(ctx,base,workerLayers);const preview=ctx.getImageData(0,0,600,600).data,exported=offscreen.getContext('2d').getImageData(0,0,600,600).data;
    let workerDiff=0;for(let i=0;i<preview.length;i++)if(preview[i]!==exported[i])workerDiff++;
    return {samples,inPadding,fitSize:fitted.size,shiftedFitSize:shiftedFit.size,columns,paddedColumns,offscreenDiff,workerDiff};
  });
  for(const sample of pixels.samples){assert.ok(sample.original.count>30);assert.equal(sample.shifted.count,sample.original.count);assert.equal(sample.shifted.left-sample.original.left,sample.textOffsetX);assert.equal(sample.shifted.top-sample.original.top,sample.textOffsetY);}
  assert.ok(pixels.inPadding.count>30);assert.ok(pixels.inPadding.right>350,'本文を元の余白領域へ移動しても枠内なら表示する');
  assert.equal(pixels.fitSize,pixels.shiftedFitSize);assert.equal(pixels.columns,1);assert.equal(pixels.paddedColumns,2);assert.equal(pixels.offscreenDiff,0,'HTML Canvas/OffscreenCanvas must match');assert.equal(pixels.workerDiff,0,'HTML Canvas/Worker must match');
  await target.locator('canvas').focus();await page.evaluate(()=>document.fonts.ready);const preview=await source.locator('canvas').evaluate(canvas=>canvas.toDataURL());
  let saving=page.waitForEvent('download');await source.locator('[data-action=save-image]').click();const png=await saving;
  const pngDiff=await page.evaluate(async([base64,preview])=>{
    const data=[];
    for(const src of ['data:image/png;base64,'+base64,preview]){const img=new Image();img.src=src;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);data.push(ctx.getImageData(0,0,c.width,c.height).data);}
    let channels=0,maxDelta=0,left=800,right=0,top=600,bottom=0;const samples=[];
    for(let i=0;i<data[0].length;i++)if(data[0][i]!==data[1][i]){channels++;maxDelta=Math.max(maxDelta,Math.abs(data[0][i]-data[1][i]));const pixel=Math.floor(i/4),x=pixel%800,y=Math.floor(pixel/800);left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);if(samples.length<5)samples.push({x,y,channel:i%4,png:data[0][i],preview:data[1][i]});}
    return {channels,maxDelta,left,right,top,bottom,samples};
  },[(await readFile(await png.path())).toString('base64'),preview]);assert.equal(pngDiff.channels,0,`saved PNG must match the preview pixels: ${JSON.stringify(pngDiff)}`);
  await page.waitForFunction(()=>!document.querySelector('#projectLoad').disabled);saving=page.waitForEvent('download');await page.click('#projectSave');const json=await saving,projectBytes=await readFile(await json.path()),project=JSON.parse(projectBytes.toString());
  for(const layer of project.pages[0].layers){assert.equal(layer.textOffsetX,-25.5);assert.equal(layer.textOffsetY,33.5);assert.equal(layer.padding,layer.kind==='caption'?60.5:18.5);}
  await page.waitForFunction(()=>!document.querySelector('#projectLoad').disabled);await page.click('#temporarySave');await page.waitForFunction(async()=>{const {getDraftMeta}=await import('./storage.js');return (await getDraftMeta())?.pages[0].layers.every(layer=>layer.textOffsetX===-25.5&&layer.textOffsetY===33.5);});
  await page.reload();await page.waitForSelector('#draftNotice:not([hidden])');await page.click('#restoreDraft');await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===2&&!document.querySelector('#projectLoad').disabled);
  for(const kind of ['balloon','caption']){const card=source.locator(`[data-kind=${kind}]`);assert.equal(await card.locator('[data-field=textOffsetX]').inputValue(),'-25.5');assert.equal(await card.locator('[data-field=textOffsetY]').inputValue(),'33.5');assert.equal(await card.locator('[data-field=padding]').inputValue(),kind==='caption'?'60.5':'18.5');}
  await target.locator('canvas').focus();await page.evaluate(()=>document.fonts.ready);assert.equal(await source.locator('canvas').evaluate(canvas=>canvas.toDataURL()),preview);
  await page.reload();await page.locator('#projectInput').setInputFiles({name:'text-positions.json',mimeType:'application/json',buffer:projectBytes});await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===2&&!document.querySelector('#projectLoad').disabled);
  for(const kind of ['balloon','caption'])assert.equal(await source.locator(`[data-kind=${kind}] [data-field=textOffsetY]`).inputValue(),'33.5');
  const balloonCard=source.locator('[data-kind=balloon]');if(!await balloonCard.evaluate(card=>card.classList.contains('selected')))await balloonCard.locator('.layer-summary').click();await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/text-position-desktop.png'});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:'artifacts/text-position-mobile.png'});
  assert.deepEqual(errors,[]);console.log('Text position browser smoke passed: signed offsets, fractional values and sliders, undo/redo, padding and wrapping, presets, aspect-ratio copying, auto-fit, frame clipping, pixel translation, OffscreenCanvas/Worker parity, PNG, project/draft recovery and mobile layout.');
}catch(error){if(page){await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/text-position-failure.png',fullPage:true}).catch(()=>{});}throw error;}
finally{await browser?.close();server.kill();}
