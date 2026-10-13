import assert from 'node:assert/strict';
import {sfxTest,exportJson} from './sfx-test-support.mjs';
await sfxTest(5290,async({page,row,card})=>{
 page.on('dialog',d=>d.accept());await page.click('#temporarySave');await page.waitForFunction(()=>document.querySelector('#draftStatus').textContent.includes('保存済'));const original=await exportJson(page),originalId=original.projectId;
 const history=await page.evaluate(async id=>(await (await import('/src/project-history.js')).listProjectHistories(id)).length,originalId);
 const changed=structuredClone(original);changed.pages[0].layers[0].text='別内容';delete changed.pages[0].layers[0].lettering;
 async function open(data,choice){await page.locator('#projectOpenInput').setInputFiles({name:'project.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});if(choice)await page.locator('.project-conflict-dialog').getByRole('button',{name:choice,exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#projectLoad').disabled);}
 await open(changed,'自動保存から再開');assert.equal(await page.locator('[data-kind=sfx] textarea').inputValue(),'ザーーーーッ');assert.equal((await exportJson(page)).projectId,originalId);
 // A same-ID image replacement must store B, while existing generations retain A.
 changed.pages[0].src=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=1000;c.height=750;c.getContext('2d').fillStyle='#ff0000';c.getContext('2d').fillRect(0,0,1000,750);return c.toDataURL();});
 await open(changed,'ファイルの内容を開く');await page.click('#temporarySave');await page.waitForFunction(async()=>{const {getDraftMeta}=await import('/src/storage.js');return (await getDraftMeta()).pages[0].layers[0].text==='別内容';});
 const identities=await page.evaluate(async id=>{const h=await import('/src/project-history.js');const latest=await h.latestProjectSnapshot(id),histories=await h.listProjectHistories(id),old=await h.getStoredSnapshot(histories.at(-1).snapshotId);return {count:histories.length,different:latest.images[0].assetId!==old.images[0].assetId};},originalId);assert.equal(identities.count,history);assert.equal(identities.different,true);
 const copyFile=structuredClone(changed);copyFile.pages[0].layers[0].text='コピー側';await open(copyFile,'別プロジェクトとして開く');const copied=await exportJson(page);assert.notEqual(copied.projectId,originalId);assert.equal(copied.pages[0].layers[0].text,'コピー側');
 await page.locator('#projectInput').setInputFiles({name:'import.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(original))});await page.waitForFunction(()=>document.querySelectorAll('.image-row').length===2&&!document.querySelector('#projectLoad').disabled);const imported=await exportJson(page);assert.equal(imported.projectId,copied.projectId);assert.notEqual(imported.pages[0].id,imported.pages[1].id);
 await open({...changed,version:99});assert.equal((await exportJson(page)).pages.length,2,'invalid open leaves current UI intact');
 const projects=await page.evaluate(async id=>{const h=await import('/src/project-history.js');return (await h.latestProjectSnapshot(id)).meta.pages[0].layers[0].text;},originalId);assert.equal(projects,'別内容','copy/import do not change source project');
 console.log('Project open/import: ID independence, three conflict choices, image replacement history, atomic failure and preserved source PASS');
});
