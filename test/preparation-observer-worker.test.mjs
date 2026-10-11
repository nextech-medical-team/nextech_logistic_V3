import assert from 'node:assert/strict';
import fs from 'node:fs';
import {preparationObserverWorker} from '../src/preparation-observer-worker.mjs';
const clock=Date.parse('2026-10-11T10:15:00Z');
let checks=0;const check=(value,message)=>{assert(value,message);checks++;};
async function scenario({race=false,changed=false,processing=false,active=false,fail=false,limit=50}={}){
 const orders=['a','b'].map(id=>({id,reference:id,erp_status:'live_review',erp_live:{phase:'starting'},suspension:{}}));
 let reads=0,writes=0,locked=false;const saved=[];
 const query=async(sql,args=[])=>{
  if(sql.startsWith('SELECT m.order_id'))return {rows:orders.map(o=>({order_id:o.id,requested:1}))};
  const order=orders.find(o=>o.id===args[0]);
  if(sql.startsWith('SELECT * FROM orders')){locked=sql.includes('FOR UPDATE');return {rows:[structuredClone(order)]};}
  if(sql.startsWith('SELECT status,error'))return {rows:[{status:processing?'processing':'review',error:null}]};
  if(sql.startsWith('SELECT id FROM resolution_jobs'))return {rows:active?[{id:'active'}]:[]};
  if(sql.startsWith('SELECT l.source_sku'))return {rows:[{source:'SKU',sku:'SKU',quantity:changed&&locked?2:1,mappingPresent:true}]};
  if(sql.startsWith('UPDATE order_recheck_monitor')){writes++;if(race)return {rows:[]};saved.push(JSON.parse(args[2]));return {rows:[{order_id:args[0]}]};}
  throw Error('Forbidden or unexpected SQL: '+sql);
 };
 const db={query,withLocks:async(_,fn)=>fn(),transaction:async fn=>fn({query})};
 const worker=preparationObserverWorker(db,{now:()=>clock,locationForOrder:()=>100934,maxProducts:limit,readDocument:()=>{throw Error('unexpected document read');},findDocument:async()=>({complete:true,found:null}),readProduct:async()=>{reads++;if(fail)throw Error('429');return {status:'active',lookupProof:{responseComplete:true},variant:{id:1,sku:'SKU',active:true,product:{active:true},stock_levels:{data:[{location:{id:100934},available:0,on_hand:0}],paginatorInfo:{hasMorePages:false}}}};}});
 const out=await worker.run();check(!worker.running,'running flag cleared');return {out,reads,writes,saved};
}
let r=await scenario();check(r.out.persisted===2&&r.reads===1,'shared SKU read once');check(r.saved.every(o=>o.business[0].code==='stock-insufficient'),'stock diagnostics persisted');check(r.saved.every(o=>!o.processing.completed&&!o.continuationEligible),'no business completion');
r=await scenario({race:true});check(r.out.persisted===0&&r.out.deferred===2,'requested version prevents stale writes');
r=await scenario({changed:true});check(r.writes===0&&r.out.deferred===2,'changed mapping/quantity prevents write');
r=await scenario({processing:true});check(r.reads===0&&r.writes===0,'processing protected');
r=await scenario({active:true});check(r.reads===0&&r.writes===0,'active resolution protected');
r=await scenario({fail:true});check(r.reads===1&&r.saved.every(o=>o.technical[0].code==='source-read-failed'),'failing product read shared and technical');
r=await scenario({limit:0});check(r.reads===0&&r.saved.every(o=>o.technical[0].code==='stale-product'),'budget exhaustion does not prove stock');
const proof={passed:true,checks,scenarios:7,noSupplierWrites:true,noJobWrites:true,at:new Date().toISOString(),scope:'isolated worker contracts; installed integration not verified'};
console.log(JSON.stringify(proof));
