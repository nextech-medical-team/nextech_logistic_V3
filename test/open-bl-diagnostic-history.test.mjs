import test from 'node:test';import assert from 'node:assert/strict';
import {projectCurrentDiagnostics} from '../src/current-order-diagnostics.mjs';
import {noPendingBlReason} from '../src/open-bl-diagnostic-history.mjs';
import {currentProblemClassifier} from '../src/problem-typology-reader.mjs';
import {selectProblemOrders} from '../src/problem-typology.mjs';
const fixture=()=>({id:'mixed',channel:'erplain',tracking_status:'not_shipped',label_status:'simulated',erp_status:'live_review',source_payload:{erplainImported:true,account:'live'},resolution_error:noPendingBlReason,erp_live:{bc:{id:1,status:'active'},documentSource:{shippingOrders:[{id:2,status:'delivered'},{id:3,status:'in_preparation'}]}}});
test('open BL retires only exact historical no-pending reason and both synthetic fallbacks',()=>{
 for(const status of ['pending','make_the_shipment','in_preparation','ready_to_ship']){
 const source=fixture();source.erp_live.documentSource.shippingOrders[1].status=status;const initial=JSON.stringify(source);const o=projectCurrentDiagnostics(structuredClone(source));
 assert.equal(o.resolution_error,null);assert.equal(o.open_bl_diagnostic_history[0].reason,noPendingBlReason);assert.deepEqual(o.open_bl_diagnostic_history[0].openBlIds,['3']);assert.equal(currentProblemClassifier()(o).length,0);assert.equal(selectProblemOrders([o],[],currentProblemClassifier(),['mixed'],true).total,0);assert.equal(selectProblemOrders([o],[],currentProblemClassifier()).total,1);assert.equal(JSON.stringify(source),initial);assert.deepEqual(projectCurrentDiagnostics(structuredClone(o)),o);
 }
});
test('carrier phone and other independent active failures survive history retirement',()=>{
 const o=fixture();o.carrier_job={status:'failed',error:'Erplain LIVE · Informations obligatoires manquantes : Numéro de téléphone'};projectCurrentDiagnostics(o);const problems=currentProblemClassifier()(o);assert.equal(problems.length,1);assert.equal(problems[0].detail,o.carrier_job.error);assert.equal(selectProblemOrders([o],[],currentProblemClassifier(),['mixed'],true).total,1);
});
test('no retirement without an associated open BL or outside verified live imports',()=>{
 for(const mutate of [o=>o.erp_live.documentSource.shippingOrders.pop(),o=>o.erp_live.documentSource.shippingOrders[1].status='cancelled',o=>o.erp_live.documentSource.shippingOrders[1].status='unpublished',o=>o.source_payload.account='test',o=>o.source_payload.erplainImported=false,o=>o.partial_mode=true,o=>o.erp_live.bc.status='cancelled']){const o=fixture();mutate(o);projectCurrentDiagnostics(o);assert.equal(o.open_bl_diagnostic_history,undefined);}
});
test('mixed reasons are never silently retired',()=>{const o=fixture();o.resolution_error+=' ; Stock insuffisant';projectCurrentDiagnostics(o);assert.equal(o.open_bl_diagnostic_history,undefined);assert.ok(o.resolution_error.includes('Stock insuffisant'));});
