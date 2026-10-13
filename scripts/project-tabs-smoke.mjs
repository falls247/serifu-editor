import assert from 'node:assert/strict';
import {sfxTest,exportJson} from './sfx-test-support.mjs';
await sfxTest(5286,async({page:a,browser})=>{
 await a.click('#temporarySave');await a.waitForFunction(()=>document.querySelector('#draftStatus').textContent.includes('保存済'));
 const project=(await exportJson(a)),id=project.projectId,owner=await a.evaluate(async id=>{const {inspectProjectLease}=await import('/src/project-lock.js');return inspectProjectLease(id);},id);
 const context=a.context(),b=await context.newPage(),c=await context.newPage();
 for(const page of [b,c]){await page.goto('http://localhost:5286');await page.locator('#draftNotice:not([hidden])').waitFor();await page.click('#restoreDraft');await page.waitForFunction(()=>document.querySelector('.image-row')&&!document.querySelector('#projectLoad').disabled);assert.equal(await page.locator('#projectAccess').getAttribute('data-readonly'),'true');assert.equal(await page.locator('#temporarySave').isDisabled(),true);}
 await b.click('#projectAccess');await b.waitForTimeout(600);await c.click('#projectAccess');
 await a.close();await c.waitForFunction(()=>document.querySelector('#projectAccess').dataset.readonly==='false');assert.equal(await b.locator('#projectAccess').getAttribute('data-readonly'),'true');
 const claim=await c.evaluate(async id=>{const l=await import('/src/project-lock.js');return l.inspectProjectLease(id);},id);assert.ok(claim.token>owner.token);
 const fenced=await b.evaluate(async({id,owner})=>{const h=await import('/src/project-history.js'),before=await h.latestProjectSnapshot(id);const clone=structuredClone(before.meta);clone.pages[0].name='OLD OWNER';let denied=0;for(const action of [()=>h.saveProjectSnapshot(clone,[],{fence:{owner:owner.owner,token:owner.token}}),()=>h.deleteStoredProject(id,{fence:{owner:owner.owner,token:owner.token}})])try{await action();}catch{denied++;}return {denied,name:(await h.latestProjectSnapshot(id)).meta.pages[0].name};},{id,owner});assert.equal(fenced.denied,2);assert.equal(fenced.name,'sfx.png');
 // Simulate a frozen/expired owner and an explicitly active viewer, not heartbeat priority.
 await b.waitForTimeout(600);await b.click('#projectAccess');await b.evaluate(async id=>{const {openDraftDatabase}=await import('/src/storage.js');const db=await openDraftDatabase(),tx=db.transaction('locks','readwrite'),s=tx.objectStore('locks'),q=s.get(id);q.onsuccess=()=>s.put({...q.result,until:0});await new Promise(resolve=>tx.oncomplete=resolve);},id);
 await b.waitForFunction(()=>document.querySelector('#projectAccess').dataset.readonly==='false');await c.waitForFunction(()=>document.querySelector('#projectAccess').dataset.readonly==='true');
 assert.equal(await b.locator('[data-kind=sfx] textarea').inputValue(),'ザーーーーッ');
 console.log('Project tabs: 3-tab view-only, last explicit input priority, close/expiry handoff, committed reload and fenced save/delete PASS');
});
