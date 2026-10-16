import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcilePublicationState} from '../src/publication-recovery.mjs';
import {retryDecision} from '../src/erp-transient-policy.mjs';
const state=(status,stock=true)=>({phase:'publishing_bl',bc:{id:1},bl:{id:2,status,update_stock:stock}});
test('confirmed draft returns to normal publication checks',()=>{
 assert.equal(reconcilePublicationState(state('unpublished'),{update_stock:true}).phase,'bl_created');
});
test('published native BL continues without replaying publication',()=>{
 for(const status of ['pending','in_preparation','make_the_shipment','ready_to_ship'])assert.equal(reconcilePublicationState(state(status),{update_stock:true}).phase,'bl_created');
});
test('separate stock flow resumes at guarded stock reconciliation',()=>{
 assert.equal(reconcilePublicationState(state('pending',false),{update_stock:false}).phase,'creating_stock');
});
test('unknown, terminal and incompatible provider states stay blocked',()=>{
 for(const status of ['cancelled','shipped','completed',undefined])assert.throws(()=>reconcilePublicationState(state(status),{update_stock:true}));
 assert.throws(()=>reconcilePublicationState(state('pending'),{}));
 assert.throws(()=>reconcilePublicationState(state('pending'),{update_stock:false}));
});
test('interrupted publication is eligible but suspended orders remain blocked',()=>{
 const o={erp_live:state('unpublished'),source_payload:{}};
 const error='BL Erplain · Publication à vérifier : contrôler le BL';
 const updated=new Date(Date.now()-60000).toISOString();
 assert.equal(retryDecision(o,error,updated),true);
 assert.equal(retryDecision({...o,resolution_pending_resume:true},error,updated),false);
 assert.equal(retryDecision({...o,label_status:'cancelled'},error,updated),false);
 assert.equal(retryDecision({...o,erp_live:{...o.erp_live,transientRecovery:{attempts:3}}},error,updated),false);
});

test('tender interrupted publication remains excluded',()=>{const o={channel:'tender',erp_live:state('unpublished'),source_payload:{}};assert.equal(retryDecision(o,'Publication à vérifier',new Date(Date.now()-60000).toISOString()),false);});
