import {checkAbort} from './bulk-task.js';
const DB_NAME='serifu-editor-drafts', DB_VERSION=1;
let connection;
function requestResult(request) { return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);}); }
function completed(transaction) { return new Promise((resolve,reject)=>{transaction.oncomplete=resolve;transaction.onabort=()=>reject(transaction.error||new Error('一時保存を中断'));transaction.onerror=()=>{};}); }
async function database() {
  if(!globalThis.indexedDB)throw new Error('このブラウザでは一時保存を利用できない');
  if(!connection) connection=new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,DB_VERSION);
    request.onupgradeneeded=()=>{const db=request.result;db.createObjectStore('drafts',{keyPath:'key'});db.createObjectStore('images',{keyPath:'id'});};
    request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();connection=null;};resolve(db);};
    request.onerror=()=>{connection=null;reject(request.error);};request.onblocked=()=>{connection=null;reject(new Error('他のタブが一時保存を使用中'));};
  });
  return connection;
}
export async function getDraftMeta() {const db=await database(),tx=db.transaction('drafts','readonly'),done=completed(tx);const data=await requestResult(tx.objectStore('drafts').get('current'));await done;return data||null;}
export async function getImageIds() {const db=await database(),tx=db.transaction('images','readonly'),done=completed(tx);const ids=await requestResult(tx.objectStore('images').getAllKeys());await done;return new Set(ids);}
export async function saveDraft(meta,newImages,{signal,onProgress=()=>{}}={}) {
  checkAbort(signal);
  const db=await database(),tx=db.transaction(['drafts','images'],'readwrite'),done=completed(tx);
  const images=tx.objectStore('images'),keep=new Set(meta.pages.map(p=>p.id));
  const abort=()=>{try{tx.abort();}catch{}};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  let prepared=0;for(const image of newImages){const request=images.put(image);request.onsuccess=()=>onProgress(++prepared,newImages.length);}
  const keys=images.getAllKeys();keys.onsuccess=()=>{const present=new Set(keys.result);if(meta.pages.some(p=>!present.has(p.id)))abort();};
  const cursor=images.openCursor();cursor.onsuccess=()=>{const value=cursor.result;if(value){if(!keep.has(value.key))value.delete();value.continue();}};
  tx.objectStore('drafts').put({...meta,key:'current'});try{await done;}catch(error){if(signal?.aborted)throw signal.reason;throw error;}finally{signal?.removeEventListener('abort',abort);}
}
export async function getDraftImages(ids) {
  const db=await database(),tx=db.transaction('images','readonly'),done=completed(tx);
  const values=await Promise.all(ids.map(id=>requestResult(tx.objectStore('images').get(id))));await done;
  if(values.some(v=>!v?.blob))throw new Error('一時保存の画像が不足');return values;
}
export async function clearDraft() {const db=await database(),tx=db.transaction(['drafts','images'],'readwrite'),done=completed(tx);tx.objectStore('drafts').clear();tx.objectStore('images').clear();await done;}
