import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
const {chromium}=createRequire(import.meta.url)('playwright');
async function withDeadline(operation,label){
 let timer;
 try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' did not finish within 30000ms')),30000);})]);}
 finally{clearTimeout(timer);}
}
export async function sfxTest(port,fn,{engine=chromium,onStage=()=>{}}={}){
 const server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','inherit']});
 let browser;
 try{
  await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',code=>reject(new Error('server exited '+code)));});
  onStage('server ready');
  browser=await engine.launch({headless:true});
  onStage('browser ready');
  const context=await browser.newContext({viewport:{width:1440,height:1080},acceptDownloads:true}),page=await withDeadline(context.newPage(),engine.name()+' page creation'),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://localhost:${port}`);
  onStage('app loaded');
  await page.uncheck('#autosaveEnabled');
  const buffer=Buffer.from(await page.evaluate(()=>{
   const c=document.createElement('canvas');c.width=1000;c.height=750;
   const ctx=c.getContext('2d');ctx.fillStyle='#899099';ctx.fillRect(0,0,c.width,c.height);
   return c.toDataURL().split(',')[1];
  }),'base64');
  onStage('fixture PNG ready');
  await page.locator('#fileInput').setInputFiles({name:'sfx.png',mimeType:'image/png',buffer});
  await page.waitForFunction(()=>document.querySelector('.image-row')&&!document.querySelector('#projectLoad').disabled);
  onStage('image loaded');
  const row=page.locator('.image-row').first();
  await row.locator('[data-action=add-sfx]').click();
  const card=row.locator('[data-kind=sfx]');
  await card.locator('textarea').fill('ザーーーーッ');
  for(const [field,value] of Object.entries({x:500,y:350,w:800,h:600,size:80,rotation:0})){
   const input=row.locator(`.position-controls [data-field=${field}]`);await input.fill(String(value));await input.press('Tab');
  }
  await row.locator('.position-controls [data-field=vertical]').selectOption('false');
  await card.locator('[data-action=sfx-glyph-enter]').click();
  onStage('SFX editor ready');
  await fn({page,row,card,browser,buffer,errors});
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();server.kill('SIGTERM');}
}
export async function exportJson(page){await page.selectOption('#projectFormat','json');const pending=page.waitForEvent('download');await page.click('#projectSave');const file=await pending;await page.waitForFunction(()=>!document.querySelector('#projectLoad').disabled);return JSON.parse(await readFile(await file.path(),'utf8'));}
export async function exportPng(page,row){const pending=page.waitForEvent('download');await row.locator('[data-action=save-image]').click();const file=await pending;await page.waitForFunction(()=>!document.querySelector('#projectLoad').disabled);return (await readFile(await file.path())).toString('base64');}
export async function pointPosition(page,layer,point){return page.locator('canvas.preview').first().evaluate((canvas,{layer,point})=>{const b=canvas.getBoundingClientRect(),a=layer.rotation*Math.PI/180;return {x:b.x+(layer.x+point.x*Math.cos(a)-point.y*Math.sin(a))*b.width/1000,y:b.y+(layer.y+point.x*Math.sin(a)+point.y*Math.cos(a))*b.height/750};},{layer,point});}
export async function assertPng(page,project,png){assert.equal(await page.evaluate(async({project,png})=>{const {draw}=await import('/src/renderer.js'),{normalizeLayers}=await import('/src/model.js');const p=project.pages[0],image=new Image();image.src=p.src;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;draw(c.getContext('2d'),image,normalizeLayers(p.layers,14),null,1,1,p.imageEdit,image,{maskEffects:p.maskEffects,maskAssets:{}});const output=new Image();output.src='data:image/png;base64,'+png;await output.decode();if(output.width!==1000||output.height!==750)return false;const other=document.createElement('canvas');other.width=1000;other.height=750;other.getContext('2d').drawImage(output,0,0);const a=c.getContext('2d').getImageData(0,0,1000,750).data,b=other.getContext('2d').getImageData(0,0,1000,750).data;return a.every((n,i)=>n===b[i]);},{project,png}),true,'PNG matches final shared Canvas renderer');}
