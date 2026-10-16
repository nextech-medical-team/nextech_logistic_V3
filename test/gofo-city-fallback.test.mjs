import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {queueLabelFromBl} from '../src/direct-label.mjs';
import {initializeCarrierJobs,createCarrierWorkers} from '../src/carrier-jobs.mjs';
import {createProductionCarriers} from '../src/carriers-test.mjs';
const config={GLS_AUTH_BASE_URL:'https://api.gls-group.net',GLS_BASE_URL:'https://api.gls-group.net/shipit-farm/v1/backend/rs',GOFO_BASE_URL:'https://api-eu.gofoexpress.com',GLS_CONTACT_ID_MONO:'synthetic',GOFO_APP_SECRET:'synthetic'};
const address={name:'Synthetic',street:'1 rue Test',city:'Rambouillet',postal:'78120',country:'FR'};
const shipment={id:'o',reference:'SYNTHETIC',channel:'amazon',carrier:'gofo',address,source_payload:{},weight_kg:0.6,parcel_count:1};
for(const [name,response,expected] of [
 ['city',{code:200301000,messageEn:'City information is incorrect'},true],
 ['mapping',{code:200301000,messageEn:'Please refer to 78120 for City-to-Postal Code mapping.'},true],
 ['other',{code:500,messageEn:'City information is incorrect'},false],
 ['existing reference',{code:200301000,messageEn:'City information is incorrect',data:{cOrderNo:'EXISTING'}},false],
 ['existing tracking',{code:200301000,messageEn:'City information is incorrect',data:{waybillNo:'TRACK'}},false],
 ['unknown',{code:200301000,messageEn:'Unknown error'},false]
])test('GOFO protocol classification: '+name,async()=>{
 const client=createProductionCarriers(config,{fetchImpl:async url=>Response.json(url.endsWith('/token')?{accessToken:'synthetic'}:response)});
 await assert.rejects(client.gofoCreate(shipment),e=>{assert.equal(e.cityRejected,expected);return true;});
});
for(const [channel,scenario] of [['amazon','city'],['amazon','zone'],['amazon','uncertain'],['tender','city'],['unknown','city'],['tender','zone'],['unknown','zone']])test('worker GOFO to GLS with one PDF: '+channel+' '+scenario,async()=>{
 const engine=new PGlite();await engine.waitReady;
 const wrap=e=>({exec:s=>e.exec(s),query:(s,p=[])=>e.query(s,p)}),db={...wrap(engine),transaction:fn=>engine.transaction(tx=>fn(wrap(tx))),recoverInterrupted:false};
 try{
 await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,channel text,reference text,carrier text,address jsonb,source_payload jsonb DEFAULT '{}',erp_live jsonb DEFAULT '{}',label_status text,weight_kg numeric,parcel_count integer,tracking_status text,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,resolution_pending_resume boolean DEFAULT false,suspension jsonb DEFAULT '{}',issue text);CREATE TABLE lines(id text,order_id text,source_line text,source_sku text,target_sku text,quantity numeric,target_quantity numeric);CREATE TABLE settings(key text,value jsonb);CREATE TABLE resolution_jobs(id text,order_id text,status text);CREATE TABLE extra_parcels(id text,order_id text);CREATE TABLE audit(user_email text,action text,detail jsonb);`);
 await initializeCarrierJobs(db);
 const erp={bc:{id:1},bl:{id:2,status:'ready_to_ship'}};
 await db.query("INSERT INTO orders(id,channel,reference,carrier,address,erp_live,label_status,weight_kg,parcel_count,source_payload) VALUES('o',$4,'SYNTHETIC','gofo',$1,$2,'simulated',0.6,1,$3)",[JSON.stringify(address),JSON.stringify(erp),JSON.stringify({shippostalcode:'78120'}),channel]);
 await queueLabelFromBl(db,'o',{email:'operator'});
 let gofo=0,gls=0;
 const workers=createCarrierWorkers(db,null,{clients:{async gofoCreate(_o,{beforeCreate}){await beforeCreate();gofo++;throw Object.assign(Error('GOFO refusal'),{rejected:true,cityRejected:scenario!=='zone',zoneRejected:scenario==='zone',uncertain:scenario==='uncertain'});},async gls(o,{beforeCreate}){await beforeCreate();gls++;assert.deepEqual(o.address,address);return {reference:'GLS',tracking:['TRACK'],documents:[Buffer.from('%PDF-1.4\nsynthetic').toString('base64')]};}}});
 await workers.run('gofo');await workers.run('gls');await workers.run('gls');await workers.run('gofo');
 const job=(await db.query("SELECT * FROM carrier_jobs WHERE order_id='o'")).rows[0],o=(await db.query("SELECT * FROM orders WHERE id='o'")).rows[0];
 assert.equal(gofo,1);assert.deepEqual(o.address,address);assert.deepEqual(o.erp_live,erp);assert.equal(o.source_payload.shippostalcode,'78120');
 if(scenario==='uncertain'||(scenario==='city'&&channel!=='amazon')){assert.equal(gls,0);assert.equal(job.status,scenario==='uncertain'?'review':'failed');assert.equal((await db.query('SELECT * FROM carrier_documents')).rows.length,0);}
 else{assert.equal(gls,1);assert.equal(job.status,'ready');assert.equal(job.carrier,'gls');assert.equal((await db.query('SELECT * FROM carrier_documents')).rows.length,1);const audit=(await db.query("SELECT * FROM audit WHERE action='carrier.gofo_zone_fallback'")).rows;assert.equal(audit.length,1);if(channel==='amazon'){assert.equal(o.source_payload.gofoZoneRefusal.kind,scenario);assert.equal(audit[0].detail.kind,scenario);assert.equal(audit[0].detail.addressUnchanged,true);}else{assert.deepEqual(Object.keys(o.source_payload.gofoZoneRefusal).sort(),['at','fallback','reason']);assert.deepEqual(audit[0].detail,{orderId:'o',reason:'GOFO refusal'});}}
 }finally{await engine.close();}
});
