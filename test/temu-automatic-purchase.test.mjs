import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticPreparationHold,temuAutomaticPurchaseWorker} from '../src/temu-automatic-purchase.mjs';
const now=Date.now();
const order={id:'o',reference:'PO-069-123456789',channel:'temu',source_payload:{temuDirect:{state:'verified'}},erp_live:{phase:'bl_ready',pricing:{status:'verified'},bl:{id:'1'},stockDocument:{id:'1'},verifiedAt:new Date(now).toISOString(),stockCheckedAt:new Date(now).toISOString()}};
test('automatic admission preserves independent holds and requires fresh preparation',()=>{
 assert.equal(automaticPreparationHold(order,now),null);
 for(const change of [{archived:true},{simulation:true},{partial_mode:true},{issue:'Stock insuffisant'},{resolution_pending_resume:true},{transport_choice:'GLS'},{suspension:{active:true,note:'stop'}},{source_payload:{marketplacePendingCorrection:{}}},{source_payload:{temuDirect:{state:'error'}}},{source_payload:{externalLabel:{active:true}}},{erp_live:{...order.erp_live,phase:'bc_created'}},{erp_live:{...order.erp_live,stockCheckedAt:new Date(now-86400001).toISOString()}}])assert.ok(automaticPreparationHold({...order,...change},now),JSON.stringify(change));
 assert.ok(automaticPreparationHold(null,now));
});
test('disabled worker performs no reads or purchases',async()=>{
 const worker=temuAutomaticPurchaseWorker({query(){throw Error('unexpected read');}},{},{},{enabled:()=>false});await worker.run();assert.equal(worker.running,false);
});
test('latest negative margin prevents buy claim',async()=>{
 let calls=0,bought=0;const saved=[];
 const plan={id:'p',currency:'EUR',amount:6,selected:1,expiresAt:now+60000,offers:[{channelId:1,shippingCompanyName:'GLS'}]};
 const db={async query(sql,args){
 if(sql.startsWith('INSERT INTO temu_automatic'))return {rows:[]};
 if(sql.startsWith('SELECT c.reference'))return {rows:[{reference:order.reference}]};
 if(sql.startsWith('SELECT * FROM orders'))return {rows:[order]};
 if(sql.startsWith('SELECT coalesce'))return {rows:[{lines:[]}]};
 if(sql.startsWith('SELECT o.id'))return {rows:[{id:'o'}]};
 if(sql.startsWith('UPDATE temu_automatic')){saved.push(JSON.parse(args[1]));return {rows:[]};}
 throw Error(sql);
 }};
 const local={async amounts(){return {};},async prepare(){return plan;},async buy(ref,id,amount,opts){await opts.beforeClaim(plan);bought++;return {status:'complete'};}};
 const margins={async get(options){assert.equal(options.fresh,true);calls++;return {calculatedAt:new Date().toISOString(),rows:[{reference:order.reference,status:calls===1?'positive':'negative',profit:calls===1?1:-1,shipping:5,shippingSource:'Devis TEMU final',issues:[]}]};}};
 await temuAutomaticPurchaseWorker(db,local,margins,{stockGate:async()=>{}}).run();assert.equal(calls,2);assert.equal(bought,0);assert.equal(saved[0].status,'held');assert.match(saved[0].message,/confirmer/);
});
