import assert from 'node:assert/strict';
import {sfxTest,exportJson,exportPng,pointPosition,assertPng} from './sfx-test-support.mjs';
await sfxTest(5280,async({page,row,card})=>{
 await card.locator('.sfx-stroke-panel summary').click();await card.locator('[data-glyph-stroke-shape]').selectOption('s');
 await card.locator('.sfx-advanced-panel summary').click();await card.locator('[data-sfx-editor=editMode]').selectOption('curve');
 let project=await exportJson(page),layer=project.pages[0].layers[0];
 const handle=await page.evaluate(async l=>{const {sfxScene}=await import('/src/renderer.js'),{strokeFrame,pathToLocal}=await import('/src/sfx-stroke-geometry.js');const ctx=document.querySelector('canvas.preview').getContext('2d'),scene=sfxScene(ctx,l),run=l.lettering.strokes[0];return pathToLocal(strokeFrame(run,scene.positions,{size:l.size}),run.path.points[1]);},layer);
 await row.locator('canvas.preview').scrollIntoViewIfNeeded();const point=await pointPosition(page,layer,handle);await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x,point.y+30,{steps:4});await page.mouse.up();
 project=await exportJson(page);assert.notEqual(project.pages[0].layers[0].lettering.strokes[0].path.points[1].y,layer.lettering.strokes[0].path.points[1].y,'Canvas handle changes curve');
 await card.locator('[data-sfx-editor-action=curve-add]').click();await card.locator('[data-sfx-editor-action=width-add]').click();await card.locator('[data-sfx-editor=widthIndex]').selectOption('1');await card.locator('[data-sfx-editor=widthW]').fill('39');await card.locator('[data-sfx-editor=widthW]').dispatchEvent('change');
 project=await exportJson(page);assert.equal(project.pages[0].layers[0].lettering.strokes[0].path.points.length,7);assert.equal(project.pages[0].layers[0].lettering.strokes[0].widths[1].w,39);
 await card.locator('[data-glyph-inherit]').selectOption('character');await card.locator('textarea').fill('ザーークーーッ');await card.locator('[data-action=sfx-text-apply]').click();project=await exportJson(page);assert.equal(project.pages[0].layers[0].lettering.strokes.length,2);
 await card.locator('textarea').fill('ザーーーーッ');await card.locator('[data-action=sfx-text-apply]').click();project=await exportJson(page);assert.equal(project.pages[0].layers[0].lettering.strokes.length,1);assert.ok(project.pages[0].layers[0].lettering.strokes[0].path.points.length>=7);
 await assertPng(page,project,await exportPng(page,row));
 await row.locator('[data-action=undo]').click();assert.equal((await exportJson(page)).pages[0].layers[0].text,'ザーークーーッ');
 console.log('SFX stroke: Canvas curve handles, point/width insertion, split/join, Undo and PNG PASS');
});
