import test from 'node:test';
import assert from 'node:assert/strict';
import {substitution} from '../src/stock-substitution.mjs';
import {resolvedMonetaryPreview} from '../src/financial-review-recovery.mjs';
const bc=status=>({id:'1',status,total:10,tax_type:'exclusive',currency:{label:'EUR'},update_stock:false,line_items:[{id:'10',type:'normal',quantity:1,price:8,tax_amount:2,variant:{id:'100',sku:'ACCEPTED'},location:{id:'1'}}],shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}});
for(const channel of ['temu','amazon','shopify'])for(const status of ['active','pending'])test(channel+' '+status+' BC replacement preview uses recorded price despite unavailable or different source',async()=>{
 const o={id:'o',channel,reference:'RECORDED',archived:false,partial_mode:false,resolution_pending_resume:false,tracking_status:'not_shipped',erp_live:{bc:{id:'1'},phase:'bc_created',pricing:{total:999,tax:777,currency:'USD'}},source_payload:{temuAmountsError:'unavailable',marketplacePendingCorrection:{old:true}}};
 const queries=[],db={query:async sql=>{assert.match(sql,/^SELECT/);return {rows:[]};}};
 const api={verify:async()=>{},request:async query=>{assert.match(query,/^query /);queries.push(query);if(query.startsWith('query V3SubstitutionBC'))return {Order:bc(status)};if(query.startsWith('query V3SubstitutionProduct'))throw Error('ACTUAL_REPLACEMENT_LOOKUP_REACHED');assert.fail('Unexpected provider call');}};
 await assert.rejects(substitution(db,api,o,{sku:'ACCEPTED',replacementSku:'REPLACEMENT',replaceQuantity:1,replacementQuantity:1,scope:'order'},{shopifyReader:()=>assert.fail('No marketplace comparison')}),/ACTUAL_REPLACEMENT_LOOKUP_REACHED/);assert.equal(queries.length,2);
});
for(const channel of ['temu','amazon','shopify'])test(channel+' monetary preview recheck follows newer BC confirmation, not old source amounts, without confirming replacement',()=>{
 const job={status:'review',action:'equivalent-preview',error:'BC · Total Erplain différent de la source',updated_at:'2026-10-11T10:00:00Z'},o={channel,erp_live:{bc:{id:'1'},pricing:{status:'verified',verifiedAt:'2026-10-11T11:00:00Z',total:999,tax:777,confirmed:{total:10,tax:2,authority:'recorded_erplain_bc'}}}};
 assert.equal(resolvedMonetaryPreview(job,o),true);assert.equal(job.status,'review');
 for(const patch of [{verifiedAt:'2026-10-11T09:00:00Z'},{status:'review'},{confirmed:{total:10,tax:2,authority:'source'}}])assert.equal(resolvedMonetaryPreview(job,{...o,erp_live:{...o.erp_live,pricing:{...o.erp_live.pricing,...patch}}}),false);
 assert.equal(resolvedMonetaryPreview(job,{...o,channel:'tender'}),false);
});
