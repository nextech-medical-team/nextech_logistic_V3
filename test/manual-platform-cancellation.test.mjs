import {test} from 'node:test';
import assert from 'node:assert/strict';
import {manualPlatformCancellation} from '../src/manual-platform-cancellation.mjs';
import {withShipmentLock} from '../src/shipment-lock.mjs';

function fixture({channel='shopify',cancelled=true,error=null,bc=true,shipped=false,documentError=null}={}){
 const order={id:'a',reference:'REF',channel,source_payload:{mallId:'42'},suspension:{},erp_live:bc?{bc:{id:'123'}}:{},tracking_status:shipped?'shipped':'not_shipped'},calls=[];
 const db={async query(sql,args){calls.push(sql);return {rows:sql.startsWith('SELECT *')?[order]:[]};}};
 const suspension={async context(){return {order};},async suspend(){calls.push('suspend');order.suspension={active:true,version:'v1'};},async cancelErplain(input){calls.push(input.verifyOnly?'verify':'cancel');if(documentError)throw Error(documentError);order.suspension.erplainCancellation={status:'complete'};}};
 const shopify={async cancel(){return {error,state:{status:error?'unavailable':'observed'},proof:{cancelled_at:cancelled?'2026-10-14T12:00:00Z':null,financial_status:'refunded'}};}};
 const connect=async()=>({clients:new Map([['42',{async read(){return {parentOrderMap:{parentOrderSn:'REF',parentOrderStatus:cancelled?3:2}};}}]])});
 return {order,calls,service:manualPlatformCancellation(db,'unused',suspension,{shopify,connect})};
}
const user={role:'operator',email:'test@example.test'};

test('200 Temu checks reuse shop authorization but read every order status afresh',async()=>{
 const order={id:'a',reference:'REF',channel:'temu',source_payload:{mallId:'42'}};
 let connections=0,reads=0;
 const db={query:async sql=>({rows:sql.startsWith('SELECT *')?[order]:[]})};
 const service=manualPlatformCancellation(db,'unused',{}, {connect:async()=>{
  connections++;
  return {clients:new Map([['42',{read:async()=>{
   reads++;
   return {parentOrderMap:{parentOrderSn:'REF',parentOrderStatus:reads%2?3:2}};
  }}]])};
 }});
 for(let i=0;i<200;i++)assert.equal((await service.next({},user)).result.platformCancelled,i%2===0);
 assert.equal(connections,1);
 assert.equal(reads,200);
});

test('failed Temu shop initialization is retried on the next check',async()=>{
 const order={id:'a',reference:'REF',channel:'temu',source_payload:{mallId:'42'}};
 let attempts=0;
 const service=manualPlatformCancellation({query:async sql=>({rows:sql.startsWith('SELECT *')?[order]:[]})},'unused',{}, {connect:async()=>{
  if(++attempts===1)throw Error('Temporary connection failure');
  return {clients:new Map([['42',{read:async()=>({parentOrderMap:{parentOrderSn:'REF',parentOrderStatus:3}})}]])};
 }});
 assert.equal((await service.next({},user)).result.status,'review');
 assert.equal((await service.next({},user)).result.status,'cancelled');
 assert.equal(attempts,2);
});

test('read-only checks complete while stock mutations are locked',async()=>{
 const f=fixture();
 let release,entered,timer;
 const held=new Promise(resolve=>entered=resolve);
 const gate=new Promise(resolve=>release=resolve);
 const stock=withShipmentLock(async()=>{entered();await gate;},['stock-mutations']);
 await held;
 try{
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Check blocked by stock lock')),1000);});
  await Promise.race([f.service.next({},user),timeout]);
  assert.equal((await f.service.next({},user)).result.platformCancelled,true);
 }finally{clearTimeout(timer);release();await stock;}
});

test('report recognizes a cancelled Erplain BC even before local tracking and labels are cancelled',async()=>{
 for(const channel of ['temu','shopify']){
  const f=fixture({channel});
  f.order.erp_live.bc.status='cancelled';
  const result=(await f.service.next({},user)).result;
  assert.equal(result.platformCancelled,true);
  assert.equal(result.v3Cancelled,true);
  assert.ok(!f.calls.includes('suspend'));
  assert.ok(!f.calls.includes('cancel'));
 }
});

test('a cancelled BL or a pending Erplain cancellation does not mean the whole order is cancelled',async()=>{
 const f=fixture();
 f.order.erp_live.bc.status='active';
 f.order.erp_live.bl={status:'cancelled'};
 f.order.suspension={active:true,erplainCancellation:{status:'review'}};
 assert.equal((await f.service.next({},user)).result.v3Cancelled,false);
});

test('report distinguishes platform cancellation from V3 and retains proof on Erplain refusal',async()=>{
 const f=fixture();let result=(await f.service.next({},user)).result;
 assert.equal(result.platformCancelled,true);assert.equal(result.v3Cancelled,false);
 result=(await f.service.apply({id:'a'},user)).result;assert.equal(result.v3Cancelled,true);
 const refused=fixture({documentError:'Stock à rapprocher'});result=(await refused.service.apply({id:'a'},user)).result;
 assert.equal(result.status,'review');assert.equal(result.platformCancelled,true);assert.equal(result.v3Cancelled,false);
 const unavailable=fixture({error:'Source unavailable'});unavailable.order.label_status='cancelled';result=(await unavailable.service.next({},user)).result;
 assert.equal(result.platformCancelled,null);assert.equal(result.v3Cancelled,true);
});

test('creation range includes both bounds, respects timezone and skips other orders before source reads',async()=>{
 const range={createdFrom:'2026-10-14T00:00:00+01:00',createdTo:'2026-10-15T00:00:00+01:00'};
 for(const [date,included] of [['2026-10-13T22:59:59Z',false],['2026-10-13T23:00:00Z',true],['2026-10-14T23:00:00Z',true],['2026-10-14T23:00:01Z',false],[null,false]]){
  const f=fixture();f.order.source_date=date;const response=await f.service.next(range,user);
  assert.equal(!!response.skipped,!included);
  if(included)assert.equal(response.result.status,'cancelled');
  else{assert.equal(response.cursor,'a');assert.equal(response.unknownDate,date===null);assert.equal(f.calls.length,1);}
 }
});

test('creation range allows either bound and rejects invalid intervals before database access',async()=>{
 for(const range of [{createdFrom:'2026-10-14T00:00:00Z'},{createdTo:'2026-10-15T00:00:00Z'}]){
  const f=fixture();f.order.source_date='2026-10-14T12:00:00Z';assert.equal((await f.service.next(range,user)).result.status,'cancelled');
 }
 const f=fixture();
 for(const range of [{createdFrom:'bad'},{createdTo:42},{createdTo:'2026-10-14T00:00'},{createdFrom:'2026-10-15T00:00:00Z',createdTo:'2026-10-14T00:00:00Z'}])await assert.rejects(()=>f.service.next(range,user),/Date|date/);
 assert.equal(f.calls.length,0);
});

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

test('shop clients expire after five minutes without caching order status',async t=>{
 const order={id:'expiry',reference:'REF',channel:'temu',source_payload:{mallId:'42'}};
 let connections=0,reads=0,now=1000;t.mock.method(Date,'now',()=>now);
 const service=manualPlatformCancellation({query:async sql=>({rows:sql.startsWith('SELECT *')?[order]:[]})},'unused',{}, {connect:async()=>{connections++;return {clients:new Map([['42',{read:async()=>{reads++;return {parentOrderMap:{parentOrderSn:'REF',parentOrderStatus:2}};}}]])};}});
 await service.next({},user);now+=299999;await service.next({},user);assert.equal(connections,1);
 now++;await service.next({},user);assert.equal(connections,2);assert.equal(reads,3);
});
test('a newly configured mall refreshes cached clients immediately',async()=>{
 const order={id:'newmall',reference:'REF',channel:'temu',source_payload:{mallId:'42'}};let connections=0;
 const api={read:async()=>({parentOrderMap:{parentOrderSn:'REF',parentOrderStatus:2}})};
 const service=manualPlatformCancellation({query:async sql=>({rows:sql.startsWith('SELECT *')?[order]:[]})},'unused',{}, {connect:async()=>({clients:new Map(++connections===1?[['42',api]]:[['42',api],['43',api]])})});
 assert.equal((await service.next({},user)).result.status,'unchanged');order.source_payload.mallId='43';assert.equal((await service.next({},user)).result.status,'unchanged');assert.equal(connections,2);
});
test('applying cancellation still waits for the stock mutation lock',async()=>{
 const f=fixture();let release,entered,done=false;const held=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const stock=withShipmentLock(async()=>{entered();await gate;},['stock-mutations']);await held;
 const pending=f.service.apply({id:'a'},user).then(r=>{done=true;return r;});
 try{await new Promise(resolve=>setTimeout(resolve,30));assert.equal(done,false);assert.ok(!f.calls.includes('suspend'));assert.ok(!f.calls.includes('cancel'));}finally{release();await stock;}
 assert.equal((await pending).result.applied,true);
});
