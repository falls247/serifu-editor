import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {sfxTest,exportJson,exportPng,assertPng} from './sfx-test-support.mjs';

await sfxTest(5312,async({page,row,card})=>{
  const toggle=(root,field)=>root.locator(`[data-field=${field}]`).locator('..').locator('.transparent-color');
  const fill=card.locator('[data-field=color]');
  await fill.fill('#2468aa');
  await toggle(card,'color').click();
  assert.equal(await toggle(card,'color').getAttribute('aria-pressed'),'true');
  assert.equal((await exportJson(page)).pages[0].layers[0].color,'transparent');
  await toggle(card,'color').click();
  assert.equal((await exportJson(page)).pages[0].layers[0].color,'#2468aa');
  await row.locator('[data-action=undo]').click();
  assert.equal(await toggle(card,'color').getAttribute('aria-pressed'),'true');
  await row.locator('[data-action=redo]').click();
  assert.equal(await toggle(card,'color').getAttribute('aria-pressed'),'false');
  await toggle(card,'color').click();
  await fill.fill('#334455');
  assert.equal(await toggle(card,'color').getAttribute('aria-pressed'),'false');
  assert.equal((await exportJson(page)).pages[0].layers[0].color,'#334455');
  await card.locator('.sfx-advanced-panel summary').click();
  const glyphFill=card.locator('[data-sfx-editor=fill]').locator('..').locator('.transparent-color');
  await glyphFill.click();
  assert.equal((await exportJson(page)).pages[0].layers[0].lettering.glyphs[0].overrides.fill,'transparent');
  await card.locator('[data-action=sfx-glyph-exit]').click();
  await toggle(card,'color').click();

  for(const [action,kind] of [['add-male','dialogue'],['add-balloon','balloon'],['add-caption','caption']]){
    await row.locator(`[data-action=${action}]`).click();
    const object=row.locator(`[data-kind=${kind}]`).last(),controls=row.locator('.position-controls');
    await object.locator('textarea').fill('透明文字');
    await object.locator('[data-field=textColor]').fill('#2468aa');
    await toggle(object,'textColor').click();
    assert.equal(await toggle(controls,'textColor').getAttribute('aria-pressed'),'true',kind);
    assert.equal((await exportJson(page)).pages[0].layers.at(-1).textColor,'transparent',kind);
    await toggle(controls,'textColor').click();
    assert.equal(await toggle(object,'textColor').getAttribute('aria-pressed'),'false',kind);
    await toggle(controls,'textColor').click();
    await toggle(object,'textOutlineColor').click();
    assert.equal(await toggle(controls,'textOutlineColor').getAttribute('aria-pressed'),'true',kind);
    await toggle(object,'textOutlineColor').click();
  }

  const pixels=await page.evaluate(async()=>{
    const {newLayer,draw}=await import('/src/renderer.js');
    const {startLettering}=await import('/src/sfx-lettering-model.js');
    const base=document.createElement('canvas');base.width=base.height=600;
    const b=base.getContext('2d');
    for(let y=0;y<600;y+=20)for(let x=0;x<600;x+=20){b.fillStyle=(x+y)%40?'#778899':'#bbccdd';b.fillRect(x,y,20,20);}
    const canvas=document.createElement('canvas');canvas.width=canvas.height=600;
    const ctx=canvas.getContext('2d'),results=[];
    const render=l=>{draw(ctx,base,[l]);return ctx.getImageData(0,0,600,600).data;};
    const sample=(l,label)=>{
      const field=l.kind==='sfx'?'color':'textColor',outline=l.kind==='caption'?'textOutlineWidth':'outline';
      const background=render({...l,text:''}),solid=render({...l,[field]:'#1122aa',[outline]:0});
      const hollow={...l,[field]:'transparent'},image=render(hollow);
      let core=0,restored=0,border=0,blue=0;
      for(let i=0;i<image.length;i+=4){
        if(solid[i]===17&&solid[i+1]===34&&solid[i+2]===170){core++;if(image[i]===background[i]&&image[i+1]===background[i+1]&&image[i+2]===background[i+2])restored++;}
        if(image[i]===238&&image[i+1]===51&&image[i+2]===0)border++;
        if(image[i]===17&&image[i+1]===34&&image[i+2]===170)blue++;
      }
      const worker=new OffscreenCanvas(600,600);draw(worker.getContext('2d'),base,[hollow]);
      const workerPixels=worker.getContext('2d').getImageData(0,0,600,600).data;
      const parity=image.every((v,i)=>v===workerPixels[i]);
      const hidden=render({...hollow,textOutlineColor:'transparent'});
      const invisible=hidden.every((v,i)=>v===background[i]);
      results.push({label,core,restored,border,blue,parity,invisible});
    };
    const common={text:'田',vertical:false,x:300,y:300,w:450,h:450,size:110,rotation:0,font:'sans',effect:'none',distortion:0,skew:0,roughness:0,dryInk:0,brushTails:0,sizeVariation:0,horizontalJitter:0,outline:5,textOutlineWidth:5,textOutlineColor:'#ee3300',lineAlign:'center',borderWidth:0,autoFit:false};
    for(const kind of ['dialogue','balloon','caption','sfx'])for(const thickness of kind==='caption'?[0]:[0,3]){
      const layer={...newLayer(kind,600,600),...common,thickness};
      sample(layer,kind+' thickness '+thickness);
      if(kind==='sfx'){
        layer.lettering=startLettering(layer);layer.lettering.outlineMode='individual';
        sample(layer,'edited sfx thickness '+thickness);
      }
    }
    const stroke={...newLayer('sfx',600,600),...common,text:'ーー'};
    stroke.lettering=startLettering(stroke);stroke.lettering.outlineMode='individual';
    sample(stroke,'continuous stroke');
    return results;
  });
  for(const sample of pixels){
    assert.ok(sample.core>20,JSON.stringify(sample));
    assert.ok(sample.restored/sample.core>.95,JSON.stringify(sample));
    assert.ok(sample.border>20,JSON.stringify(sample));
    assert.equal(sample.blue,0,JSON.stringify(sample));
    assert.equal(sample.parity,true,JSON.stringify(sample));
    assert.equal(sample.invisible,true,JSON.stringify(sample));
  }

  let project=await exportJson(page);
  await assertPng(page,project,await exportPng(page,row));
  const saved=Buffer.from(JSON.stringify(project));
  await page.reload();
  await page.locator('#projectInput').setInputFiles({name:'transparent.json',mimeType:'application/json',buffer:saved});
  await page.waitForFunction(()=>document.querySelector('.image-row')&&!document.querySelector('#projectLoad').disabled);
  project=await exportJson(page);
  for(const layer of project.pages[0].layers)assert.equal(layer.kind==='sfx'?layer.color:layer.textColor,'transparent');
  for(const kind of ['dialogue','balloon','caption','sfx'])assert.equal(await toggle(row.locator(`[data-kind=${kind}]`),kind==='sfx'?'color':'textColor').getAttribute('aria-pressed'),'true');
  const summary=row.locator('[data-kind=sfx] .layer-summary');
  if(await summary.isVisible())await summary.click();
  await page.setViewportSize({width:420,height:860});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await mkdir('artifacts',{recursive:true});
  await page.screenshot({path:'artifacts/transparent-color-mobile.png'});
  console.log('Transparent text: all object controls, glyph overrides, undo/redo, opaque color recovery, hollow pixels, OffscreenCanvas, PNG, project reload and mobile layout PASS',pixels);
});
