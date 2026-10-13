import {originalBlob} from './project-io.js';
import {validProjectId} from './project-identity.js';

const imageKey=async blob=>{
  const data=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
  return 'image:'+Array.from(new Uint8Array(data),x=>x.toString(16).padStart(2,'0')).join('')+':'+blob.type;
};
const canonical=p=>JSON.stringify({
  name:p.name,done:p.done===true,imageEdit:p.imageEdit??null,layers:p.layers,
  maskEffects:p.maskEffects??[],selectedMaskId:p.selectedMaskId??null
});
export async function projectFileMatchesSnapshot(fileData,snapshot,{signal}={}){
  if(!snapshot||fileData?.projectId!==snapshot.projectId||!Array.isArray(fileData.pages))return false;
  const stored=snapshot.meta.pages,records=fileData.pages;
  if(records.length!==stored.length||JSON.stringify(fileData.preferences)!==JSON.stringify(snapshot.meta.preferences))return false;
  const fileKeys=new Set();
  for(let i=0;i<records.length;i++){
    if(signal?.aborted)throw signal.reason;
    const record=records[i],saved=stored[i];
    if(!validProjectId(record.id)||record.id!==saved.id||canonical(record)!==canonical(saved))return false;
    fileKeys.add(record.id);
  }
  const imageRefs=new Map(snapshot.images.map(x=>[x.pageId,x.assetId]));
  const maskRefs=new Map(snapshot.masks.map(x=>[JSON.stringify([x.pageId,x.id]),x.assetId]));
  let maskCount=0;
  for(const page of records){
    if(signal?.aborted)throw signal.reason;
    const blob=await originalBlob(page);
    if(await imageKey(blob)!==imageRefs.get(page.id))return false;
    for(const [id,asset] of Object.entries(page.maskAssets||{})){
      const key=JSON.stringify([page.id,id]),ref=maskRefs.get(key);
      if(!ref||!ref.includes('mask:'+asset.sha256+':'))return false;
      maskCount++;
    }
  }
  return maskCount===snapshot.masks.length;
}
export async function projectConflictChoice(){
  const dialog=document.createElement('dialog');
  dialog.className='project-conflict-dialog';
  dialog.setAttribute('aria-label','同じプロジェクトIDの編集状態が異なります');
  const title=document.createElement('h2');title.textContent='同じプロジェクトIDに別の編集状態があります';
  const explanation=document.createElement('p');explanation.textContent='開く編集状態を選んでください。既存の履歴5世代は削除されません。';
  dialog.append(title,explanation);
  const actions=[['file','ファイルの内容を開く'],['autosave','自動保存から再開'],['copy','別プロジェクトとして開く'],['cancel','中止']];
  const choice=await new Promise(resolve=>{
    for(const [value,label] of actions){
      const button=document.createElement('button');button.type='button';button.textContent=label;
      button.onclick=()=>{dialog.close();resolve(value);};dialog.append(button);
    }
    dialog.oncancel=event=>{event.preventDefault();dialog.close();resolve('cancel');};
    document.body.append(dialog);dialog.showModal();
  });
  dialog.remove();return choice;
}
