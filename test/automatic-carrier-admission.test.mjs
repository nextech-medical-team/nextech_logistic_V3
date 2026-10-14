import {currentMappingFingerprint} from '../src/current-mapping-line.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {queueCarrierLabels,initializeCarrierJobs,createCarrierWorkers} from '../src/carrier-jobs.mjs';
import {admitPreparedCarrierLabels,reconcileAutomaticTest} from '../src/automatic-test.mjs';
import {shipmentFingerprint} from '../src/label-stock-gate.mjs';
import {currentHoldDiagnostic} from '../src/preparation-recheck-policy.mjs';

async function fixture(){
 const engine=new PGlite();await engine.waitReady;
 const db={query:(...a)=>engine.query(...a),exec:s=>engine.exec(s),transaction:fn=>engine.transaction(tx=>fn({query:(...a)=>tx.query(...a),exec:s=>tx.exec(s)})),close:()=>engine.close(),recoverInterrupted:false};
 await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,reference text,channel text DEFAULT 'shopify',label_status text DEFAULT 'simulated',carrier text DEFAULT 'gls',address jsonb DEFAULT '{"name":"Test","street":"1 rue Test","city":"Paris","postal":"75001","country":"FR"}',source_payload jsonb DEFAULT '{}',erp_live jsonb DEFAULT '{}',weight_kg numeric DEFAULT 1,parcel_count int DEFAULT 1,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,resolution_pending_resume boolean DEFAULT true,duplicate_of text,issue text,tracking_status text DEFAULT 'not_shipped',suspension jsonb DEFAULT '{}');
 CREATE TABLE settings(key text PRIMARY KEY,value jsonb);CREATE TABLE audit(user_email text,action text,detail jsonb);
 CREATE TABLE mappings(channel text,source_sku text,target_sku text,source_qty numeric,target_qty numeric);
 CREATE TABLE lines(id text PRIMARY KEY,order_id text,source_line text,source_sku text,target_sku text,quantity numeric,target_quantity numeric,source_payload jsonb DEFAULT '{}');
 CREATE TABLE erp_live_jobs(order_id text PRIMARY KEY,status text,error text);
 CREATE TABLE resolution_jobs(id text PRIMARY KEY,order_id text,action text,status text,error text,result jsonb,created_at timestamptz DEFAULT now());
 CREATE TABLE correction_jobs(id text,order_id text,status text);
 CREATE TABLE extra_parcels(id text,order_id text,status text);CREATE TABLE partial_deliveries(id text,order_id text,status text);
 CREATE TABLE order_recheck_monitor(order_id text PRIMARY KEY,state jsonb DEFAULT '{}',next_check timestamptz DEFAULT now(),requested bigint DEFAULT 1);`);
 await initializeCarrierJobs(db);return db;
}
async function order(db,id,carrier='gls',channel='shopify'){
 await db.query('INSERT INTO orders(id,reference,carrier,channel) VALUES($1,$1,$2,$3)',[id,carrier,channel]);
 await db.query("INSERT INTO lines VALUES($1,$2,'1','SKU','SKU',1,1)",[id+'-line',id]);
 const o=(await db.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0];
 await db.query('UPDATE orders SET erp_live=$2 WHERE id=$1',[id,JSON.stringify({phase:'bl_ready',bc:{id:'bc-'+id,status:'active'},bl:{id:'bl-'+id,status:'ready_to_ship'},verifiedAt:new Date().toISOString(),stockCheckedAt:new Date().toISOString(),mappingPreparationFingerprint:await currentMappingFingerprint(db,o),labelPreparationFingerprint:await shipmentFingerprint(db,o)})]);
 await db.query("INSERT INTO erp_live_jobs VALUES($1,'complete',null)",[id]);
 await db.query("INSERT INTO resolution_jobs(id,order_id,action,status,result) VALUES($1,$2,'refresh','complete','{\"erpOnly\":true,\"labelRequested\":false}')",[id+'-resolution',id]);
}
const count=async(db,sql)=>Number((await db.query(sql)).rows[0].n);

test('recorded BC labels ignore missing or changed mappings at admission and again before GOFO creation',async()=>{
 const db=await fixture();try{
  for(const id of ['manual-missing','auto-changed'])await order(db,id,'gofo','amazon');
  await db.query("UPDATE orders SET erp_live=erp_live-'mappingPreparationFingerprint' WHERE id='manual-missing'");
  await db.query("INSERT INTO mappings VALUES('amazon','SKU','LATER-MAPPING',1,20)");
  const manual=(await db.query("SELECT * FROM orders WHERE id='manual-missing'")).rows[0];
  assert.equal(await queueCarrierLabels(db,['manual-missing']),1);
  assert.equal(await admitPreparedCarrierLabels(db),1);
  await db.query("UPDATE mappings SET target_sku='EVEN-LATER',target_qty=99");
  let posts=0;const clients={gofoCreate:async o=>{posts++;assert.equal(o.lines[0].target_sku,'SKU');assert.equal(Number(o.lines[0].target_quantity),1);return {reference:'ref-'+posts,tracking:['track-'+posts]};},gofoLabel:async()=>Buffer.from('%PDF-1.4 test').toString('base64')};
  const worker=createCarrierWorkers(db,null,{clients});await worker.run('gofo');await worker.run('gofo');await worker.run('gofo');
  assert.equal(posts,2);assert.equal(await count(db,"SELECT count(*) n FROM carrier_jobs WHERE status='ready'"),2);assert.equal(await count(db,'SELECT count(*) n FROM carrier_documents'),2);
  const after=(await db.query("SELECT * FROM orders WHERE id='manual-missing'")).rows[0];assert.deepEqual(after.erp_live,manual.erp_live);
  assert.equal(await queueCarrierLabels(db,['manual-missing','auto-changed']),0);
 }finally{await db.close();}
});

test('existing automatic admission resumes Boutique and Relais plus all direct carriers; repeat and restart never duplicate',async()=>{
 const db=await fixture();try{
 for(const [id,c,ch] of [['boutique','gls','shopify'],['relais','gls_shop','shopify'],['gofo','gofo','amazon'],['pharma','gls_pharma','tender']])await order(db,id,c,ch);
 assert.equal(await admitPreparedCarrierLabels(db),4);assert.equal(await admitPreparedCarrierLabels(db),0);
 const jobs=(await db.query('SELECT * FROM carrier_jobs')).rows;assert.equal(jobs.length,4);assert.ok(jobs.every(j=>j.environment==='production'&&j.creation_id));
 assert.ok((await db.query('SELECT * FROM orders')).rows.every(o=>!o.resolution_pending_resume&&o.label_status==='production_pending'));
 db.recoverInterrupted=true;await initializeCarrierJobs(db);assert.equal(await admitPreparedCarrierLabels(db),0);
 }finally{await db.close();}
});

test('manual and automatic admission share an atomic order lock and unique durable request',async()=>{
 const db=await fixture();try{await order(db,'race');const counts=await Promise.all([queueCarrierLabels(db,['race']),admitPreparedCarrierLabels(db),queueCarrierLabels(db,['race'],{automatic:true})]);assert.equal(counts.reduce((a,b)=>a+b,0),1);assert.equal(await count(db,'SELECT count(*) n FROM carrier_jobs'),1);assert.equal(await count(db,"SELECT count(*) n FROM audit WHERE action='carrier.admitted'"),1);}finally{await db.close();}
});

test('blocked variants preserve hold and evidence; one invalid order does not prevent the valid tail',async()=>{
 const db=await fixture();try{
 const scenarios={temu:"UPDATE orders SET channel='temu' WHERE id=$1",suspended:"UPDATE orders SET suspension='{\"active\":true}' WHERE id=$1",cancelled:"UPDATE orders SET tracking_status='cancelled' WHERE id=$1",partial:"UPDATE orders SET partial_mode=true WHERE id=$1",archived:"UPDATE orders SET archived=true WHERE id=$1",fingerprint:"UPDATE orders SET weight_kg=2 WHERE id=$1",erp:"UPDATE erp_live_jobs SET status='review' WHERE order_id=$1",unready:"UPDATE orders SET erp_live=jsonb_set(erp_live,'{bl,status}','\"in_preparation\"') WHERE id=$1",readOnly:"UPDATE resolution_jobs SET result='{\"erpOnly\":true,\"readOnly\":true}' WHERE order_id=$1",noResume:"UPDATE resolution_jobs SET result='{\"erpOnly\":true,\"resumeAfter\":false}' WHERE order_id=$1",uncertain:"INSERT INTO carrier_jobs(order_id,carrier,status,environment,error) VALUES($1,'gls','review','production','Création incertaine')",pdf:"INSERT INTO carrier_documents VALUES($1,0,decode('255044462d','hex'))",history:"INSERT INTO carrier_label_history VALUES('history',$1,'{\"environment\":\"production\"}',now())",extra:"INSERT INTO extra_parcels VALUES('extra',$1,'failed')",busy:"INSERT INTO correction_jobs VALUES('correction',$1,'waiting')"};
 for(const [id,sql] of Object.entries(scenarios)){await order(db,id);await db.query(sql,[id]);}
 await order(db,'zz-valid','gls_shop');assert.equal(await admitPreparedCarrierLabels(db),2);
 assert.equal(await count(db,"SELECT count(*) n FROM carrier_jobs WHERE order_id NOT IN ('uncertain','zz-valid','fingerprint')"),0);
 assert.equal(await count(db,"SELECT count(*) n FROM orders WHERE id NOT IN ('zz-valid','fingerprint') AND NOT resolution_pending_resume"),0);
 assert.equal((await db.query("SELECT status,error FROM carrier_jobs WHERE order_id='uncertain'")).rows[0].error,'Création incertaine');
 assert.equal(await count(db,'SELECT count(*) n FROM carrier_documents'),1);
 assert.equal(await count(db,"SELECT count(*) n FROM carrier_jobs WHERE order_id='fingerprint'"),1); // source fingerprint no longer blocks an existing BC
 }finally{await db.close();}
});

test('two workers claim one creation; GLS Shop resolves relay and recovers a PDF without a second POST',async()=>{
 const db=await fixture();try{await order(db,'shop','gls_shop');await admitPreparedCarrierLabels(db);let posts=0,shops=0;
 const clients={resolveParcelShop:async()=>{shops++;return {parcelShopId:'123'};},gls:async()=>{posts++;await new Promise(r=>setTimeout(r,30));return {reference:'ref',tracking:['track'],documents:[Buffer.from('%PDF-1.4 existing').toString('base64')]};}};
 const a=createCarrierWorkers(db,null,{clients}),b=createCarrierWorkers(db,null,{clients});await Promise.all([a.run('gls'),b.run('gls')]);assert.equal(posts,1);assert.equal(shops,1);assert.equal((await db.query('SELECT status FROM carrier_jobs')).rows[0].status,'ready');
 await a.run('gls');assert.equal(posts,1);assert.equal(await count(db,'SELECT count(*) n FROM carrier_documents'),1);
 }finally{await db.close();}
});

test('GOFO persisted creation resumes PDF fetch; interruption and uncertain errors never replay creation',async()=>{
 const db=await fixture();try{
 await order(db,'pdf','gofo');await admitPreparedCarrierLabels(db);
 await db.query("UPDATE carrier_jobs SET status='awaiting_pdf',attempts=1,result='{\"reference\":\"existing\",\"tracking\":[\"track\"]}',updated_at=now()-interval '1 minute' WHERE order_id='pdf'");
 let pdf=0;const clients={gofoCreate:()=>assert.fail('second POST'),gofoLabel:async()=>{pdf++;return Buffer.from('%PDF-1.4 gofo').toString('base64');}};await createCarrierWorkers(db,null,{clients}).run('gofo');assert.equal(pdf,1);
 await order(db,'interrupted');await queueCarrierLabels(db,['interrupted']);await db.query("UPDATE carrier_jobs SET status='creating' WHERE order_id='interrupted'");db.recoverInterrupted=true;await initializeCarrierJobs(db);await createCarrierWorkers(db,null,{clients:{gls:()=>assert.fail('replayed interruption')}}).run('gls');assert.equal((await db.query("SELECT status FROM carrier_jobs WHERE order_id='interrupted'")).rows[0].status,'review');
 await order(db,'timeout');await queueCarrierLabels(db,['timeout']);let posts=0;const w=createCarrierWorkers(db,null,{clients:{gls:async()=>{posts++;throw Object.assign(Error('Résultat incertain'),{uncertain:true});}}});await w.run('gls');await w.run('gls');assert.equal(posts,1);assert.equal((await db.query("SELECT status FROM carrier_jobs WHERE order_id='timeout'")).rows[0].status,'review');
 }finally{await db.close();}
});

test('automatic disabled performs no admission and precise diagnostics report the real step',async()=>{
 const db=await fixture();try{await order(db,'off');await db.query("INSERT INTO settings VALUES('automatic_live','{\"enabled\":false}')");await reconcileAutomaticTest(db);assert.equal(await count(db,'SELECT count(*) n FROM carrier_jobs'),0);}finally{await db.close();}
 const o={channel:'shopify',resolution_pending_resume:true,erp_live:{bc:{id:'bc'},bl:{id:'bl'}}};assert.equal(currentHoldDiagnostic(o).code,'carrier_resume_hold');
 assert.match(currentHoldDiagnostic({...o,carrierAdmission:{status:'held',reason:'Empreinte modifiée'}}).label,/Empreinte modifiée/);
 for(const [status,text] of [['pending','worker'],['creating','cours'],['awaiting_pdf','PDF']])assert.match(currentHoldDiagnostic({...o,carrier_job:{status}}).label,new RegExp(text));
});
