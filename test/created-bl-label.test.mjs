import test from 'node:test';
import assert from 'node:assert/strict';
import {hasCreatedBl} from '../src/created-bl-label.mjs';
import {assertLabelStockGate} from '../src/label-stock-gate.mjs';
import {assertPreparedLabelOrder} from '../src/equivalent-auto-label.mjs';
import {partialService} from '../src/partial-deliveries.mjs';

for(const status of ['pending','make_the_shipment','in_preparation','ready_to_ship'])test(`BL ${status}: no BC/stock/mapping/fiscal/preparation gate`,async()=>{
 const o={id:'o',reference:'order',channel:'amazon',carrier:'gls',erp_live:{bl:{id:'bl',status},bc:{id:'bc',status:'active'},phase:'old',pricing:{status:'blocked'}},issue:'Quantités BL et sortie de stock différentes',source_payload:{marketplacePendingCorrection:true,erplainValidationHold:true},suspension:{},tracking_status:'not_shipped'};
 assert.equal(hasCreatedBl(o),true);
 await assertLabelStockGate({query:()=>assert.fail('SQL gate after BL')},o);
 assert.doesNotThrow(()=>assertPreparedLabelOrder(o,{status:'review',error:'Stock incohérent'}));
 assert.throws(()=>assertPreparedLabelOrder({...o,suspension:{active:true}}),/suspend/i);
 assert.throws(()=>assertPreparedLabelOrder({...o,tracking_status:'cancelled'}),/annul/i);
});
test('no BL, draft and cancelled BL never count as published',()=>{
 for(const bl of [null,{}, {id:'bl',status:'unpublished'},{id:'bl',status:'cancelled'},{id:'bl',status:'shipped'},{id:'bl',status:'delivered'}])assert.equal(hasCreatedBl({erp_live:{bl}}),false);
});

for(const initial of ['finalizing_bl','bl_ready','awaiting_pdf'])test(`partial ${initial}: label/PDF does not call Erplain or redo stock readiness`,async()=>{
 const pdf=Buffer.from('%PDF-1.4 fixture').toString('base64');let posts=0,pdfWrites=0;
 const d={id:'delivery',order_id:'order',status:initial,stage:initial,selection:[{sku:'SKU',quantity:2}],bl:{id:'bl',label:'SHO00744654',status:'ready_to_ship'},environment:'production',label_choice:'new',stock_document:{id:'wrong-stock'},tracking:initial==='awaiting_pdf'?['tracking']:[],carrier:initial==='awaiting_pdf'?'gls':null,carrier_result:initial==='awaiting_pdf'?{tracking:['tracking'],documents:[pdf]}:null};
 const o={id:'order',reference:'order',channel:'amazon',carrier:'gls',address:{country:'FR'},erp_live:{bc:{id:'bc',status:'active'}},suspension:{},tracking_status:'not_shipped'};
 const query=async(sql,args=[])=>{
  if(sql.startsWith('SELECT * FROM partial_deliveries'))return {rows:d.status==='ready'?[]:[structuredClone(d)]};
  if(sql.startsWith('SELECT * FROM orders'))return {rows:[structuredClone(o)]};
  if(sql.startsWith('SELECT sku,weight_kg'))return {rows:[{sku:'SKU',weight_kg:2}]};
  if(sql.startsWith('SELECT 1 FROM partial_documents'))return {rows:[]};
  if(sql.includes("key='routing'"))return {rows:[]};
  if(sql.startsWith('UPDATE partial_deliveries')){d.status=args[1];d.carrier=args[4];d.tracking=JSON.parse(args[7]);d.carrier_result=args[8]?JSON.parse(args[8]):null;return {rows:[]};}
  if(sql.startsWith('INSERT INTO partial_documents')){pdfWrites++;return {rows:[]};}
  assert.fail('Unexpected SQL '+sql);
 };
 const db={query,transaction:async fn=>fn({query})};
 const api=new Proxy({},{get:()=>()=>assert.fail('Erplain call after BL')});
 const worker=partialService(db,'unused',{api,clients:{gls:async shipment=>{posts++;assert.equal(shipment.label_bl,'SHO00744654');return {tracking:['tracking'],documents:[pdf]};}}});
 await worker.run();assert.equal(d.status,'ready');assert.equal(posts,initial==='awaiting_pdf'?0:1);assert.equal(pdfWrites,1);
 await worker.run();assert.equal(posts,initial==='awaiting_pdf'?0:1);
});
