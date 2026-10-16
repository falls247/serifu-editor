import assert from 'node:assert/strict';
import {sfxTest,exportJson,pointPosition} from './sfx-test-support.mjs';

await sfxTest(5321,async({page,row,card})=>{
  await card.locator('.sfx-advanced-panel summary').click();
  await card.locator('.sfx-stroke-panel summary').click();
  await card.locator('[data-glyph-stroke-point]').selectOption('1');
  await card.locator('[data-glyph-stroke-point-axis=y]').fill('0.16');
  await card.locator('[data-glyph-stroke-point-axis=y]').press('Tab');
  const layer=(await exportJson(page)).pages[0].layers[0],strokes=structuredClone(layer.lettering.strokes);
  for(const mode of ['curve','width','both']){
    await card.locator('[data-sfx-editor=editMode]').selectOption(mode);
    await card.locator('[data-glyph-index="5"]').click();
    assert.equal(await card.locator('[data-sfx-editor=editMode]').inputValue(),'glyph',`${mode}: selecting a character in the list exits point editing`);
    await card.locator('[data-sfx-editor=editMode]').selectOption(mode);
    await card.locator('[data-glyph-index="1"]').click();
    assert.equal(await card.locator('[data-sfx-editor=editMode]').inputValue(),'glyph',`${mode}: selecting a long vowel mark in the list exits point editing`);
    for(const type of ['glyph','stroke']){
      await card.locator('[data-sfx-editor=editMode]').selectOption(mode);
      const point=await page.evaluate(async({layer,mode,type})=>{
        const {sfxScene,sfxItemHit}=await import('/src/renderer.js'),{strokeHandles}=await import('/src/sfx-editor.js');
        const canvas=document.querySelector('canvas.preview'),scene=sfxScene(canvas.getContext('2d'),layer);
        const item=scene.items.find(item=>item.type===type&&(type==='stroke'||item.index===0));
        const handles=strokeHandles(scene,layer,{strokeRun:layer.lettering.strokes[0].runStart,editMode:mode});
        const radius=10/(canvas.getBoundingClientRect().width/1000)+2,b=item.bounds,center={x:(b.minX+b.maxX)/2,y:(b.minY+b.maxY)/2};
        let point=null,closest=Infinity;
        for(let y=b.minY;y<=b.maxY;y+=1)for(let x=b.minX;x<=b.maxX;x+=1){
          const distance=Math.hypot(x-center.x,y-center.y);
          if(distance<closest&&handles.every(handle=>Math.hypot(x-handle.x,y-handle.y)>radius)&&sfxItemHit(item,{x,y})){point={x,y};closest=distance;}
        }
        if(!point)throw Error(`no ${type} ink away from ${mode} handles`);return point;
      },{layer,mode,type});
      await row.locator('canvas.preview').scrollIntoViewIfNeeded();
      const at=await pointPosition(page,layer,point);await page.mouse.click(at.x,at.y);
      assert.equal(await card.locator('[data-sfx-editor=editMode]').inputValue(),'glyph',`${mode}: selecting a ${type} on Canvas exits point editing`);
    }
  }
  const after=(await exportJson(page)).pages[0].layers[0];
  assert.deepEqual(after.lettering.strokes,strokes,'selection changes preserve the edited curve and width data');
  console.log('SFX edit mode: character-list and Canvas selection exit curve/width/both modes without changing strokes PASS');
});
