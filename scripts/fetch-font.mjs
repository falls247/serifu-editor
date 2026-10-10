import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FONT_COMMIT, FONT_FILES } from '../fonts.js';
const output=new URL('../assets/fonts/',import.meta.url);
function hash(buffer){return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');}
await mkdir(output,{recursive:true});
async function prepareFont({directory,source,file,sha,bundled,raw}){
  const target=new URL(file,output);
  try {if(hash(await readFile(target))===sha)return;}catch{}
  if(bundled){
    const encoded=file.endsWith('.ttf')&&!raw,input=new URL(`../assets/font-sources/${source}${encoded?'.base64':''}`,import.meta.url);
    const bytes=encoded?Buffer.from(await readFile(input,'utf8'),'base64'):await readFile(input);
    if(hash(bytes)!==sha)throw new Error(`Bundled font checksum mismatch: ${file}`);
    await writeFile(target,bytes);return;
  }
  const response=await fetch(`https://raw.githubusercontent.com/google/fonts/${FONT_COMMIT}/ofl/${directory}/${source}`,{signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw new Error(`Font download failed: ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer());if(hash(bytes)!==sha)throw new Error(`Font checksum mismatch: ${file}`);
  await writeFile(target,bytes);
}
for(let i=0;i<FONT_FILES.length;i+=4)await Promise.all(FONT_FILES.slice(i,i+4).map(prepareFont));
console.log(`日本語書体${FONT_FILES.filter(font=>font.file.endsWith('.ttf')).length}種類と各作者のライセンスを準備した`);
