import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {closeTransientReviews} from '../src/erplain-transient-recovery.mjs';

const old='Erplain temporairement limité : vérification et reprise automatiques programmées';
const waiting='Accès Erplain en attente · reprise automatique programmée';
const state=()=>({bc:{id:1941165,status:'active',update_stock:true},bl:{id:1914865,status:'ready_to_ship'},phase:'bl_ready',verifiedAt:'2026-10-15T12:45:28.473Z',stockCheckedAt:'2026-10-15T12:40:39.354Z',transientRecovery:{attempts:1,lastError:'Erplain HTTP 429',lastFailureAt:'2026-10-15T11:44:49.762Z',nextReadCheckAt:'2026-10-15T11:55:00.809Z',readRateLimited:true}});

test('quota completion reconciles only old review diagnostics with newer verified ERP completion',async t=>{
 const db=new PGlite();await db.waitReady;t.after(()=>db.close());
 await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,erp_live jsonb,source_payload jsonb DEFAULT '{}',suspension jsonb DEFAULT '{}',resolution_pending_resume boolean DEFAULT true,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,label_status text DEFAULT 'simulated',tracking_status text DEFAULT 'not_shipped');
 CREATE TABLE erp_live_jobs(order_id text,status text,error text,updated_at timestamptz);
 CREATE TABLE resolution_jobs(id text PRIMARY KEY,order_id text,status text,stage text,error text,updated_at timestamptz,result jsonb);
 CREATE TABLE correction_jobs(order_id text,status text);`);
 async function reset(){
  await db.exec('TRUNCATE orders,erp_live_jobs,resolution_jobs,correction_jobs');
  await db.query("INSERT INTO orders(id,erp_live) VALUES('o',$1)",[JSON.stringify(state())]);
  await db.exec("INSERT INTO erp_live_jobs VALUES('o','complete',NULL,'2026-10-15T12:45:28.481872Z')");
  await db.query("INSERT INTO resolution_jobs VALUES('r','o','review','Erplain à compléter',$1,'2026-10-15T11:44:50.887932Z',$2)",[old,JSON.stringify({preserved:true})]);
 }
 async function check({complete=true,sql}={}){
  await reset();if(sql)await db.exec(sql);
  const orders=(await db.query('SELECT * FROM orders')).rows,erp=(await db.query('SELECT * FROM erp_live_jobs')).rows;
  const previous=(await db.query("SELECT * FROM resolution_jobs WHERE id='r'")).rows[0];
  await closeTransientReviews({transaction:fn=>db.transaction(fn)});
  const r=(await db.query("SELECT * FROM resolution_jobs WHERE id='r'")).rows[0];
  assert.equal(r.status,complete?'complete':'review');
  if(complete){assert.equal(r.error,null);assert.equal(r.result.resolvedPreviousError,previous.error);assert.equal(r.result.preserved,true);assert.equal(r.result.verifiedAt,orders[0].erp_live.verifiedAt);}
  else assert.deepEqual(r,previous);
  assert.deepEqual((await db.query('SELECT * FROM orders')).rows,orders,'holds, snapshots and recovery metadata remain unchanged');
  assert.deepEqual((await db.query('SELECT * FROM erp_live_jobs')).rows,erp,'no queueing or provider replay');
  await closeTransientReviews({transaction:fn=>db.transaction(fn)});
  assert.deepEqual((await db.query("SELECT * FROM resolution_jobs WHERE id='r'")).rows[0],r,'idempotent');
 }
 await t.test('observed completed TEMU order keeps its preparation hold',()=>check());
 await t.test('completed worker whose old quota flags are cleared is still authoritative',()=>check({sql:"UPDATE orders SET resolution_pending_resume=false,erp_live=jsonb_set(erp_live,'{transientRecovery}', '{\"readRateLimited\":false,\"lastError\":null}'::jsonb)"}));
 await t.test('missing legacy quota flags do not invalidate successful completion',()=>check({sql:"UPDATE orders SET erp_live=erp_live-'transientRecovery'"}));
 for(const status of ['shipped','delivered'])await t.test('already '+status+' retires only the former quota review',()=>check({sql:`UPDATE orders SET tracking_status='${status}',erp_live=jsonb_set(erp_live,'{bl,status}','"${status}"')`}));
 await t.test('current wording uses the same completion proof',async()=>{
  await reset();await db.query('UPDATE resolution_jobs SET error=$1',[waiting]);
  await closeTransientReviews({transaction:fn=>db.transaction(fn)});
  const r=(await db.query('SELECT * FROM resolution_jobs')).rows[0];assert.equal(r.status,'complete');assert.equal(r.result.resolvedPreviousError,waiting);
 });
 for(const [name,sql] of [
  ['pending worker',"UPDATE erp_live_jobs SET status='pending'"],
  ['unresolved worker',"UPDATE erp_live_jobs SET status='review'"],
  ['current worker error',"UPDATE erp_live_jobs SET error='Erplain HTTP 429'"],
  ['old verification',"UPDATE orders SET erp_live=jsonb_set(erp_live,'{verifiedAt}','\"2026-10-15T10:00:00Z\"')"],
  ['verification newer than job completion',"UPDATE erp_live_jobs SET updated_at='2026-10-15T12:00:00Z'"],
  ['failure after verification',"UPDATE orders SET erp_live=jsonb_set(erp_live,'{transientRecovery,lastFailureAt}','\"2026-10-15T13:00:00Z\"')"],
  ['invalid failure date',"UPDATE orders SET erp_live=jsonb_set(erp_live,'{transientRecovery,lastFailureAt}','\"invalid\"')"],
  ['suspended order',`UPDATE orders SET suspension='{"active":true}'`],
  ['cancelled order',"UPDATE orders SET tracking_status='cancelled'"],
  ['cancelled BC',"UPDATE orders SET erp_live=jsonb_set(erp_live,'{bc,status}','\"cancelled\"')"],
  ['cancelled BL',"UPDATE orders SET erp_live=jsonb_set(erp_live,'{bl,status}','\"cancelled\"')"],
  ['unknown BL',"UPDATE orders SET erp_live=erp_live-'bl'"],
  ['incomplete preparation',"UPDATE orders SET erp_live=jsonb_set(erp_live,'{phase}','\"bl_created\"')"],
  ['no stock proof',"UPDATE orders SET erp_live=jsonb_set(erp_live,'{bc,update_stock}','false')"],
  ['archived order',"UPDATE orders SET archived=true"],
  ['partial delivery',"UPDATE orders SET partial_mode=true"],
  ['source correction',`UPDATE orders SET source_payload='{"marketplacePendingCorrection":{}}'`],
  ['active intervention',"INSERT INTO resolution_jobs VALUES('busy','o','queued','Action',null,now(),null)"],
  ['active correction',"INSERT INTO correction_jobs VALUES('o','checking')"],
  ['other stage',"UPDATE resolution_jobs SET stage='Autre contrôle'"],
  ['unrelated error',"UPDATE resolution_jobs SET error='Stock insuffisant'"],
  ['mixed message',"UPDATE resolution_jobs SET error=error||' ; Stock insuffisant'"],
 ])await t.test(name+' cannot close the review',()=>check({complete:false,sql}));
});
