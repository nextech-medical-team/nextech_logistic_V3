import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {currentPreparationObservation,preparationMonitorView,projectPreparationActivity} from '../src/preparation-observation-view.mjs';
import {preparationNeedsCheck,observePreparation} from '../src/preparation-observation.mjs';
const now=Date.now(),observation={schemaVersion:1,observedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+899000).toISOString(),business:[{code:'stock-insufficient',message:'Stock insuffisant : SKU-X : 10 nécessaires ; stock disponible : 0'}],technical:[],blocked:true,processing:{completed:false}};
const state={preparationObservation:observation,preparationObservedVersion:3,lastProgress:new Date(now-7200000).toISOString()};
test('source TTL is not extended by a slow batch or a shared earlier product read',()=>{
 const readAt=new Date(now-800000).toISOString();const proof=observePreparation({order:{id:'ttl',reference:'TTL',erp_status:'live_review'},lines:[{source:'X',sku:'X',quantity:1,mappingPresent:true,locationId:100934}],documentSearch:{found:null,complete:true,readAt},products:[{sku:'X',readAt,status:'active',lookupProof:{responseComplete:true},variant:{sku:'X',active:true,product:{active:true},track_inventory:true,stock_levels:{data:[{location:{id:100934},available:0,on_hand:0}],paginatorInfo:{hasMorePages:false}}}}],now});
 assert.equal(proof.business[0].code,'stock-insufficient');assert.equal(Date.parse(proof.expiresAt),Date.parse(readAt)+900000);
 assert.equal(currentPreparationObservation({preparationObservation:proof,preparationObservedVersion:1},1,now+100001),null);
});
test('queued, active, completed, partial and explicitly suspended preparation is excluded',()=>{
 const order={erp_status:'live_review'};assert.equal(preparationNeedsCheck(order,{status:'review'}),true);
 for(const status of ['pending','processing','complete'])assert.equal(preparationNeedsCheck(order,{status}),false);
 for(const patch of [{partial_mode:true},{archived:true},{suspension:{active:true}},{suspension:{erplainCancellation:{}}}])assert.equal(preparationNeedsCheck({...order,...patch},{status:'review'}),false);
});
test('proof requires current source version, valid TTL and nonfuture read',()=>{
 assert.equal(currentPreparationObservation(state,3,now),observation);
 for(const version of [undefined,null,2])assert.equal(currentPreparationObservation(state,version,now),null);
 assert.equal(currentPreparationObservation({...state,preparationObservedVersion:undefined},undefined,now),null);
 assert.equal(currentPreparationObservation(state,3,now+900000),null);
 assert.equal(currentPreparationObservation(state,3,now-2000),null);
 const view=preparationMonitorView(state,3,now);assert.equal(view.alert,true);assert.equal(view.lastProgress,state.lastProgress);assert.match(view.result,/Stock insuffisant/);
});
const ctx=vm.createContext({Date,transportPendingText:null});vm.runInContext(fs.readFileSync(new URL('../public/compact-problems.js',import.meta.url),'utf8'),ctx);
const render=o=>ctx.compactProblems(o);
test('queued and running jobs do not create a review hold and independent failures remain visible',()=>{
 for(const status of ['pending','processing','complete']){
  const order={erp_status:'live_review',erp_live_job:{status},sku_lines:[]};
  assert.equal(render(order).some(p=>p.type==='erp-review'),false);
  const diagnostics=render({...order,issue:'Adresse incomplète'});
  assert.equal(diagnostics.some(p=>p.type==='erp-review'),false);
  assert.ok(diagnostics.some(p=>p.detail==='Adresse incomplète'));
 }
 assert.ok(render({erp_status:'live_review',erp_live_job:{status:'review'},sku_lines:[]}).some(p=>p.type==='erp-review'));
});
test('processing projection replaces only an obsolete confirmed mapping or missing reason, without touching history',()=>{
 const row={service:'Erplain',state:'blocked',reason:'BC · Mapping manquant : SKU-X',monitoring:{result:'Stock insuffisant',preparationObservationCurrent:true,preparationObservation:{mappingVerified:true}},activities:[{service:'Erplain',state:'blocked',reason:'BC · Mapping manquant : SKU-X'},{service:'V3',state:'blocked',reason:'Adresse incomplète'}]};
 const before=JSON.stringify(row),out=projectPreparationActivity(row);assert.equal(out.reason,'Stock insuffisant');assert.equal(out.activities[0].reason,'Stock insuffisant');assert.equal(out.activities[1].reason,'Adresse incomplète');assert.equal(JSON.stringify(row),before);
 assert.equal(projectPreparationActivity({...row,reason:'TVA incorrecte'}).reason,'TVA incorrecte');
 assert.equal(projectPreparationActivity({...row,monitoring:{...row.monitoring,preparationObservationCurrent:false}}).reason,row.reason);
 assert.equal(projectPreparationActivity({...row,monitoring:{...row.monitoring,preparationObservation:{mappingVerified:false}}}).reason,row.reason);
});
test('current stock and technical diagnostics replace generic review while preserving other failures',()=>{
 const base={erp_status:'live_review',erp_live_job:{status:'review'},sku_lines:[]};
 const stock=render({...base,preparation_observation:observation,issue:'Adresse incomplète'});
 assert.equal(stock.some(p=>p.type==='erp-review'),false);assert.equal(stock.find(p=>p.type==='stock').kind,'business');assert.ok(stock.some(p=>p.detail==='Adresse incomplète'));
 const technical=render({...base,preparation_observation:{...observation,business:[],technical:[{code:'stock-unverifiable',message:'Stock non vérifiable : SKU-X'}]}});
 assert.equal(technical[0].type,'api-stock');assert.equal(technical[0].kind,'technical');
 const continuation=render({...base,preparation_observation:{...observation,business:[],technical:[],processing:{continuationRequired:true},nextStep:'Autres prérequis à contrôler'}});
 assert.equal(continuation[0].kind,'processing');assert.match(continuation[0].label,/poursuivre/);
 const expired=render({...base,preparation_observation:{...observation,expiresAt:new Date(now-1).toISOString()}});assert.equal(expired[0].type,'erp-review');
});
