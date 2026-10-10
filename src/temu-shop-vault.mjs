import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const exec=promisify(execFile);
export async function loadShopVault(directory){
 if(process.env.SHOP_VAULT_FILE){const info=await stat(process.env.SHOP_VAULT_FILE);if(process.platform!=='win32'&&(info.mode&0o077))throw Error('TEMU · Les accès du coffre doivent être privés');const data=JSON.parse(await readFile(process.env.SHOP_VAULT_FILE,'utf8'));if(!Array.isArray(data)||data.some(m=>!m.appKey||!m.appSecret||!m.accessToken||!m.country))throw Error('TEMU · Coffre des boutiques incomplet');return data;}
 try{await access(path.join(directory,'shops-encrypted.json'));}catch(e){if(e.code==='ENOENT')return [];throw e;}
 try{const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./temu-shop-vault.ps1',import.meta.url)),'-Directory',directory],{windowsHide:true,timeout:20000,maxBuffer:1048576});return JSON.parse(stdout.replace(/^\uFEFF/,''));}
 catch{throw Error('TEMU · Coffre des accès illisible pour ce compte Windows');}
}
