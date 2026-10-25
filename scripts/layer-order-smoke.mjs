import {waitForAsync} from './browser-wait.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {PROJECT_VERSION} from '../src/model.js';
const {chromium}=createRequire(import.meta.url)('playwright');
const port=5208,server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
let browser,page;
try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server did not start')),10000);server.stdout.once('data',()=>{clearTimeout(timer);resolve();});server.once('error',reject);server.stderr.on('data',chunk=>process.stderr.write(chunk));});
  browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  const legacy=await page.evaluate(async()=>{
    const {newLayer}=await import('./src/renderer.js');
    const image=document.createElement('canvas');image.width=400;image.height=300;const ctx=image.getContext('2d');ctx.fillStyle='#0000c8';ctx.fillRect(0,0,400,300);
    const balloon={...newLayer('balloon',400,300),shape:'ellipse',x:200,y:150,w:180,h:180,transparency:0,borderWidth:0,sfxOrder:'above'};
    const sfx={...newLayer('sfx',400,300),text:'H',x:200,y:150,w:120,h:120,size:80,outline:0,font:'sans',vertical:false,color:'#ff0000',effect:'tension',rotation:0,skew:0,distortion:0};
    const dialogue={...newLayer('dialogue',400,300),text:'D',x:40,y:40,w:60,h:60,size:24};
    const caption={...newLayer('caption',400,300),text:'C',x:350,y:40,w:60,h:60,size:24};
    return {version:10,pages:[{name:'overlap.png',src:image.toDataURL(),layers:[dialogue,balloon,sfx,caption]}]};
  });
  const load=async data=>{
    await page.locator('#projectInput').setInputFiles({name:'layers.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
    await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===1&&!document.querySelector('#projectLoad').disabled);
    await page.evaluate(()=>document.fonts.ready);
  };
  await load(legacy);
  const row=page.locator('.image-row'),canvas=row.locator('canvas.preview'),card=kind=>row.locator(`.layer-card[data-kind=${kind}]`);
  const order=()=>row.locator('.layer-card').evaluateAll(cards=>cards.map(card=>card.dataset.kind));
  const select=(kind,options)=>card(kind).locator('.layer-summary:visible,.kind-label:visible').first().click(options);
  const act=action=>row.locator(`.position-controls [data-action=${action}]`).click();
  const shortcut=async key=>{await canvas.focus();await page.keyboard.press(key);};
  const redCount=()=>canvas.evaluate(canvas=>{const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let count=0;for(let i=0;i<data.length;i+=4)if(data[i]===255&&data[i+1]===0&&data[i+2]===0)count++;return count;});
  assert.deepEqual(await order(),['sfx','balloon','dialogue','caption'],'legacy effective order is migrated');
  assert.equal(await row.locator('[data-field=sfxOrder]').count(),0);
  assert.equal(await redCount(),0,'legacy front balloon still covers SFX');
  await select('sfx');await act('forward');
  assert.deepEqual(await order(),['balloon','sfx','dialogue','caption']);assert.ok(await redCount()>100,'forward exposes SFX over balloon');
  await row.locator('[data-action=undo]').click();assert.equal(await redCount(),0);
  await row.locator('[data-action=redo]').click();assert.ok(await redCount()>100);
  await select('balloon');
  await canvas.scrollIntoViewIfNeeded();let bounds=await canvas.boundingBox();
  await page.mouse.click(bounds.x+bounds.width*.5,bounds.y+bounds.height*.5);
  assert.equal(await row.locator('.layer-card.selected').getAttribute('data-kind'),'sfx','hit testing follows visible stacking');
  await act('backward');assert.equal(await redCount(),0);
  await select('balloon');await act('backward');assert.ok(await redCount()>100,'balloon moves below SFX with the same control');
  await select('sfx');await act('frontmost');
  assert.deepEqual(await order(),['balloon','dialogue','caption','sfx']);
  await act('backmost');await act('backmost');assert.deepEqual(await order(),['sfx','balloon','dialogue','caption']);
  await row.locator('[data-action=undo]').click();assert.deepEqual(await order(),['balloon','dialogue','caption','sfx'],'no-op at boundary does not create history');
  await select('balloon');
  await select('sfx',{modifiers:['Shift']});await act('backmost');
  assert.deepEqual(await order(),['balloon','sfx','dialogue','caption']);assert.equal(await row.locator('.multi-selected').count(),2);
  await row.locator('[data-action=undo]').click();assert.deepEqual(await order(),['balloon','dialogue','caption','sfx']);
  for(const kind of ['dialogue','sfx','balloon','caption']){
    const initial=await order();await select(kind);await act('backmost');
    const before=await order(),expected=[...before.filter(item=>item!==kind),kind];
    await shortcut('h');assert.deepEqual(await order(),expected,`${kind}: H moves the selected object to the front`);
    assert.equal(await card(kind).evaluate(node=>node.classList.contains('selected')),true,'H preserves selection');
    await shortcut('h');await shortcut('Control+z');assert.deepEqual(await order(),before,'repeating H at the front adds no history');
    await shortcut('Control+Shift+z');assert.deepEqual(await order(),expected,'redo restores the frontmost order');
    await shortcut('Control+z');
    if(initial[0]!==kind)await shortcut('Control+z');
  }
  await select('balloon');await select('sfx',{modifiers:['Shift']});
  const beforeGroup=await order(),group=beforeGroup.filter(kind=>['balloon','sfx'].includes(kind));
  await row.locator('[data-action=preview-focus]').click();
  await shortcut('Shift+H');
  assert.deepEqual(await order(),[...beforeGroup.filter(kind=>!group.includes(kind)),...group],'H preserves relative order of multiple objects in live FOCUS');
  assert.equal(await row.locator('.layer-card.multi-selected').count(),2,'H preserves multiple selection');
  await shortcut('Control+z');assert.deepEqual(await order(),beforeGroup);
  await row.locator('[data-action=preview-focus]').click();
  await select('sfx');await act('frontmost');
  // Save through the UI, then compare PNG output with the common renderer without selection handles.
  await page.selectOption('#projectFormat','json');let downloading=page.waitForEvent('download');await page.click('#projectSave');
  const project=JSON.parse(await readFile(await (await downloading).path(),'utf8'));
  assert.equal(project.version,PROJECT_VERSION);assert.deepEqual(project.pages[0].layers.map(layer=>layer.kind),await order());
  assert.ok(project.pages[0].layers.every(layer=>!Object.hasOwn(layer,'sfxOrder')));
  await page.waitForFunction(()=>!document.querySelector('#projectLoad').disabled);
  const expected=await page.evaluate(async layers=>{
    const {draw}=await import('./src/renderer.js');
    const image=new Image();image.src=window.layerOriginal;await image.decode();const output=document.createElement('canvas');output.width=400;output.height=300;draw(output.getContext('2d'),image,layers);return output.toDataURL();
  },await page.evaluate(({src,layers})=>{window.layerOriginal=src;return layers;},project.pages[0]));
  downloading=page.waitForEvent('download');await row.locator('[data-action=save-image]').click();
  const png=await readFile(await (await downloading).path());
  const actual=await page.evaluate(async base64=>{const image=new Image();image.src=`data:image/png;base64,${base64}`;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').drawImage(image,0,0);return canvas.toDataURL();},png.toString('base64'));
  assert.equal(actual,expected,'worker PNG uses the same order as preview renderer');
  await page.waitForFunction(()=>!document.querySelector('#projectLoad').disabled);await page.click('#temporarySave');
  await waitForAsync(page,async version=>{const {getDraftMeta}=await import('./src/storage.js');return (await getDraftMeta())?.version===version;},PROJECT_VERSION);
  await page.reload();await page.waitForSelector('#draftNotice:not([hidden])');await page.click('#restoreDraft');
  await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===1&&!document.querySelector('#projectLoad').disabled);
  assert.deepEqual(await order(),['balloon','dialogue','caption','sfx']);assert.ok(await redCount()>100,'draft recovery retains SFX in front');
  await page.reload();await load(project);assert.deepEqual(await order(),['balloon','dialogue','caption','sfx']);assert.ok(await redCount()>100,'current project is not remigrated');
  // .serifu containers also preserve the same order on import.
  await page.selectOption('#projectFormat','serifu');downloading=page.waitForEvent('download');await page.click('#projectSave');
  const binary=await readFile(await (await downloading).path());await page.reload();
  await page.locator('#projectInput').setInputFiles({name:'layers.serifu',mimeType:'application/octet-stream',buffer:binary});
  await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===1&&!document.querySelector('#projectLoad').disabled);
  assert.deepEqual(await order(),['balloon','dialogue','caption','sfx']);assert.ok(await redCount()>100);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'layer actions fit mobile viewport');
  assert.deepEqual(errors,[]);
  console.log('Layer order browser smoke passed: migration, both directions, endpoints, multiple selection, undo/redo, hit testing, PNG, JSON/binary projects, draft recovery and mobile layout.');
}catch(error){if(page){await mkdir('artifacts',{recursive:true});await page.screenshot({path:'artifacts/layer-order-failure.png',fullPage:true}).catch(()=>{});}throw error;}
finally{await browser?.close();server.kill();}
