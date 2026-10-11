import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
function request(port,path,method='GET',headers={},body=''){
  return new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path,method,headers},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));});req.on('error',reject);req.setTimeout(3000,()=>req.destroy(new Error(`Request timeout: ${method} ${path}`)));req.end(body);});
}
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}
async function unusedPort(){const temporary=http.createServer();const port=await listen(temporary);await new Promise(resolve=>temporary.close(resolve));return port;}
test('SAM3 proxy limits hosts, origins, routes and bodies while preserving API failures',{timeout:15000},async()=>{
  const received=[];
  const backend=http.createServer(async(req,res)=>{const parts=[];for await(const part of req)parts.push(part);received.push({url:req.url,method:req.method,headers:req.headers,body:Buffer.concat(parts).toString()});res.writeHead(req.url.endsWith('/expired')?410:200,{'Content-Type':'application/json'});res.end(JSON.stringify(req.url.endsWith('/expired')?{error:{code:'IMAGE_EXPIRED',retryable:true}}:{status:'ready'}));});
  const backendPort=await listen(backend),port=await unusedPort();
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:String(port),SAM3_API_PORT:String(backendPort)},stdio:['ignore','pipe','pipe']});
  try{
    await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('Proxy failed to start');})]);
    assert.equal((await request(port,'/')).status,200);
    assert.equal((await request(port,'/api/sam3/health')).status,200);
    assert.equal((await request(port,'/api/sam3/health','GET',{Host:`evil.local:${port}`})).status,403);
    assert.equal((await request(port,'/api/sam3/infer','POST',{Origin:'https://evil.example','Content-Type':'application/json'},'{}')).status,403);
    assert.equal((await request(port,'/api/sam3/infer','POST',{'Sec-Fetch-Site':'cross-site'},'{}')).status,403);
    assert.equal((await request(port,'/api/sam3/infer','POST',{Origin:'null'},'{}')).status,403);
    assert.equal((await request(port,'/api/sam3/infer','POST',{Origin:`http://127.0.0.1:${port}`,'Content-Type':'application/json'},'{"requestId":"page:1"}')).status,200);
    assert.equal(received.at(-1).body,'{"requestId":"page:1"}');assert.equal(received.at(-1).headers.host,`127.0.0.1:${backendPort}`);
    assert.equal((await request(port,'/api/sam3/settings','POST',{Origin:`http://127.0.0.1:${port}`,'Content-Type':'application/json'},'{"modelPath":"/models/sam3.pt"}')).status,200);
    assert.equal(received.at(-1).url,'/api/sam3/settings');assert.equal(received.at(-1).body,'{"modelPath":"/models/sam3.pt"}');
    assert.equal((await request(port,'/api/sam3/settings','POST',{Origin:'https://evil.example'},'{}')).status,403);
    assert.equal((await request(port,'/api/sam3/images/image','DELETE')).status,200,'Origin-less CLI allowed');
    assert.equal((await request(port,'/api/sam3/jobs/expired')).status,410);
    assert.equal((await request(port,'/api/sam3/http://external.example')).status,404);
    assert.equal((await request(port,'/api/sam3/health?target=external')).status,400);
    assert.equal((await request(port,'/api/sam3/health','POST')).status,405);
    assert.equal((await request(port,'/api/sam3/infer','POST',{'Content-Encoding':'gzip'},'{}')).status,415);
    const before=received.length;
    assert.equal((await request(port,'/api/sam3/infer','POST',{},'x'.repeat(256*1024+1))).status,413);
    assert.equal(received.length,before,'Oversized request must never reach inference server');
    backend.closeAllConnections();await new Promise(resolve=>backend.close(resolve));
    const offline=await request(port,'/api/sam3/health');assert.equal(offline.status,503);assert.equal(JSON.parse(offline.body).error.code,'BACKEND_UNAVAILABLE');
  }finally{child.kill('SIGTERM');await once(child,'exit');if(backend.listening)backend.closeAllConnections();await new Promise(resolve=>backend.close(resolve));}
});
