import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {recoverDocumentsAndLabels} from '../src/recovered-bl-label.mjs';
import {existingBlShipment,queueExistingBlLabel} from '../src/existing-bl-label.mjs';
import {initializePartialDeliveries,partialService} from '../src/partial-deliveries.mjs';
import {resolveImportedLabelOrder} from '../src/erplain-label-required.mjs';

const address={label:'Client',address_1:'1 rue Test',city:'Paris',postal_code:'75001',country:'FR',phone:'0600000000'};
const line={id:'10',type:'normal',quantity:2,price:4,variant:{id:'20',sku:'SKU',track_inventory:true},location:{id:'30'}};
const blLine={...line,id:'11',parent_id:'10',quantity:1};
const first={id:'101',label:'SHO00743398',status:'delivered',line_items:[blLine]};
const second={id:'102',label:'SHO00745173',status:'pending',shipping_address:address,line_items:[blLine]};
const bc={id:'100',status:'active',label:'C00014220',shipping_address:address,line_items:[line],shipping_orders:{data:[first,second],paginatorInfo:{hasMorePages:false}}};
const order={id:'o',channel:'amazon',reference:'SYNTHETIC',tracking_status:'delivered',erp_live:{bc:{id:'100',status:'active'},bl:first},address:{country:'FR'}};

test('associated BL action targets the pending BL, not the delivered one',async()=>{
 const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const code=app.split('\n').find(line=>line.startsWith('function erplainBlHistoryHtml('));
 const context={user:{role:'operator'},esc:String,erpStatusText:String,cancelledStockRestoreHtml:()=>''};vm.createContext(context);vm.runInContext(code,context);
 const html=context.erplainBlHistoryHtml({...order,erp_live:{...order.erp_live,bc}});
 assert.match(html,/data-existing-bl-label="102"/);assert.doesNotMatch(html,/data-existing-bl-label="101"/);
 context.user.role='viewer';assert.doesNotMatch(context.erplainBlHistoryHtml({...order,erp_live:{...order.erp_live,bc}}),/data-existing-bl-label/);
});

test('only the selected pending BL supplies quantities and address',()=>{
 const result=existingBlShipment(order,bc,'102');assert.equal(result.selection[0].quantity,1);assert.equal(result.address.postal,'75001');
 for(const status of ['delivered','shipped','completed','cancelled','unpublished'])assert.throws(()=>existingBlShipment(order,{...bc,shipping_orders:{...bc.shipping_orders,data:[first,{...second,status}]}},'102'),/BL absent/);
 assert.throws(()=>existingBlShipment(order,bc,'999'),/BL absent/);
 assert.throws(()=>existingBlShipment({...order,suspension:{active:true,note:'Test'}},bc,'102'),/suspendue/);
 assert.throws(()=>existingBlShipment(order,{...bc,line_items:[{...line,quantity:1}]},'102'),/reliquat/);
});

async function fixture(fn){
 const engine=new PGlite();await engine.waitReady;const wrap=e=>({query:(s,p=[])=>e.query(s,p),exec:s=>e.exec(s)});
 const db={...wrap(engine),transaction:fn=>engine.transaction(tx=>fn(wrap(tx))),recoverInterrupted:false};
 try{
  await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,channel text,reference text,tracking_status text,erp_live jsonb,address jsonb,suspension jsonb DEFAULT '{}',archived boolean DEFAULT false,source_payload jsonb DEFAULT '{}',carrier text);
   CREATE TABLE carrier_jobs(order_id text,status text,tracking jsonb);
   CREATE TABLE carrier_documents(order_id text,pdf bytea);
   CREATE TABLE erp_live_jobs(order_id text,status text);
   CREATE TABLE resolution_jobs(order_id text,status text);
   CREATE TABLE audit(user_email text,action text,detail jsonb);
   CREATE TABLE products(sku text,weight_kg numeric);
   CREATE TABLE settings(key text,value jsonb);
   INSERT INTO products VALUES('SKU',0.5);
   INSERT INTO carrier_jobs VALUES('o','ready','["OLD-TRACK"]');
   INSERT INTO carrier_documents VALUES('o','old-pdf');`);
  await initializePartialDeliveries(db);
  await db.query('INSERT INTO orders(id,channel,reference,tracking_status,erp_live,address,carrier) VALUES($1,$2,$3,$4,$5,$6,$7)',[order.id,order.channel,order.reference,order.tracking_status,JSON.stringify(order.erp_live),JSON.stringify(order.address),'gofo']);
  let document=structuredClone(bc);const api={verify:async()=>{},request:async query=>{assert.match(query,/^query V3DocumentRead/);return {Order:structuredClone(document)};}};
  await fn(db,api,value=>{document=value});
 }finally{await engine.close();}
}

test('SQL and worker: second BL label is unique; original shipment and PDF survive',async()=>fixture(async(db,api)=>{
 const before=(await db.query('SELECT * FROM orders')).rows;
 const request={id:'o',blId:'102',requestId:randomUUID()};
 const results=await Promise.all([queueExistingBlLabel(db,api,request,{email:'operator'}),queueExistingBlLabel(db,api,{...request,requestId:randomUUID()},{email:'operator'})]);
 assert.equal(results[0].id,results[1].id);assert.equal(results[1].existing,true);
 let creates=0,pdfReads=0;
 const worker=partialService(db,'/tmp',{api,clients:{gofoCreate:async shipment=>{creates++;assert.equal(shipment.label_bl,'SHO00745173');assert.equal(shipment.erp_live.bl.id,'102');assert.equal(shipment.lines[0].target_quantity,1);assert.equal(shipment.weight_kg,0.5);assert.equal(shipment.address.postal,'75001');return {reference:'NEW',tracking:['NEW-TRACK']};},gofoLabel:async()=>{pdfReads++;return Buffer.from('%PDF-1.4\nNEW').toString('base64');}}});
 await worker.run();await worker.run();assert.equal(creates,1);assert.equal(pdfReads,1);
 const delivery=(await db.query('SELECT * FROM partial_deliveries')).rows[0];assert.equal(delivery.status,'ready',delivery.error);assert.deepEqual(delivery.tracking,['NEW-TRACK']);assert.equal(delivery.stock_document,null);
 assert.equal((await db.query('SELECT * FROM partial_documents')).rows.length,1);
 assert.deepEqual((await db.query('SELECT * FROM orders')).rows,before);
 assert.deepEqual((await db.query('SELECT tracking FROM carrier_jobs')).rows[0].tracking,['OLD-TRACK']);
 assert.equal(Buffer.from((await db.query('SELECT pdf FROM carrier_documents')).rows[0].pdf).toString(),'old-pdf');
 assert.equal((await queueExistingBlLabel(db,api,request,{email:'operator'})).existing,true);
 await worker.run();assert.equal(creates,1);
}));

test('changed BL blocks purchase; uncertain carrier outcome is never purchased twice',async()=>fixture(async(db,api,setDocument)=>{
 await queueExistingBlLabel(db,api,{id:'o',blId:'102',requestId:randomUUID()},{email:'operator'});
 setDocument({...bc,shipping_orders:{...bc.shipping_orders,data:[first,{...second,shipping_address:{...address,address_1:'Different'}}]}});
 let creates=0;const worker=partialService(db,'/tmp',{api,clients:{gofoCreate:async()=>{creates++;throw Error('Timeout transporteur');}}});
 await worker.run();assert.equal(creates,0);
 let delivery=(await db.query('SELECT * FROM partial_deliveries')).rows[0];assert.equal(delivery.status,'review');assert.match(delivery.error,/modifié/);
 setDocument(structuredClone(bc));await db.exec("UPDATE partial_deliveries SET status='bl_ready'");
 await worker.run();await worker.run();assert.equal(creates,1);
 delivery=(await db.query('SELECT * FROM partial_deliveries')).rows[0];assert.equal(delivery.status,'review');assert.equal(delivery.stage,'creating_label');
 const replay=await queueExistingBlLabel(db,api,{id:'o',blId:'102',requestId:randomUUID()},{email:'operator'});assert.equal(replay.existing,true);
 await worker.run();assert.equal(creates,1);
}));

test('PDF retry does not create another shipment even if Erplain is unavailable',async()=>fixture(async(db,api)=>{
 await queueExistingBlLabel(db,api,{id:'o',blId:'102',requestId:randomUUID()},{email:'operator'});
 let creates=0,pdfs=0;const worker=partialService(db,'/tmp',{api,clients:{gofoCreate:async()=>{creates++;return {reference:'NEW',tracking:['NEW-TRACK']};},gofoLabel:async()=>{if(++pdfs===1)throw Error('PDF momentanément indisponible');return Buffer.from('%PDF-1.4').toString('base64');}}});
 await worker.run();const d=(await db.query('SELECT * FROM partial_deliveries')).rows[0];assert.equal(d.status,'review');assert.equal(d.stage,'awaiting_pdf');assert.equal(d.carrier_result.reference,'NEW');
 api.verify=async()=>{throw Error('Erplain indisponible');};
 await db.exec("UPDATE partial_deliveries SET status='awaiting_pdf'");await worker.run();
 assert.equal(creates,1);assert.equal(pdfs,2);assert.equal((await db.query('SELECT status FROM partial_deliveries')).rows[0].status,'ready');
}));


test('explicit recovery queues one label for the missing associated BL; repeats preserve it',async()=>fixture(async(db,api)=>{
 const refresh=async()=>({bc,stockHolds:[],message:'Documents récupérés.'});
 const firstResult=await recoverDocumentsAndLabels(db,api,'o',{email:'operator'},{refresh});
 assert.equal(firstResult.labels.length,1);assert.equal(firstResult.labels[0].blId,'102');assert.equal(firstResult.labels[0].existing,false);
 const again=await recoverDocumentsAndLabels(db,api,'o',{email:'operator'},{refresh});
 assert.equal(again.labels[0].existing,true);assert.equal((await db.query('SELECT * FROM partial_deliveries')).rows.length,1);
 assert.equal((await db.query('SELECT * FROM carrier_documents')).rows.length,1);
}));

test('recovery reports stock and suspension holds without hiding the successful document refresh',async()=>fixture(async(db,api)=>{
 let refresh=async()=>({bc,stockHolds:[{message:'Stock à rapprocher'}],message:'Documents récupérés.'});
 let r=await recoverDocumentsAndLabels(db,api,'o',{email:'operator'},{refresh});
 assert.equal(r.labels.length,0);assert.match(r.message,/Stock à rapprocher/);
 await db.query("UPDATE orders SET suspension=$1",[JSON.stringify({active:true,note:'Test'})]);
 refresh=async()=>({bc,stockHolds:[],message:'Documents récupérés.'});
 r=await recoverDocumentsAndLabels(db,api,'o',{email:'operator'},{refresh});
 assert.equal(r.labels.length,0);assert.equal(r.labelHolds.length,1);assert.match(r.message,/suspendue/);
 assert.equal((await db.query('SELECT * FROM partial_deliveries')).rows.length,0);
}));

test('multiple pending associated BLs validate total allocations and get distinct requests',async()=>fixture(async(db,api,setDocument)=>{
 const extra={...second,id:'103',label:'SHO00745174'};
 const document={...bc,line_items:[{...line,quantity:3}],shipping_orders:{data:[first,second,extra],paginatorInfo:{hasMorePages:false}}};
 setDocument(document);
 const r=await recoverDocumentsAndLabels(db,api,'o',{email:'operator'},{refresh:async()=>({bc:document,stockHolds:[],message:'OK'})});
 assert.equal(r.labels.length,2,JSON.stringify(r.labelHolds));assert.equal((await db.query('SELECT * FROM partial_deliveries')).rows.length,2);
 assert.throws(()=>existingBlShipment(order,{...document,line_items:[line]},'102'),/reliquat/);
}));

test('recovered archived delivery is promoted once without creating another row',async()=>fixture(async(db,api)=>{
 await db.query("INSERT INTO partial_deliveries(id,order_id,request_id,status,stage,selection,bl,label_choice,environment) VALUES('recovered','o','recovered-bl:o:102','review','recovered_bl',$1,$2,'new','production')",[JSON.stringify([]),JSON.stringify(second)]);
 const r=await queueExistingBlLabel(db,api,{id:'o',blId:'102',requestId:randomUUID()},{email:'operator'});
 assert.equal(r.id,'recovered');assert.equal(r.existing,false);
 const d=(await db.query('SELECT * FROM partial_deliveries')).rows;assert.equal(d.length,1);assert.equal(d[0].status,'bl_ready');assert.equal(d[0].label_choice,'existing_bl');
 assert.equal((await queueExistingBlLabel(db,api,{id:'o',blId:'102',requestId:randomUUID()},{email:'operator'})).existing,true);
}));

test('recovery uses the normal label path for the pending primary BL',async()=>fixture(async(db,api)=>{
 const primary={...first,status:'pending'};let primaryCalls=0;
 const r=await recoverDocumentsAndLabels(db,api,'o',{email:'operator'},{refresh:async()=>({bc:{...bc,shipping_orders:{data:[primary]}},stockHolds:[],message:'OK'}),queuePrimary:async(_db,id,user)=>{assert.equal(id,'o');assert.equal(user.email,'operator');primaryCalls++;return {id,status:'pending',existing:false};}});
 assert.equal(primaryCalls,1);assert.equal(r.labels.length,1);assert.equal(r.labels[0].blId,'101');
}));

test('associated BL keeps the known recipient phone when Erplain omits it',()=>{
 const document={...bc,shipping_orders:{...bc.shipping_orders,data:[first,{...second,shipping_address:{...address,phone:null}}]}};
 const shipment=existingBlShipment({...order,address:{...order.address,phone:'0612345678'}},document,'102');
 assert.equal(shipment.address.phone,'0612345678');
});

test('recovery reports an existing uncertain request without sending another shipment',async()=>fixture(async(db,api)=>{
 await queueExistingBlLabel(db,api,{id:'o',blId:'102',requestId:randomUUID()},{email:'operator'});
 await db.query("UPDATE partial_deliveries SET status='review',stage='creating_label',error='Résultat transporteur incertain'");
 const r=await recoverDocumentsAndLabels(db,api,'o',{email:'operator'},{refresh:async()=>({bc,stockHolds:[],message:'Actualisé'})});
 assert.equal(r.labels[0].existing,true);assert.equal(r.labelHolds.length,1);
 assert.match(r.message,/Résultat transporteur incertain/);
 assert.equal((await db.query('SELECT * FROM partial_deliveries')).rows.length,1);
}));

test('imported associated BL retains its own destination during carrier validation',async()=>{
 const o={...order,associated_bl_label:true,label_bl_id:'102',carrier:'gls',source_payload:{erplainImported:true,account:'live'},address:{phone:'0612345678'}};
 const api={verify:async()=>{},request:async query=>{
  assert.match(query,/ShippingOrder\(id:\$bl\).*shipping_address/);
  return {Order:{id:'100',customer:{id:'1',label:'Client'},external_reference:'BC-REF',shipping_address:{...address,city:'Lyon',postal_code:'69001'}},ShippingOrder:{...second,shipping_address:{...address,phone:null},orders:{data:[{id:'100'}],paginatorInfo:{hasMorePages:false}}}};
 }};
 const result=await resolveImportedLabelOrder(o,api);
 assert.equal(result.address.city,'Paris');assert.equal(result.address.postal,'75001');assert.equal(result.address.phone,'0612345678');assert.equal(result.label_bl,second.label);
});
