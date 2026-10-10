import {readFile} from 'node:fs/promises';
import path from 'node:path';
// The fulfillment warehouse is explicit configuration, never a guess based on
// the first stock level or the warehouse with the largest physical quantity.
export async function stockChoiceLocation(directory){
 let refs;
 try{refs=JSON.parse(await readFile(path.join(directory,'live-workflow-references.json'),'utf8'));}
 catch{throw Error('Sélection produit : emplacement Erplain LIVE non configuré');}
 if(Number(refs.companyId)!==100174||!/^\d+$/.test(String(refs.locationId||''))||Number(refs.locationId)<=0)throw Error('Sélection produit : emplacement Erplain LIVE non vérifié');
 return String(refs.locationId);
}
