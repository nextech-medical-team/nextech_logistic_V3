import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {initializeTemuShipping,temuShipping} from '../src/temu-shipping.mjs';
import {temuLocalService} from '../src/temu-local.mjs';
import {temuAutomaticPurchaseWorker,automaticPreparationHold} from '../src/temu-automatic-purchase.mjs';
let db;after(async()=>{if(db)await db.close();});
const reference='PO-108-08320568412790292';
async function fixture({profit=10.81,initial='api_error',suspension={},beforeClaim=async()=>{},failBuy=false,providerPackage=false}={}){
 if(!db){db=new PGlite();await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,reference text UNIQUE,channel text,archived boolean DEFAULT false,simulation boolean DEFAULT true,partial_mode boolean DEFAULT false,resolution_pending_resume boolean DEFAULT true,issue text,transport_choice text,erp_live jsonb DEFAULT '{}',source_payload jsonb DEFAULT '{}',address jsonb DEFAULT '{}',suspension jsonb DEFAULT '{}',weight_kg numeric,tracking_status text,label_status text);
 CREATE TABLE lines(id text,order_id text,source_line text,source_sku text,target_sku text,target_quantity numeric,quantity numeric,source_payload jsonb);
 CREATE TABLE erp_live_jobs(order_id text,status text,error text);CREATE TABLE resolution_jobs(id text,order_id text,status text);CREATE TABLE correction_jobs(id text,order_id text,status text);
 CREATE TABLE carrier_jobs(order_id text);CREATE TABLE carrier_documents(order_id text);CREATE TABLE extra_parcels(order_id text);
 CREATE TABLE mappings(channel text,source_sku text,target_sku text,source_qty numeric,target_qty numeric);CREATE TABLE catalog_results(sku text,message text);CREATE TABLE audit(user_email text,action text,detail jsonb);
 CREATE TABLE temu_automatic_purchase_audit(attempt_id text PRIMARY KEY,reference text,plan_id text,decision jsonb);`);await initializeTemuShipping(db);}
 else await db.exec('TRUNCATE orders,lines,erp_live_jobs,resolution_jobs,correction_jobs,carrier_jobs,carrier_documents,extra_parcels,temu_label_documents,temu_label_jobs,temu_automatic_purchase_audit,audit');
 const erp={bc:{id:1949149,label:'C0015986',status:'active'},phase:'bc_created',stockIncidentRecheck:{currentError:'Stock insuffisant IP26211 : 0 utilisable'}};
 const source={origin:'temu_excel',mallId:'shop',visibilityHold:true,temuExcelCommercial:{total:1},temuDirect:{state:'verified'}};
 await db.query(`INSERT INTO orders(id,reference,channel,issue,erp_live,source_payload,suspension,address,weight_kg,tracking_status,label_status) VALUES('o',$1,'temu','Ancien refus préparation',$2,$3,$4,'{"country":"LV"}',0.2,'not_shipped','simulated')`,[reference,JSON.stringify(erp),JSON.stringify(source),JSON.stringify(suspension)]);
 await db.exec("INSERT INTO erp_live_jobs VALUES('o','review','Stock insuffisant');INSERT INTO resolution_jobs VALUES('old','o','review')");
 await db.query(`INSERT INTO lines VALUES('l','o','item','IP26211',null,null,1,'{"excel":{}}')`);
 if(initial)await db.query('INSERT INTO temu_label_jobs(reference,status) VALUES($1,$2)',[reference,initial]);
 let buys=0,reads=[],marginsRead=0;
 const detail={parentOrderMap:{parentOrderSn:reference,parentOrderStatus:2,expectShipLatestTime:Math.floor(Date.now()/1000)+86400},orderList:[{orderSn:'item',quantity:1,productList:[{extCode:'IP26211'}],packageSnInfo:providerPackage?[{packageSn:'PK-123'}]:[]}]};
 const api={canBuy:true,async buy(){buys++;if(failBuy)throw Error('Network response uncertain');return {packageSnList:['PK-123']};},async pdf(){return Buffer.from('%PDF-provider-unchanged');},async read(method){reads.push(method);
  if(method==='bg.open.accesstoken.info.get')return {mallId:'shop'};
  if(method==='bg.order.detail.v2.get')return detail;
  if(method==='bg.logistics.shipment.v2.get')return {shipmentInfoDTO:[]};
  if(method==='bg.logistics.warehouse.list.get')return {warehouseList:[{warehouseId:1,defaultWarehouse:true}]};
  if(method==='bg.logistics.shippingservices.get')return {onlineChannelDtoList:[{channelId:1,shipCompanyId:1,shippingCompanyName:'FedEx',estimatedAmount:'6.65',estimatedCurrencyCode:'EUR'}]};
  if(method==='bg.logistics.shipment.result.get')return {packageInfoResultList:[{packageSn:'PK-123',shippingLabelStatus:1,orderSendInfoList:[{parentOrderSn:reference,orderSn:'item',quantity:1}],trackingNumber:'TRACK',estimatedAmount:'6.65',estimatedCurrencyCode:'EUR'}]};
  if(method==='bg.logistics.shipment.document.get')return {shippingLabelUrlList:[{packageSn:'PK-123',documentType:'SHIPPING_LABEL_PDF',url:'https://example.invalid/label.pdf'}]};
  if(method==='temu.track.trackinginfo.get')return {packageSn:'PK-123',trackingNum:'TRACK',trackingInfo:[]};
  throw Error('Unexpected API '+method);
 }};
 const local=temuLocalService(db,'unused',{apiFactory:()=>api,shopLoader:async()=>[],configLoader:async()=>({TEMU_APP_KEY:'fixture',TEMU_APP_SECRET:'fixture',TEMU_ACCESS_TOKEN:'fixture'})});
 const margins={async get(){marginsRead++;await beforeClaim(marginsRead);return {calculatedAt:new Date().toISOString(),rows:[{reference,status:profit==null?'incomplete':profit>0?'positive':'negative',profit,shipping:6.65/1.2,shippingSource:'Devis TEMU final',issues:[]}]};}};
 const worker=temuAutomaticPurchaseWorker(db,local,margins,{stockGate(){assert.fail('No stock gate');},refreshPreparation(){assert.fail('No ERP refresh');}});
 return {worker,local,api,erp,source,detail,get buys(){return buys;},get marginsRead(){return marginsRead;},reads,read:async()=>(await db.query("SELECT * FROM orders WHERE id='o'")).rows[0]};
}
test('LV historical Excel order: native local API buys with positive margin before BL, despite stock review/simulation/stale commercial validation; no ERP mutation',async()=>{
 const f=await fixture();const before=await f.read();assert.equal(automaticPreparationHold(before),null);
 const r=await f.worker.process(reference);assert.equal(r.status,'complete');assert.equal(f.buys,1);assert.equal(f.marginsRead,2);
 const after=await f.read();assert.deepEqual(after.erp_live,before.erp_live);assert.equal(after.simulation,true);assert.equal(after.issue,before.issue);assert.equal(after.resolution_pending_resume,true);
 assert.deepEqual(Buffer.from((await db.query('SELECT pdf FROM temu_label_documents')).rows[0].pdf),Buffer.from('%PDF-provider-unchanged'));
 const audit=(await db.query('SELECT decision FROM temu_automatic_purchase_audit')).rows;assert.equal(audit.length,1);assert.equal(audit[0].decision.policy,'positive-margin-without-bl-v2');
 await assert.rejects(f.worker.process(reference),/existante|rapprocher/);assert.equal(f.buys,1);
});
for(const profit of [0,-1,null])test(`margin ${profit} never buys without BL`,async()=>{
 const f=await fixture({profit});await assert.rejects(f.worker.process(reference),/confirmer/);assert.equal(f.buys,0);assert.equal((await db.query('SELECT attempt_id FROM temu_label_jobs')).rows[0].attempt_id,null);
});
test('source or costs changed during final margin check cannot claim the earlier financial proof',async()=>{
 const f=await fixture({beforeClaim:async n=>{if(n===2)await db.query("UPDATE lines SET quantity=2 WHERE id='l'");}});
 await assert.rejects(f.worker.process(reference),/modifiés/);assert.equal(f.buys,0);
});
test('concurrent ERP preparation changes do not become a label prerequisite',async()=>{
 const f=await fixture({beforeClaim:async n=>{if(n===2)await db.query("UPDATE orders SET erp_live=erp_live||'{\"bl\":{\"id\":\"new\",\"status\":\"pending\"}}' WHERE id='o'");}});
 await f.worker.process(reference);assert.equal(f.buys,1);
});
test('failed purchase becomes uncertain and cannot be retried or cleared by historical recovery',async()=>{
 const f=await fixture({failBuy:true});await assert.rejects(f.worker.process(reference),/incertain/);assert.equal(f.buys,1);
 await assert.rejects(f.worker.process(reference),/existant|tentative|confirmer|vérifier|Achat/);assert.equal(f.buys,1);
});
test('supplier existing package is recovered before amounts/margin; never bought again',async()=>{
 const f=await fixture({providerPackage:true,profit:null});const r=await f.worker.process(reference);assert.equal(r.status,'complete');assert.equal(f.buys,0);assert.equal(f.marginsRead,0);
});
test('explicit suspension and every other channel remain ineligible regardless of profit',async()=>{
 const f=await fixture({suspension:{active:true,note:'human stop'}});await assert.rejects(f.worker.process(reference),/suspendue/);assert.equal(f.reads.length,0);assert.equal(f.buys,0);
 for(const channel of ['amazon','shopify','tender'])assert.ok(automaticPreparationHold({...await f.read(),channel,suspension:{}}));
});

for(const status of ['cancelled','shipped','delivered'])test('recorded terminal BL '+status+' prevents purchase before and during financial claim',async()=>{
 let f=await fixture();await db.query("UPDATE orders SET erp_live=erp_live||jsonb_build_object('bl',jsonb_build_object('id','BL','status',$1::text)) WHERE id='o'",[status]);
 await assert.rejects(f.worker.process(reference),/annulé|expédié/);assert.equal(f.buys,0);assert.equal(f.reads.length,0);
 f=await fixture({beforeClaim:async n=>{if(n===2)await db.query("UPDATE orders SET erp_live=erp_live||jsonb_build_object('bl',jsonb_build_object('id','BL','status',$1::text)) WHERE id='o'",[status]);}});
 await assert.rejects(f.worker.process(reference),/annulé|expédié/);assert.equal(f.buys,0);assert.equal((await db.query('SELECT attempt_id FROM temu_label_jobs')).rows[0].attempt_id,null);
});
