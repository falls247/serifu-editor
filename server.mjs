import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { FONT_FILES } from './src/fonts.js';
const assets=['index.html','favicon-32.png','apple-touch-icon.png','src/app.js','src/export.js','src/renderer.js','src/glyph-layout.js','src/brush-stroke.js','src/balloons.js', 'src/captions.js', 'src/typography.js','src/ink.js','src/fonts.js','src/model.js','src/image-edit.js','src/preview-modal.js','src/presets.js','src/storage.js','src/bulk-task.js','src/bulk-pool.js','src/image-worker.js','src/image-metadata.js','src/export-cache.js','src/project-io.js','src/project-filenames.js','src/project-worker.js','src/zip.js','style.css',...FONT_FILES.map(font=>'assets/fonts/'+font.file)];
const files={'/':'index.html',...Object.fromEntries(assets.map(path=>['/'+path,path]))};
const port=Number(process.env.PORT)||5173;
http.createServer(async(req,res)=>{
  const file=files[new URL(req.url,'http://localhost').pathname];if(!file){res.writeHead(404).end();return;}
  try {res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.ttf')?'font/ttf':file.endsWith('.png')?'image/png':file.endsWith('.txt')?'text/plain':'text/html');res.end(await readFile(new URL(file,import.meta.url)));}
  catch {res.writeHead(404).end();}
}).listen(port,'127.0.0.1',()=>console.log(`Serifu Editor: http://localhost:${port}`));
