import {test} from 'node:test';
import assert from 'node:assert/strict';
import {manualPlatformCancellation} from '../src/manual-platform-cancellation.mjs';

function fixture({channel='shopify',cancelled=true,error=null,bc=true,shipped=false,documentError=null}={}){
 const order={id:'a',reference:'REF',channel,source_payload:{mallId:'42'},suspension:{},erp_live:bc?{bc:{id:'123'}}:{},tracking_status:shipped?'shipped':'not_shipped'},calls=[];
 const db={async query(sql,args){calls.push(sql);return {rows:sql.startsWith('SELECT *')?[order]:[]};}};
 const suspension={async context(){return {order};},async suspend(){calls.push('suspend');order.suspension={active:true,version:'v1'};},async cancelErplain(input){calls.push(input.verifyOnly?'verify':'cancel');if(documentError)throw Error(documentError);order.suspension.erplainCancellation={status:'complete'};}};
 const shopify={async cancel(){return {error,state:{status:error?'unavailable':'observed'},proof:{cancelled_at:cancelled?'2026-10-14T12:00:00Z':null,financial_status:'refunded'}};}};
 const connect=async()=>({clients:new Map([['42',{async read(){return {parentOrderMap:{parentOrderSn:'REF',parentOrderStatus:cancelled?3:2}};}}]])});
 return {order,calls,service:manualPlatformCancellation(db,'unused',suspension,{shopify,connect})};
}
const user={role:'operator',email:'test@example.test'};

test('refresh and apply retain the order destination country for both platforms',async()=>{
 for(const channel of ['shopify','temu']){
  const f=fixture({channel});f.order.address={country:'IT'};
  assert.equal((await f.service.next({},user)).result.country,'IT');
  assert.equal((await f.service.apply({id:'a'},user)).result.country,'IT');
 }
});
test('confirmed cancellations suspend V3 before cancelling Erplain for both channels',async()=>{
 for(const channel of ['shopify','temu']){const f=fixture({channel});const result=await f.service.apply({id:'a'},user);assert.equal(result.result.status,'cancelled');assert.ok(f.calls.indexOf('suspend')<f.calls.indexOf('cancel'));assert.ok(f.calls.some(s=>s.includes("label_status='cancelled'")));}
});
test('refund without cancellation does not suspend or cancel',async()=>{const f=fixture({cancelled:false});assert.equal((await f.service.apply({id:'a'},user)).result.status,'unchanged');assert.ok(!f.calls.includes('suspend'));});
test('failed fresh read cannot reuse an old cancellation proof',async()=>{const f=fixture({error:'Source unavailable'});assert.equal((await f.service.apply({id:'a'},user)).result.status,'review');assert.ok(!f.calls.includes('cancel'));assert.ok(!f.calls.includes('suspend'));});
test('Erplain refusal retains local suspension and reports review',async()=>{const f=fixture({documentError:'Stock à rapprocher'});assert.equal((await f.service.apply({id:'a'},user)).result.status,'review');assert.equal(f.order.suspension.active,true);assert.ok(!f.calls.some(s=>s.includes("label_status='cancelled'")));});
test('shipped order is held for physical reconciliation',async()=>{const f=fixture({shipped:true,bc:false});assert.equal((await f.service.apply({id:'a'},user)).result.status,'review');assert.ok(!f.calls.includes('cancel'));});
test('no Erplain BC still cancels the local order',async()=>{const f=fixture({bc:false});assert.equal((await f.service.apply({id:'a'},user)).result.status,'cancelled');assert.ok(!f.calls.includes('cancel'));});
test('repeated click verifies previous Erplain attempt without retrying writes',async()=>{const f=fixture();f.order.suspension={active:true,erplainCancellation:{status:'review'}};await f.service.apply({id:'a'},user);assert.ok(f.calls.includes('verify'));assert.ok(!f.calls.includes('cancel'));});
test('viewer rejected before source reads',async()=>{const f=fixture();await assert.rejects(()=>f.service.next({},{role:'viewer'}),/Droits/);assert.equal(f.calls.length,0);});
test('empty scan terminates',async()=>{const service=manualPlatformCancellation({query:async()=>({rows:[]})},'unused',{});assert.deepEqual(await service.next({},user),{done:true});});

test('selected platforms constrain the database scan before any source read',async()=>{
 for(const channels of [['temu'],['shopify'],['temu','shopify']]){
  const service=manualPlatformCancellation({query:async(sql,args)=>{assert.match(sql,/channel=ANY\(\$2::text\[\]\)/);assert.deepEqual(args,['cursor',channels]);return {rows:[]};}},'unused',{});
  assert.deepEqual(await service.next({cursor:'cursor',channels},user),{done:true});
 }
});
test('invalid platform selection is rejected before database access',async()=>{
 const f=fixture();for(const channels of [[],['amazon'],'temu',[null]])await assert.rejects(()=>f.service.next({channels},user),/Plateformes invalides/);assert.equal(f.calls.length,0);
});

for(const channel of ['shopify','temu'])test('refresh observes '+channel+' cancellations without applying them',async()=>{
 const f=fixture({channel});const response=await f.service.next({},user);
 assert.equal(response.result.status,'cancelled');assert.equal(response.result.applied,undefined);
 assert.ok(!f.calls.includes('suspend'));assert.ok(!f.calls.includes('cancel'));
 assert.ok(!f.calls.some(sql=>sql.includes("label_status='cancelled'")));
});

test('apply rechecks source and ignores a stale cancellation in the input',async()=>{
 const f=fixture({cancelled:false});const response=await f.service.apply({id:'a',cancelled:true},user);
 assert.equal(response.result.status,'unchanged');assert.ok(!f.calls.includes('suspend'));
});

test('apply requires a valid order and operational role',async()=>{
 const f=fixture();await assert.rejects(()=>f.service.apply({},user),/Commande requise/);
 await assert.rejects(()=>f.service.apply({id:'a'},{role:'viewer'}),/Droits/);
 const service=manualPlatformCancellation({query:async()=>({rows:[]})},'unused',{});
 await assert.rejects(()=>service.apply({id:'archived'},user),/inaccessible/);
});
