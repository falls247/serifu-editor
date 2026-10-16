import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForAsync} from '../scripts/browser-wait.mjs';
test('非同期のfalseは待機成功にならず、実際のtrueまで再評価する',async()=>{
 let attempts=0;
 const page={evaluate:async(predicate,arg)=>predicate(arg)};
 await waitForAsync(page,async target=>++attempts>=target,3,{polling:1,timeout:1000});
 assert.equal(attempts,3);
});
test('未解決の非同期評価も待機期限を超えない',{timeout:2000},async()=>{
 const page={evaluate:()=>new Promise(()=>{})};
 await assert.rejects(waitForAsync(page,()=>false,undefined,{timeout:25}),/within 25ms/);
});
