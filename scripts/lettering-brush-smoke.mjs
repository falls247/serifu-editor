import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
const port=5206,server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let browser,page;
try {
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('server timeout')),10000);server.stdout.once('data',()=>{clearTimeout(timer);resolve();});server.once('error',reject);});
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1100}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${port}`);await page.uncheck('#autosaveEnabled');
  const result=await page.evaluate(async()=>{
    const {newLayer,draw,textGlyphs,clearGlyphCache}=await import('./renderer.js'),{glyphBounds,layoutCacheStats}=await import('./glyph-layout.js'),{paintBalloon}=await import('./balloons.js'),{clearBrushCache,brushCacheStats}=await import('./brush-stroke.js'),{fontDescription}=await import('./fonts.js');
    const fontLayers=['comic','brush','chikara','sans'].map(font=>({...newLayer('sfx',1000,750),font}));await Promise.all(fontLayers.map(l=>fontDescription(l).load).filter(Boolean).map(query=>document.fonts.load(query)));clearGlyphCache();
    const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=1150;const ctx=canvas.getContext('2d'),bg=document.createElement('canvas');bg.width=1200;bg.height=1150;const bc=bg.getContext('2d');bc.fillStyle='#efece5';bc.fillRect(0,0,1200,1150);
    const l={...newLayer('sfx',1200,1150),text:'ドカーン！',size:100,w:1080,h:220,x:600,y:130,rotation:0,effect:'none',outline:0,distortion:0,skew:0,sizeVariation:0,horizontalJitter:0,roughness:0,dryInk:0,brushTails:0,glyphSeed:123,kerningMode:'optical'};
    const lengths=[10,40,70,100].map(kerningStrength=>glyphBounds(textGlyphs(ctx,{...l,vertical:false,kerningStrength})).width);
    const verticalLengths=[10,40,70,100].map(kerningStrength=>glyphBounds(textGlyphs(ctx,{...l,w:240,h:1100,vertical:true,kerningStrength})).height);
    const pixelDiff=(a,b)=>a.reduce((sum,v,i)=>sum+(v!==b[i]),0),pixels=()=>new Uint8ClampedArray(ctx.getImageData(0,0,1200,1150).data);
    const render=layers=>{draw(ctx,bg,layers);return pixels();};
    const zero=render([{...l,vertical:false,kerningStrength:0}]);const standard=render([{...l,vertical:false,kerningStrength:0,kerningMode:'standard'}]);
    const jitter={...l,vertical:false,kerningStrength:85,rotationJitter:18,verticalJitter:8,spacingJitter:10,horizontalJitter:12,sizeVariation:15,distortion:30,skew:20},first=render([jitter]),fixed=render([jitter]);
    clearGlyphCache();const coldFixed=render([jitter]);
    const seedChange=pixelDiff(first,render([{...jitter,glyphSeed:124}]));
    const rows=[];
    for(let i=0;i<3;i++)rows.push({...l,vertical:false,y:130+i*170,kerningStrength:i?85:0,...(i===2?{rotationJitter:18,verticalJitter:8,spacingJitter:12,horizontalJitter:10,sizeVariation:15}:{}),text:'ドカーン！'});
    const lettering=render(rows);const letteringPreview=canvas.toDataURL();
    const bodies=[];for(let row=0;row<4;row++)for(let col=0;col<3;col++){
      const layer=newLayer(row===3?'caption':'balloon',1200,1150);
      bodies.push({...layer,x:210+col*390,y:155+row*280,w:270,h:170,rotation:0,shape:row===0?'ellipse':row===1?'distorted-rect':row===2?'spiky':'rect',shapeSeed:123,brushSeed:123,tail:row<3,tailX:95,tailY:120,tailAngle:65,tailWidth:35,borderWidth:8,text:row===3?'手描きの枠線':'筆圧と掠れ',size:25,font:'sans',vertical:false,color:'#ffffff',transparency:35,shadowEnabled:row===1,shadowBlur:12,shadowOffsetX:7,shadowOffsetY:8,borderStyle:col===0?'solid':col===1?'brush':'dry-brush',brushRoughness:col===1?25:65,brushPressureVariation:col===1?35:80,brushTexture:col===1?15:85,brushOpacityVariation:col===1?10:35});
    }
    render(bodies);const brushPreview=canvas.toDataURL();
    const b={...bodies[1],x:600,y:400,text:'',tail:true,transparency:100};
    const brush=render([b]),pressureChange=pixelDiff(brush,render([{...b,brushPressureVariation:0}])),textureChange=pixelDiff(brush,render([{...b,brushTexture:95}])),opacityChange=pixelDiff(brush,render([{...b,brushOpacityVariation:90}])),roughnessChange=pixelDiff(brush,render([{...b,brushRoughness:100}]));
    const caption={...b,kind:'caption',shape:'spiky',autoFit:false,padding:0,textOutlineWidth:0,alignX:'center',alignY:'center'},captionChange=pixelDiff(render([caption]),render([{...caption,borderStyle:'solid'}]));
    const html=document.createElement('canvas');html.width=html.height=700;const hc=html.getContext('2d');hc.translate(350,350);hc.globalAlpha=.35;paintBalloon(hc,b);const hp=hc.getImageData(0,0,700,700).data;
    const off=new OffscreenCanvas(700,700),oc=off.getContext('2d');oc.translate(350,350);oc.globalAlpha=.35;paintBalloon(oc,b);let maxAlpha=0;for(let i=3;i<hp.length;i+=4)maxAlpha=Math.max(maxAlpha,hp[i]);
    const workerDiff=pixelDiff(hp,oc.getImageData(0,0,700,700).data);
    // Each font/script, punctuation, empty line, taper and transformed letter must remain finite.
    let fixtureCount=0;for(const font of ['comic','brush','chikara','sans'])for(const vertical of [true,false])for(const size of [8,36,180,500]){
      const test={...jitter,font,vertical,size,w:600,h:1000,text:'漢字あいうカタカナABC123、。ー「」\nシュッ\n\n',effect:'taper',taperRate:6,outline:2,stretchX:130,stretchY:90};
      const glyphs=textGlyphs(ctx,test);if(!glyphs.every(g=>Number.isFinite(g.x+g.y+g.size)))throw new Error('non-finite glyph');render([test]);fixtureCount++;
    }
    const perf=document.createElement('canvas');perf.width=2000;perf.height=3000;const pc=perf.getContext('2d'),background=new OffscreenCanvas(2000,3000),letters=Array.from({length:10},(_,i)=>({...jitter,x:300+(i%3)*600,y:300+Math.floor(i/3)*700,size:100,w:520,h:600,vertical:true}));
    const time=fn=>{const start=performance.now();fn();return performance.now()-start;},cold=time(()=>{clearGlyphCache();draw(pc,background,letters);}),analysisBefore=layoutCacheStats().profileAnalyses,warm=Array.from({length:12},()=>time(()=>draw(pc,background,letters))).sort((a,b)=>a-b),analysisAfter=layoutCacheStats().profileAnalyses;
    const brushCold=time(()=>{clearBrushCache();render(bodies);}),brushWarm=Array.from({length:12},()=>time(()=>render(bodies))).sort((a,b)=>a-b);
    return {lengths,verticalLengths,zeroDiff:pixelDiff(zero,standard),fixedDiff:pixelDiff(first,fixed),coldFixedDiff:pixelDiff(first,coldFixed),seedChange,pressureChange,textureChange,opacityChange,roughnessChange,captionChange,workerDiff,maxAlpha,fixtureCount,letteringPreview,brushPreview,perf:{cold,warmMedian:warm[6],warmP95:warm[11],brushCold,brushWarmMedian:brushWarm[6],brushWarmP95:brushWarm[11],brushCache:brushCacheStats(),analysisBefore,analysisAfter}};
  });
  await mkdir('artifacts',{recursive:true});for(const [key,name] of [['letteringPreview','lettering-layout-comparison.png'],['brushPreview','brush-outline-comparison.png']]){await writeFile('artifacts/'+name,Buffer.from(result[key].split(',')[1],'base64'));delete result[key];}
  for(const lengths of [result.lengths,result.verticalLengths])assert.ok(lengths.every((length,i)=>!i||length<lengths[i-1]),'stronger optical kerning must shorten ink occupancy');
  assert.equal(result.zeroDiff,0);assert.equal(result.fixedDiff,0);assert.equal(result.coldFixedDiff,0);assert.equal(result.workerDiff,0);assert.ok(result.maxAlpha<=90);assert.equal(result.perf.analysisBefore,result.perf.analysisAfter,'warm frames reuse contour profiles');
  for(const key of ['seedChange','pressureChange','textureChange','opacityChange','roughnessChange','captionChange'])assert.ok(result[key]>100,key+' must visibly affect pixels');
  await writeFile('artifacts/lettering-brush-results.json',JSON.stringify(result,null,2));

  // Actual editing, seeds, presets, undo, both project formats, preview and PNG.
  const images=await page.evaluate(()=>[[1200,950],[600,1300]].map(([w,h])=>{const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').fillRect(0,0,w,h);return c.toDataURL().split(',')[1];}));
  await page.locator('#fileInput').setInputFiles(images.map((base64,i)=>({name:`test-${i}.png`,mimeType:'image/png',buffer:Buffer.from(base64,'base64')})));
  await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===2&&!document.querySelector('#projectLoad').disabled);
  const source=page.locator('.image-row').first();await source.locator('[data-action=add-sfx]').click();let sfx=source.locator('[data-kind=sfx]');await sfx.locator('.placement-settings summary').click();
  await sfx.locator('[data-field=kerningMode]').selectOption('optical');await sfx.locator('[data-field=kerningStrength]').fill('90');await sfx.locator('[data-field=rotationJitter]').fill('15');await sfx.locator('[data-field=glyphSeed]').fill('1234');await sfx.locator('textarea').fill('ドカーン！');await sfx.locator('[data-action=regenerate-placement]').click();
  const newSeed=await source.locator('[data-kind=sfx] [data-field=glyphSeed]').inputValue();assert.notEqual(newSeed,'1234');
  await source.locator('canvas').focus();await page.keyboard.press('Control+z');assert.equal(await source.locator('[data-kind=sfx] [data-field=glyphSeed]').inputValue(),'1234');await page.keyboard.press('Control+Shift+z');assert.equal(await source.locator('[data-kind=sfx] [data-field=glyphSeed]').inputValue(),newSeed);
  await source.locator('[data-action=add-caption]').click();const caption=source.locator('[data-kind=caption]');await caption.locator('textarea').fill('筆圧のある枠線');await caption.locator('.brush-settings summary').click();await caption.locator('[data-field=borderStyle]').selectOption('dry-brush');await caption.locator('[data-field=brushTexture]').fill('80');await caption.locator('[data-field=brushSeed]').fill('0');
  page.once('dialog',dialog=>dialog.accept('手描きテスト'));await caption.locator('[data-action=save-preset]').click();
  const preset=await source.locator('[data-kind=caption] [data-preset-select]').inputValue();assert.ok(preset);
  await source.locator('[data-action=copy-all]').click();await page.waitForFunction(()=>!document.querySelector('#projectLoad').disabled);await page.locator('.image-row').nth(1).locator('canvas').focus();await page.locator('.image-row').nth(1).locator('[data-action=paste-all]').click();await page.waitForFunction(()=>!document.querySelector('#projectLoad').disabled);assert.equal(await page.locator('.image-row').nth(1).locator('[data-kind=caption] [data-field=brushSeed]').inputValue(),'0');
  await page.evaluate(async()=>{const {fontDescription}=await import('./fonts.js');await document.fonts.load(fontDescription({kind:'sfx',font:'comic'}).load);});await page.locator('.image-row').nth(1).locator('canvas').focus();
  const preview=await source.locator('canvas').evaluate(c=>c.toDataURL());let downloading=page.waitForEvent('download');await source.locator('[data-action=save-image]').click();const png=await downloading;
  const exported=await page.evaluate(async base64=>{const image=new Image();image.src='data:image/png;base64,'+base64;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;c.getContext('2d').drawImage(image,0,0);return c.toDataURL();},(await readFile(await png.path())).toString('base64'));
  await page.selectOption('#projectFormat','json');downloading=page.waitForEvent('download');await page.click('#projectSave');const project=JSON.parse(await readFile(await (await downloading).path(),'utf8'));
  assert.equal(project.version,9);assert.equal(project.pages[0].layers[0].glyphSeed,Number(newSeed));assert.equal(project.pages[0].layers[1].brushSeed,0);assert.equal(project.pages[0].layers[1].brushTexture,80);
  const expected=await page.evaluate(async project=>{const {draw}=await import('./renderer.js'),image=new Image();image.src=project.pages[0].src;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;draw(c.getContext('2d'),image,project.pages[0].layers);return c.toDataURL();},project);assert.equal(expected,exported,'same full-resolution preview and PNG pixels');assert.equal(preview,exported,'actual app preview matches PNG');
  const workerPNG=await page.evaluate(async project=>{
    const {ImagePool}=await import('./bulk-pool.js'),pool=new ImagePool(),blob=await (await fetch(project.pages[0].src)).blob();
    try{const rendered=await pool.run('render-png',{blob,width:1200,height:950,layers:project.pages[0].layers},null,()=>{throw new Error('new rendering must succeed in Worker');});
      const image=new Image();image.src=URL.createObjectURL(rendered);await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;c.getContext('2d').drawImage(image,0,0);URL.revokeObjectURL(image.src);return c.toDataURL();
    }finally{pool.close();}
  },project);assert.equal(workerPNG,exported,'actual Worker PNG matches main and preview');result.actualWorkerPNGDiff=0;
  await page.selectOption('#projectFormat','serifu');downloading=page.waitForEvent('download');await page.click('#projectSave');const binary=await readFile(await (await downloading).path());await writeFile('artifacts/lettering-brush.serifu',binary);await writeFile('artifacts/lettering-brush.json',JSON.stringify(project));
  await page.click('#temporarySave');await page.waitForFunction(async()=>{const {getDraftMeta}=await import('./storage.js');return (await getDraftMeta())?.pages[0].layers[1].brushSeed===0;});
  await page.reload();await page.click('#restoreDraft');await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===2&&!document.querySelector('#projectLoad').disabled);assert.equal(await source.locator('[data-kind=sfx] [data-field=rotationJitter]').inputValue(),'15');assert.equal(await source.locator('[data-kind=caption] [data-field=brushTexture]').inputValue(),'80');
  await page.locator('#projectInput').setInputFiles('artifacts/lettering-brush.serifu');await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===4&&!document.querySelector('#projectLoad').disabled);
  await page.setViewportSize({width:430,height:900});await source.locator('[data-kind=caption] .layer-summary').click();await source.locator('[data-kind=caption] .brush-settings').evaluate(d=>d.open=true);await page.screenshot({path:'artifacts/lettering-brush-mobile.png',fullPage:true});assert.deepEqual(errors,[]);
  await writeFile('artifacts/lettering-brush-results.json',JSON.stringify(result,null,2));console.log('Lettering/brush browser smoke passed:',JSON.stringify(result));
}catch(error){await page?.screenshot({path:'artifacts/lettering-brush-failure.png',fullPage:true}).catch(()=>{});throw error;}
finally{await browser?.close();server.kill();}
