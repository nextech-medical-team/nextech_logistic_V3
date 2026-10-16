import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {syncSupersededQuotaReviews} from '../src/erplain-transient-recovery.mjs';
test('only a newer confirmed business refusal supersedes quota; no business data changes or retry',async()=>{
 const db=new PGlite();await db.waitReady;
 try{
 await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,erp_live jsonb,source_payload jsonb DEFAULT '{}',suspension jsonb DEFAULT '{}',resolution_pending_resume boolean DEFAULT false,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,label_status text,tracking_status text);
 CREATE TABLE erp_live_jobs(order_id text,status text,error text,updated_at timestamptz);
 CREATE TABLE resolution_jobs(id text PRIMARY KEY,order_id text,status text,stage text,error text,updated_at timestamptz,result jsonb);
 CREATE TABLE correction_jobs(order_id text,status text);`);
 const old='Erplain temporairement limité : vérification et reprise automatiques programmées',reason='BC · Quantités réservées non confirmées · SKU TEST : commandées 50, réservées 0, expédiées 0';
 for(const id of ['current','older','quota','unknown','transient','generic','blank','suspended','cancelled','partial','held','archived','resolution','correction','stage','error','pending','source']){
 const recovery={readRateLimited:false,lastError:null};if(id==='quota')recovery.readRateLimited=true;if(id==='unknown')delete recovery.readRateLimited;
 await db.query('INSERT INTO orders(id,erp_live,suspension,label_status,partial_mode,resolution_pending_resume,archived,source_payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,JSON.stringify({phase:'bc_created',bc:{id:1},transientRecovery:recovery}),JSON.stringify(id==='suspended'?{active:true}:{}),id==='cancelled'?'cancelled':'pending',id==='partial',id==='held',id==='archived',JSON.stringify(id==='source'?{marketplacePendingCorrection:{active:true}}:{})]);
 await db.query('INSERT INTO erp_live_jobs VALUES($1,$2,$3,$4)',[id,id==='pending'?'pending':'review',id==='transient'?'Erplain HTTP 503':id==='generic'?'Incident temporaire Erplain : attente':id==='blank'?'':reason,id==='older'?'2026-10-15T01:00:00Z':'2026-10-15T03:00:00Z']);
 await db.query("INSERT INTO resolution_jobs VALUES($1,$1,'review',$2,$3,'2026-10-15T02:00:00Z',$4)",[id,id==='stage'?'Autre contrôle':'Erplain à compléter',id==='error'?'Stock insuffisant':old,JSON.stringify({preserved:true})]);
 }
 await db.exec("INSERT INTO resolution_jobs VALUES('active','resolution','queued','Attente',null,now(),null);INSERT INTO correction_jobs VALUES('correction','checking')");
 const before=(await db.query('SELECT * FROM orders ORDER BY id')).rows,erp=(await db.query('SELECT * FROM erp_live_jobs ORDER BY order_id')).rows;
 await db.transaction(tx=>syncSupersededQuotaReviews(tx));
 const rows=(await db.query('SELECT * FROM resolution_jobs ORDER BY id')).rows;assert.deepEqual(rows.filter(r=>r.result?.diagnosticAuthority).map(r=>r.id),['current']);
 const current=rows.find(r=>r.id==='current');assert.equal(current.status,'review');assert.equal(current.error,reason);assert.equal(current.result.supersededQuotaError,old);assert.equal(current.result.preserved,true);
 assert.deepEqual((await db.query('SELECT * FROM orders ORDER BY id')).rows,before);assert.deepEqual((await db.query('SELECT * FROM erp_live_jobs ORDER BY order_id')).rows,erp);
 await db.transaction(tx=>syncSupersededQuotaReviews(tx));assert.deepEqual((await db.query('SELECT * FROM resolution_jobs ORDER BY id')).rows,rows);
 }finally{await db.close();}
});
