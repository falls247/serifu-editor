import test from 'node:test';
import assert from 'node:assert/strict';
import {newProjectId,validProjectId,projectIdentity,pageIdentity} from '../src/project-identity.js';
test('UUIDの値検証と旧ファイル互換',()=>{
  const id=newProjectId();assert.ok(validProjectId(id));
  assert.equal(projectIdentity({projectId:id},14),id);
  assert.equal(pageIdentity({id},14),id);
  assert.equal(projectIdentity({},13),null);assert.equal(pageIdentity({},13),null);
  assert.throws(()=>projectIdentity({projectId:'../../x'},14),/ID/);
  assert.throws(()=>pageIdentity({id:'../../x'},14),/ID/);
  assert.throws(()=>projectIdentity({projectId:id},13),/ID/);
});
