import test from 'node:test';
import assert from 'node:assert/strict';
import {manualPricingData} from '../src/temu-manual-pricing.mjs';
import {temuCommercialSource} from '../src/temu-commercial-source.mjs';
import {temuCountryAmounts} from '../src/temu-country-vat.mjs';
import {temuPricingIssue,ensureTemuBcPricing} from '../src/temu-bc-pricing.mjs';
import {buildBcPricing,sourceCurrency} from '../src/bc-pricing.mjs';
function fixture(currency='SEK',vatRate=25){
 const o={channel:'temu',reference:'PO-TEST',address:{country:'SE'},source_payload:{}};
 const lines=[{id:'L',source_line:'LINE',source_sku:'SKU',quantity:3}];
 const data=manualPricingData(o,lines,{currency,vatRate,priceLines:[{id:'L',quantity:3,unitPriceHt:'2.13',shippingTtc:'1.01'}]});
 o.source_payload.temuManualPricing={data,vatRate,at:'2026-10-12T11:00:00Z',source:'manual_user'};return {o,lines};
}
test('manual seller HT, quantities, shipping and entered VAT price BC without API, preserving raw records',async()=>{
 for(const currency of ['EUR','SEK'])for(const rate of [0,25,27,27.5]){
  const {o,lines}=fixture(currency,rate);o.source_payload.temuAmounts={data:{parentOrderMap:{estimatedRevenue:{amount:999999,currency:'USD'}}}};
  const before=structuredClone(o);assert.equal(temuPricingIssue(o,lines),null);assert.equal(sourceCurrency(o),currency);
  const d=temuCommercialSource(o,temuCountryAmounts(o));assert.equal(d.parentOrderMap.estimatedRevenue.amount,639+Math.round(639*rate/100)+101);assert.equal(d.v3CommercialBasis.field,'manualSellerTotal');
  const pricing=buildBcPricing(o,lines,[{variant:{id:'V'},quantity:30}],[{id:'T',active:true,tax_rates:[{rate}]}]);assert.equal(pricing.currency,currency);assert.equal(pricing.total,d.parentOrderMap.estimatedRevenue.amount/100);assert.equal(pricing.items[0].quantity,30);assert.ok(Math.abs(pricing.items[0].price*30-6.39)<1e-9);
  assert.equal(await ensureTemuBcPricing({},o,lines,()=>assert.fail('API must not run')),false);assert.deepEqual(o,before);
 }
});
test('manual source fails closed for invalid provenance, currencies, quantities, identity and totals; no API fallback',async()=>{
 for(const change of [o=>o.source_payload.temuManualPricing.source='unknown',o=>o.source_payload.temuManualPricing.at='invalid',o=>o.source_payload.temuManualPricing.data.parentOrderMap.parentOrderSn='OTHER',o=>o.source_payload.temuManualPricing.data.orderList[0].unitBasePrice.amount=1,o=>o.source_payload.temuManualPricing.data.orderList[0].basePrice.amount=true,o=>o.source_payload.temuManualPricing.data.orderList[0].quantity=0,o=>o.source_payload.temuManualPricing.data.orderList[0].shipTaxAmount.amount=200,o=>o.source_payload.temuManualPricing.data.orderList[0].basePrice.currency='USD']){
  const {o,lines}=fixture();change(o);assert.ok(temuPricingIssue(o,lines));await assert.rejects(ensureTemuBcPricing({},o,lines,()=>assert.fail('API fallback forbidden')));
 }
 const {o,lines}=fixture();lines[0].quantity=4;assert.match(temuPricingIssue(o,lines),/Quantité/);assert.ok(temuPricingIssue(o,[]));
});
test('API seller requirement remains when no manual seller entry exists',()=>{
 const {o,lines}=fixture();delete o.source_payload.temuManualPricing;assert.match(temuPricingIssue(o,lines),/estimatedRevenue/);
});
