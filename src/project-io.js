import {checkAbort,yieldToBrowser} from './bulk-task.js';
import {PROJECT_VERSION,normalizeMaskEffects} from './model.js';
import {assetFromEncoded,maskAssetMetadata,maskBytesToBase64,maxMaskPayloadBytes,verifyMaskAsset} from './mask-codec.js';
const MAGIC=new Uint8Array([0x53,0x45,0x52,0x49,0x46,0x55,0,1]);
export const MANIFEST_LIMIT=16*1024**2;
export const MAX_PROJECT_MASK_DECODED_BYTES=256*1024**2;
export const MAX_PROJECT_MASK_COMPRESSED_BYTES=256*1024**2;
const mimePattern=/^image\/(png|jpeg|webp|gif|avif)$/;

function addMaskProjectBytes(totals, metadata) {
  maxMaskPayloadBytes(metadata);
  if (!Number.isSafeInteger(metadata.byteLength) || metadata.byteLength <= 0) throw new Error('マスクbyteLengthが不正');
  const decoded = totals.decoded + metadata.bbox.width * metadata.bbox.height, compressed = totals.compressed + metadata.byteLength;
  if (!Number.isSafeInteger(decoded) || decoded > MAX_PROJECT_MASK_DECODED_BYTES) throw new Error('プロジェクトの展開済みマスク総量が上限を超える');
  if (!Number.isSafeInteger(compressed) || compressed > MAX_PROJECT_MASK_COMPRESSED_BYTES) throw new Error('プロジェクトの圧縮マスク総量が上限を超える');
  return { decoded, compressed };
}

function addAssetsMaskBytes(totals, assets) {
  for (const asset of Object.values(assets)) totals = addMaskProjectBytes(totals, asset);
  return totals;
}

function validateJSONMaskBudget(pages) {
  let totals = { decoded: 0, compressed: 0 };
  for (const page of pages) for (const asset of Object.values(page.maskAssets ?? {})) {
    const maxLength = maxMaskPayloadBytes(asset);
    if (typeof asset.dataBase64 !== 'string' || asset.data !== undefined || asset.dataBase64.length > Math.ceil(maxLength / 3) * 4) throw new Error('マスクBase64が上限を超える');
    totals = addMaskProjectBytes(totals, asset);
  }
}
export async function originalBlob(page){if(page.assetBlob||page.file)return page.assetBlob||page.file;const response=await fetch(page.src);if(!response.ok)throw new Error(`元画像を読めない: ${page.name}`);return response.blob();}
export function blobDataURL(blob,signal){return new Promise((resolve,reject)=>{checkAbort(signal);const reader=new FileReader();const abort=()=>reader.abort();const cleanup=()=>signal?.removeEventListener('abort',abort);reader.onload=()=>{cleanup();resolve(reader.result);};reader.onerror=()=>{cleanup();reject(reader.error);};reader.onabort=()=>{cleanup();reject(signal?.reason||new DOMException('中断','AbortError'));};signal?.addEventListener('abort',abort,{once:true});reader.readAsDataURL(blob);});}
let jsonWorker=null,jsonDisabled=false;
const jsonJobs=new Map();
function stopJSON(error){jsonWorker?.terminate();jsonWorker=null;for(const job of [...jsonJobs.values()])job.finish(error);}
export async function projectJSON(kind,payload,{signal,operationId=crypto.randomUUID()}={}){
  checkAbort(signal);
  if(!jsonDisabled&&typeof Worker!=='undefined'&&!jsonWorker){try{
    jsonWorker=new Worker(new URL('./project-worker.js',import.meta.url),{type:'module'});
    jsonWorker.onmessage=({data})=>{const job=jsonJobs.get(data.jobId);if(job?.operationId===data.operationId)job.finish(data.error?new Error(data.error):null,data.value);};
    jsonWorker.onerror=event=>{event.preventDefault();jsonDisabled=true;const error=new Error(event.message||'編集データWorkerが終了');error.workerUnavailable=true;stopJSON(error);};
    jsonWorker.onmessageerror=()=>stopJSON(new Error('編集データWorkerの応答が不正'));
  }catch{jsonDisabled=true;}}
  if(!jsonWorker){await yieldToBrowser();checkAbort(signal);return kind==='parse'?JSON.parse(await payload.text()):JSON.stringify(payload);}
  return new Promise((resolve,reject)=>{const jobId=crypto.randomUUID();
    const abort=()=>stopJSON(signal.reason);
    const timer=setTimeout(()=>stopJSON(new Error('編集データの処理がタイムアウト')),120000);
    const finish=(error,value)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);jsonJobs.delete(jobId);error?reject(error):resolve(value);};
    jsonJobs.set(jobId,{operationId,finish});signal?.addEventListener('abort',abort,{once:true});
    try{jsonWorker.postMessage({operationId,jobId,kind,payload});}catch(error){finish(error);}
  }).catch(async error=>{if(!error.workerUnavailable)throw error;await yieldToBrowser();checkAbort(signal);return kind==='parse'?JSON.parse(await payload.text()):JSON.stringify(payload);});
}

function pageMaskPlan(page) {
  const effects = page.maskEffects ?? [];
  if (!effects.length) return { effects: [], assets: {}, imageWidth: page.img?.width, imageHeight: page.img?.height };
  if (!page.maskAssets || typeof page.maskAssets !== 'object') throw new Error(`マスク素材がない: ${page.name}`);
  const width = page.img?.width, height = page.img?.height, assetIds = new Set(Object.keys(page.maskAssets));
  const normalized = normalizeMaskEffects(effects, width, height, assetIds), used = new Set(normalized.map(effect => effect.assetId)), assets = {};
  for (const id of used) {
    const asset = page.maskAssets[id];
    if (!asset || asset.id !== id) throw new Error('マスクassetのmap keyとIDが一致しない');
    assets[id] = asset;
  }
  return { effects: normalized, assets, imageWidth: width, imageHeight: height };
}

async function verifyMaskPlan(plan) {
  for (const [id, asset] of Object.entries(plan.assets)) {
    if (!asset || asset.id !== id) throw new Error('マスクassetのmap keyとIDが一致しない');
    await verifyMaskAsset(asset, { imageWidth: plan.imageWidth, imageHeight: plan.imageHeight });
  }
  return plan;
}

async function jsonMaskAssets(assets) {
  return Object.fromEntries(await Promise.all(Object.entries(assets).map(async ([id, asset]) => [id, {
    ...maskAssetMetadata(asset), dataBase64: maskBytesToBase64(asset.data),
  }])));
}

function referencedMaskAssets(effects, assets) {
  return Object.fromEntries([...new Set(effects.map(effect => effect.assetId))].map(id => [id, assets[id]]));
}

function createDecodedAssets(entries, imageWidth, imageHeight) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('JSONマスクasset一覧が不正');
  return Promise.all(Object.entries(entries).map(async ([id, asset]) => {
    if (!id || id.length > 200 || ['__proto__','constructor','prototype'].includes(id) || !asset || typeof asset !== 'object' || Array.isArray(asset)
        || typeof asset.dataBase64 !== 'string' || asset.data !== undefined || !Number.isSafeInteger(asset.byteLength) || asset.byteLength <= 0) throw new Error('JSONマスクassetが不正');
    const decoded = await assetFromEncoded({ ...asset, id: asset.id ?? id });
    if (decoded.id !== id) throw new Error('JSONマスクasset IDが一致しない');
    if (decoded.imageWidth !== imageWidth || decoded.imageHeight !== imageHeight) throw new Error('マスク画像寸法が一致しない');
    return [id, decoded];
  })).then(Object.fromEntries);
}

export async function* projectParts(pages,preferences,{format='serifu',task,sourceFolderName}={}){
  const signal=task?.signal;checkAbort(signal);
  task?.stage(format==='json'?'JSON変換':'原画像収録',pages.length);
  const maskPlans=pages.map(pageMaskPlan);let maskBytes={decoded:0,compressed:0};
  for(const plan of maskPlans)maskBytes=addAssetsMaskBytes(maskBytes,plan.assets);
  if(format==='json'){
    const folder=typeof sourceFolderName==='string'&&sourceFolderName?`,"sourceFolderName":${await projectJSON('stringify',sourceFolderName,{signal})}`:'';
    yield `{"version":${PROJECT_VERSION},"preferences":${await projectJSON('stringify',preferences,{signal})}${folder},"pages":[`;
    for(let i=0;i<pages.length;i++){checkAbort(signal);const p=pages[i],src=p.src?.startsWith('data:')?p.src:await blobDataURL(await originalBlob(p),signal),mask=await verifyMaskPlan(maskPlans[i]);
      const record={name:p.name,src,imageWidth:p.img.width,imageHeight:p.img.height,layers:p.layers,done:p.done===true,edited:p.edited===true,...(p.imageEdit?{imageEdit:p.imageEdit}:{}),maskEffects:mask.effects,maskAssets:await jsonMaskAssets(mask.assets)};
      yield (i?',':'')+await projectJSON('stringify',record,{signal});task?.result(p.name);await yieldToBrowser();}
    yield ']}';return;
  }
  const assets=[],blobs=[],records=[],maskAssets=[],maskBlobs=[];
  for(let pageIndex=0;pageIndex<pages.length;pageIndex++){const p=pages[pageIndex];checkAbort(signal);const blob=await originalBlob(p);if(!mimePattern.test(blob.type))throw new Error(`未対応の原画像形式: ${p.name}`);
    const mask=await verifyMaskPlan(maskPlans[pageIndex]);
    records.push({name:p.name,assetIndex:assets.length,layers:p.layers,done:p.done===true,edited:p.edited===true,...(p.imageEdit?{imageEdit:p.imageEdit}:{}),maskEffects:mask.effects});
    assets.push({size:blob.size,mimeType:blob.type,width:p.img.width,height:p.img.height});blobs.push(blob);
    for(const [id,asset] of Object.entries(mask.assets)){maskAssets.push({pageIndex,...maskAssetMetadata(asset)});maskBlobs.push(asset.data);}
    if(blobs.length%20===0)await yieldToBrowser();}
  const manifestData={containerVersion:2,projectVersion:PROJECT_VERSION,preferences,pages:records,assets,maskAssets};
  if(typeof sourceFolderName==='string'&&sourceFolderName)manifestData.sourceFolderName=sourceFolderName;
  const manifest=new TextEncoder().encode(await projectJSON('stringify',manifestData,{signal}));
  if(manifest.byteLength>MANIFEST_LIMIT)throw new Error('編集メタデータが16MiBを超える');
  const header=new Uint8Array(12);header.set(MAGIC);new DataView(header.buffer).setUint32(8,manifest.byteLength,true);yield header;yield manifest;
  for(let i=0;i<blobs.length;i++){checkAbort(signal);yield blobs[i];task?.result(pages[i].name);}
  for(const blob of maskBlobs){checkAbort(signal);yield blob;}
}
export async function projectBlob(pages,preferences,options){const parts=[];for await(const part of projectParts(pages,preferences,options))parts.push(part);checkAbort(options?.task?.signal);return new Blob(parts,{type:options?.format==='json'?'application/json':'application/octet-stream'});}
function validatePages(data,container=false){
  const version=container?data.projectVersion:data.version;
  if(!Number.isInteger(version)||version<(container?6:1)||version>PROJECT_VERSION||!Array.isArray(data.pages)||!data.pages.length)throw new Error('未対応または空の編集データ');
  for(const p of data.pages){if(!p||typeof p.name!=='string'||!Array.isArray(p.layers))throw new Error('画像データが不正');
    if(!container&&(typeof p.src!=='string'||!/^data:image\/(png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/\s]*={0,2}$/.test(p.src)))throw new Error('画像データが不正');
    if(version<12&&(Object.hasOwn(p,'maskEffects')||Object.hasOwn(p,'maskAssets')))throw new Error('旧版データに未対応のマスク情報がある');
    if(version<13&&[...p.layers,...(Array.isArray(p.maskEffects)?p.maskEffects:[])].some(object=>object&&Object.hasOwn(object,'layoutOrder')))throw new Error('旧版データに未対応の重なり順がある');
    if(version>=12){
      if(!container&&![p.imageWidth,p.imageHeight].every(n=>Number.isSafeInteger(n)&&n>0&&n<=30000))throw new Error('JSON画像寸法が不正');
      if(p.maskEffects!==undefined&&!Array.isArray(p.maskEffects))throw new Error('マスク加工一覧が不正');
      if(p.maskAssets!==undefined&&(!p.maskAssets||typeof p.maskAssets!=='object'||Array.isArray(p.maskAssets)))throw new Error('JSONマスクasset一覧が不正');
    }}
}
export async function readProject(file,{signal}={}){
  checkAbort(signal);const head=new Uint8Array(await file.slice(0,12).arrayBuffer());
  if(!MAGIC.slice(0,6).every((b,i)=>head[i]===b)){const data=await projectJSON('parse',file,{signal});validatePages(data);const pages=[];
    if(data.version>=12)validateJSONMaskBudget(data.pages);
    for(const p of data.pages){const decodedAssets=data.version>=12?await createDecodedAssets(p.maskAssets??{},p.imageWidth,p.imageHeight):{};const maskEffects=data.version>=12?normalizeMaskEffects(p.maskEffects??[],p.imageWidth,p.imageHeight,new Set(Object.keys(decodedAssets)),data.version):[];
      pages.push({name:p.name,src:p.src,layers:p.layers,done:p.done,edited:p.edited,...(p.imageEdit?{imageEdit:p.imageEdit}:{}),maskEffects,maskAssets:referencedMaskAssets(maskEffects,decodedAssets),...(data.version>=12?{expectedSize:{width:p.imageWidth,height:p.imageHeight}}:{})});}
    return {version:data.version,preferences:data.preferences,...(typeof data.sourceFolderName==='string'?{sourceFolderName:data.sourceFolderName}:{}),pages};}
  if(head.length!==12||!MAGIC.every((b,i)=>head[i]===b))throw new Error('未対応の高速編集データ');
  const length=new DataView(head.buffer).getUint32(8,true);if(!length||length>MANIFEST_LIMIT||12+length>file.size)throw new Error('manifest長が不正');
  const data=await projectJSON('parse',file.slice(12,12+length),{signal});
  if(![1,2].includes(data.containerVersion)||!Array.isArray(data.assets))throw new Error('コンテナ版またはassetが不正');validatePages(data,true);
  if(data.containerVersion===1&&data.projectVersion>=12)throw new Error('container v1にマスクを保存できない');
  if(data.containerVersion===2&&(!Array.isArray(data.maskAssets)||data.projectVersion<12))throw new Error('mask asset一覧が不正');
  const blobs=[];let offset=12+length;
  for(const a of data.assets){checkAbort(signal);if(!a||!Number.isSafeInteger(a.size)||a.size<=0||!mimePattern.test(a.mimeType)||![a.width,a.height].every(n=>Number.isSafeInteger(n)&&n>0)||!Number.isSafeInteger(offset+a.size)||offset+a.size>file.size)throw new Error('asset範囲または画像形式が不正');blobs.push(file.slice(offset,offset+a.size,a.mimeType));offset+=a.size;}
  const maskBlobs=[];let maskBytes={decoded:0,compressed:0};
  if(data.containerVersion===2)for(const a of data.maskAssets){
    checkAbort(signal);
    if(!a||!Number.isSafeInteger(a.pageIndex)||a.pageIndex<0||a.pageIndex>=data.pages.length||typeof a.id!=='string'||!a.id||a.id.length>200||['__proto__','constructor','prototype'].includes(a.id)
        ||!Number.isSafeInteger(a.byteLength)||a.byteLength<=0||a.byteLength>maxMaskPayloadBytes(a)
        ||!Number.isSafeInteger(offset+a.byteLength)||offset+a.byteLength>file.size)throw new Error('mask asset範囲またはmetadataが不正');
    maskBytes=addMaskProjectBytes(maskBytes,a);
    maskBlobs.push({record:a,blob:file.slice(offset,offset+a.byteLength)});offset+=a.byteLength;
  }
  if(offset!==file.size)throw new Error('ファイル全長がasset総和と一致しない');
  for(const p of data.pages){if(!Number.isSafeInteger(p.assetIndex)||p.assetIndex<0||p.assetIndex>=blobs.length)throw new Error('画像参照が範囲外');}
  const pages=[];
  for(let pageIndex=0;pageIndex<data.pages.length;pageIndex++){
    const p=data.pages[pageIndex],imageAsset=data.assets[p.assetIndex],maskAssets={};
    for(const {record,blob} of maskBlobs.filter(item=>item.record.pageIndex===pageIndex)){
      if(Object.hasOwn(maskAssets,record.id))throw new Error('mask asset IDが重複している');
      if(record.imageWidth!==imageAsset.width||record.imageHeight!==imageAsset.height)throw new Error('mask assetの画像寸法が一致しない');
      const bytes=new Uint8Array(await blob.arrayBuffer());
      maskAssets[record.id]=await assetFromEncoded({...record,data:bytes});
    }
    const maskEffects=data.projectVersion>=12?normalizeMaskEffects(p.maskEffects??[],imageAsset.width,imageAsset.height,new Set(Object.keys(maskAssets)),data.projectVersion):[];
    pages.push({name:p.name,layers:p.layers,done:p.done,edited:p.edited,...(p.imageEdit?{imageEdit:p.imageEdit}:{}),maskEffects,maskAssets:referencedMaskAssets(maskEffects,maskAssets),blob:blobs[p.assetIndex],expectedSize:imageAsset});
  }
  return {version:data.projectVersion,preferences:data.preferences,...(typeof data.sourceFolderName==='string'?{sourceFolderName:data.sourceFolderName}:{}),pages};
}
export async function writeParts(directory,name,parts,signal,onWrite=()=>{},onClosing=()=>{}){
  checkAbort(signal);const file=await directory.getFileHandle(name,{create:true});checkAbort(signal);const writer=await file.createWritable();let closed=false;
  const abort=()=>{void writer.abort().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  try{checkAbort(signal);for await(const part of parts){checkAbort(signal);await writer.write(part);onWrite(part instanceof Blob?part.size:typeof part==='string'?new TextEncoder().encode(part).length:part.byteLength);}
    checkAbort(signal);onClosing();await writer.close();closed=true;
  }catch(error){if(signal?.aborted)throw signal.reason;throw error;}finally{signal?.removeEventListener('abort',abort);if(!closed)await writer.abort().catch(()=>{});}
}
