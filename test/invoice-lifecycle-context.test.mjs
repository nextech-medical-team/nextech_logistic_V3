import test from 'node:test';import assert from 'node:assert/strict';
import {documentLifecycle} from '../src/document-lifecycle.mjs';
test('delivered existing draft keeps invoice and forwards customer context',async()=>{
 const journal={invoiceId:'42'};let status='draft',context;
 const bl={id:'12',status:'delivered',orders:{data:[]},invoicesCount:1,invoices:[{id:'42',status:'draft'}]};
 const invoice=()=>({id:'42',status,total:10,paid_amount:10,remaining_balance:0});
 const gateway={verifyLive:async()=>{},readBL:async()=>bl,readInvoice:async()=>invoice(),validateInvoiceForBL:async()=>{},finalizeInvoice:async(i,c)=>{context=c;assert.equal(i.id,'42');status='paid';}};
 const engine=documentLifecycle({gateway,store:{withLock:async(id,fn)=>fn(),read:async()=>journal,save:async()=>{}}});
 const sourcePayload={isbusinessorder:'false'};
 const result=await engine.resume({blId:'12',orderId:'order-1',channel:'amazon',sourcePayload});
 assert.deepEqual(context,{orderId:'order-1',channel:'amazon',sourcePayload});assert.equal(result.billing,'paid');assert.equal(journal.invoiceId,'42');
});
