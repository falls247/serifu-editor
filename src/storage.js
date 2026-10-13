import {activeProjectSnapshot,projectSnapshotImages,projectSnapshotMasks} from './project-history.js';
import {checkAbort} from './bulk-task.js';
import {assetFromEncoded,maskAssetMetadata,maxMaskPayloadBytes} from './mask-codec.js';
import {MAX_PROJECT_MASK_DECODED_BYTES} from './project-io.js';
const DB_NAME='serifu-editor-drafts', DB_VERSION=3;
let connection;
function validateMaskBudget(metadata){
  let decoded=0,compressed=0;
  for(const asset of metadata){
    const maximum=maxMaskPayloadBytes(asset);
    if(!Number.isSafeInteger(asset.byteLength)||asset.byteLength<=0||asset.byteLength>maximum)throw new Error('一時保存のマスクサイズが不正');
    decoded+=asset.bbox.width*asset.bbox.height;compressed+=asset.byteLength;
    if(!Number.isSafeInteger(decoded)||!Number.isSafeInteger(compressed)||decoded>MAX_PROJECT_MASK_DECODED_BYTES||compressed>MAX_PROJECT_MASK_DECODED_BYTES)throw new Error('一時保存のマスク総量が上限を超える');
  }
}
function requestResult(request) { return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);}); }
function completed(transaction) { return new Promise((resolve,reject)=>{transaction.oncomplete=resolve;transaction.onabort=()=>reject(transaction.error||new Error('一時保存を中断'));transaction.onerror=()=>{};}); }
async function database() {
  if(!globalThis.indexedDB)throw new Error('このブラウザでは一時保存を利用できない');
  if(!connection) connection=new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains('drafts'))db.createObjectStore('drafts',{keyPath:'key'});
      if(!db.objectStoreNames.contains('images'))db.createObjectStore('images',{keyPath:'id'});
      if(!db.objectStoreNames.contains('masks'))db.createObjectStore('masks',{keyPath:'key'});
      for(const [name,keyPath] of [['projects','projectId'],['snapshots','id'],['latest','projectId'],['history','historyId'],['imageAssets','assetId'],['maskAssetsV2','assetId'],['locks','projectId'],['projectViewers','key']])if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath});
    };
    request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();connection=null;};resolve(db);};
    request.onerror=()=>{connection=null;reject(request.error);};request.onblocked=()=>{connection=null;reject(new Error('他のタブが一時保存を使用中'));};
  });
  return connection;
}
export const openDraftDatabase=()=>database();
export async function getDraftMeta() {const versioned=await activeProjectSnapshot();if(versioned)return versioned.meta;const db=await database(),tx=db.transaction('drafts','readonly'),done=completed(tx);const data=await requestResult(tx.objectStore('drafts').get('current'));await done;return data||null;}
export async function getImageIds() {const versioned=await activeProjectSnapshot();if(versioned)return new Set(versioned.images.map(x=>x.pageId));const db=await database(),tx=db.transaction('images','readonly'),done=completed(tx);const ids=await requestResult(tx.objectStore('images').getAllKeys());await done;return new Set(ids);}
export async function saveDraft(meta,newImages,{signal,onProgress=()=>{},masks=[]}={}) {
  checkAbort(signal);
  validateMaskBudget(masks.map(record=>record.asset));
  const maskRecords=[];
  const pageIds=new Set(meta.pages.map(page=>page.id)),recordKeys=new Set();
  for(const record of masks){
    checkAbort(signal);
    if(!record||!pageIds.has(record.pageId)||record.id!==record.asset?.id)throw new Error('一時保存のマスク参照が不正');
    const key=JSON.stringify([record.pageId,record.id]);
    if(recordKeys.has(key))throw new Error('一時保存のマスク参照が重複');
    recordKeys.add(key);
    const asset=await assetFromEncoded(record.asset);
    maskRecords.push({key,pageId:record.pageId,id:record.id,metadata:maskAssetMetadata(asset),blob:new Blob([asset.data],{type:'application/octet-stream'})});
  }
  for(const page of meta.pages)for(const effect of page.maskEffects||[])if(!recordKeys.has(JSON.stringify([page.id,effect.assetId])))throw new Error('一時保存のマスクが不足');
  checkAbort(signal);
  const db=await database(),tx=db.transaction(['drafts','images','masks'],'readwrite'),done=completed(tx);
  const images=tx.objectStore('images'),keep=new Set(meta.pages.map(p=>p.id));
  // 確定素材の現行スナップショットを同一トランザクションで置換する。
  tx.objectStore('masks').put({key:'current',records:maskRecords});
  const abort=()=>{try{tx.abort();}catch{}};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  let prepared=0;for(const image of newImages){const request=images.put(image);request.onsuccess=()=>onProgress(++prepared,newImages.length);}
  const keys=images.getAllKeys();keys.onsuccess=()=>{const present=new Set(keys.result);if(meta.pages.some(p=>!present.has(p.id)))abort();};
  const cursor=images.openCursor();cursor.onsuccess=()=>{const value=cursor.result;if(value){if(!keep.has(value.key))value.delete();value.continue();}};
  tx.objectStore('drafts').put({...meta,key:'current'});try{await done;}catch(error){if(signal?.aborted)throw signal.reason;throw error;}finally{signal?.removeEventListener('abort',abort);}
}
export async function getDraftImages(ids) {
  const versioned=await activeProjectSnapshot();if(versioned)return projectSnapshotImages(versioned,ids);
  const db=await database(),tx=db.transaction('images','readonly'),done=completed(tx);
  const values=await Promise.all(ids.map(id=>requestResult(tx.objectStore('images').get(id))));await done;
  if(values.some(v=>!v?.blob))throw new Error('一時保存の画像が不足');return values;
}
export async function getDraftMasks(pageIds) {
  const versioned=await activeProjectSnapshot();if(versioned)return projectSnapshotMasks(versioned,pageIds);
  const db=await database(),tx=db.transaction('masks','readonly'),done=completed(tx);
  const snapshot=await requestResult(tx.objectStore('masks').get('current'));await done;
  const pages=new Set(pageIds),result=[],seen=new Set();
  const records=(snapshot?.records||[]).filter(record=>pages.has(record.pageId));
  validateMaskBudget(records.map(record=>record.metadata));
  for(const record of records){
    const key=JSON.stringify([record.pageId,record.id]);
    if(seen.has(key)||!(record.blob instanceof Blob)||record.blob.size!==record.metadata?.byteLength||record.id!==record.metadata?.id)throw new Error('一時保存のマスク参照が不正');
    seen.add(key);
    const asset=await assetFromEncoded({...record.metadata,data:new Uint8Array(await record.blob.arrayBuffer())});
    result.push({pageId:record.pageId,id:record.id,asset});
  }
  return result;
}
export async function clearDraft() {
  const db=await database(),tx=db.transaction(['drafts','images','masks','latest'],'readwrite'),done=completed(tx);
  const active=await requestResult(tx.objectStore('drafts').get('active'));
  if(active?.projectId)tx.objectStore('latest').delete(active.projectId);
  tx.objectStore('drafts').clear();tx.objectStore('images').clear();tx.objectStore('masks').put({key:'current',records:[]});await done;
}
