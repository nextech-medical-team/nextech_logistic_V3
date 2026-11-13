import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBcPricing,verifyBcPricing} from '../src/bc-pricing.mjs';
const codes=[{id:'vat',tax_rates:[{rate:20}]}];
function fixture({included=true,price=219.2,quantity=1,discounts=[10.96],erpQuantity=4000,tax=34.71,total=208.24}={}){
 const order={channel:'shopify',source_payload:{currency:'EUR',taxes_included:included,total_price:String(total),shipping_lines:[]}};
 const lines=[{source_sku:'TEST',quantity,source_payload:{price:String(price),discount_allocations:discounts.map(amount=>({amount:String(amount)})),tax_lines:[{rate:0.2,price:String(tax)}]}}];
 const products=[{quantity:erpQuantity,variant:{id:'v'}}];
 return {order,lines,products,pricing:buildBcPricing(order,lines,products,codes)};
}
function actual(p){return {total:p.total,currency:{label:'EUR'},tax_type:p.tax_type,line_items:p.items.map((l,i)=>({...l,price:Number(l.price.toFixed(4)),tax_amount:p.lineAmounts[i].tax,discount:l.discount??0,discount_rule_amount:0,ecotax:0}))};}
test('13003: original TTC price and separate allocated discount survive pack conversion',()=>{
 const {pricing:p}=fixture();const l=p.items[0];
 assert.equal(p.tax_type,'inclusive');assert.ok(Math.abs(l.price-0.0548)<1e-15);assert.equal(l.discount,5);assert.equal(l.discount_type,'percentage');assert.equal(l.apply_discount_rules,false);
 assert.equal(Math.round(l.price*l.quantity*(1-l.discount/100)*100)/100,208.24);
 assert.equal(p.sourceLinesTotal,208.24);assert.equal(Number(p.lineAmounts[0].gross.toFixed(2)),208.24);
 assert.doesNotThrow(()=>verifyBcPricing(actual(p),p));
 for(const patch of [{discount:0},{discount:10},{discount_type:'amount'},{price:0.05206}]){const a=actual(p);Object.assign(a.line_items[0],patch);assert.throws(()=>verifyBcPricing(a,p));}
});
test('HT Shopify prices stay HT and multiple allocations are applied once',()=>{
 const {pricing:p}=fixture({included:false,price:100,quantity:2,erpQuantity:20,discounts:[10,20],tax:34,total:204});
 assert.equal(p.tax_type,'exclusive');assert.equal(p.items[0].price,10);assert.equal(p.items[0].discount,15);assert.equal(p.total,204);
 assert.doesNotThrow(()=>verifyBcPricing(actual(p),p));
});
test('zero, full and cent-rounded discounts retain source amounts',()=>{
 for(const discounts of [[],[100],[6.43]]){
  const d=discounts.reduce((s,v)=>s+v,0),{pricing:p}=fixture({price:100,discounts,erpQuantity:1,tax:0,total:100-d});
  assert.equal(p.items[0].price,100);assert.equal(p.items[0].discount??0,d);
  assert.doesNotThrow(()=>verifyBcPricing(actual(p),p));
 }
 const {pricing:p}=fixture({price:128.72,discounts:[6.43],erpQuantity:100,tax:20.38,total:122.29});
 assert.equal(p.items[0].price,1.2872);assert.equal(Number(p.lineAmounts[0].gross.toFixed(2)),122.29);
 assert.doesNotThrow(()=>verifyBcPricing(actual(p),p));
});
test('missing or excessive Shopify discounts fail before a document is sent',()=>{
 assert.throws(()=>fixture({discounts:[220]}),/Remise supérieure/);
 const {order,lines,products}=fixture();delete lines[0].source_payload.discount_allocations;
 assert.throws(()=>buildBcPricing(order,lines,products,codes),/Remises à actualiser/);
});
