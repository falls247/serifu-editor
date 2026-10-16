import assert from 'node:assert/strict';
import {sfxTest,exportJson} from './sfx-test-support.mjs';

await sfxTest(5317,async({page,card})=>{
 await card.locator('.sfx-advanced-panel summary').click();
 assert.equal(await card.locator('[data-sfx-editor=editMode]').inputValue(),'glyph');
 assert.equal(await card.locator('[data-sfx-editor-action=curve-add]').count(),1,'curve-add action is available on first glyph-edit render');
 await card.locator('[data-sfx-editor-action=curve-add]').click();

 const project=await exportJson(page),layer=project.pages[0].layers[0],run=layer.lettering.strokes[0];
 assert.equal(run.path.points.length,7,'curve point is inserted into the stored path');
 assert.equal(await card.locator('[data-sfx-editor=editMode]').inputValue(),'curve','curve handles become visible after insertion');
 assert.equal(await card.locator('[data-glyph-stroke-point]').inputValue(),'3','new anchor is selected');
 const handles=await page.evaluate(async layer=>{
  const {sfxScene}=await import('/src/renderer.js'),{strokeHandles}=await import('/src/sfx-editor.js');
  const ctx=document.querySelector('canvas.preview').getContext('2d'),scene=sfxScene(ctx,layer);
  const mode={strokeRun:layer.lettering.strokes[0].runStart,editMode:document.querySelector('[data-sfx-editor=editMode]').value};
  return strokeHandles(scene,layer,mode).filter(handle=>handle.kind==='curve').length;
 },layer);
 assert.equal(handles,7,'all inserted curve handles are exposed for editing');
 console.log('SFX curve insertion: point, mode switch and selection PASS');
});
