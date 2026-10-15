import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {projectCurrentDiagnostics} from '../src/current-order-diagnostics.mjs';
import {replacementDiagnosticProof,supersededStockReason} from '../src/substitution-diagnostics.mjs';
import {currentResolutionState,completedHistoricalPreparation} from '../src/historical-preparation-completion.mjs';
import {monitoringObservation} from '../src/order-recheck-monitor.mjs';
const shortage=sku=>'BL bloqué — stock insuffisant : '+sku+' : 1 nécessaires, 0 utilisables, manque 1';
function order(){
 const at=new Date(Date.now()-1000).toISOString();
 return {id:'o',channel:'temu',reference:'PO-EXAMPLE',source_payload:{},label_status:'pending',erp_status:'live_review',tracking_status:'not_shipped',issue:null,erp_live_job:{status:'pending',error:null},resolution_active:{stage:'Équivalent enregistré · contrôle stock et BL'},resolution_error:shortage('OLD'),erp_live:{bc:{id:'10',status:'active',line_items:[{variant:{sku:'OLD'},quantity:1}]},phase:'bc_created',equivalentAttemptId:'committed-attempt',equivalentRefreshedAt:at,equivalentOriginalLines:[{source_sku:'OLD',quantity:1}],equivalentItems:[{description:'NEW',quantity:1}],documentSource:{checkedAt:at,lines:[{lineId:'new',sku:'NEW',quantity:1}]},stockIncidentRecheck:{status:'active',checkedAt:at,currentError:shortage('OLD')}},resolution_actions:[{action:'replace-equivalent',status:'waiting',error:null,result:{equivalent:true,erpOnly:true}},{action:'equivalent-preview',status:'complete',result:{replacementSku:'NEW'}},{action:'resume-erp',status:'review',error:shortage('OLD')} ]};
}
test('legacy confirmed replacement projects obsolete original shortage as history and keeps preparation pending',async()=>{
 const original=order(),before=structuredClone(original),o=projectCurrentDiagnostics(structuredClone(original));
 assert.equal(o.resolution_error,null);assert.equal(o.erp_live.stockIncidentRecheck.currentError,null);assert.equal(o.erp_live.stockIncidentRecheck.status,'superseded');assert.equal(o.resolution_actions[2].error,null);
 assert(o.substitution_diagnostic_history.some(h=>h.reason===shortage('OLD')));
 assert.deepEqual(o.replacement_preparation.products,[{sku:'NEW',quantity:1}]);
 assert.equal(o.erp_live_job.status,'pending');assert.equal(o.erp_live.bl,undefined);assert.equal(o.erp_live.verifiedAt,undefined);assert.deepEqual(original,before);
 const ui=vm.createContext({});vm.runInContext(await readFile(new URL('../public/compact-problems.js',import.meta.url),'utf8'),ui);
 const problems=ui.compactProblems(o);assert.equal(problems.length,1);assert.equal(problems[0].type,'preparation-pending');assert.equal(problems[0].sku,'NEW');assert(!problems[0].label.includes('stock insuffisant'));
 const observed=monitoringObservation(original,{});assert.equal(observed.blocked,false);assert.notEqual(observed.result,'Remplacement à confirmer');
 assert.equal(completedHistoricalPreparation(o,{status:'pending',error:null}),false);
});
test('no proof, changed quantities, invalid quantities and mismatched product sets retain the original diagnostic',()=>{
 for(const change of [o=>delete o.erp_live.equivalentAttemptId,o=>o.erp_live.equivalentRefreshedAt='bad',o=>o.erp_live.equivalentRefreshedAt=new Date(Date.now()+60000).toISOString(),o=>o.erp_live.documentSource.checkedAt='bad',o=>o.erp_live.documentSource.lines[0].quantity=2,o=>o.erp_live.documentSource.lines[0].quantity=true,o=>o.erp_live.documentSource.lines[0].sku='OTHER',o=>o.erp_live.equivalentItems=[],o=>o.erp_live.documentSource.lines=[]]){
  const o=order();change(o);const projected=projectCurrentDiagnostics(o);assert.equal(projected.resolution_error,shortage('OLD'));assert.equal(projected.replacement_preparation,undefined);
 }
});
test('partial replacement, replacement shortage, mixed and generic errors remain visible',()=>{
 const o=order();const proof=replacementDiagnosticProof(o);
 for(const reason of [shortage('NEW'),shortage('OLD')+' ; NEW : 1 nécessaires, 0 utilisables, manque 1',shortage('OLD')+' ; Adresse invalide','Stock insuffisant','Produit de remplacement [NEW] : stock insuffisant'])assert.equal(supersededStockReason(reason,proof),false,reason);
 const partial=order();partial.erp_live.documentSource.lines.push({sku:'OLD',quantity:1});partial.erp_live.equivalentItems.push({description:'OLD',quantity:1});assert.equal(projectCurrentDiagnostics(partial).resolution_error,shortage('OLD'));
 const current=order();current.erp_live_job={status:'review',error:shortage('NEW')};const projected=projectCurrentDiagnostics(current);assert.equal(projected.erp_live_job.error,shortage('NEW'));assert.equal(projected.replacement_preparation,undefined);
});
test('suspension, cancelled orders and partial/import-deferred flows gain no readiness or pending confirmation',()=>{
 for(const patch of [{suspension:{active:true}},{label_status:'cancelled'},{tracking_status:'shipped'},{partial_mode:true},{resolution_pending_resume:true},{archived:true}]){const o={...order(),...patch};assert.equal(projectCurrentDiagnostics(o).replacement_preparation,undefined);}
 const actions=order().resolution_actions;assert.equal(currentResolutionState(actions).pendingReplacement,false);
 for(const patch of [{status:'review',error:'Uncertain mutation'},{result:{equivalent:true,erpOnly:true,partialRemainder:true}},{result:{equivalent:true,erpOnly:true,importDeferred:true}},{result:{} }])assert.equal(currentResolutionState([{...actions[0],...patch},actions[1]]).pendingReplacement,true);
 assert.equal(currentResolutionState([actions[1],actions[0]]).pendingReplacement,true,'a newer preview still needs confirmation');
});
test('persisted snapshot proof also covers mapped source SKUs after BC synchronization',()=>{
 const o=order();o.erp_live.bc.line_items=[{variant:{sku:'NEW'},quantity:1}];o.erp_live.equivalentOriginalLines=[{source_sku:'MARKETPLACE'}];o.erp_live.substitutionDiagnostics={retiredSkus:['OLD'],bcId:'10'};
 assert.equal(projectCurrentDiagnostics(o).resolution_error,null);
 o.erp_live.documentSource.lines=[{sku:'OLD',quantity:1}];o.erp_live.equivalentItems=[{description:'OLD',quantity:1}];o.resolution_error=shortage('OLD');assert.equal(projectCurrentDiagnostics(o).resolution_error,shortage('OLD'),'reintroduced products are current again');
});
test('a later divergent BC or fresh failed preparation cannot be certified by an older replacement',()=>{
 const current=order();current.erp_live.substitutionDiagnostics={bcId:'10',retiredSkus:['OLD']};
 assert.equal(projectCurrentDiagnostics(current).resolution_error,shortage('OLD'));
 const failed=order();failed.erp_live_job={status:'review',error:shortage('OLD'),updated_at:new Date().toISOString()};assert.equal(projectCurrentDiagnostics(failed).erp_live_job.error,shortage('OLD'));
});
