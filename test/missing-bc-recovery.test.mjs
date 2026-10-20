import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {recoverMissingBc} from '../src/missing-bc-recovery.mjs';
import {validateResolution} from '../src/problem-resolution.mjs';
const request={id:'o',requestId:'12345678-1234-1234-1234-123456789abc',action:'refresh',type:'unknown',provider:'Erplain',confirmMissingBc:true,missingBcId:'10',orderReference:'PO-original'};
test('BC recovery request requires explicit confirmation, scope, provider and exact identity fields',()=>{
 assert.deepEqual(validateResolution(request),request);
 for(const change of [{confirmMissingBc:false},{missingBcId:''},{missingBcId:10},{orderReference:''},{provider:'TEMU'},{type:'customer'},{action:'resume'}])assert.throws(()=>validateResolution({...request,...change}));
});
const original={id:'o',channel:'temu',reference:'PO-original',received_at:'2026-10-16T00:00:00.000Z',erp_live:{phase:'bc_created',bc:{id:'10',label:'C0016034',status:'unpublished'},customer:{id:'20'},customerNumber:'RECORDED',pricing:{status:'pending'}},issue:'BC Erplain introuvable : aucune donnée locale remplacée',source_payload:{sourceShop:'shop'},archived:false,partial_mode:false,simulation:false,suspension:{},label_status:'ready',tracking_status:'not_shipped'};
const options={bcId:'10',reference:'PO-original',confirmed:true,resolutionId:'self'};
async function fixture(){
 const e=new PGlite();await e.exec(`CREATE TABLE orders(id text PRIMARY KEY,channel text,reference text,received_at text,erp_live jsonb,issue text,source_payload jsonb,archived boolean,partial_mode boolean,simulation boolean,suspension jsonb,label_status text,tracking_status text);
 CREATE TABLE erp_live_jobs(order_id text,status text,error text);CREATE TABLE resolution_jobs(id text,order_id text,status text,action text);CREATE TABLE correction_jobs(order_id text,status text);CREATE TABLE partial_deliveries(order_id text);CREATE TABLE carrier_jobs(order_id text,status text,result jsonb);CREATE TABLE audit(user_email text,action text,detail jsonb);CREATE TABLE labels(order_id text,pdf text);`);
 const cols=Object.keys(original);await e.query(`INSERT INTO orders(${cols.join(',')}) VALUES(${cols.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(original).map(v=>v&&typeof v==='object'?JSON.stringify(v):v));
 await e.exec("INSERT INTO erp_live_jobs VALUES('o','review','BC absent');INSERT INTO resolution_jobs VALUES('self','o','running','refresh');INSERT INTO carrier_jobs VALUES('o','ready','{\"tracking\":\"existing\"}');INSERT INTO labels VALUES('o','existing-pdf');");
 return {e,db:{query:(...a)=>e.query(...a),transaction:f=>e.transaction(f)},read:async()=>(await e.query("SELECT * FROM orders WHERE id='o'")).rows[0]};
}
const connection=data=>({data,paginatorInfo:{hasMorePages:false}});
function apiFor(mode,f){let identityReads=0;const calls=[];return {calls,verify:async()=>{},request:async(q,v)=>{
 assert.match(q,/^query /);calls.push(q);
 if(q.includes('V3MissingBcIdentity')){identityReads++;if(mode==='missing-field')return {};if(mode==='partial-error')return {Order:null,_v3Errors:[{message:'timeout'}]};return {Order:mode==='exists'||mode==='reappeared'&&identityReads===2?{id:'10',label:'C0016034'}:null};}
 if(q.includes('V3RecoverReference'))return {Orders:connection(mode==='candidate'?[{id:'11',label:'C0017000',status:'active',external_reference:'V3:o'}]:[])};
 if(q.includes('V3MissingBcCustomer'))return {Customer:{id:'20',customer_number:mode==='wrong-customer'?'OTHER':'RECORDED'}};
 if(q.includes('V3MissingBcShipping')){
  if(mode==='quota')throw Error('HTTP 429');
  if(mode==='incomplete')return {ShippingOrders:{data:[]}};
  const bl={id:'30',external_reference:mode==='bl-reference'?'PO-original':'OTHER',orders:connection([{id:mode==='bl-linked'?'10':'99'}])};
  if(mode==='bl-incomplete')bl.orders.paginatorInfo.hasMorePages=true;
  if(mode==='repeated-page')return {ShippingOrders:{data:[bl],paginatorInfo:{hasMorePages:true}}};
  // A different order may have reused the old visible BC number; only IDs matter.
  return {ShippingOrders:connection([bl])};
 }
 if(q.includes('V3MissingBcStock'))return {StockRemovals:connection(mode==='stock'?[{id:'40'}]:[])};
 if(q.includes('V3MissingBcLedger')){
  if(mode==='race')await f.e.exec("UPDATE orders SET issue='Changed'");
  if(mode==='busy-race')await f.e.exec("UPDATE erp_live_jobs SET status='processing'");
  return {InventoryLogs:connection(mode==='movement'?[{id:'50',document_id:'10',order_type:'Order'}]:[])};
 }
 throw Error('Unexpected query');
 }};}
test('absent draft resets only ERP preparation, preserves label, audits proof and cannot be replayed',async()=>{
 const f=await fixture();try{
  const before=await f.read(),api=apiFor('absent',f),result=await recoverMissingBc(f.db,api,before,options),after=await f.read();
  assert.equal(result.erpOnly,true);assert.equal(after.erp_live.phase,'customer_created');assert.equal(after.erp_live.bc,undefined);assert.equal(after.erp_live.pricing,undefined);
  assert.deepEqual(after.erp_live.missingBcRecovery.previousState,before.erp_live);
  for(const key of Object.keys(before).filter(k=>k!=='erp_live'))assert.deepEqual(after[key],before[key]);
  assert.equal((await f.e.query('SELECT pdf FROM labels')).rows[0].pdf,'existing-pdf');
  assert.equal((await f.e.query('SELECT status FROM carrier_jobs')).rows[0].status,'ready');
  assert.equal((await f.e.query('SELECT status FROM erp_live_jobs')).rows[0].status,'review');
  assert.equal((await f.e.query('SELECT count(*)::int n FROM audit')).rows[0].n,1);
  await assert.rejects(()=>recoverMissingBc(f.db,api,after,options));
 }finally{await f.e.close();}
});
test('absence recovery refuses existing documents, incomplete API, quota, movements and concurrent changes without resetting state',async()=>{
 const f=await fixture();try{
  for(const mode of ['exists','missing-field','partial-error','candidate','wrong-customer','quota','incomplete','bl-linked','bl-reference','bl-incomplete','repeated-page','stock','movement','reappeared','race','busy-race']){
   await f.e.query("UPDATE orders SET erp_live=$1,issue=$2",[JSON.stringify(original.erp_live),original.issue]);await f.e.exec("UPDATE erp_live_jobs SET status='review';DELETE FROM audit");
   const before=await f.read();await assert.rejects(()=>recoverMissingBc(f.db,apiFor(mode,f),before,options),undefined,mode);
   assert.deepEqual((await f.read()).erp_live,before.erp_live,mode);assert.equal((await f.e.query('SELECT count(*)::int n FROM audit')).rows[0].n,0);
  }
 }finally{await f.e.close();}
});
test('no remote operation for protected scopes, stale confirmations or attempted downstream operations',async()=>{
 const api={verify:()=>{throw Error('Unexpected remote call');}};
 for(const change of [{partial_mode:true},{archived:true},{tracking_status:'shipped'},{source_payload:{erplainImported:true}},{erp_live:{...original.erp_live,phase:'creating_bl'}},{erp_live:{...original.erp_live,bl:{id:'30'}}},{erp_live:{...original.erp_live,stockCreationAttemptedAt:'now'}},{erp_live:{...original.erp_live,bc:{id:'10',status:'active'}}}]){
  await assert.rejects(()=>recoverMissingBc({},api,{...original,...change},options),/BC absent/);
 }
 await assert.rejects(()=>recoverMissingBc({},api,original,{...options,confirmed:false}),/Confirmation/);
 await assert.rejects(()=>recoverMissingBc({},api,original,{...options,bcId:'999'}),/brouillon/);
});
