import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
const port=5193,server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let browser,page;
try {
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Test server did not start')),10000);server.stdout.once('data',()=>{clearTimeout(timer);resolve();});server.once('error',reject);server.stderr.on('data',chunk=>process.stderr.write(chunk));});
  const fontBytes=await readFile('assets/fonts/851CHIKARA-YOWAKU_002.ttf');assert.equal(createHash('sha256').update(fontBytes).digest('hex'),'0a11074b39d9ed5af63dfd4a208b8f02a22fff9b0695195064c8ace72cb8d3ce');
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  await page.selectOption('#projectFormat','json');
  const images=await page.evaluate(()=>[[1000,750],[500,1000]].map(([width,height])=>{const c=document.createElement('canvas');c.width=width;c.height=height;c.getContext('2d').fillStyle='#d5bbaa';c.getContext('2d').fillRect(0,0,width,height);return c.toDataURL().split(',')[1];}));
  await page.locator('#fileInput').setInputFiles(images.map((base64,i)=>({name:`0${i+1}-typography.png`,mimeType:'image/png',buffer:Buffer.from(base64,'base64')})));
  await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===2&&!document.querySelector('#projectLoad').disabled);
  const rows=page.locator('.image-row'),source=rows.nth(0),portrait=rows.nth(1),field=name=>source.locator(`.position-controls [data-field=${name}]`);
  await source.locator('[data-action=add-male]').click();await source.locator('[data-kind=dialogue] textarea').fill('さあ、出発しよう。');await field('font').selectOption('chikara');
  await page.evaluate(()=>document.fonts.load('400 64px MangaChikaraYowaku'));assert.equal(await page.evaluate(()=>document.fonts.check('400 64px MangaChikaraYowaku')),true);
  await source.locator('[data-action=add-sfx]').click();const sfx=source.locator('[data-kind=sfx]').first();await sfx.locator('textarea').fill('ドドドド');await field('font').selectOption('chikara');await field('size').fill('100');await field('rotation').fill('0');
  assert.equal(await sfx.locator('[data-field=effect] option[value=none]').innerText(),'なし');assert.equal(await sfx.locator('[data-field=effect] option[value=taper]').innerText(),'先細り');
  assert.equal(await sfx.locator('[data-field=taperRate]').isVisible(),false);await sfx.locator('[data-field=effect]').selectOption('taper');assert.equal(await sfx.locator('[data-field=taperRate]').isVisible(),true);assert.equal(await sfx.locator('[data-field=taperRate]').inputValue(),'10');
  await sfx.locator('[data-field=taperRate]').fill('12.5');await sfx.locator('[data-field=taperRate]').blur();await source.locator('[data-action=undo]').click();assert.equal(await sfx.locator('[data-field=taperRate]').inputValue(),'10');await source.locator('[data-action=redo]').click();assert.equal(await sfx.locator('[data-field=taperRate]').inputValue(),'12.5');
  await sfx.locator('[data-field=effect]').selectOption('none');assert.equal(await sfx.locator('[data-field=taperRate]').isVisible(),false);await sfx.locator('[data-field=effect]').selectOption('taper');assert.equal(await sfx.locator('[data-field=taperRate]').inputValue(),'12.5');
  await sfx.locator('summary').click();for(const key of ['sizeVariation','horizontalJitter','distortion','skew','roughness','dryInk','brushTails','blurX','blurY','motionBlur','blur'])await sfx.locator(`[data-field=${key}]`).fill('0');
  await page.evaluate(()=>document.fonts.ready);
  const rendering=await page.evaluate(async()=>{
    const {draw,newLayer,textGlyphs}=await import('./renderer.js'),{fontDescription}=await import('./fonts.js');
    const base=document.createElement('canvas');base.width=240;base.height=240;base.getContext('2d').fillStyle='#ffffff';base.getContext('2d').fillRect(0,0,240,240);
    const canvas=document.createElement('canvas');canvas.width=240;canvas.height=240;const ctx=canvas.getContext('2d'),punctuation=[];
    for(const font of ['chikara','sans','serif','hand','comic']){
      const query=fontDescription({font,kind:'dialogue'}).load;if(query)await document.fonts.load(query);
      for(const thickness of [0,2.5])for(const char of ['、','。']){
        const l={...newLayer('dialogue',240,240),font,thickness,text:char,x:120,y:120,w:200,h:200,size:80,outline:2};draw(ctx,base,[l]);
        const bytes=ctx.getImageData(0,0,240,240).data;let n=0,x=0,y=0;for(let i=0;i<bytes.length;i+=4)if(bytes[i]===17&&bytes[i+1]===17&&bytes[i+2]===17){n++;x+=(i/4)%240;y+=Math.floor(i/4/240);}punctuation.push({font,thickness,char,n,x:x/n,y:y/n});
      }
    }
    base.width=1000;base.height=320;base.getContext('2d').fillStyle='#ffffff';base.getContext('2d').fillRect(0,0,1000,320);canvas.width=1000;canvas.height=320;
    const layer={...newLayer('sfx',1000,320),text:'ドドドド',font:'chikara',effect:'none',taperRate:12.5,x:500,y:160,w:900,h:300,size:100,color:'#ff0000',vertical:false,rotation:0,outline:2,distortion:0,skew:0,roughness:0,dryInk:0,brushTails:0,sizeVariation:0,horizontalJitter:0};
    const stats=effect=>{layer.effect=effect;draw(ctx,base,[layer]);const glyphs=textGlyphs(ctx,layer),bytes=ctx.getImageData(0,0,1000,320).data;let black=0;for(let i=0;i<bytes.length;i+=4)if(bytes[i]===17&&bytes[i+1]===17&&bytes[i+2]===17)black++;
      const heights=glyphs.map((g,i)=>{const left=i?(g.x+glyphs[i-1].x)/2:-450,right=i+1<glyphs.length?(g.x+glyphs[i+1].x)/2:450;let min=320,max=-1;for(let y=0;y<320;y++)for(let x=Math.max(0,Math.ceil(500+left));x<Math.min(1000,Math.floor(500+right));x++){const p=(y*1000+x)*4;if(bytes[p]===255&&bytes[p+1]===0&&bytes[p+2]===0){min=Math.min(min,y);max=Math.max(max,y);}}return max-min+1;});return {black,heights};};
    return {punctuation,none:stats('none'),taper:stats('taper'),burst:stats('burst')};
  });
  for(const p of rendering.punctuation)assert.ok(p.n>5&&p.x>125&&p.y<115,`${p.font}/${p.thickness}/${p.char}: punctuation must be upper-right, including adjusted ink thickness (${p.x},${p.y})`);
  assert.equal(rendering.none.black,0,'none must omit ornaments and extrusion shadows');assert.equal(rendering.taper.black,0);assert.ok(rendering.burst.black>50);assert.ok(rendering.none.heights.every(h=>h===rendering.none.heights[0]));assert.ok(rendering.taper.heights.every((h,i,a)=>h>0&&(!i||h<a[i-1])),'taper must visibly shrink successive letters');
  page.once('dialog',dialog=>dialog.accept('チカラヨワク先細り'));await page.click('#savePreset');const preset=await page.locator('#defaultSfx').inputValue();
  await source.locator('[data-action=add-sfx]').click();assert.equal(await source.locator('[data-kind=sfx]').last().locator('[data-field=taperRate]').inputValue(),'12.5');assert.equal(await field('font').inputValue(),'chikara');await source.locator('[data-action=undo]').click();
  await page.locator('#fileInput').setInputFiles({name:'03-new-image.png',mimeType:'image/png',buffer:Buffer.from(images[0],'base64')});await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===3&&!document.querySelector('#projectLoad').disabled);
  const added=rows.nth(2);await added.locator('[data-action=add-sfx]').click();assert.equal(await added.locator('[data-kind=sfx] [data-preset-select]').inputValue(),preset);assert.equal(await added.locator('[data-kind=sfx] [data-field=taperRate]').inputValue(),'12.5');assert.equal(await added.locator('.position-controls [data-field=font]').inputValue(),'chikara');
  await source.locator('[data-action=copy-all]').click();await portrait.locator('[data-action=paste-all]').click();assert.equal(await portrait.locator('[data-kind=sfx] [data-field=taperRate]').inputValue(),'12.5');await portrait.locator('[data-kind=sfx] .layer-summary').click();await portrait.locator('[data-kind=sfx] textarea').focus();assert.equal(await portrait.locator('.position-controls [data-field=size]').inputValue(),'50');assert.equal(await portrait.locator('.position-controls [data-field=font]').inputValue(),'chikara');
  await added.locator('canvas').focus();await page.evaluate(()=>document.fonts.ready);const preview=await source.locator('canvas').evaluate(canvas=>canvas.toDataURL());
  let saving=page.waitForEvent('download');await source.locator('[data-action=save-image]').click();const png=await saving;
  const exported=await page.evaluate(async bytes=>{const image=new Image();image.src=`data:image/png;base64,${bytes}`;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;c.getContext('2d').drawImage(image,0,0);return c.toDataURL();},(await readFile(await png.path())).toString('base64'));assert.equal(exported,preview,'new font, corrected punctuation and taper must match PNG exactly');
  await page.waitForFunction(()=>!document.querySelector('#projectLoad').disabled);saving=page.waitForEvent('download');await page.click('#projectSave');const jsonDownload=await saving,project=JSON.parse(await readFile(await jsonDownload.path(),'utf8'));assert.equal(project.version,8);assert.equal(project.pages[0].layers[0].font,'chikara');assert.equal(project.pages[0].layers[1].taperRate,12.5);assert.equal(project.pages[0].layers[1].effect,'taper');
  await page.waitForFunction(()=>!document.querySelector('#projectLoad').disabled);await page.click('#temporarySave');await page.waitForFunction(async()=>{const {getDraftMeta}=await import('./storage.js');return (await getDraftMeta())?.pages[0].layers[1].taperRate===12.5;});
  await page.reload();await page.click('#restoreDraft');await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===3&&!document.querySelector('#projectLoad').disabled);assert.equal(await source.locator('[data-kind=sfx] [data-field=taperRate]').inputValue(),'12.5');assert.equal(await page.locator('#defaultSfx').inputValue(),preset);await added.locator('canvas').focus();await page.evaluate(()=>document.fonts.ready);assert.equal(await source.locator('canvas').evaluate(canvas=>canvas.toDataURL()),preview);
  await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/typography-desktop.png'});await writeFile('artifacts/typography-project.json',JSON.stringify(project));await page.reload();await page.locator('#projectInput').setInputFiles('artifacts/typography-project.json');await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===3&&!document.querySelector('#projectLoad').disabled);assert.equal(await source.locator('[data-kind=sfx] [data-field=taperRate]').inputValue(),'12.5');
  assert.deepEqual(errors,[]);console.log('Typography browser smoke passed: exact attached font bytes, dialogue and SFX font selection, upper-right punctuation in five fonts and two ink weights, none without ornaments/shadows, visible progressive taper, adjustable rate and undo, presets on new layers/images, portrait copy, exact preview/PNG parity and project/draft recovery.');
}catch(error){if(page){await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/typography-failure.png',fullPage:true}).catch(()=>{});}throw error;}
finally{await browser?.close();server.kill();}
