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
    const originalPut=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){if(this.name==='latest')throw new DOMException('migration quota fixture','QuotaExceededError');return originalPut.apply(this,args);};
    let rejected=false;
    try{await h.migrateLegacyDraft();}catch{rejected=true;}finally{IDBObjectStore.prototype.put=originalPut;}
    if(!rejected||await h.activeProjectSnapshot())throw Error('failed migration changed active data');
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
  const contracts=await migrationPage.evaluate(async()=>{
    const h=await import('/src/project-history.js'),s=await import('/src/storage.js'),{encodeMask}=await import('/src/mask-codec.js');
    const projectId=crypto.randomUUID(),pageId=crypto.randomUUID(),maskId=crypto.randomUUID(),realNow=Date.now,start=realNow()+1000000;
    const a=await encodeMask(Uint8Array.from([1,0,0,0,1,0,0,0,1]),3,3),b=await encodeMask(Uint8Array.from([0,1,0,1,0,1,0,1,0]),3,3);const maskA={...a,id:maskId},maskB={...b,id:maskId};
    let latest,clock=start;
    const meta=text=>({version:14,projectId,savedAt:clock,preferences:{},pages:[{id:pageId,name:'source',layers:[{text}],maskEffects:[{assetId:maskId}]}]});
    Date.now=()=>clock;
    try{
      const first=await h.saveProjectSnapshot(meta('A'),[{id:pageId,blob:new Blob(['image A'])}],{masks:[{pageId,id:maskId,asset:maskA}]});
      for(let i=0;i<20;i++){clock+=100;latest=await h.saveProjectSnapshot(meta('step '+i),[],{masks:[{pageId,id:maskId,asset:maskA}]});}
      if((await h.listProjectHistories(projectId)).length!==1)throw Error('rapid confirmations created history');
      clock=start+300001;latest=await h.saveProjectSnapshot(meta('B'),[{id:pageId,blob:new Blob(['image B'])}],{masks:[{pageId,id:maskId,asset:maskB}]});
      for(let i=2;i<6;i++){clock+=300001;latest=await h.saveProjectSnapshot(meta('generation '+i),[],{masks:[{pageId,id:maskId,asset:maskB}]});}
      const history=await h.listProjectHistories(projectId);if(history.length!==5)throw Error('rotation count');if(history.some(x=>x.snapshotId===first.snapshotId))throw Error('sixth did not drop oldest');
      clock+=300001;const same=await h.saveProjectSnapshot(meta('generation 5'),[],{masks:[{pageId,id:maskId,asset:maskB}]});if(same.historyCreated)throw Error('same state created history');
      const before=await h.latestProjectSnapshot(projectId),originalPut=IDBObjectStore.prototype.put;
      for(const failure of ['quota','abort']){
        const controller=new AbortController();
        IDBObjectStore.prototype.put=function(...args){if(this.name==='latest'&&failure==='quota')throw new DOMException('simulated quota','QuotaExceededError');const result=originalPut.apply(this,args);if(this.name==='snapshots'&&failure==='abort')controller.abort(new DOMException('simulated shutdown','AbortError'));return result;};
        let rejected=false;try{await h.saveProjectSnapshot(meta('BROKEN'),[{id:pageId,blob:new Blob(['broken'])}],{masks:[{pageId,id:maskId,asset:maskA}],signal:controller.signal});}catch{rejected=true;}finally{IDBObjectStore.prototype.put=originalPut;}
        if(!rejected||(await h.latestProjectSnapshot(projectId)).id!==before.id||(await h.listProjectHistories(projectId)).length!==5)throw Error('failed atomic save changed latest/history');
      }
      // A second project shares immutable bytes, but owns its own logical generations.
      const other=crypto.randomUUID();await h.saveProjectSnapshot({...meta('other'),projectId:other},[{id:pageId,blob:new Blob(['image B'])}],{masks:[{pageId,id:maskId,asset:maskB}]});
      const capacity=(await h.projectStorageReport()).find(p=>p.projectId===projectId),snapshots=await Promise.all([...new Set([capacity.latest.snapshotId,...capacity.history.map(x=>x.snapshotId)])].map(id=>h.getStoredSnapshot(id)));
      const metadataBytes=snapshots.reduce((n,snapshot)=>n+JSON.stringify(snapshot.meta).length*2,0);
      if(capacity.logicalBytes!==metadataBytes+new Blob(['image B']).size+b.byteLength||capacity.reclaimableBytes!==0||capacity.history.some(x=>x.reclaimableBytes!==0))throw Error('capacity double-counted shared assets or offered bytes needed by another generation/project');
      await s.clearDraft({projectId});await h.collectUnusedProjectAssets();if((await h.listProjectHistories(projectId)).length!==5||!await h.latestProjectSnapshot(other))throw Error('clear deleted histories/other project');
      const oldest=history.at(-1),restored=await h.getStoredSnapshot(oldest.snapshotId);await h.restoreProjectHistory(projectId,oldest.snapshotId);
      if(await (await h.projectSnapshotImages(restored,[pageId]))[0].blob.text()!=='image B')throw Error('old image references missing');
      if((await h.projectSnapshotMasks(restored,[pageId]))[0].asset.sha256!==b.sha256)throw Error('historical mask missing');
      await h.deleteProjectHistory(projectId,oldest.historyId);await h.collectUnusedProjectAssets();if(!await h.getStoredSnapshot(oldest.snapshotId))throw Error('GC deleted the active restored generation');
      const db=await s.openDraftDatabase();let tx=db.transaction('latest','readwrite');tx.objectStore('latest').put({projectId:'broken-reference',snapshotId:'missing'});await new Promise(resolve=>tx.oncomplete=resolve);
      let guarded=false;try{await h.collectUnusedProjectAssets();}catch{guarded=true;}if(!guarded)throw Error('GC did not guard corrupt reference');
      tx=db.transaction('latest','readwrite');tx.objectStore('latest').delete('broken-reference');await new Promise(resolve=>tx.oncomplete=resolve);await h.collectUnusedProjectAssets();
      return {rapidSaves:20,history:5,quota:'rollback',abort:'rollback',masks:'retained',clear:'scoped',gc:'guarded'};
    }finally{Date.now=realNow;}
  });
  console.log('Vault contracts PASS:',contracts);
  // Crash the page with an actual IDB transaction open after its snapshot write.
  const beforeCrash=await migrationPage.evaluate(async()=>{
    const h=await import('/src/project-history.js'),s=await h.activeProjectSnapshot();
    return {projectId:s.projectId,snapshotId:s.id,history:await h.listProjectHistories(s.projectId)};
  });
  await migrationPage.evaluate(async projectId=>{
    const h=await import('/src/project-history.js'),bundle=await h.readProjectBundle(projectId),meta=structuredClone(bundle.snapshot.meta);
    meta.pages[0].name='UNCOMMITTED CRASH';
    const originalPut=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){
      if(this.name==='latest'){
        window.crashTransactionReady=true;
        const store=this,keepOpen=()=>{const request=store.get(projectId);request.onsuccess=keepOpen;};keepOpen();
        return;
      }
      return originalPut.apply(this,args);
    };
    void h.saveProjectSnapshot(meta,[],{masks:bundle.masks}).catch(()=>{});
  },beforeCrash.projectId);
  await migrationPage.waitForFunction(()=>window.crashTransactionReady===true);
  const cdp=await migrationContext.newCDPSession(migrationPage);
  const crashed=once(migrationPage,'crash');void cdp.send('Page.crash').catch(()=>{});await crashed;
  const observer=await migrationContext.newPage();await observer.goto(`http://127.0.0.1:${port}/src/project-history.js`);
  const afterCrash=await observer.evaluate(async projectId=>{
    const h=await import('/src/project-history.js'),bundle=await h.readProjectBundle(projectId);
    return {projectId,snapshotId:bundle.snapshot.id,history:await h.listProjectHistories(projectId),name:bundle.snapshot.meta.pages[0].name};
  },beforeCrash.projectId);
  assert.equal(afterCrash.snapshotId,beforeCrash.snapshotId);assert.deepEqual(afterCrash.history,beforeCrash.history);assert.notEqual(afterCrash.name,'UNCOMMITTED CRASH');
  console.log('Page crash during native IDB save: latest/history/asset bundle retained PASS');
  await migrationContext.close();
  console.log('Project vault browser PASS:',JSON.stringify({initial,history:result.histories,locks:'token fenced',restored:'old bytes',failedSave:'atomic'}));
  await context.close();
}finally{await browser?.close();server.kill('SIGTERM');}
