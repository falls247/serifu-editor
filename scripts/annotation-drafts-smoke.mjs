import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {exportJson} from './sfx-test-support.mjs';
const {chromium}=createRequire(import.meta.url)('playwright');
const port=5324,server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','inherit']});
const annotations=[
  {type:'dialogue',speaker:'male',text:'こんにちは'},
  {type:'dialogue',speaker:'female',text:'おはよう\nございます'},
  {type:'caption',text:'翌朝'},
  {type:'sound_effect',text:'ドンッ'},
  {type:'speech_bubble',text:'それで？'},
];
const draft=(name,items=annotations)=>JSON.stringify({schemaVersion:1,imageFile:name,annotations:items,savedAt:'2026-10-13T21:00:00+09:00'});
const layerContents=layers=>layers.map(({id,...layer})=>layer);
let browser,folder;
try{
  await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',code=>reject(new Error(`server exited ${code}`)));});
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1920,height:1080}}),errors=[];
  context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  const newPage=async()=>{const page=await context.newPage();await page.goto(`http://localhost:${port}`);await page.uncheck('#autosaveEnabled');return page;};
  const ready=page=>page.waitForFunction(()=>!document.querySelector('#projectLoad').disabled);
  const openNative=async(page,entries)=>{
    await page.evaluate(entries=>{
      const files=entries.map(entry=>{
        const name=entry.name;
        return {kind:'file',name,getFile:async()=>{
          if(entry.error)throw new Error('下書き読取失敗');
          if(entry.text!==undefined)return new File([entry.text],name,{type:'application/json'});
          const canvas=document.createElement('canvas');canvas.width=entry.width||1000;canvas.height=entry.height||750;
          const ctx=canvas.getContext('2d');ctx.fillStyle='#506070';ctx.fillRect(0,0,canvas.width,canvas.height);
          const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
          return new File([blob],name,{type:'image/png'});
        }};
      });
      window.showDirectoryPicker=async()=>({name:'下書き画像',async *values(){yield*files;}});
    },entries);
    await page.click('#open');await ready(page);
  };
  const assertLayout=async(page,layers,width,height)=>{
    const measured=await page.evaluate(async({layers,width,height})=>{
      const {layerBounds,draw}=await import('/src/renderer.js');await document.fonts.ready;
      const pad=256,base=document.createElement('canvas'),canvas=document.createElement('canvas');
      base.width=canvas.width=width+pad*2;base.height=canvas.height=height+pad*2;
      const ctx=canvas.getContext('2d',{willReadFrequently:true});
      return layers.map(layer=>{
        const b=layerBounds(ctx,layer),bounds={left:layer.x+b.minX,right:layer.x+b.maxX,top:layer.y+b.minY,bottom:layer.y+b.maxY};
        draw(ctx,base,[{...layer,x:layer.x+pad,y:layer.y+pad}]);
        const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;let leaked=0;
        for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++)if(pixels[(y*canvas.width+x)*4+3]&&(x-pad<bounds.left-1||x-pad>bounds.right+1||y-pad<bounds.top-1||y-pad>bounds.bottom+1))leaked++;
        return {...bounds,leaked};
      });
    },{layers,width,height});
    for(const [i,b] of measured.entries()){
      assert.equal(b.leaked,0,`layer ${i} drawing stays inside measured bounds`);
      assert.ok(b.left>=0&&b.right<=width+.01&&b.top>=0&&b.bottom<=height+.01,`layer ${i} fits image`);
      for(const c of measured.slice(i+1))assert.ok(b.right<=c.left||c.right<=b.left||b.bottom<=c.top||c.bottom<=b.top,'objects do not overlap');
    }
    for(let i=1;i<measured.length;i++){
      const previous=measured[i-1],current=measured[i];
      assert.ok(current.top>previous.top+.01||current.right<previous.left,'array order proceeds left, then down');
    }
  };
  const page=await newPage();
  await page.evaluate(async()=>{
    const {PREFS_KEY,defaultPreferences,createPreset}=await import('/src/presets.js'),{newLayer}=await import('/src/renderer.js');
    const prefs=defaultPreferences();prefs.autosave.enabled=false;
    for(const kind of ['dialogue','caption','sfx','balloon']){
      const layer={...newLayer(kind,1000,750),font:'sans',w:240,h:260,size:38,rotation:kind==='sfx'?-17:12};
      if(kind==='balloon')Object.assign(layer,{tail:true,tailX:-100,tailY:200,shadowEnabled:true});
      if(kind==='sfx')Object.assign(layer,{effect:'speed',blur:2,motionBlur:12,blurY:6});
      if(kind==='caption')Object.assign(layer,{autoFit:false,textColor:'#2468aa',shape:'spiky',borderWidth:8});
      const preset=createPreset(`下書き ${kind}`,layer,1000,750);prefs.presets.push(preset);prefs.defaults[kind]=preset.id;
    }
    localStorage.setItem(PREFS_KEY,JSON.stringify(prefs));
  });
  await page.reload();
  await openNative(page,[{name:'img001.jpg.json',text:draft('img001.jpg')},{name:'img001.jpg'},{name:'img002.png'},{name:'img002.json',text:draft('img002.png')}]);
  assert.match(await page.locator('#status').textContent(),/下書き5件/);
  const project=await exportJson(page),layers=project.pages[0].layers;
  assert.deepEqual(layers.map(layer=>layer.kind),['dialogue','dialogue','caption','sfx','balloon']);
  assert.deepEqual(layers.map(layer=>layer.text),annotations.map(item=>item.text));
  assert.deepEqual(layers.slice(0,2).map(layer=>layer.speaker),['male','female']);
  assert.equal(layers[2].textColor,'#2468aa');assert.equal(layers[4].tail,true);assert.equal(layers[4].shadowEnabled,true);
  assert.ok(layers.every(layer=>layer.rotation!==0));
  assert.ok(layers.filter(layer=>layer.speaker!=='female').every(layer=>layer.presetId));
  assert.equal(project.pages[0].edited,true);assert.equal(project.pages[0].done,false);assert.equal(project.pages[1].layers.length,0);
  assert.equal(await page.locator('.image-row').first().locator('[data-action=undo]').isDisabled(),true);
  await assertLayout(page,layers,1000,750);
  await page.locator('.image-row').first().locator('[data-kind=dialogue] textarea').first().fill('取り込み後の編集');
  await page.locator('.image-row').first().locator('[data-action=undo]').click();
  assert.equal(await page.locator('.image-row').first().locator('[data-kind=dialogue] textarea').first().inputValue(),'こんにちは');
  await page.click('#temporarySave');await page.waitForFunction(()=>document.querySelector('#draftStatus').textContent.includes('保存済'));
  const stored=await page.evaluate(async id=>(await (await import('/src/project-history.js')).latestProjectSnapshot(id)).meta,project.projectId);
  assert.deepEqual(stored.pages[0].layers,layers);
  const restored=await newPage();
  await restored.locator('#projectInput').setInputFiles({name:'imported.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});await ready(restored);
  assert.deepEqual(layerContents((await exportJson(restored)).pages[0].layers),layerContents(layers),'JSON roundtrip preserves generated objects');
  const fast=await newPage();
  await page.selectOption('#projectFormat','serifu');const downloading=page.waitForEvent('download');await page.click('#projectSave');const file=await downloading;await ready(page);
  await fast.locator('#projectInput').setInputFiles(await file.path());await ready(fast);
  assert.deepEqual(layerContents((await exportJson(fast)).pages[0].layers),layerContents(layers),'fast project roundtrip preserves generated objects');

  const invalid=await newPage();
  await openNative(invalid,[
    {name:'01.png'},{name:'01.png.json',text:'{'},
    {name:'02.png'},{name:'02.png.json',text:draft('wrong.png')},
    {name:'03.png'},{name:'03.png.json',text:draft('03.png',[annotations[0],{type:'future',text:'不明'},annotations[2]])},
    {name:'04.png'},{name:'04.png.json',text:JSON.stringify({schemaVersion:2,imageFile:'04.png',annotations})},
    {name:'05.png'},{name:'05.png.json',error:true},
  ]);
  const warning=await invalid.locator('#status').textContent();
  for(const name of ['01.png.json','02.png.json','03.png.json','04.png.json','05.png.json'])assert.ok(warning.includes(name),`${name} warning`);
  assert.deepEqual((await exportJson(invalid)).pages.map(p=>p.layers.length),[0,0,2,0,0]);
  const fontFailure=await newPage();
  await fontFailure.evaluate(async()=>{
    const {PREFS_KEY}=await import('/src/presets.js'),prefs=JSON.parse(localStorage.getItem(PREFS_KEY));
    prefs.presets.find(p=>p.id===prefs.defaults.sfx).style.font='comic';localStorage.setItem(PREFS_KEY,JSON.stringify(prefs));
  });
  const fontSuccess=await newPage();
  await fontSuccess.evaluate(()=>{const load=document.fonts.load.bind(document.fonts);window.loadedDraftFonts=[];document.fonts.load=async query=>{const faces=await load(query);window.loadedDraftFonts.push(query);return faces;};});
  await openNative(fontSuccess,[{name:'loaded-font.png'},{name:'loaded-font.png.json',text:draft('loaded-font.png',[annotations[3]])}]);
  assert.ok(await fontSuccess.evaluate(()=>window.loadedDraftFonts.length>0),'bundled fonts are prepared before completing import');
  const fontLayers=(await exportJson(fontSuccess)).pages[0].layers;assert.equal(fontLayers.length,1);assert.equal(fontLayers[0].font,'comic');
  await assertLayout(fontSuccess,fontLayers,1000,750);
  await fontFailure.reload();await fontFailure.evaluate(()=>{document.fonts.load=async()=>{throw new Error('テスト書体読込失敗');};});
  await openNative(fontFailure,[{name:'font.png'},{name:'font.png.json',text:draft('font.png',[annotations[3]])}]);
  assert.match(await fontFailure.locator('#status').textContent(),/font.png.json.*書体読込失敗/);
  assert.equal((await exportJson(fontFailure)).pages[0].layers.length,0,'font failure keeps the image');
  // Restore shared preferences before creating subsequent pages.
  await fontFailure.evaluate(async()=>{
    const {PREFS_KEY}=await import('/src/presets.js'),prefs=JSON.parse(localStorage.getItem(PREFS_KEY));
    prefs.presets.find(p=>p.id===prefs.defaults.sfx).style.font='sans';localStorage.setItem(PREFS_KEY,JSON.stringify(prefs));
  });
  const dense=await newPage(),denseItems=Array.from({length:12},(_,i)=>({type:'dialogue',speaker:i%2?'female':'male',text:`「長めの下書き、${i+1}」\n改行も保持する。`}));
  await openNative(dense,[{name:'dense.png'},{name:'dense.png.json',text:draft('dense.png',denseItems)}]);
  const denseLayers=(await exportJson(dense)).pages[0].layers;
  assert.equal(denseLayers.length,12);assert.ok(denseLayers[0].size<38,'dense layout shrinks preset dimensions');
  await assertLayout(dense,denseLayers,1000,750);
  const tiny=await newPage();
  await openNative(tiny,[{name:'tiny.png',width:40,height:40},{name:'tiny.png.json',text:draft('tiny.png')}]);
  assert.match(await tiny.locator('#status').textContent(),/画像外/);
  const tinyProject=await exportJson(tiny);assert.equal(tinyProject.pages[0].layers.length,5);
  assert.ok(tinyProject.pages[0].layers.some(l=>l.y>40),'minimum layout continues below image');

  const fallback=await newPage();await fallback.evaluate(()=>{window.showDirectoryPicker=undefined;});
  folder=await mkdtemp(join(tmpdir(),'serifu-annotation-drafts-'));
  const png=Buffer.from(await fallback.evaluate(()=>{const c=document.createElement('canvas');c.width=1000;c.height=750;return c.toDataURL().split(',')[1];}),'base64');
  for(const [name,text] of [['a','同名画像A'],['b','同名画像B']]){
    const directory=join(folder,name);await mkdir(directory);
    await writeFile(join(directory,'same.png'),png);await writeFile(join(directory,'same.png.json'),draft('same.png',[{type:'dialogue',speaker:'male',text}]));
  }
  await fallback.locator('#folderInput').setInputFiles(folder);await ready(fallback);
  const fallbackProject=await exportJson(fallback);
  assert.deepEqual(fallbackProject.pages.map(p=>p.layers[0].text).sort(),['同名画像A','同名画像B']);
  const imageOnly=await newPage();
  await imageOnly.locator('#fileInput').setInputFiles([{name:'only.png',mimeType:'image/png',buffer:png},{name:'only.png.json',mimeType:'application/json',buffer:Buffer.from(draft('only.png'))}]);await ready(imageOnly);
  assert.equal((await exportJson(imageOnly)).pages[0].layers.length,0,'image-only input does not import JSON');
  assert.deepEqual(errors,[]);
  console.log('下書きJSON: フォルダAPI・代替入力・5種類・非重複描画・既定書式・異常入力・縮小限界・編集/保存/一時保存 PASS');
}finally{await browser?.close();server.kill('SIGTERM');if(folder)await rm(folder,{recursive:true,force:true});}
