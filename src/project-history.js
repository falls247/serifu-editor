// Versioned project vault. Legacy v2 draft stores are retained for safe fallback.
import {openDraftDatabase} from './storage.js';
import {assetFromEncoded,maskAssetMetadata} from './mask-codec.js';
import {validProjectId} from './project-identity.js';
import {checkAbort} from './bulk-task.js';

const read=request=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
const finished=tx=>new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error||new Error('保存トランザクションが中断'));tx.onerror=()=>{};});
const digest=async blob=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
const snapshotId=()=>crypto.randomUUID();
const cleanMeta=meta=>structuredClone(meta);

export async function activeProjectSnapshot(){
  const db=await openDraftDatabase(),tx=db.transaction(['drafts','latest','snapshots'],'readonly'),done=finished(tx);
  const active=await read(tx.objectStore('drafts').get('active'));
  const pointer=active?.projectId?await read(tx.objectStore('latest').get(active.projectId)):null;
  const snapshot=pointer?await read(tx.objectStore('snapshots').get(pointer.snapshotId)):null;
  await done;
  if(pointer&&!snapshot)throw new Error('最新スナップショットの参照が破損');
  return snapshot||null;
}
export async function projectImageIds(projectId){
  const snapshot=await activeProjectSnapshot();
  return new Set(snapshot?.projectId===projectId?snapshot.images.map(record=>record.pageId):[]);
}
export async function projectSnapshotImages(snapshot,ids){
  if(!snapshot)return [];
  const byPage=new Map(snapshot.images.map(record=>[record.pageId,record.assetId]));
  const db=await openDraftDatabase(),tx=db.transaction('imageAssets','readonly'),done=finished(tx);
  const images=await Promise.all(ids.map(id=>read(tx.objectStore('imageAssets').get(byPage.get(id)))));
  await done;
  if(images.some(item=>!(item?.blob instanceof Blob)))throw new Error('保存済み画像が不足');
  return images.map((item,i)=>({id:ids[i],blob:item.blob}));
}
export async function projectSnapshotMasks(snapshot,pageIds){
  if(!snapshot)return [];
  const included=new Set(pageIds),records=snapshot.masks.filter(record=>included.has(record.pageId));
  const db=await openDraftDatabase(),tx=db.transaction('maskAssetsV2','readonly'),done=finished(tx);
  const data=await Promise.all(records.map(record=>read(tx.objectStore('maskAssetsV2').get(record.assetId))));
  await done;
  if(data.some(item=>!(item?.blob instanceof Blob)))throw new Error('保存済みマスクが不足');
  const result=[];
  for(let i=0;i<data.length;i++){
    const record=records[i],item=data[i];
    if(item.blob.size!==item.metadata.byteLength)throw new Error('保存済みマスクのサイズ不一致');
    const asset=await assetFromEncoded({...item.metadata,id:record.id,data:new Uint8Array(await item.blob.arrayBuffer())});
    result.push({pageId:record.pageId,id:record.id,asset});
  }
  return result;
}
export async function listProjectHistories(projectId){
  const db=await openDraftDatabase(),tx=db.transaction('history','readonly'),done=finished(tx);
  const records=await read(tx.objectStore('history').getAll());await done;
  return records.filter(x=>x.projectId===projectId).sort((a,b)=>b.createdAt-a.createdAt||b.historyId.localeCompare(a.historyId));
}
export async function listStoredProjects(){
  const db=await openDraftDatabase(),tx=db.transaction(['projects','latest'],'readonly'),done=finished(tx);
  const [projects,latest]=await Promise.all([read(tx.objectStore('projects').getAll()),read(tx.objectStore('latest').getAll())]);await done;
  const byId=new Map(latest.map(x=>[x.projectId,x]));
  return projects.map(p=>({...p,latest:byId.get(p.projectId)||null}));
}
export async function getStoredSnapshot(snapshotKey){
  const db=await openDraftDatabase(),tx=db.transaction('snapshots','readonly'),done=finished(tx);
  const snapshot=await read(tx.objectStore('snapshots').get(snapshotKey));await done;
  if(!snapshot)throw new Error('指定した復元世代が見つからない');
  return snapshot;
}
export async function saveProjectSnapshot(meta,newImages,{signal,masks=[],fence=null,history=true}={}){
  checkAbort(signal);
  if(!validProjectId(meta?.projectId)||!Array.isArray(meta.pages)||!Number.isFinite(meta.savedAt))throw new Error('プロジェクト保存メタデータが不正');
  const pageIds=new Set(meta.pages.map(x=>x.id));
  if(pageIds.size!==meta.pages.length||pageIds.has(undefined))throw new Error('ページIDが重複または欠損');
  const imageInputs=new Map();
  for(const image of newImages){
    checkAbort(signal);
    if(!pageIds.has(image.id)||!(image.blob instanceof Blob)||imageInputs.has(image.id))throw new Error('画像の参照またはBlobが不正');
    const hash=await digest(image.blob);imageInputs.set(image.id,{assetId:'image:'+hash+':'+image.blob.type,blob:image.blob,byteLength:image.blob.size,hash});
  }
  const maskInputs=new Map(),maskPages=new Set(),maskRefs=[];
  for(const record of masks){
    checkAbort(signal);
    if(!record||!pageIds.has(record.pageId)||record.id!==record.asset?.id)throw new Error('マスク参照が不正');
    const key=JSON.stringify([record.pageId,record.id]);if(maskPages.has(key))throw new Error('マスク参照の重複');maskPages.add(key);
    const asset=await assetFromEncoded(record.asset),metadata=maskAssetMetadata(asset);
    const blob=new Blob([asset.data],{type:'application/octet-stream'});
    const assetId='mask:'+metadata.sha256+':'+[metadata.imageWidth,metadata.imageHeight,metadata.bbox.x,metadata.bbox.y,metadata.bbox.width,metadata.bbox.height,metadata.codec].join(':');
    maskInputs.set(assetId,{assetId,blob,metadata,byteLength:blob.size});
    maskRefs.push({pageId:record.pageId,id:record.id,assetId});
  }
  for(const p of meta.pages)for(const effect of p.maskEffects||[])if(!maskPages.has(JSON.stringify([p.id,effect.assetId])))throw new Error('マスク素材が不足');
  checkAbort(signal);
  const db=await openDraftDatabase(),tx=db.transaction(['projects','latest','snapshots','history','imageAssets','maskAssetsV2','drafts','locks'],'readwrite'),done=finished(tx);
  const abort=()=>{try{tx.abort();}catch{}};
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  try{
    const [previous,entries,lock,project]=await Promise.all([
      read(tx.objectStore('latest').get(meta.projectId)),
      read(tx.objectStore('history').getAll()),
      read(tx.objectStore('locks').get(meta.projectId)),
      read(tx.objectStore('projects').get(meta.projectId))
    ]);
    if(fence!==null && (!lock||lock.token!==fence.token||lock.owner!==fence.owner||lock.until<Date.now()))throw new Error('編集権を失ったため保存できない');
    if(fence===null&&lock&&lock.until>Date.now())throw new Error('別のタブが編集中のため保存できない');
    const prevSnapshot=previous?await read(tx.objectStore('snapshots').get(previous.snapshotId)):null;
    if(previous&&!prevSnapshot)throw new Error('最新スナップショットの参照が破損');
    const oldImages=new Map(prevSnapshot?.images.map(record=>[record.pageId,record.assetId])||[]);
    const imageRefs=meta.pages.map(page=>{
      const assetId=imageInputs.get(page.id)?.assetId||oldImages.get(page.id);
      if(!assetId)throw new Error('保存対象の原画像が不足: '+page.name);
      return {pageId:page.id,assetId};
    });
    for(const record of imageRefs){
      const asset=imageInputs.get(record.pageId);
      if(!asset&&!await read(tx.objectStore('imageAssets').get(record.assetId)))throw new Error('最新スナップショットの画像参照が破損');
    }
    for(const input of imageInputs.values())tx.objectStore('imageAssets').put(input);
    for(const input of maskInputs.values())tx.objectStore('maskAssetsV2').put(input);
    const id=snapshotId(),createdAt=Date.now();
    const snapshot={id,projectId:meta.projectId,createdAt,meta:cleanMeta(meta),images:imageRefs,masks:maskRefs};
    const own=entries.filter(x=>x.projectId===meta.projectId).sort((a,b)=>b.createdAt-a.createdAt);
    const prior=own[0];
    const changed=!prevSnapshot||JSON.stringify({
      pages:prevSnapshot.meta.pages,preferences:prevSnapshot.meta.preferences,images:prevSnapshot.images,masks:prevSnapshot.masks
    })!==JSON.stringify({pages:meta.pages,preferences:meta.preferences,images:imageRefs,masks:maskRefs});
    const shouldHistory=history&&(!prior||createdAt-prior.createdAt>=300000)&&changed;
    tx.objectStore('snapshots').put(snapshot);
    tx.objectStore('projects').put({projectId:meta.projectId,name:meta.sourceFolderName||'名称未設定',updatedAt:createdAt,createdAt:project?.createdAt||createdAt});
    tx.objectStore('latest').put({projectId:meta.projectId,snapshotId:id,revision:meta.revision??0,savedAt:meta.savedAt});
    tx.objectStore('drafts').put({key:'active',projectId:meta.projectId});
    if(shouldHistory)tx.objectStore('history').put({historyId:snapshotId(),projectId:meta.projectId,createdAt,snapshotId:id});
    const kept=shouldHistory?4:5;
    for(const extra of own.slice(kept))tx.objectStore('history').delete(extra.historyId);
    await done;
    return {snapshotId:id,historyCreated:shouldHistory};
  }catch(error){abort();await done.catch(()=>{});throw error;}
  finally{signal?.removeEventListener('abort',abort);}
}
export async function activateStoredProject(projectId,{fence=null}={}){
  const db=await openDraftDatabase(),tx=db.transaction(['latest','locks','drafts'],'readwrite'),complete=finished(tx);
  try{
    const [latest,lock]=await Promise.all([read(tx.objectStore('latest').get(projectId)),read(tx.objectStore('locks').get(projectId))]);
    if(!latest)throw new Error('指定プロジェクトには最新の保存内容がない');
    if(fence&&(!lock||lock.owner!==fence.owner||lock.token!==fence.token||lock.until<Date.now()))throw new Error('編集権を失っている');
    tx.objectStore('drafts').put({key:'active',projectId});await complete;
    return latest;
  }catch(error){try{tx.abort();}catch{}await complete.catch(()=>{});throw error;}
}
export async function restoreProjectHistory(projectId,snapshotKey,{fence=null}={}){
  const snapshot=await getStoredSnapshot(snapshotKey);
  if(snapshot.projectId!==projectId)throw new Error('異なるプロジェクトの復元データ');
  const db=await openDraftDatabase(),tx=db.transaction(['locks','latest','drafts'],'readwrite'),done=finished(tx);
  try{
    const lock=await read(tx.objectStore('locks').get(projectId));
    if(fence!==null&&(!lock||lock.owner!==fence.owner||lock.token!==fence.token||lock.until<Date.now()))throw new Error('編集権を失ったため復元できない');
    if(fence===null&&lock&&lock.until>Date.now())throw new Error('他のタブが編集中');
    tx.objectStore('latest').put({projectId,snapshotId:snapshotKey,revision:snapshot.meta.revision??0,savedAt:Date.now()});
    tx.objectStore('drafts').put({key:'active',projectId});await done;
  }catch(error){try{tx.abort();}catch{}await done.catch(()=>{});throw error;}
  return snapshot;
}
export async function deleteProjectHistory(projectId,historyId,{fence=null}={}){
  const db=await openDraftDatabase(),tx=db.transaction(['locks','history'],'readwrite'),done=finished(tx);
  try{
    const lock=await read(tx.objectStore('locks').get(projectId));
    if(fence!==null&&(!lock||lock.owner!==fence.owner||lock.token!==fence.token||lock.until<Date.now()))throw new Error('編集権がない');
    if(fence===null&&lock&&lock.until>Date.now())throw new Error('他のタブが編集中');
    const record=await read(tx.objectStore('history').get(historyId));
    if(!record||record.projectId!==projectId)throw new Error('復元世代が見つからない');
    tx.objectStore('history').delete(historyId);await done;
  }catch(error){try{tx.abort();}catch{}await done.catch(()=>{});throw error;}
}
export async function collectUnusedProjectAssets(){
  const db=await openDraftDatabase(),tx=db.transaction(['snapshots','latest','history','imageAssets','maskAssetsV2'],'readwrite'),done=finished(tx);
  const [snapshots,latest,history,images,masks]=await Promise.all([
    read(tx.objectStore('snapshots').getAll()),read(tx.objectStore('latest').getAll()),
    read(tx.objectStore('history').getAll()),read(tx.objectStore('imageAssets').getAllKeys()),
    read(tx.objectStore('maskAssetsV2').getAllKeys())
  ]);
  const kept=new Set([...latest.map(x=>x.snapshotId),...history.map(x=>x.snapshotId)]);
  const liveImage=new Set(),liveMask=new Set();
  for(const snapshot of snapshots){
    if(!kept.has(snapshot.id)){tx.objectStore('snapshots').delete(snapshot.id);continue;}
    for(const ref of snapshot.images)liveImage.add(ref.assetId);
    for(const ref of snapshot.masks)liveMask.add(ref.assetId);
  }
  for(const key of images)if(!liveImage.has(key))tx.objectStore('imageAssets').delete(key);
  for(const key of masks)if(!liveMask.has(key))tx.objectStore('maskAssetsV2').delete(key);
  await done;
  return {snapshotsRemoved:snapshots.filter(x=>!kept.has(x.id)).length,imageAssetsRemoved:images.filter(x=>!liveImage.has(x)).length,maskAssetsRemoved:masks.filter(x=>!liveMask.has(x)).length};
}
