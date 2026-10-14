import test from 'node:test';
import assert from 'node:assert/strict';
import {canRetryFailedCarrier,hasUncertainCarrierHistory,provesClearedImportedPreflight} from '../src/carrier-attempt-proof.mjs';
const job={order_id:'o',status:'failed',attempts:1,creation_id:'reserved',result:null,reference:null,tracking:[],error:null,updated_at:'2026-10-14T10:01:44.515Z'};
const audit={action:'erplain.label_preflight_refreshed',created_at:'2026-10-14T10:01:44.515266Z',detail:{orderId:'o',currentError:null,previousError:'Erplain LIVE · Informations obligatoires manquantes : Numéro de téléphone',labelPurchased:false}};
test('exact archived cleared phone refusal is retryable with reserved creation ID',async()=>{
 const before=JSON.stringify({job,audit});
 const db={query:async sql=>({rows:sql.includes('FROM carrier_label_history')?[{job,documents:false}]:[audit]})};
 assert.equal(await canRetryFailedCarrier(db,job),true);
 assert.equal(await hasUncertainCarrierHistory(db,'o'),false);
 assert.equal(JSON.stringify({job,audit}),before);
});
for(const [name,patch] of Object.entries({laterAttempt:{attempts:2},providerStarted:{creation_started_at:'now'},providerPhase:{failure_phase:'provider'},tracking:{tracking:['T']},reference:{reference:'R'},result:{result:{}},unknownTracking:{tracking:null},laterUpdate:{updated_at:'2026-10-14T10:01:44.516Z'}}))test('no retry for '+name,()=>assert.equal(provesClearedImportedPreflight({...job,...patch},audit),false));
for(const [name,patch] of Object.entries({unknownAction:{action:'another'},missingDate:{created_at:null},wrongOrder:{detail:{...audit.detail,orderId:'other'}},providerError:{detail:{...audit.detail,previousError:'Transporteur timeout'}},purchase:{detail:{...audit.detail,labelPurchased:true}},missingPurchaseProof:{detail:{...audit.detail,labelPurchased:undefined}}}))test('reject incomplete audit '+name,()=>assert.equal(provesClearedImportedPreflight(job,{...audit,...patch}),false));
test('archive PDF remains protected despite exact preflight proof',async()=>assert.equal(await hasUncertainCarrierHistory({query:async()=>({rows:[{job,documents:true}]})},'o'),true));
test('unexplained null failure never permits replay',async()=>assert.equal(await canRetryFailedCarrier({query:async()=>({rows:[]})},job),false));
