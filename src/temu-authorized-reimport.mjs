import {readFileSync} from 'node:fs';import path from 'node:path';
export function authorizedTemuScope(entries){
 if(!Array.isArray(entries)||entries.some(e=>!Array.isArray(e)||e.length!==2||!/^PO-\d+-\d+$/.test(String(e[0]))||!/^\d+$/.test(String(e[1])))||new Set(entries.map(e=>e[0])).size!==entries.length)throw Error('Périmètre privé TEMU invalide');
 return new Map(entries.map(([reference,shop])=>[String(reference),String(shop)]));
}
function loadScope(){
 try{return authorizedTemuScope(JSON.parse(readFileSync(path.join(process.env.DATA_DIR||'/var/lib/nextech-live','temu-authorized-reimport-scope.json'),'utf8')));}
 catch(e){if(e.code==='ENOENT')return new Map();throw e;}
}
export function authorizedFreshTemu(r,options={}){
 if(options.batch!=="fresh-temu-34-20261008")return false;
 const scope=loadScope();
 const ref=r.payload?.detail?.parentOrderMap?.parentOrderSn;
 if(r.channel!=="temu"||!scope.has(ref)||String(r.shop)!==scope.get(ref))throw Error("Reprise hors des 34 commandes autorisées");
 return true;
}
