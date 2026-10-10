import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { FONT_FILES } from './fonts.js';
const assets=['index.html','app.js','export.js','renderer.js','balloons.js', 'captions.js', 'typography.js','ink.js','fonts.js','model.js','presets.js','storage.js','style.css',...FONT_FILES.map(font=>'assets/fonts/'+font.file)];
const files={'/':'index.html',...Object.fromEntries(assets.map(path=>['/'+path,path]))};
const port=Number(process.env.PORT)||5173;
http.createServer(async(req,res)=>{
  const file=files[new URL(req.url,'http://localhost').pathname];if(!file){res.writeHead(404).end();return;}
  try {res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.ttf')?'font/ttf':file.endsWith('.txt')?'text/plain':'text/html');res.end(await readFile(new URL(file,import.meta.url)));}
  catch {res.writeHead(404).end();}
}).listen(port,'127.0.0.1',()=>console.log(`Serifu Editor: http://localhost:${port}`));
