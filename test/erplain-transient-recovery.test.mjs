import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {resumeTransientErplain,recordTransientFailure} from '../src/erplain-transient-recovery.mjs';
import {customerCreationStarted,customerCreationFailed,canRetryCustomerCreation} from '../src/customer-creation-recovery.mjs';
import {retryDecision} from '../src/erp-transient-policy.mjs';
import {erplainBatchError} from '../src/erplain-accounts.mjs';

const old=new Date(Date.now()-600000).toISOString();
const order=state=>({id:'o',reference:'PO-069-1',channel:'temu',archived:false,partial_mode:false,resolution_pending_resume:false,source_payload:{},erp_live:state});

test('transient failures before BC creation are eligible but protected orders stay blocked',()=>{
 for(const state of [{},{phase:'creating_customer',customerNumber:'C1'},{phase:'customer_created',customer:{id:'1'}}]){
  assert.equal(retryDecision(order(state),'Erplain HTTP 429',old),true);
  for(const block of [{archived:true},{resolution_pending_resume:true},{partial_mode:true},{tracking_status:'shipped'},{label_status:'cancelled'},{suspension:{active:true}}])assert.equal(retryDecision({...order(state),...block},'Erplain HTTP 429',old),false);
 }
 assert.equal(retryDecision(order({phase:'creating_stock'}),'Erplain HTTP 429',old),false);
 assert.equal(retryDecision(order({}),'Stock non vérifiable',old),false);
});

test('batch rate limits retain their classification without claiming a safe mutation replay',()=>{
 const e=erplainBatchError({_v3Errors:[{path:['p0'],code:'RATE_LIMITED',message:'Too many requests'}]},'p0','creating_customer');
 assert.equal(e.httpStatus,429);assert.equal(e.erplainReadOnly,false);assert.equal(e.confirmedRateLimitRejection,false);
 assert.match(e.message,/Erplain HTTP 429/);
 assert.equal(erplainBatchError({},'p1','creating_bc').message,'Réponse incomplète creating_bc');
});

test('database recovery reconciles drafts and customers using reads only',async()=>{
 const engine=new PGlite(),wrap=e=>({query:(q,p)=>e.query(q,p)}),db={...wrap(engine),transaction:f=>engine.transaction(tx=>f(wrap(tx)))};
 try{
  await engine.exec(`CREATE TABLE orders(id text PRIMARY KEY,reference text,channel text,source_payload jsonb DEFAULT '{}',erp_live jsonb,label_status text,tracking_status text,issue text,suspension jsonb DEFAULT '{}',archived boolean DEFAULT false,partial_mode boolean DEFAULT false,resolution_pending_resume boolean DEFAULT false);
   CREATE TABLE erp_live_jobs(order_id text,status text,error text,updated_at timestamptz);
   CREATE TABLE resolution_jobs(order_id text,status text);CREATE TABLE correction_jobs(order_id text,status text);`);
  async function check(state,response,{resumed=true,error=null,jobError='Erplain HTTP 429'}={}){
   await engine.exec('TRUNCATE orders,erp_live_jobs');
   await db.query("INSERT INTO orders(id,reference,channel,erp_live) VALUES('o','PO-069-1','temu',$1)",[JSON.stringify(state)]);
   await db.query("INSERT INTO erp_live_jobs VALUES('o','review',$2,$1)",[old,jobError]);
   const calls=[];
   const count=await resumeTransientErplain(db,{request:async(q,v)=>{assert.match(q,/^query /);calls.push({q,v});if(response instanceof Error)throw response;return response;}});
   assert.equal(count,resumed?1:0);assert.equal(calls.length,1);
   const j=(await db.query('SELECT * FROM erp_live_jobs')).rows[0],o=(await db.query('SELECT erp_live FROM orders')).rows[0];
   assert.equal(j.status,resumed?'pending':'review');if(error)assert.match(j.error,error);
   return {state:o.erp_live,calls};
  }
  const draft={phase:'bc_created',bc:{id:'12',status:'unpublished'}};
  const response={Order:{id:'12',status:'unpublished',shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}}};
  assert.equal((await check(draft,response)).state.bc.id,'12');
  await check({...draft,transientRecovery:{attempts:1,lastError:null}},response,{jobError:'BC/BL : rapprochement incomplet ou ambigu, contrôle nécessaire'});
  await check(draft,{Order:{...response.Order,status:'cancelled'}},{resumed:false,error:/rapprochement/});
  await check(draft,{Order:{...response.Order,id:'99'}},{resumed:false,error:/rapprochement/});
  await check(draft,{Order:{...response.Order,shipping_orders:{data:[{id:'bl'}],paginatorInfo:{hasMorePages:false}}}},{resumed:false,error:/rapprochement/});
  await check({...draft,phase:'creating_bl'},response,{resumed:false,error:/rapprochement/});
  await check(draft,{Order:{...response.Order,shipping_orders:{data:[],paginatorInfo:{hasMorePages:true}}}},{resumed:false,error:/rapprochement/});
  const customer={phase:'creating_customer',customerNumber:'C1'};
  const found={Customers:{data:[{id:'9',customer_number:'C1'}],paginatorInfo:{hasMorePages:false}}};
  await check({...customer,transientRecovery:{originalError:'Réponse incomplète creating_customer'}},found,{jobError:'Client Erplain · Création à vérifier : rapprocher le client de cette commande avant reprise'});
  const recovered=await check(customer,found);
  assert.equal(recovered.state.phase,'customer_created');assert.equal(recovered.state.customer.id,'9');
  assert.equal(recovered.calls[0].v.where.value,'C1');
  await check(customer,{Customers:{data:[],paginatorInfo:{hasMorePages:false}}},{jobError:'Client Erplain · Création à vérifier : rapprocher le client de cette commande avant reprise',resumed:false,error:/aucune nouvelle cr[ée]ation/});
  const rejected=await check({...customer,customerCreationAttempt:customerCreationFailed(customerCreationStarted(order(customer)),{httpStatus:429,confirmedRateLimitRejection:true})},{Customers:{data:[],paginatorInfo:{hasMorePages:false}}});
  assert.equal(rejected.state.phase,undefined);assert.equal(rejected.state.customerNumber,'C1');assert.equal(rejected.state.customerReconciliation.retryAuthorizedBy,'confirmed_no_write');
  await check(customer,{Customers:{...found.Customers,data:[...found.Customers.data,...found.Customers.data]}},{resumed:false,error:/ambigu/});
  await check({...customer,phase:'customer_created',customer:{id:'other'}},found,{resumed:false,error:/différent/i});
  await check({},{Company:{id:100174}});
  await check({},{Company:{id:1}},{resumed:false,error:/Identité/});
  const limited=Object.assign(Error('Erplain HTTP 429'),{httpStatus:429,erplainReadOnly:true,retryAfter:120});
  const deferred=await check(draft,limited,{resumed:false,error:/automatique programmée/});
  assert.equal(deferred.state.transientRecovery.attempts,0);
  assert.ok(Date.parse(deferred.state.transientRecovery.nextReadCheckAt)>Date.now());
 }finally{await engine.close();}
});

 test('only explicit whole-request rate-limit rejection releases customer creation',async()=>{
 for(const confirmed of [true,false,undefined]){
  const o=order({phase:'creating_customer'});
  const error={httpStatus:429,confirmedRateLimitRejection:confirmed};
  o.erp_live.customerCreationAttempt=customerCreationFailed(customerCreationStarted(o),error);
  await recordTransientFailure({query:async()=>({rows:[]})},o,'Erplain HTTP 429',error);
  assert.equal(canRetryCustomerCreation(o,'V3:o'),confirmed===true);
 }
});
