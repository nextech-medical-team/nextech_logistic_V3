import test from 'node:test';
import assert from 'node:assert/strict';
import {excelMoney,excelAmounts,excelPricing,customerDetails,matchesCustomer,findCustomer} from '../scripts/temu-excel-commercial.mjs';
const line=(extra={})=>({source_sku:'SKU',quantity:1,source_payload:{excel:{'Prix de vente (hors taxes)':'2,82€','Total du prix de base après réduction':'2,82€','Total du prix de vente après réductions (hors taxes)':'2,82€','Taxe sur les produits':'0,57€',"Total de l'expédition (hors taxes)":'2,49€',"Taxe d'expédition":'0,50€',...extra}}});
const order={channel:'temu',recipient:'Jean Martin',address:{street:'1 rue Test',city:'Paris',postal:'75001',country:'FR'}};
test('Slovak seller settlement stays 24.83 TTC with destination VAT 23 percent',()=>{
 const l=line({'Total du prix de base après réduction':'21,19€','Prix de vente (hors taxes)':'23,52€','Total du prix de vente après réductions (hors taxes)':'23,52€','Taxe sur les produits':'1,18€',"Total de l'expédition (hors taxes)":'2,34€',"Taxe d'expédition":'0,12€'});
 const o={...order,address:{...order.address,country:'SK'}},codes=[{id:'destination-tax',active:true,tax_rates:[{rate:23}]},{id:'product-tax',active:true,tax_rates:[{rate:20}]},{id:'source-tax',active:true,tax_rates:[{rate:5}]}];
 const product={variant:{id:'772608'},quantity:8,tax_codes:[{id:'product-tax'}]};
 const p=excelPricing(o,[l],[product],codes);
 assert.equal(p.total,24.83);assert.equal(p.tax,4.64);assert.equal(p.tax_type,'inclusive');assert.equal(p.taxPolicy,'temu_destination_standard_20261014');
 assert.equal(p.items[0].price*8,22.37);assert.equal(p.items[1].price,2.46);
 assert.ok(p.items.every(i=>i.tax_codes[0].id==='destination-tax'));
 assert.throws(()=>excelPricing(o,[l],[product],codes.filter(c=>c.id!=='destination-tax')),/TVA 23/);
 assert.throws(()=>excelPricing(o,[l],[product],[...codes,{id:'duplicate',active:true,tax_rates:[{rate:23}]}]),/ambiguë/);
});
test('Excel includes freight and tax, gross amounts remain exact after quantity conversion',()=>{
 const amounts=excelAmounts([line()]);assert.equal(amounts.total,6.38);assert.equal(amounts.net,5.31);assert.equal(amounts.tax,1.07);
 const pricing=excelPricing(order,[line()],[{variant:{id:'v'},tax_codes:[{id:'tax'}],quantity:50}], [{id:'tax',active:true,tax_rates:[{rate:20}]}]);assert.equal(pricing.tax_type,'inclusive');assert.equal(pricing.items[0].price*50,3.39);assert.equal(pricing.items[1].price,2.99);
});
test('Excel BC uses seller settlement 9.44 instead of buyer payment 10.03',async()=>{
 const {excelCommercialSource,verifiedExcelCommercial}=await import('../src/temu-excel-commercial.mjs');
 const l={...line({'Total du prix de base après réduction':'5,28€','Prix de vente (hors taxes)':'5,87€','Total du prix de vente après réductions (hors taxes)':'5,87€','Taxe sur les produits':'1,17€','Total payé':'10,03€'}),source_line:'item'};
 const o={...order,reference:'PO-069-03227667425913000',source_payload:{origin:'temu_excel'}};
 const amounts=excelCommercialSource(o,[l]);assert.equal(amounts.total,9.44);assert.equal(amounts.tax,1.67);assert.equal(amounts.net,7.77);
 const pricing=excelPricing(o,[l],[{variant:{id:'v'},tax_codes:[{id:'tax'}],quantity:1}],[{id:'tax',active:true,tax_rates:[{rate:20}]}]);
 assert.equal(pricing.total,9.44);assert.equal(pricing.items[0].price,6.45);assert.equal(pricing.items[1].price,2.99);
 o.source_payload.temuExcelCommercial={...amounts,total:10.03};
 assert.throws(()=>verifiedExcelCommercial(o,[l]),/modifiés/);
 delete l.source_payload.excel['Total du prix de base après réduction'];
 assert.throws(()=>excelAmounts([l]),/montant absent.*prix de base/);
});
test('discounts are applied once and bad amounts or currencies block',()=>{
 const l=line({'Prix de vente (hors taxes)':'3,82€','Réduction de la part du vendeur':'1€'});assert.equal(excelAmounts([l]).total,6.38);
 assert.equal(excelAmounts([line({'Prix de vente (hors taxes)':'10€'})]).total,6.38);
 assert.throws(()=>excelAmounts([line({'Total du prix de base après réduction':'invalide'})]),/invalide/);
 assert.throws(()=>excelAmounts([line({'Taxe sur les produits':''})]),/absent/);
 assert.throws(()=>excelAmounts([line({'Taxe sur les produits':'0.57 GBP'})]),/devises/);
 assert.throws(()=>excelAmounts([line({'Remboursement des produits':'1€'})]),/remboursement/);
 assert.throws(()=>excelMoney('abc','prix'),/invalide/);
});
test('individual default, explicit company only, matching requires full address and type',()=>{
 const details=customerDetails(order,[line({'prénom du destinataire':'Jean','nom de famille du destinataire':'Martin'})]);assert.equal(details.input.customer_type,'individual');assert.equal(details.input.first_name,'Jean');assert.equal(details.input.last_name,'Martin');
 const c={label:order.recipient,customer_type:'individual',addresses:{data:details.input.addresses.data}};assert.equal(matchesCustomer(c,details),true);assert.equal(matchesCustomer({...c,addresses:{data:[{...c.addresses.data[0],postal_code:'69001'}]}},details),false);
 assert.equal(customerDetails(order,[line({'Company name':'Entreprise Exemple'})]).input.customer_type,'company');
 assert.equal(customerDetails({...order,reference:'another'},[line()]).input.customer_number,details.input.customer_number);
});
test('existing customer reused, duplicate identities blocked',async()=>{
 const details=customerDetails(order,[line()]);const c={id:'known',label:order.recipient,customer_type:'individual',addresses:{data:details.input.addresses.data}};
 const api={read:async()=>({Customers:{data:[c]}})};assert.equal((await findCustomer(api,details)).id,'known');api.read=async()=>({Customers:{data:[c,{...c,id:'duplicate'}]}});await assert.rejects(findCustomer(api,details),/Plusieurs/);
});
test('localized TEMU currency symbols preserve amounts and disambiguate crowns by country',()=>{
 assert.deepEqual(excelMoney('102,57kr.','prix',{country:'DK'}),{amount:102.57,currency:'DKK'});
 assert.deepEqual(excelMoney('98,41kr','prix',{country:'SE'}),{amount:98.41,currency:'SEK'});
 assert.deepEqual(excelMoney('157,02 Kč','prix'),{amount:157.02,currency:'CZK'});
 assert.deepEqual(excelMoney('8 470,87 Ft','prix'),{amount:8470.87,currency:'HUF'});
 assert.throws(()=>excelMoney('102,57kr.','prix'),/ambiguë/);
 const l=line();for(const k of Object.keys(l.source_payload.excel))l.source_payload.excel[k]=l.source_payload.excel[k].replace('€','kr.');
 assert.equal(excelAmounts([l],{country:'DK'}).currency,'DKK');
});
test('TEMU sale price is a line total even when multiple units are purchased',()=>{
 const l={...line({'Prix de vente (hors taxes)':'67,25€','Total du prix de base après réduction':'67,25€','Total du prix de vente après réductions (hors taxes)':'67,25€','Taxe sur les produits':'16,80€',"Total de l'expédition (hors taxes)":'0€',"Taxe d'expédition":'0€'}),quantity:5};
 const amounts=excelAmounts([l],{country:'HR'});assert.equal(amounts.net,67.25);assert.equal(amounts.total,84.05);
 const pricing=excelPricing({...order,address:{...order.address,country:'HR'}},[l],[{variant:{id:'v'},tax_codes:[{id:'tax'}],quantity:5}],[{id:'tax',active:true,tax_rates:[{rate:25}]}]);assert.equal(pricing.items[0].quantity,5);assert.equal(Math.round(pricing.items[0].price*5*100),8405);
 const discounted={...line({'Prix de vente (hors taxes)':'30,35€','Total du prix de base après réduction':'21,24€','Total du prix de vente après réductions (hors taxes)':'21,24€','Réduction de la part du vendeur':'9,11€'}),quantity:5};assert.equal(excelAmounts([discounted]).rows[0].net,21.24);
 assert.equal(excelAmounts([{...l,source_payload:{excel:{...l.source_payload.excel,'Total du prix de vente après réductions (hors taxes)':'336,25€'}}}]).total,84.05);
});


test('Excel selects destination tax instead of product defaults or source tax',async()=>{
 const {buildBcPricing,rateFromTax}=await import('../src/bc-pricing.mjs');
 const codes=[5,5.5,20,21,23].map(rate=>({id:String(rate),active:true,tax_rates:[{rate}]}));
 const order={channel:'temu',address:{country:'SK'},source_payload:{origin:'temu_excel'}};
 const lines=[{source_line:'item',source_sku:'SKU',quantity:1,source_payload:{excel:{'Prix de vente (hors taxes)':'23,52 €','Total du prix de base après réduction':'23,52 €','Total du prix de vente après réductions (hors taxes)':'23,52 €','Taxe sur les produits':'1,18 €',"Total de l'expédition (hors taxes)":'2,34 €',"Taxe d'expédition":'0,12 €'}}}];
 const pricing=buildBcPricing(order,lines,[{variant:{id:'variant'},tax_codes:[{id:'20'}],quantity:8}],codes);
 assert.equal(pricing.total,27.16);assert.equal(pricing.tax,5.08);
 assert.ok(pricing.items.every(item=>item.tax_codes.length===1&&item.tax_codes[0].id==='23'));
 assert.equal(rateFromTax(2.34,.12,codes,'SK',{preferExactRate:true}),5);
 // A true rounded tie is still ambiguous; the country does not invent a rate.
 assert.throws(()=>rateFromTax(2.34,.12,[...codes,{id:'5.1',active:true,tax_rates:[{rate:5.1}]}],'SK',{preferExactRate:true}),/préciser/);
 // Existing non-Excel behaviour is preserved.
 assert.throws(()=>rateFromTax(2.34,.12,codes,'SK'),/préciser/);
});
