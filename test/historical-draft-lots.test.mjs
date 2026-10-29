import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeHistoricalDraft} from '../src/historical-bl-draft.mjs';
function fixture(){
 const line={id:'10',type:'normal',quantity:300,variant:{id:'2'},location:{id:'3'}};
 const bc={id:'1',status:'active',update_stock:true,line_items:[line],shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}};
 const bl={id:'9',label:'draft',created_at:'2026-10-29 15:00:00',status:'unpublished',update_stock:true,line_items:[line],orders:{data:[{id:'1'}],paginatorInfo:{hasMorePages:false}}};
 const debit={id:1,document_id:'1',source:'erplain',order_type:'Order',on_hand_diff:-300,available_diff:-300,variant:{id:'2'},location:{id:'3'},created_at:'2026-10-29 07:51:46'};
 const minus={id:100,document_id:null,source:'erplain',order_type:null,on_hand_diff:-60,available_diff:-60,variant:{id:'2'},location:{id:'3'},created_at:'2026-10-29 10:43:17'};
 const plus={...minus,id:101,on_hand_diff:60,available_diff:60};let documentReads=0;
 const pages=[[debit,minus],[plus]],calls=[];
 const api={request:async(q,v)=>{assert.match(q,/^query /);calls.push({q,v});if(q.includes('V3HistoricalDraftDocuments')){documentReads++;return {Order:bc,ShippingOrder:bl};}if(q.includes('V3HistoricalExtraStock'))return {StockRemovals:{data:[],paginatorInfo:{hasMorePages:false}}};if(q.includes('V3InheritedBlLedger')){assert.match(q,/source order_type on_hand_diff available_diff location/);return {InventoryLogs:{data:pages[v.page-1],paginatorInfo:{hasMorePages:v.page<pages.length}}};}throw Error('Unexpected query');}};
 return {bc,bl,debit,minus,plus,pages,calls,api,documentReads:()=>documentReads,order:{id:'o',items:[line],erp_live:{bc:{id:'1'},bl:{id:'9'}}}};
}
test('draft reader accepts verified lot reallocation across pages without any stock mutation',async()=>{const f=fixture();assert.equal((await normalizeHistoricalDraft(f.api,f.order)).id,'9');assert.equal(f.documentReads(),2);assert.equal(f.calls.filter(c=>c.q.includes('V3InheritedBlLedger')).length,2);});
for(const [name,change] of Object.entries({unbalanced:f=>f.plus.available_diff=59,missingCounterpart:f=>f.pages.pop(),wrongVariant:f=>f.plus.variant={id:'4'},duplicateId:f=>f.plus.id=f.minus.id,realBlMovement:f=>{f.debit.document_id='9';f.debit.order_type='ShippingOrder';},unknownSource:f=>f.plus.source='unknown',wrongDate:f=>f.plus.created_at='2026-10-29 10:43:18'}))test(name+' keeps the draft blocked',async()=>{const f=fixture();change(f);await assert.rejects(()=>normalizeHistoricalDraft(f.api,f.order));});
