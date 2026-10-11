import test from 'node:test';
import assert from 'node:assert/strict';
import {excludedTemuCarrier,automaticTemuMarginDecision} from '../src/temu-purchase-policy.mjs';
import {temuShipping} from '../src/temu-shipping.mjs';
const now=Date.now(),reference='PO-069-123456789';
const offer=(id,name,amount)=>({channelId:id,shipCompanyId:id,shipCompanyName:name,estimatedAmount:String(amount),estimatedCurrencyCode:'EUR'});
const detail={parentOrderMap:{parentOrderSn:reference,parentOrderStatus:2,expectShipLatestTime:Math.floor(now/1000)+86400},orderList:[{orderSn:'line-1',quantity:1}]};
function harness(offers){let job=null,bought=0,claimed=0;return {get job(){return job;},get bought(){return bought;},get claimed(){return claimed;},db:{async query(sql,args){
 if(sql.startsWith('SELECT suspension'))return {rows:[{suspension:{}}]};
 if(sql.startsWith('SELECT channel'))return {rows:[{channel:'temu',source_payload:{}}]};
 if(sql.startsWith('SELECT * FROM temu_label_jobs'))return {rows:job?[job]:[]};
 if(sql.startsWith('INSERT INTO temu_label_jobs(reference,status,plan)')){job={reference,status:'ready',plan:JSON.parse(args[1]),packages:[]};return {rows:[]};}
 if(sql.includes("SET status='purchasing'")){claimed++;job.status='purchasing';job.attempt_id=args[1];return {rows:[{reference}]};}
 if(sql.includes("SET status='uncertain'")){job.status='uncertain';return {rows:[]};}
 throw Error('Unexpected SQL '+sql);
 }},api:{canBuy:true,async buy(){bought++;throw Error('lost response');},async read(method){
 if(method==='bg.order.detail.v2.get')return detail;
 if(method==='bg.logistics.shipment.v2.get')return {shipmentInfoDTO:[]};
 if(method==='bg.logistics.warehouse.list.get')return {warehouseList:[{warehouseId:1,defaultWarehouse:true}]};
 if(method==='bg.logistics.shippingservices.get')return {onlineChannelDtoList:offers};
 throw Error('Unexpected provider read '+method);
 }}};}
test('Cainiao variants excluded; other carriers remain available',()=>{
 for(const name of ['Cainiao','CAINIAO France','cai niao','Cainiao-Express'])assert.ok(excludedTemuCarrier({shipCompanyName:name}));
 assert.ok(excludedTemuCarrier({shippingCompanyName:'CAINIAO'}));
 assert.equal(excludedTemuCarrier({shipCompanyName:'GLS'}),false);
});
test('quote skips all Cainiao offers and selects cheapest remaining',async()=>{
 const h=harness([offer(1,'Cainiao',1),offer(2,'Cainiao France',2),offer(3,'GLS',3),offer(4,'GOFO',4)]);
 const plan=await temuShipping(h.db,h.api).prepare(reference);assert.equal(plan.selected,3);assert.equal(plan.amount,3);assert.equal(h.bought,0);
 assert.ok(plan.offers[0].unavailableReason.includes('Cainiao'));
});
test('only Cainiao or explicit Cainiao selection never buys',async()=>{
 for(const [offers,selection] of [[[offer(1,'Cainiao',1)],undefined],[[offer(1,'Cainiao',1),offer(2,'GLS',2)],1]]){
 const h=harness(offers);await assert.rejects(temuShipping(h.db,h.api).prepare(reference,selection),/Aucun service/);assert.equal(h.bought,0);}
});
test('carrier changed to Cainiao after preview is rejected before claim',async()=>{
 const offers=[offer(1,'GLS',2)],h=harness(offers),s=temuShipping(h.db,h.api),p=await s.prepare(reference);
 offers[0].shipCompanyName='Cainiao';await assert.rejects(s.buy(reference,p.id,p.amount),/Aucun service/);assert.equal(h.claimed,0);assert.equal(h.bought,0);
});
test('final admission failure never claims or buys; uncertain attempt never replays',async()=>{
 const h=harness([offer(1,'GLS',2)]),s=temuShipping(h.db,h.api),p=await s.prepare(reference);
 await assert.rejects(s.buy(reference,p.id,p.amount,{beforeClaim:()=>{throw Error('Marge négative');}}),/Marge/);assert.equal(h.claimed,0);
 await assert.rejects(s.buy(reference,p.id,p.amount),/incertain/);assert.equal(h.bought,1);
 await assert.rejects(s.buy(reference,p.id,p.amount),/déjà tenté/);assert.equal(h.bought,1);
});
test('automatic decision uses exact fresh EUR quote and strictly positive complete margin',()=>{
 const plan={id:'p',currency:'EUR',amount:6,selected:1,expiresAt:now+60000,offers:[{channelId:1,shipCompanyName:'GLS'}]};
 const row={reference,status:'positive',profit:1,shipping:5,shippingSource:'Devis TEMU final',issues:[]};
 const snapshot={calculatedAt:new Date(now).toISOString(),rows:[row]};
 assert.ok(automaticTemuMarginDecision(snapshot,reference,plan,now).allowed);
 for(const change of [{status:'negative',profit:-1},{status:'zero',profit:0},{status:'incomplete'},{profit:NaN},{issues:['Prix manquant']},{shipping:4},{shippingSource:'Estimation TEMU'}])assert.equal(automaticTemuMarginDecision({...snapshot,rows:[{...row,...change}]},reference,plan,now).allowed,false);
 for(const change of [{expiresAt:now-1},{currency:'GBP'},{amount:NaN},{offers:[{channelId:1,shipCompanyName:'Cainiao'}]}])assert.equal(automaticTemuMarginDecision(snapshot,reference,{...plan,...change},now).allowed,false);
 assert.equal(automaticTemuMarginDecision({...snapshot,calculatedAt:new Date(now-61000).toISOString()},reference,plan,now).allowed,false);
});

test('atomic order guard refuses a changed command without provider purchase',async()=>{
 const h=harness([offer(1,'GLS',2)]),s=temuShipping(h.db,h.api),p=await s.prepare(reference);
 const original=h.db.query;let guarded=false;
 h.db.query=async(sql,args)=>{if(sql.includes("SET status='purchasing'")){guarded=sql.includes('o.erp_live=$5::jsonb')&&sql.includes('correction_jobs');return {rows:[]};}return original(sql,args);};
 await assert.rejects(s.buy(reference,p.id,p.amount,{beforeClaim:async()=>({orderProof:{id:'o',erpLive:{},sourcePayload:{},address:{},suspension:{},weight:null}})}),/modifiés/);
 assert.equal(guarded,true);assert.equal(h.bought,0);
});
