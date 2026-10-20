import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {documentMetadata,representativeLabel} from '../src/erplain-document-metadata.mjs';
import {buildBcPricing} from '../src/bc-pricing.mjs';

test('all TEMU countries and missing country use the configured TEMU FR manager',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'v3-temu-manager-'));
 try{
  await writeFile(path.join(directory,'account-representatives.json'),JSON.stringify({sourceCompany:100174,targetCompany:100174,rows:[{label:'TEMU FR',active:true,liveId:'42'},{label:'TEMU DE',active:true,liveId:'99'}]}));
  for(const country of ['FR','DE','IT','SK','HU','BE','ES','NL','PL','RO','CH','GB','']){
   const o={channel:'temu',reference:'PO-TEST',address:{country},source_payload:{temuCountry:country},erp_live:{}};
   assert.equal(representativeLabel(o),'TEMU FR');
   assert.deepEqual(await documentMetadata(o,directory),{external_reference:'PO-TEST',account_representative:{id:'42'}});
   assert.equal(o.address.country,country);
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('missing or ambiguous representative is an observation; exact mapped assignment and company guard remain',async()=>{
 const parent=path.resolve(os.tmpdir()),directory=await mkdtemp(path.join(parent,'v3-representative-'));
 try{
  for(const state of ['missing-file','missing','ambiguous','mapped','wrong-company']){
   if(state!=='missing-file')await writeFile(path.join(directory,'account-representatives.json'),JSON.stringify({sourceCompany:state==='wrong-company'?99:100174,targetCompany:100174,rows:state==='missing'?[]:Array.from({length:state==='ambiguous'?2:1},(_,i)=>({label:'TEMU FR',active:true,liveId:String(i+1)}))}));
   const order={id:'a',reference:'REF',channel:'temu',source_payload:{temuCountry:'IT'},erp_live:{}};
   if(state==='wrong-company'){await assert.rejects(()=>documentMetadata(order,directory),/hors société/);continue;}
   const data=await documentMetadata(order,directory);assert.equal(data.external_reference,'REF');
   if(state==='mapped')assert.deepEqual(data.account_representative,{id:'1'});else{assert.equal(data.account_representative,undefined);assert.equal(order.erp_live.accountRepresentativeObservation.blocking,false);}
  }
 }finally{assert.equal(path.dirname(path.resolve(directory)),parent);assert.ok(path.basename(directory).startsWith('v3-representative-'));await rm(directory,{recursive:true,force:true});}
});
test('source discounts and inconsistent totals do not prevent a BC; quantities and real unit prices are retained',()=>{
 const order={channel:'samples',source_payload:{},address:{country:'FR'}},line={quantity:2,source_sku:'A',source_payload:{puht:10,taxes:20,total:999,rem:10}},product={quantity:2,variant:{id:1}};
 const p=buildBcPricing(order,[line],[product],[{id:'tax',tax_rates:[{rate:20}]}]);
 assert.equal(p.items[0].quantity,2);assert.equal(p.items[0].price,10);assert.equal(p.items[0].apply_discount_rules,true);assert.equal(p.sourceTotalObservation.blocking,false);assert.equal(p.commercialObservations[0].received,10);
 assert.throws(()=>buildBcPricing(order,[{...line,quantity:0}],[product],[{id:'tax',tax_rates:[{rate:20}]}]),/Quantité/);
});
test('received shipping charge is sent even when source tax is unspecified; no rate is invented',()=>{
 const p=buildBcPricing({channel:'samples',source_payload:{coutsdexpedition:5},address:{country:'FR'}},[{quantity:2,source_sku:'A',source_payload:{puht:10,taxes:20}}],[{quantity:2,variant:{id:1}}],[{id:'tax',tax_rates:[{rate:20}]}]);
 assert.equal(p.items[0].quantity,2);assert.equal(p.items[1].type,'shipping_cost');assert.equal(p.items[1].price,5);assert.equal(Object.hasOwn(p.items[1],'tax_codes'),false);assert.equal(p.taxSourceComplete,false);assert.equal(p.lineAmounts[1].taxUnspecified,true);
});
test('incoherent Amazon tax uses only an explicit ERP product rate and keeps real products/quantities',()=>{
 const o={channel:'amazon',source_payload:{currency:'EUR'},address:{country:'FR'}},line={quantity:2,source_sku:'A',source_payload:{itemprice:12,itemtax:8,shippingprice:0,shippingtax:0}},product={quantity:2,variant:{id:1},tax_codes:[{id:'tax'}]},codes=[{id:'tax',tax_rates:[{rate:20}]}];
 const p=buildBcPricing(o,[line],[product],codes);assert.equal(p.items[0].quantity,2);assert.equal(p.items[0].price,5);assert.deepEqual(p.items[0].tax_codes,[{id:'tax'}]);assert.equal(p.commercialObservations[0].blocking,false);
 assert.throws(()=>buildBcPricing(o,[line],[{...product,tax_codes:undefined}],codes),/TVA/);
});
