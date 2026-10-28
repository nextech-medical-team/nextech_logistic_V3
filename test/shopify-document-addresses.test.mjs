import test from 'node:test';
import assert from 'node:assert/strict';
import {newSalesBcInput} from '../src/erplain-live-workflow.mjs';
import {normalizeShopifyOrders} from '../src/marketplace-local-import.mjs';
import {shopifyCollector} from '../src/marketplace-collection.mjs';
import {parseShopifyRows} from '../src/shopify-file-import.mjs';
import {marketplaceChangeFields} from '../src/marketplace-comparison.mjs';
import {unchangedPartialCommercial} from '../src/shopify-status-only-proof.mjs';

const customer={name:'Client Test',address1:'17 rue Client',zip:'83250',city:'Test',country_code:'FR'};
const destination={...customer,address1:'11 avenue Relais',address2:'MAISON DE LA PRESSE'};
function raw(relay=false){return {id:'123',name:'#TEST',updated_at:'2026-10-01T10:00:00Z',shipping_address:relay?destination:customer,billing_address:{...customer,address1:'22 rue Facture'},shipping_lines:[{title:relay?'Relais GLS':'GLS BusinessParcel'}],...(relay?{glsRelayId:{value:'GLS_FR-123'},glsRelayMetadata:{value:JSON.stringify({selectedRelais:'GLS_FR-123',originalShippingAddress:customer})}}:{}),line_items:[{id:'7',sku:'A',quantity:1}]};}
function order(source){return {...normalizeShopifyOrders([source])[0],channel:'shopify',erp_live:{customer:{id:1}},pricing:{tax_type:'exclusive',items:[]},currency:{id:1}};}
test('home delivery and billing use their separate Shopify addresses',()=>{
 const input=newSalesBcInput(order(raw()),1);
 assert.equal(input.shipping_address.address_1,'17 rue Client');
 assert.equal(input.billing_address.address_1,'22 rue Facture');
});
test('selected GLS relay is the document destination while operational client stays intact',()=>{
 const o=order(raw(true)),before=structuredClone(o.address),input=newSalesBcInput(o,1);
 assert.equal(input.shipping_address.address_1,'11 avenue Relais, MAISON DE LA PRESSE');
 assert.equal(input.billing_address.address_1,'22 rue Facture');
 assert.deepEqual(o.address,before);assert.equal(o.address.street,'17 rue Client');
});
test('missing billing falls back to the client, never the relay; incomplete billing blocks creation',()=>{
 const source=raw(true);delete source.billing_address;
 assert.equal(newSalesBcInput(order(source),1).billing_address.address_1,'17 rue Client');
 source.billing_address={...customer,zip:''};assert.throws(()=>newSalesBcInput(order(source),1),/facturation/);
});
test('other channels preserve their existing address behavior',()=>{
 const o=order(raw());o.channel='amazon';const input=newSalesBcInput(o,1);
 assert.deepEqual(input.billing_address,input.shipping_address);
});
test('billing changes are observed even when relay client address is unchanged',()=>{
 const source=raw(true),before=order(source),next=order({...source,billing_address:customer});
 assert.ok(marketplaceChangeFields(before,before.lines,next).includes('adresse de facturation'));
});
test('a billing edit cannot pass as a status-only partial order update',()=>{
 const source={...raw(),currency:'EUR',total_price:'10',taxes_included:true,line_items:[{id:'7',sku:'A',quantity:1,price:'10',tax_lines:[],discount_allocations:[]}]};
 const o={channel:'shopify',partial_mode:true,source_payload:source};
 assert.equal(unchangedPartialCommercial(o,{...source,fulfillment_status:'fulfilled'}),true);
 assert.equal(unchangedPartialCommercial(o,{...source,billing_address:customer}),false);
});
test('CSV import retains billing fields and postal leading zero',()=>{
 const parsed=parseShopifyRows([{row:2,name:'#TEST',id:'123',lineitemsku:'A',lineitemquantity:'1',shippingname:'Client',shippingaddress1:'1 rue Livraison',shippingzip:'75001',shippingcity:'Paris',shippingcountry:'FR',billingname:'Client',billingaddress1:'2 rue Facture',billingzip:"'01230",billingcity:'Test',billingcountry:'FR'}]);
 assert.equal(parsed.valid[0].source_payload.billing_address.zip,'01230');
 assert.equal(parsed.valid[0].source_payload.billing_address.address1,'2 rue Facture');
});
test('GraphQL order and poll read and preserve billing separately',async()=>{
 const n={id:'gid://shopify/Order/123',name:'#TEST',updatedAt:'2026-10-01T10:00:00Z',shippingAddress:{...destination,countryCodeV2:'FR'},billingAddress:{...customer,countryCodeV2:'FR'},lineItems:{nodes:[{id:'gid://shopify/LineItem/7',sku:'A',quantity:1}],pageInfo:{hasNextPage:false}},shippingLines:{nodes:[],pageInfo:{hasNextPage:false}}};
 const api=shopifyCollector({SHOPIFY_STORE_DOMAIN:'test.myshopify.com',SHOPIFY_ACCESS_TOKEN:'test'},{fetchImpl:async(url,options)=>{
  const {query}=JSON.parse(options.body);assert.match(query,/billingAddress\{name address1 address2 zip city countryCodeV2 phone\}/);
  return Response.json({data:query.includes('query NextechOrders(')?{orders:{nodes:[n],pageInfo:{hasNextPage:false}}}:{order:n}});
 }});
 const single=await api.order('123');assert.equal(single.billing_address.address1,customer.address1);assert.equal(single.shipping_address.address1,destination.address1);
 const page=await api.page({since:'2026-10-01',until:'2026-10-02'});assert.deepEqual(page.items[0].payload.billing_address,single.billing_address);
});
