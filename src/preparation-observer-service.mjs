import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {erplainAccount} from './erplain-accounts.mjs';
import {readErplainDocuments} from './erplain-document-read.mjs';
import {recoverOrder} from './erplain-document-metadata.mjs';
import {readSku} from './problem-resolution.mjs';
import {preparationObserverWorker} from './preparation-observer-worker.mjs';

export function preparationObserverService(db,directory,{enabled=()=>true,now=()=>Date.now(),api=erplainAccount(directory,'source'),readReferences=async()=>JSON.parse(await readFile(path.join(directory,'live-workflow-references.json'),'utf8')),readDocument=readErplainDocuments,findDocument=recoverOrder,readProduct=readSku,...limits}={}){
 let running=false,locationId,identity;
 const source={request(query,...args){if(!/^query\s/.test(query)||/\bmutation\b/i.test(query))throw Error('Contrôle de préparation : écriture fournisseur interdite');return api.request(query,...args);}};
 const verified=async()=>{identity??=Promise.resolve().then(()=>api.verify()).then(company=>{if(String(company?.id)!=='100174')throw Error('Identité Erplain non vérifiée');return company;});await identity;};
 const worker=preparationObserverWorker(db,{...limits,enabled,now,locationForOrder:()=>locationId,
  readDocument:async id=>{await verified();return readDocument(source,id);},
  findDocument:async order=>{await verified();const found=await findDocument(source,order);if(found!==null&&!found?.id)throw Error('Recherche BC non vérifiable');return {complete:true,found:found?.id??null};},
  readProduct:async sku=>{await verified();return readProduct(source,sku);}});
 return {get running(){return running;},async run(){
  if(running||!enabled())return {skipped:true};running=true;
  try{const references=await readReferences();if(references.companyId!==100174||! /^[1-9]\d*$/.test(String(references.locationId||'')))throw Error('Dépôt de préparation Erplain non vérifié');
   locationId=String(references.locationId);identity=null;return await worker.run();
  }finally{running=false;}
 }};
}
