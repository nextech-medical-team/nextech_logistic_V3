import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
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
test('SQL réel : projection et filtre concordent, aucune écriture de diagnostic',async()=>{
 const db=new PGlite();try{
  await db.exec('CREATE TABLE orders(carrier text,channel text,source_payload jsonb,erp_live jsonb,issue text,address jsonb,resolution_pending_resume boolean)');
  for(const carrier of ['gofo','gls','gls_pharma','gls_shop',null,'unknown'])for(const reason of [stale,'Stock insuffisant',null,stale+' ; Stock insuffisant']){
   await db.query("INSERT INTO orders VALUES($1,'amazon','{}','{}',$2,'{}',false)",[carrier,reason]);
  }
  const before=(await db.query('SELECT * FROM orders')).rows;
  const rows=(await db.query(`SELECT *,${currentReasonSql('issue')} AS reason,${currentReasonEmptySql('issue')} AS empty FROM orders`)).rows;
  for(const o of rows){const expected=currentCarrierReason(o,o.issue);assert.equal(o.reason,expected);assert.equal(o.empty,expected===null);}
  assert.deepEqual((await db.query('SELECT * FROM orders')).rows,before);
 }finally{await db.close();}
});
