import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { runDocumentationCheck } from './check-documentation.mjs';
const files=['server.mjs'];
for(const directory of ['src','scripts'])for(const name of await readdir(new URL(`../${directory}/`,import.meta.url)))if(/\.(js|mjs)$/.test(name))files.push(`${directory}/${name}`);
for(const file of files){const result=spawnSync(process.execPath,['--check',file],{cwd:new URL('../',import.meta.url),stdio:'inherit'});if(result.error||result.status!==0)process.exit(result.status||1);}
console.log(`構文チェック: ${files.length}ファイル PASS`);
try { runDocumentationCheck(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
