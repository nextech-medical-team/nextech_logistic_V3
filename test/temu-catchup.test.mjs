import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readTemuSource,validateTemuSource} from '../src/temu-catchup-reader.mjs';
import {temuCatchupDelay,obsoleteTemuVisibilityError} from '../src/temu-catchup-policy.mjs';
import {temuCatchupWorker,initializeTemuCatchup,temuBlockedSql} from '../src/temu-catchup-worker.mjs';
import {reconcileTemuCatchup} from '../src/temu-catchup-reconcile.mjs';
import {temuCollector} from '../src/temu-collection.mjs';
const reference='PO-069-123456789';
function payload(){return {detail:{parentOrderMap:{parentOrderSn:reference,parentOrderTime:1700000000,updateTime:1700000100,parentOrderStatus:2,regionName1:'France'},orderList:[{orderSn:'069-1234',quantity:1,productList:[{extCode:'SKU'}],packageSnInfo:[]}]},shipping:{receiptName:'TEST',addressLine1:'1 rue Test',addressLine2:'',addressLine3:null,postCode:'75001',regionName1:'France',regionName3:'Paris'},amounts:{parentOrderMap:{parentOrderSn:reference,estimatedRevenue:{amount:100,currency:'EUR'}},orderList:[{orderSn:'069-1234',quantity:1}]}};}
function apiFor(p=payload(),errors={},calls=[]){return {read:async(type,args)=>{calls.push({type,args});if(errors[type])throw errors[type];const map={'bg.order.detail.v2.get':p.detail,'bg.order.decryptshippinginfo.get':p.shipping,'bg.order.amount.query':p.amounts,'bg.logistics.shipment.v2.get':{shipmentInfoDTO:[]},'bg.order.list.v2.get':{pageItems:[{parentOrderMap:p.detail.parentOrderMap}],totalItemNum:1}};assert.ok(Object.hasOwn(map,type),'read-only endpoint '+type);return structuredClone(map[type]);}};}
test('backoff continues hourly and respects longer provider cooldown',()=>{assert.deepEqual([1,2,3,4,5,9].map(temuCatchupDelay),[120000,300000,900000,1800000,3600000,3600000]);assert.equal(temuCatchupDelay(1,7200000),7200000);assert.throws(()=>temuCatchupDelay(0));assert.equal(obsoleteTemuVisibilityError('TEMU refuse l’opération : 180020006 The current order status cannot be viewed.'),true);assert.equal(obsoleteTemuVisibilityError('Stock insuffisant ; TEMU refuse l’opération : 180020006 The current order status cannot be viewed.'),false);});
test('first read validates country/identity/quantities/revenue and retains independent successes',async()=>{
 const calls=[],r=await readTemuSource(apiFor(payload(),{},calls),reference);assert.equal(r.complete,true);assert.equal(r.coreComplete,true);assert.equal(r.payload.country,'FR');assert.equal(calls.filter(x=>x.type==='bg.order.detail.v2.get').length,2);
 const error=Error('TEMU refuse l’opération : 180020006 The current order status cannot be viewed.');
 const partial=await readTemuSource(apiFor(payload(),{'bg.order.decryptshippinginfo.get':error}),reference);assert.equal(partial.coreComplete,false);assert.deepEqual(partial.payload.amounts,payload().amounts);assert.equal(partial.errors[0].field,'shipping');assert.equal(partial.errors[0].code,'180020006');
 for(const mutate of [p=>p.shipping.regionName1='Belgium',p=>p.amounts.parentOrderMap.parentOrderSn='OTHER',p=>p.amounts.orderList=[],p=>p.detail.orderList.push(p.detail.orderList[0]),p=>delete p.amounts.parentOrderMap.estimatedRevenue]){const p=payload();mutate(p);assert.throws(()=>validateTemuSource(p,reference));}
});
test('changed bookend, stop and failed logistics never become a complete successful read',async()=>{
 const base=apiFor(),api={read:async(t,a)=>{const r=await base.read(t,a);if(t==='bg.order.detail.v2.get'&&++api.n===2)r.parentOrderMap.parentOrderStatus=4;return r;},n:0};assert.equal((await readTemuSource(api,reference)).coreComplete,false);
 await assert.rejects(readTemuSource(base,reference,{shouldStop:()=>true}),/Arrêt/);
 const p=await readTemuSource(apiFor(payload(),{'bg.logistics.shipment.v2.get':Error('TEMU HTTP 429')}),reference);assert.equal(p.complete,false);assert.equal(p.coreComplete,true);assert.equal(p.coverage.shipments,false);
});
test('collector retains failed fields, uses destination country and stable receipt identity',async()=>{
 const p=payload(),collector=temuCollector(apiFor(p),{mallId:'M',country:'BE'}),options={since:'2023-01-01',until:'2026-01-01'};
 const a=await collector.page(options),b=await collector.page(options);assert.equal(a.items[0].payload.country,'FR');assert.equal(a.items[0].payload.sourceCoverage.complete,true);assert.equal(a.items[0].deliveryId,b.items[0].deliveryId);
 const broken=temuCollector(apiFor(p,{'bg.order.amount.query':Error('TEMU refusal 3000032')}),{mallId:'M',country:'FR'});const r=await broken.page(options);assert.match(r.items[0].deliveryId,/^incomplete:/);assert.ok(r.items[0].payload.shipping.receiptName);assert.equal(r.items[0].payload.sourceCoverage.coreComplete,false);
});
async function fixture(){
 const e=new PGlite();await e.waitReady;const db={query:(s,a)=>e.query(s,a),exec:s=>e.exec(s),transaction:fn=>e.transaction(t=>fn({query:(s,a)=>t.query(s,a)})),close:()=>e.close()};
 await db.exec(`CREATE TABLE settings(key text PRIMARY KEY,value jsonb);INSERT INTO settings VALUES('marketplace_automatic','{"enabled":true,"channels":{"temu":true}}'),('background_tasks','{}');
 CREATE TABLE orders(id text PRIMARY KEY,channel text DEFAULT 'temu',reference text,source_reference text,received_at timestamptz DEFAULT now(),recipient text DEFAULT 'TEST',address jsonb DEFAULT '{}',source_payload jsonb DEFAULT '{}',erp_live jsonb DEFAULT '{}',suspension jsonb DEFAULT '{}',issue text,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,duplicate_of text,resolution_pending_resume boolean DEFAULT false,label_status text DEFAULT 'pending',erp_status text DEFAULT 'pending',tracking_status text DEFAULT 'not_shipped');
 CREATE TABLE lines(id text PRIMARY KEY,order_id text,source_line text,source_sku text,quantity numeric,target_sku text,target_quantity numeric,source_payload jsonb DEFAULT '{}');
 CREATE TABLE carrier_documents(order_id text,pdf bytea);CREATE TABLE carrier_jobs(order_id text,status text,error text);CREATE TABLE temu_label_jobs(reference text,packages jsonb DEFAULT '[]',attempt_id text,error text,status text);
 CREATE TABLE erp_live_jobs(order_id text PRIMARY KEY,status text,error text,updated_at timestamptz DEFAULT now());CREATE TABLE marketplace_order_links(channel text,shop text,reference text,order_id text,version text,UNIQUE(channel,shop,reference));CREATE TABLE resolution_jobs(order_id text,status text,error text);CREATE TABLE correction_jobs(order_id text,status text);CREATE TABLE partial_deliveries(order_id text);CREATE TABLE extra_parcels(order_id text);
 CREATE TABLE order_recheck_monitor(order_id text PRIMARY KEY,state jsonb DEFAULT '{}',next_check timestamptz DEFAULT now(),requested bigint DEFAULT 1);CREATE TABLE audit(user_email text,action text,detail jsonb);
 INSERT INTO orders(id,reference,issue,source_payload) VALUES('A','${reference}','Stock insuffisant','{"mallId":"M"}');INSERT INTO order_recheck_monitor(order_id) VALUES('A');`);return db;
}
test('general SQL selection includes all blocker families, excludes archives and duplicates',async()=>{const db=await fixture();try{
 for(const [n,patch] of Object.entries({weight:{issue:'Poids manquant'},catalog:{issue:'SKU absent'},finance:{erp_status:'live_review'},incomplete:{source_payload:{visibilityHold:true}},resume:{resolution_pending_resume:true},cancel:{suspension:{active:true},issue:'Annulation à vérifier'}})){await db.query('INSERT INTO orders(id,reference,issue,erp_status,source_payload,resolution_pending_resume,suspension) VALUES($1,$1,$2,$3,$4,$5,$6)',[n,patch.issue||null,patch.erp_status||'pending',JSON.stringify(patch.source_payload||{}),patch.resolution_pending_resume||false,JSON.stringify(patch.suspension||{})]);}
 await db.exec("INSERT INTO orders(id,reference,issue,archived) VALUES('archive','archive','Stock',true);INSERT INTO orders(id,reference,issue,duplicate_of) VALUES('duplicate','duplicate','Stock','A');");
 assert.equal((await db.query('SELECT id FROM orders o WHERE '+temuBlockedSql)).rows.length,7);
}finally{await db.close();}});
test('SQL worker persists restart retries, wakes diagnostics, preserves independent issues and never creates business jobs',async()=>{const db=await fixture();try{
 const observation=await readTemuSource(apiFor(),reference),loader=async()=>[{channel:'temu',shop:'M',refreshSource:async()=>observation}];
 const worker=temuCatchupWorker(db,loader,{withLock:fn=>fn()});const result=await worker.run();assert.equal(result.complete,true);
 const o=(await db.query("SELECT * FROM orders WHERE id='A'")).rows[0];assert.equal(o.issue,'Stock insuffisant');assert.equal(o.source_payload.temuCatchup.complete,true);assert.equal((await db.query('SELECT * FROM lines')).rows.length,1);assert.equal((await db.query('SELECT * FROM erp_live_jobs')).rows.length,0);assert.equal((await db.query('SELECT * FROM carrier_jobs')).rows.length,0);assert.equal((await db.query('SELECT requested FROM order_recheck_monitor')).rows[0].requested,3);
 const q=(await db.query('SELECT * FROM temu_source_catchup')).rows[0];assert.equal(q.failures,0);assert.equal(q.lease_token,null);assert.ok(q.last_success_at);
 assert.equal((await temuCatchupWorker(db,loader,{withLock:fn=>fn()}).run()).idle,true);
 await db.exec("UPDATE temu_source_catchup SET next_at=now();");const broken=temuCatchupWorker(db,async()=>[{channel:'temu',shop:'M',refreshSource:async()=>{throw Error('TEMU refuse l’opération : 180020006 The current order status cannot be viewed.');}}],{withLock:fn=>fn()});assert.equal((await broken.run()).delay,120000);const failed=(await db.query('SELECT * FROM temu_source_catchup')).rows[0];assert.equal(failed.failures,1);assert.ok(failed.first_failure_at);assert.equal(failed.observation.complete,true);assert.equal((await db.query("SELECT issue FROM orders WHERE id='A'")).rows[0].issue,'Stock insuffisant');
}finally{await db.close();}});
test('prepared documents and mappings are immutable on source drift',async()=>{const db=await fixture();try{
 await db.exec("INSERT INTO carrier_documents VALUES('A',decode('25504446','hex'));INSERT INTO lines(id,order_id,source_line,source_sku,quantity,target_sku,target_quantity) VALUES('OLD','A','069-1234','OLD',2,'MAPPED',20);");
 const before=(await db.query('SELECT * FROM lines')).rows,docs=(await db.query('SELECT * FROM carrier_documents')).rows;
 const observation=await readTemuSource(apiFor(),reference),order=(await db.query('SELECT * FROM orders')).rows[0];
 const result=await db.transaction(tx=>reconcileTemuCatchup(tx,order,observation));assert.ok(result.conflicts.includes('articles/quantités'));assert.deepEqual((await db.query('SELECT * FROM lines')).rows,before);assert.deepEqual((await db.query('SELECT * FROM carrier_documents')).rows,docs);assert.equal((await db.query('SELECT * FROM orders')).rows[0].issue,'Stock insuffisant');
}finally{await db.close();}});
test('pause and a concurrent local change prevent applying a delayed response',async()=>{const db=await fixture();try{
 await db.exec("UPDATE settings SET value='{"+ '"enabled":false' +"}' WHERE key='marketplace_automatic'");let reads=0;const loader=async()=>{reads++;return [];};assert.equal((await temuCatchupWorker(db,loader,{withLock:fn=>fn()}).run()).reason,'disabled');assert.equal(reads,0);
 await db.exec("UPDATE settings SET value='{"+'"enabled":true' +"}' WHERE key='marketplace_automatic'");
 const observation=await readTemuSource(apiFor(),reference);const worker=temuCatchupWorker(db,async()=>[{channel:'temu',shop:'M',refreshSource:async()=>{await db.exec("UPDATE orders SET issue='Autre changement',source_payload=source_payload||'{\"localEdit\":true}' WHERE id='A'");return observation;}}],{withLock:fn=>fn()});assert.equal((await worker.run()).failed,true);assert.equal((await db.query('SELECT * FROM lines')).rows.length,0);assert.equal((await db.query('SELECT * FROM orders')).rows[0].issue,'Autre changement');
}finally{await db.close();}});

test('expected shipping refusal depends on verified source stage and never hides another failure',async()=>{
 for(const status of [1,2,3]){
  const p=payload();p.detail.parentOrderMap.parentOrderStatus=status;
  const error=Object.assign(Error('TEMU refuse l’opération : 180020006 The current order status cannot be viewed.'),{code:'180020006'});
  const r=await readTemuSource(apiFor(p,{'bg.order.decryptshippinginfo.get':error}),reference);
  assert.equal(r.complete,false);assert.equal(r.coreComplete,false);assert.equal(r.requiredComplete,status!==2);
  assert.equal(r.sourceStage,status===1?'pending':status===3?'cancelled':'fulfillment');
  const failed=await readTemuSource(apiFor(p,{'bg.order.decryptshippinginfo.get':error,'bg.order.amount.query':Error('Finance indisponible')}),reference);assert.equal(failed.requiredComplete,false);
 }
});
test('stage observation preserves every operational field, label and independent issue',async()=>{
 const {observeTemuSourceStage}=await import('../src/temu-catchup-reconcile.mjs');
 for(const stage of ['pending','cancelled']){
  const db=await fixture();try{
   await db.query("INSERT INTO orders(id,reference,source_reference,issue,source_payload) VALUES('STAGE',$1,$1,'Stock insuffisant',$2::jsonb)",[reference,JSON.stringify({mallId:'M',visibilityHold:true,temuShippingInfo:{receiptName:'Preserved'}})]);
   const before=(await db.query("SELECT * FROM orders WHERE id='STAGE'")).rows[0];
   const p=payload();p.detail.parentOrderMap.parentOrderStatus=stage==='pending'?1:3;
   const r=await readTemuSource(apiFor(p,{'bg.order.decryptshippinginfo.get':Object.assign(Error('refus'),{code:'180020006'})}),reference);
   await db.transaction(tx=>observeTemuSourceStage(tx,before,r));
   const after=(await db.query("SELECT * FROM orders WHERE id='STAGE'")).rows[0];
   for(const key of ['address','erp_live','label_status','tracking_status','recipient','issue'])assert.deepEqual(after[key],before[key]);
   assert.deepEqual(after.source_payload.temuShippingInfo,before.source_payload.temuShippingInfo);assert.equal(after.source_payload.visibilityHold,true);assert.equal(after.source_payload.temuCatchup.sourceStage,stage);
  }finally{await db.close();}
 }
});

test('quota deferral and relay retry are bounded; a purchase is never retried',async()=>{
 const {temuApi}=await import('../src/temu-api.mjs');
 const config={TEMU_APP_KEY:'test-'+Date.now(),TEMU_APP_SECRET:'fixture',TEMU_ACCESS_TOKEN:'fixture'};
 let reads=0;const api=temuApi(config,{relay:{purchaseEnabled:true},relayRead:async()=>{reads++;throw Error('relais (SSH 255)');}});
 await assert.rejects(api.read('bg.order.detail.v2.get',{parentOrderSn:reference}),/SSH 255/);assert.equal(reads,2);
 let purchases=0;const buy=temuApi({...config,TEMU_APP_KEY:config.TEMU_APP_KEY+'-buy'},{relay:{purchaseEnabled:true},relayRead:async()=>{purchases++;throw Error('relais (SSH 255)');}});
 await assert.rejects(buy.buy({}),/SSH 255/);assert.equal(purchases,1);
 let calls=0;const throttled=temuApi({...config,TEMU_APP_KEY:config.TEMU_APP_KEY+'-429'},{relay:null,fetchImpl:async()=>{calls++;return {ok:false,status:429,headers:{get:()=> '60'}};}});
 await assert.rejects(throttled.read('bg.order.detail.v2.get',{}),e=>e.status===429&&e.retryAfter==='60');
 await assert.rejects(throttled.read('bg.order.detail.v2.get',{}),e=>e.code==='source_budget_deferred');assert.equal(calls,1);
 await assert.rejects(api.read('bg.logistics.shipment.create',{}),/interdite/);
});
test('a newer source error and an independent issue survive old successful proof',async()=>{
 const {projectCurrentDiagnostics}=await import('../src/current-order-diagnostics.mjs');
 const error='TEMU refuse l’opération : 180020006 The current order status cannot be viewed.';
 const proof={checkedAt:'2026-10-11T10:00:00Z',complete:false,coreComplete:false,requiredComplete:true,sourceStage:'pending',stageReason:'En attente (indicatif)',currentReason:'Coordonnées en attente',conflicts:[]};
 const a={channel:'temu',issue:error,source_payload:{temuCatchup:proof}};assert.equal(projectCurrentDiagnostics(a).issue,'Coordonnées en attente');
 const b={channel:'temu',issue:error,source_payload:{temuCatchup:proof,temuDirect:{attemptedAt:'2026-10-11T11:00:00Z'}}};assert.equal(projectCurrentDiagnostics(b).issue,error);
 const c={channel:'temu',issue:'Stock insuffisant',source_payload:{temuCatchup:proof}};assert.equal(projectCurrentDiagnostics(c).issue,'Stock insuffisant');
});

test('pending-stage worker persists its age and escalates without changing business data',async()=>{
 const db=await fixture();try{
  const p=payload();p.detail.parentOrderMap.parentOrderStatus=1;
  const observation=await readTemuSource(apiFor(p,{'bg.order.decryptshippinginfo.get':Object.assign(Error('refus'),{code:'180020006'})}),reference);
  const loader=async()=>[{channel:'temu',shop:'M',refreshSource:async()=>observation}];
  const worker=temuCatchupWorker(db,loader,{withLock:fn=>fn()});
  assert.equal((await worker.run()).delay,120000);
  const first=(await db.query('SELECT * FROM temu_source_catchup')).rows[0];assert.ok(first.first_failure_at);assert.equal(first.failures,0);
  await db.exec("UPDATE temu_source_catchup SET next_at=now(),first_failure_at=now()-interval '5 hours'");
  assert.equal((await worker.run()).delay,120000);
  const monitor=(await db.query('SELECT state FROM order_recheck_monitor')).rows[0].state.temuSourceCatchup;
  assert.equal(monitor.alert,true);assert.equal(monitor.escalated,true);assert.equal(monitor.complete,false);
  assert.equal((await db.query('SELECT * FROM lines')).rows.length,0);
  assert.equal((await db.query('SELECT issue FROM orders')).rows[0].issue,'Stock insuffisant');
 }finally{await db.close();}
});

test('native list version must remain stable across all endpoint reads',async()=>{
 const base=apiFor();let lists=0;
 const changing={read:async(type,args)=>{const data=await base.read(type,args);if(type==='bg.order.list.v2.get'&&++lists===2)data.pageItems[0].parentOrderMap.updateTime++;return data;}};
 const changed=await readTemuSource(changing,reference);assert.equal(changed.coreComplete,false);assert.equal(changed.requiredComplete,false);assert.ok(changed.errors.some(e=>e.field==='version'));
 const missing=payload();delete missing.detail.parentOrderMap.updateTime;
 const unavailable=await readTemuSource(apiFor(missing),reference);assert.equal(unavailable.coreComplete,false);assert.ok(unavailable.errors.some(e=>e.field==='version'));
 const good=await readTemuSource(apiFor(),reference);assert.equal(good.sourceVersion,1700000100);assert.equal(good.payload.detail.parentOrderMap.updateTime,1700000100);
});

test('only dated older source refusals are superseded in job projections',async()=>{
 const {projectCurrentDiagnostics}=await import('../src/current-order-diagnostics.mjs');
 const error='TEMU refuse l’opération : 180020006 The current order status cannot be viewed.';
 const proof={checkedAt:'2026-10-11T10:00:00Z',complete:true,coreComplete:true,conflicts:[]};
 const o={channel:'temu',source_payload:{temuCatchup:proof},erp_live_job:{error,updated_at:'2026-10-11T09:00:00Z'},temu_job:{error,updated_at:'2026-10-11T11:00:00Z'},resolution_error:error,resolution_actions:[{error,updated_at:'2026-10-11T09:00:00Z'},{error,updated_at:'2026-10-11T11:00:00Z'},{error}]};
 const projected=projectCurrentDiagnostics(o);assert.equal(projected.erp_live_job.error,null);assert.equal(projected.temu_job.error,error);assert.equal(projected.resolution_error,error);assert.equal(projected.resolution_actions[0].error,null);assert.equal(projected.resolution_actions[1].error,error);assert.equal(projected.resolution_actions[2].error,error);
});

test('fresh source read preserves uncertain purchase metadata and clears only source incompleteness',async()=>{
 const db=await fixture();try{
  const direct={source:'external_temu',state:'uncertain',requestId:'existing-attempt',attemptedAt:'2026-10-11T09:00:00Z',error:'Résultat achat à rapprocher'};
  await db.query("UPDATE orders SET address=$1::jsonb,source_payload=source_payload||$2::jsonb WHERE id='A'",[JSON.stringify({name:'TEST',street:'1 rue Test',postal:'75001',city:'Paris',country:'FR'}),JSON.stringify({temuDirect:direct,visibilityHold:true,sourceCoverage:{complete:false}})]);
  await db.exec("INSERT INTO carrier_documents VALUES('A',decode('25504446','hex'));INSERT INTO lines(id,order_id,source_line,source_sku,quantity) VALUES('CURRENT','A','069-1234','SKU',1)");
  const observation=await readTemuSource(apiFor(),reference),order=(await db.query('SELECT * FROM orders')).rows[0];
  const documents=(await db.query('SELECT * FROM carrier_documents')).rows,lines=(await db.query('SELECT * FROM lines')).rows;
  const result=await db.transaction(tx=>reconcileTemuCatchup(tx,order,observation));assert.deepEqual(result.conflicts,[]);
  const after=(await db.query('SELECT * FROM orders')).rows[0];assert.deepEqual(after.source_payload.temuDirect,direct);assert.equal(after.source_payload.temuSourceRead.state,'verified');assert.equal(after.source_payload.sourceCoverage.complete,true);assert.equal(after.source_payload.visibilityHold,false);
  assert.deepEqual((await db.query('SELECT * FROM carrier_documents')).rows,documents);assert.deepEqual((await db.query('SELECT * FROM lines')).rows,lines);
  const error='TEMU refuse l’opération : 180020006 The current order status cannot be viewed.';
  const {projectCurrentDiagnostics}=await import('../src/current-order-diagnostics.mjs');const projected=projectCurrentDiagnostics({channel:'temu',source_payload:after.source_payload,temu_job:{error,updated_at:'2026-10-11T08:00:00Z'}});assert.equal(projected.temu_job.error,error);
 }finally{await db.close();}
});

test('terminal platform declaration never becomes a new blocker when local required data exist',async()=>{
 const {observeTemuSourceStage}=await import('../src/temu-catchup-reconcile.mjs');const db=await fixture();try{
  const p=payload();p.detail.parentOrderMap.parentOrderStatus=3;
  const observation=await readTemuSource(apiFor(p,{'bg.order.decryptshippinginfo.get':Object.assign(Error('refus'),{code:'180020006'})}),reference);
  const error='TEMU refuse l’opération : 180020006 The current order status cannot be viewed.';
  await db.query("UPDATE orders SET issue=$1,address=$2::jsonb WHERE id='A'",[error,JSON.stringify({name:'TEST',street:'1 rue Test',postal:'75001',city:'Paris',country:'FR'})]);
  await db.exec("INSERT INTO lines(id,order_id,source_line,source_sku,quantity) VALUES('L','A','069-1234','SKU',1)");
  const order=(await db.query('SELECT * FROM orders')).rows[0];await db.transaction(tx=>observeTemuSourceStage(tx,order,observation));
  const after=(await db.query('SELECT * FROM orders')).rows[0];assert.equal(after.issue,null);assert.equal(after.source_payload.temuCatchup.currentReason,null);assert.match(after.source_payload.temuCatchup.stageReason,/indicative/);assert.deepEqual(after.address,order.address);assert.equal(after.label_status,order.label_status);
 }finally{await db.close();}
});
test('initial partial read keeps proven destination and never substitutes mall country',async()=>{
 const p=payload(),collector=temuCollector(apiFor(p,{'bg.order.amount.query':Error('finance')}),{mallId:'M',country:'BE'});
 const result=await collector.page({since:'2023-01-01',until:'2026-01-01'});assert.equal(result.items[0].payload.country,'FR');assert.equal(result.items[0].payload.sourceCoverage.complete,false);
});

test('known partial receipt schedules safe catch-up without replacing current business state',async()=>{
 const {applyMarketplaceReceipt}=await import('../src/marketplace-inbox.mjs');const db=await fixture();try{
  await initializeTemuCatchup(db);await db.exec("UPDATE settings SET value=value||'{\"since\":\"2023-01-01\"}' WHERE key='marketplace_automatic'");
  const before=(await db.query('SELECT * FROM orders')).rows[0],p=payload();
  const r={channel:'temu',shop:'M',payload:{detail:p.detail,shipping:{},country:'FR',visibilityError:'Coordonnées indisponibles',sourceCoverage:{complete:false,coreComplete:false,errors:[{field:'shipping',code:'180020006'}]}}};
  const result=await applyMarketplaceReceipt(db,r);assert.equal(result.sourceCatchupQueued,true);
  const after=(await db.query('SELECT * FROM orders')).rows[0];for(const key of ['issue','address','label_status','erp_status','resolution_pending_resume'])assert.deepEqual(after[key],before[key]);
  assert.ok(after.source_payload.temuReceiptObservation);assert.equal((await db.query('SELECT count(*)::int n FROM temu_source_catchup')).rows[0].n,1);assert.equal((await db.query('SELECT count(*)::int n FROM erp_live_jobs')).rows[0].n,0);
 }finally{await db.close();}
});


test('complete initial recovery queues existing preparation only within authorized reception window',async()=>{
 for(const scenario of ['allowed','paused','before-start','independent-issue','uncertain-purchase','correction-history']){
  const db=await fixture();try{
   const p=payload();p.detail.parentOrderMap.parentOrderTime=Math.floor(Date.now()/1000)-60;p.detail.parentOrderMap.updateTime=p.detail.parentOrderMap.parentOrderTime+1;
   const source={mallId:'M',sourceShop:'M',visibilityHold:true};if(scenario==='uncertain-purchase')source.temuDirect={attemptedAt:new Date().toISOString()};
   await db.query("UPDATE orders SET issue=$1,source_payload=$2::jsonb,resolution_pending_resume=true WHERE id='A'",[scenario==='independent-issue'?'Stock insuffisant':'TEMU refuse l’opération : 180020006 The current order status cannot be viewed.',JSON.stringify(source)]);
   await db.query("INSERT INTO settings VALUES('automatic_live',$1::jsonb)",[JSON.stringify({enabled:scenario!=='paused'})]);
   await db.query("UPDATE settings SET value=$1::jsonb WHERE key='marketplace_automatic'",[JSON.stringify({enabled:true,channels:{temu:true},since:new Date(Date.now()+(scenario==='before-start'?0:-86400000)).toISOString()})]);
   if(scenario==='correction-history')await db.exec("INSERT INTO correction_jobs VALUES('A','complete')");
   const observation=await readTemuSource(apiFor(p),reference),order=(await db.query("SELECT * FROM orders WHERE id='A'")).rows[0];
   const result=await db.transaction(tx=>reconcileTemuCatchup(tx,order,observation));assert.equal(result.initialRecovered,scenario==='allowed',scenario);
   assert.equal((await db.query('SELECT * FROM erp_live_jobs')).rows.length,scenario==='allowed'?1:0,scenario);
   assert.equal((await db.query('SELECT * FROM carrier_jobs')).rows.length,0);assert.equal((await db.query('SELECT * FROM temu_label_jobs')).rows.length,0);
   const after=(await db.query("SELECT * FROM orders WHERE id='A'")).rows[0];assert.equal(after.source_payload.visibilityHold,false);
   if(scenario==='independent-issue')assert.equal(after.issue,'Stock insuffisant');
   if(scenario==='paused'){assert.equal(after.source_payload.temuInitialPreparationPending,true);await db.exec("UPDATE settings SET value='{\"enabled\":true}' WHERE key='automatic_live'");const resumed=await db.transaction(tx=>reconcileTemuCatchup(tx,after,observation));assert.equal(resumed.initialRecovered,true);assert.equal((await db.query('SELECT * FROM erp_live_jobs')).rows.length,1);assert.equal((await db.query("SELECT source_payload FROM orders WHERE id='A'")).rows[0].source_payload.temuInitialPreparationPending,undefined);}
   if(scenario==='uncertain-purchase')assert.deepEqual(after.source_payload.temuDirect,source.temuDirect);
   if(scenario==='allowed'){assert.equal(after.resolution_pending_resume,false);assert.equal(after.source_payload.temuLabelPurchaseConfirmationRequired,true);await db.transaction(tx=>reconcileTemuCatchup(tx,after,observation));assert.equal((await db.query('SELECT * FROM erp_live_jobs')).rows.length,1);}
  }finally{await db.close();}
 }
});

test('stable partial read retains financial hold and replaces source error only',async()=>{
 const db=await fixture();try{
 const error="TEMU refuse l’opération : 3000032 access_token don't have this api access, please ask for seller to authorize this api in seller center first.and share the new access_token with you.";
 const old=error+' ; TEMU refuse l’opération : 180020006 The current order status cannot be viewed.';
 await db.query("UPDATE orders SET issue=$1,source_payload=$2::jsonb WHERE id='A'",[old,JSON.stringify({mallId:'M',visibilityHold:true})]);
 const observed=await readTemuSource(apiFor(payload(),{'bg.order.amount.query':Error(error)}),reference);
 const worker=temuCatchupWorker(db,async()=>[{channel:'temu',shop:'M',refreshSource:async()=>observed}],{withLock:fn=>fn()});await worker.run();
 const after=(await db.query("SELECT * FROM orders WHERE id='A'")).rows[0];assert.match(after.issue,/Autorisation API des montants/);assert.ok(!after.issue.includes('180020006'));assert.equal(after.source_payload.visibilityHold,true);assert.equal(after.source_payload.platformStatusObservation.payload.detail.parentOrderMap.parentOrderStatus,2);assert.equal((await db.query('SELECT * FROM erp_live_jobs')).rows.length,0);assert.equal((await db.query('SELECT * FROM carrier_jobs')).rows.length,0);
 }finally{await db.close();}
});
test('partial proof rejects stale, unstable and foreign source, preserves independent issues',async()=>{
 const {partialTemuReadProof,pureTemuSourceReadError}=await import('../src/temu-catchup-policy.mjs');
 const observed=await readTemuSource(apiFor(payload(),{'bg.order.amount.query':Error('TEMU 3000032')}),reference),o={reference,source_payload:{}};
 assert.ok(partialTemuReadProof(o,observed));assert.equal(partialTemuReadProof({...o,reference:'OTHER'},observed),null);assert.equal(partialTemuReadProof(o,{...observed,coverage:{...observed.coverage,consistency:false}}),null);assert.equal(partialTemuReadProof({...o,source_payload:{temuOrderDetail:{parentOrderMap:{updateTime:observed.sourceVersion+1}}}},observed),null);assert.equal(pureTemuSourceReadError('Stock insuffisant ; TEMU refuse l’opération : 180020006 The current order status cannot be viewed.'),false);
});
test('older unattempted orders precede repeated initial holds',async()=>{
 const db=await fixture();try{
 await db.query("UPDATE orders SET source_payload=$1::jsonb WHERE id='A'",[JSON.stringify({mallId:'M',visibilityHold:true})]);await db.query('INSERT INTO orders(id,reference,issue,source_payload) VALUES($1,$1,$2,$3::jsonb)',['B','Stock',JSON.stringify({mallId:'M'})]);
 const worker=temuCatchupWorker(db,async()=>[{channel:'temu',shop:'M',refreshSource:async()=>{throw Error('read failed');}}],{withLock:fn=>fn()});assert.equal((await worker.run()).orderId,'A');await db.exec("UPDATE temu_source_catchup SET next_at=now()-interval '1 minute'");assert.equal((await worker.run()).orderId,'B');
 }finally{await db.close();}
});

test('every new blocker registers immediately without waiting for discovery',async()=>{
 const db=await fixture();try{await initializeTemuCatchup(db);await db.query('INSERT INTO orders(id,reference) VALUES($1,$1)',['new']);assert.equal((await db.query("SELECT * FROM temu_source_catchup WHERE order_id='new'")).rows.length,0);await db.query("INSERT INTO erp_live_jobs(order_id,status,error) VALUES('new','review','Stock')");assert.equal((await db.query("SELECT * FROM temu_source_catchup WHERE order_id='new'")).rows.length,1);await db.query("UPDATE orders SET issue='Poids' WHERE id='new'");assert.equal((await db.query("SELECT * FROM temu_source_catchup WHERE order_id='new'")).rows.length,1);}finally{await db.close();}
});
