import test from 'node:test';
import assert from 'node:assert/strict';
import {projectCurrentDiagnostics} from '../src/current-order-diagnostics.mjs';
import {selectProblemOrders,WITHOUT_DIAGNOSTIC} from '../src/problem-typology.mjs';
import {currentProblemClassifier} from '../src/problem-typology-reader.mjs';
const archived='Étiquette TEMU déjà achetée : PDF original indisponible (120018027). FedEx TEST déjà collecté ; conserver cette expédition.';
function delivered(){return {id:'delivered',channel:'temu',tracking_status:'delivered',label_status:'ready',source_payload:{externalLabel:{active:true}},issue:archived,temu_job:{status:'external',error:archived},erp_live_job:{status:'complete',error:null}};}
test('delivered PDF history cannot reenter active problems through the SQL fallback',()=>{
 const o=delivered(),before=structuredClone(o);projectCurrentDiagnostics(o);
 assert.equal(o.temu_pdf_archive_note,archived);assert.equal(o.issue,null);assert.equal(o.temu_job.error,null);
 for(const labels of [[],[WITHOUT_DIAGNOSTIC]]){const r=selectProblemOrders([o],labels,currentProblemClassifier(),[o.id],true);assert.equal(r.total,0);assert.deepEqual(r.problemTypes,[]);}
 assert.deepEqual(before,delivered());assert.equal(o.tracking_status,'delivered');assert.equal(o.temu_job.status,'external');
});
test('human delivery rule closes even independent errors while retaining archived PDF history',()=>{
 const o=delivered();o.erp_live_job={status:'review',error:'Stock insuffisant'};projectCurrentDiagnostics(o);
 const r=selectProblemOrders([o],[],currentProblemClassifier(),[o.id],true);assert.equal(r.total,0);assert.deepEqual(r.problemTypes,[]);assert.equal(o.erp_live_job.error,null);assert.equal(o.temu_pdf_archive_note,archived);
});
test('ordinary lists retain history, unknown active errors and partial remainders remain visible',()=>{
 const o=delivered();projectCurrentDiagnostics(o);assert.equal(selectProblemOrders([o],[],currentProblemClassifier(),[o.id]).total,1);
 const unknown={id:'unknown'},partial={id:'partial',partial_mode:true,label_status:'blocked',issue:'Stock insuffisant'};
 const r=selectProblemOrders([o,unknown,partial],[],currentProblemClassifier(),['delivered','unknown','partial'],true);
 assert.deepEqual(r.rows.map(o=>o.id),['unknown','partial']);assert.ok(r.problemTypes.some(p=>p.label===WITHOUT_DIAGNOSTIC));
});
test('undelivered PDF refusal remains an active problem',()=>{
 const o=delivered();o.tracking_status='in_transit';projectCurrentDiagnostics(o);assert.equal(selectProblemOrders([o],[],currentProblemClassifier(),[o.id],true).total,1);
});
