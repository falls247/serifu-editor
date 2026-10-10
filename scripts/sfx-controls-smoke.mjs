import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const {chromium}=createRequire(import.meta.url)('playwright');
const port=5211,server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','inherit']});
let browser,page;
try{
  await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',code=>reject(new Error(`server exited: ${code}`)));});
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);await page.uncheck('#autosaveEnabled');
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=800;c.height=600;c.getContext('2d').fillStyle='#ece8e0';c.getContext('2d').fillRect(0,0,800,600);return c.toDataURL().split(',')[1];});
  await page.locator('#fileInput').setInputFiles({name:'sfx-controls.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
  await page.waitForFunction(()=>document.querySelector('.image-row')&&!document.querySelector('#projectLoad').disabled);
  const row=page.locator('.image-row'),position=row.locator('.position-controls');await row.locator('[data-action=add-sfx]').click();
  const card=row.locator('[data-kind=sfx]'),number=field=>card.locator(`input[data-field=${field}]`),slider=field=>card.locator(`input[data-numeric-field=${field}]`);
  await card.locator('textarea').fill('ドキ♥♡');await position.locator('[data-field=font]').selectOption('chikara');await position.locator('[data-field=vertical]').selectOption('false');
  for(const [field,value] of Object.entries({rotation:0,size:100,w:740,h:260}))await position.locator(`[data-field=${field}]`).fill(String(value));
  await card.locator('[data-field=effect]').selectOption('none');
  const placement=card.locator('.placement-settings'),effects=card.locator('.effect-details:not(.placement-settings)');await placement.locator('summary').click();await effects.locator('summary').click();
  for(const field of ['distortion','skew','roughness','dryInk','brushTails','sizeVariation','horizontalJitter'])await number(field).fill('0');
  await card.locator('[data-field=kerningMode]').selectOption('optical');await number('kerningStrength').fill('85');await number('rotationJitter').fill('12');
  const oldSeed=await number('glyphSeed').inputValue();await card.locator('[data-action=regenerate-placement]').click();
  assert.notEqual(await number('glyphSeed').inputValue(),oldSeed);assert.equal(await placement.getAttribute('open'),'');assert.equal(await effects.getAttribute('open'),'');
  await row.locator('[data-action=undo]').click();assert.equal(await number('glyphSeed').inputValue(),oldSeed);assert.equal(await placement.getAttribute('open'),'');assert.equal(await effects.getAttribute('open'),'');
  await row.locator('[data-action=redo]').click();assert.notEqual(await number('glyphSeed').inputValue(),oldSeed);assert.equal(await placement.getAttribute('open'),'');
  await effects.locator('summary').click();await card.locator('[data-action=regenerate-placement]').click();assert.equal(await effects.getAttribute('open'),null);await effects.locator('summary').click();
  const numericPairs=await row.evaluate(row=>[...row.querySelectorAll('input[data-field][type=number],input[data-field][type=range]')].map(input=>({field:input.dataset.field,paired:!!input.closest('.numeric-setting')?.querySelector(`[data-numeric-field="${input.dataset.field}"]`)})));
  assert.ok(numericPairs.length>30);assert.ok(numericPairs.every(pair=>pair.paired),'every layer and position numeric field must have the other input mode');
  await number('kerningStrength').fill('62');assert.equal(await slider('kerningStrength').inputValue(),'62');
  await number('kerningStrength').press('ArrowUp');assert.equal(await number('kerningStrength').inputValue(),'63');assert.equal(await slider('kerningStrength').inputValue(),'63');
  const track=await slider('kerningStrength').boundingBox();await page.mouse.move(track.x+track.width*.65,track.y+track.height/2);await page.mouse.down();await page.mouse.move(track.x+track.width*.81,track.y+track.height/2,{steps:8});await page.mouse.up();
  const dragged=await slider('kerningStrength').inputValue();assert.ok(Number(dragged)>75);assert.equal(await number('kerningStrength').inputValue(),dragged);
  await slider('kerningStrength').press('ArrowLeft');assert.equal(await number('kerningStrength').inputValue(),String(Number(dragged)-1));
  await row.locator('[data-action=undo]').click();assert.equal(await number('kerningStrength').inputValue(),dragged);await row.locator('[data-action=undo]').click();assert.equal(await number('kerningStrength').inputValue(),'63');
  await row.locator('[data-action=redo]').click();assert.equal(await number('kerningStrength').inputValue(),dragged);
  await position.locator('[data-field=w]').fill('2500');assert.equal(await position.locator('[data-numeric-field=w]').inputValue(),'2500');assert.equal(await position.locator('[data-numeric-field=w]').getAttribute('max'),'2500');await position.locator('[data-field=w]').fill('740');
  await number('minimumGlyphGap').fill('1.6');assert.equal(await slider('minimumGlyphGap').inputValue(),'1.6');await number('outline').fill('3.25');assert.equal(await slider('outline').inputValue(),'3.25');
  await card.locator('[data-field=textOutlineColor]').fill('#a63870');await number('outline').fill('6.5');assert.equal(await slider('outline').inputValue(),'6.5');assert.equal(await position.locator('[data-field=outline]').inputValue(),'6.5');
  await position.locator('[data-numeric-field=outline]').focus();await position.locator('[data-numeric-field=outline]').press('ArrowRight');assert.equal(await number('outline').inputValue(),'7');
  await page.evaluate(()=>document.fonts.ready);
  const rendering=await page.evaluate(async()=>{
    const {newLayer,draw,textGlyphs,clearGlyphCache}=await import('./renderer.js'),{fontDescription,glyphFontDescription,fontLoadQueries}=await import('./fonts.js'),{captionLayout}=await import('./captions.js');
    const ctx=document.createElement('canvas').getContext('2d');const missing=[],hearts=[];
    for(const font of ['chikara','hand','brush','comic','round']){
      await Promise.all(fontLoadQueries({font}).map(query=>document.fonts.load(query)));clearGlyphCache();
      for(const char of ['♥','♡']){
        const layer={...newLayer('sfx',360,360),font,text:char,effect:'none',size:100,x:180,y:180,w:320,h:320,rotation:0,outline:0,distortion:0,skew:0,roughness:0,dryInk:0,brushTails:0,sizeVariation:0,horizontalJitter:0};
        const primary=fontDescription(layer);ctx.font=`${primary.weight} 100px "${fontDescription({font}).family.split('"')[1]}"`;const m=ctx.measureText(char);
        if(m.actualBoundingBoxLeft+m.actualBoundingBoxRight===0&&m.actualBoundingBoxAscent+m.actualBoundingBoxDescent===0)missing.push({font,char});
        const chosen=glyphFontDescription(ctx,layer,char);if(font==='chikara'&&!chosen.family.startsWith('"MangaGekifude"'))throw new Error('empty Chikara heart did not use GEKIFUDE');
        for(const vertical of [false,true])for(const kerningMode of ['standard','optical']){
          const a=document.createElement('canvas'),b=document.createElement('canvas');a.width=b.width=360;a.height=b.height=360;
          const config={...layer,vertical,kerningMode,kerningStrength:85};draw(a.getContext('2d'),a,[config]);
          // Preserve the renderer-selected font for covered symbols; force GEKIFUDE for empty Chikara hearts.
          if(font==='chikara')draw(b.getContext('2d'),b,[{...config,font:'gekifude'}]);else b.getContext('2d').drawImage(a,0,0);
          const pixels=a.getContext('2d').getImageData(0,0,360,360).data,reference=b.getContext('2d').getImageData(0,0,360,360).data;
          hearts.push({font,char,vertical,kerningMode,ink:pixels.filter((value,i)=>i%4===3&&value>0).length,diff:pixels.reduce((n,value,i)=>n+(value!==reference[i]),0)});
        }
      }
      const layer={...newLayer('sfx',360,360),font};if(!glyphFontDescription(ctx,layer,'あ').family.startsWith(`"${primaryFamily(fontDescription(layer))}"`))throw new Error('covered glyph replaced');
    }
    function primaryFamily(description){return description.family.split('"')[1];}
    const caption={...newLayer('caption',360,360),font:'chikara',text:'あ♥♡',autoFit:false,size:70};const layout=captionLayout(ctx,caption);
    const captionFonts=layout.glyphs.map(g=>({char:g.char,font:g.font}));
    const base=document.createElement('canvas');base.width=800;base.height=500;const c=base.getContext('2d');c.fillStyle='#ece8e0';c.fillRect(0,0,800,500);
    const reference={...newLayer('sfx',800,500),font:'chikara',text:'ドキ♥♡',vertical:false,x:400,y:140,w:740,h:220,size:110,rotation:0,effect:'none',outline:7,textOutlineColor:'#a63870',distortion:0,skew:0,roughness:0,dryInk:0,brushTails:0,sizeVariation:0,horizontalJitter:0,kerningMode:'optical',kerningStrength:85};
    const balloon={...newLayer('balloon',800,500),font:'chikara',text:'好き♥♡',size:40,x:200,y:370,w:300,h:210,vertical:false};
    const box={...newLayer('caption',800,500),font:'chikara',text:'♥♡ ハートの枠',x:590,y:370,w:340,h:150,vertical:false};
    const result=document.createElement('canvas');result.width=800;result.height=500;draw(result.getContext('2d'),base,[reference,balloon,box]);
    const pixels=result.getContext('2d').getImageData(0,0,800,500).data;const outlinePixels=pixels.filter((value,i)=>i%4===0&&value===166&&pixels[i+1]===56&&pixels[i+2]===112).length;
    return {missing,hearts,captionFonts,outlinePixels,png:result.toDataURL(),layout:textGlyphs(ctx,reference).map(g=>({char:g.char,x:g.x,y:g.y}))};
  });
  assert.ok(rendering.missing.filter(g=>g.font==='chikara').length===2);assert.ok(rendering.hearts.every(g=>g.ink>30&&g.diff===0));
  assert.match(rendering.captionFonts[0].font,/MangaChikaraYowaku/);for(const g of rendering.captionFonts.slice(1))assert.match(g.font,/MangaGekifude/);assert.ok(rendering.outlinePixels>100);
  page.once('dialog',dialog=>dialog.accept('色付き輪郭'));await card.locator('[data-action=save-preset]').click();const preset=await card.locator('[data-preset-select]').inputValue();
  await card.locator('[data-field=textOutlineColor]').fill('#224466');await card.locator('[data-field=textOutlineColor]').blur();await card.locator('[data-preset-select]').selectOption(preset);assert.equal(await card.locator('[data-field=textOutlineColor]').inputValue(),'#a63870');assert.equal(await number('outline').inputValue(),'7');assert.equal(await placement.getAttribute('open'),'');
  await card.locator('[data-action=duplicate]').click();const duplicate=row.locator('[data-kind=sfx]').last();assert.equal(await duplicate.locator('[data-field=textOutlineColor]').inputValue(),'#a63870');await duplicate.locator('[data-action=drop-layer]').click();
  await page.selectOption('#projectFormat','json');let downloading=page.waitForEvent('download');await page.click('#projectSave');let download=await downloading;const project=JSON.parse(await readFile(await download.path(),'utf8'));
  assert.equal(project.pages[0].layers[0].textOutlineColor,'#a63870');assert.ok(Math.abs(project.pages[0].layers[0].outline-7)<1e-9);await page.waitForFunction(()=>!document.querySelector('#projectLoad').disabled);
  // Deselect the page before comparing preview with actual export (which has no selection handles).
  await page.evaluate(()=>document.querySelector('canvas.preview').focus());await page.keyboard.press('Escape');
  downloading=page.waitForEvent('download');await row.locator('[data-action=save-image]').click();download=await downloading;const png=(await readFile(await download.path())).toString('base64');
  const parity=await page.evaluate(async({project,png})=>{
    const {draw}=await import('./renderer.js'),{ImagePool}=await import('./bulk-pool.js');const img=await createImageBitmap(await (await fetch(project.pages[0].src)).blob()),canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;draw(canvas.getContext('2d'),img,project.pages[0].layers);
    const decode=async(blob)=>{const bitmap=await createImageBitmap(blob),c=document.createElement('canvas');c.width=800;c.height=600;c.getContext('2d').drawImage(bitmap,0,0);bitmap.close();return c.getContext('2d').getImageData(0,0,800,600).data;};
    const expected=canvas.getContext('2d').getImageData(0,0,800,600).data,actual=await decode(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const pool=new ImagePool({size:1});const blob=await pool.run('render-png',{blob:await (await fetch(project.pages[0].src)).blob(),width:800,height:600,layers:project.pages[0].layers},undefined,()=>{throw new Error('Worker unavailable');});const worker=await decode(blob);pool.close();img.close();
    return {exportDiff:expected.reduce((n,v,i)=>n+(v!==actual[i]),0),workerDiff:expected.reduce((n,v,i)=>n+(v!==worker[i]),0)};
  },{project,png});assert.deepEqual(parity,{exportDiff:0,workerDiff:0});
  await mkdir('artifacts',{recursive:true});await writeFile('artifacts/sfx-font-fallback.png',Buffer.from(rendering.png.split(',')[1],'base64'));delete rendering.png;
  await writeFile('artifacts/sfx-controls-project.json',JSON.stringify(project));await writeFile('artifacts/sfx-controls-results.json',JSON.stringify({numericPairs,rendering,parity},null,2));
  await page.waitForFunction(()=>!document.querySelector('#projectLoad').disabled);await page.screenshot({path:'artifacts/sfx-controls-desktop.png',fullPage:true});await page.setViewportSize({width:430,height:950});await page.screenshot({path:'artifacts/sfx-controls-mobile.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'sliders must fit mobile viewport');
  await page.reload();await page.locator('#projectInput').setInputFiles('artifacts/sfx-controls-project.json');await page.waitForFunction(()=>document.querySelector('.image-row')&&!document.querySelector('#projectLoad').disabled);
  assert.equal(await card.locator('[data-field=textOutlineColor]').inputValue(),'#a63870');assert.equal(await number('outline').inputValue(),'7');assert.deepEqual(errors,[]);
  console.log(`SFX controls browser smoke passed: ${numericPairs.length} numeric pairs, open details after regeneration/undo/presets, slider drag/arrows/direct input/undo, ${rendering.hearts.length} heart renders, caption fallback, colored outline persistence, mobile layout, PNG and actual Worker pixel difference 0.`);
}catch(error){if(page){await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/sfx-controls-failure.png',fullPage:true}).catch(()=>{});}throw error;}
finally{await browser?.close();server.kill();}
