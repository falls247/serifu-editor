// Cross-tab project lease. All acquisition and writes are serialized by IndexedDB.
import {openDraftDatabase} from './storage.js';
const ask=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
const done=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||new Error('編集権トランザクション中断'));});
// A document owns a unique fence identity. Duplicated tabs can copy sessionStorage,
// so session IDs must never grant write ownership. Reloads reacquire after pagehide/expiry.
export const tabIdentity=crypto.randomUUID();
let reloadPredecessor=null;
try{reloadPredecessor=sessionStorage.getItem('serifu.reload-owner');sessionStorage.removeItem('serifu.reload-owner');}catch{}
const LEASE_MS=12000,ACTIVE_MS=30000;
const viewerKey=(projectId,owner)=>JSON.stringify([projectId,owner]);
async function transact(stores,mode,callback){
  const db=await openDraftDatabase(),tx=db.transaction(stores,mode),completed=done(tx);
  try{const result=await callback(tx);await completed;return result;}
  catch(error){try{tx.abort();}catch{}await completed.catch(()=>{});throw error;}
}
export async function signalProjectActivity(projectId,owner=tabIdentity,{interaction=false}={}){
  return transact(['projectViewers'],'readwrite',async tx=>{
    const store=tx.objectStore('projectViewers'),key=viewerKey(projectId,owner),before=await ask(store.get(key)),now=Date.now();
    store.put({key,projectId,owner,lastSeen:now,lastActivity:interaction?now:before?.lastActivity||0});
  });
}
export async function claimProjectLease(projectId,owner=tabIdentity){
  return transact(['locks','projectViewers'],'readwrite',async tx=>{
    const locks=tx.objectStore('locks'),viewers=tx.objectStore('projectViewers'),now=Date.now();
    const [current,candidates]=await Promise.all([ask(locks.get(projectId)),ask(viewers.getAll())]);
    const others=candidates.filter(x=>x.projectId===projectId&&x.lastSeen>now-ACTIVE_MS&&!(current?.until<=now&&x.owner===current?.owner));
    others.sort((a,b)=>b.lastActivity-a.lastActivity||a.owner.localeCompare(b.owner));
    const preferred=others[0]?.owner;
    if(owner===tabIdentity&&reloadPredecessor&&current?.owner===reloadPredecessor){
      viewers.delete(viewerKey(projectId,reloadPredecessor));reloadPredecessor=null;
      const transferred={projectId,owner,token:current.token+1,ownerEpoch:current.token+1,until:now+LEASE_MS};locks.put(transferred);return {held:true,...transferred};
    }
    if(current?.owner===owner&&current.until>now){
      const updated={...current,ownerEpoch:current.ownerEpoch??current.token,until:now+LEASE_MS};locks.put(updated);
      return {held:true,...updated};
    }
    if(current?.owner&&current.until>now)return {held:false,owner:current.owner,token:current.token,until:current.until};
    if(preferred&&preferred!==owner)return {held:false,owner:preferred,token:current?.token||0,until:0};
    const token=(current?.token||0)+1;
    // Same-document expiry may interrupt expensive hashing. Track uninterrupted
    // ownership separately from the strict token required by every write.
    const ownerEpoch=current?.owner===owner?(current.ownerEpoch??current.token):token;
    const record={projectId,owner,token,ownerEpoch,until:now+LEASE_MS};
    locks.put(record);return {held:true,...record};
  });
}
export async function inspectProjectLease(projectId){
  return transact(['locks'],'readonly',async tx=>await ask(tx.objectStore('locks').get(projectId))||null);
}
export async function releaseProjectLease(projectId,owner=tabIdentity){
  return transact(['locks','projectViewers'],'readwrite',async tx=>{
    const locks=tx.objectStore('locks'),current=await ask(locks.get(projectId));
    tx.objectStore('projectViewers').delete(viewerKey(projectId,owner));
    if(current?.owner===owner)locks.put({...current,until:0,owner:null});
  });
}
