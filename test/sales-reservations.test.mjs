import test from 'node:test';
import assert from 'node:assert/strict';
import {newSalesBcInput,assertNewBcStockPolicy} from '../src/erplain-live-workflow.mjs';
import {publishIncrementalBc,assertPublishedBcReservation} from '../src/bc-numbering.mjs';
import {verifyHistoricalStock,historicalPendingLines} from '../src/historical-stock-proof.mjs';
import {assertFullOrderStock} from '../src/stock-gate.mjs';
import {assertResumeStock} from '../src/resume-stock-policy.mjs';
import {evaluateStockIncident} from '../src/stock-incident-recheck.mjs';
import {confirmDeliveryReady} from '../src/bl-ready.mjs';
import {partialLines,validatePartial} from '../src/partial-deliveries.mjs';
import {buildReceiptPlan,receiptOrderBlock} from '../src/receipt-recovery-plan.mjs';

const line=()=>({id:'10',type:'normal',quantity:100000,price:.037,reserved_quantity:100000,shipped_quantity:0,on_hand:-8000,available:-112000,variant:{id:'642345',sku:'RNBM10001',track_inventory:true},location:{id:'100934'}});
const bc=()=>({id:'1934803',label:'C00014930',created_at:'2026-10-08 10:00:00',status:'active',update_stock:true,line_items:[line()],shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}});
const order=()=>({id:'local',erp_live:{bc:{id:'1934803'}}});
function evidence(document){return [{bc:String(document.id),variant:'642345',complete:true,order:[{id:'reserve',document_id:document.id,order_type:'Order',variant:{id:'642345'},location:{id:'100934'},on_hand_diff:0,available_diff:-100000}],shipping:[]}];}

for(const channel of ['tender','amazon','shopify','temu','relay','manual','other'])test(channel+' reserves the full sales quantity at publication, including negative stock',async()=>{
 const source={id:'local',reference:'REF',channel,source_date:'08/10/2026',source_payload:{notes:'Note conservée'},erp_live:{customer:{id:'5'}},address:{name:'Client',street:'Rue',postalCode:'75001',city:'Paris',country:'FR'},currency:{id:'EUR',label:'EUR'},pricing:{tax_type:'exclusive',items:[{quantity:100000,price:.037,variant:{id:'642345'},location:{id:'100934'}}]},documentMetadata:{external_reference:'REF',update_stock:false}};
 const input=newSalesBcInput(source,'7');assert.equal(input.status,'unpublished');assert.equal(input.update_stock,true);assert.equal(input.line_items[0].quantity,100000);assert.equal(input.dated_at,'2026-10-08');assert.equal(input.price_level.id,'7');
 assert.equal(input.notes,channel==='tender'?'Note conservée':'Commande REF');
 let current={...bc(),status:'unpublished',line_items:[{...line(),reserved_quantity:0,available:-12000}]},writes=0;
 const api={request:async(q,v)=>{
  if(q.includes('DocumentNumberingContext'))return {DocumentNumberingContext:{preview:'C00014930',manual_override_allowed_effective:true}};
  if(q.startsWith('mutation ')){writes++;assert.deepEqual(v.input,{label:'C00014930',status:'active',update_stock:true});current=bc();return {UpdateOrder:structuredClone(current)};}
  return {Order:structuredClone(current)};
 }};
 const published=await publishIncrementalBc(api,current.id,{datedAt:input.dated_at,verify:()=>{},lock:fn=>fn()});
 assert.equal(published.line_items[0].reserved_quantity,100000);assert.equal(published.line_items[0].on_hand,-8000);assert.equal(published.line_items[0].available,-112000);assert.equal(writes,1);
 assert.throws(()=>assertFullOrderStock(published.line_items),/100000 nécessaires, 0 utilisables, manque 100000/);
 await publishIncrementalBc(api,current.id,{verify:()=>{},lock:fn=>fn()});assert.equal(writes,1,'retry must not create another reservation');
});

test('legacy unpublished BC keeps false; active BC is never retroactively mutated',async()=>{
 let current={...bc(),update_stock:false,status:'unpublished',line_items:[{...line(),reserved_quantity:0}]},writes=0;
 const api={request:async(q,v)=>{if(q.includes('DocumentNumberingContext'))return {DocumentNumberingContext:{preview:current.label,manual_override_allowed_effective:true}};if(q.startsWith('mutation ')){writes++;assert.equal(v.input.update_stock,false);current.status='active';return {UpdateOrder:structuredClone(current)};}return {Order:structuredClone(current)};}};
 await publishIncrementalBc(api,current.id,{verify:()=>{},lock:fn=>fn()});await publishIncrementalBc(api,current.id,{verify:()=>{},lock:fn=>fn()});assert.equal(writes,1);assert.equal(current.update_stock,false);
});

test('unknown stock policy is rejected before any publication',async()=>{
 const api={request:async q=>{assert.ok(q.startsWith('query '));return {Order:{...bc(),status:'unpublished',update_stock:null}};}};
 await assert.rejects(publishIncrementalBc(api,'1934803',{verify:()=>{},lock:fn=>fn()}),/politique de stock.*non vérifiée/i);
});
test('new reservation intent cannot silently become a legacy document on retry',async()=>{
 for(const status of ['active','unpublished']){
  const api={request:async q=>{assert.ok(q.startsWith('query '));return {Order:{...bc(),status,update_stock:false}};}};
  await assert.rejects(publishIncrementalBc(api,'1934803',{expectedStockPolicy:true,verify:()=>{},lock:fn=>fn()}),/réservation différente/);
 }
});
test('missing reservations or changed stock flag fail provider confirmation',()=>{
 for(const changed of [{...bc(),update_stock:false},{...bc(),line_items:[{...line(),reserved_quantity:0}]},{...bc(),line_items:[{...line(),reserved_quantity:null}]},{...bc(),line_items:[{...line(),variant:{id:'642345'}}]}])assert.throws(()=>assertPublishedBcReservation(changed,true));
 assert.doesNotThrow(()=>assertPublishedBcReservation({...bc(),line_items:[{...line(),variant:{id:'642345',track_inventory:false},reserved_quantity:0}]},true));
});
test('a reservation alone remains visible during shortage but never certifies a physical debit',()=>{
 const document=bc(),proof=verifyHistoricalStock(document,evidence(document),{reservationOnly:true});assert.equal(proof.reservationVerified,true);assert.equal(proof.stockOnBc,false);assert.equal(proof.physicalDebitVerified,false);
 const incident=evaluateStockIncident(order(),document,{historicalProof:proof});assert.equal(incident.status,'active');assert.match(incident.currentError,/manque 100000/);
 assert.throws(()=>verifyHistoricalStock(document,evidence(document),{beforeBlPublication:true}),/stock insuffisant/);
 document.line_items[0].on_hand=104000;document.line_items[0].available=0;
 assert.equal(verifyHistoricalStock(document,evidence(document),{beforeBlPublication:true}).beforeBlPublication,true);
 assert.equal(evaluateStockIncident(order(),document,{historicalProof:proof}).preparationRequired,true);
});
test('resume after replenishment requests pre-BL proof; a published BL requests physical proof',async()=>{
 const options=[];const prove=async(api,o,opt)=>{options.push(opt);return {bcId:'1934803',stockOnBc:true};};
 await assertResumeStock({},order(),bc(),[line()],{prove});const o=order();o.erp_live.bl={id:'20',status:'unpublished'};await assertResumeStock({},o,bc(),[line()],{prove});o.erp_live.bl.status='pending';await assertResumeStock({},o,bc(),[line()],{prove});assert.deepEqual(options.map(o=>o.beforeBlPublication),[true,true,false]);
});

function partialFixture(){
 const document=bc();document.line_items[0]={...line(),on_hand:100000,available:0};
 const shipments=[{id:'20',label:'SHO00000020',created_at:'2026-10-08 11:00:00',status:'pending',update_stock:true,line_items:[{...line(),quantity:20000,parent_id:'10'}]},{id:'21',label:'SHO00000021',created_at:'2026-10-08 12:00:00',status:'pending',update_stock:true,line_items:[{...line(),quantity:30000,parent_id:'10'}]}];
 document.shipping_orders.data=shipments;
 const rows=evidence(document);rows[0].shipping=shipments.map((bl,i)=>({id:'physical'+i,document_id:bl.id,order_type:'ShippingOrder',variant:{id:'642345'},location:{id:'100934'},on_hand_diff:-bl.line_items[0].quantity,available_diff:0}));
 const selected=shipments[1],blEvidence=[{bl:selected.id,variant:'642345',complete:true,rows:[rows[0].shipping[1]]}];
 return {document,shipments,rows,selected,blEvidence};
}
test('partial BLs deduct only selected physical quantities with no second available debit',()=>{
 const f=partialFixture(),options={bl:f.selected,blEvidence:f.blEvidence,pendingBlScope:true,allowPendingSiblings:true};
 assert.equal(historicalPendingLines(f.document,f.selected,{allowPendingSiblings:true})[0].quantity,30000);
 assert.throws(()=>historicalPendingLines(f.document,f.selected),/Autre BL/);
 assert.equal(verifyHistoricalStock(f.document,f.rows,options).stockModel,'reservation_bc_sortie_bl');
 f.rows[0].shipping[1].available_diff=-30000;assert.throws(()=>verifyHistoricalStock(f.document,f.rows,options),/physiques/);
 f.rows[0].shipping[1].available_diff=0;f.rows[0].shipping[1].on_hand_diff=-30001;assert.throws(()=>verifyHistoricalStock(f.document,f.rows,options),/physiques/);
});
test('partial allocations cannot exceed stock or remaining sales quantity',()=>{
 const l={...line(),quantity:100000,reserved_quantity:80000,shipped_quantity:20000,on_hand:50000,available:-30000};
 const candidates=partialLines([l]);assert.equal(candidates[0].remaining,80000);assert.equal(candidates[0].available,50000);assert.equal(validatePartial(candidates,[{lineId:'10',quantity:30000}])[0].quantity,30000);assert.throws(()=>validatePartial(candidates,[{lineId:'10',quantity:50001}]),/stock insuffisant/);
});
test('partial finalization reads every BL ledger and never creates a separate stock movement',async()=>{
 const f=partialFixture(),calls=[];
 const api={request:async(q,v)=>{
  calls.push(q);
  if(q.includes('V3DeliveryReady'))return {Order:structuredClone(f.document),ShippingOrder:structuredClone(f.selected)};
  if(q.includes('V3HistoricalStockLogs'))return {InventoryLogs:{data:[...f.rows[0].order,...f.rows[0].shipping],paginatorInfo:{hasMorePages:false}}};
  if(q.includes('V3InheritedBlLedger'))return {InventoryLogs:{data:[...f.rows[0].order,...f.rows[0].shipping],paginatorInfo:{hasMorePages:false}}};
  if(q.includes('V3FinalizeDelivery')){assert.deepEqual(v.input,{label:f.selected.label,status:'ready_to_ship'});f.selected.status='ready_to_ship';return {UpdateShippingOrder:{id:f.selected.id}};}
  throw Error('Unexpected request: '+q);
 }};
 const result=await confirmDeliveryReady(api,{bcId:f.document.id,blId:f.selected.id,lines:f.selected.line_items,stockOnBc:true,pendingBlScope:true,allowPendingSiblings:true});assert.equal(result.status,'ready_to_ship');assert.equal(calls.filter(q=>q.startsWith('mutation ')).length,1);assert.ok(!calls.some(q=>q.includes('CreateStockRemoval')));
 f.selected.status='in_preparation';const count=calls.length;await assert.rejects(confirmDeliveryReady(api,{bcId:f.document.id,blId:f.selected.id,lines:f.selected.line_items,stockOnBc:true,pendingBlScope:true,allowPendingSiblings:true}),/interdit/);assert.ok(calls.slice(count).every(q=>q.startsWith('query ')));
});

test('recorded recovery preserves new reservation intent and never reclassifies it as legacy',()=>{const o=order();o.erp_live.bcReservationPolicy='erplain_bc_bl';assert.throws(()=>assertNewBcStockPolicy(o,{update_stock:false}),/rapprochement/);assert.throws(()=>assertNewBcStockPolicy(o,{}),/rapprochement/);assert.doesNotThrow(()=>assertNewBcStockPolicy(o,{update_stock:true}));assert.doesNotThrow(()=>assertNewBcStockPolicy(order(),{update_stock:false}));});
test('receipt recovery admits only verified new reservations and sufficient replenishment',()=>{
 const o=order();o.erp_live.bcReservationPolicy='erplain_bc_bl';const document=bc();
 const receipt={id:'receipt',label:'PRP1',status:'completed',update_stock:true,line_items:[line()]};
 const plan=()=>buildReceiptPlan([receipt],[o],new Map([[document.id,document]])).rows[0];
 assert.equal(receiptOrderBlock(o,document),null);assert.equal(plan().status,'blocked');
 document.line_items[0].on_hand=52000;document.line_items[0].available=-52000;assert.equal(plan().status,'blocked');assert.match(plan().reason,/48000 utilisables/);
 document.line_items[0].on_hand=104000;document.line_items[0].available=0;assert.equal(plan().status,'eligible');
 // PR146 permits historical BCs to continue through the native worker, which
 // reconciles their existing stock documents. New marked BCs retain the gates above.
 delete o.erp_live.bcReservationPolicy;assert.equal(plan().status,'eligible');assert.equal(plan().stockAlreadyApplied,true);
 o.erp_live.bcReservationPolicy='erplain_bc_bl';document.line_items[0].reserved_quantity=0;assert.equal(plan().status,'blocked');
 document.line_items[0].reserved_quantity=100000;o.erp_live.stockCreationAttemptedAt='2026-10-08T00:00:00Z';assert.equal(plan().status,'blocked');
});

 test('reservation failure reports provider quantities instead of implying a stock shortage',()=>{
  const document={...bc(),line_items:[{...line(),quantity:100,reserved_quantity:0,shipped_quantity:0,variant:{...line().variant,sku:'491930'}}]};
  assert.throws(()=>assertPublishedBcReservation(document,true),/SKU 491930 : commandées 100, réservées 0, expédiées 0/);
  document.line_items[0].reserved_quantity=null;
  assert.throws(()=>assertPublishedBcReservation(document,true),/réservées non reçues/);
 });
