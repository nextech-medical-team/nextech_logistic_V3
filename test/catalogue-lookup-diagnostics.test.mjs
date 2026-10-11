import test from 'node:test';import assert from 'node:assert/strict';
import {catalogueLookupProof,reconcileCatalogueMessage,refreshLookupDiagnostics} from '../src/catalogue-lookup-diagnostics.mjs';
const proof=()=>({sku:'COLL200200',status:'active',complete:true,sourceReadOnly:true,readAt:new Date(Date.now()-100).toISOString(),variantId:'2899571',productId:'2009207',documentId:null});
const old=()=>new Date(Date.now()-10000).toISOString();
const missing='COLL200200 : SKU Erplain introuvable';
function fixture(patch={}){
 const order={id:'o',archived:false,issue:missing,erp_live:{},resolution_pending_resume:true,source_payload:{temuManualPricing:{vatRate:27}}};
 const job={status:'review',error:'TEMU · Accès aux montants refusé (3000032)',updated_at:old()};
 const resolutions=[{id:'r',action:'manual-temu-pricing',status:'review',error:missing,updated_at:old()}];
 const f={order,job,resolutions,carrier:null,lines:[{sku:'COLL200200'}],writes:[],...patch};
 const query=async(sql,args)=>{
  if(sql.startsWith('SELECT id,archived'))return {rows:[f.order]};
  if(sql.includes('FROM lines'))return {rows:f.lines};
  if(sql.startsWith('SELECT status,error'))return {rows:f.job?[f.job]:[]};
  if(sql.startsWith('SELECT status FROM carrier'))return {rows:f.carrier?[f.carrier]:[]};
  if(sql.startsWith('SELECT id,action'))return {rows:f.resolutions};
  f.writes.push({sql,args});
  if(sql.startsWith('UPDATE orders'))f.order.issue=args[1];
  if(sql.startsWith('UPDATE resolution_jobs'))f.resolutions.find(j=>j.id===args[0]).error=args[1];
  if(sql.startsWith('UPDATE erp_live_jobs'))f.job.error=args[1];
  return {rowCount:f.conflict?0:1,rows:[]};
 };f.db={transaction:async fn=>fn({query})};return f;
}
test('exact SKU component retires on fresh proof and preserves unrelated components',()=>{
 const x=reconcileCatalogueMessage(missing+' ; Stock insuffisant',proof(),{errorUpdatedAt:old()});assert.equal(x.message,'Stock insuffisant');assert.equal(x.retired.length,1);
 for(const text of ['Autre : SKU Erplain introuvable','SKU Erplain introuvable','COLL200200 : SKU Erplain introuvable demain'])assert.equal(reconcileCatalogueMessage(text,proof(),{errorUpdatedAt:old()}).message,text);
});
test('incomplete, future, stale or superseded supplier proof never clears error',()=>{
 for(const patch of [{status:'missing'},{complete:false},{sourceReadOnly:false},{variantId:null},{productId:null},{readAt:old()},{readAt:new Date(Date.now()+10000).toISOString()}]){
  const date=new Date(Date.now()-500).toISOString();
  assert.equal(reconcileCatalogueMessage(missing,{...proof(),...patch},{errorUpdatedAt:date}).message,missing);
 }
 assert.equal(reconcileCatalogueMessage(missing,proof(),{errorUpdatedAt:'invalid'}).message,missing);
 assert.equal(reconcileCatalogueMessage(missing,proof(),{errorUpdatedAt:old(),now:Date.now()+400000}).message,missing);
});
test('COLL order and current manual pricing diagnostic retire, hold and actual supplier refusal remain',async()=>{
 const f=fixture(),amounts=JSON.stringify(f.order.source_payload);const r=await refreshLookupDiagnostics(f.db,f.order,proof());
 assert.equal(r.retired.length,2);assert.equal(f.order.issue,null);assert.equal(f.resolutions[0].error,null);assert.equal(f.resolutions[0].status,'review');assert.equal(f.job.error,'TEMU · Accès aux montants refusé (3000032)');assert.equal(f.order.resolution_pending_resume,true);assert.equal(JSON.stringify(f.order.source_payload),amounts);
 assert.ok(f.writes.every(w=>/^UPDATE (orders SET issue|resolution_jobs SET error)|^INSERT INTO audit/.test(w.sql)));
 const audit=f.writes.find(w=>w.sql.startsWith('INSERT'));assert.equal(JSON.parse(audit.args[0]).retired[1].previousMessage,missing);assert.equal(JSON.parse(audit.args[0]).retired[1].jobId,'r');
 f.writes=[];assert.equal((await refreshLookupDiagnostics(f.db,f.order,proof())).retired.length,0);assert.equal(f.writes.length,0);
});
test('manual pricing resolution works without Erplain job, preserving job identity and timestamps',async()=>{
 const f=fixture({job:null}),stamp=f.resolutions[0].updated_at;assert.equal((await refreshLookupDiagnostics(f.db,f.order,proof())).retired.length,2);assert.equal(f.resolutions[0].updated_at,stamp);
});
test('newer independent resolution prevents retirement of historical manual pricing failure',async()=>{
 const f=fixture();f.resolutions.unshift({id:'later',action:'mapping',status:'review',error:'Mapping à confirmer',updated_at:old()});assert.equal((await refreshLookupDiagnostics(f.db,f.order,proof())).retired.length,0);assert.equal(f.order.issue,missing);assert.equal(f.resolutions[1].error,missing);
});
test('read-only refresh after manual pricing does not hide current diagnostic',async()=>{
 const f=fixture();f.resolutions.unshift({id:'read',action:'refresh',status:'complete',error:null,updated_at:old()});assert.equal((await refreshLookupDiagnostics(f.db,f.order,proof())).retired.length,2);
});
test('active processing, carrier or resolution, archived order, changed BC or lines refuses updates',async()=>{
 for(const patch of [{job:{status:'processing'}},{carrier:{status:'awaiting_pdf'}},{resolutions:[{status:'running',action:'refresh'}]},{order:{id:'o',archived:true,erp_live:{}}},{order:{id:'o',archived:false,erp_live:{bc:{id:'changed'}}}},{lines:[{sku:'other'}]}]){
  const f=fixture(patch);await assert.rejects(refreshLookupDiagnostics(f.db,{id:'o',erp_live:{}},proof()));assert.equal(f.writes.length,0);
 }
});
test('newer error is preserved and compare-and-set conflict aborts',async()=>{
 const f=fixture();f.resolutions[0].updated_at=new Date(Date.now()+1).toISOString();assert.equal((await refreshLookupDiagnostics(f.db,f.order,proof())).retired.length,0);
 const conflict=fixture({conflict:true});await assert.rejects(refreshLookupDiagnostics(conflict.db,conflict.order,proof()),/transaction annulée/);
});
test('existing BC lookup diagnostic still reconciles independently of manual pricing',async()=>{
 const f=fixture({resolutions:[]});f.order.issue='BC · SKU Erplain LIVE introuvable : COLL200200';f.job.error=f.order.issue;assert.equal((await refreshLookupDiagnostics(f.db,f.order,proof())).retired.length,2);
});
test('active supplier proof requires complete unique identity',()=>{
 const response={Variants:{data:[{id:1,sku:'COLL200200',active:true,product:{id:2,active:true}}],paginatorInfo:{hasMorePages:false}}};
 assert.equal(catalogueLookupProof({sku:'COLL200200',response,locationId:'1',readAt:old()}).status,'active');
 assert.throws(()=>catalogueLookupProof({sku:'COLL200200',response:{Variants:{...response.Variants,paginatorInfo:{hasMorePages:true}}},readAt:old()}));
});
test('own diagnostic-only check-sku can reconcile without changing running resolution',async()=>{
 const f=fixture();f.resolutions.unshift({id:'check',action:'check-sku',status:'running',error:null,updated_at:old()});assert.equal((await refreshLookupDiagnostics(f.db,f.order,proof())).retired.length,2);assert.equal(f.resolutions[0].status,'running');
});
