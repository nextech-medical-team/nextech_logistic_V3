import test from 'node:test';import assert from 'node:assert/strict';import {monitoringObservation} from '../src/order-recheck-monitor.mjs';import {correctionStatusSnapshot} from '../src/correction-status-check.mjs';import {currentHoldDiagnostic} from '../src/preparation-recheck-policy.mjs';
test('legacy blocked status becomes the actual stage; independent error remains visible',()=>{
 const base={label_status:'blocked',erp_status:'blocked',resolution_error:'Préparation bloquée : vérification à reprendre',erp_live:{bc:{id:'1'},bl:{id:'2'},phase:'bl_ready'},channel:'temu',erp_live_job:{status:'complete'},temu_job:{status:'ready'}};
 assert.equal(monitoringObservation(base).result,'Achat d’étiquette TEMU à confirmer');
 const refused={...base,temu_job:{status:'shipment_error',error:'TEMU · Étiquette refusée : adresse non anglaise'}};
 assert.match(monitoringObservation(refused).result,/^Étiquette refusée par TEMU/);
 const actual={...base,issue:'Stock insuffisant'};assert.equal(monitoringObservation(actual).result,'Stock insuffisant');
 const pending={...base,erp_live:{},erp_live_job:{status:'pending'},temu_job:null};
 assert.match(monitoringObservation(pending).result,/Préparation Erplain en attente/);
 const missing={label_status:'blocked',erp_status:'live_review',issue:'Correspondance SKU absente : BT-010-G'};
 const snapshot=correctionStatusSnapshot(missing,{erpJob:{status:'review',error:'BC · Mapping manquant : BT-010-G'}});
 assert.ok(snapshot.blockers.includes(missing.issue));assert.ok(!snapshot.blockers.some(x=>/^Préparation bloquée/.test(x)));
 assert.equal(missing.label_status,'blocked');
});
test('automatic purchase refusal remains actionable with precise reason',()=>{
 const d=currentHoldDiagnostic({channel:'temu',erp_live:{bc:{id:'1'},bl:{id:'2'}},temu_job:{status:'ready'},temu_auto_purchase:{result:{status:'held',message:'Achat d’étiquette TEMU à confirmer : Marge nulle ou négative'}}});
 assert.equal(d.label,'Achat d’étiquette TEMU à confirmer : Marge nulle ou négative');assert.ok(d.decisionRequired);
});


import {processingView} from '../src/order-priority.mjs';
test('processing timeline exposes waiting Erplain, missing BL, TEMU confirmation and TEMU refusal',()=>{
 assert.match(processingView({erp_status:'pending',erp_position:1}).step,/Préparation Erplain en attente de traitement/);
 assert.equal(processingView({erp_status:'review',phase:'bc_created'}).step,'BL Erplain restant à préparer');
 assert.equal(processingView({temu_status:'ready'}).step,'Achat d’étiquette TEMU à confirmer');
 assert.equal(processingView({temu_status:'shipment_error',temu_error:'wrong address'}).step,'Étiquette refusée par TEMU');
});

test('an obsolete generic issue never hides a current stock or provider failure',()=>{
 const o={channel:'temu',issue:'Préparation bloquée : vérification à reprendre',label_status:'blocked',erp_live:{phase:'bl_ready',bc:{id:'1'},bl:{id:'2'}},erp_live_job:{status:'review',error:'Stock insuffisant : SKU TEST'},temu_job:{status:'ready'}};
 assert.equal(monitoringObservation(o).result,'Stock insuffisant : SKU TEST');
 assert.equal(monitoringObservation({...o,erp_live_job:{status:'review',error:null},temu_job:{status:'shipment_error',error:'TEMU · Étiquette refusée : adresse invalide'}}).result,'Étiquette refusée par TEMU : TEMU · Étiquette refusée : adresse invalide');
});
