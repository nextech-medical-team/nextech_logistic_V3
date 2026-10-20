import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {documentMetadata,externalReference,recoverOrder} from '../src/erplain-document-metadata.mjs';
const order=()=>({id:'synthetic',channel:'tender',reference:'AO-ORIGINAL',source_reference:'OTHER',source_payload:{importIdentityReference:true}});
test('excluded tender keeps installed external reference',()=>assert.equal(externalReference(order()),'AO-ORIGINAL'));
test('excluded tender keeps missing and ambiguous representative failures',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v3-tender-scope-'));
 try{
  await assert.rejects(documentMetadata(order(),dir),{code:'ENOENT'});
  await writeFile(path.join(dir,'account-representatives.json'),JSON.stringify({sourceCompany:100174,targetCompany:100174,rows:[]}));
  await assert.rejects(documentMetadata(order(),dir),/absent ou ambigu/);
  const row={label:"Appels d'offres",active:true,liveId:'123'};
  await writeFile(path.join(dir,'account-representatives.json'),JSON.stringify({sourceCompany:100174,targetCompany:100174,rows:[row,row]}));
  await assert.rejects(documentMetadata(order(),dir),/absent ou ambigu/);
  await writeFile(path.join(dir,'account-representatives.json'),JSON.stringify({sourceCompany:100174,targetCompany:100174,rows:[row]}));
  assert.deepEqual(await documentMetadata(order(),dir),{external_reference:'AO-ORIGINAL',account_representative:{id:'123'}});
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('excluded tender recovery keeps installed query and matching behavior',async()=>{
 let calls=0;
 const candidate={id:'123',status:'active',external_reference:'AO-ORIGINAL',customer:{customer_number:'V3:synthetic'}};
 const api={request:async(query,variables)=>{calls++;assert.match(query,/customer_number/);assert.equal(variables.where.OR[1].value,'AO-ORIGINAL');return {Orders:{data:[candidate],paginatorInfo:{hasMorePages:false}}};}};
 const db={query:()=>{throw Error('Unexpected new tender lookup');}};
 assert.deepEqual(await recoverOrder(api,order(),{db}),candidate);assert.equal(calls,1);
});

import {assertFullOrderStock} from '../src/stock-gate.mjs';
test('all stock paths including tender reject a real shortage without epsilon',()=>{
 const lines=[{variant:{id:'1',sku:'S',track_inventory:true},location:{id:'2'},quantity:1.0000005,available:1,on_hand:1,reserved_quantity:0}];
 assert.throws(()=>assertFullOrderStock(lines,{preserveInstalled:true}),/stock insuffisant/);
 assert.throws(()=>assertFullOrderStock(lines),/stock insuffisant/);
});
test('all stock paths including tender reject empty product documents',()=>{
 assert.throws(()=>assertFullOrderStock([],{preserveInstalled:true}),/sans produit/);
 assert.throws(()=>assertFullOrderStock([]),/sans produit/);
});


test('tender BC publication retains independent installed confirmation read',async()=>{
 const {publishIncrementalBc}=await import('../src/bc-numbering.mjs');
 for(const preserveInstalled of [true,false]){
  const calls=[],published={id:'7',label:'C123',status:'active',update_stock:false,line_items:[]};
  const api={request:async q=>{calls.push(q);if(q.includes('V3BcNumberRead'))return {Order:{...published,status:'unpublished'}};if(q.includes('V3BcNumber('))return {DocumentNumberingContext:{preview:'C123',manual_override_allowed_effective:true}};if(q.startsWith('mutation '))return {UpdateOrder:published};if(q.includes('V3BcNumberVerify'))return {Order:published};throw Error(q);}};
  await publishIncrementalBc(api,'7',{preserveInstalled,verify:()=>{},lock:fn=>fn()});
  assert.equal(calls.filter(q=>q.includes('V3BcNumberVerify')).length,preserveInstalled?1:0);
 }
});
