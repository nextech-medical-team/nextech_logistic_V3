import {test} from 'node:test';
import assert from 'node:assert/strict';
import {currentCarrierReason,projectCurrentDiagnostics,currentReasonSql,currentReasonEmptySql} from '../src/current-order-diagnostics.mjs';
const stale='Transporteur non déterminé';
for(const carrier of ['gls','gls_pharma','gls_shop','gofo'])test('Retire le motif exact pour '+carrier,()=>{
 const original={carrier,issue:stale,resolution_error:stale,erp_live_job:{error:stale},carrier_job:{error:'Préparation modifiée depuis la validation du BL'},resolution_actions:[{error:stale}],label_status:'simulated',document_count:0};
 const o=projectCurrentDiagnostics(structuredClone(original));
 assert.equal(o.issue,null);assert.equal(o.resolution_error,null);assert.equal(o.erp_live_job.error,null);
 assert.equal(o.carrier_job.error,original.carrier_job.error);assert.deepEqual(o.resolution_actions,original.resolution_actions);
 assert.equal(o.label_status,'simulated');assert.equal(o.document_count,0);assert.equal(original.issue,stale);
});
for(const carrier of [null,'','unknown','temu'])test('Conserve le défaut si transporteur indéterminé '+carrier,()=>assert.equal(currentCarrierReason({carrier},stale),stale));
test('Conserve motifs composites, erreurs réelles et absence de motif',()=>{
 for(const reason of [stale+' ; Stock insuffisant','Préparation modifiée depuis la validation du BL',null,'Étiquette refusée par TEMU'])assert.equal(currentCarrierReason({carrier:'gofo'},reason),reason);
});
test('Les deux filtres SQL utilisent la même règle exacte',()=>{
 for(const sql of [currentReasonSql('issue'),currentReasonEmptySql('issue')]){assert.match(sql,/carrier IN/);assert.match(sql,/Transporteur non déterminé/);}
});
