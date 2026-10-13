import test from 'node:test';
import assert from 'node:assert/strict';
import {ImagePool} from '../src/bulk-pool.js';
test('中断直後の次操作に古い起動・応答が干渉せずWorkerが再利用可能',async()=>{
 const Original=globalThis.Worker;
 class MockWorker{postMessage(message){const handler=this.onmessage;setTimeout(()=>handler?.({data:{...message,value:message.kind==='probe'?true:message.payload.value}}),8);}terminate(){this.terminated=true;}}
 globalThis.Worker=MockWorker;
 try{
  const pool=new ImagePool({timeout:2000}),controller=new AbortController();
  const first=pool.run('prepare-image',{value:'old'},{signal:controller.signal,data:{operationId:'old'}},()=>{throw Error('old fallback');});
  controller.abort(new DOMException('cancel','AbortError'));await assert.rejects(first,{name:'AbortError'});
  pool.resize(4);assert.equal(await pool.run('prepare-image',{value:'new'},{signal:new AbortController().signal,data:{operationId:'new'}},()=>{throw Error('new operation lost Worker');}),'new');assert.equal(pool.disabled,false);pool.close();
 }finally{globalThis.Worker=Original;}
});
