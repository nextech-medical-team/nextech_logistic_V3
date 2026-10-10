import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db.mjs';
import {chosenRoute,defaultRouting} from '../src/routing.mjs';
import {assertDirectCarrierAllowed} from '../src/temu-label-policy.mjs';
import {assertManualLabelOrder,assertTemuManualLabel} from '../src/manual-label-policy.mjs';
import {regenerateProductionLabels} from '../src/label-regeneration.mjs';
import {shipmentFingerprint} from '../src/label-stock-gate.mjs';
import {reconcileTemuRouting} from '../src/temu-routing-reconciliation.mjs';
import {currentProblemClassifier} from '../src/problem-typology-reader.mjs';
import {processingView} from '../src/order-priority.mjs';
const order=(choice,country='FR')=>({channel:'temu',transport_choice:choice,address:{country},erp_live:{},source_payload:{}});
test('TEMU stays automatic; only an explicit valid manual choice routes to a partner',()=>{
 for(const country of ['FR','CZ','DE','IT','ES','PL']){
  assert.equal(chosenRoute(order(null,country),1).carrier,'temu');
  assert.equal(chosenRoute(order('gls',country),1).carrier,'gls');
  assert.throws(()=>assertDirectCarrierAllowed(order(null,country),'gls'),/explicitement/);
  assert.doesNotThrow(()=>assertManualLabelOrder(order(null,country),'gls',{manualChoice:true}));
  assert.doesNotThrow(()=>assertDirectCarrierAllowed(order('gls',country),'gls'));
  assert.throws(()=>assertDirectCarrierAllowed(order('gls',country),'gofo'));
 }
 assert.equal(chosenRoute(order('gofo'),1).carrier,'gofo');
 assert.throws(()=>chosenRoute(order('gofo','CZ'),1),/France/);
 assert.throws(()=>assertDirectCarrierAllowed(order('gofo','CZ'),'gofo'),/France/);
 assert.throws(()=>chosenRoute(order('invalid'),1),/non autorisé/);
 assert.throws(()=>chosenRoute(order('gls'),0),/Poids/);
 assert.equal(chosenRoute(order(null),0).weight,0.25);
 assert.equal(defaultRouting.rules.find(r=>r.channel==='temu').fixed,'temu');
});
test('manual choice retains suspension, cancellation, shipment and uncertain purchase protection',()=>{
 for(const status of ['purchasing','uncertain','cancelled','cancellation_requested','not_to_ship'])assert.throws(()=>assertTemuManualLabel({status}));
 for(const status of ['shipment_error','ready','complete'])assert.doesNotThrow(()=>assertTemuManualLabel({status}));
 for(const extra of [{archived:true},{tracking_status:'delivered'},{tracking_status:'in_transit'},{partial_mode:true},{suspension:{active:true}}])assert.throws(()=>assertManualLabelOrder({...order('gls'),...extra},'gls'));
});
test('manual production queue preserves TEMU package, PDF and tracking; no-choice and uncertain requests cannot queue',async()=>{
 const db=await openDatabase();try{
 // Only disposable in-memory state. No credentials, provider, or network operation.
 await db.exec(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS erp_live jsonb DEFAULT '{}'; ALTER TABLE orders ADD COLUMN IF NOT EXISTS transport_choice text; ALTER TABLE orders ADD COLUMN IF NOT EXISTS suspension jsonb DEFAULT '{}';
 CREATE TABLE IF NOT EXISTS temu_label_jobs(reference text PRIMARY KEY,status text,packages jsonb,attempt_id text);
 CREATE TABLE IF NOT EXISTS temu_label_documents(reference text,package text,pdf bytea);
 CREATE TABLE IF NOT EXISTS carrier_jobs(order_id text PRIMARY KEY,carrier text,status text DEFAULT 'pending',environment text,result jsonb,tracking jsonb DEFAULT '[]',batch_id text,creation_id text,stock_override jsonb,reference text,attempts int DEFAULT 0,error text,updated_at timestamptz DEFAULT now());
 CREATE TABLE IF NOT EXISTS carrier_documents(order_id text,document_index int,pdf bytea);
 CREATE TABLE IF NOT EXISTS carrier_label_history(id text,order_id text,job jsonb);
 CREATE TABLE IF NOT EXISTS carrier_label_history_documents(history_id text,document_index int,pdf bytea);
 CREATE TABLE IF NOT EXISTS erp_live_jobs(order_id text,status text);
 CREATE TABLE IF NOT EXISTS resolution_jobs(id text,order_id text,status text);
 CREATE TABLE IF NOT EXISTS correction_jobs(order_id text,status text);
 CREATE TABLE IF NOT EXISTS extra_parcels(order_id text);
 CREATE TABLE IF NOT EXISTS partial_deliveries(order_id text);`);
 const beforePdf=Buffer.from('existing PDF, never modified');
 for(const [id,choice,status] of [['manual','gls','shipment_error'],['automatic',null,'shipment_error'],['uncertain','gls','uncertain']]){
  const o={...order(choice),id,reference:'CASE-'+id,recipient:'Test',weight_kg:0.02,parcel_count:1,carrier:choice||'temu',address:{name:'Test',street:'1 Rue Test',postal:'75001',city:'Paris',country:'FR'},erp_live:{bc:{status:'active'},bl:{id:'bl-'+id,status:'ready_to_ship'},verifiedAt:'2026-10-11',stockCheckedAt:'2026-10-11'}};
  await db.query('INSERT INTO orders(id,channel,reference,recipient,address,erp_live,carrier,weight_kg,parcel_count,transport_choice) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,'temu',o.reference,'Test',JSON.stringify(o.address),JSON.stringify(o.erp_live),o.carrier,.02,1,choice]);
  o.erp_live.labelPreparationFingerprint=await shipmentFingerprint(db,(await db.query('SELECT * FROM orders WHERE id=$1',[id])).rows[0]);
  await db.query('UPDATE orders SET erp_live=$2 WHERE id=$1',[id,JSON.stringify(o.erp_live)]);
  await db.query('INSERT INTO erp_live_jobs VALUES($1,$2)',[id,'complete']);
  await db.query('INSERT INTO temu_label_jobs VALUES($1,$2,$3,$4)',[o.reference,status,JSON.stringify(['existing-package']),'original-attempt']);
  await db.query('INSERT INTO temu_label_documents VALUES($1,$2,$3)',[o.reference,'existing-package',beforePdf]);
 }
 const before=(await db.query('SELECT * FROM temu_label_jobs ORDER BY reference')).rows;
 const documents=(await db.query('SELECT * FROM temu_label_documents ORDER BY reference')).rows;
 const r=await regenerateProductionLabels(db,{ids:['manual','automatic','uncertain']});
 assert.equal(r.queued,1,JSON.stringify(r));assert.equal(r.skipped.length,2);
 assert.equal((await db.query('SELECT * FROM carrier_jobs')).rows[0].order_id,'manual');
 assert.deepEqual((await db.query('SELECT * FROM temu_label_jobs ORDER BY reference')).rows,before);
 assert.deepEqual((await db.query('SELECT * FROM temu_label_documents ORDER BY reference')).rows,documents);
 // A routing reconciliation must leave the explicitly chosen partner unchanged.
 await reconcileTemuRouting(db,{apply:true,backup:async()=>{}});
 assert.equal((await db.query("SELECT transport_choice,carrier FROM orders WHERE id='manual'")).rows[0].transport_choice,'gls');
 }finally{await db.close();}
});

test('manual choice suppresses historical TEMU refusal but keeps uncertain purchase visible',()=>{
 const classify=currentProblemClassifier(),error='TEMU · Étiquette refusée : The shipping address contains non-English characters.';
 const o={...order(null),carrier:'temu',temu_job:{status:'shipment_error',error}};
 assert.ok(classify(o).some(p=>p.provider==='TEMU'));
 assert.equal(classify({...o,transport_choice:'gls',carrier:'gls'}).length,0);
 assert.ok(classify({...o,transport_choice:'gls',temu_job:{status:'uncertain',error}}).length);
 const p={id:'test',temu_status:'shipment_error',temu_error:error};
 assert.ok(processingView(p).activities.some(a=>a.service==='TEMU'));
 assert.ok(!processingView({...p,transport_choice:'gls'}).activities.some(a=>a.service==='TEMU'));
 assert.ok(processingView({...p,transport_choice:'gls',temu_status:'uncertain'}).activities.some(a=>a.service==='TEMU'));
});
