import test from 'node:test';
import assert from 'node:assert/strict';
import {monitoringObservation} from '../src/order-recheck-monitor.mjs';
import {currentHoldDiagnostic} from '../src/preparation-recheck-policy.mjs';
const now=Date.now();
const order={channel:'temu',label_status:'blocked',erp_live:{bc:{id:'BC'},bl:{id:'BL'}},temu_job:{status:'pending',error:'TEMU · PDF en attente chez TEMU',packages:['PK-1'],result:{source:'temu_direct',observedAt:new Date(now-60000).toISOString(),packageInfoResultList:[{packageSn:'PK-1',shippingLabelStatus:0}]}}};
test('fresh verified pending PDF remains visible without a false block or alert',()=>{
 const before=structuredClone(order),r=monitoringObservation(order,{lastProgress:new Date(now-7200000).toISOString(),blocked:true,alert:true},now);
 assert.equal(r.blocked,false);assert.equal(r.alert,false);assert.equal(r.followUp,true);
 assert.equal(r.holdCode,'temu_pdf_processing');assert.match(r.result,/récupération automatique/);assert.match(r.nextStep,/aucun nouvel achat/);
 assert.deepEqual(order,before);
});
test('stale or unverifiable results request verification rather than asserting provider pending',()=>{
 for(const result of [{...order.temu_job.result,observedAt:new Date(now-600001).toISOString()},{...order.temu_job.result,observedAt:null},{...order.temu_job.result,packageInfoResultList:[]}]){
  const o={...order,temu_job:{...order.temu_job,result}};
  assert.equal(currentHoldDiagnostic(o,{now}).code,'temu_pdf_recheck');
  assert.equal(monitoringObservation(o,{},now).blocked,true);
 }
});
test('independent blockers, suspension and supplier refusals remain blocked',()=>{
 for(const patch of [{issue:'Stock insuffisant'},{suspension:{active:true,note:'Décision humaine'}},{erp_live_job:{status:'review',error:'TVA invalide'}},{resolution_pending_resume:true},{temu_job:{status:'shipment_error',error:'Poids refusé'}}])assert.equal(monitoringObservation({...order,...patch},{},now).blocked,true);
});
test('freshness boundaries and supplier identity cannot hide an unverified result',()=>{
 for(const age of [0,600000])assert.equal(currentHoldDiagnostic({...order,temu_job:{...order.temu_job,result:{...order.temu_job.result,observedAt:new Date(now-age).toISOString()}}},{now}).code,'temu_pdf_processing');
 for(const patch of [{observedAt:new Date(now+1).toISOString()},{source:'cached'},{packageInfoResultList:[{packageSn:'PK-OTHER',shippingLabelStatus:0}]},{packageInfoResultList:[{packageSn:'PK-1',shippingLabelStatus:2}]}])assert.equal(currentHoldDiagnostic({...order,temu_job:{...order.temu_job,result:{...order.temu_job.result,...patch}}},{now}).code,'temu_pdf_recheck');
 const failed={...order,temu_job:{...order.temu_job,error:'Authentification refusée'}};
 assert.equal(currentHoldDiagnostic(failed,{now}).code,'temu_error');assert.equal(monitoringObservation(failed,{},now).blocked,true);
});
