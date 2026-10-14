import test from 'node:test';
import assert from 'node:assert/strict';
import {readReceiptRelatedBcs,refreshReceiptBcs} from '../src/receipt-recovery-read.mjs';
const receipt={id:1,status:'delivered',update_stock:true,line_items:[{quantity:1,variant:{id:42,sku:'RECEIVED'},location:{id:1}}]};
const order=(id,sku='OTHER')=>({id,skus:[sku],erp_live:{bc:{id,line_items:[{variant:{id:99,sku}}]}}});
const bc=id=>({id,line_items:[{variant:{id:42,sku:'RECEIVED'}}],shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}});
test('provider filter searches every V3 BC and catches a receipt SKU absent from its local snapshot',async()=>{
 const os=[order('a'),order('b'),order('c')],calls=[];
 const r=await readReceiptRelatedBcs({request:async(q,v)=>{calls.push({q,v});return {Orders:{data:[bc('b')],paginatorInfo:{hasMorePages:false}}};}},os,[receipt]);
 assert.equal(r.mode,'provider-product-filter');assert.deepEqual([...r.bcs.keys()],['b']);assert.equal(calls.length,1);
 assert.deepEqual(calls[0].v.where.AND[0].value,['a','b','c']);assert.equal(calls[0].v.where.AND[1].OR[0].operator,'EXISTS');assert.equal(r.errors.size,0);
});
test('provider matching paginates and also reads local SKU disagreements',async()=>{
 const os=[order('a'),order('b'),order('c','RECEIVED')],calls=[];
 const r=await readReceiptRelatedBcs({request:async(q,v)=>{calls.push(q);if(q.includes('RelatedStock'))return {Orders:{data:[bc(v.page===1?'a':'b')],paginatorInfo:{hasMorePages:v.page===1}}};return {Orders:{data:[{...bc('c'),line_items:[{variant:{id:99,sku:'OTHER'}}]}],paginatorInfo:{hasMorePages:false}}};}},os,[receipt]);
 assert.equal(r.bcs.size,3);assert.equal(calls.length,3);
});
test('unsupported product filters fall back to exhaustive reads rather than hiding orders',async()=>{
 let calls=0;const r=await readReceiptRelatedBcs({request:async q=>{calls++;if(q.includes('RelatedStock'))throw Error('Unsupported filter');return {Orders:{data:[bc('a')],paginatorInfo:{hasMorePages:false}}};}},[order('a')],[receipt]);
 assert.equal(r.mode,'exhaustive-fallback');assert.equal(r.bcs.size,1);assert.equal(calls,2);
});
test('quota failure cannot certify the provider search complete',async()=>{
 const r=await readReceiptRelatedBcs({request:async()=>{throw Object.assign(Error('Quota'),{httpStatus:429});}},[order('a'),order('b')],[receipt]);assert.equal(r.errors.size,2);assert.equal(r.bcs.size,0);
});

test('small fresh Order batches replace stale collection BL states with a bounded alias count',async()=>{
 const os=[order('a'),order('b')],bcs=new Map([['a',bc('a')],['b',bc('b')]]),errors=new Map(),progress=[];let calls=0;
 await refreshReceiptBcs({request:async(q,v)=>{calls++;assert.match(q,/r0:Order/);assert.equal(v.id0,'a');return {r0:{...bc('a'),shipping_orders:{data:[{id:1,status:'in_preparation'}],paginatorInfo:{hasMorePages:false}}},r1:bc('b')};}},os,bcs,errors,p=>progress.push(p));
 assert.equal(calls,1);assert.equal(bcs.get('a').shipping_orders.data[0].status,'in_preparation');assert.equal(errors.size,0);assert.equal(progress[0].done,2);
});
