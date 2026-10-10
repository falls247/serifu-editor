import {checkAbort,yieldToBrowser} from './bulk-task.js';
const MAGIC=new Uint8Array([0x53,0x45,0x52,0x49,0x46,0x55,0,1]);
export const MANIFEST_LIMIT=16*1024**2;
const mimePattern=/^image\/(png|jpeg|webp|gif|avif)$/;
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
export async function* projectParts(pages,preferences,{format='serifu',task}={}){
  const signal=task?.signal;checkAbort(signal);
  task?.stage(format==='json'?'JSON変換':'原画像収録',pages.length);
  if(format==='json'){
    yield `{"version":6,"preferences":${await projectJSON('stringify',preferences,{signal})},"pages":[`;
    for(let i=0;i<pages.length;i++){checkAbort(signal);const p=pages[i],src=p.src?.startsWith('data:')?p.src:await blobDataURL(await originalBlob(p),signal);
      yield (i?',':'')+await projectJSON('stringify',{name:p.name,src,layers:p.layers,done:p.done===true,edited:p.edited===true},{signal});task?.result(p.name);await yieldToBrowser();}
    yield ']}';return;
  }
  const assets=[],blobs=[],records=[];
  for(const p of pages){checkAbort(signal);const blob=await originalBlob(p);if(!mimePattern.test(blob.type))throw new Error(`未対応の原画像形式: ${p.name}`);
    records.push({name:p.name,assetIndex:assets.length,layers:p.layers,done:p.done===true,edited:p.edited===true});assets.push({size:blob.size,mimeType:blob.type,width:p.img.width,height:p.img.height});blobs.push(blob);if(blobs.length%20===0)await yieldToBrowser();}
  const manifest=new TextEncoder().encode(await projectJSON('stringify',{containerVersion:1,projectVersion:6,preferences,pages:records,assets},{signal}));
  if(manifest.byteLength>MANIFEST_LIMIT)throw new Error('編集メタデータが16MiBを超える');
  const header=new Uint8Array(12);header.set(MAGIC);new DataView(header.buffer).setUint32(8,manifest.byteLength,true);yield header;yield manifest;
  for(let i=0;i<blobs.length;i++){checkAbort(signal);yield blobs[i];task?.result(pages[i].name);}
}
export async function projectBlob(pages,preferences,options){const parts=[];for await(const part of projectParts(pages,preferences,options))parts.push(part);checkAbort(options?.task?.signal);return new Blob(parts,{type:options?.format==='json'?'application/json':'application/octet-stream'});}
function validatePages(data,container=false){
  const version=container?data.projectVersion:data.version;
  if(!(container?version===6:[1,2,3,4,5,6].includes(version))||!Array.isArray(data.pages)||!data.pages.length)throw new Error('未対応または空の編集データ');
  for(const p of data.pages){if(!p||typeof p.name!=='string'||!Array.isArray(p.layers))throw new Error('画像データが不正');
    if(!container&&(typeof p.src!=='string'||!/^data:image\/(png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/\s]*={0,2}$/.test(p.src)))throw new Error('画像データが不正');}
}
export async function readProject(file,{signal}={}){
  checkAbort(signal);const head=new Uint8Array(await file.slice(0,12).arrayBuffer());
  if(!MAGIC.slice(0,6).every((b,i)=>head[i]===b)){const data=await projectJSON('parse',file,{signal});validatePages(data);return {version:data.version,preferences:data.preferences,pages:data.pages.map(({name,src,layers,done,edited})=>({name,src,layers,done,edited}))};}
  if(head.length!==12||!MAGIC.every((b,i)=>head[i]===b))throw new Error('未対応の高速編集データ');
  const length=new DataView(head.buffer).getUint32(8,true);if(!length||length>MANIFEST_LIMIT||12+length>file.size)throw new Error('manifest長が不正');
  const data=await projectJSON('parse',file.slice(12,12+length),{signal});
  if(data.containerVersion!==1||!Array.isArray(data.assets))throw new Error('コンテナ版またはassetが不正');validatePages(data,true);
  const blobs=[];let offset=12+length;
  for(const a of data.assets){checkAbort(signal);if(!a||!Number.isSafeInteger(a.size)||a.size<=0||!mimePattern.test(a.mimeType)||![a.width,a.height].every(n=>Number.isSafeInteger(n)&&n>0)||!Number.isSafeInteger(offset+a.size)||offset+a.size>file.size)throw new Error('asset範囲または画像形式が不正');blobs.push(file.slice(offset,offset+a.size,a.mimeType));offset+=a.size;}
  if(offset!==file.size)throw new Error('ファイル全長がasset総和と一致しない');
  for(const p of data.pages){if(!Number.isSafeInteger(p.assetIndex)||p.assetIndex<0||p.assetIndex>=blobs.length)throw new Error('画像参照が範囲外');}
  return {version:data.projectVersion,preferences:data.preferences,pages:data.pages.map(p=>({name:p.name,layers:p.layers,done:p.done,edited:p.edited,blob:blobs[p.assetIndex],expectedSize:data.assets[p.assetIndex]}))};
}
export async function writeParts(directory,name,parts,signal,onWrite=()=>{},onClosing=()=>{}){
  checkAbort(signal);const file=await directory.getFileHandle(name,{create:true});checkAbort(signal);const writer=await file.createWritable();let closed=false;
  const abort=()=>{void writer.abort().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  try{checkAbort(signal);for await(const part of parts){checkAbort(signal);await writer.write(part);onWrite(part instanceof Blob?part.size:typeof part==='string'?new TextEncoder().encode(part).length:part.byteLength);}
    checkAbort(signal);onClosing();await writer.close();closed=true;
  }catch(error){if(signal?.aborted)throw signal.reason;throw error;}finally{signal?.removeEventListener('abort',abort);if(!closed)await writer.abort().catch(()=>{});}
}
