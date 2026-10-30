import test from 'node:test';
import assert from 'node:assert/strict';
import {readHistoricalStock} from '../src/historical-stock-proof.mjs';
function fixture(){
 const bc={id:'2074255',created_at:'2026-10-28 13:33:21',status:'active',update_stock:true,line_items:[{id:'line',type:'normal',quantity:100,variant:{id:'640451',track_inventory:true},location:{id:'100934'}}],shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}};
 const initial={id:21064380,document_id:null,source:'erplain',order_type:null,on_hand_diff:300,available_diff:300,variant:{id:640451},location:{id:100934},created_at:'2026-10-28 10:17:40'};
 const debit={id:21071791,document_id:2074255,source:'erplain',order_type:'Order',on_hand_diff:-100,available_diff:-100,variant:{id:640451},location:{id:100934},created_at:'2026-10-28 13:34:11'};
 const calls=[];const api={request:async(q,v)=>{assert.match(q,/^query V3HistoricalStockLogs/);calls.push(v);return {InventoryLogs:{data:v.page===1?[initial]:[debit],paginatorInfo:{hasMorePages:v.page===1}}};}};
 return {bc,initial,debit,api,calls};
}
test('initial stock before BC creation does not hide the exact paginated BC debit',async()=>{
 const f=fixture(),r=await readHistoricalStock(f.api,f.bc);
 assert.deepEqual(r.proof.logIds,['21071791']);assert.equal(r.proof.stockOnBc,true);
 assert.equal(f.calls.length,2);assert.equal(r.evidence[0].order.length,1);
});
for(const [name,change] of Object.entries({
 sameInstant:f=>f.initial.created_at=f.bc.created_at,
 later:f=>f.initial.created_at='2026-10-28 13:34:00',
 undated:f=>delete f.initial.created_at,
 invalidDate:f=>f.initial.created_at='invalid',
 debit:f=>{f.initial.on_hand_diff=-300;f.initial.available_diff=-300;},
 mismatchedQuantities:f=>f.initial.available_diff=200,
 missingLocation:f=>delete f.initial.location,
 missingVariant:f=>delete f.initial.variant,
 missingId:f=>delete f.initial.id,
 unknownSource:f=>f.initial.source='unknown',
 partiallyIdentified:f=>f.initial.document_id=2074255,
 stringQuantities:f=>{f.initial.on_hand_diff='300';f.initial.available_diff='300';},
 missingBcDebit:f=>f.debit.document_id=999,
 wrongBcDebit:f=>f.debit.on_hand_diff=-99,
 duplicateBcDebit:f=>f.api.request=async()=>({InventoryLogs:{data:[f.initial,f.debit,{...f.debit,id:21071792}],paginatorInfo:{hasMorePages:false}}})
}))test(name+' remains blocked',async()=>{const f=fixture();change(f);await assert.rejects(()=>readHistoricalStock(f.api,f.bc));});
test('timezone offsets are compared as instants',async()=>{const f=fixture();f.initial.created_at='2026-10-28T15:00:00+02:00';assert.equal((await readHistoricalStock(f.api,f.bc)).proof.stockOnBc,true);f.initial.created_at='2026-10-28T13:00:00-01:00';await assert.rejects(()=>readHistoricalStock(f.api,f.bc));});

test('balanced lot reassignment is accepted across pages without changing the BC ledger',async()=>{
 const f=fixture();f.initial.created_at='2026-10-29 13:10:09';f.initial.on_hand_diff=-14100;f.initial.available_diff=-14100;
 const counterpart={...f.initial,id:f.initial.id+1,on_hand_diff:14100,available_diff:14100};
 f.api.request=async(q,{page})=>({InventoryLogs:{data:page===1?[f.initial]:[counterpart,f.debit],paginatorInfo:{hasMorePages:page===1}}});
 assert.deepEqual((await readHistoricalStock(f.api,f.bc)).proof.logIds,['21071791']);
});
for(const [name,change] of Object.entries({
 unbalanced:rows=>rows[1].available_diff=299,
 mismatchedDate:rows=>rows[1].created_at='2026-10-29 13:10:10',
 mismatchedLocation:rows=>rows[1].location={id:'999'},
 nonConsecutive:rows=>rows[1].id+=1,
 missingCounterpart:rows=>rows.pop(),
 duplicateId:rows=>rows[1].id=rows[0].id,
 partiallyIdentifiedPair:rows=>rows[1].document_id=2074255
}))test('lot reassignment '+name+' remains blocked',async()=>{
 const f=fixture();const rows=[{...f.initial,created_at:'2026-10-29 13:10:09',on_hand_diff:-300,available_diff:-300},{...f.initial,id:f.initial.id+1,created_at:'2026-10-29 13:10:09'}];change(rows);
 f.api.request=async()=>({InventoryLogs:{data:[...rows,f.debit],paginatorInfo:{hasMorePages:false}}});await assert.rejects(()=>readHistoricalStock(f.api,f.bc));
});
test('pair before the BC is accepted without losing its negative half',async()=>{const f=fixture();const pair={...f.initial,id:f.initial.id+1,on_hand_diff:-300,available_diff:-300};f.api.request=async()=>({InventoryLogs:{data:[f.initial,pair,f.debit],paginatorInfo:{hasMorePages:false}}});assert.equal((await readHistoricalStock(f.api,f.bc)).proof.stockOnBc,true);});

import {readInheritedBlLedger} from '../src/historical-stock-proof.mjs';
test('BL reader uses the same balanced-pair check and preserves its exact debit',async()=>{
 const f=fixture(),bl={id:'900',created_at:'2026-10-29 12:00:00',line_items:f.bc.line_items};
 const minus={...f.initial,id:1,created_at:'2026-10-29 13:10:09',on_hand_diff:-14100,available_diff:-14100},plus={...minus,id:2,on_hand_diff:14100,available_diff:14100};
 const debit={...f.debit,document_id:'900',order_type:'ShippingOrder',on_hand_diff:-100,available_diff:0};
 const api={request:async q=>{assert.match(q,/source order_type/);assert.match(q,/created_at/);return {InventoryLogs:{data:[minus,plus,debit],paginatorInfo:{hasMorePages:false}}};}};
 assert.deepEqual((await readInheritedBlLedger(api,bl))[0].rows,[debit]);
 plus.on_hand_diff=14099;plus.available_diff=14099;await assert.rejects(()=>readInheritedBlLedger(api,bl),/mouvement non identifié/);
});
test('unrelated lot pairs cannot cover a missing or duplicate debit of the BC',async()=>{
 const f=fixture();const minus={...f.initial,id:1,created_at:'2026-10-29 13:10:09',on_hand_diff:-14100,available_diff:-14100},plus={...minus,id:2,on_hand_diff:14100,available_diff:14100};
 let rows=[minus,plus];f.api.request=async()=>({InventoryLogs:{data:rows,paginatorInfo:{hasMorePages:false}}});await assert.rejects(()=>readHistoricalStock(f.api,f.bc),/quantités déjà déduites/);
 rows.push(f.debit,{...f.debit,id:f.debit.id+1});await assert.rejects(()=>readHistoricalStock(f.api,f.bc),/quantités déjà déduites/);
});
