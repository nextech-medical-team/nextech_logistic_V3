import test from 'node:test';
import assert from 'node:assert/strict';
import {assertTemuEurTotal,convertTemuPricingToEur,verifyTemuEurRecovery} from '../src/temu-eur-pricing.mjs';
import {verifyBcPricing} from '../src/bc-pricing.mjs';

function pricing(currency, grossRows, vat) {
 const lineAmounts=grossRows.map((gross,i)=>({
  type:i===0?'normal':'shipping_cost',variantId:i===0?'42':'',quantity:1,taxCodes:['25'],gross,rate:vat
 }));
 return {
  version:2,source:'temu',currency,tax_type:'exclusive',
  total:grossRows.reduce((sum,gross)=>sum+gross,0),tax:0,lineAmounts,
  items:lineAmounts.map(l=>({type:l.type,...(l.variantId?{variant:{id:l.variantId}}:{}),quantity:1,price:l.gross,tax_codes:[{id:'25'}],apply_discount_rules:false}))
 };
}
for(const [currency,gross,rate,vat,expected,tax] of [
 ['DKK',941.97,7.4758,25,126,25.20],
 ['CZK',896.56,24.42,21,36.71,6.37]
]){
 test(`TEMU ${currency} creates and verifies the exact EUR gross total`,()=>{
  const source=pricing(currency,[gross],vat);
  const converted=convertTemuPricingToEur(source,rate);
  assert.equal(converted.total,expected);
  assert.equal(converted.tax,tax);
  assert.equal(converted.items[0].price,expected);
  assert.equal(converted.conversion.currency,currency);
  assert.equal(source.currency,currency);
  const bc={currency:{label:'EUR'},total:expected,tax_type:'inclusive',line_items:converted.items.map(l=>({...l,tax_amount:tax,discount:0,discount_rule_amount:null,ecotax:null}))};
  assert.doesNotThrow(()=>assertTemuEurTotal(bc,converted));
  assert.doesNotThrow(()=>verifyBcPricing(bc,converted));
  assert.throws(()=>assertTemuEurTotal({...bc,total:expected+0.01},converted),/différent/);
 });
}
test('allocation conserves the rounded gross total and preserves freight',()=>{
 const source=pricing('DKK',[2,2],25);
 const converted=convertTemuPricingToEur(source,7.4758);
 assert.equal(converted.total,0.54);
 assert.deepEqual(converted.items.map(l=>[l.type,l.price]),[['normal',0.27],['shipping_cost',0.27]]);
 assert.deepEqual(convertTemuPricingToEur(source,converted.conversion.rate),converted);
 assert.throws(()=>convertTemuPricingToEur({...source,total:5},7.4758),/rapprocher/);
 assert.throws(()=>convertTemuPricingToEur(source,0),/invalide/);
});

test('recovered EUR creations validate saved totals and keep draft conversion',()=>{
 const converted=convertTemuPricingToEur(pricing('DKK',[941.97],25),7.4758);
 const order={erp_live:{temuEurPricing:converted}};
 const bc={id:'7',status:'unpublished',currency:{label:'EUR'},total:126,line_items:[{tax_amount:25.20}]};
 for(const status of ['active','unpublished']){
  assert.throws(()=>verifyTemuEurRecovery(order,{...bc,status,currency:{label:'DKK'}}),/Devise/);
  assert.throws(()=>verifyTemuEurRecovery(order,{...bc,status,total:127}),/total/);
 }
 assert.equal(verifyTemuEurRecovery(order,bc),converted);
 assert.equal(order.erp_live.temuEurVerifiedBcId,undefined);
 verifyTemuEurRecovery(order,{...bc,status:'active'});
 assert.equal(order.erp_live.temuEurVerifiedBcId,'7');
 assert.equal(verifyTemuEurRecovery(order,{...bc,total:127}),null);
 assert.throws(()=>verifyTemuEurRecovery(order,{...bc,id:'8',total:127}),/total/);
});
test('historical BCs and existing BLs do not acquire commercial recovery gates',()=>{
 const bc={id:'7',status:'active',currency:{label:'DKK'},total:999};
 assert.equal(verifyTemuEurRecovery({erp_live:{}},bc),null);
 for(const field of ['bl','stockDocument']){
  const order={erp_live:{temuEurPricing:{total:126,currency:'EUR'},[field]:{id:'9'}}};
  assert.equal(verifyTemuEurRecovery(order,bc),null);
  assert.equal(order.erp_live.temuEurVerifiedBcId,undefined);
 }
});

import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {erplainLiveWorker} from '../src/erplain-live-workflow.mjs';

test('worker reconciles uncertain EUR creation and rejects wrong currency without supplier writes',async()=>{
const dir=await mkdtemp(path.join(tmpdir(),'section7-eur-'));
try{
 await writeFile(path.join(dir,'currency-correspondence.json'),JSON.stringify({rows:[]}));
 await writeFile(path.join(dir,'live-workflow-references.json'),JSON.stringify({companyId:100174,locationId:'4',priceLevelId:'5'}));
 const results=[];
 for(const status of ['active','unpublished']){
  const o={id:'probe',channel:'temu',reference:'TEST',source_payload:{},erp_live:{phase:'creating_bc',temuEurPricing:{currency:'EUR',total:126,tax:25.2,conversion:{currency:'DKK',rate:7.4758}}}};
  const bc={id:'1',status,label:'BC-TEST',external_reference:'V3:probe',update_stock:true,total:941.97,currency:{label:'DKK'},line_items:[{id:'2',type:'normal',variant:{id:'3'},location:{id:'4'},quantity:1,price:941.97,tax_amount:188.39}]};
  const queries=[],errors=[],db={query:async(q,args)=>{queries.push(q);if(q.startsWith('SELECT * FROM orders'))return {rows:[o]};if(q.includes("status='review',error=$2"))errors.push(args[1]);return {rows:[]};},transaction:async fn=>fn(db)};
  const calls=[],api={verify:async()=>{},request:async q=>{assert.ok(q.startsWith('query '),'no supplier mutation');calls.push(q);if(q.includes('V3RecoverReference'))return {Orders:{data:[bc],paginatorInfo:{hasMorePages:false}}};if(q.includes('V3RecordedBcExecution'))return {Order:bc};throw Error('Unexpected query '+q);}};
  await erplainLiveWorker(db,dir,{api}).run({bcOnlyOrderId:o.id});
  assert.equal(o.erp_live.bc.id,'1');assert.ok(errors.some(e=>e.includes('Devise ou total en euros')),JSON.stringify(errors));assert.equal(calls.length,2);
  results.push({status,errors,providerReads:calls.length,providerWrites:0});
 }
 assert.equal(results.length,2);
}finally{await rm(dir,{recursive:true,force:true});}

});
