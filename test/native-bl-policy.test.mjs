import test from 'node:test';
import assert from 'node:assert/strict';
import {usesNativeBlCycle,readNativeBlCycle,assertNativeBcSnapshot} from '../src/native-bl-policy.mjs';
import {historicalPreparationProof} from '../src/historical-stock-proof.mjs';
import {normalizeHistoricalDraft} from '../src/historical-bl-draft.mjs';
import {assertResumeStock} from '../src/resume-stock-policy.mjs';
import {confirmDeliveryReady} from '../src/bl-ready.mjs';
import {prepareMissingDraftRecovery} from '../src/missing-draft-recovery.mjs';
import {representativeLabels} from '../src/erplain-document-metadata.mjs';
const conn=data=>({data,paginatorInfo:{hasMorePages:false}});
function fixture(){
 const order={id:'native',channel:'amazon',erp_live:{bcReservationPolicy:'erplain_bc_bl',bc:{id:7},phase:'bc_created'}};
 const bc={id:7,status:'active',update_stock:true,created_at:'2026-10-15 10:00:00',line_items:[{type:'normal',quantity:24,reserved_quantity:0,available:130349,on_hand:130349,variant:{id:599184,sku:'489-392 + 489-394',track_inventory:true},location:{id:100934}}],shipping_orders:conn([])};
 const data={Order:bc},calls=[];
 const api={request:async(q,v)=>{calls.push(q);assert.match(q,/^query /);return data;}};
 return {order,bc,data,api,calls};
}
test('native BC with 24 items, zero reservation and no debit proof proceeds without ledger calls',async()=>{
 const f=fixture();const proof=await historicalPreparationProof(f.api,f.order,{beforeBlPublication:true});
 assert.equal(proof.stockModel,'erplain_native_cycle');assert.equal(proof.historicalDebitCompared,false);assert.equal(f.calls.length,1);assert.doesNotMatch(f.calls[0],/InventoryLogs/);
 const resumed=await assertResumeStock(f.api,f.order,f.bc,f.bc.line_items);assert.equal(resumed.stockOnBc,true);
});
test('actual 5/10 shortage continues to wait for reception',async()=>{const f=fixture();Object.assign(f.bc.line_items[0],{quantity:10,available:5,on_hand:5});await assert.rejects(()=>readNativeBlCycle(f.api,f.order,{beforeBlPublication:true}),/stock insuffisant/i);});

for(const channel of Object.keys(representativeLabels).filter(channel=>channel!=='tender'))test(channel+' saved unpublished draft rechecks stock before publication and resume',async()=>{
 const f=fixture();f.order.channel=channel;f.order.erp_live.bl={id:9,status:'unpublished'};
 f.data.ShippingOrder={id:9,status:'unpublished',update_stock:true,orders:conn([{id:7}])};
 Object.assign(f.bc.line_items[0],{quantity:200,available:94,on_hand:94});
 assert.throws(()=>assertNativeBcSnapshot(f.order,f.bc,{beforeBlPublication:true}),/stock insuffisant/);
 await assert.rejects(()=>readNativeBlCycle(f.api,f.order,{beforeBlPublication:true}),/stock insuffisant/);
 await assert.rejects(()=>assertResumeStock(f.api,f.order,f.bc,f.bc.line_items),/stock insuffisant/);
 assert.ok(f.calls.every(q=>q.startsWith('query ')));
});

test('fresh unpublished status rechecks stock even with stale saved pending status',async()=>{
 const f=fixture();f.order.erp_live.bl={id:9,status:'pending'};
 f.data.ShippingOrder={id:9,status:'unpublished',update_stock:true,orders:conn([{id:7}])};
 Object.assign(f.bc.line_items[0],{quantity:200,available:94,on_hand:94});
 await assert.rejects(()=>readNativeBlCycle(f.api,f.order,{beforeBlPublication:true}),/stock insuffisant/);
});
test('existing native draft does not compare BC quantities or stock journals',async()=>{
 const f=fixture();f.order.erp_live.bl={id:9,status:'unpublished'};f.data.ShippingOrder={id:9,label:'SHO00744947',status:'unpublished',update_stock:true,orders:conn([{id:7}])};f.bc.line_items=[];
 assert.equal((await normalizeHistoricalDraft(f.api,f.order)).id,9);assert.equal(f.calls.length,1);
});
for(const [name,change] of [
 ['suspension',f=>f.order.suspension={active:true}],['archive',f=>f.order.archived=true],['shipped',f=>f.order.tracking_status='shipped'],
 ['separate stock write',f=>f.order.erp_live.stockCreationAttemptedAt='now'],['separate stock document',f=>f.order.erp_live.stockDocument={id:1}],
 ['wrong BC',f=>f.bc.id=8],['inactive BC',f=>f.bc.status='cancelled'],['changed stock policy',f=>f.bc.update_stock=false],
 ['incomplete BL search',f=>f.bc.shipping_orders.paginatorInfo.hasMorePages=true],['existing other BL',f=>f.bc.shipping_orders.data=[{id:10}]],
 ['missing draft',f=>f.order.erp_live.bl={id:9}],
 ])test(name+' stays protected',async()=>{const f=fixture();change(f);await assert.rejects(()=>readNativeBlCycle(f.api,f.order));assert.ok(f.calls.every(q=>q.startsWith('query ')));});
test('imports, tenders, partials and legacy BCs retain their own stock cycle',()=>{for(const change of [o=>o.source_payload={erplainImported:true},o=>o.channel='tender',o=>o.partial_mode=true,o=>delete o.erp_live.bcReservationPolicy]){const f=fixture();change(f.order);assert.equal(usesNativeBlCycle(f.order),false);}});
function readyFixture(status='pending'){
 const f=fixture(),bl={id:9,label:'SHO00744947',status,update_stock:true,line_items:[]};f.bc.shipping_orders=conn([{id:9}]);
 const api={request:async(q,v)=>{f.calls.push(q);if(q.startsWith('mutation ')){assert.equal(v.input.status,'ready_to_ship');bl.status='ready_to_ship';return {UpdateShippingOrder:{id:9}};}assert.match(q,/V3DeliveryReady/);return {Order:f.bc,ShippingOrder:{...bl}};}};
 return {...f,run:()=>confirmDeliveryReady(api,{bcId:7,blId:9,lines:[{quantity:999}],stockOnBc:true,nativeErplainCycle:true})};
}
test('native BL finalization ignores historical debit and quantity equality',async()=>{const f=readyFixture();assert.equal((await f.run()).status,'ready_to_ship');assert.equal(f.calls.filter(q=>q.startsWith('mutation ')).length,1);assert.ok(!f.calls.some(q=>q.includes('InventoryLogs')));});
test('in_preparation to ready remains forbidden',async()=>{const f=readyFixture('in_preparation');await assert.rejects(f.run,/interdit/);assert.equal(f.calls.length,1);});
test('ready label flow never republishes a ready BL',async()=>{const f=readyFixture('ready_to_ship');assert.equal((await f.run()).status,'ready_to_ship');assert.ok(f.calls.every(q=>q.startsWith('query ')));});
function absentFixture(){
 const f=fixture();f.order.erp_live.phase='bl_created';f.order.erp_live.bl={id:9,label:'SHO00744947',status:'unpublished',update_stock:true};
 const logs={InventoryLogs:conn([])},db={query:async()=>({rows:[]})};
 const api={request:async(q,v)=>{assert.match(q,/^query /);f.calls.push(q);if(q.includes('V3MissingDraftRead'))return {...f.data,ShippingOrder:null};if(q.includes('Ledger'))return logs;if(q.includes('V3MissingDraftStock'))return {StockRemovals:conn([])};return {ShippingOrders:conn([])};}};
 return {...f,logs,run:()=>prepareMissingDraftRecovery(db,api,f.order,{resolutionId:'r'})};
}
test('absent native draft is retired locally only after zero old-BL movements',async()=>{const f=absentFixture();const next=await f.run();assert.equal(next.phase,'bc_created');assert.equal(next.bl,undefined);assert.equal(next.missingDraftRecoveries[0].retiredDraft.id,9);assert.equal(f.order.erp_live.bl.id,9);});
test('old BL movement forbids recreation',async()=>{const f=absentFixture();f.logs.InventoryLogs.data=[{id:1,document_id:9,order_type:'ShippingOrder',variant:{id:599184}}];await assert.rejects(f.run,/mouvement existant/);});
test('incomplete old-BL journal forbids recreation',async()=>{const f=absentFixture();delete f.logs.InventoryLogs.paginatorInfo;await assert.rejects(f.run,/journal incomplet/);});

test('native absent draft preserves prior BC proof while verifying no BL movement',async()=>{const f=absentFixture();f.order.erp_live.historicalStockProof={stockOnBc:true,logIds:['old']};const next=await f.run();assert.deepEqual(next.historicalStockProof,f.order.erp_live.historicalStockProof);});
test('old BL movement on a variant removed from the BC still blocks recreation',async()=>{const f=absentFixture();f.logs.InventoryLogs.data=[{id:1,document_id:9,order_type:'ShippingOrder',variant:{id:999}}];await assert.rejects(f.run,/mouvement existant/);});
