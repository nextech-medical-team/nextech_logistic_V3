import test from 'node:test';import assert from 'node:assert/strict';
import {historicalSubstitutionItems,verifyHistoricalSubstitutionLots} from '../src/historical-substitution-lots.mjs';
function fixture(){
 const added={variant:{id:'2'},location:{id:'3'},quantity:100,price:0.1083,tax_codes:[{id:'tax'}],apply_discount_rules:false};
 const retained={id:'old',quantity:20};
 const bc={update_stock:true},plan={items:[retained,added],commercialBefore:{line_items:[{id:'old'}]}};
 const calls=[];const api={request:async q=>{assert.match(q,/^query /);calls.push(q);if(q.includes('FifoVariant'))return {Variant:{id:'2',sku:'CH23100',has_batch_numbers:true,has_serial_numbers:false}};if(q.includes('FifoBatchNumberStockLevels'))return {BatchNumberStockLevels:{data:[{on_hand:14100,available:14100,location_id:'3',variant_id:'2',batch_number:{id:'lot',label:'260410015.'}}],paginatorInfo:{hasMorePages:false}}};if(q.includes('FifoBatchNumberInventoryLogs'))return {BatchNumberInventoryLogs:{data:[{on_hand:14100,batch_number:{id:'lot'},inventory_log:{id:9,created_at:'2026-10-29 10:00:00',location:{id:'3'},variant:{id:'2'}}}],paginatorInfo:{hasMorePages:false}}};throw Error('Unexpected query');}};
 return {bc,plan,api,calls,added,retained};
}
test('historical replacement sends FIFO lots on the new line and preserves existing/commercial fields',async()=>{
 const f=fixture(),items=await historicalSubstitutionItems(f.api,f.bc,f.plan);
 assert.equal(items[0],f.retained);assert.deepEqual(items[1],{...f.added,batch_numbers:[{batch_number:{id:'lot'},quantity:100}]});assert.equal(f.calls.length,3);assert.equal(f.plan.items[1].batch_numbers,undefined);
 f.plan.items=items;const updated={line_items:[{id:'old',batch_numbers:[{batch_number:{id:'existing'},quantity:20}]},{...items[1],id:'new'}]};assert.doesNotThrow(()=>verifyHistoricalSubstitutionLots(updated,f.plan));
 for(const patch of [{batch_numbers:[]},{batch_numbers:[{batch_number:{id:'wrong'},quantity:100}]},{batch_numbers:[{batch_number:{id:'lot'},quantity:99}]}])assert.throws(()=>verifyHistoricalSubstitutionLots({line_items:[{...updated.line_items[1],...patch}]},f.plan),/affectation Erplain différente/);
});
test('nonhistorical and reconcile-only paths do not allocate another lot',async()=>{const f=fixture();f.bc.update_stock=false;assert.equal(await historicalSubstitutionItems(f.api,f.bc,f.plan),f.plan.items);f.bc.update_stock=true;f.plan.reconcileOnly=true;assert.equal(await historicalSubstitutionItems(f.api,f.bc,f.plan),f.plan.items);assert.equal(f.calls.length,0);});
test('lot shortage blocks before an order mutation can be sent',async()=>{const f=fixture();f.plan.items[1].quantity=20000;await assert.rejects(()=>historicalSubstitutionItems(f.api,f.bc,f.plan),/stock disponible par lot insuffisant/);assert.ok(f.calls.every(q=>q.startsWith('query ')));});
test('an unchanged historical line cannot stand in for a missing new lot allocation',async()=>{const f=fixture();f.plan.items=await historicalSubstitutionItems(f.api,f.bc,f.plan);assert.throws(()=>verifyHistoricalSubstitutionLots({line_items:[{...f.plan.items[1],id:'old'}]},f.plan),/affectation Erplain différente/);});
