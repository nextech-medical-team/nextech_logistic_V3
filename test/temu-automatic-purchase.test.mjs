import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticPreparationHold,temuAutomaticPurchaseWorker} from '../src/temu-automatic-purchase.mjs';
const now=Date.now();
const order={id:'o',reference:'PO-069-123456789',channel:'temu',source_payload:{temuDirect:{state:'verified'}},erp_live:{phase:'bl_ready',pricing:{status:'verified'},bl:{id:'1'},stockDocument:{id:'1'},documentSource:{checkedAt:new Date(now).toISOString(),stockHolds:[]},verifiedAt:new Date(now).toISOString(),stockCheckedAt:new Date(now).toISOString()}};
test('automatic admission preserves independent holds and requires validated preparation and a current read before buying',()=>{
 assert.equal(automaticPreparationHold(order,now),null);
 for(const change of [{archived:true},{simulation:true},{partial_mode:true},{issue:'Stock insuffisant'},{resolution_pending_resume:true},{transport_choice:'GLS'},{suspension:{active:true,note:'stop'}},{source_payload:{marketplacePendingCorrection:{}}},{source_payload:{temuDirect:{state:'error'}}},{source_payload:{externalLabel:{active:true}}},{erp_live:{...order.erp_live,phase:'bc_created'}},{erp_live:{...order.erp_live,stockCheckedAt:'invalid'}}])assert.ok(automaticPreparationHold({...order,...change},now),JSON.stringify(change));
 assert.equal(automaticPreparationHold({...order,erp_live:{...order.erp_live,verifiedAt:new Date(now-10*86400000).toISOString(),stockCheckedAt:new Date(now-10*86400000).toISOString()}},now),null);
 assert.ok(automaticPreparationHold(null,now));
});
test('legacy callers never read or buy, including enabled settings and positive margins',async()=>{
 const forbidden=()=>assert.fail('Automatic purchase path must not run');
 for(const enabled of [true,false]){
  const worker=temuAutomaticPurchaseWorker({query:forbidden},{prepare:forbidden,buy:forbidden},{get:forbidden},{enabled:()=>enabled,refreshPreparation:forbidden});
  assert.equal((await worker.run()).status,'disabled');assert.equal(worker.running,false);
 }
});

test('manual purchase route requires explicit confirmation; recovery remains available',async()=>{
 const {temuRoutes}=await import('../src/temu-routes.mjs');
 let buys=0,recoveries=0,audits=0;
 const ctx={p:'/api/temu/buy',req:{method:'POST'},res:{},url:new URL('https://example.invalid'),service:{},local:{buy:async(ref,id,amount)=>{assert.equal(ref,'PO-1-2');assert.equal(id,'quote');assert.equal(amount,2.5);buys++;return {};},recover:async()=>{recoveries++;return {};}},user:{role:'operator'},permitted:()=>{},audit:async()=>{audits++;},json:()=>{}};
 for(const confirmPurchase of [undefined,false,'true',1]){
  await assert.rejects(temuRoutes({...ctx,body:async()=>({confirmPurchase})}),/Confirmation explicite/);
 }
 assert.equal(buys,0);assert.equal(audits,0);
 await temuRoutes({...ctx,body:async()=>({reference:'PO-1-2',planId:'quote',amount:2.5,confirmPurchase:true})});
 assert.equal(buys,1);assert.equal(audits,1);
 await temuRoutes({...ctx,p:'/api/temu/recover',body:async()=>({reference:'PO-1-2'})});
 assert.equal(recoveries,1);assert.equal(buys,1);
});
test('saved automatic switch cannot re-enable purchases and server schedules no purchase worker',async()=>{
 const {validateTaskControls,taskControls}=await import('../src/background-controls.mjs');
 assert.throws(()=>validateTaskControls({'temu-automatic-purchase':true}),/manuel/);
 assert.deepEqual(validateTaskControls({'temu-automatic-purchase':false}),{'temu-automatic-purchase':false});
 const controls=await taskControls({query:async()=>({rows:[{value:{'temu-automatic-purchase':true,'temu-logistics':true}}]})});
 assert.equal(controls['temu-automatic-purchase'],false);assert.equal(controls['temu-logistics'],true);
 const {readFile}=await import('node:fs/promises');
 const server=await readFile(new URL('../src/server.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(server,/temuAutomaticPurchaseWorker|temuAutoPurchase\.run/);
});
