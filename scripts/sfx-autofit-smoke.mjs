import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {sfxTest,exportJson,exportPng,assertPng,pointPosition} from './sfx-test-support.mjs';

await sfxTest(5336,async({page,row,card,browser})=>{
  const position=row.locator('.position-controls'),button=position.locator('[data-action=sfx-autofit]');
  const set=async(field,value)=>{const input=position.locator(`[data-field=${field}]`);await input.fill(String(value));await input.press('Tab');};
  const layer=async()=>(await exportJson(page)).pages[0].layers[0];
  await card.locator('[data-field=effect]').selectOption('none');
  await page.evaluate(()=>document.fonts.ready);
  assert.equal(await button.evaluate(node=>node.previousElementSibling.dataset.action),'center');
  assert.equal(await button.evaluate(node=>Math.abs(node.getBoundingClientRect().top-node.previousElementSibling.getBoundingClientRect().top)<1),true,'AutoFit stays to the right of center');
  assert.equal(await button.getAttribute('aria-pressed'),'false');
  const before=await layer();
  await button.focus();await page.keyboard.press('Space');
  assert.equal(await button.getAttribute('aria-pressed'),'true');
  let current=await layer();assert.equal(current.autoFit,true);assert.equal(current.size,before.size);
  assert.deepEqual(current.lettering,before.lettering,'AutoFit preserves editable glyph and stroke data');

  const assertFit=async(target)=>{
    const bounds=await page.evaluate(async target=>{
      const {draw}=await import('/src/renderer.js');
      const c=document.createElement('canvas');c.width=1000;c.height=750;
      const blank=document.createElement('canvas');blank.width=1000;blank.height=750;
      draw(c.getContext('2d'),blank,[{...target,x:500,y:375,rotation:0,effect:'none'}]);
      const pixels=c.getContext('2d').getImageData(0,0,1000,750).data;
      let minX=1000,minY=750,maxX=-1,maxY=-1;
      for(let y=0;y<750;y++)for(let x=0;x<1000;x++)if(pixels[(y*1000+x)*4+3]){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
      return {w:maxX-minX+1,h:maxY-minY+1,cx:(minX+maxX+1)/2,cy:(minY+maxY+1)/2};
    },target);
    assert.ok(Math.abs(bounds.w-target.w)<6,`text width ${bounds.w} fits ${target.w}`);
    assert.ok(Math.abs(bounds.h-target.h)<6,`text height ${bounds.h} fits ${target.h}`);
    assert.ok(Math.abs(bounds.cx-500)<3&&Math.abs(bounds.cy-375)<3,'text centered in rectangle');
  };
  await assertFit(current);
  await set('w',360);await set('h',240);current=await layer();await assertFit(current);
  assert.equal(current.w,360);assert.equal(current.h,240);assert.equal(current.size,before.size);
  await row.locator('[data-action=undo]').click();assert.equal((await layer()).h,600);
  await row.locator('[data-action=redo]').click();assert.equal((await layer()).h,240);

  // Glyph picking uses the inverse fit, while its overlay uses the forward fit.
  const target=await page.evaluate(async current=>{
    const {sfxScene,sfxAutoFitTransform}=await import('/src/renderer.js');
    const ctx=document.querySelector('canvas.preview').getContext('2d'),scene=sfxScene(ctx,current),fit=sfxAutoFitTransform(ctx,current);
    const item=scene.items.find(item=>item.type==='glyph'&&item.index===5),b=item.bounds;
    return {x:(b.minX+b.maxX)/2*fit.scaleX+fit.x,y:(b.minY+b.maxY)/2*fit.scaleY+fit.y};
  },current);
  await row.locator('canvas.preview').scrollIntoViewIfNeeded();
  let point=await pointPosition(page,current,target);await page.mouse.click(point.x,point.y);
  assert.equal(await card.locator('[data-glyph-index="5"]').getAttribute('aria-pressed'),'true');
  await card.locator('[data-action=sfx-glyph-exit]').click();
  await row.locator('canvas.preview').scrollIntoViewIfNeeded();
  point=await pointPosition(page,current,{x:current.w/2,y:current.h/2});
  const end=await pointPosition(page,current,{x:260,y:90});
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:5});await page.mouse.up();
  current=await layer();assert.ok(Math.abs(current.w-520)<=2);assert.ok(Math.abs(current.h-180)<=2);
  assert.equal(current.size,before.size);await assertFit(current);

  await row.locator('[data-action=preview-focus]').click();
  await set('w',420);await set('h',280);current=await layer();await assertFit(current);
  assert.equal(await button.getAttribute('aria-pressed'),'true');
  await row.locator('[data-action=preview-full]').click();await page.locator('#fullPreview').waitFor({state:'visible'});
  await page.locator('#fullPreviewClose').click();
  await row.locator('[data-action=preview-focus]').click();
  const project=await exportJson(page),png=await exportPng(page,row);await assertPng(page,project,png);
  const workerDiff=await page.evaluate(async({project,png})=>{
    const {ImagePool}=await import('/src/bulk-pool.js'),p=project.pages[0],pool=new ImagePool({size:1});
    try{
      const blob=await pool.run('render-png',{blob:await (await fetch(p.src)).blob(),width:1000,height:750,layers:p.layers},undefined,()=>{throw Error('Worker unavailable');});
      const pixels=async blob=>{const bitmap=await createImageBitmap(blob),c=document.createElement('canvas');c.width=1000;c.height=750;c.getContext('2d').drawImage(bitmap,0,0);bitmap.close();return c.getContext('2d').getImageData(0,0,1000,750).data;};
      const a=await pixels(blob),b=await pixels(await (await fetch('data:image/png;base64,'+png)).blob());return a.reduce((count,n,i)=>count+(n!==b[i]),0);
    }finally{pool.close();}
  },{project,png});assert.equal(workerDiff,0,'Worker and PNG output match');
  await page.locator('#projectOpenInput').setInputFiles({name:'autofit.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
  await page.waitForFunction(()=>document.querySelector('[data-kind=sfx]')&&!document.querySelector('#projectLoad').disabled);
  assert.equal(await button.getAttribute('aria-pressed'),'true');assert.equal((await layer()).autoFit,true);
  assert.equal(await exportPng(page,row),png,'saved AutoFit restores identical PNG');
  await button.click();const disabled=await layer();assert.equal(disabled.autoFit,false);assert.equal(disabled.w,current.w);assert.equal(disabled.h,current.h);
  await row.locator('[data-action=undo]').click();assert.equal((await layer()).autoFit,true);
  await row.locator('[data-action=redo]').click();assert.equal((await layer()).autoFit,false);

  // Exercise ordinary SFX, directions, explicit newlines and single/empty text.
  const cases=await page.evaluate(async()=>{
    const {newLayer,draw}=await import('/src/renderer.js'),{startLettering}=await import('/src/sfx-lettering-model.js');
    const cases=[];
    for(const vertical of [true,false])for(const text of ['ドン！','ドン\nガガッ','ド',''])for(const edited of [false,true]){
      const base={...newLayer('sfx',1000,750),autoFit:true,x:500,y:375,rotation:0,w:260,h:400,text,vertical,effect:'none',outline:3,roughness:0,dryInk:0,brushTails:0,distortion:0,skew:0};
      if(edited)base.lettering=startLettering(base);
      const c=document.createElement('canvas');c.width=1000;c.height=750;const blank=document.createElement('canvas');blank.width=1000;blank.height=750;
      draw(c.getContext('2d'),blank,[base]);const data=c.getContext('2d').getImageData(0,0,1000,750).data;
      let minX=1000,minY=750,maxX=-1,maxY=-1;for(let y=0;y<750;y++)for(let x=0;x<1000;x++)if(data[(y*1000+x)*4+3]){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
      cases.push({vertical,text,edited,w:maxX-minX+1,h:maxY-minY+1});
    }
    return cases;
  });
  for(const item of cases)if(item.text){assert.ok(Math.abs(item.w-260)<6,JSON.stringify(item));assert.ok(Math.abs(item.h-400)<6,JSON.stringify(item));}

  await mkdir('artifacts',{recursive:true});
  await button.click();await row.locator('.preview-pane').screenshot({path:'artifacts/sfx-autofit-desktop.png'});
  const touch=await browser.newContext({viewport:{width:430,height:950},hasTouch:true,isMobile:true});
  try{
    const mobile=await touch.newPage();await mobile.goto(page.url());
    await mobile.locator('#projectOpenInput').setInputFiles({name:'autofit.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
    await mobile.waitForFunction(()=>document.querySelector('[data-kind=sfx]')&&!document.querySelector('#projectLoad').disabled);
    const toggle=mobile.locator('.position-controls [data-action=sfx-autofit]');await toggle.tap();assert.equal(await toggle.getAttribute('aria-pressed'),'false');await toggle.tap();assert.equal(await toggle.getAttribute('aria-pressed'),'true');
    assert.equal(await toggle.evaluate(node=>Math.abs(node.getBoundingClientRect().top-node.previousElementSibling.getBoundingClientRect().top)<1),true,'AutoFit stays beside center on mobile');
    assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await mobile.locator('.position-controls').screenshot({path:'artifacts/sfx-autofit-mobile.png'});
    for(const theme of ['dark','light']){
      await mobile.goto(new URL('/docs/',page.url()).href);
      await mobile.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
      assert.equal(await mobile.locator('#sfx').getByText(/AutoFit.*初期状態/).count(),1);
      assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    }
  }finally{await touch.close();}
  await writeFile('artifacts/sfx-autofit-results.json',JSON.stringify({cases,workerDiff},null,2));
  console.log('SFX AutoFit: fitted ink bounds, numeric/drag resizing, glyph picking, normal/FOCUS/full view, keyboard/touch, Undo/Redo, JSON/PNG/Worker parity and mobile layout PASS');
});
