import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp,writeFile,chmod,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
async function unusedPort(){const server=http.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
for(const crash of [false,true])test(`dev launcher ${crash?'handles backend failure':'starts and stops'} with no remaining process group`,{timeout:20000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'serifu-dev-')),uv=join(directory,'mock-uv.mjs');
  await writeFile(uv,`#!/usr/bin/env node\nimport http from 'node:http';\nimport {readFile} from 'node:fs/promises';\nimport {spawn} from 'node:child_process';\nconst reportedPid=(await readFile('/proc/self/stat','utf8')).split(' ')[0];\nconst nested=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log(require('node:fs').readFileSync('/proc/self/stat','utf8').split(' ')[0]);setInterval(()=>{},1000)"]);\nnested.stdout.once('data',chunk=>console.log('fixture-pids:'+reportedPid+','+chunk.toString().trim()));if(process.env.FIXTURE_CRASH==='1')setTimeout(()=>process.exit(17),1500);\nhttp.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'ready',modelLoaded:false,gpuAvailable:false,version:'mock'}));}).listen(Number(process.env.SAM3_API_PORT),'127.0.0.1');\n`);await chmod(uv,0o755);
  const port=await unusedPort(),apiPort=await unusedPort();
  const child=spawn(process.execPath,['scripts/dev.mjs'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:String(port),SAM3_API_PORT:String(apiPort),SAM3_MOCK:'1',UV_COMMAND:uv,FIXTURE_CRASH:crash?'1':'0'},stdio:['ignore','pipe','pipe']});
  let log='',stopped=false;const exited=once(child,'exit');child.stdout.on('data',chunk=>{log+=chunk;});child.stderr.on('data',chunk=>{log+=chunk;});
  try{
    await new Promise((resolve,reject)=>{const started=Date.now(),timer=setInterval(()=>{if(log.includes('SAM3: ready')&&log.includes('fixture-pids:')){clearInterval(timer);resolve();}else if(child.exitCode!==null||Date.now()-started>10000){clearInterval(timer);reject(new Error(log||'Dev startup timeout'));}},50);});
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status,200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/sam3/health`)).status,200);
    const pids=/fixture-pids:(\d+),(\d+)/.exec(log);assert.ok(pids);
    if(!crash)child.kill('SIGTERM');const [code]=await exited;stopped=true;assert.equal(code,crash?17:0);
    for(const pid of pids.slice(1).map(Number)){let alive=false;try{alive=(await readFile(`/proc/${pid}/stat`,'utf8')).split(' ')[2]!=='Z';}catch{}assert.equal(alive,false,`Process ${pid} must terminate`);}
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/sam3/health`));
  }finally{if(!stopped){child.kill('SIGTERM');await exited;}await rm(directory,{recursive:true,force:true});}
});
