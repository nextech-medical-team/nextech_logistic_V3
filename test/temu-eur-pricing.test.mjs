import test from 'node:test';
import assert from 'node:assert/strict';
import {assertTemuEurTotal,convertTemuPricingToEur} from '../src/temu-eur-pricing.mjs';
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
