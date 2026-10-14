import test from 'node:test';
import assert from 'node:assert/strict';
import {canRetryFailedCarrier,provesLegacyPreflight,markCarrierCreationStarted,hasUncertainCarrierHistory,provesImportedFieldsPreflight} from '../src/carrier-attempt-proof.mjs';
import {createProductionCarriers} from '../src/carriers-test.mjs';
const job={order_id:'order',status:'failed',attempts:1,creation_id:null,result:null,reference:null,tracking:[],error:'Échec antérieur revalidé',updated_at:'2026-10-10T03:12:00.528Z'};
const audit={created_at:job.updated_at,detail:{orderId:'order',currentError:job.error,previousError:'Préparation modifiée depuis la validation du BL : recontrôler',businessWrites:0,labelPurchased:false,previousUpdatedAt:'2026-10-09T11:48:53.733Z',proof:{previousFailureAt:'2026-10-09T11:48:53.733Z',validationAt:'2026-10-09T15:35:49.486Z',readOnly:true,verified:true,businessActionAuthorized:false}}};
test('legacy generic diagnostic uses immutable audit provenance rather than business checks',async()=>{
 assert(provesLegacyPreflight(job,audit));
 const calls=[];assert(await canRetryFailedCarrier({query:async(...a)=>{calls.push(a);return {rows:[audit]};}},job));
 assert.equal(calls.length,1);assert.deepEqual(calls[0][1],['order',job.updated_at]);
});
for(const [name,patch] of Object.entries({newCreation:{creation_id:'new'},result:{result:{}},reference:{reference:'existing'},tracking:{tracking:['T']},missingTracking:{tracking:undefined},laterUpdate:{updated_at:'2026-10-11T00:00:00Z'}}))test('legacy evidence rejects '+name,()=>assert.equal(provesLegacyPreflight({...job,...patch},audit),false));
for(const [name,patch] of Object.entries({wrongOrder:{orderId:'other'},wrongError:{currentError:'different'},providerError:{previousError:'Timeout'},providerWrites:{businessWrites:1},labelPurchased:{labelPurchased:true},wrongPriorTime:{previousUpdatedAt:'invalid'}}))test('audit rejects '+name,()=>assert.equal(provesLegacyPreflight(job,{...audit,detail:{...audit.detail,...patch}}),false));
test('no audit proof never permits generic legacy failures',async()=>assert.equal(await canRetryFailedCarrier({query:async()=>({rows:[]})},job),false));
test('legacy recorded-BC fingerprint rejection is known preflight even with assigned creation id',async()=>{
 const failed={...job,error:'BC modifié depuis sa préparation : recontrôle requis',creation_id:'legacy-assigned'};
 const db={query:()=>assert.fail('no additional business or provider read')};
 assert.equal(await canRetryFailedCarrier(db,failed),true);
 assert.equal(await canRetryFailedCarrier(db,{...failed,creation_started_at:'2026-10-14T00:00:00Z'}),false);
 assert.equal(await canRetryFailedCarrier(db,{...failed,result:{reference:'R'}}),false);
});
const fieldJob={...job,creation_id:'old-field-attempt',error:'Échec d’étiquette antérieur : champs Erplain relus et validés. Aucune relance effectuée.'};
for(const error of ['Mapping modifié avant création : recontrôle requis','Mapping modifié depuis la validation du BL : recontrôle requis'])test('retired mapping preflight can resume without mapping or BC reads: '+error,async()=>{
 const db={query:()=>assert.fail('no new business checks')};
 const failed={...job,error,creation_id:'reserved',attempts:4,failure_phase:'preflight',creation_started_at:null};
 assert.equal(await canRetryFailedCarrier(db,failed),true);
 for(const patch of [{creation_started_at:'2026-10-14T00:00:00Z'},{failure_phase:'provider'},{result:{reference:'R'}},{reference:'R'},{tracking:['T']}])assert.equal(await canRetryFailedCarrier(db,{...failed,...patch}),false);
});
const fieldAudit={created_at:job.updated_at,detail:{orderId:'order',currentError:fieldJob.error,previousError:'Erplain LIVE · Numéro de téléphone invalide : corriger avant création de l’étiquette',businessWrites:0,labelPurchased:false,proof:{readOnly:true,businessActionAuthorized:false}}};
test('archived imported field validation failure is proven preflight by matching audit',()=>assert(provesImportedFieldsPreflight(fieldJob,fieldAudit)));
test('known preflight archive without PDF does not veto a new manual label',async()=>{
 const db={query:async sql=>sql.startsWith('SELECT h.id')?{rows:[{job:fieldJob,documents:false}]}:{rows:[fieldAudit]}};
 assert.equal(await hasUncertainCarrierHistory(db,'order'),false);
});
for(const patch of [{documents:true},{job:{...fieldJob,status:'ready'}},{job:{...fieldJob,result:{reference:'R'}}},{job:{...fieldJob,tracking:['T']}},{job:{...fieldJob,creation_started_at:'2026-10-14T00:00:00Z'}}])test('archive creation evidence retained '+JSON.stringify(patch),async()=>{
 const db={query:async sql=>sql.startsWith('SELECT h.id')?{rows:[{job:fieldJob,documents:false,...patch}]}:{rows:[fieldAudit]}};
 assert.equal(await hasUncertainCarrierHistory(db,'order'),true);
});
test('unproven archive and stale field audit remain protected',async()=>{
 const db={query:async sql=>sql.startsWith('SELECT h.id')?{rows:[{job:fieldJob,documents:false}]}:{rows:[]}};
 assert.equal(await hasUncertainCarrierHistory(db,'order'),true);
 assert.equal(provesImportedFieldsPreflight(fieldJob,{...fieldAudit,created_at:'2026-10-11T00:00:00Z'}),false);
});
test('persisted preflight failure survives any translated or rewritten message',async()=>{
 assert(await canRetryFailedCarrier({query:()=>assert.fail('no business queries')},{...job,failure_phase:'preflight',creation_started_at:null,creation_id:'attempt'}));
});
for(const patch of [{status:'review'},{creation_started_at:'now'},{failure_phase:'provider'},{result:{reference:'R'}},{reference:'R'},{tracking:['T']}])test('persisted provider evidence preserved '+JSON.stringify(patch),async()=>assert.equal(await canRetryFailedCarrier({query:()=>assert.fail('no query')},{...job,failure_phase:'preflight',...patch}),false));
test('DB marker error prevents entering provider call',async()=>{
 let providerCalls=0;await assert.rejects(async()=>{await markCarrierCreationStarted({query:async()=>{throw Error('database failed');}},'order');providerCalls++;},/database failed/);assert.equal(providerCalls,0);
});
test('preexisting marker prevents entering provider call',async()=>{
 let providerCalls=0;await assert.rejects(async()=>{await markCarrierCreationStarted({query:async()=>({rows:[]})},'order');providerCalls++;},/rapprocher/);assert.equal(providerCalls,0);
});
const config={GLS_AUTH_BASE_URL:'https://api.gls-group.net',GLS_BASE_URL:'https://api.gls-group.net/shipit-farm/v1/backend/rs',GOFO_BASE_URL:'https://api-eu.gofoexpress.com',GLS_CONTACT_ID_MONO:'synthetic',GOFO_APP_SECRET:'synthetic'};
const shipment={id:'o',reference:'#TEST',channel:'amazon',carrier:'gofo',address:{name:'Synthetic',street:'1 rue Test',postal:'75001',city:'Paris',country:'FR'},source_payload:{},weight_kg:1,parcel_count:1};
for(const carrier of ['gls','gofo'])test(carrier+' records marker only after authentication and immediately before creation HTTP',async()=>{
 const timeline=[];const client=createProductionCarriers(config,{fetchImpl:async(url)=>{
  if(url.endsWith('/token')){timeline.push('authentication');return Response.json({access_token:'synthetic',accessToken:'synthetic'});}
  timeline.push('creation');return carrier==='gls'?Response.json({CreatedShipment:{ParcelData:[{TrackID:'T'}],PrintData:[]}}):Response.json({code:200,data:{cOrderNo:'R',waybillNo:'T'}});
 }});
 const beforeCreate=async()=>{timeline.push('marker');};
 await (carrier==='gls'?client.gls({...shipment,carrier},{beforeCreate}):client.gofoCreate(shipment,{beforeCreate}));
 assert.deepEqual(timeline,['authentication','marker','creation']);
});
test('adapter local validation failure never records creation marker',async()=>{
 let calls=0,markers=0;const client=createProductionCarriers(config,{fetchImpl:async()=>{calls++;assert.fail('no HTTP');}});
 await assert.rejects(client.gls({...shipment,parcel_count:0},{beforeCreate:async()=>{markers++;}}),/colis invalide/);assert.equal(calls,0);assert.equal(markers,0);
});
test('authentication refusal never records creation marker',async()=>{
 let posts=0,markers=0;const client=createProductionCarriers(config,{fetchImpl:async(url)=>{assert(url.endsWith('/token'));posts++;return Response.json({});}});
 await assert.rejects(client.gofoCreate(shipment,{beforeCreate:async()=>{markers++;}}),/Authentification/);assert.equal(posts,1);assert.equal(markers,0);
});
test('marker persistence failure prevents actual provider POST after authentication',async()=>{
 let creates=0;const client=createProductionCarriers(config,{fetchImpl:async(url)=>{if(url.endsWith('/token'))return Response.json({accessToken:'synthetic'});creates++;assert.fail('no creation POST');}});
 await assert.rejects(client.gofoCreate(shipment,{beforeCreate:async()=>{throw Error('database failure');}}),/database failure/);assert.equal(creates,0);
});

for(const attempts of [1,2,10,99])test('proven preflight retry is independent of attempt count '+attempts,async()=>{
 const db={query:async()=>({rows:[audit]})};
 assert(await canRetryFailedCarrier(db,{...job,attempts}));
 assert(provesImportedFieldsPreflight({...fieldJob,attempts},fieldAudit));
 assert(await canRetryFailedCarrier({query:async()=>({rows:[fieldAudit]})},{...fieldJob,attempts}));
 assert(await canRetryFailedCarrier(db,{...job,attempts,creation_started_at:null,failure_phase:'preflight'}));
 for(const patch of [{creation_started_at:'2026-10-14T00:00:00Z'},{failure_phase:'provider'},{result:{}},{tracking:['T']},{reference:'R'}])assert.equal(await canRetryFailedCarrier(db,{...job,attempts,...patch}),false);
 assert.equal(await canRetryFailedCarrier({query:async()=>({rows:[]})},{...job,attempts,error:'Timeout'}),false);
 assert.equal(provesImportedFieldsPreflight({...fieldJob,attempts,updated_at:'2026-10-14T00:00:00Z'},fieldAudit),false);
});
