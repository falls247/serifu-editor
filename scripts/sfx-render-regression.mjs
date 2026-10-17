import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {sfxTest} from './sfx-test-support.mjs';
const baseline=await readFile('test/fixtures/legacy-renderer.txt','utf8');
const sourceRenderer=await readFile('test/fixtures/source-renderer-c53be9c.txt','utf8');
const sourceInk=await readFile('test/fixtures/source-ink-c53be9c.txt','utf8');
await sfxTest(5288,async({page})=>{
 await page.route('**/source-ink.js',route=>route.fulfill({contentType:'application/javascript',body:sourceInk}));
 await page.route('**/legacy-reference.js',route=>route.fulfill({contentType:'application/javascript',body:baseline.replaceAll("from './","from '/src/")}));
 await page.route('**/source-reference.js',route=>route.fulfill({contentType:'application/javascript',body:sourceRenderer.replaceAll("from './ink.js'","from '/source-ink.js'").replaceAll("from './","from '/src/")}));
 const results=await page.evaluate(async()=>{
  const current=await import('/src/renderer.js'),legacy=await import('/legacy-reference.js'),source=await import('/source-reference.js'),{startLettering}=await import('/src/sfx-lettering-model.js'),{fontLoadQueries}=await import('/src/fonts.js');
  const image=document.createElement('canvas');image.width=1000;image.height=750;image.getContext('2d').fillStyle='#556677';image.getContext('2d').fillRect(0,0,1000,750);
  let legacyPixelCases=0,sourcePixelCases=0;
  const compare=async(layer,label,reference=legacy)=>{
   for(const q of fontLoadQueries(layer))await document.fonts.load(q);
   current.clearGlyphCache();reference.clearGlyphCache();
   const a=document.createElement('canvas'),b=document.createElement('canvas');a.width=b.width=1000;a.height=b.height=750;
   current.draw(a.getContext('2d'),image,[layer],null);reference.draw(b.getContext('2d'),image,[layer],null);
   const pixels=a.getContext('2d').getImageData(0,0,1000,750).data,old=b.getContext('2d').getImageData(0,0,1000,750).data;
   if(!pixels.every((v,i)=>v===old[i]))throw Error((reference===legacy?'legacy':'source')+' pixel regression '+label);
   if(reference===legacy)legacyPixelCases++;else sourcePixelCases++;
  };
  for(const vertical of [true,false])for(const font of ['comic','gekifude','sans'])for(const effect of ['none','taper','impact','rumble']){
   const layer={...current.newLayer('sfx',1000,750),text:'ドンッ\nザーー！',x:500,y:350,w:800,h:600,size:70,rotation:15,vertical,font,effect,glyphSeed:123,textureSeed:456,inkTexture:'grunge'};
   await compare(layer,[vertical,font,effect]);
  }
  for(const vertical of [true,false])for(const [label,props] of [
   ['thickness-expand',{thickness:3.5}],['thickness-erode',{thickness:-2}],
   ['directional-blur',{blurX:8,blurY:12,blurStrength:210}],
   ['grunge-brush',{inkTexture:'grunge',grungeAmount:70,scratchLength:60,scratchAngle:90,spatterAmount:35,roughness:55,dryInk:70,brushTails:80,outline:14}],
  ]){
   const layer={...current.newLayer('sfx',1000,750),text:'ドンッ\nザーー！',x:500,y:350,w:800,h:600,size:70,rotation:15,vertical,font:'comic',effect:'impact',glyphSeed:123,textureSeed:456,...props};
   await compare(layer,[vertical,label],source);
  }
  for(const vertical of [true,false]){
   const layer={...current.newLayer('sfx',1000,750),text:'ゴゴゴッ!!',x:500,y:350,w:800,h:600,size:70,rotation:0,vertical,font:'comic',effect:'tension',outline:10,roughness:35,dryInk:55,brushTails:45,blurX:6,blurY:9,glyphSeed:123,textureSeed:456};
   layer.lettering=startLettering(layer);layer.lettering.glyphs[1].dx=7;layer.lettering.glyphs[2].rotation=9;layer.lettering.glyphs[3].overrides.fill='#8d2446';
   await compare(layer,[vertical,'edited-lettering'],source);
  }
  const expected=[0,1,3,4,7];
  for(const vertical of [true,false])for(const optical of [false,true]){
   const l={...current.newLayer('sfx',1000,750),text:'ドド\nガ👨‍👩‍👧‍👦\n\nッ',size:60,w:130,h:150,vertical,kerningMode:optical?'optical':'standard',kerningStrength:optical?70:0};l.lettering=startLettering(l);
   const items=current.sfxScene(image.getContext('2d'),l).glyphs;if(JSON.stringify(items.map(g=>g.index))!==JSON.stringify(expected))throw Error('source grapheme mapping mismatch');
  }
  const layer={...current.newLayer('sfx',1000,750),text:'ボコボコボコボコボコボコ',x:500,y:350,w:800,h:600,size:65,rotation:0,vertical:false};layer.lettering=startLettering(layer);layer.lettering.outlineMode='union';
  const canvas=document.createElement('canvas');canvas.width=1000;canvas.height=750;current.draw(canvas.getContext('2d'),image,[layer],null);
  const timings=[];for(let i=0;i<30;i++){layer.lettering.glyphs[0].dx=i;const start=performance.now();current.draw(canvas.getContext('2d'),image,[layer],null);timings.push(performance.now()-start);}
  timings.sort((a,b)=>a-b);return {legacyPixelCases,sourcePixelCases,sourceIndexCases:4,performance:{samples:30,characters:12,image:'1000x750',meanMs:timings.reduce((s,t)=>s+t,0)/timings.length,p95Ms:timings[Math.floor(timings.length*.95)],browser:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency}};
 });assert.equal(results.legacyPixelCases,24);assert.equal(results.sourcePixelCases,10);await mkdir('artifacts',{recursive:true});await writeFile('artifacts/sfx-validation.json',JSON.stringify(results,null,2));console.log('SFX legacy/source pixels, source indices, and drag redraw benchmark PASS:',JSON.stringify(results));
});
