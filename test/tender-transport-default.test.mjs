import test from 'node:test';
import assert from 'node:assert/strict';
import {route} from '../src/domain.mjs';
import {chosenRoute,defaultRouting,loadRouting} from '../src/routing.mjs';
import {importedLabelMissingFields,resolveImportedLabelOrder} from '../src/erplain-label-required.mjs';
const bc=()=>({id:'bc',customer:{id:'client',label:'CLIENT'},account_representative:{label:"Appels d'offres"},external_reference:'REF',shipping_address:{label:'DEST',address_1:'1 RUE TEST',postal_code:'75001',city:'Paris',country:'FR',phone:''}});
const bl={id:'bl',label:'BL123',status:'in_preparation',orders:{data:[{id:'bc'}],paginatorInfo:{hasMorePages:false}}};
const order=()=>({channel:'erplain',carrier:'gls',address:{country:'FR'},source_payload:{erplainImported:true,account:'live'},erp_live:{bc:bc(),bl}});
test('native and imported tender orders default to GLS at all weights',()=>{
 for(const weight of [.8,31]){
  assert.equal(route('tender',weight).carrier,'gls');
  assert.equal(chosenRoute({channel:'tender',address:{country:'FR'}},weight).carrier,'gls');
  for(const label of ["Appels d'offres",' APPELS D’OFFRES ',"Appel d'offres"]){const o=order();o.erp_live.bc.account_representative.label=label;assert.deepEqual(chosenRoute(o,weight),{carrier:'gls',weight,parcels:Math.ceil(weight/30)});}
 }
});
test('installed Pharma default upgrades to GLS without mutating settings',async()=>{
 const config=structuredClone(defaultRouting);config.rules.find(r=>r.channel==='tender').fixed='gls_pharma';
 const before=structuredClone(config),loaded=await loadRouting({query:async()=>({rows:[{value:config}]})});
 assert.equal(chosenRoute(order(),1,loaded).carrier,'gls');assert.deepEqual(config,before);
 assert.deepEqual(loaded.rules.filter(r=>r.channel!=='tender'),config.rules.filter(r=>r.channel!=='tender'));
});
test('imported tender label accepts absent phone and keeps other required fields',async()=>{
 const document=bc(),api={verify:async()=>{},request:async()=>({Order:document,ShippingOrder:bl})};
 assert.deepEqual(importedLabelMissingFields(document,bl),[]);
 const result=await resolveImportedLabelOrder(order(),api);assert.equal(result.address.phone,'');assert.equal(result.carrier,'gls');
 document.shipping_address.city='';assert(importedLabelMissingFields(document,bl).some(x=>x.includes('Ville')));
});
test('phone remains required for other imported account managers',async()=>{
 const document=bc();document.account_representative.label='Commercial';
 assert(importedLabelMissingFields(document,bl).some(x=>x.includes('téléphone')));
 await assert.rejects(resolveImportedLabelOrder(order(),{verify:async()=>{},request:async()=>({Order:document,ShippingOrder:bl})}),/téléphone/);
});

test('associated BL label keeps its delivery address and optional tender phone',async()=>{
 const document=bc(),delivery={...structuredClone(bl),shipping_address:{label:'BL DEST',address_1:'2 RUE BL',postal_code:'69001',city:'Lyon',country:'FR',phone:null}};
 const input={...order(),associated_bl_label:true};let query;
 const result=await resolveImportedLabelOrder(input,{verify:async()=>{},request:async q=>{query=q;return {Order:document,ShippingOrder:delivery};}});
 assert.match(query,/ShippingOrder\(id:\$bl\).*shipping_address/);
 assert.equal(result.address.name,'BL DEST');assert.equal(result.address.street1,'2 RUE BL');
 assert.equal(result.address.city,'Lyon');assert.equal(result.address.postal,'69001');assert.equal(result.address.phone,'');
 assert.equal(result.carrier,'gls');
 delivery.shipping_address.city='';await assert.rejects(()=>resolveImportedLabelOrder(input,{verify:async()=>{},request:async()=>({Order:document,ShippingOrder:delivery})}),/Ville/);
});

test('associated BL falls back to the order address only when BL address is absent',async()=>{
 const document=bc(),delivery=structuredClone(bl),input={...order(),associated_bl_label:true,address:{phone:'0144556677'}};
 const result=await resolveImportedLabelOrder(input,{verify:async()=>{},request:async()=>({Order:document,ShippingOrder:delivery})});
 assert.equal(result.address.street1,'1 RUE TEST');assert.equal(result.address.phone,'0144556677');
 input.associated_bl_label=false;const ordinary=await resolveImportedLabelOrder(input,{verify:async()=>{},request:async()=>({Order:document,ShippingOrder:{...delivery,shipping_address:{label:'OTHER',city:'Lyon'}}})});
 assert.equal(ordinary.address.city,'Paris');assert.equal(ordinary.address.phone,'');
});
