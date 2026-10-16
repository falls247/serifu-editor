import assert from 'node:assert/strict';
import {sfxTest,exportJson,pointPosition} from './sfx-test-support.mjs';

await sfxTest(5322,async({page,row,card})=>{
  const canvas=row.locator('canvas.preview'),mode=card.locator('[data-sfx-editor=editMode]');
  await card.locator('textarea').fill('ザーークーーッ');
  await card.locator('[data-action=sfx-text-apply]').click();
  await card.locator('.sfx-advanced-panel summary').click();
  const initial=(await exportJson(page)).pages[0].layers[0];
  const atItem=async(type,index)=>{
    const local=await page.evaluate(async({layer,type,index})=>{
      const {sfxScene,sfxItemHit}=await import('/src/renderer.js'),{strokeHandles}=await import('/src/sfx-editor.js');
      const preview=document.querySelector('canvas.preview'),scene=sfxScene(preview.getContext('2d'),layer);
      const item=scene.items.find(item=>item.type===type&&item.index===index);
      const handles=layer.lettering.strokes.flatMap(run=>strokeHandles(scene,layer,{editMode:'both',strokeRun:run.runStart}));
      const radius=10/(preview.getBoundingClientRect().width/1000)+2,b=item.bounds,center={x:(b.minX+b.maxX)/2,y:(b.minY+b.maxY)/2};
      let point=null,closest=Infinity;
      for(let y=b.minY;y<=b.maxY;y+=.5)for(let x=b.minX;x<=b.maxX;x+=.5){
        const distance=Math.hypot(x-center.x,y-center.y);
        if(distance<closest&&handles.every(handle=>Math.hypot(x-handle.x,y-handle.y)>radius)&&sfxItemHit(item,{x,y})){point={x,y};closest=distance;}
      }
      if(!point)throw Error(`no ${type} ${index} body point away from control points`);return point;
    },{layer:initial,type,index});
    await canvas.scrollIntoViewIfNeeded();return pointPosition(page,initial,local);
  };
  let at=await atItem('glyph',0);await page.mouse.dblclick(at.x,at.y);
  assert.equal(await mode.inputValue(),'glyph','double-clicking a regular character keeps character editing');
  at=await atItem('stroke',1);await page.mouse.dblclick(at.x,at.y);
  assert.equal(await mode.inputValue(),'curve','double-clicking a long vowel mark enters curve-point editing');
  assert.equal(await card.locator('[data-glyph-stroke-run]').inputValue(),'1');
  assert.equal(await page.evaluate(()=>{
    const canvas=document.querySelector('canvas.preview'),data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    for(let i=0;i<data.length;i+=4)if(data[i]===239&&data[i+1]===75&&data[i+2]===145)return true;return false;
  }),true,'double-click selects a visible pink control point');
  at=await atItem('glyph',0);await page.mouse.click(at.x,at.y);
  assert.equal(await mode.inputValue(),'glyph','another character still exits curve-point editing');
  at=await atItem('stroke',4);await page.mouse.dblclick(at.x,at.y);
  assert.equal(await mode.inputValue(),'curve');
  assert.equal(await card.locator('[data-glyph-stroke-run]').inputValue(),'4','double-click edits the targeted stroke instead of the previous one');
  assert.deepEqual((await exportJson(page)).pages[0].layers[0].lettering,initial.lettering,'double-click selection preserves lettering data');
  await card.locator('[data-action=sfx-glyph-exit]').click();
  at=await atItem('stroke',4);await page.mouse.dblclick(at.x,at.y);
  assert.equal(await mode.inputValue(),'curve','double-click enters curve editing from the normal layer view');
  assert.equal(await card.locator('[data-glyph-stroke-run]').inputValue(),'4');
  const chosen=Number(await card.locator('[data-glyph-stroke-point]').inputValue());
  await card.locator('.sfx-stroke-panel summary').click();
  await card.locator('[data-glyph-stroke-point-axis=y]').fill('0.2');
  await card.locator('[data-glyph-stroke-point-axis=y]').press('Tab');
  const edited=(await exportJson(page)).pages[0].layers[0];
  assert.equal(edited.lettering.strokes[1].path.points[chosen].y,0.2,'the point selected by double-click can be edited');
  assert.deepEqual(edited.lettering.strokes[0],initial.lettering.strokes[0],'editing the second stroke preserves the first');
  console.log('SFX double-click: curve mode, targeted stroke, pink point, normal layer entry and subsequent editing PASS');
});
