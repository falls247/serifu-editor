import {waitForAsync} from './browser-wait.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {PROJECT_VERSION} from '../src/model.js';
const {chromium}=createRequire(import.meta.url)('playwright');
const port=5241,server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let browser,page;
try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server did not start')),10000);server.stdout.once('data',()=>{clearTimeout(timer);resolve();});server.once('error',reject);server.stderr.on('data',chunk=>process.stderr.write(chunk));});
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  const legacy=await page.evaluate(async()=>{
    const {newLayer}=await import('./src/renderer.js'),{encodeMask,maskBytesToBase64}=await import('./src/mask-codec.js'),{defaultMaskEffect}=await import('./src/model.js');
    const canvas=document.createElement('canvas');canvas.width=400;canvas.height=300;canvas.getContext('2d').fillStyle='rgb(30,80,140)';canvas.getContext('2d').fillRect(0,0,400,300);
    const masks=[],assets={};
    for(const [id,x,y,w,h] of [['A',80,70,200,160],['B',120,100,90,80]]){
      const bits=new Uint8Array(400*300);for(let row=y;row<y+h;row++)bits.fill(1,row*400+x,row*400+x+w);
      if(id==='A')for(let row=120;row<140;row++)bits.fill(0,row*400+180,row*400+200);
      const asset=await encodeMask(bits,400,300,{id:`asset-${id}`});assets[asset.id]={...asset,data:undefined,decoded:undefined,dataBase64:maskBytesToBase64(asset.data)};
      masks.push({...defaultMaskEffect(asset,{id,createdOrder:masks.length}),effect:id==='A'?'fill-black':'fill-white'});
    }
    const caption={...newLayer('caption',400,300),text:'',x:180,y:140,w:140,h:110,color:'#ff0000',transparency:0,borderWidth:0,rotation:0};
    const dialogue={...newLayer('dialogue',400,300),text:'D',x:40,y:260,w:50,h:50,size:24};
    return {version:12,pages:[{name:'mask-order.png',src:canvas.toDataURL(),imageWidth:400,imageHeight:300,layers:[caption,dialogue],maskEffects:masks,maskAssets:assets}]};
  });
  const load=async data=>{await page.locator('#projectInput').setInputFiles({name:'order.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===1&&!document.querySelector('#projectLoad').disabled);};
  await load(legacy);
  const row=page.locator('.image-row'),canvas=row.locator('canvas.preview'),mask=id=>row.locator(`.mask-effect-card[data-mask-id="${id}"]`);
  const order=()=>row.locator('.layer-cards').evaluate(node=>[...node.children].map(card=>card.dataset.maskId||card.dataset.kind));
  const select=async id=>{const card=mask(id);await card.locator('.mask-effect-summary:visible,.mask-effect-name:visible').click();};
  const act=action=>row.locator(`.position-controls [data-action=${action}]`).click();
  const pixel=(x=130,y=110)=>canvas.evaluate((node,{x,y})=>{const ratio=node.width/400;return [...node.getContext('2d').getImageData(Math.floor(x*ratio),Math.floor(y*ratio),1,1).data];},{x,y});
  assert.deepEqual(await order(),['A','B','caption','dialogue']);assert.deepEqual(await pixel(),[255,0,0,255],'legacy text remains in front');
  assert.equal(await mask('A').locator('.mask-effect-grid').isVisible(),false);
  await mask('A').locator('.mask-effect-summary').focus();assert.equal(await mask('A').locator('.mask-effect-grid').isVisible(),false,'tab focus does not expand a summary');await page.keyboard.press('Enter');
  assert.equal(await mask('A').locator('.mask-effect-grid').isVisible(),true);assert.equal(await row.locator('.layer-card.selected').count(),0);
  assert.equal(await row.locator('.position-controls>.control-grid').first().isVisible(),false,'text controls hide while a mask is selected');
  await act('forward');assert.deepEqual(await order(),['B','A','caption','dialogue']);
  await canvas.focus();await page.keyboard.press('h');assert.deepEqual(await order(),['B','caption','dialogue','A']);assert.deepEqual(await pixel(),[0,0,0,255],'H moves a selected mask in front of text');
  await page.keyboard.press('Control+z');assert.deepEqual(await order(),['B','A','caption','dialogue']);
  await page.keyboard.press('Control+Shift+z');assert.deepEqual(await order(),['B','caption','dialogue','A']);
  assert.deepEqual(await pixel(185,125),[255,0,0,255],'holes in the front mask retain lower objects');
  await mask('A').locator('[data-mask-field=effect]').selectOption('blur');
  await mask('A').locator('[data-mask-field=blurRadius]').fill('0');await mask('A').locator('[data-mask-field=blurRadius]').dispatchEvent('change');
  assert.deepEqual(await pixel(),[30,80,140,255],'front effects sample original pixels, including blur zero');
  await mask('A').locator('[data-mask-field=effect]').selectOption('fill-black');
  await row.locator('[data-action=undo]').click();assert.deepEqual(await pixel(),[30,80,140,255]);await row.locator('[data-action=redo]').click();assert.deepEqual(await pixel(),[0,0,0,255]);
  await act('backward');assert.deepEqual(await order(),['B','caption','A','dialogue']);
  await act('backmost');assert.deepEqual(await order(),['A','B','caption','dialogue']);assert.deepEqual(await pixel(),[255,0,0,255]);
  await row.locator('[data-action=undo]').click();assert.deepEqual(await order(),['B','caption','A','dialogue']);await row.locator('[data-action=redo]').click();
  await row.locator('.layer-card[data-kind=caption] .layer-summary').click();assert.equal(await mask('A').locator('.mask-effect-grid').isVisible(),false);assert.match(await mask('A').locator('.mask-effect-summary').innerText(),/黒塗り/);
  await act('backmost');assert.deepEqual(await order(),['caption','A','B','dialogue']);assert.deepEqual(await pixel(),[255,255,255,255],'text can move behind masks');
  await select('A');await mask('A').locator('[data-mask-action=frontmost]').click();assert.deepEqual(await order(),['caption','B','dialogue','A']);assert.deepEqual(await pixel(),[0,0,0,255]);
  await select('B');await act('frontmost');assert.deepEqual(await pixel(),[255,255,255,255],'mask overlap follows explicit order');
  const clickPosition=await canvas.evaluate(node=>({x:node.getBoundingClientRect().width*130/400,y:node.getBoundingClientRect().height*110/300}));await canvas.click({position:clickPosition});
  assert.equal(await row.locator('.mask-effect-card.selected').getAttribute('data-mask-id'),'B','canvas hit testing follows unified order');
  const save=async format=>{await page.selectOption('#projectFormat',format);const waiting=page.waitForEvent('download');await page.click('#projectSave');const result=await readFile(await (await waiting).path());await page.waitForFunction(()=>!document.querySelector('#projectLoad').disabled);return result;};
  const json=JSON.parse((await save('json')).toString());assert.equal(json.version,PROJECT_VERSION);assert.ok(json.pages[0].layers.every(layer=>Number.isInteger(layer.layoutOrder)));
  const expected=await page.evaluate(async record=>{const {draw}=await import('./src/renderer.js'),{assetFromEncoded}=await import('./src/mask-codec.js');const assets={};for(const [id,asset] of Object.entries(record.maskAssets))assets[id]=await assetFromEncoded(asset);const image=new Image();image.src=record.src;await image.decode();const output=document.createElement('canvas');output.width=400;output.height=300;draw(output.getContext('2d'),image,record.layers,null,1,1,null,null,{maskEffects:record.maskEffects,maskAssets:assets});return output.toDataURL();},json.pages[0]);
  const waiting=page.waitForEvent('download');await row.locator('[data-action=save-image]').click();const png=await readFile(await (await waiting).path());
  const actual=await page.evaluate(async base64=>{const image=new Image();image.src=`data:image/png;base64,${base64}`;await image.decode();const output=document.createElement('canvas');output.width=image.width;output.height=image.height;output.getContext('2d').drawImage(image,0,0);return output.toDataURL();},png.toString('base64'));
  assert.equal(actual,expected,'Worker PNG equals main renderer for interleaved text and masks');
  const rotations=await page.evaluate(async()=>{
    const {draw,newLayer}=await import('./src/renderer.js'),{imageMatrix}=await import('./src/image-edit.js');
    const {encodeMask}=await import('./src/mask-codec.js'),{defaultMaskEffect}=await import('./src/model.js');
    const {ImagePool}=await import('./src/bulk-pool.js'),{openFullPreview}=await import('./src/preview-modal.js');
    const source=document.createElement('canvas');source.width=12;source.height=10;const context=source.getContext('2d');context.fillStyle='rgb(30,80,140)';context.fillRect(0,0,12,10);context.clearRect(4,4,1,1);
    const bits=new Uint8Array(120);for(let y=3;y<7;y++)bits.fill(1,y*12+3,y*12+7);bits[4*12+5]=0;
    const asset=await encodeMask(bits,12,10),effect={...defaultMaskEffect(asset),effect:'blur',blurRadius:0,layoutOrder:1};
    const layers=[{...newLayer('caption',12,10),x:6,y:5,w:10,h:8,text:'',borderWidth:0,color:'#ff0000',transparency:0,layoutOrder:0}],assets={[asset.id]:asset};
    const pool=new ImagePool({size:1}),blob=await new Promise(resolve=>source.toBlob(resolve,'image/png')),results=[];
    try{for(const rotation of [0,90,180,270]){
      const imageEdit={rotation,crop:{x:2,y:2,width:8,height:6}},output=document.createElement('canvas');output.width=rotation%180?6:8;output.height=rotation%180?8:6;
      draw(output.getContext('2d'),source,layers,null,1,1,imageEdit,{width:12,height:10},{maskEffects:[effect],maskAssets:assets});
      const data=output.getContext('2d').getImageData(0,0,output.width,output.height).data,[a,b,c,d,e,f]=imageMatrix(12,10,imageEdit);
      const pixel=(x,y)=>{const px=Math.floor(a*(x+.5)+c*(y+.5)+e),py=Math.floor(b*(x+.5)+d*(y+.5)+f);return [...data.slice((py*output.width+px)*4,(py*output.width+px)*4+4)];};
      const png=await pool.run('render-png',{blob,width:12,height:10,layers,imageEdit,maskEffects:[effect],maskAssets:assets},undefined,()=>{throw new Error('Worker unavailable');});
      const bitmap=await createImageBitmap(png),worker=document.createElement('canvas');worker.width=bitmap.width;worker.height=bitmap.height;worker.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
      await openFullPreview({name:'mixed rotation',src:source.toDataURL(),img:{width:12,height:10},layers,imageEdit,maskEffects:[effect],maskAssets:assets},document.querySelector('[data-action=preview-full]'));
      const preview=document.querySelector('#fullPreviewCanvas'),previewData=preview.getContext('2d').getImageData(0,0,preview.width,preview.height).data;
      const workerData=worker.getContext('2d').getImageData(0,0,worker.width,worker.height).data;
      results.push({rotation,opaque:pixel(3,3),hole:pixel(5,4),transparent:pixel(4,4),workerMatches:data.every((value,index)=>value===workerData[index]),previewMatches:data.every((value,index)=>value===previewData[index]),workerDiff:[...data].findIndex((value,index)=>value!==workerData[index]),previewDiff:[...data].findIndex((value,index)=>value!==previewData[index])});
      await new Promise(resolve=>{document.querySelector('#fullPreview').addEventListener('close',resolve,{once:true});document.querySelector('#fullPreviewClose').click();});
    }}finally{pool.close();}
    return results;
  });
  for(const result of rotations){assert.deepEqual(result.opaque,[30,80,140,255],`original pixels above text at ${result.rotation}°`);assert.deepEqual(result.hole,[255,0,0,255]);assert.deepEqual(result.transparent,[0,0,0,0]);assert.ok(result.workerMatches&&result.previewMatches,`rotated Worker and full preview match: ${JSON.stringify(result)}`);}
  await page.waitForFunction(()=>!document.querySelector('#projectLoad').disabled);await page.click('#temporarySave');
  await waitForAsync(page,async version=>{const {getDraftMeta}=await import('./src/storage.js');return (await getDraftMeta())?.version===version;},PROJECT_VERSION);
  await page.reload();await page.waitForSelector('#draftNotice:not([hidden])');await page.click('#restoreDraft');await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===1&&!document.querySelector('#projectLoad').disabled);
  const final=['caption','dialogue','A','B'];assert.deepEqual(await order(),final);assert.deepEqual(await pixel(),[255,255,255,255]);
  await page.reload();await load(json);assert.deepEqual(await order(),final);assert.deepEqual(await pixel(),[255,255,255,255]);
  const binary=await save('serifu');await page.reload();await page.locator('#projectInput').setInputFiles({name:'order.serifu',mimeType:'application/octet-stream',buffer:binary});await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===1&&!document.querySelector('#projectLoad').disabled);assert.deepEqual(await order(),final);assert.deepEqual(await pixel(),[255,255,255,255]);
  await page.setViewportSize({width:390,height:844});await select('A');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);console.log('Mask order browser smoke PASS: compact selection, mixed stacking, original pixels, holes, both directions/endpoints, undo/redo, hit testing, Worker PNG, JSON/container/draft and mobile.');
}catch(error){if(page){await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/mask-order-failure.png',fullPage:true}).catch(()=>{});}throw error;}
finally{await browser?.close();server.kill();}
