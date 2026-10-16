import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {projectCurrentDiagnostics} from '../src/current-order-diagnostics.mjs';
import {manualLabelRequestView} from '../src/manual-label-request-view.mjs';
import {processingView} from '../src/order-priority.mjs';
import {currentProblemClassifier} from '../src/problem-typology-reader.mjs';
const fixture=(status='queued')=>({channel:'temu',carrier:'temu',document_count:0,erp_live:{},source_payload:{},resolution_active:{id:'request',action:'choose-carrier',carrier:'gls',status,created_at:'2026-10-15T11:14:54Z',updated_at:'2026-10-15T11:14:54Z'},temu_job:{status:'shipment_error',error:'TEMU · Étiquette refusée : adresse',state_since:'2026-10-15T10:49:49Z'}});
for(const carrier of ['gls','gofo'])for(const status of ['queued','running','waiting'])test('acknowledge persisted '+carrier+' request '+status+' without claiming purchase',()=>{
 const o=fixture(status);o.resolution_active.carrier=carrier;const before=JSON.stringify(o),p=projectCurrentDiagnostics(structuredClone(o));
 assert.equal(p.manual_label_request.carrier,carrier);assert.equal(p.temu_job.error,null);assert.equal(p.previous_temu_label_refusal.reason,o.temu_job.error);assert.equal(p.carrier,'temu');assert.equal(p.transport_choice,undefined);assert.equal(JSON.stringify(o),before);
 assert(!/achetée|créée|disponible/.test(p.manual_label_request.message));
 assert.equal(currentProblemClassifier()({...p,label_status:'blocked',sku_lines:[]}).length,0);
 const v=processingView({id:'o',carrier:'temu',resolution_action:'choose-carrier',resolution_status:status,temu_status:'shipment_error',temu_error:null,manual_label_request:p.manual_label_request});
 assert.equal(v.service,carrier.toUpperCase());assert.notEqual(v.state,'blocked');
});
for(const status of ['uncertain','purchasing','cancellation_requested','api_error'])test('preserve independent TEMU state '+status,()=>{
 const o=fixture();o.temu_job.status=status;const p=projectCurrentDiagnostics(structuredClone(o));assert.equal(p.temu_job.error,o.temu_job.error);assert(!p.previous_temu_label_refusal);
});
test('newer or undated TEMU refusal stays current',()=>{
 for(const at of [null,'invalid','2026-10-15T12:00:00Z']){
  const o=fixture();o.temu_job.state_since=at;assert.equal(projectCurrentDiagnostics(o).temu_job.error,'TEMU · Étiquette refusée : adresse');
 }
});
test('unrelated, completed, unrecorded or unsupported requests do not invent a GLS acknowledgement',()=>{
 for(const patch of [{id:null},{action:'refresh'},{status:'complete'},{status:'review'},{carrier:'unknown'}]){const o=fixture();Object.assign(o.resolution_active,patch);assert.equal(manualLabelRequestView(o),null);}
 assert.equal(manualLabelRequestView({carrier:'gls'}),null);
});
test('only the matching request carrier job advances acknowledgement to actual available PDF',()=>{
 const o=fixture('waiting');o.carrier_job={batch_id:'old-request',status:'ready'};o.document_count=1;
 assert(!manualLabelRequestView(o).message.includes('disponible'));
 o.carrier_job.batch_id='resolution-request';assert.equal(manualLabelRequestView(o).message,'Étiquette GLS disponible');
 o.document_count=0;assert(!manualLabelRequestView(o).message.includes('disponible'));
 o.carrier_job.status='awaiting_pdf';assert.equal(manualLabelRequestView(o).message,'PDF GLS en cours de récupération');
 o.carrier_job.status='failed';o.carrier_job.error='Refus GLS';assert.equal(manualLabelRequestView(o).state,'blocked');assert.equal(manualLabelRequestView(o).message,'Refus GLS');
});
test('browser acknowledgement matches backend queued/running messages and escapes HTML',()=>{
 const context={esc:s=>String(s).replaceAll('<','&lt;')};vm.createContext(context);vm.runInContext(readFileSync(new URL('../public/diagnostics.js',import.meta.url),'utf8'),context);
 for(const status of ['queued','running'])for(const carrier of ['gls','gofo']){
  const o=fixture(status);o.resolution_active.carrier=carrier;const p=projectCurrentDiagnostics(o);
  assert.equal(vm.runInContext(`manualRequestFeedbackText('${status}','${carrier}')`,context),p.manual_label_request.message);
  context.order=p;const html=vm.runInContext('manualLabelRequestHtml(order)',context);assert(html.includes(p.manual_label_request.message));assert.match(html,/Reçue le/);assert.match(html,/Refus TEMU antérieur/);
 }
 context.order={manual_label_request:{message:'<script>bad',received_at:null}};assert(!vm.runInContext('manualLabelRequestHtml(order)',context).includes('<script>'));
});

test('excluded tender and persisting projection retain installed behavior',()=>{
 const tender=fixture();tender.channel='tender';assert.equal(manualLabelRequestView(tender),null);
 const persisted=fixture(),before=structuredClone(persisted);projectCurrentDiagnostics(persisted,{delivery:false});assert.equal(persisted.manual_label_request,undefined);assert.equal(persisted.temu_job.error,before.temu_job.error);
});
test('terminal delivery stays authoritative over an old active request',()=>{
 const o=fixture();o.tracking_status='delivered';const p=projectCurrentDiagnostics(o);assert.equal(p.order_delivered,true);assert.equal(p.manual_label_request,undefined);
});
