import assert from 'node:assert/strict';
import {sfxTest,exportJson,exportPng,assertPng} from './sfx-test-support.mjs';
await sfxTest(5284,async({page,row,card})=>{
 await card.locator('textarea').fill('ボコッ');await card.locator('[data-action=sfx-text-apply]').click();let project=await exportJson(page),layer=project.pages[0].layers[0];
 const positions=await page.evaluate(async l=>{const {sfxScene}=await import('/src/renderer.js');return sfxScene(document.querySelector('canvas.preview').getContext('2d'),l).glyphs.map(g=>({index:g.index,x:g.x}));},layer);
 for(const g of positions){await card.locator(`[data-glyph-index="${g.index}"]`).click();await card.locator('[data-glyph-field=dx]').fill(String(-g.x));await card.locator('[data-glyph-field=dx]').press('Tab');}
 await card.locator('.sfx-outline-group-panel summary').click();await card.locator('[data-action=sfx-outline-group-all]').click();project=await exportJson(page);layer=project.pages[0].layers[0];
 const groups=await page.evaluate(async l=>{const {sfxScene,sfxResolvedGroups}=await import('/src/renderer.js');return sfxResolvedGroups(sfxScene(document.querySelector('canvas.preview').getContext('2d'),l),l.lettering);},layer);assert.ok(groups.some(g=>g.members.length===3),'real ink overlap creates a shared group');
 await card.locator('[data-sfx-group-color]').fill('#55aaff');await card.locator('[data-sfx-group-color]').dispatchEvent('change');project=await exportJson(page);assert.equal(project.pages[0].layers[0].lettering.outlineGroups[0].locked,true);
 await assertPng(page,project,await exportPng(page,row));
 const contourStable=await page.evaluate(async l=>{const {sfxScene}=await import('/src/renderer.js');const ctx=document.querySelector('canvas.preview').getContext('2d');const a=sfxScene(ctx,{...l,inkTexture:'grunge',grungeAmount:0}),b=sfxScene(ctx,{...l,inkTexture:'grunge',grungeAmount:90});return a.glyphs.every((item,i)=>item.surface.body.every((value,k)=>value===b.glyphs[i].surface.body[k]));},project.pages[0].layers[0]);assert.equal(contourStable,true,'grunge does not alter outline silhouette');
 await card.locator('.sfx-advanced-panel summary').click();await card.locator('[data-sfx-editor-action=select-all]').click();await row.locator('canvas.preview').focus();await page.keyboard.press('Control+d');project=await exportJson(page);assert.equal(project.pages[0].layers[0].text,'ボボココッッ');await page.keyboard.press('Control+z');assert.equal((await exportJson(page)).pages[0].layers[0].text,'ボコッ');
 console.log('SFX outlines: actual overlap, locked members, grunge silhouette, multi-glyph duplicate/Undo and PNG PASS');
});
