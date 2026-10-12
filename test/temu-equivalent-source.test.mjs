import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileTemuCatchup} from '../src/temu-catchup-reconcile.mjs';

const reason='TEMU · Données source différentes : articles/quantités · Rapprochement à vérifier';
function fixture(){
 const original={source_line:'069-08030614922871380',source_sku:'1999905275',quantity:'10'};
 const detail={parentOrderMap:{parentOrderSn:'PO-069-08030609679991380',parentOrderStatus:2,updateTime:100},orderList:[{orderSn:original.source_line,quantity:10,productList:[{extCode:original.source_sku}]}]};
 const shipping={receiptName:'TEST',addressLine1:'1 rue Test',postCode:'75001',regionName3:'Paris'};
 const order={id:'TEST',channel:'temu',reference:detail.parentOrderMap.parentOrderSn,address:{name:'TEST',street:'1 rue Test',postal:'75001',city:'Paris',country:'FR'},issue:reason,erp_live:{bc:{id:'BC'},bl:{id:'BL'},equivalentOriginalLines:[original]},source_payload:{marketplacePendingCorrection:{detail:structuredClone(detail),shipping,country:'FR',sourceCatchupConflicts:['articles/quantités']}}};
 const lines=[{source_line:'replacement',source_sku:'Safecare-XL',quantity:1000,target_sku:'Safecare-XL',target_quantity:1000}];
 const observation={reference:order.reference,coreComplete:true,complete:true,sourceVersion:100,checkedAt:'2026-10-11T20:00:00Z',coverage:{},errors:[],payload:{detail,shipping,country:'FR',amounts:{total:100}}};
 const queries=[];let saved;
 const tx={query:async(sql,args)=>{queries.push(sql);if(sql.startsWith('SELECT * FROM lines'))return {rows:structuredClone(lines)};if(sql.startsWith('SELECT\n EXISTS'))return {rows:[{prepared:true,busy:false}]};if(sql.startsWith('UPDATE orders SET address'))saved={source:JSON.parse(args[3]),issue:args[4]};return {rows:[]};}};
 delete order.erp_live.bc;delete order.erp_live.bl;
 return {order,lines,observation,queries,tx,get saved(){return saved;}};
}
test('PO069: source ten boxes matches original while replacement remains 1000 pieces; stale owned conflict clears',async()=>{
 const f=fixture(),before=structuredClone(f.order.erp_live),lines=structuredClone(f.lines);
 assert.deepEqual((await reconcileTemuCatchup(f.tx,f.order,f.observation)).conflicts,[]);
 assert.equal(f.saved.issue,null);assert.equal(f.saved.source.marketplacePendingCorrection,undefined);
 assert.deepEqual(f.order.erp_live,before);assert.deepEqual(f.lines,lines);
 assert.ok(f.queries.every(sql=>! /^(UPDATE lines|DELETE FROM lines|INSERT INTO lines|INSERT INTO erp_live_jobs|INSERT INTO carrier)/.test(sql)));
});
test('Before BC, actual TEMU quantity, SKU, line, address and amount changes still block',async()=>{
 for(const [change,expected] of [[f=>f.observation.payload.detail.orderList[0].quantity=9,'articles/quantités'],[f=>f.observation.payload.detail.orderList[0].productList[0].extCode='OTHER','articles/quantités'],[f=>f.observation.payload.detail.orderList[0].orderSn='OTHER','articles/quantités'],[f=>f.observation.payload.shipping.postCode='10000','adresse'],[f=>{f.order.source_payload.temuAmounts={data:{total:101}};},'montants']]){
  const f=fixture();change(f);assert.ok((await reconcileTemuCatchup(f.tx,f.order,f.observation)).conflicts.includes(expected));assert.equal(f.saved.issue,reason);
 }
});
test('invalid original snapshot fails closed instead of falling back to replacement',async()=>{
 for(const snapshot of [null,[],[{}],[{source_line:'L',source_sku:'SKU',quantity:0}],Array(2).fill({source_line:'L',source_sku:'SKU',quantity:1})]){
  const f=fixture();f.order.erp_live.equivalentOriginalLines=snapshot;assert.ok((await reconcileTemuCatchup(f.tx,f.order,f.observation)).conflicts.includes('articles/quantités'));
 }
});
test('unrelated review, incomplete read and pending true historical change are preserved',async()=>{
 for(const change of [f=>f.order.issue='Stock insuffisant',f=>f.observation.complete=false,f=>f.order.source_payload.marketplacePendingCorrection.sourceCatchupConflicts=['adresse'],f=>f.order.source_payload.marketplacePendingCorrection.detail.orderList[0].quantity=9]){
  const f=fixture();change(f);const prior=structuredClone(f.order.source_payload.marketplacePendingCorrection),issue=f.order.issue;await reconcileTemuCatchup(f.tx,f.order,f.observation);assert.deepEqual(f.saved.source.marketplacePendingCorrection,prior);assert.equal(f.saved.issue,issue);
 }
});
test('orders without substitution use current source lines and preserve genuine changes',async()=>{
 const f=fixture();delete f.order.erp_live.equivalentOriginalLines;f.lines.splice(0,1,{source_line:'069-08030614922871380',source_sku:'1999905275',quantity:10});assert.deepEqual((await reconcileTemuCatchup(f.tx,f.order,f.observation)).conflicts,[]);f.observation.payload.detail.orderList[0].quantity=11;assert.ok((await reconcileTemuCatchup(f.tx,f.order,f.observation)).conflicts.includes('articles/quantités'));
});

// These are the same provider differences, now observed after BC acceptance.
// Only the cancellation/refund facts may enter the operational continuation.
test('After BC, equivalents and all changed provider content cannot request a new commercial review',async()=>{
 for(const change of [f=>f.observation.payload.detail.orderList[0].quantity=9,f=>f.observation.payload.detail.orderList[0].productList[0].extCode='OTHER',f=>f.observation.payload.detail.orderList[0].orderSn='OTHER',f=>f.observation.payload.shipping.postCode='10000',f=>f.order.source_payload.temuAmounts={data:{total:101}},f=>f.order.erp_live.equivalentOriginalLines=null,f=>delete f.order.erp_live.equivalentOriginalLines]){
  const f=fixture();f.order.erp_live.bc={id:'BC'};f.order.erp_live.bl={id:'BL'};change(f);
  const before=structuredClone({erp:f.order.erp_live,address:f.order.address,lines:f.lines});const writes=[];
  const tx={query:async(sql,args)=>{writes.push({sql,args});assert.ok(sql.startsWith('UPDATE orders SET source_payload='));return {rows:[]};}};
  const result=await reconcileTemuCatchup(tx,f.order,f.observation);
  assert.deepEqual(result.conflicts,[]);assert.equal(result.contentFrozen,true);assert.equal(f.order.issue,null);
  assert.deepEqual({erp:f.order.erp_live,address:f.order.address,lines:f.lines},before);
  const lifecycle=JSON.parse(writes.at(-1).args[1]).platformLifecycleObservation;assert.equal(lifecycle.cancelled,false);assert.equal(lifecycle.scope,'cancellation-refund-only');assert.equal(lifecycle.orderList,undefined);
 }
});
test('After BC, cancellation/refund observations preserve real stock issues and existing documents',async()=>{
 const f=fixture();f.order.erp_live.bc={id:'BC'};f.order.issue=reason+' ; Stock insuffisant';f.observation.payload.detail.parentOrderMap.parentOrderStatus=3;
 f.observation.payload.amounts={parentOrderMap:{parentOrderSn:f.order.reference,refundsTotal:{amount:100,currency:'EUR'},customerPaid:{amount:100,currency:'EUR'}}};
 const before=structuredClone(f.order.erp_live),writes=[];await reconcileTemuCatchup({query:async(sql,args)=>{writes.push({sql,args});assert.ok(sql.startsWith('UPDATE orders SET source_payload='));return {rows:[]};}},f.order,f.observation);
 assert.equal(f.order.issue,'Stock insuffisant');assert.deepEqual(f.order.erp_live,before);const ob=JSON.parse(writes.at(-1).args[1]).platformLifecycleObservation;assert.equal(ob.cancelled,true);assert.equal(ob.refundStatus,'full');
});
