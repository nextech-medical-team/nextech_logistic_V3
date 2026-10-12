import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectTemuQuantities,temuFulfillmentBlock,projectTemuQuantityDiagnosis,cancelledTemuFulfillment,invalidTemuQuantities} from '../src/temu-fulfillment-quantities.mjs';
import {inspectTemu,temuShipping} from '../src/temu-shipping.mjs';
import {mutationBlock,retryDecision} from '../src/erp-transient-policy.mjs';
import {preparationBlock} from '../src/bc-authorization.mjs';
import {projectCurrentDiagnostics} from '../src/current-order-diagnostics.mjs';

const ref='PO-069-123456789';
const line=(overrides={})=>({orderSn:'069-123456789',quantity:0,orderStatus:3,originalOrderQuantity:1,canceledQuantityBeforeShipment:1,packageSnInfo:[],...overrides});
const detail=(items=[line()],status=3)=>({parentOrderMap:{parentOrderSn:ref,parentOrderStatus:status,expectShipLatestTime:1900000000},orderList:items});
const order=(overrides={})=>({channel:'temu',reference:ref,archived:false,source_payload:{temuOrderDetail:detail()},...overrides});

test('confirmed zero remainder blocks preparation and reports cancellation without changing data',()=>{
 const o=order({erp_live:{bc:{id:1},bl:{id:2},stockDocument:{id:3}},temu_job:{error:invalidTemuQuantities,status:'api_error'},issue:'stock insuffisant'});const before=structuredClone(o);
 assert.equal(temuFulfillmentBlock(o),cancelledTemuFulfillment);assert.equal(mutationBlock(o,{allowHeldBc:true}),cancelledTemuFulfillment);assert.equal(preparationBlock(o),cancelledTemuFulfillment);
 assert.throws(()=>inspectTemu(o.source_payload.temuOrderDetail,ref),{message:cancelledTemuFulfillment});
 projectCurrentDiagnostics(o);assert.equal(o.temu_job.error,cancelledTemuFulfillment);assert.equal(o.issue,before.issue);assert.deepEqual(o.erp_live,before.erp_live);assert.deepEqual(o.source_payload,before.source_payload);assert.equal(o.temu_job.status,'api_error');
 assert.equal(retryDecision(o,'Erplain HTTP 503',new Date(0).toISOString()),false);
});
test('partial cancellations retain only positive sale quantities and source remains immutable',()=>{
 const d=detail([line(),line({orderSn:'069-remaining',quantity:2,orderStatus:2,originalOrderQuantity:3,canceledQuantityBeforeShipment:1})],4),before=structuredClone(d);
 assert.deepEqual(inspectTemu(d,ref).lines,[{parentOrderSn:ref,orderSn:'069-remaining',quantity:2}]);assert.deepEqual(d,before);assert.equal(temuFulfillmentBlock(order({source_payload:{temuOrderDetail:d}})),null);
});
test('partially cancelled positive line already reports remaining quantity, cancellation is not subtracted twice',()=>{
 const d=detail([line({quantity:2,originalOrderQuantity:3,canceledQuantityBeforeShipment:1,orderStatus:2})],4);assert.equal(inspectTemu(d,ref).lines[0].quantity,2);
});
test('cancelled duplicate identity is still rejected before exclusion',()=>assert.throws(()=>inspectTemu(detail([line(),line()],4),ref),{message:invalidTemuQuantities}));
test('status or cancellation flag alone never becomes a business cancellation',()=>{
 for(const d of [detail([line({quantity:1})]),detail([line({canceledQuantityBeforeShipment:0})]),detail([line()],2),detail([line({orderStatus:2})])])assert.equal(temuFulfillmentBlock(order({source_payload:{temuOrderDetail:d}})),null);
 assert.equal(temuFulfillmentBlock(order({channel:'amazon'})),null);assert.equal(temuFulfillmentBlock(order({reference:'PO-069-other'})),null);
});
test('contradictory mixed cancellation and empty partial order both fail closed',()=>{
 assert.throws(()=>inspectTemu(detail([line(),line({orderSn:'remaining',quantity:1})]),ref),/Annulation incohérente/);assert.throws(()=>inspectTemu(detail([line()],4),ref),/aucun article restant à préparer/);
});
for(const quantity of [null,undefined,'',false,true,-1,0.5,'1.5','abc',Infinity,Number.MAX_SAFE_INTEGER+1])test('malformed quantity '+String(quantity)+' is not silently replaced',()=>assert.throws(()=>inspectTemuQuantities(detail([line({quantity})]),ref),{message:invalidTemuQuantities}));
for(const changes of [{orderSn:''},{orderSn:42},{originalOrderQuantity:null},{originalOrderQuantity:0},{canceledQuantityBeforeShipment:0},{canceledQuantityBeforeShipment:2},{canceledQuantityBeforeShipment:'1.5'}])test('zero line requires complete cancellation proof '+JSON.stringify(changes),()=>assert.throws(()=>inspectTemuQuantities(detail([line(changes)]),ref),{message:invalidTemuQuantities}));
test('integer sale quantity strings are accepted; ERP unit conversions never enter transport lines',()=>{
 for(const quantity of ['1','1.0','1.000000',' 1 ']){const d=detail([line({quantity,orderStatus:2})],2);assert.equal(inspectTemu(d,ref).lines[0].quantity,1);}
});
test('existing suspension and V3 cancellation remain authoritative',()=>{
 assert.match(mutationBlock(order({suspension:{active:true,reason:'stop'}})),/suspendue/);assert.match(mutationBlock(order({label_status:'cancelled'})),/dans V3/);
});
test('unrelated errors and uncertain purchases are preserved by presentation',()=>{
 const o=order({temu_job:{status:'uncertain',error:'Résultat achat incertain',attempt_id:'known'},issue:'Écart prix'});const before=structuredClone(o);projectTemuQuantityDiagnosis(o);assert.deepEqual(o,before);
});
test('cancelled label recovery uses known packages without applying shipment quantity validation',async()=>{
 const pkg='PK-12345',queries=[],reads=[];
 const db={query:async(sql,args)=>{queries.push(sql);if(sql.includes('SELECT channel,source_payload'))return {rows:[]};if(sql==='SELECT * FROM temu_label_jobs WHERE reference=$1')return {rows:[{packages:[pkg],result:{source:'temu_direct'}}]};if(sql.includes('SELECT package FROM temu_label_documents'))return {rows:[{package:pkg}]};if(sql.includes('SELECT count(*)'))return {rows:[{n:1}]};return {rows:[]};}};
 const api={read:async(type)=>{reads.push(type);if(type==='bg.logistics.shipment.result.get')return {packageInfoResultList:[{packageSn:pkg,orderSendInfoList:[{parentOrderSn:ref}],shippingLabelStatus:1}]};throw Error('Unexpected provider call');},buy:async()=>{throw Error('Purchase forbidden');}};
 await temuShipping(db,api).recover(ref,{packages:[pkg]});assert.deepEqual(reads,['bg.logistics.shipment.result.get']);assert(!queries.some(s=>s.includes('INSERT INTO temu_label_documents')||s.includes('UPDATE orders')));
});
test('cancelled quote stops before offers, plan writes or purchase',async()=>{
 const writes=[];const db={query:async(sql)=>{if(sql.startsWith('SELECT'))return {rows:[]};writes.push(sql);return {rows:[]};}};
 const api={read:async(type)=>{assert.equal(type,'bg.order.detail.v2.get');return detail();},buy:async()=>{throw Error('Purchase forbidden');}};
 await assert.rejects(temuShipping(db,api).prepare(ref),{message:cancelledTemuFulfillment});assert.deepEqual(writes,[]);
});
