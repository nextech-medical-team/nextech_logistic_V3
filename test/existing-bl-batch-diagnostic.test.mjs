import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const context=vm.createContext({});vm.runInContext(readFileSync(new URL('../public/compact-problems.js',import.meta.url),'utf8'),context);
const lot='BL · Lot de traçabilité Erplain · SKU : activer la gestion des lots et renseigner un numéro de lot dans Erplain — création BL bloquée';
const order=()=>({id:'o',channel:'temu',carrier:'temu',source_payload:{},sku_lines:[{sku:'SKU',quantity:1}],erp_live:{bc:{id:'1'}},erp_live_job:{status:'complete'},resolution_error:lot});
const problems=o=>context.compactProblems(o);
test('lot creation alerts disappear for an identified existing BL, across all alert sources',()=>{
 for(const status of ['unpublished','pending','make_the_shipment','in_preparation','ready_to_ship','shipped','delivered','completed']){
  const o=order();o.erp_live.bl={id:'2',status};o.issue=lot;o.erp_live_job.error=lot;o.sku_lines[0].catalog_issue=lot;assert.equal(problems(o).filter(p=>p.type==='batch').length,0,status);
 }
});
test('existing BL does not hide carrier, address, quota or purchase errors',()=>{
 const o=order();o.erp_live.bl={id:'2',status:'ready_to_ship'};o.issue='Erplain HTTP 429';o.temu_job={status:'failed',error:'Achat d’étiquette TEMU à confirmer : Marge nulle ou négative'};
 const p=problems(o);assert.ok(p.some(p=>p.type==='api-limit'));assert.ok(p.some(p=>p.type==='temu-purchase-confirmation'));assert.ok(!p.some(p=>p.type==='batch'));
});
test('orders without a BL, cancelled BLs, and partial remainders retain lot alerts',()=>{
 for(const patch of [{},{erp_live:{bc:{id:'1'},bl:{id:'2',status:'cancelled'}}},{erp_live:{bc:{id:'1'},bl:{id:'2',status:'ready_to_ship'}},partial_mode:true},{erp_live:{bc:{id:'1'},bl:{label:'SHO00746677',status:'ready_to_ship'}}}])assert.ok(problems({...order(),...patch}).some(p=>p.type==='batch'));
});
test('a synchronized identified BL also retires the creation alert without modifying the order',()=>{
 const o=order();o.erplain_tracking_bls=[{id:'2',status:'ready_to_ship'}];const before=JSON.stringify(o);assert.ok(!problems(o).some(p=>p.type==='batch'));assert.equal(JSON.stringify(o),before);
});
