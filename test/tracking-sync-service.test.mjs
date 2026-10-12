import test from 'node:test';
import assert from 'node:assert/strict';
import {createTrackingTestDb} from './support/tracking-db.mjs';
import {initializeTrackingSync,trackingOverview,trackingHistory} from '../src/tracking-sync-history.mjs';
import {trackingSyncService,trackingSyncRoutes} from '../src/tracking-sync-service.mjs';

test('test limité : refuse les sélections globales, vides ou supérieures à cinq avant tout accès',async()=>{
 const service=trackingSyncService({query:()=>{throw Error('Accès inattendu');}},'/unused');
 for(const ids of [undefined,null,[],['a','b','c','d','e','f'],[' '],['a',null]]){
  await assert.rejects(service.enqueue({mode:'preview',ids},{email:'test@example.test'}),/1 à 5 commandes/);
 }
});

test('cinq commandes sélectionnées : aucune lecture ni modification de la sixième',async()=>{
 const db=await createTrackingTestDb();
 try{
  await initializeTrackingSync(db);
  const ids=Array.from({length:5},(_,i)=>'selected-'+i),reads=[];
  for(let i=0;i<6;i++){
   await db.query('INSERT INTO orders(id,reference,channel,erp_live) VALUES($1,$2,$3,$4)',['selected-'+i,'REF-'+i,'amazon',JSON.stringify({bc:{id:'100'},bl:{id:String(200+i)}})]);
   await db.query('INSERT INTO carrier_jobs VALUES($1,$2,$3,$4,$5)',['selected-'+i,'gls','production','ready',JSON.stringify(['TRACK-'+i])]);
  }
  const service=trackingSyncService(db,'/unused',{clients:()=>({
   carrier:{read:async(c,e,tracking)=>{reads.push(tracking);return [{carrier:c,tracking,code:'INTRANSIT',at:'2026-01-01T10:00:00Z'}];}},
   gateway:{verifyLive:async()=>{},readBL:async id=>({id,status:'pending',orders:{data:[{id:'100',status:'confirmed'}]}}),setBLStatus:async()=>{throw Error('Écriture Erplain inattendue');}}
  })});
  const {run}=await service.enqueue({ids,mode:'preview'},{email:'test@example.test'});
  await service.run();
  assert.deepEqual(reads.sort(),['TRACK-0','TRACK-1','TRACK-2','TRACK-3','TRACK-4']);
  const result=(await db.query('SELECT * FROM tracking_sync_runs WHERE id=$1',[run.id])).rows[0];
  assert.equal(result.status,'complete');assert.equal(result.total,5);assert.equal(result.processed,5);
  const changed=(await db.query("SELECT id FROM orders WHERE tracking_status='shipped' ORDER BY id")).rows.map(r=>r.id);
  assert.deepEqual(changed,ids);
  assert.deepEqual((await db.query('SELECT DISTINCT order_id FROM tracking_sync_observations ORDER BY order_id')).rows.map(r=>r.order_id),ids);
  // Old global jobs still queued at deployment must fail before contacting any API.
  await db.query("INSERT INTO tracking_sync_runs(id,requested_by,mode,order_ids) VALUES('old-global','test','preview',NULL)");
  reads.length=0;await service.run();assert.deepEqual(reads,[]);
  const old=(await db.query("SELECT status,error FROM tracking_sync_runs WHERE id='old-global'")).rows[0];
  assert.equal(old.status,'failed');assert.match(old.error,/1 à 5 commandes/);
 }finally{await db.close();}
});

test('bouton : file unique, progression, suivis V3 et historique persistant des BL',async()=>{
 const db=await createTrackingTestDb();
 try{
  await initializeTrackingSync(db);
  const env={ERPLAIN_LIVE_WRITES:'1'};let physical='INTRANSIT',erplain='pending',fail=false,writes=0;
  const service=trackingSyncService(db,'/unused',{env,clients:()=>({
   carrier:{read:async(c,e,tracking)=>{if(fail)throw Error('Transporteur indisponible');return [{carrier:c,tracking,code:physical,label:physical==='DELIVERED'?'Delivered':'In transit',at:'2026-01-01T10:00:00Z'}];}},
   gateway:{verifyLive:async()=>{},readBL:async()=>({id:'20',status:erplain,orders:{data:[{id:'10',status:'confirmed'}]}}),setBLStatus:async(id,status)=>{writes++;erplain=status;}}
  })});
  const user={email:'operator@example.test',role:'operator'};
  const queued=await service.enqueue({ids:['o1'],mode:'preview'},user);
  assert.equal((await service.enqueue({ids:['o1'],mode:'preview'},user)).existing,true);
  await service.run();
  let overview=await service.overview({});
  assert.equal(overview.runs[0].status,'complete');assert.equal(overview.runs[0].processed,1);
  assert.equal(overview.rows[0].result.carrierStatus,'shipped');assert.equal(writes,0);
  assert.equal((await db.query("SELECT tracking_status FROM orders WHERE id='o1'")).rows[0].tracking_status,'shipped');
  const key=overview.rows[0].target_key;
  physical='DELIVERED';erplain='shipped';
  await service.enqueue({ids:['o1'],mode:'apply'},user);await service.run();
  assert.equal(writes,1);
  const history=await service.history(key,{});
  assert.equal(history.changes[0].carrier_before,'shipped');assert.equal(history.changes[0].carrier_after,'delivered');
  assert.equal(history.changes[0].erplain_before,'shipped');assert.equal(history.changes[0].erplain_after,'delivered');
  assert.equal(history.events.length,4);
  assert.equal((await db.query("SELECT tracking_status FROM orders WHERE id='o1'")).rows[0].tracking_status,'delivered');
  await service.enqueue({ids:['o1'],mode:'apply'},user);await service.run();
  assert.equal((await service.history(key,{})).changes.length,history.changes.length);
  fail=true;await service.enqueue({ids:['o1'],mode:'preview'},user);await service.run();
  overview=await service.overview({search:'TRACK2'});
  assert.equal(overview.total,1);assert.equal(overview.rows[0].result.carrierStatus,'delivered');
  assert.equal(overview.rows[0].result.lastKnownErplain,'delivered');
  assert.match(overview.rows[0].result.error,/indisponible/);
  assert.equal((await trackingOverview(db,{runId:queued.run.id})).rows[0].result.carrierStatus,'shipped');
  await assert.rejects(service.enqueue({ids:[],mode:'apply'},user),/Sélection/);
  const before=(await trackingHistory(db,key)).changes[0].id;
  assert.ok((await trackingHistory(db,key,{before})).changes.every(c=>Number(c.id)<Number(before)));
  await assert.rejects(trackingHistory(db,'invalid'),/invalide/);
 }finally{await db.close();}
});

test('aucune ecriture Erplain si la configuration change après le clic',async()=>{
 const db=await createTrackingTestDb();
 try{
  await initializeTrackingSync(db);const env={ERPLAIN_LIVE_WRITES:'1'};
  const service=trackingSyncService(db,'/unused',{env,clients:()=>{throw Error('Ne doit pas contacter une API');}});
  await service.enqueue({ids:['o1'],mode:'apply'},{email:'admin@example.test'});
  env.ERPLAIN_LIVE_WRITES='0';await service.run();
  assert.equal((await service.overview({})).runs[0].status,'failed');
  await db.exec('DELETE FROM worker_health');
  await assert.rejects(service.enqueue({ids:['o1'],mode:'preview'},{email:'operator@example.test'}),/indisponible/);
 }finally{await db.close();}
});

test('routes : consultation autorisée, lancement réservé aux rôles opérationnels',async()=>{
 let queued=0,response;
 const service={overview:async()=>({rows:[]}),enqueue:async()=>{queued++;return {ok:true};}};
 const base={p:'/api/tracking-sync',url:new URL('http://localhost/api/tracking-sync'),res:{},service,user:{role:'viewer'},body:async()=>({mode:'preview'}),json:(r,s,v)=>response={s,v},permitted:(u,roles)=>{if(!roles.includes(u.role))throw Object.assign(Error('Droits insuffisants'),{status:403});}};
 assert.equal(await trackingSyncRoutes({...base,req:{method:'GET'}}),true);assert.equal(response.s,200);
 await assert.rejects(trackingSyncRoutes({...base,req:{method:'POST'}}),{status:403});assert.equal(queued,0);
 await trackingSyncRoutes({...base,user:{role:'operator'},req:{method:'POST'}});assert.equal(response.s,202);assert.equal(queued,1);
});
