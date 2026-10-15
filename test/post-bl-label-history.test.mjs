import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {projectCurrentDiagnostics} from '../src/current-order-diagnostics.mjs';
import {retiredPostBlLabelReasons} from '../src/post-bl-label-history.mjs';
import {processingView} from '../src/order-priority.mjs';
import {currentProblemClassifier} from '../src/problem-typology-reader.mjs';
import {orderProblemLabels} from '../src/problem-typology.mjs';
const fixture=(reason=retiredPostBlLabelReasons[0])=>({id:'synthetic',channel:'temu',carrier:'gls',transport_choice:'gls',document_count:0,tracking_status:'not_shipped',label_status:'production_pending',suspension:{},erp_live:{bl:{id:'bl',status:'ready_to_ship'}},resolution_error:reason,carrier_job:{status:'failed',error:reason,tracking:[],result:null,creation_started_at:null,failure_phase:null,updated_at:'2026-10-14T09:50:59Z'},resolution_actions:[{id:'r',status:'review',error:reason}],sku_lines:[]});
for(const reason of retiredPostBlLabelReasons)test('published BL moves exact obsolete refusal to history: '+reason,()=>{
 const source=fixture(reason),before=JSON.stringify(source),o=projectCurrentDiagnostics(structuredClone(source));
 assert.equal(o.carrier_job.error,null);assert.equal(o.resolution_error,null);assert.equal(o.resolution_actions[0].error,null);
 assert.equal(o.label_manual_request_required,true);assert(o.label_diagnostic_history.some(h=>h.reason===reason));
 assert.equal(o.carrier_job.status,'failed');assert.equal(o.resolution_actions[0].status,'review');assert.equal(o.label_status,'production_pending');assert.equal(JSON.stringify(source),before);
 assert.deepEqual(projectCurrentDiagnostics(structuredClone(o)),o);
 const p=processingView({id:o.id,carrier:'gls',carrier_status:'failed',carrier_error:o.carrier_job.error,resolution_status:'review',resolution_error:o.resolution_error,label_manual_request_required:true});
 assert.equal(p.state,'manual');assert(!p.activities.some(a=>a.state==='blocked'));
 assert.equal(currentProblemClassifier()(o).length,0);
 assert.equal(orderProblemLabels(o,currentProblemClassifier(),true).length,0);
});
for(const [name,patch] of Object.entries({missingBl:{erp_live:{}},cancelledBl:{erp_live:{bl:{id:'bl',status:'cancelled'}}},partial:{partial_mode:true},suspended:{suspension:{active:true}},provider:{carrier_job:{failure_phase:'provider'}},marker:{carrier_job:{creation_started_at:'now'}},tracking:{carrier_job:{tracking:['T']}},reference:{carrier_job:{reference:'R'}},result:{carrier_job:{hasResult:true}},pdf:{document_count:1},persistedPdf:{carrier_job:{documentCount:1}},uncertain:{carrier_job:{status:'review'}},unknown:{carrier_job:{error:'GLS timeout'}}}))test('preserve real/uncertain or protected state: '+name,()=>{
 const o=fixture();Object.assign(o,{...patch,carrier_job:{...o.carrier_job,...patch.carrier_job}});const previous=o.carrier_job.error;
 const projected=projectCurrentDiagnostics(structuredClone(o));assert.equal(projected.label_manual_request_required,undefined);assert.equal(projected.carrier_job.error,previous);
});
test('independent errors stay visible and history HTML is escaped',()=>{
 const o=fixture();o.issue='Stock à rapprocher séparément';o.resolution_error='GLS erreur fournisseur';
 const p=projectCurrentDiagnostics(structuredClone(o));assert.equal(p.issue,o.issue);assert.equal(p.resolution_error,o.resolution_error);
 const context={esc:s=>String(s).replaceAll('<','&lt;'),console};vm.createContext(context);vm.runInContext(readFileSync(new URL('../public/diagnostics.js',import.meta.url),'utf8'),context);
 context.order=p;const html=vm.runInContext('postBlLabelHistoryHtml(order)',context);assert.match(html,/Nouvelle demande manuelle attendue/);assert.match(html,/Historique de l’étiquette/);
 p.label_diagnostic_history=[{reason:'<script>unsafe'}];assert(!vm.runInContext('postBlLabelHistoryHtml(order)',context).includes('<script>'));
});
