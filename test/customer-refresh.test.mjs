import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {validateResolution} from '../src/problem-resolution.mjs';
import {refreshCustomerIdentity} from '../src/customer-refresh.mjs';
import {customerCreationStarted,customerCreationFailed,customerCreationMessage} from '../src/customer-creation-recovery.mjs';
const input={id:'o',requestId:'12345678-1234-1234-1234-123456789abc',action:'refresh',type:'customer',provider:'Erplain',resumeAfter:true};
test('customer dialog refresh is accepted, other actions and providers stay forbidden',()=>{
 assert.deepEqual(validateResolution(input),input);
 assert.throws(()=>validateResolution({...input,action:'force-stock-label'}),/incompatible/);
 assert.throws(()=>validateResolution({...input,provider:'TEMU'}),/Erplain/);
});
async function fixture(){
 const e=new PGlite();await e.exec(`CREATE TABLE orders(id text PRIMARY KEY,channel text,erp_live jsonb,issue text,source_payload jsonb DEFAULT '{}',archived boolean DEFAULT false,partial_mode boolean DEFAULT false,suspension jsonb DEFAULT '{}',label_status text DEFAULT 'pending',tracking_status text DEFAULT 'not_shipped');CREATE TABLE erp_live_jobs(order_id text,status text);CREATE TABLE correction_jobs(order_id text,status text);CREATE TABLE audit(user_email text,action text,detail jsonb);`);
 await e.query("INSERT INTO orders(id,channel,erp_live,issue) VALUES('o','temu',$1,$2)",[JSON.stringify({phase:'creating_customer',customerNumber:'RECORDED'}),customerCreationMessage]);
 await e.exec("INSERT INTO erp_live_jobs VALUES('o','review')");
 return {e,db:{query:(...args)=>e.query(...args),transaction:fn=>e.transaction(fn)},read:async()=>(await e.query("SELECT * FROM orders WHERE id='o'")).rows[0]};
}
test('explicit customer refresh reuses identity, preserves failed cases and never mutates Erplain',async()=>{
 const f=await fixture();try{
  const original=await f.read();
  for(const mode of ['found','absent','safe-absent','ambiguous','incomplete','wrong-number','changed','busy','quota','suspended']){
   await f.e.query("UPDATE orders SET erp_live=$1,issue=$2,suspension='{}' WHERE id='o'",[JSON.stringify(original.erp_live),original.issue]);
   await f.e.exec("UPDATE erp_live_jobs SET status='review';DELETE FROM audit");
   if(mode==='safe-absent'){const s=structuredClone(original.erp_live);s.customerCreationAttempt=customerCreationFailed(customerCreationStarted(original),{httpStatus:429,confirmedRateLimitRejection:true});await f.e.query("UPDATE orders SET erp_live=$1 WHERE id='o'",[JSON.stringify(s)]);}
   if(mode==='suspended')await f.e.exec(`UPDATE orders SET suspension='{"active":true}'`);
   const before=await f.read();let calls=0;
   const api={verify:async()=>{},request:async(q,v)=>{
    calls++;assert.match(q,/^query V3RefreshCustomerIdentity/);assert.equal(v.where.value,'RECORDED');
    if(mode==='changed')await f.e.exec("UPDATE orders SET issue='Autre erreur' WHERE id='o'");
    if(mode==='busy')await f.e.exec("UPDATE erp_live_jobs SET status='processing'");
    if(mode==='quota')throw Error('Erplain HTTP 429');
    return {Customers:{data:['absent','safe-absent'].includes(mode)?[]:mode==='ambiguous'?[{id:'1',customer_number:'RECORDED'},{id:'2',customer_number:'RECORDED'}]:[{id:'1',customer_number:mode==='wrong-number'?'OTHER':'RECORDED'}],paginatorInfo:{hasMorePages:mode==='incomplete'}}};
   }};
   if(['found','safe-absent'].includes(mode)){
    const result=await refreshCustomerIdentity(f.db,api,before);assert.equal(result.erpOnly,true);const after=await f.read();assert.equal(after.issue,null);
    assert.equal(after.erp_live.phase,mode==='found'?'customer_created':undefined);
    assert.equal(after.erp_live.customer?.id,mode==='found'?'1':undefined);
    assert.equal((await f.e.query('SELECT status FROM erp_live_jobs')).rows[0].status,'review');
    assert.equal((await f.e.query('SELECT count(*)::int n FROM audit')).rows[0].n,1);
   }else{
    await assert.rejects(()=>refreshCustomerIdentity(f.db,api,before));assert.deepEqual((await f.read()).erp_live,before.erp_live);
    assert.equal((await f.e.query('SELECT count(*)::int n FROM audit')).rows[0].n,0);
   }
   assert.equal(calls,mode==='suspended'?0:1);
  }
 }finally{await f.e.close();}
});
