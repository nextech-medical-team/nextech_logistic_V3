import test from 'node:test';
import assert from 'node:assert/strict';
import {alignMappedBc,assertAdditionalMappingStock} from '../src/mapping-bc-alignment.mjs';

function fixture({lostResponse=false,applyBeforeLoss=true,bcExtras={}}={}){
 const item={id:'3',type:'normal',quantity:3000,price:20/3000,discount:0,discount_rule_amount:0,ecotax:0,tax_amount:0,tax_codes:[],location:{id:'1'},variant:{id:'2',sku:'680483',track_inventory:true}};
 let bc={id:'10',label:'C1',external_reference:'PO',created_at:'2026-09-30 10:00:00',status:'active',update_stock:true,total:20,paid_amount:0,invoices_count:0,tax_type:'exclusive',currency:{label:'EUR'},line_items:[item],shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}},...bcExtras};
 const desired={type:'normal',quantity:20,price:1,tax_codes:[],location:{id:'1'},variant:{id:'2'}};
 const order={id:'o',reference:'PO',channel:'temu',source_payload:{},items:[desired],erp_live:{bc:{id:'10'}},pricing:{total:20,tax:0,currency:'EUR',tax_type:'exclusive',items:[desired]}};
 const calls=[];const api={request:async(query,variables)=>{
  calls.push(query);
  if(query.includes('V3MappingBC'))return {Order:structuredClone(bc)};
  if(query.includes('V3HistoricalExtraStock'))return {StockRemovals:{data:[],paginatorInfo:{hasMorePages:false}}};
  if(query.includes('V3HistoricalStockLogs'))return {InventoryLogs:{data:[{id:'l1',document_id:'10',order_type:'Order',on_hand_diff:-3000,available_diff:-3000,variant:{id:'2'},location:{id:'1'}},...(bc.line_items[0].quantity===20?[{id:'l2',document_id:'10',order_type:'Order',on_hand_diff:2980,available_diff:2980,variant:{id:'2'},location:{id:'1'}}]:[])],paginatorInfo:{hasMorePages:false}}};
  if(query.includes('V3AlignMappedBC')){
   if(!lostResponse||applyBeforeLoss)bc={...bc,line_items:[{...item,...desired}]};
   if(lostResponse)throw Error('réponse perdue');return {UpdateOrder:structuredClone(bc)};
  }
  assert.fail('unexpected provider operation');
 }};
 return {order,api,calls,options:{save:async()=>{},guard:async()=>{},preserveLabels:async()=>{}},get bc(){return bc;}};
}
test('current mapping 20 aligns BC 3000 through normal Erplain edit and verifies net debit 20',async()=>{
 const f=fixture(),result=await alignMappedBc(f.api,f.order,f.options);
 assert.equal(result.aligned,true);assert.equal(f.bc.line_items[0].quantity,20);assert.equal(f.order.erp_live.mappingAlignmentAttempt.status,'verified');
 assert.equal(f.calls.filter(q=>q.startsWith('mutation')).length,1);
 assert.ok(f.calls.filter(q=>q.includes('V3HistoricalStockLogs')).length>=2);
 await alignMappedBc(f.api,f.order,f.options);assert.equal(f.calls.filter(q=>q.startsWith('mutation')).length,1);
});
test('lost response is reconciled by reads and never replayed, whether supplier applied it or not',async()=>{
 for(const applied of [true,false]){
  const f=fixture({lostResponse:true,applyBeforeLoss:applied});await assert.rejects(alignMappedBc(f.api,f.order,f.options),/réponse perdue/);
  if(applied){await alignMappedBc(f.api,f.order,f.options);assert.equal(f.order.erp_live.mappingAlignmentAttempt.status,'verified');}
  else await assert.rejects(alignMappedBc(f.api,f.order,f.options),/aucune réécriture/);
  assert.equal(f.calls.filter(q=>q.startsWith('mutation')).length,1);
 }
});
test('existing shipments, paid invoices, partial orders, explicit equivalents and guards prevent edits',async()=>{
 for(const extra of [{status:'cancelled'},{invoices_count:1},{paid_amount:1},{shipping_orders:{data:[{id:'99'}],paginatorInfo:{hasMorePages:false}}}]){
  const f=fixture({bcExtras:extra});await assert.rejects(alignMappedBc(f.api,f.order,f.options),/BC actif/);assert.equal(f.calls.filter(q=>q.startsWith('mutation')).length,0);
 }
 for(const field of ['partial_mode','existingBL','equivalent']){const f=fixture();if(field==='partial_mode')f.order.partial_mode=true;else if(field==='existingBL')f.order.erp_live.bl={id:'9'};else f.order.erp_live.equivalentItems=[{}];assert.equal((await alignMappedBc(f.api,f.order,f.options)).skipped,true);assert.equal(f.calls.length,0);}
 const f=fixture();await assert.rejects(alignMappedBc(f.api,f.order,{...f.options,guard:async()=>{throw Error('Commande suspendue');}}),/suspendue/);assert.equal(f.calls.filter(q=>q.startsWith('mutation')).length,0);
});

test('only additional mapped units require available stock, never the previously debited quantity',async()=>{
 const item=(id,quantity)=>({type:'normal',variant:{id,sku:id},location:{id:'1'},quantity});const bc={update_stock:true,line_items:[item('2',3000)]};let calls=0;
 const api={request:async(q,{id})=>{calls++;assert.ok(q.startsWith('query '));return {Variant:{id,sku:id,active:true,track_inventory:true,product:{id:'p',active:true},stock_levels:{data:[{location:{id:'1'},available:20,on_hand:20}],paginatorInfo:{hasMorePages:false}}}};}};
 await assertAdditionalMappingStock(api,bc,[item('2',20)]);assert.equal(calls,0);
 await assertAdditionalMappingStock(api,bc,[item('2',3020)]);assert.equal(calls,1);
 await assertAdditionalMappingStock(api,bc,[item('3',20)]);assert.equal(calls,2);
 await assert.rejects(assertAdditionalMappingStock(api,bc,[item('2',3021)]),/stock insuffisant/);
});
test('additional stock requires complete data for the exact active variant and location',async()=>{
 const item={type:'normal',variant:{id:'2'},location:{id:'1'},quantity:20},bc={update_stock:true,line_items:[]};
 for(const extra of [{id:'other'},{active:false},{track_inventory:undefined},{stock_levels:{data:[],paginatorInfo:{hasMorePages:false}}},{stock_levels:{data:[],paginatorInfo:{hasMorePages:true}}}]){
 const api={request:async()=>({Variant:{id:'2',active:true,track_inventory:true,product:{id:'p',active:true},...extra}})};await assert.rejects(assertAdditionalMappingStock(api,bc,[item]));
 }
});

test('existing label preservation completes before BC mutation; failure blocks every external write',async()=>{
 const f=fixture();let preserved=false;f.options.preserveLabels=async()=>{assert.equal(f.calls.some(q=>q.startsWith('mutation')),false);preserved=true;};await alignMappedBc(f.api,f.order,f.options);assert.equal(preserved,true);
 const blocked=fixture();blocked.options.preserveLabels=async()=>{throw Error('PDF preservation mismatch');};await assert.rejects(alignMappedBc(blocked.api,blocked.order,blocked.options),/PDF preservation mismatch/);assert.equal(blocked.calls.filter(q=>q.startsWith('mutation')).length,0);assert.equal(blocked.order.erp_live.mappingAlignmentAttempt,undefined);
 const missing=fixture();delete missing.options.preserveLabels;await assert.rejects(alignMappedBc(missing.api,missing.order,missing.options),/Conservation des etiquettes/);assert.equal(missing.calls.filter(q=>q.startsWith('mutation')).length,0);
});
