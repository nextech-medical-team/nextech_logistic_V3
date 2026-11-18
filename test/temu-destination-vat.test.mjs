import test from 'node:test';
import assert from 'node:assert/strict';
import {temuDestinationVat,temuDestinationRates} from '../src/temu-destination-vat.mjs';
import {buildBcPricing} from '../src/bc-pricing.mjs';
import {temuCommercialSource} from '../src/temu-commercial-source.mjs';
const m=amount=>({amount,currency:'EUR'});
for(const [country,rate] of Object.entries(temuDestinationRates))test(country+' uses destination '+rate+'% for Excel and API, preserving seller TTC',()=>{
 const o={channel:'temu',reference:'PO-1-2',address:{country},source_payload:{origin:'temu_excel'}};
 const lines=[{source_line:'item',source_sku:'SKU',quantity:1,source_payload:{excel:{'Total du prix de base après réduction':'100 EUR','Taxe sur les produits':'20 EUR',"Total de l'expédition (hors taxes)":'10 EUR',"Taxe d'expédition":'2 EUR'}}}];
 const products=[{variant:{id:'v'},quantity:8,tax_codes:[{id:'wrong-default'}]}],codes=[{id:'destination',active:true,tax_rates:[{rate}]}];
 const excel=buildBcPricing(o,lines,products,codes);
 assert.equal(excel.total,132);assert.ok(excel.items.every(i=>i.tax_codes[0].id==='destination'));assert.ok(excel.lineAmounts.every(l=>l.rate===rate));
 o.source_payload={temuAmounts:{data:{parentOrderMap:{parentOrderSn:o.reference,estimatedRevenue:m(13200),basePriceTotal:m(10000),shippingAmountTotal:m(1000),taxTotal:m(2200)},orderList:[{orderSn:'item',quantity:1,basePrice:m(10000),productTaxAmount:m(2000),shipAmountTotalTaxIncl:m(1200),shipTaxAmount:m(200),productTaxRate:20000000,shipTaxRate:20000000}]}}};
 const original=structuredClone(o),api=buildBcPricing(o,lines,products,codes);
 assert.equal(api.total,132);assert.equal(api.tax,excel.tax);assert.ok(api.lineAmounts.every(l=>l.rate===rate));assert.deepEqual(o,original);
 assert.equal(temuCommercialSource(o).parentOrderMap.estimatedRevenue.amount,13200);
});
test('missing or unknown destination never silently uses France or the product default',()=>{
 for(const country of ['',null,'ZZ'])assert.throws(()=>temuDestinationVat({address:{country}}),/pays de livraison/);
 assert.equal(temuDestinationVat({address:{country:'hu'}}).rate,27);
 assert.equal(temuDestinationVat({address:{country:'EL'}}).rate,24);
 assert.equal(temuDestinationVat({address:{country:'UK'}}).rate,20);
});

test('reconciles a seller deduction for a partially cancelled TEMU line',()=>{
 const reference='PO-1-2',orderSn='item';
 const raw={
  parentOrderMap:{parentOrderSn:reference,estimatedRevenue:m(772),basePriceTotal:m(774),shippingAmountTotal:m(249),taxTotal:m(136),taxTotalAfterDiscount:m(136),estimatedRevenueDeduction:m(387)},
  orderList:[{orderSn,quantity:2,unitBasePrice:m(387),basePrice:m(774),productTaxAmount:m(172),shipAmountTotalTaxIncl:m(299),shipTaxAmount:m(50)}]
 };
 const order={channel:'temu',reference,address:{country:'FR'},source_payload:{
  temuAmounts:{data:raw},
  temuOrderDetail:{parentOrderMap:{parentOrderSn:reference},orderList:[{orderSn,quantity:1,originalOrderQuantity:2,canceledQuantityBeforeShipment:1}]}
 }};
 const original=structuredClone(order);
 const data=temuCommercialSource(order);
 assert.equal(data.orderList[0].quantity,1);
 assert.equal(data.parentOrderMap.estimatedRevenue.amount,772);
 assert.equal(data.v3PartialLineCancellation.coveredSellerDeduction,387);
 assert.deepEqual(order,original);
 raw.parentOrderMap.estimatedRevenueDeduction=m(386);
 assert.throws(()=>temuCommercialSource(order),/Retenue sur revenu/);
});
