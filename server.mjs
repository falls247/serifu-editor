import http from 'node:http';
import { readFile } from 'node:fs/promises';
const assets=['index.html','app.js','renderer.js','ink.js','model.js','presets.js','storage.js','style.css','assets/fonts/DelaGothicOne-Regular.ttf','assets/fonts/OFL.txt','assets/fonts/YujiBoku-Regular.ttf','assets/fonts/YujiBoku-OFL.txt'];
const files={'/':'index.html',...Object.fromEntries(assets.map(path=>['/'+path,path]))};
const port=Number(process.env.PORT)||5173;
http.createServer(async(req,res)=>{
  const file=files[new URL(req.url,'http://localhost').pathname];if(!file){res.writeHead(404).end();return;}
  try {res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.ttf')?'font/ttf':file.endsWith('.txt')?'text/plain':'text/html');res.end(await readFile(new URL(file,import.meta.url)));}
  catch {res.writeHead(404).end();}
}).listen(port,'127.0.0.1',()=>console.log(`Serifu Editor: http://localhost:${port}`));
