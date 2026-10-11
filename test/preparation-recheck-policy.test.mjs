import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {initializeRecoverySweeps,requestRecoverySweeps,currentHoldDiagnostic,externalCoverage} from '../src/preparation-recheck-policy.mjs';

test('independent durable sweeps rediscover missing jobs, restrict hourly scope and survive restart',async()=>{
 const db=new PGlite();try{
  await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,archived boolean DEFAULT false,resolution_pending_resume boolean DEFAULT false,issue text,partial_mode boolean DEFAULT false,label_status text,erp_status text);
   CREATE TABLE order_recheck_monitor(order_id text PRIMARY KEY REFERENCES orders(id),state jsonb DEFAULT '{}',next_check timestamptz DEFAULT now(),next_external timestamptz DEFAULT now(),requested bigint DEFAULT 1);
   CREATE TABLE erp_live_jobs(order_id text,status text);CREATE TABLE resolution_jobs(order_id text,status text);CREATE TABLE correction_jobs(order_id text,status text);
   INSERT INTO orders(id,issue) VALUES('untracked','Stock à vérifier');INSERT INTO orders(id) VALUES('healthy');INSERT INTO orders(id,archived,issue) VALUES('archive',true,'Stock');`);
  await initializeRecoverySweeps(db);
  await db.query("UPDATE order_recheck_sweeps SET next_at=now()+interval '1 day' WHERE name='daily-consistency'");
  const first=await requestRecoverySweeps(db);assert.equal(first.length,1);assert.equal(first[0].requested,1);assert.equal(first[0].providerMutations,0);
  const rows=(await db.query('SELECT * FROM order_recheck_monitor ORDER BY order_id')).rows;assert.equal(rows.length,2);assert.equal(rows.find(x=>x.order_id==='untracked').state.auditRequested,true);assert.deepEqual(rows.find(x=>x.order_id==='healthy').state,{});
  await initializeRecoverySweeps(db);assert.deepEqual(await requestRecoverySweeps(db),[]);
  await db.query("UPDATE order_recheck_sweeps SET next_at=now()-interval '1 second' WHERE name='daily-consistency'");
  assert.equal((await requestRecoverySweeps(db))[0].requested,2);
  const daily=(await db.query("SELECT next_at>now() future,result FROM order_recheck_sweeps WHERE name='daily-consistency'")).rows[0];assert.equal(daily.future,true);assert.equal(daily.result.providerMutations,0);
 }finally{await db.close();}
});

test('hold reasons expose the real next stage without the obsolete generic message',()=>{
 const bc={id:'1'},bl={id:'2'};
 const cases=[
  [{erp_live:{}},'bc_unverified'],
  [{erp_live:{bc}},'bl_missing'],
  [{erp_live:{bc},erp_live_job:{status:'pending'},resolution_pending_resume:true},'erp_admission_hold'],
  [{channel:'temu',erp_live:{bc,bl},temu_job:{status:'ready'}},'temu_confirmation'],
  [{channel:'temu',erp_live:{bc,bl},temu_job:{status:'shipment_error',error:'TEMU: colis existant à rapprocher'}},'temu_error'],
  [{channel:'temu',erp_live:{bc,bl},temu_job:{status:'complete'}},'legacy_proof'],
  [{source_payload:{marketplacePendingCorrection:true}},'source_change']
 ];
 for(const [o,code] of cases){const d=currentHoldDiagnostic(o);assert.equal(d.code,code);assert.ok(d.nextStep);assert.notEqual(d.label,'Reprise de préparation à vérifier');}
});
test('two missed external cycles alert; an attempt never substitutes a complete check',()=>{
 const now=Date.parse('2026-10-11T12:00:00Z');
 assert.equal(externalCoverage({attemptedAt:new Date(now-1800000).toISOString(),now}).overdue,true);
 assert.equal(externalCoverage({attemptedAt:new Date(now).toISOString(),checkedAt:new Date(now-1800000).toISOString(),now}).overdue,true);
 assert.equal(externalCoverage({checkedAt:new Date(now-60000).toISOString(),now}).overdue,false);
});
