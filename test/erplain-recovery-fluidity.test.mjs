import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {resumeTransientErplain} from '../src/erplain-transient-recovery.mjs';

const error='Erplain HTTP 429 · attente du quota partagé différée, aucune requête envoyée';
test('existing Amazon draft resumes without missing-document transport or ledger guards',async t=>{
 const {engine,db,api}=await fixture(t,1);
 await engine.query("UPDATE orders SET channel='amazon'");
 await engine.query('UPDATE orders SET erp_live=$1',[JSON.stringify({phase:'publishing_bl',bcReservationPolicy:'erplain_bc_bl',bc:{id:123,status:'active',update_stock:true},bl:{id:456,label:'SHO00745115',status:'unpublished',update_stock:true}})]);
 await engine.query('UPDATE erp_live_jobs SET error=$1',['BL Erplain · Publication à vérifier']);
 let reads=0;api.request=async q=>{reads++;if(q.includes('V3TransientBL'))return {Order:{id:123,status:'active',update_stock:true,shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}}};
 assert.match(q,/^query V3TransientSavedDraft/);return {ShippingOrder:{id:456,label:'SHO00745115',status:'unpublished',update_stock:true,orders:{data:[{id:123}],paginatorInfo:{hasMorePages:false}}}};};
 assert.equal(await resumeTransientErplain(db,api),1);assert.equal(reads,2);
 assert.equal((await engine.query('SELECT erp_live FROM orders')).rows[0].erp_live.phase,'bl_created');
});
for(const channel of ['amazon','temu','shopify'])for(const scenario of ['absent','movement','concurrent-suspension','concurrent-label'])test(channel+' missing draft recovery: '+scenario,async t=>{
 const {engine,db,api}=await fixture(t,1);
 await engine.query('UPDATE orders SET channel=$1',[channel]);
 await engine.exec(`ALTER TABLE resolution_jobs ADD COLUMN id text;
 CREATE TABLE carrier_jobs(order_id text);CREATE TABLE carrier_documents(order_id text);CREATE TABLE partial_deliveries(order_id text);CREATE TABLE audit(user_email text,action text,detail jsonb);`);
 const before={phase:'publishing_bl',bcReservationPolicy:'erplain_bc_bl',bc:{id:123,status:'active',update_stock:true},bl:{id:456,label:'SHO00745115',status:'unpublished',update_stock:true}};
 await engine.query('UPDATE orders SET erp_live=$1',[JSON.stringify(before)]);
 await engine.query('UPDATE erp_live_jobs SET error=$1',['BL Erplain · Publication à vérifier']);
 let mutations=0;
 api.request=async q=>{
  if(!q.startsWith('query ')){mutations++;assert.fail('read-only reconciliation');}
  if(q.includes('V3TransientBL'))return {Order:{id:123,status:'active',update_stock:true,shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}}};
  if(q.includes('V3TransientSavedDraft'))return {ShippingOrder:null};
  if(q.includes('V3MissingDraftRead'))return {Order:{id:123,created_at:'2026-10-15 08:00:00',status:'active',update_stock:true,line_items:[{type:'normal',variant:{id:1}}],shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}},ShippingOrder:null};
  if(q.includes('V3MissingNativeDraftLedger'))return {InventoryLogs:{data:scenario==='movement'?[{id:9,document_id:456,order_type:'ShippingOrder'}]:[],paginatorInfo:{hasMorePages:false}}};
  if(q.includes('V3MissingDraftStock'))return {StockRemovals:{data:[],paginatorInfo:{hasMorePages:false}}};
  if(q.includes('V3MissingDraftLabel')){
   if(scenario==='concurrent-suspension')await engine.query(`UPDATE orders SET suspension='{"active":true}'`);
   if(scenario==='concurrent-label')await engine.query("INSERT INTO carrier_jobs VALUES('0')");
   return {ShippingOrders:{data:[{id:789,label:'SHO00745115',status:'ready_to_ship',orders:{data:[{id:999}],paginatorInfo:{hasMorePages:false}}}],paginatorInfo:{hasMorePages:false}}};
  }
  assert.fail(q);
 };
 if(scenario==='concurrent-label')await assert.rejects(resumeTransientErplain(db,api),/document transport/);
 else assert.equal(await resumeTransientErplain(db,api),scenario==='absent'?1:0);
 const after=(await engine.query('SELECT erp_live FROM orders')).rows[0].erp_live;
 assert.equal(mutations,0);
 if(scenario==='absent'){
  assert.equal(after.phase,'bc_created');assert.equal(after.bl,undefined);assert.deepEqual(after.bc,before.bc);
  assert.deepEqual(after.missingDraftRecoveries[0].retiredDraft,before.bl);
  assert.equal(after.missingDraftRecoveries[0].labelMatches[0].id,789);
  assert.equal((await engine.query('SELECT action FROM audit')).rows[0].action,'erplain.missing_draft_retired');
  assert.equal((await engine.query('SELECT status FROM erp_live_jobs')).rows[0].status,'pending');
 }else{assert.deepEqual(after.bl,before.bl);assert.equal((await engine.query('SELECT * FROM audit')).rows.length,0);}
});
async function fixture(t,n=2){
 const engine=new PGlite();await engine.waitReady;t.after(()=>engine.close());
 await engine.exec(`CREATE TABLE orders(id text PRIMARY KEY,channel text DEFAULT 'amazon',source_payload jsonb DEFAULT '{}',label_status text DEFAULT 'pending',tracking_status text DEFAULT 'not_shipped',issue text,erp_live jsonb NOT NULL,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,resolution_pending_resume boolean DEFAULT false,suspension jsonb DEFAULT '{}');
 CREATE TABLE erp_live_jobs(order_id text PRIMARY KEY,status text DEFAULT 'review',error text,updated_at timestamptz DEFAULT now()-interval '1 hour');
 CREATE TABLE resolution_jobs(order_id text,status text);CREATE TABLE correction_jobs(order_id text,status text);`);
 for(let i=0;i<n;i++){
  await engine.query('INSERT INTO orders(id,erp_live) VALUES($1,$2)',[String(i),JSON.stringify({transientRecovery:{attempts:0,lastError:error,readRateLimited:true}})]);
  await engine.query('INSERT INTO erp_live_jobs(order_id,error) VALUES($1,$2)',[String(i),error]);
 }
 let inTransaction=false;
 const db={query:(...args)=>engine.query(...args),transaction:fn=>engine.transaction(async tx=>{inTransaction=true;try{return await fn(tx);}finally{inTransaction=false;}})};
 const api={request:async q=>{assert.equal(inTransaction,false,'API/quota wait must not retain a transaction');assert.match(q,/^query /);return {Company:{id:100174}};}};
 return {engine,db,api};
}
test('recovery reads outside transactions and shares one identity request for ten orders',async t=>{
 const {engine,db,api}=await fixture(t,12);let reads=0;const request=api.request;api.request=async q=>{reads++;return request(q);};
 // PostgreSQL timestamps retain microseconds; JavaScript Date retains only
 // milliseconds. The optimistic job version must preserve the exact value.
 await engine.query("UPDATE erp_live_jobs SET updated_at='2020-01-01T00:00:00.123456Z'");
 assert.equal(await resumeTransientErplain(db,api),10);assert.equal(reads,1);
 assert.equal((await engine.query("SELECT count(*)::int n FROM erp_live_jobs WHERE status='pending'")).rows[0].n,10);
});
test('one quota refusal stops the pass without consuming mutation retries',async t=>{
 const {engine,db,api}=await fixture(t);let reads=0;
 api.request=async()=>{reads++;throw Object.assign(Error(error),{httpStatus:429,erplainReadOnly:true,retryAfter:60});};
 assert.equal(await resumeTransientErplain(db,api),0);assert.equal(reads,1);
 const rows=(await engine.query('SELECT erp_live FROM orders ORDER BY id')).rows;
 assert.equal(rows[0].erp_live.transientRecovery.attempts,0);assert.ok(rows[0].erp_live.transientRecovery.nextReadCheckAt);
 assert.equal(rows[1].erp_live.transientRecovery.checkedAt,undefined);
});
test('suspension and document edits during the network read cannot be overwritten',async t=>{
 const {engine,db,api}=await fixture(t);
 api.request=async()=>{
  await engine.query(`UPDATE orders SET suspension='{"active":true,"note":"stop"}' WHERE id='0'`);
  await engine.query(`UPDATE orders SET erp_live=erp_live||'{"bc":{"id":123,"status":"active"}}' WHERE id='1'`);
  return {Company:{id:100174}};
 };
 assert.equal(await resumeTransientErplain(db,api),0);
 const rows=(await engine.query('SELECT * FROM orders ORDER BY id')).rows;
 assert.equal(rows[0].suspension.active,true);assert.equal(rows[1].erp_live.bc.id,123);
 assert.equal((await engine.query("SELECT count(*)::int n FROM erp_live_jobs WHERE status='review'")).rows[0].n,2);
});
test('new active resolution or job replacement prevents stale recovery commit',async t=>{
 const {engine,db,api}=await fixture(t);
 api.request=async()=>{
  await engine.query("INSERT INTO resolution_jobs VALUES('0','queued')");
  await engine.query("UPDATE erp_live_jobs SET status='complete',updated_at=now() WHERE order_id='1'");
  return {Company:{id:100174}};
 };
 assert.equal(await resumeTransientErplain(db,api),0);
 assert.deepEqual((await engine.query('SELECT status FROM erp_live_jobs ORDER BY order_id')).rows.map(x=>x.status),['review','complete']);
});
test('interrupted publication resumes automatically after a read-only reconciliation',async t=>{
 const {engine,db,api}=await fixture(t,1);
 await engine.query('UPDATE orders SET erp_live=$1',[JSON.stringify({phase:'publishing_bl',bc:{id:123},bl:{id:456,status:'unpublished',update_stock:true}})]);
 await engine.query('UPDATE erp_live_jobs SET error=$1',['BL Erplain · Publication à vérifier : contrôler le BL et son mouvement de stock avant reprise']);
 api.request=async q=>{assert.match(q,/^query V3TransientBL/);return {Order:{id:123,status:'active',update_stock:true,shipping_orders:{data:[{id:456,label:'BL123',status:'pending',update_stock:true}],paginatorInfo:{hasMorePages:false}}}};};
 assert.equal(await resumeTransientErplain(db,api),1);
 const state=(await engine.query('SELECT erp_live FROM orders')).rows[0].erp_live;
 assert.equal(state.phase,'bl_created');assert.equal(state.bl.status,'pending');
 assert.equal((await engine.query('SELECT status FROM erp_live_jobs')).rows[0].status,'pending');
});
test('existing BC/BL read is reconciled without provider mutation',async t=>{
 const {engine,db,api}=await fixture(t,1);
 await engine.query(`UPDATE orders SET erp_live=erp_live||'{"phase":"bl_created","bc":{"id":123,"status":"active"},"bl":{"id":456,"status":"pending"}}'`);
 api.request=async q=>{assert.match(q,/^query V3TransientBL/);return {Order:{id:123,status:'active',shipping_orders:{data:[{id:456,status:'pending'}],paginatorInfo:{hasMorePages:false}}}};};
 assert.equal(await resumeTransientErplain(db,api),1);
 assert.equal((await engine.query('SELECT erp_live FROM orders')).rows[0].erp_live.bl.id,456);
});

test('tender transient recovery preserves installed publication phase',async t=>{
 const {engine,db,api}=await fixture(t,1);
 await engine.query("UPDATE orders SET channel='tender'");
 await engine.query('UPDATE orders SET erp_live=$1',[JSON.stringify({phase:'publishing_bl',bc:{id:123},bl:{id:456,status:'unpublished'},transientRecovery:{lastError:error,readRateLimited:true}})]);
 api.request=async q=>{assert.match(q,/^query /);return {Order:{id:123,status:'active',shipping_orders:{data:[{id:456,status:'pending'}],paginatorInfo:{hasMorePages:false}}}};};
 assert.equal(await resumeTransientErplain(db,api),1);
 const s=(await engine.query('SELECT erp_live FROM orders')).rows[0].erp_live;
 assert.equal(s.phase,'publishing_bl');assert.equal(s.publicationReconciledAt,undefined);
});

for(const mode of ['found','absent','ambiguous','incomplete','cancelled','race'])test('persisted creating_customer 429 selects read-only reconciliation: '+mode,async t=>{
 const {engine,db,api}=await fixture(t,1);const state={phase:'creating_customer',customerNumber:'V3:0',transientRecovery:{lastError:'Erplain HTTP 429',attempts:0,providerRateLimited:true}};
 await engine.query('UPDATE orders SET erp_live=$1',[JSON.stringify(state)]);await engine.query("UPDATE erp_live_jobs SET error='Erplain HTTP 429'");if(mode==='cancelled')await engine.exec("UPDATE orders SET tracking_status='cancelled'");
 let calls=0;api.request=async(q,v)=>{calls++;assert.match(q,/^query V3RecoverQuotaCustomer/);assert.equal(v.where.value,'V3:0');if(mode==='race')await engine.exec(`UPDATE orders SET suspension='{"active":true}'`);return {Customers:{data:mode==='absent'?[]:mode==='ambiguous'?[{id:7,customer_number:'V3:0'},{id:8,customer_number:'V3:0'}]:[{id:7,customer_number:'V3:0'}],paginatorInfo:{hasMorePages:mode==='incomplete'}}};};
 const n=await resumeTransientErplain(db,api);assert.equal(n,mode==='found'?1:0);assert.equal(calls,mode==='cancelled'?0:1);
 const saved=(await engine.query('SELECT erp_live FROM orders')).rows[0].erp_live;assert.equal(saved.customer?.id,mode==='found'?7:undefined);assert.equal(saved.phase,mode==='found'?'customer_created':'creating_customer');
 await resumeTransientErplain(db,api);assert.equal(calls,mode==='cancelled'?0:1,'no immediate retry or duplicate creation');
});
test('persisted missing draft error without transient lastError enters reconciliation',async t=>{
 const {engine,db,api}=await fixture(t,1);await engine.query('UPDATE orders SET erp_live=$1',[JSON.stringify({phase:'publishing_bl',bc:{id:123},bl:{id:456,status:'unpublished'},transientRecovery:{lastError:null,attempts:1}})]);await engine.query("UPDATE erp_live_jobs SET error='Brouillon BL introuvable dans Erplain'");let calls=0;
 api.request=async q=>{calls++;assert.match(q,/^query /);return {Order:{id:123,status:'active',update_stock:true,shipping_orders:{data:[{id:456,status:'pending',update_stock:true}],paginatorInfo:{hasMorePages:false}}}};};assert.equal(await resumeTransientErplain(db,api),1);assert.equal(calls,1);
});
test('missing saved BC searches immutable identity, never guesses from its number or recreates',async t=>{
 const {engine,db,api}=await fixture(t,1);await engine.exec("ALTER TABLE orders ADD COLUMN reference text DEFAULT 'PO-fixture'");await engine.query('UPDATE orders SET erp_live=$1',[JSON.stringify({phase:'bc_created',bc:{id:123,label:'C0016034',status:'unpublished'},transientRecovery:{lastError:null,attempts:1}})]);await engine.query("UPDATE erp_live_jobs SET error='BC/BL : rapprochement incomplet ou ambigu, contrôle nécessaire'");let calls=0;
 api.request=async(q,v)=>{calls++;assert.match(q,/^query /);if(q.includes('V3TransientBL'))return {Order:null};assert.match(q,/V3RecoverReference/);assert.equal(JSON.stringify(v).includes('C0016034'),false);return {Orders:{data:[{id:789,status:'active',external_reference:'V3:0'}],paginatorInfo:{hasMorePages:false}}};};assert.equal(await resumeTransientErplain(db,api),0);assert.equal(calls,2);
 const saved=(await engine.query('SELECT erp_live FROM orders')).rows[0].erp_live;assert.equal(saved.bc.id,123);assert.equal(saved.documentReconciliation.candidateBcId,'789');assert.match((await engine.query('SELECT error FROM erp_live_jobs')).rows[0].error,/autre identité/);await resumeTransientErplain(db,api);assert.equal(calls,2);
});
