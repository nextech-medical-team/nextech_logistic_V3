import {resolveExcelTemuShop} from '../src/temu-excel-shop.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTemuExcelTestDatabase} from './support/temu-excel-db.mjs';
import {temuExcelPreparation,excelImportHold} from '../src/temu-excel-preparation.mjs';
import {buildBcPricing,sourceCurrency,verifySourceCommercialTotals} from '../src/bc-pricing.mjs';
import {ensureTemuBcPricing} from '../src/temu-bc-pricing.mjs';
import {temuSellerTotals} from '../src/temu-commercial-source.mjs';
import {automaticPreparationHold} from '../src/temu-automatic-purchase.mjs';
import {initializeTemuShipping,temuShipping} from '../src/temu-shipping.mjs';
import {shipmentFingerprint} from '../src/label-stock-gate.mjs';
const reference='PO-069-123456789',user={role:'manager',email:'fixture@example.invalid'};
async function fixture(t){
 const db=await createTemuExcelTestDatabase();t.after(()=>db.close());
 await db.exec(`ALTER TABLE orders ADD COLUMN erp_live jsonb NOT NULL DEFAULT '{}',ADD COLUMN weight_kg numeric,ADD COLUMN transport_choice text,ADD COLUMN partial_mode boolean DEFAULT false;
 ALTER TABLE lines ADD COLUMN target_sku text,ADD COLUMN target_quantity numeric;
 CREATE TABLE erp_live_jobs(order_id text,status text,error text);
 CREATE TABLE resolution_jobs(id text,order_id text,request_id text,action text,payload jsonb,status text DEFAULT 'queued',stage text DEFAULT 'En attente',error text,created_at timestamptz DEFAULT now());`);
 await initializeTemuShipping(db);
 await db.query("INSERT INTO orders(id,channel,reference,recipient,address,source_date,source_payload,suspension,tracking_status,resolution_pending_resume) VALUES('o','temu',$1,'Client fictif',$2,'2026-10-12',$3,$4,'not_shipped',true)",[reference,JSON.stringify({country:'HR',street:'Rue fictive',postal:'10000',city:'Ville'}),JSON.stringify({origin:'temu_excel',manualPreparationRequired:true}),JSON.stringify({active:true,note:excelImportHold,version:'initial'})]);
 const excel={'Prix de vente (hors taxes)':'67,25€','Total du prix de vente après réductions (hors taxes)':'67,25€','Taxe sur les produits':'16,80€',"Total de l'expédition (hors taxes)":'0€',"Taxe d'expédition":'0€'};
 await db.query("INSERT INTO lines(id,order_id,source_line,source_sku,quantity,source_payload,target_sku,target_quantity) VALUES('l','o','item','SKU',5,$1,'ERP-SKU',10)",[JSON.stringify({temuOrderSn:'item',excel})]);
 const now=Math.floor(Date.now()/1000),detail={parentOrderMap:{parentOrderSn:reference,parentOrderStatus:2,expectShipLatestTime:now+4*86400},orderList:[{orderSn:'item',orderStatus:2,quantity:5,productList:[{extCode:'SKU'}]}]};
 let bought=0;const calls=[],api={canBuy:true,async buy(){bought++;return {packageSnList:['PK-123']};},async pdf(){return Buffer.from('%PDF-fixture');},async read(method){calls.push(method);
  if(method==='bg.order.detail.v2.get')return detail;
  if(method==='bg.logistics.shipment.v2.get')return {shipmentInfoDTO:[]};
  if(method==='bg.logistics.warehouse.list.get')return {warehouseList:[{warehouseId:1,defaultWarehouse:true}]};
  if(method==='bg.logistics.shippingservices.get')return {onlineChannelDtoList:[{channelId:1,shipCompanyId:1,estimatedAmount:'2.50',estimatedCurrencyCode:'EUR',availablePickupTimeSlotList:[{pickupStartTime:now+86400,pickupEndTime:now+86401},{pickupStartTime:now+172800,pickupEndTime:now+172801},{pickupStartTime:now+500000,pickupEndTime:now+500001}]}]};
  if(method==='bg.logistics.shipment.result.get')return {packageInfoResultList:[{packageSn:'PK-123',shippingLabelStatus:1,orderSendInfoList:[{parentOrderSn:reference}]}]};
  if(method==='bg.logistics.shipment.document.get')return {shippingLabelUrlList:[{packageSn:'PK-123',documentType:'SHIPPING_LABEL_PDF',url:'https://example.invalid/label.pdf'}]};
  throw Error(method);
 }};
 const candidates=[{mallId:'123',api}],local={resolveExcelShop:(o,lines)=>resolveExcelTemuShop(o,lines,candidates)};
 const service=temuExcelPreparation(db,local),read=async()=>(await db.query("SELECT * FROM orders WHERE id='o'")).rows[0],lines=async()=>(await db.query("SELECT * FROM lines WHERE order_id='o' ORDER BY source_line,id")).rows;
 return {db,service,api,candidates,detail,read,lines,calls,now,get bought(){return bought;},async input(){const p=await service.preview(reference);return {reference,fingerprint:p.fingerprint,confirmPreparation:true};}};
}
test('production validation is explicit, atomic and idempotent; queues the existing resume action without a label purchase',async t=>{
 const f=await fixture(t),b=await f.input();assert.equal((await f.read()).suspension.active,true);assert.equal(f.calls.length,0);
 await assert.rejects(f.service.prepare(b,{...user,role:'operator'}),/Droits/);
 await assert.rejects(f.service.prepare({...b,confirmPreparation:false},user),/Confirmez/);
 const results=await Promise.all([f.service.prepare({...b,mallId:"untrusted-browser-value"},user),f.service.prepare(b,user)]);assert.equal(results.filter(r=>r.replayed).length,1);
 const resumed=await f.service.preview(reference);assert.equal((await f.service.prepare({...b,fingerprint:resumed.fingerprint},user)).replayed,true);
 const o=await f.read();assert.equal(o.suspension.active,false);assert.equal(o.source_payload.mallId,'123');assert.equal(o.resolution_pending_resume,true);assert.equal(o.source_payload.temuExcelCommercial.total,84.05);
 const jobs=(await f.db.query('SELECT * FROM resolution_jobs')).rows;assert.equal(jobs.length,1);assert.equal(jobs[0].action,'resume');assert.equal(jobs[0].payload.type,'resolved');assert.equal((await f.db.query('SELECT * FROM erp_live_jobs')).rows.length,0);assert.equal(f.bought,0);assert.match(automaticPreparationHold(o),/achat manuel/);
});
test('SKU, quantity, reference, cancellation and stale preview cannot release the import hold',async t=>{
 const f=await fixture(t),b=await f.input(),original=structuredClone(f.detail);
 for(const change of [d=>d.orderList[0].quantity=6,d=>d.orderList[0].productList[0].extCode='OTHER',d=>d.parentOrderMap.parentOrderSn='OTHER',d=>d.parentOrderMap.parentOrderStatus=3]){
  Object.assign(f.detail,structuredClone(original));change(f.detail);await assert.rejects(f.service.prepare(b,user));assert.equal((await f.read()).suspension.active,true);
 }
 Object.assign(f.detail,original);await f.db.query("UPDATE orders SET issue='Blocage indépendant' WHERE id='o'");await assert.rejects(f.service.prepare(await f.input(),user),/Blocage/);assert.equal((await f.read()).issue,'Blocage indépendant');await f.db.query("UPDATE orders SET issue=null WHERE id='o'");await f.db.query("UPDATE orders SET recipient='Autre client' WHERE id='o'");await assert.rejects(f.service.prepare(b,user),/modifiée/);assert.equal((await f.db.query('SELECT * FROM resolution_jobs')).rows.length,0);
});
test('automatic discovery holds missing, ambiguous and unreadable orders then retries without duplicate jobs',async t=>{
 const f=await fixture(t),input=await f.input(),owner={mallId:'123',api:f.api};
 const absent={mallId:'empty',api:{read:async()=>({parentOrderMap:{},orderList:[]})}};
 for(const candidates of [[],[absent],[owner,{...owner,mallId:'other'}],[owner,{mallId:'failed',api:{read:async()=>{throw Error('quota API');}}}]]){
  f.candidates.splice(0,f.candidates.length,...candidates);
  await assert.rejects(f.service.prepare(input,user),/introuvable|ambigu|quota/);
  assert.equal((await f.read()).suspension.active,true);
  assert.equal((await f.db.query('SELECT * FROM resolution_jobs')).rows.length,0);
  assert.equal(f.bought,0);
 }
 f.candidates.splice(0,f.candidates.length,absent,owner);
 await f.service.prepare(input,user);
 assert.equal((await f.read()).source_payload.mallId,'123');
 const before=f.calls.length;
 assert.equal((await f.service.prepare(input,user)).replayed,true);
 assert.equal(f.calls.length,before);
 assert.equal((await f.db.query('SELECT * FROM resolution_jobs')).rows.length,1);
 assert.equal(f.bought,0);
});
test('production worker uses Excel source totals and shared pricing, without API amounts or double multiplication',async t=>{
 const f=await fixture(t);await f.service.prepare(await f.input(),user);const o=await f.read(),lines=await f.lines();
 assert.equal(await ensureTemuBcPricing(f.db,o,lines,()=>assert.fail('No API amount request')),false);
 o.source_payload.temuAmounts={data:{parentOrderMap:{estimatedRevenue:{currency:'USD',amount:1}}}};
 assert.equal(sourceCurrency(o),'EUR');const pricing=buildBcPricing(o,lines,[{variant:{id:'1'},quantity:10}],[{id:'25',active:true,tax_rates:[{rate:25}]}]);assert.equal(pricing.total,84.05);assert.equal(pricing.tax,16.8);assert.equal(pricing.items[0].quantity,10);assert.equal(pricing.items[0].price,8.405);assert.equal(pricing.tax_type,'inclusive');
 assert.equal(temuSellerTotals(o).total,84.05);verifySourceCommercialTotals({total:84.05,currency:{label:'EUR'},line_items:[{tax_amount:16.8}]},temuSellerTotals(o));
 lines[0].quantity=10;await assert.rejects(ensureTemuBcPricing(f.db,o,lines,()=>assert.fail('No API amount request')),/modifiés/);
});
test('same TEMU shipping engine requires validated production BL, quotes 0.25 kg/latest slot, and buys once',async t=>{
 const f=await fixture(t);await f.service.prepare(await f.input(),user);const shipping=temuShipping(f.db,f.api);
 await assert.rejects(shipping.prepare(reference),/préparation à terminer/);
 await f.db.query("UPDATE orders SET resolution_pending_resume=false,weight_kg=5 WHERE id='o'");
 await assert.rejects(shipping.prepare(reference),/BL validé/);
 const proof=await shipmentFingerprint(f.db,await f.read()),at=new Date().toISOString();
 await f.db.query("UPDATE orders SET erp_live=$1 WHERE id='o'",[JSON.stringify({bc:{id:'bc'},bl:{id:'bl',status:'ready_to_ship'},verifiedAt:at,stockCheckedAt:at,labelPreparationFingerprint:proof})]);await f.db.query("INSERT INTO erp_live_jobs VALUES('o','complete',null)");
 const plan=await shipping.prepare(reference),parcel=plan.request.sendRequestList[0];assert.equal(parcel.weight,'0.25');assert.equal(parcel.length,'10.00');assert.equal(parcel.width,'8.00');assert.equal(parcel.height,'0.50');assert.equal(parcel.pickupStartTime,f.now+172800);assert.equal(f.bought,0);
 f.detail.orderList[0].quantity=4;await assert.rejects(shipping.buy(reference,plan.id,plan.amount),/quantités/);assert.equal(f.bought,0);f.detail.orderList[0].quantity=5;
 const result=await shipping.buy(reference,plan.id,plan.amount);assert.equal(result.status,'complete');assert.equal(f.bought,1);await assert.rejects(shipping.buy(reference,plan.id,plan.amount),/déjà tenté/);assert.equal(f.bought,1);
});
