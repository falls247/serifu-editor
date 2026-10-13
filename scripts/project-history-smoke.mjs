import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {once} from 'node:events';
const {chromium}=createRequire(import.meta.url)('playwright');
const port=5274,server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','inherit']});
let browser;
try{
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw new Error('project vault server exit');})]);
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext(),page=await context.newPage(),second=await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/src/project-history.js`);
  await second.goto(`http://127.0.0.1:${port}/src/project-history.js`);
  const initial=await page.evaluate(async()=>{
    const open=indexedDB.open('serifu-editor-drafts',2);
    await new Promise((resolve,reject)=>{
      open.onupgradeneeded=()=>{const db=open.result;for(const [name,keyPath] of [['drafts','key'],['images','id'],['masks','key']])if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath});};
      open.onsuccess=resolve;open.onerror=()=>reject(open.error);
    });
    const db=open.result,tx=db.transaction(['drafts','images'],'readwrite');
    tx.objectStore('drafts').put({key:'current',version:13,pages:[],legacy:'preserved'});
    await new Promise(resolve=>tx.oncomplete=resolve);db.close();
    const storage=await import('/src/storage.js');
    if((await storage.getDraftMeta())?.legacy!=='preserved')throw Error('v2 draft unreadable');
    const db3=await storage.openDraftDatabase();
    if(db3.version!==3||!db3.objectStoreNames.contains('history'))throw Error('missing v3 schema');
    return true;
  });
  const projectId='fa076475-7256-4c17-8d8b-3cbcbf2d93f9',pageId='a3c84564-3bbd-4971-9401-0123456789ab';
  const result=await page.evaluate(async({projectId,pageId})=>{
    const h=await import('/src/project-history.js'),storage=await import('/src/storage.js');
    const meta={projectId,version:14,savedAt:Date.now(),pages:[{id:pageId,name:'sample',layers:[{text:'A'}],maskEffects:[]}]};
    const first=await h.saveProjectSnapshot(meta,[{id:pageId,blob:new Blob(['pixels-A'],{type:'image/png'})}]);
    if(!first.historyCreated)throw Error('first generation was not recorded');
    const image1=(await storage.getDraftImages([pageId]))[0];
    if(await image1.blob.text()!=='pixels-A')throw Error('wrong latest A image');
    const second=await h.saveProjectSnapshot({...meta,pages:[{...meta.pages[0],layers:[{text:'B'}]}]},[]);
    if(second.historyCreated)throw Error('rapid save created extra history');
    const previousNow=Date.now,clock=previousNow()+300002;Date.now=()=>clock;
    let third;
    try{third=await h.saveProjectSnapshot({...meta,savedAt:clock,pages:[{...meta.pages[0],layers:[{text:'C'}]}]},[{id:pageId,blob:new Blob(['pixels-C'],{type:'image/png'})}]);}
    finally{Date.now=previousNow;}
    const history=await h.listProjectHistories(projectId);
    if(history.length!==2||!third.historyCreated)throw Error('five minute generation policy broken');
    const retained=await h.getStoredSnapshot(first.snapshotId);
    if(await (await h.projectSnapshotImages(retained,[pageId]))[0].blob.text()!=='pixels-A')throw Error('history lost old image');
    const failed=await h.saveProjectSnapshot({...meta,pages:[{...meta.pages[0],name:'broken',maskEffects:[{assetId:'absent'}]}]},[],{masks:[]}).then(()=>false,()=>true);
    if(!failed||(await storage.getDraftMeta()).pages[0].layers[0].text!=='C')throw Error('rollback damaged latest');
    await h.restoreProjectHistory(projectId,first.snapshotId);
    if((await storage.getDraftMeta()).pages[0].layers[0].text!=='A')throw Error('restoration missed metadata');
    if((await h.listProjectHistories(projectId)).length!==2)throw Error('restoration changed generations');
    await h.collectUnusedProjectAssets();
    const still=await h.getStoredSnapshot(third.snapshotId);
    if(!still||await (await h.projectSnapshotImages(still,[pageId]))[0].blob.text()!=='pixels-C')throw Error('GC removed referenced history');
    return {first,second,third,histories:history.length};
  },{projectId,pageId});
  const a=await page.evaluate(async projectId=>{
    const lock=await import('/src/project-lock.js');
    await lock.signalProjectActivity(projectId,lock.tabIdentity,{interaction:true});
    return lock.claimProjectLease(projectId,lock.tabIdentity);
  },projectId);
  assert.equal(a.held,true);
  const b=await second.evaluate(async projectId=>{
    const lock=await import('/src/project-lock.js');
    await lock.signalProjectActivity(projectId,lock.tabIdentity,{interaction:true});
    return lock.claimProjectLease(projectId,lock.tabIdentity);
  },projectId);
  assert.equal(b.held,false);
  await page.evaluate(async projectId=>{
    const lock=await import('/src/project-lock.js');await lock.releaseProjectLease(projectId,lock.tabIdentity);
  },projectId);
  const ownership=await second.evaluate(async projectId=>{
    const lock=await import('/src/project-lock.js');
    return lock.claimProjectLease(projectId,lock.tabIdentity);
  },projectId);
  assert.equal(ownership.held,true);assert.ok(ownership.token>a.token);
  const fenced=await page.evaluate(async({projectId,pageId,owner,token})=>{
    const h=await import('/src/project-history.js');
    const before=(await h.activeProjectSnapshot()).meta.pages[0].layers[0].text;
    let denied=false;
    try{await h.saveProjectSnapshot({version:14,projectId,savedAt:Date.now(),pages:[{id:pageId,layers:[{text:'STALE'}],maskEffects:[]}]},[],{fence:{owner,token}});}
    catch{denied=true;}
    return denied&&(await h.activeProjectSnapshot()).meta.pages[0].layers[0].text===before;
  },{projectId,pageId,owner:a.owner,token:a.token});
  assert.equal(fenced,true,'stale owner must never replace latest');
  // A real v2 draft is migrated once, without deleting old sources.
  const migrationContext=await browser.newContext(),migrationPage=await migrationContext.newPage();
  await migrationPage.goto(`http://127.0.0.1:${port}/src/project-history.js`);
  const migrated=await migrationPage.evaluate(async()=>{
    const pageId='c5cc5773-b88e-4de0-b616-af946d7a24e1',original='pixels-from-v2';
    const request=indexedDB.open('serifu-editor-drafts',2);
    const db=await new Promise((resolve,reject)=>{
      request.onupgradeneeded=()=>{
        for(const [name,keyPath] of [['drafts','key'],['images','id'],['masks','key']])
          if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name,{keyPath});
      };
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    let tx=db.transaction(['drafts','images','masks'],'readwrite');
    tx.objectStore('drafts').put({key:'current',version:13,savedAt:Date.now(),preferences:{},pages:[{id:pageId,name:'v2 image',layers:[],maskEffects:[]}]});
    tx.objectStore('images').put({id:pageId,blob:new Blob([original],{type:'image/png'})});
    tx.objectStore('masks').put({key:'current',records:[]});
    await new Promise(resolve=>tx.oncomplete=resolve);db.close();
    const h=await import('/src/project-history.js'),storage=await import('/src/storage.js');
    if(await h.migrateLegacyDraft()!==true)throw Error('legacy migration did not begin');
    if(await h.migrateLegacyDraft()!==false)throw Error('legacy migration produced duplicate');
    const meta=await storage.getDraftMeta(),old=await(async()=>{
      const d=await storage.openDraftDatabase(),t=d.transaction('drafts','readonly');
      return new Promise((resolve,reject)=>{const q=t.objectStore('drafts').get('current');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
    })();
    const restored=(await storage.getDraftImages([pageId]))[0].blob;
    const history=await h.listProjectHistories(meta.projectId);
    return {metaVersion:meta.version,legacyVersion:old.version,original:await restored.text(),history:history.length};
  });
  assert.deepEqual(migrated,{metaVersion:14,legacyVersion:13,original:'pixels-from-v2',history:1});
  await migrationContext.close();
  console.log('Project vault browser PASS:',JSON.stringify({initial,history:result.histories,locks:'token fenced',restored:'old bytes',failedSave:'atomic'}));
  await context.close();
}finally{await browser?.close();server.kill('SIGTERM');}
