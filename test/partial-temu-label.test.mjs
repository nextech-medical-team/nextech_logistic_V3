import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {partialTemuLabelService,partialTemuLines,readyPartialBl} from '../src/partial-temu-label.mjs';
import {initializePartialDeliveries,partialService} from '../src/partial-deliveries.mjs';
import {temuShipping} from '../src/temu-shipping.mjs';

const ref='PO-100-200',bl={id:30,label:'SHO00000030',status:'pending'},selection=[{lineId:'20',variantId:'60',locationId:'70',sku:'BOX',quantity:50,ordered:50},{lineId:'21',variantId:'61',locationId:'70',sku:'B',quantity:1,ordered:1}];
async function fixture(){
 const e=new PGlite(),db={query:(...a)=>e.query(...a),exec:(...a)=>e.exec(...a),transaction:fn=>e.transaction(t=>fn({query:(...a)=>t.query(...a)}))};
 await e.exec(`CREATE TABLE orders(id text primary key,reference text,channel text,partial_mode boolean,source_payload jsonb,erp_live jsonb,suspension jsonb,archived boolean default false,tracking_status text,label_status text,transport_choice text,weight_kg numeric);
 CREATE TABLE lines(id text,order_id text,source_line text,source_sku text,target_sku text,quantity numeric,target_quantity numeric,source_payload jsonb);
 CREATE TABLE products(sku text,weight_kg numeric);
 CREATE TABLE erp_live_jobs(order_id text,status text);CREATE TABLE correction_jobs(order_id text,status text);CREATE TABLE resolution_jobs(order_id text,status text);
 CREATE TABLE temu_label_jobs(reference text,status text,attempt_id text,packages jsonb);
 CREATE TABLE temu_label_documents(reference text,package text,pdf bytea);`);
 await initializePartialDeliveries(db);
 await e.query('INSERT INTO orders VALUES($1,$2,$3,true,$4,$5,$6,false,$7,$8,null,0.25)',['o',ref,'temu',JSON.stringify({temuLabelPurchaseConfirmationRequired:true}),JSON.stringify({bc:{id:'10',status:'active'}}),'{}','unknown','partial']);
 for(const [id,sku] of [['s1','BOX'],['s2','B'],['s3','REMAINDER']])await e.query('INSERT INTO lines VALUES($1,$2,$1,$3,null,1,null,$4)',[id,'o',sku,JSON.stringify({temuOrderSn:id,marketplaceQuantity:1})]);
 await e.exec("INSERT INTO products VALUES('BOX',0.005),('B',0.005)");
 await e.query("INSERT INTO partial_deliveries(id,order_id,request_id,status,stage,selection,bl,label_choice,environment,carrier) VALUES('d','o','request','bl_only','bl_only',$1,$2,'bl_only_temu','production','temu')",[JSON.stringify(selection),JSON.stringify(bl)]);
 let providerStatus='pending',packages=[],lostBuy=false,readFailure=false,documentPending=false,amount=2.40;const calls=[],erplainCalls=[];
 const detail=()=>({parentOrderMap:{parentOrderSn:ref,parentOrderStatus:2,orderPaymentType:'PPD',expectShipLatestTime:Math.floor(Date.now()/1000)+100000},orderList:['s1','s2','s3'].map(orderSn=>({orderSn,quantity:1,orderPaymentType:'PPD',packageSnInfo:packages.map(packageSn=>({packageSn}))}))});
 const parcel=()=>({packageSn:'PK-123',shippingLabelStatus:1,trackingNumber:'TRACK',shippingCompanyName:'Partner',orderSendInfoList:[{parentOrderSn:ref,orderSn:'s1',quantity:1},{parentOrderSn:ref,orderSn:'s2',quantity:1}]});let parcelList=[parcel()];
 const api={canBuy:true,read:async(type,args)=>{calls.push({type,args});if(readFailure)throw Error('TEMU HTTP 429');
  if(type==='bg.order.detail.v2.get')return detail();
  if(type==='bg.logistics.shipment.v2.get')return {shipmentInfoDTO:packages.map(packageSn=>({packageSn,parentOrderSn:ref}))};
  if(type==='bg.logistics.shipment.result.get')return {packageInfoResultList:parcelList};
  if(type==='bg.logistics.warehouse.list.get')return {warehouseList:[{warehouseId:'W',defaultWarehouse:true}]};
  if(type==='bg.logistics.shippingservices.get')return {onlineChannelDtoList:[{channelId:11,shipCompanyId:22,estimatedAmount:String(amount),estimatedCurrencyCode:'EUR',shipCompanyName:'Partner'}]};
  if(type==='bg.logistics.shipment.document.get')return {shippingLabelUrlList:documentPending?[]:[{packageSn:'PK-123',documentType:'SHIPPING_LABEL_PDF',url:'https://example.invalid/label.pdf'}]};
  assert.fail(type);
 },buy:async request=>{calls.push({type:'buy',request});packages=['PK-123'];if(lostBuy)throw Error('timeout after supplier accepted');return {packageSnList:packages};},pdf:async()=>{calls.push({type:'pdf'});return Buffer.from('%PDF-1.4 preserved supplier');}};
 const erplain={request:async(q,v)=>{erplainCalls.push({q,v});if(q.startsWith('mutation')){assert.equal(providerStatus,'pending');assert.deepEqual(Object.keys(v.input).sort(),['label','status']);providerStatus='ready_to_ship';return {UpdateShippingOrder:{...bl,status:providerStatus}};}return {ShippingOrder:{...bl,status:providerStatus}};}};
 const service=partialTemuLabelService(db,{partialApi:async(reference,id)=>{assert.equal(reference,ref);assert.equal(id,'d');return api;}},erplain,{preserveLabels:async()=>{}});
 const row=async()=>(await e.query("SELECT * FROM partial_deliveries WHERE id='d'")).rows[0];
 return {e,db,api,service,row,calls,erplainCalls,detail,parcel,erplain,setStatus:x=>providerStatus=x,setPackages:x=>packages=x,setParcels:x=>parcelList=x,setLostBuy:x=>lostBuy=x,setReadFailure:x=>readFailure=x,setDocumentPending:x=>documentPending=x,setAmount:x=>amount=x};
}

test('published partial BL chains status-only ready and an exact TEMU quote; no stock/BC/mapping gate or purchase',async()=>{const f=await fixture();try{
 const result=await f.service.advance('d'),d=await f.row();assert.equal(result.status,'temu_confirm',d.error);assert.equal(d.bl.status,'ready_to_ship');assert.equal(d.temu_label.plan.amount,2.4);
 const quote=f.calls.find(c=>c.type==='bg.logistics.shippingservices.get');assert.deepEqual(quote.args.shipOrderInfoList,[{parentOrderSn:ref,orderSn:'s1',quantity:1},{parentOrderSn:ref,orderSn:'s2',quantity:1}]);assert.equal(quote.args.weight,'0.255');assert(!f.calls.some(c=>c.type==='buy'));assert.equal(f.erplainCalls.filter(c=>c.q.startsWith('mutation')).length,1);assert(!f.erplainCalls.some(c=>/StockRemoval|Order\(id/.test(c.q)&&!c.q.includes('ShippingOrder')));
 await f.service.advance('d');assert.equal(f.erplainCalls.filter(c=>c.q.startsWith('mutation')).length,1);
}finally{await f.e.close();}});

test('confirmation buys once, archives the unchanged PDF and ends ready with the same BL and stock',async()=>{const f=await fixture();try{
 await f.service.advance('d');const plan=(await f.row()).temu_label.plan;
 await assert.rejects(f.service.buy('d',plan.id,plan.amount,false),/Confirmation explicite/);assert(!f.calls.some(c=>c.type==='buy'));
 const result=await f.service.buy('d',plan.id,plan.amount,true);assert.equal(result.status,'ready',(await f.row()).error);const d=await f.row();assert.equal(d.bl.id,30);assert.deepEqual(d.tracking,['TRACK']);assert.equal(d.temu_label.state,'paid');assert.equal(d.stock_document,null);const docs=(await f.e.query('SELECT pdf FROM partial_documents')).rows;assert.equal(Buffer.from(docs[0].pdf).toString(),'%PDF-1.4 preserved supplier');
 await assert.rejects(f.service.buy('d',plan.id,plan.amount,true));await f.service.advance('d');assert.equal(f.calls.filter(c=>c.type==='buy').length,1);assert.equal(f.calls.filter(c=>c.type==='pdf').length,1);
}finally{await f.e.close();}});

test('forbidden in_preparation never changes ERPLAIN and never blocks quote, purchase or PDF',async()=>{const f=await fixture();try{
 f.setStatus('in_preparation');await f.service.advance('d');let d=await f.row();assert.equal(d.status,'temu_confirm');assert.match(d.temu_label.readyError,/interdit/);const plan=d.temu_label.plan;
 await f.service.buy('d',plan.id,plan.amount,true);d=await f.row();assert.equal(d.status,'temu_ready_review');assert.deepEqual(d.tracking,['TRACK']);assert.equal((await f.e.query('SELECT count(*) n FROM partial_documents')).rows[0].n,1);assert(!f.erplainCalls.some(c=>c.q.startsWith('mutation')));
 f.setStatus('pending');await f.service.advance('d');assert.equal((await f.row()).status,'ready');assert.equal(f.calls.filter(c=>c.type==='buy').length,1);assert.equal(f.calls.filter(c=>c.type==='pdf').length,1);
}finally{await f.e.close();}});

test('lost supplier response recovers the accepted parcel after restart without repurchase',async()=>{const f=await fixture();try{
 await f.service.advance('d');const plan=(await f.row()).temu_label.plan;f.setLostBuy(true);await assert.rejects(f.service.buy('d',plan.id,plan.amount,true),/incertain/);assert.equal((await f.row()).temu_label.state,'uncertain');await f.service.advance('d');assert.equal((await f.row()).status,'ready');assert.equal(f.calls.filter(c=>c.type==='buy').length,1);
}finally{await f.e.close();}});

test('uncertain result with no parcel never becomes a new purchasable quote',async()=>{const f=await fixture();try{
 await f.service.advance('d');const plan=(await f.row()).temu_label.plan;f.setLostBuy(true);await assert.rejects(f.service.buy('d',plan.id,plan.amount,true));f.setPackages([]);await f.service.advance('d');const d=await f.row();assert.equal(d.status,'temu_wait');assert.match(d.error,/incertain/);assert.equal(d.temu_label.attemptId.length,36);await assert.rejects(f.service.buy('d',plan.id,plan.amount,true));assert.equal(f.calls.filter(c=>c.type==='buy').length,1);
}finally{await f.e.close();}});

test('existing exact supplier label is recovered before any quote, amount read or buy',async()=>{const f=await fixture();try{
 f.setPackages(['PK-123']);await f.service.advance('d');assert.equal((await f.row()).status,'ready');assert(!f.calls.some(c=>['buy','bg.logistics.shippingservices.get','bg.order.amount.query'].includes(c.type)));
}finally{await f.e.close();}});

test('pending PDF and read quota keep the paid attempt, resume the same package and preserve documents',async()=>{const f=await fixture();try{
 f.setPackages(['PK-123']);f.setDocumentPending(true);await f.service.advance('d');assert.equal((await f.row()).status,'temu_wait');f.setReadFailure(true);await f.service.advance('d');assert.match((await f.row()).error,/429/);f.setReadFailure(false);f.setDocumentPending(false);await f.service.advance('d');assert.equal((await f.row()).status,'ready');assert(!f.calls.some(c=>c.type==='buy'));
}finally{await f.e.close();}});

test('overlapping, incomplete or foreign shipments fail closed without quote or buy',async()=>{for(const type of ['overlap','incomplete','foreign']){const f=await fixture();try{
 f.setPackages(['PK-123']);f.setParcels(type==='incomplete'?[]:[{...f.parcel(),orderSendInfoList:type==='foreign'?[{parentOrderSn:'PO-999-999',orderSn:'s1',quantity:1}]:[{parentOrderSn:ref,orderSn:'s1',quantity:1}]}]);await f.service.advance('d');assert.equal((await f.row()).status,'temu_wait');assert(!f.calls.some(c=>['buy','bg.logistics.shippingservices.get'].includes(c.type)));
}finally{await f.e.close();}}});

test('expired, changed price or changed selected quantity never sends a purchase',async()=>{for(const kind of ['expired','price','quantity']){const f=await fixture();try{
 await f.service.advance('d');const p=(await f.row()).temu_label.plan;
 if(kind==='expired')await f.e.exec("UPDATE partial_deliveries SET temu_label=jsonb_set(temu_label,'{plan,expiresAt}','1')");
 if(kind==='price')f.setAmount(3.4);
 if(kind==='quantity')await f.e.exec("UPDATE partial_deliveries SET selection=jsonb_set(selection,'{0,quantity}','25')");
 await assert.rejects(f.service.buy('d',p.id,p.amount,true));assert(!f.calls.some(c=>c.type==='buy'));
}finally{await f.e.close();}}});

test('suspension and provider cancellation prevent purchase; no direct carrier fallback exists',async()=>{for(const kind of ['suspension','cancelled']){const f=await fixture();try{
 if(kind==='suspension'){await f.e.exec("UPDATE orders SET suspension='{\"active\":true}'");await assert.rejects(f.service.advance('d'));}
 else {f.setStatus('cancelled');await f.service.advance('d');assert.equal((await f.row()).status,'temu_ready_review');}
 assert.equal(f.calls.length,0);assert(!f.erplainCalls.some(c=>c.q.startsWith('mutation')));
}finally{await f.e.close();}}});

test('actual partial worker rediscovers the old BL-only row and respects the persistent nextAt',async()=>{const f=await fixture();try{
 const worker=partialService(f.db,'unused',{api:f.erplain,temu:f.service});await worker.run();assert.equal((await f.row()).status,'temu_confirm');const calls=f.calls.length;await worker.run();assert.equal(f.calls.length,calls);
 await f.e.exec("UPDATE partial_deliveries SET status='temu_wait',temu_label=jsonb_set(temu_label,'{nextAt}',to_jsonb('2099-01-01T00:00:00Z'::text))");await worker.run();assert.equal(f.calls.length,calls);
}finally{await f.e.close();}});

test('supplier sale units cannot be fractional or matched ambiguously',()=>{
 const o={reference:ref},d={selection:[selection[0]]},source=[{source_line:'s1',source_sku:'BOX',quantity:1,source_payload:{}}],detail={orderList:[{orderSn:'s1',quantity:1}]};assert.equal(partialTemuLines(o,d,source,detail)[0].quantity,1);assert.throws(()=>partialTemuLines(o,{selection:[{...selection[0],quantity:25}]},source,detail),/unités TEMU/);assert.throws(()=>partialTemuLines(o,d,[...source,...source],detail),/identifiable/);
});

test('ready status fails closed on unknown source and never rewrites an already-ready BL',async()=>{
 let mutations=0;for(const status of [undefined,'unknown','in_preparation'])await assert.rejects(readyPartialBl({request:async q=>{if(q.startsWith('mutation'))mutations++;return {ShippingOrder:{...bl,status}};}},bl));
 await readyPartialBl({request:async()=>({ShippingOrder:{...bl,status:'ready_to_ship'}})},bl);assert.equal(mutations,0);
});

test('a whole-order TEMU purchase cannot bypass the partial parcel path',async()=>{const f=await fixture();try{
 await assert.rejects(temuShipping(f.db,f.api).prepare(ref),/livraison partielle/);assert.equal(f.calls.length,0);
}finally{await f.e.close();}});

test('another uncertain partial attempt and an active business write prevent purchase',async()=>{const f=await fixture();try{
 await f.e.query("INSERT INTO partial_deliveries(id,order_id,request_id,status,selection,label_choice,temu_label) VALUES('other','o','other','temu_wait','[]','bl_only_temu',$1)",[JSON.stringify({attemptId:'unknown',state:'uncertain'})]);await f.service.advance('d');assert.match((await f.row()).error,/autre livraison partielle incertain/);assert(!f.calls.some(c=>c.type==='buy'));
 await f.e.exec("DELETE FROM partial_deliveries WHERE id='other'");await f.service.advance('d');const p=(await f.row()).temu_label.plan;await f.e.exec("INSERT INTO correction_jobs VALUES('o','applying')");await assert.rejects(f.service.buy('d',p.id,p.amount,true),/Traitement en cours/);assert(!f.calls.some(c=>c.type==='buy'));assert.equal((await f.row()).temu_label.attemptId,undefined);
}finally{await f.e.close();}});

test('existing label editions are frozen before the status mutation and skipped on no-op',async()=>{
 const events=[];let status='pending';const api={request:async q=>{if(q.startsWith('mutation')){events.push('mutation');status='ready_to_ship';}return {ShippingOrder:{...bl,status}};}};
 await readyPartialBl(api,bl,{beforeChange:async()=>events.push('preserve')});await readyPartialBl(api,bl,{beforeChange:async()=>events.push('unexpected')});assert.deepEqual(events,['preserve','mutation']);
});
