import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const commit='7085eb89a950e85db5b166b7a58d414544b4140c';
const output=new URL('../assets/fonts/',import.meta.url);
const files={'DelaGothicOne-Regular.ttf':'258f93526667223b6fd9476258d42ace60c7bfd6','OFL.txt':'87fae845f60599624117220cf9477a0eca0785c2'};
function hash(buffer){return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');}
await mkdir(output,{recursive:true});
for(const [name,expected] of Object.entries(files)){
  const target=new URL(name,output);
  try {if(hash(await readFile(target))===expected)continue;}catch{}
  const response=await fetch(`https://raw.githubusercontent.com/google/fonts/${commit}/ofl/delagothicone/${name}`,{signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw new Error(`Font download failed: ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer());if(hash(bytes)!==expected)throw new Error('Font checksum mismatch');
  await writeFile(target,bytes);
}
console.log('極太日本語書体 Dela Gothic One とOFLライセンスを準備した');
