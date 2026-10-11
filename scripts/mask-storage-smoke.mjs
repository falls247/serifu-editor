import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
const { chromium }=createRequire(import.meta.url)('playwright');
const port=5246,server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:String(port)},stdio:['ignore','pipe','inherit']});
let browser;
try{
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw new Error('Storage server failed to start');})]);
  browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto(`http://127.0.0.1:${port}/src/storage.js`);
  const result=await page.evaluate(async()=>{
    const open=indexedDB.open('serifu-editor-drafts',1);
    await new Promise((resolve,reject)=>{open.onupgradeneeded=()=>{open.result.createObjectStore('drafts',{keyPath:'key'});open.result.createObjectStore('images',{keyPath:'id'});};open.onsuccess=resolve;open.onerror=()=>reject(open.error);});
    const legacy=open.result,tx=legacy.transaction('drafts','readwrite');tx.objectStore('drafts').put({key:'current',version:11,pages:[],legacy:'kept'});await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});legacy.close();
    const storage=await import('/src/storage.js'),{encodeMask}=await import('/src/mask-codec.js');
    const migrated=await storage.getDraftMeta();if(migrated.legacy!=='kept')throw new Error('v1 migration lost metadata');
    const asset=await encodeMask(Uint8Array.from([0,1,0,1,1,0,0,0,0]),3,3);
    const meta={version:12,pages:[{id:'p1',name:'original',maskEffects:[{assetId:asset.id}]}]};
    await storage.saveDraft(meta,[{id:'p1',blob:new Blob(['original pixels'])}],{masks:[{pageId:'p1',id:asset.id,asset}]});
    const restored=await storage.getDraftMasks(['p1']);
    const valid=restored.length===1&&restored[0].asset.sha256===asset.sha256&&restored[0].asset.decoded.every((v,i)=>v===asset.decoded[i]);
    let failures=0;
    for(const options of [{masks:[]},{masks:[{pageId:'p1',id:asset.id,asset:{...asset,sha256:'0'.repeat(64)}}]},{masks:[{pageId:'foreign',id:asset.id,asset}]}]){
      try{await storage.saveDraft({...meta,pages:[{...meta.pages[0],name:'broken'}]},[],options);throw new Error('Invalid save unexpectedly succeeded');}catch(error){if(error.message==='Invalid save unexpectedly succeeded')throw error;failures++;}
      if((await storage.getDraftMeta()).pages[0].name!=='original')throw new Error('Failed save damaged previous draft');
    }
    const controller=new AbortController();controller.abort(new DOMException('cancelled','AbortError'));
    try{await storage.saveDraft(meta,[],{signal:controller.signal,masks:[{pageId:'p1',id:asset.id,asset}]});throw new Error('Aborted save succeeded');}catch(error){if(error.name!=='AbortError')throw error;failures++;}
    const largeRecords=Array.from({length:269},(_,i)=>({pageId:'p1',id:`large-${i}`,asset:{id:`large-${i}`,imageWidth:1000,imageHeight:1000,bbox:{x:0,y:0,width:1000,height:1000},codec:'rle32le-v1',byteLength:8,sha256:'0'.repeat(64),data:new Uint8Array(8)}}));
    try{await storage.saveDraft(meta,[],{masks:largeRecords});throw new Error('Oversized draft succeeded');}catch(error){if(!error.message.includes('総量が上限'))throw error;failures++;}
    const image=await storage.getDraftImages(['p1']);if(await image[0].blob.text()!=='original pixels')throw new Error('Original bytes changed');
    await storage.saveDraft({version:12,pages:[{id:'p1',maskEffects:[]}]},[]);
    const released=(await storage.getDraftMasks(['p1'])).length===0;
    await storage.clearDraft();
    return {valid,failures,released,cleared:await storage.getDraftMeta()===null};
  });
  assert.deepEqual(result,{valid:true,failures:5,released:true,cleared:true});console.log('IndexedDB v1→v2 migration, mask roundtrip, rollback, abort and release: PASS');
}finally{await browser?.close();server.kill('SIGTERM');}
