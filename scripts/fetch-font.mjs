import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const commit='7085eb89a950e85db5b166b7a58d414544b4140c';
const output=new URL('../assets/fonts/',import.meta.url);
const files=[
  ['delagothicone','DelaGothicOne-Regular.ttf','DelaGothicOne-Regular.ttf','258f93526667223b6fd9476258d42ace60c7bfd6'],
  ['delagothicone','OFL.txt','OFL.txt','87fae845f60599624117220cf9477a0eca0785c2'],
  ['yujiboku','YujiBoku-Regular.ttf','YujiBoku-Regular.ttf','3a8cb821f00c7c03ac2eb90915898749b9bce4df'],
  ['yujiboku','OFL.txt','YujiBoku-OFL.txt','cff4fd743037483847e8d10afbc7ebc5e9226553'],
];
function hash(buffer){return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');}
await mkdir(output,{recursive:true});
for(const [directory,source,name,expected] of files){
  const target=new URL(name,output);
  try {if(hash(await readFile(target))===expected)continue;}catch{}
  const response=await fetch(`https://raw.githubusercontent.com/google/fonts/${commit}/ofl/${directory}/${source}`,{signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw new Error(`Font download failed: ${response.status}`);
  const bytes=Buffer.from(await response.arrayBuffer());if(hash(bytes)!==expected)throw new Error('Font checksum mismatch');
  await writeFile(target,bytes);
}
console.log('極太 Dela Gothic One、筆文字 Yuji Boku とOFLライセンスを準備した');
