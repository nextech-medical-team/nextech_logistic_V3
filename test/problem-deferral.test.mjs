import test from 'node:test';import assert from 'node:assert/strict';
import {initializeProblemDeferral,problemDeferralService} from '../src/problem-deferral.mjs';
import {activeProblemOrderSql,orderQuery} from '../src/order-query.mjs';
import {initializeOrderSuspension,suspensionBlock} from '../src/order-suspension.mjs';
import {pathToFileURL} from 'node:url';

test('defer/restore are persisted, audited, concurrency-safe display decisions only',async()=>{
 const {PGlite}=await (process.env.PGLITE_MODULE?import(pathToFileURL(process.env.PGLITE_MODULE).href):import('@electric-sql/pglite'));
 const engine=new PGlite();const wrap=e=>({query:(q,p=[])=>e.query(q,p),exec:q=>e.exec(q)}),db=wrap(engine);db.transaction=fn=>engine.transaction(tx=>fn(wrap(tx)));
 try{
  await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,reference text,archived boolean DEFAULT false,suspension jsonb DEFAULT '{}',erp_live jsonb DEFAULT '{}',label_status text DEFAULT 'blocked',tracking_status text DEFAULT 'not_shipped',source_payload jsonb DEFAULT '{}',resolution_pending_resume boolean DEFAULT false);
  CREATE TABLE audit(user_email text,action text,detail jsonb);
  CREATE TABLE jobs(order_id text,status text);CREATE TABLE carrier_jobs(order_id text,status text,environment text);`);
  await initializeOrderSuspension(db);await initializeProblemDeferral(db);await initializeProblemDeferral(db);
  const initial={id:'one',reference:'TEST',suspension:{version:'business-version'},erp_live:{bc:{id:1,status:'active'},bl:{id:2,status:'ready_to_ship'}},source_payload:{unchanged:true}};
  await db.query('INSERT INTO orders(id,reference,suspension,erp_live,source_payload) VALUES($1,$2,$3,$4,$5)',[initial.id,initial.reference,JSON.stringify(initial.suspension),JSON.stringify(initial.erp_live),JSON.stringify(initial.source_payload)]);
  await db.exec("INSERT INTO jobs VALUES('one','processing')");
  const service=problemDeferralService(db),user={role:'operator',email:'test@example.test'};
  const input={id:'one',note:'Attente de réponse fournisseur',expectedVersion:''};
  await assert.rejects(()=>service.defer(input,{role:'viewer'}),/Droits/);
  for(const note of ['', ' ', 'x'.repeat(2001)])await assert.rejects(()=>service.defer({...input,note},user),/note/);
  await service.defer(input,user);let ctx=await service.context('one');assert.equal(ctx.state.active,true);assert.equal(ctx.history.length,1);assert.equal(ctx.history[0].action,'problem_deferred');
  await db.query("UPDATE jobs SET status='processing' WHERE order_id='one'");
  assert.equal(ctx.order.suspension.version,'business-version');assert.equal(suspensionBlock(ctx.order),null);
  assert.deepEqual((await db.query('SELECT erp_live,source_payload,resolution_pending_resume FROM orders')).rows[0],{erp_live:initial.erp_live,source_payload:initial.source_payload,resolution_pending_resume:false});
  assert.equal((await db.query('SELECT status FROM jobs')).rows[0].status,'processing');
  assert.equal((await db.query('SELECT count(*)::int n FROM orders WHERE '+activeProblemOrderSql)).rows[0].n,0);
  const deferred=orderQuery(new URLSearchParams('status=__deferred'));assert.equal((await db.query('SELECT id FROM orders '+deferred.where,deferred.args)).rows[0].id,'one');
  await assert.rejects(()=>service.restore({...input,note:'Reprendre'},user),/changé/);
  await assert.rejects(()=>service.defer({...input,expectedVersion:ctx.state.version},user),/déjà/);
  // Updating the independent suspension during a report must remain preserved.
  await db.query("UPDATE orders SET suspension=suspension || '{\"active\":true,\"note\":\"Suspendue\",\"version\":\"new-business-version\"}'::jsonb WHERE id='one'");
  await service.restore({...input,note:'Réponse reçue',expectedVersion:ctx.state.version},user);ctx=await service.context('one');assert.equal(ctx.state.active,false);assert.equal(ctx.order.suspension.active,true);assert.equal(ctx.order.suspension.version,'new-business-version');assert.equal(ctx.history.length,2);assert.equal((await db.query('SELECT status FROM jobs')).rows[0].status,'processing');
  const suspended=orderQuery(new URLSearchParams('status=__suspended'));assert.equal((await db.query('SELECT id FROM orders '+suspended.where,suspended.args)).rows[0].id,'one');
  await db.query("UPDATE orders SET suspension=suspension-'active' WHERE id='one'");assert.equal((await db.query('SELECT count(*)::int n FROM orders WHERE '+activeProblemOrderSql)).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int n FROM audit')).rows[0].n,2);
 }finally{await engine.close();}
});
