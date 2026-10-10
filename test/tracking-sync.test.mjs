import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {trackingDecision,synchronizeTracking,readTemuTracking} from '../src/tracking-sync.mjs';
import {trackingSyncConfig} from '../src/tracking-sync-config.mjs';

const target={orderId:'order-1',reference:'ORDER-1',blId:'20',bcId:'10',carrier:'gls',environment:'production',tracking:['TRACK1','TRACK2']};
const bl=status=>({id:'20',status,orders:{data:[{id:'10',status:'confirmed'}]}});
const event=(tracking,code='DELIVERED')=>({carrier:'gls',tracking,code,label:code==='DELIVERED'?'Delivered':'In transit',at:'2026-01-01T10:00:00Z'});
const delivered=[event('TRACK1'),event('TRACK2')];

test('tous les colis sont requis avant livraison',()=>{
 assert.equal(trackingDecision(target,delivered,bl('shipped')).target,'delivered');
 assert.equal(trackingDecision(target,[event('TRACK1')],bl('shipped')).write,false);
 assert.equal(trackingDecision(target,[event('TRACK1'),event('TRACK2','INTRANSIT')],bl('pending')).target,'shipped');
});
test('aucune regression ni progression sur un incident',()=>{
 assert.equal(trackingDecision(target,delivered,bl('cancelled')).write,false);
 assert.equal(trackingDecision(target,[event('TRACK1','INTRANSIT'),event('TRACK2','INTRANSIT')],bl('delivered')).write,false);
 assert.equal(trackingDecision(target,[event('TRACK1'),{...event('TRACK2'),code:'CANCELLED',label:'Cancelled'}],bl('pending')).write,false);
});
test('rattachement, dates futures et suivis dupliques sont bloques',()=>{
 assert.throws(()=>trackingDecision({...target,bcId:'999'},delivered,bl('pending')),/Rattachement/);
 assert.throws(()=>trackingDecision(target,[{...event('TRACK1'),at:'2099-01-01'}],bl('pending')),/dates/);
 assert.equal(trackingDecision({...target,tracking:['TRACK1','TRACK1']},delivered,bl('pending')).write,false);
});

function harness({apply=false,status='shipped',readError=false,confirmStatus='delivered',current=true}={}){
 const calls=[];let reads=0;
 const gateway={verifyLive:async()=>calls.push('verify'),readBL:async()=>bl(reads++?confirmStatus:status),setBLStatus:async(id,s)=>calls.push('write:'+id+':'+s)};
 const store={assertCurrent:async()=>{if(!current)throw Error('Commande modifiée');},withLock:async(t,fn)=>{calls.push('lock');return fn();},record:async action=>calls.push(action),confirm:async(t,s)=>calls.push('local:'+s)};
 const carrier={read:async(c,e,n)=>{if(readError&&n==='TRACK2')throw Error('API indisponible');return [event(n)];}};
 return {calls,run:()=>synchronizeTracking({targets:[target],carrier,gateway,store,apply})};
}
test('apercu : lectures reelles mais aucune ecriture',async()=>{
 const h=harness();const report=await h.run();
 assert.equal(report.counts.proposed,1);assert.deepEqual(h.calls,['verify']);
});
test('application : intention, ecriture, relecture, confirmation locale',async()=>{
 const h=harness({apply:true});const report=await h.run();
 assert.equal(report.counts.updated,1);
 assert.deepEqual(h.calls,['verify','lock','tracking_sync.intent','write:20:delivered','local:delivered','tracking_sync.confirmed']);
});
test('erreur de lecture ou changement de commande : aucune mutation Erplain',async()=>{
 for(const options of [{readError:true},{current:false}]){
  const h=harness({apply:true,...options});const r=await h.run();
  assert.equal(r.counts.error,1);assert.equal(h.calls.some(c=>c.startsWith('write:')),false);
 }
});
test('mutation non confirmee : ne pas annoncer de mise a jour locale',async()=>{
 const h=harness({apply:true,confirmStatus:'shipped'});const r=await h.run();
 assert.equal(r.counts.error,1);assert.equal(h.calls.some(c=>c.startsWith('local:')),false);
});
test('limitation API : suspendre le transporteur, continuer les autres',async()=>{
 const calls=[],deferred=[];
 const r=await synchronizeTracking({targets:[target,{...target,reference:'NEXT'},{...target,reference:'GOFO',carrier:'gofo'}],
  carrier:{read:async(c,e,n)=>{calls.push(c);if(c==='gls'){const error=Error('HTTP 429');error.retryAfter=7200;throw error;}return [{...event(n),carrier:'gofo'}];}},
  gateway:{verifyLive:async()=>{},readBL:async()=>bl('shipped')},
  store:{assertCurrent:async()=>{},deferCarrier:async(c,s)=>deferred.push([c,s])}});
 assert.deepEqual(deferred,[['gls',7200]]);assert.equal(calls.filter(c=>c==='gls').length,1);
 assert.equal(r.counts.error,2);assert.equal(r.counts.proposed,1);
});
test('reprise apres interruption : rapproche le statut sans repeter la mutation',async()=>{
 const h=harness({apply:true,status:'delivered'});const r=await h.run();
 assert.equal(r.counts.unchanged,1);assert.ok(h.calls.includes('local:delivered'));assert.equal(h.calls.some(c=>c.startsWith('write:')),false);
});
test('un BL partiel utilise seulement ses colis',async()=>{
 const writes=[];
 const r=await synchronizeTracking({targets:[{...target,partialId:'part-1',tracking:['TRACK1']}],apply:true,
  carrier:{read:async()=>[event('TRACK1')]},gateway:{verifyLive:async()=>{},readBL:async()=>bl(writes.length?'delivered':'shipped'),setBLStatus:async()=>writes.push('write')},
  store:{assertCurrent:async()=>{},record:async()=>{},withLock:async(t,fn)=>fn(),confirm:async t=>assert.equal(t.partialId,'part-1')}});
 assert.equal(r.counts.updated,1);
});
test('un suivi reste visible sans BL, une date future ne devient pas un statut V3',async()=>{
 for(const invalid of [false,true]){
  let observed;
  const r=await synchronizeTracking({targets:[{...target,blId:null}],carrier:{read:async(c,e,t)=>[{...event(t),...(invalid?{at:'2099-01-01'}:{})}]},
   store:{},gateway:{verifyLive:async()=>{throw Error('Ne doit pas consulter Erplain');}},onRow:async row=>{observed=row;}});
  assert.equal(r.counts.error,1);
  assert.equal(observed.carrierStatus,invalid?undefined:'delivered');
  assert.match(observed.error,invalid?/dates invalides/:/BL Erplain absent/);
 }
});
test('configuration : priorite au token env sans perdre la societe du fichier',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'nextech-tracking-test-'));
 try{
  await writeFile(path.join(directory,'erplain-live.json'),JSON.stringify({apiKey:'old',companyId:100174}));
  const c=await trackingSyncConfig(directory,'erplain-live.json',{ERPLAIN_API_KEY:'new'});
  assert.equal(c.apiKey,'new');assert.equal(c.companyId,100174);
  assert.equal((await trackingSyncConfig(directory,'carriers-production.json',{})).GOFO_BASE_URL,'https://api-eu.gofoexpress.com');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('TEMU : verifier le colis puis lire les evenements de suivi',async()=>{
 const reference='PO-123-456',p={packageSn:'PK-123',trackingNumber:'TRACK1',shippingLabelStatus:1,orderSendInfoList:[{parentOrderSn:reference}]};
 const responses={
  'bg.order.detail.v2.get':{parentOrderMap:{parentOrderSn:reference,parentOrderStatus:4},orderList:[{orderSn:'item-1',packageSnInfo:[{packageSn:p.packageSn}]}]},
  'bg.logistics.shipment.v2.get':{shipmentInfoDTO:[{...p,parentOrderSn:reference}]},
  'bg.logistics.shipment.result.get':{packageInfoResultList:[p]},
  'temu.track.trackinginfo.get':{packageSn:p.packageSn,trackingNum:p.trackingNumber,trackingInfo:[{logisticsStatus:'DELIVERED',statusText:'Delivered',logisticsUpdatedAt:1767261600}]}
 };
 const api={read:async type=>responses[type]};
 const r=await readTemuTracking(api,reference);assert.deepEqual(r.tracking,['TRACK1']);assert.equal(r.events[0].carrier,'temu');
 responses['temu.track.trackinginfo.get'].trackingNum='OTHER';
 await assert.rejects(readTemuTracking(api,reference),/identité/);
});
