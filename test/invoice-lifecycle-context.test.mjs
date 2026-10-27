import test from 'node:test';import assert from 'node:assert/strict';
import {documentLifecycle} from '../src/document-lifecycle.mjs';
import {shippingTransition} from '../src/status-policy.mjs';

for(const physical of ['shipped','delivered']){
 test(`cancellation policy refuses ${physical}`,()=>{
  assert.throws(()=>shippingTransition({current:physical,target:'cancelled',cancellationConfirmed:true}),{message:'Annulation non appliquée : le BL est déjà expédié ou livré.'});
 });
 for(const proof of ['explicit','cancelled_bc'])for(const evidence of ['erplain','tracking']){
  test(`automatic cancellation refuses ${physical} from ${evidence} with ${proof} before any write`,async()=>{
   const writes=[],journal={};
   const bl={id:'12',status:evidence==='erplain'?physical:'pending',orders:{data:[{id:'10',status:proof==='cancelled_bc'?'cancelled':'active'}]}};
   const forbidden=async()=>{writes.push('mutation');throw Error('Unexpected mutation');};
   const gateway={verifyLive:async()=>{},readBL:async()=>bl,cancelOrder:forbidden,setBLStatus:forbidden,createInvoiceFromBL:forbidden,createPayment:forbidden};
   const engine=documentLifecycle({gateway,store:{withLock:async(id,fn)=>fn(),read:async()=>journal,save:forbidden},onStatus:forbidden});
   await assert.rejects(()=>engine.resume({blId:'12',bcId:'10',channel:'temu',cancellationConfirmed:proof==='explicit',expectedTracking:evidence==='tracking'?['parcel']:[],events:evidence==='tracking'?[{tracking:'parcel',carrier:'temu',code:physical==='delivered'?'DELIVERED':'IN TRANSIT',at:'2026-10-27T10:00:00Z'}]:[]}),{message:'Annulation non appliquée : le BL est déjà expédié ou livré.'});
   assert.deepEqual(writes,[]);assert.deepEqual(journal,{});
  });
 }
}

test('automatic confirmed cancellation still cancels an unshipped BC and BL in order',async()=>{
 const writes=[],bl={id:'12',status:'pending',orders:{data:[{id:'10',status:'active'}]}};
 const gateway={verifyLive:async()=>{},readBL:async()=>bl,cancelOrder:async id=>writes.push(['bc',id]),setBLStatus:async(id,status)=>{writes.push(['bl',id,status]);bl.status=status;}};
 const engine=documentLifecycle({gateway,store:{withLock:async(id,fn)=>fn(),read:async()=>({}),save:async()=>{}}});
 const result=await engine.resume({blId:'12',bcId:'10',channel:'temu',cancellationConfirmed:true});
 assert.deepEqual(writes,[['bc','10'],['bl','12','cancelled']]);assert.equal(result.bl.status,'cancelled');
});
for(const current of ['pending','ready_to_ship','shipped']){
 for(const observed of ['shipped','delivered']){
  test(`background lifecycle keeps Erplain ${current} when carrier reports ${observed}`,async()=>{
   const journal={},writes=[];
   const bl={id:'12',status:current,orders:{data:[{id:'10',status:'active'}]},invoicesCount:0,invoices:[]};
   const gateway={
    verifyLive:async()=>{},readBL:async()=>bl,
    setBLStatus:async(...args)=>{writes.push(args);throw Error('Unexpected status write');},
    createInvoiceFromBL:async()=>{throw Error('Unexpected invoice creation');}
   };
   const engine=documentLifecycle({gateway,store:{withLock:async(id,fn)=>fn(),read:async()=>journal,save:async()=>{}}});
   const result=await engine.resume({
    blId:'12',bcId:'10',channel:'temu',preparationComplete:true,
    expectedTracking:['parcel-1'],
    events:[{tracking:'parcel-1',carrier:'temu',code:observed==='delivered'?'DELIVERED':'IN TRANSIT',at:'2026-10-20T10:00:00Z'}]
   });
   assert.equal(result.tracking.status,observed);
   assert.equal(result.bl.status,current);
   assert.equal(result.billing,'not_due');
   assert.deepEqual(writes,[]);
   assert.equal(journal.statusIntent,undefined);
  });
 }
}
for(const cancelled of [false,true]){
 test(`background lifecycle preserves ${cancelled?'BC cancellation':'ready preparation'}`,async()=>{
  const journal={},writes=[];
  const bl={id:'12',status:'pending',orders:{data:[{id:'10',status:cancelled?'cancelled':'active'}]}};
  const gateway={verifyLive:async()=>{},readBL:async()=>bl,setBLStatus:async(id,status)=>{writes.push([id,status]);bl.status=status;}};
  const engine=documentLifecycle({gateway,store:{withLock:async(id,fn)=>fn(),read:async()=>journal,save:async()=>{}}});
  const result=await engine.resume({blId:'12',channel:'temu',preparationComplete:true});
  assert.equal(result.bl.status,cancelled?'cancelled':'ready_to_ship');
  assert.deepEqual(writes,[['12',cancelled?'cancelled':'ready_to_ship']]);
 });
}
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
