import test from 'node:test';
import assert from 'node:assert/strict';
import {projectFileMatchesSnapshot} from '../src/project-conflict.js';
test('project conflicts skip only matching content and matching immutable IDs',async()=>{
  const saved={projectId:'foo',meta:{pages:[{id:'p1',name:'a',done:true,layers:[],maskEffects:[]}],preferences:{}},images:[],masks:[]};
  assert.equal(await projectFileMatchesSnapshot({projectId:'different',pages:[]},saved),false);
  assert.equal(await projectFileMatchesSnapshot({projectId:'foo',pages:[{id:'p1',name:'a',done:false,layers:[]}],preferences:{}},saved),false);
});