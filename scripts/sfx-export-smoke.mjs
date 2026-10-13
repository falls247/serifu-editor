import assert from 'node:assert/strict';
import {sfxTest,exportJson,exportPng,assertPng} from './sfx-test-support.mjs';
await sfxTest(5296,async({page,row,card})=>{
 page.on('dialog',dialog=>dialog.accept());
 await card.locator('[data-glyph-index="0"]').click();await card.locator('[data-glyph-field=dx]').fill('1500');await card.locator('[data-glyph-field=dx]').press('Tab');
 await card.locator('.sfx-overflow').waitFor({state:'visible'});
 const project=await exportJson(page),png=await exportPng(page,row),layer=project.pages[0].layers[0];
 assert.equal(layer.lettering.glyphs[0].dx,1500);await assertPng(page,project,png);
 const before=structuredClone(layer.lettering);
 await row.locator('.position-controls [data-field=vertical]').selectOption('true');await row.locator('.position-controls [data-field=vertical]').selectOption('false');
 assert.deepEqual((await exportJson(page)).pages[0].layers[0].lettering,before,'writing-direction round trip preserves manual positions and curves');
 await page.locator('#projectOpenInput').setInputFiles({name:'roundtrip.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(project))});
 await page.waitForFunction(()=>document.querySelector('[data-kind=sfx]')&&!document.querySelector('#projectLoad').disabled);
 const restored=page.locator('.image-row').first(),reloaded=await exportJson(page);
 assert.deepEqual(reloaded.pages[0].layers[0].lettering,before);assert.equal(await exportPng(page,restored),png,'reload produces identical original-size PNG bytes');
 console.log('SFX export: overflow warning/clipping, original dimensions, orientation round trip and exact reload PNG PASS');
});
