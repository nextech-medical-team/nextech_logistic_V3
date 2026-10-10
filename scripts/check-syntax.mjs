import {execFileSync} from 'node:child_process';
import {readdir} from 'node:fs/promises';
async function files(dir){const entries=await readdir(dir,{withFileTypes:true});return (await Promise.all(entries.map(e=>e.isDirectory()?files(dir+'/'+e.name):[dir+'/'+e.name]))).flat();}
let checked=0;for(const dir of ['src','public','scripts','test'])for(const file of await files(dir))if(/\.(mjs|js)$/.test(file)){execFileSync(process.execPath,['--check',file],{stdio:'inherit'});checked++;}
console.log(checked+' fichiers JavaScript vérifiés');
