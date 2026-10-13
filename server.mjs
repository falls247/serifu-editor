import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { FONT_FILES } from './src/fonts.js';
const assets=['index.html','favicon-32.png','apple-touch-icon.png','src/app.js','src/export.js','src/project-identity.js','src/project-history.js','src/project-lock.js','src/project-conflict.js','src/sfx-lettering-templates.js','src/sfx-outline-groups.js','src/sfx-lettering-model.js','src/sfx-stroke-geometry.js','src/sfx-edit-operations.js','src/sfx-editor.js','src/renderer.js','src/glyph-layout.js','src/brush-stroke.js','src/balloons.js','src/captions.js','src/typography.js','src/ink.js','src/fonts.js','src/model.js','src/image-edit.js','src/preview-modal.js','src/preview-render.js','src/preview-magnifier.js','src/presets.js','src/storage.js','src/bulk-task.js','src/bulk-pool.js','src/image-worker.js','src/image-metadata.js','src/export-cache.js','src/project-io.js','src/project-filenames.js','src/project-worker.js','src/zip.js','src/mask-codec.js','src/mask-geometry.js','src/mask-effects.js','src/sam3-client.js','src/sam3-ui.js','style.css',...FONT_FILES.map(font=>'assets/fonts/'+font.file)];
const files={'/':'index.html',...Object.fromEntries(assets.map(path=>['/'+path,path]))};
const port=Number(process.env.PORT)||5173,backendPort=Number(process.env.SAM3_API_PORT)||8765;
const identifier='[a-zA-Z0-9_-]{1,100}';
const routes=[[/^\/api\/sam3\/health$/,['GET']], [/^\/api\/sam3\/settings$/,['POST']], [/^\/api\/sam3\/images$/,['POST']], [/^\/api\/sam3\/infer$/,['POST']], [new RegExp(`^/api/sam3/jobs/${identifier}$`),['GET','DELETE']], [new RegExp(`^/api/sam3/images/${identifier}$`),['DELETE']]];
const rates=new Map();
function error(res,status,code,message,retryable=false){
  if(res.headersSent){res.destroy();return;}
  res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify({error:{code,message,retryable,requestId:randomUUID()}}));
}
function localHost(host){
  try{const url=new URL(`http://${host}`);return ['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&url.host===host&&url.port===String(port);}
  catch{return false;}
}
function allowRequest(req,res){
  if(!localHost(req.headers.host)){error(res,403,'FORBIDDEN_HOST','localhostのHostのみ利用できる');return false;}
  const site=req.headers['sec-fetch-site'];
  if(site&&!['same-origin','none'].includes(site)){error(res,403,'FORBIDDEN_ORIGIN','同一オリジンからのみ利用できる');return false;}
  const origin=req.headers.origin;
  // OriginなしはCLIに許可。ブラウザのFetch Metadataも同時に検査する。
  if(origin&&origin!==`http://${req.headers.host}`){error(res,403,'FORBIDDEN_ORIGIN','同一オリジンからのみ利用できる');return false;}
  return true;
}
async function proxy(req,res,path){
  const route=routes.find(([pattern])=>pattern.test(path));
  if(!route){error(res,404,'NOT_FOUND','未対応のSAM3 API');return;}
  if(!route[1].includes(req.method)){res.setHeader('Allow',route[1].join(', '));error(res,405,'METHOD_NOT_ALLOWED','未対応のHTTPメソッド');return;}
  if(req.headers['content-encoding']){error(res,415,'INVALID_REQUEST','圧縮した要求は受け付けない');return;}
  if(['POST','DELETE'].includes(req.method)){
    const now=Date.now(),key=req.socket.remoteAddress,previous=rates.get(key);
    const record=previous&&now-previous.start<60000?previous:{start:now,count:0};rates.set(key,record);
    if(++record.count>180){error(res,429,'RATE_LIMITED','要求が多すぎる。少し待って再試行',true);return;}
  }
  const limit=path==='/api/sam3/images'?31*1024**2:256*1024,declared=req.headers['content-length'];
  if(declared&&(!/^\d+$/.test(declared)||Number(declared)>limit)){error(res,413,'INVALID_REQUEST','要求サイズが上限を超える');req.resume();return;}
  let bytes=0;const chunks=[];
  try{for await(const chunk of req){bytes+=chunk.length;if(bytes>limit){error(res,413,'INVALID_REQUEST','要求サイズが上限を超える');return;}chunks.push(chunk);}}
  catch{error(res,400,'INVALID_REQUEST','要求を読み取れない');return;}
  const headers={'Content-Length':bytes};for(const name of ['content-type','origin','sec-fetch-site'])if(req.headers[name])headers[name]=req.headers[name];
  const upstream=http.request({hostname:'127.0.0.1',port:backendPort,path,method:req.method,headers,timeout:70000},response=>{
    let size=0;const body=[];
    response.on('data',chunk=>{size+=chunk.length;if(size>64*1024**2){upstream.destroy();error(res,502,'RESPONSE_TOO_LARGE','推論結果が大きすぎる',true);}else body.push(chunk);});
    response.on('error',()=>error(res,502,'BACKEND_UNAVAILABLE','SAM3サーバーの応答が中断した',true));
    response.on('end',()=>{if(res.writableEnded||res.destroyed)return;res.writeHead(response.statusCode||502,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(Buffer.concat(body));});
  });
  upstream.on('timeout',()=>{upstream.destroy();error(res,504,'INFERENCE_TIMEOUT','SAM3サーバーの応答がタイムアウトした',true);});
  upstream.on('error',()=>{if(!res.writableEnded)error(res,503,'BACKEND_UNAVAILABLE','SAM3サーバーへ接続できない。npm run devで起動',true);});
  res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});upstream.end(Buffer.concat(chunks));
}
const server=http.createServer(async(req,res)=>{
  if(!allowRequest(req,res))return;
  let url;try{url=new URL(req.url,'http://localhost');}catch{error(res,400,'INVALID_REQUEST','URLが不正');return;}
  if(url.pathname.startsWith('/api/sam3')){if(url.search){error(res,400,'INVALID_REQUEST','APIのqueryは未対応');return;}await proxy(req,res,url.pathname);return;}
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
  const file=files[url.pathname];if(!file){res.writeHead(404).end();return;}
  try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.ttf')?'font/ttf':file.endsWith('.png')?'image/png':file.endsWith('.txt')?'text/plain':'text/html');res.setHeader('X-Content-Type-Options','nosniff');const data=await readFile(new URL(file,import.meta.url));res.end(req.method==='HEAD'?undefined:data);}
  catch{res.writeHead(404).end();}
});
server.requestTimeout=30000;server.listen(port,'127.0.0.1',()=>console.log(`Serifu Editor: http://localhost:${port}`));
