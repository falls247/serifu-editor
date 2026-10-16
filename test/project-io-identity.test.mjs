import test from 'node:test';
import assert from 'node:assert/strict';
import {projectBlob,readProject} from '../src/project-io.js';
import {newProjectId} from '../src/project-identity.js';
test('v14 serifuコンテナはプロジェクトIDとページIDを保持しコンテナ版2を維持',async()=>{
  const projectId=newProjectId(),pageId=newProjectId();
  const page={id:pageId,name:'source.png',file:new Blob([Uint8Array.of(1,2,3,4)],{type:'image/png'}),
    img:{width:120,height:80},layers:[],done:true,edited:false,maskEffects:[],maskAssets:{}};
  const packed=await projectBlob([page],{test:true},{projectId});
  const restored=await readProject(packed);
  assert.equal(restored.version,14);
  assert.equal(restored.projectId,projectId);
  assert.equal(restored.pages[0].id,pageId);
  assert.equal(restored.pages[0].expectedSize.width,120);
  const header=new Uint8Array(await packed.slice(0,12).arrayBuffer());
  const manifestLength=new DataView(header.buffer).getUint32(8,true);
  const manifest=JSON.parse(await packed.slice(12,12+manifestLength).text());
  assert.equal(manifest.containerVersion,2);
  assert.equal(manifest.projectVersion,14);
  assert.equal(manifest.projectId,projectId);
});
test('旧形式の入力でIDが無い場合にIDを捏造せず呼出側へ返す',async()=>{
  const page={name:'source.png',file:new Blob([Uint8Array.of(1,2,3,4)],{type:'image/png'}),
    img:{width:120,height:80},layers:[],done:false,edited:false,maskEffects:[],maskAssets:{}};
  const restored=await readProject(await projectBlob([page],{},{}));
  assert.equal(restored.projectId,undefined);
  assert.equal(restored.pages[0].id,undefined);
});
