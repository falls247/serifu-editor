import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
const root=new URL('../',import.meta.url),backend=new URL('backend/',root);
const uiPort=Number(process.env.PORT)||5173,apiPort=Number(process.env.SAM3_API_PORT)||8765;
let uv=process.env.UV_COMMAND||'uv';
if(!process.env.UV_COMMAND){try{await access(`${homedir()}/.local/bin/uv`);uv=`${homedir()}/.local/bin/uv`;}catch{}}
try{await access(new URL('pyproject.toml',backend));}
catch{console.error('backend/がない。SAM3バックエンドをセットアップしてから起動');process.exit(1);}
const children=[];let stopping=false,failed=false;
function stop(code=0){
  if(stopping)return;stopping=true;failed=code!==0;process.exitCode=code;
  // 親コマンドが先に異常終了しても、同じグループの孫プロセスを停止する。
  for(const child of children)if(child.pid){try{process.kill(-child.pid,'SIGTERM');}catch{}}
  setTimeout(()=>{for(const child of children)if(child.pid){try{process.kill(-child.pid,'SIGKILL');}catch{}}},4000);
}
function start(command,args,cwd,env=process.env){
  const child=spawn(command,args,{cwd,env,stdio:'inherit',detached:true});children.push(child);
  child.once('error',error=>{console.error(`${command}を起動できない: ${error.code||'UNKNOWN'}。uvとbackend環境を確認`);stop(1);});
  child.once('exit',(code,signal)=>{if(!stopping){console.error(`${command}が終了 (${signal||code})`);stop(code||1);}});
  return child;
}
process.once('SIGINT',()=>stop());process.once('SIGTERM',()=>stop());
start(process.execPath,['server.mjs'],root);
start(uv,['run','--locked',...(process.env.SAM3_MOCK==='1'?[]:['--extra','gpu']),'python','-m','uvicorn','app.main:app','--host','127.0.0.1','--port',String(apiPort)],backend,{...process.env,UI_ORIGINS:process.env.UI_ORIGINS||`http://localhost:${uiPort},http://127.0.0.1:${uiPort}`});
console.log(`UI: http://localhost:${uiPort} / SAM3: http://127.0.0.1:${apiPort}`);
async function waitReady(){
  for(let i=0;i<120&&!stopping;i++){
    try{const response=await fetch(`http://127.0.0.1:${uiPort}/api/sam3/health`,{signal:AbortSignal.timeout(1500)});if(response.ok){const health=await response.json();console.log(`SAM3: ${health.status} / GPU: ${health.gpuAvailable?'利用可能':'未利用'}${health.error?` / ${health.error.message||health.error.code}`:''}`);if(health.modelPath)console.log(`モデル: ${health.modelPath}`);return;}}
    catch{}await delay(500);
  }
  if(!stopping){console.error('SAM3ヘルスチェックが応答しなかった');stop(1);}
}
await waitReady();if(failed)process.exitCode=1;
