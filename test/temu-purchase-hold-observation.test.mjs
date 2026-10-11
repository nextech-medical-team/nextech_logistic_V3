import test from 'node:test';
import assert from 'node:assert/strict';
import {monitoringObservation} from '../src/order-recheck-monitor.mjs';
import {currentTemuPurchaseHoldDetail,currentHoldDiagnostic} from '../src/preparation-recheck-policy.mjs';
const now=Date.now(),date=n=>new Date(now+n).toISOString();
const quota='Quota partagé : lecture différée';
function order(){return {channel:'temu',reference:'PO-069-123456',erp_live:{bc:{id:'bc'},bl:{id:'bl'}},temu_job:{status:'ready',error:null},temu_auto_purchase:{checkedAt:date(-60000),result:{status:'held',message:quota,at:date(-60000)}},source_payload:{temuOrderDetail:{parentOrderMap:{parentOrderSn:'PO-069-123456'}},temuDirect:{source:'temu_direct',state:'verified',verifiedAt:date(-1000)}}};}
test('a later verified read removes only the obsolete quota suffix and preserves purchase confirmation and history',()=>{
 const o=order(),before=structuredClone(o);
 assert.equal(currentTemuPurchaseHoldDetail(o,{now}),'');
 const result=currentHoldDiagnostic(o);
 assert.equal(result.code,'temu_confirmation');
 assert.equal(result.label,'Achat d’étiquette TEMU à confirmer');
 assert.equal(result.decisionRequired,true);
 assert.deepEqual(o,before);
});
test('only the same order and causally later successful read retire an observation',()=>{
 const cases=[
 o=>{o.source_payload.temuOrderDetail.parentOrderMap.parentOrderSn='OTHER';},
 o=>{delete o.source_payload.temuOrderDetail;},
 o=>{o.source_payload.temuDirect.verifiedAt=date(-60000);},
 o=>{o.source_payload.temuDirect.verifiedAt=date(-70000);},
 o=>{o.source_payload.temuDirect.verifiedAt=date(1000);},
 o=>{o.source_payload.temuDirect.verifiedAt='invalid';},
 o=>{o.source_payload.temuDirect.state='failed';},
 o=>{o.source_payload.temuDirect.error='Provider refusal';},
 o=>{o.source_payload.temuDirect.source='cache';},
 o=>{o.temu_auto_purchase.checkedAt='invalid';},
 o=>{o.temu_job.error='Still refused';},
 o=>{o.temu_job.status='pending';},
 o=>{o.source_payload.temuReadDeferred={deferred:true};},
 o=>{o.source_payload.marketplacePendingCorrection={};},
 o=>{o.source_payload.visibilityHold=true;}
 ];
 for(const change of cases){const o=order();change(o);assert.equal(currentTemuPurchaseHoldDetail(o,{now}),quota);}
});
test('commercial, stock and combined refusals remain visible',()=>{
 for(const message of ['Marge nette insuffisante','Stock insuffisant',quota+' ; marge négative','Articles ou quantités invalides']){
  const o=order();o.temu_auto_purchase.result.message=message;
  assert.equal(currentTemuPurchaseHoldDetail(o,{now}),message);
  assert.match(currentHoldDiagnostic(o).label,new RegExp(message));
 }
});
test('fallback observation date and optional exact display prefix preserve causal retirement',()=>{
 const o=order();delete o.temu_auto_purchase.checkedAt;
 o.temu_auto_purchase.result.message='Achat d’étiquette TEMU à confirmer : TEMU · '+quota;
 assert.equal(currentTemuPurchaseHoldDetail(o,{now}),'');
});
test('a current deferred read remains observable and never becomes purchase confirmation',()=>{
 const o=order();o.source_payload.temuReadDeferred={deferred:true};
 assert.equal(currentHoldDiagnostic(o).code,'temu_read_deferred');
 assert.equal(currentHoldDiagnostic(o).decisionRequired,false);
});

test('monitor refresh replaces its old visible result without changing the confirmation decision',()=>{
 const o=order();o.awaiting_purchase=true;
 const result=monitoringObservation(o,{result:'Achat d’étiquette TEMU à confirmer : '+quota,blocked:false},now);
 assert.equal(result.result,'Achat d’étiquette TEMU à confirmer');
 assert.equal(result.blocked,false);
 assert.equal(result.followUp,true);
 assert.equal(result.holdCode,'temu_confirmation');
 assert.equal(o.temu_auto_purchase.result.message,quota);
});
