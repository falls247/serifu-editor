import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
const port=5200,server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let browser,page;
try {
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Test server did not start')),10000);server.stdout.once('data',()=>{clearTimeout(timer);resolve();});server.once('error',reject);server.stderr.on('data',chunk=>process.stderr.write(chunk));});
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);await page.selectOption('#projectFormat','json');
  const images=await page.evaluate(()=>[[800,650],[400,900]].map(([width,height])=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');ctx.fillStyle='#ccbbaa';ctx.fillRect(0,0,width,height);return canvas.toDataURL().split(',')[1];}));
  await page.locator('#fileInput').setInputFiles(images.map((base64,index)=>({name:`0${index+1}-speech.png`,mimeType:'image/png',buffer:Buffer.from(base64,'base64')})));
  await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===2&&!document.querySelector('#projectLoad').disabled);
  const source=page.locator('.image-row').nth(0),portrait=page.locator('.image-row').nth(1),field=name=>source.locator(`.position-controls [data-field=${name}]`);
  await source.locator('[data-action=add-female]').click();const dialogue=source.locator('[data-kind=dialogue]').first();
  assert.equal(await dialogue.locator('[data-field=textColor]').inputValue(),'#ef4b91');assert.equal(await field('textColor').inputValue(),'#ef4b91');
  await dialogue.locator('textarea').fill('指定色のセリフ');await field('vertical').selectOption('false');await field('x').fill('400');await field('y').fill('130');await field('w').fill('650');await field('h').fill('150');
  await dialogue.locator('[data-field=textColor]').fill('#2468aa');assert.equal(await field('textColor').inputValue(),'#2468aa');
  await field('textOutlineColor').fill('#cc3300');assert.equal(await dialogue.locator('[data-field=textOutlineColor]').inputValue(),'#cc3300');
  await dialogue.locator('[data-field=outline]').fill('0');assert.equal(await field('outline').inputValue(),'0');await field('outline').fill('5.5');assert.equal(await dialogue.locator('[data-field=outline]').inputValue(),'5.5');
  await dialogue.locator('[data-action=speaker-male]').click();assert.equal(await field('textColor').inputValue(),'#2468aa','explicit color must survive a speaker change');
  await dialogue.locator('[data-action=reset-text-color]').click();assert.equal(await field('textColor').inputValue(),'#111111');
  await dialogue.locator('[data-action=speaker-female]').click();assert.equal(await field('textColor').inputValue(),'#ef4b91');await field('textColor').fill('#2468aa');
  page.once('dialog',dialog=>dialog.accept('セリフの指定色'));await dialogue.locator('[data-action=save-preset]').click();
  await source.locator('[data-action=add-female]').click();assert.equal(await source.locator('[data-kind=dialogue]').last().locator('[data-field=textColor]').inputValue(),'#2468aa');await source.locator('[data-action=undo]').click();
  await source.locator('[data-action=add-balloon]').click();const balloon=source.locator('[data-kind=balloon]').first();
  await balloon.locator('textarea').fill('吹き出しの文字');await field('vertical').selectOption('false');await field('x').fill('400');await field('y').fill('415');await field('w').fill('570');await field('h').fill('330');await field('size').fill('48');await field('thickness').fill('2.5');
  await balloon.locator('[data-field=textColor]').fill('#007755');await field('textOutlineColor').fill('#cc3300');await field('outline').fill('6.5');
  assert.equal(await field('textColor').inputValue(),'#007755');assert.equal(await balloon.locator('[data-field=textOutlineColor]').inputValue(),'#cc3300');assert.equal(await balloon.locator('[data-field=outline]').inputValue(),'6.5');
  assert.equal(await balloon.locator('[data-field=shapeSeed]').isVisible(),true);assert.equal(await balloon.locator('[data-field=spikeCount]').isVisible(),false);
  await field('shapeSeed').fill('0');assert.equal(await balloon.locator('[data-field=shapeSeed]').inputValue(),'0');
  await balloon.locator('[data-field=shapeSeed]').fill('1');assert.equal(await field('shapeSeed').inputValue(),'1');
  await source.locator('.position-controls [data-action=regenerate-shape]').click();const nextSeed=await field('shapeSeed').inputValue();assert.notEqual(nextSeed,'1');
  await source.locator('[data-action=undo]').click();assert.equal(await field('shapeSeed').inputValue(),'1');await source.locator('[data-action=redo]').click();assert.equal(await field('shapeSeed').inputValue(),nextSeed);
  await field('shape').selectOption('spiky');assert.equal(await balloon.locator('[data-field=spikeCount]').isVisible(),true);
  await field('spikeCount').fill('18');assert.equal(await balloon.locator('[data-field=spikeCount]').inputValue(),'18');
  await balloon.locator('[data-field=spikeCount]').fill('24');assert.equal(await field('spikeCount').inputValue(),'24');
  await field('shapeSeed').fill('4321');await field('shapeSeed').blur();
  await field('shape').selectOption('ellipse');assert.equal(await field('shapeSeed').isVisible(),false);assert.equal(await balloon.locator('[data-field=shapeSeed]').isVisible(),false);await field('shape').selectOption('spiky');
  page.once('dialog',dialog=>dialog.accept('指定色と尖り24'));await balloon.locator('[data-action=save-preset]').click();
  await source.locator('[data-action=add-balloon]').click();const fresh=source.locator('[data-kind=balloon]').last();
  assert.equal(await fresh.locator('[data-field=shapeSeed]').inputValue(),'4321');assert.equal(await fresh.locator('[data-field=spikeCount]').inputValue(),'24');assert.equal(await fresh.locator('[data-field=textColor]').inputValue(),'#007755');await source.locator('[data-action=undo]').click();
  const pixels=await page.evaluate(async()=>{
    const {newLayer,draw}=await import('./renderer.js');const base=document.createElement('canvas');base.width=base.height=600;const bc=base.getContext('2d');bc.fillStyle='#ccbbaa';bc.fillRect(0,0,600,600);
    const canvas=document.createElement('canvas');canvas.width=canvas.height=600;const ctx=canvas.getContext('2d');
    const render=layer=>{draw(ctx,base,[layer]);return new Uint8ClampedArray(ctx.getImageData(0,0,600,600).data);};
    const colorCount=(bytes,rgb)=>{let count=0;for(let i=0;i<bytes.length;i+=4)if(bytes[i]===rgb[0]&&bytes[i+1]===rgb[1]&&bytes[i+2]===rgb[2])count++;return count;};
    const diff=(a,b)=>a.reduce((sum,value,i)=>sum+(value!==b[i]?1:0),0),samples=[];
    for(const kind of ['dialogue','balloon'])for(const thickness of [0,2.5]){
      const l={...newLayer(kind,600,600,'female'),text:'声色',vertical:false,x:300,y:300,w:430,h:350,size:84,thickness,textColor:'#2468aa',textOutlineColor:'#cc3300',outline:6,borderWidth:0,shape:'ellipse'};
      const original=render(l),recolored=render({...l,textOutlineColor:'#00aa44'}),bare=render({...l,outline:0});
      samples.push({kind,thickness,body:colorCount(original,[36,104,170]),outline:colorCount(original,[204,51,0]),recolored:colorCount(recolored,[0,170,68]),oldOutline:colorCount(recolored,[204,51,0]),bareOutline:colorCount(bare,[204,51,0])});
    }
    const b={...newLayer('balloon',600,600),x:300,y:300,w:350,h:350,distortion:85,shapeSeed:0,spikeCount:12};
    const rect=render(b),rectSeed=diff(rect,render({...b,shapeSeed:1})),spiky=render({...b,shape:'spiky'}),spikeSeed=diff(spiky,render({...b,shape:'spiky',shapeSeed:1})),spikeCount=diff(spiky,render({...b,shape:'spiky',spikeCount:24})),repeat=diff(spiky,render({...b,shape:'spiky'}));
    const styled={...b,shape:'spiky',spikeCount:24,text:'指定色',textColor:'#2468aa',textOutlineColor:'#cc3300',outline:5,thickness:2.5},html=render(styled),offscreen=new OffscreenCanvas(600,600);draw(offscreen.getContext('2d'),base,[styled]);
    return {samples,rectSeed,spikeSeed,spikeCount,repeat,offscreenDiff:diff(html,offscreen.getContext('2d').getImageData(0,0,600,600).data)};
  });
  for(const sample of pixels.samples){assert.ok(sample.body>20);assert.ok(sample.outline>20);assert.ok(sample.recolored>20);assert.equal(sample.oldOutline,0);assert.equal(sample.bareOutline,0);}
  assert.ok(pixels.rectSeed>100);assert.ok(pixels.spikeSeed>100);assert.ok(pixels.spikeCount>100);assert.equal(pixels.repeat,0);assert.equal(pixels.offscreenDiff,0);
  await source.locator('[data-action=copy-all]').click();await portrait.locator('[data-action=paste-all]').click();
  const copied=portrait.locator('[data-kind=balloon]').first();assert.equal(await copied.locator('[data-field=shapeSeed]').inputValue(),'4321');assert.equal(await copied.locator('[data-field=spikeCount]').inputValue(),'24');assert.equal(await copied.locator('[data-field=textColor]').inputValue(),'#007755');assert.equal(await copied.locator('[data-field=outline]').inputValue(),'3.25');
  await portrait.locator('canvas').focus();await page.evaluate(()=>document.fonts.ready);const preview=await source.locator('canvas').evaluate(canvas=>canvas.toDataURL());
  let saving=page.waitForEvent('download');await source.locator('[data-action=save-image]').click();const png=await saving;
  const pngPixels=await page.evaluate(async base64=>{const img=new Image();img.src='data:image/png;base64,'+base64;await img.decode();const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;canvas.getContext('2d').drawImage(img,0,0);return canvas.toDataURL();},(await readFile(await png.path())).toString('base64'));assert.equal(pngPixels,preview);
  await page.waitForFunction(()=>!document.querySelector('#projectLoad').disabled);saving=page.waitForEvent('download');await page.click('#projectSave');const download=await saving,projectBytes=await readFile(await download.path()),project=JSON.parse(projectBytes.toString());
  assert.equal(project.version,8);assert.equal(project.pages[0].layers[0].textColor,'#2468aa');assert.equal(project.pages[0].layers[0].textOutlineColor,'#cc3300');assert.equal(project.pages[0].layers[0].outline,5.5);assert.equal(project.pages[0].layers[1].shapeSeed,4321);assert.equal(project.pages[0].layers[1].spikeCount,24);
  await page.waitForFunction(()=>!document.querySelector('#projectLoad').disabled);await page.click('#temporarySave');await page.waitForFunction(async()=>{const {getDraftMeta}=await import('./storage.js');const meta=await getDraftMeta();return meta?.version===8&&meta.pages[0].layers[1].spikeCount===24;});
  await page.reload();await page.click('#restoreDraft');await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===2&&!document.querySelector('#projectLoad').disabled);
  assert.equal(await dialogue.locator('[data-field=textColor]').inputValue(),'#2468aa');assert.equal(await balloon.locator('[data-field=shapeSeed]').inputValue(),'4321');assert.equal(await balloon.locator('[data-field=spikeCount]').inputValue(),'24');
  await page.reload();await page.locator('#projectInput').setInputFiles({name:'speech-style.json',mimeType:'application/json',buffer:projectBytes});await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===2&&!document.querySelector('#projectLoad').disabled);
  assert.equal(await dialogue.locator('[data-field=textOutlineColor]').inputValue(),'#cc3300');assert.equal(await balloon.locator('[data-field=spikeCount]').inputValue(),'24');
  await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/speech-style-desktop.png'});
  await page.setViewportSize({width:420,height:860});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:'artifacts/speech-style-mobile.png'});
  assert.deepEqual(errors,[]);console.log('Speech style browser smoke passed: custom colors and outlines, zero outline, speaker defaults, synchronized controls, seed and tip count, regeneration undo, presets, copy scaling, fixed pixels, OffscreenCanvas parity, PNG and project/draft recovery, mobile layout.',pixels);
}catch(error){if(page){await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/speech-style-failure.png',fullPage:true}).catch(()=>{});}throw error;}
finally{await browser?.close();server.kill();}
