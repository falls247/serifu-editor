import http from 'node:http';
import {readFile} from 'node:fs/promises';
const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/renderer.js':'renderer.js','/model.js':'model.js','/style.css':'style.css'};
http.createServer(async(req,res)=>{const file=files[new URL(req.url,'http://localhost').pathname];if(!file){res.writeHead(404).end();return;}try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await readFile(new URL(file,import.meta.url)));}catch{res.writeHead(500).end();}}).listen(Number(process.env.PORT)||5173,'127.0.0.1',()=>console.log('Serifu Editor: http://localhost:5173'));
