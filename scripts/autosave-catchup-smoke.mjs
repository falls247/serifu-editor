import assert from 'node:assert/strict';
import {sfxTest,exportJson} from './sfx-test-support.mjs';
import {waitForAsync} from './browser-wait.mjs';

async function holdImageHash(page) {
  await page.evaluate(()=>{
    const original=Blob.prototype.arrayBuffer;
    let hold=true;
    Blob.prototype.arrayBuffer=function(){
      if(hold&&this.type==='image/png'&&this.size>1024){
        hold=false;window.saveHeld=true;
        return new Promise((resolve,reject)=>{
          window.releaseSave=()=>{hold=false;original.call(this).then(resolve,reject);};
        });
      }
      return original.call(this);
    };
  });
}
async function interveningWriter(page,project,{save=false}={}) {
  await page.evaluate(async({project,save})=>{
    const {openDraftDatabase}=await import('/src/storage.js');
    const {claimProjectLease,releaseProjectLease}=await import('/src/project-lock.js');
    const {saveProjectSnapshot}=await import('/src/project-history.js');
    const db=await openDraftDatabase(),tx=db.transaction('locks','readwrite'),locks=tx.objectStore('locks'),request=locks.get(project.projectId);
    request.onsuccess=()=>locks.put({...request.result,until:0});
    await new Promise(resolve=>tx.oncomplete=resolve);
    const other=crypto.randomUUID(),claim=await claimProjectLease(project.projectId,other);
    if(!claim.held)throw Error('test owner could not acquire expired lease');
    const p=project.pages[0],bytes=Uint8Array.from(atob(p.src.split(',')[1]),c=>c.charCodeAt(0)),layer={...p.layers[0],text:'OTHER'};delete layer.lettering;
    await saveProjectSnapshot({version:14,projectId:project.projectId,savedAt:Date.now(),pages:[{...p,layers:[layer]}]},[{id:p.id,blob:new Blob([bytes],{type:'image/png'})}],{fence:{owner:other,token:claim.token}});
    await releaseProjectLease(project.projectId,other);
    if(save)document.querySelector('#temporarySave').click();
  },{project,save});
}
for(const [index,pause] of [1000,121000].entries()) {
  await sfxTest(5299+index,async({page,row,card})=>{
    await page.clock.install();
    await card.locator('textarea').fill('OLD');
    await card.locator('[data-action=sfx-text-apply]').click();
    await holdImageHash(page);
    await page.click('#temporarySave');
    await page.waitForFunction(()=>window.saveHeld===true,undefined,{timeout:10000});
    const before=await page.evaluate(async()=>{
      const {openDraftDatabase}=await import('/src/storage.js');
      const db=await openDraftDatabase(),request=db.transaction('locks').objectStore('locks').getAll();
      return new Promise(resolve=>request.onsuccess=()=>resolve(request.result[0]));
    });
    await page.check('#autosaveEnabled');
    await row.locator('[data-action=copy-all]').click();
    await page.waitForFunction(()=>!document.querySelector('#projectLoad').disabled,undefined,{timeout:3000});
    await card.locator('textarea').fill('NEW');
    await card.locator('[data-action=sfx-text-apply]').click();
    await page.clock.fastForward(pause);
    await page.evaluate(()=>window.releaseSave());
    await waitForAsync(page,async()=>{
      const {getDraftMeta}=await import('/src/storage.js');
      return (await getDraftMeta())?.pages[0].layers[0].text==='NEW';
    },undefined,{timeout:3000});
    assert.equal(await card.locator('textarea').inputValue(),'NEW');
    if(pause>12000){
      const fence=await page.evaluate(async before=>{
        const {inspectProjectLease}=await import('/src/project-lock.js');
        const {latestProjectSnapshot,saveProjectSnapshot}=await import('/src/project-history.js');
        const current=await inspectProjectLease(before.projectId);
        let refused=false;
        try{await saveProjectSnapshot((await latestProjectSnapshot(before.projectId)).meta,[],{fence:{owner:before.owner,token:before.token}});}catch{refused=true;}
        return {current,refused};
      },before);
      assert.ok(fence.current.token>before.token);
      assert.equal(fence.current.ownerEpoch,before.ownerEpoch);
      assert.equal(fence.refused,true,'expired token must remain invalid even for the same owner');
    }
    console.log(`Autosave: held save + additional edits, ${pause}ms clock advance PASS`);
  });
}
await sfxTest(5301,async({page,card})=>{
  const project=await exportJson(page);
  await holdImageHash(page);
  await page.click('#temporarySave');
  await page.waitForFunction(()=>window.saveHeld===true,undefined,{timeout:10000});
  await interveningWriter(page,project);
  await page.evaluate(()=>window.releaseSave());
  await page.waitForFunction(()=>document.querySelector('#draftStatus').dataset.error==='true',undefined,{timeout:10000});
  const latest=await page.evaluate(async id=>{
    const {latestProjectSnapshot}=await import('/src/project-history.js');
    return (await latestProjectSnapshot(id)).meta.pages[0].layers[0].text;
  },project.projectId);
  assert.equal(latest,'OTHER','an intervening writer must keep its committed latest');
  assert.equal(await page.locator('#projectAccess').getAttribute('data-readonly'),'true');
  try{await page.waitForFunction(()=>document.querySelector('#projectAccess').dataset.readonly==='false',undefined,{timeout:10000});}catch(error){console.error(await page.evaluate(()=>({draft:document.querySelector('#draftStatus').textContent,status:document.querySelector('#status').textContent,progress:document.querySelector('#progress')?.textContent,restoreDisabled:document.querySelector('#restoreDraft').disabled,access:document.querySelector('#projectAccess').textContent})));throw error;}
  assert.equal(await card.locator('textarea').inputValue(),'OTHER');
  console.log('Autosave: ownership changed during hashing, stale preparation refused and latest reloaded PASS');
});

await sfxTest(5302,async({page,card})=>{
  await page.click('#temporarySave');
  await page.waitForFunction(()=>document.querySelector('#draftStatus').textContent.includes('保存済'),undefined,{timeout:10000});
  const project=await exportJson(page);
  await interveningWriter(page,project,{save:true});
  await page.waitForFunction(()=>document.querySelector('#projectAccess').dataset.readonly==='true',undefined,{timeout:10000});
  const latest=await page.evaluate(async id=>{
    const {latestProjectSnapshot}=await import('/src/project-history.js');
    return (await latestProjectSnapshot(id)).meta.pages[0].layers[0].text;
  },project.projectId);
  assert.equal(latest,'OTHER','a new save must notice ownership changed since its last lease poll');
  await page.waitForFunction(()=>document.querySelector('#projectAccess').dataset.readonly==='false',undefined,{timeout:10000});
  assert.equal(await card.locator('textarea').inputValue(),'OTHER');
  console.log('Autosave: writer changed before the next lease poll, stale new save refused PASS');
});
