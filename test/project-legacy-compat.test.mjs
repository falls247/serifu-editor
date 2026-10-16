import test from 'node:test';
import assert from 'node:assert/strict';
import {newLayer} from '../src/renderer.js';
import {normalizeLayers} from '../src/model.js';
import {readProject,projectBlob} from '../src/project-io.js';
test('JSON v1〜v13は遅延移行を保ち新モデルへ読める',async()=>{
 for(let version=1;version<=13;version++){
  const l=newLayer(version===1?'dialogue':'sfx',1000,750);l.text='ドン';if(version===1)l.kind='bubble';
  const data=await readProject(new Blob([JSON.stringify({version,pages:[{name:'legacy.png',src:'data:image/png;base64,AA==',layers:[l],done:false,...(version>=12?{imageWidth:1000,imageHeight:750}:{})}],preferences:{}})],{type:'application/json'}));
  const normalized=normalizeLayers(data.pages[0].layers,version);assert.equal(normalized[0].lettering,undefined);assert.equal(normalized[0].text,'ドン');assert.equal(data.projectId,undefined);
 }
});
test('コンテナ1/2は旧SFX・原画像バイトを保持する',async()=>{
 const l=newLayer('sfx',2,3);const blob=await projectBlob([{id:crypto.randomUUID(),name:'legacy.png',img:{width:2,height:3},file:new Blob(['original bytes'],{type:'image/png'}),layers:[l],done:false}],{}, {format:'serifu'});
 const bytes=new Uint8Array(await blob.arrayBuffer()),length=new DataView(bytes.buffer).getUint32(8,true),manifest=JSON.parse(new TextDecoder().decode(bytes.slice(12,12+length))),payload=bytes.slice(12+length);
 for(const version of [1,2]){const copy=structuredClone(manifest);copy.containerVersion=version;copy.projectVersion=version===1?6:13;delete copy.projectId;for(const p of copy.pages){delete p.id;if(version===1){delete p.maskEffects;delete p.maskAssets;}}if(version===1)delete copy.maskAssets;const json=new TextEncoder().encode(JSON.stringify(copy)),header=bytes.slice(0,12);new DataView(header.buffer).setUint32(8,json.length,true);const legacy=await readProject(new Blob([header,json,payload]));assert.equal(await legacy.pages[0].blob.text(),'original bytes');assert.equal(normalizeLayers(legacy.pages[0].layers,legacy.version)[0].lettering,undefined);}
});
