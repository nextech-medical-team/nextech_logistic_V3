import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function validateCancelledImportScope(value){
 if(value==null)return null;
 if(!Array.isArray(value.orderIds)||!value.orderIds.length||value.orderIds.length>5000||value.orderIds.some(id=>typeof id!=='string'||!uuid.test(id))||!uuid.test(value.receiptId||'')||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}Z$/.test(value.receivedAt||'')||!Number.isFinite(Date.parse(value.receivedAt)))throw Error('Périmètre privé de réimportation invalide');
 return {orderIds:[...new Set(value.orderIds)],receiptId:value.receiptId,receivedAt:value.receivedAt};
}
export function readCancelledImportScope(filename=path.join(process.env.DATA_DIR||fileURLToPath(new URL('../data/',import.meta.url)),'cancelled-import-reimport-scope.json')){
 let text;try{text=readFileSync(filename,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}
 let value;try{value=JSON.parse(text);}catch{throw Error('Périmètre privé de réimportation illisible');}
 return validateCancelledImportScope(value);
}
