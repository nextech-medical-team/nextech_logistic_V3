import test from 'node:test';import assert from 'node:assert/strict';
import {runPlatformHoldMaintenance,rollbackPlatformHoldMaintenance} from '../src/platform-hold-maintenance.mjs';
import {authorizedTemuScope,authorizedFreshTemu} from '../src/temu-authorized-reimport.mjs';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
test('Private TEMU authorization is kept outside Git and independent of declared status',async()=>{
 assert.throws(()=>authorizedTemuScope([['PO-1-2','123'],['PO-1-2','123']]));assert.throws(()=>authorizedTemuScope([['BAD','123']]));assert.throws(()=>authorizedTemuScope([['PO-1-2','invalid']]));
 const directory=await mkdtemp(path.join(os.tmpdir(),'nextech-scope-test-')),file=path.join(directory,'temu-authorized-reimport-scope.json'),old=process.env.DATA_DIR;
 try{await writeFile(file,JSON.stringify([['PO-1-2','123']]));process.env.DATA_DIR=directory;
  for(const status of [1,2,3,4,5,undefined])assert.equal(authorizedFreshTemu({channel:'temu',shop:'123',payload:{detail:{parentOrderMap:{parentOrderSn:'PO-1-2',parentOrderStatus:status}}}},{batch:'fresh-temu-34-20261008'}),true);
  assert.throws(()=>authorizedFreshTemu({channel:'temu',shop:'other',payload:{detail:{parentOrderMap:{parentOrderSn:'PO-1-2'}}}},{batch:'fresh-temu-34-20261008'}));
 }finally{if(old===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=old;await unlink(file);await rmdir(directory);}
});
test('Maintenance replaces historical platform cancellation reason, preserves cancelled Erplain documents and never creates jobs',async()=>{
 const at=new Date().toISOString(),payload={id:'1',name:'#TEST',created_at:at,updated_at:at,fulfillment_status:'fulfilled',financial_status:'refunded',cancelled_at:at,line_items:[{id:'2',sku:'SKU',quantity:1}],shipping_address:{name:'TEST',address1:'Street',zip:'10000',city:'City',country_code:'FR'}};
 const order={id:'order1',channel:'shopify',reference:'#TEST',source_payload:{...payload},issue:'Commande entièrement remboursée dans Shopify · BC et BL Erplain annulés',label_status:'cancelled',tracking_status:'cancelled',resolution_pending_resume:false,archived:false,erp_live:{bc:{id:'3',status:'cancelled'},bl:{id:'4',status:'cancelled'}}};
 const original=structuredClone(order),tables={orders:[order],lines:[],jobs:[],erp_live_jobs:[],carrier_jobs:[],carrier_documents:[],document_lifecycle:[],extra_parcels:[],partial_deliveries:[],resolution_jobs:[],correction_jobs:[]};let updates=0;
 const db={query:async(sql,args)=>{
  if(sql.startsWith('LOCK TABLE'))return {rows:[]};
  if(sql.startsWith('UPDATE orders SET')){updates++;Object.assign(order,{source_payload:JSON.parse(args[1]),issue:args[2],resolution_pending_resume:args[3],label_status:args[4]});return {rows:[{id:order.id}]};}
  const table=sql.match(/SELECT \* FROM ([a-z_]+)/)?.[1];assert.ok(table,sql);return {rows:structuredClone(tables[table])};
 },transaction:async fn=>fn(db)};
 const report=await runPlatformHoldMaintenance({db,apply:true,pauseProbe:async()=>({paused:true,epoch:'test-pause'}),collect:async()=>({payload,checkedAt:new Date().toISOString(),origin:'provider',channel:'shopify',orderId:order.id,readOnly:true,complete:true})});
 assert.equal(report.status,'PASS');assert.equal(updates,1);assert.match(order.issue,/BC annulé dans Erplain/);assert.doesNotMatch(order.issue,/Shopify/);assert.deepEqual(order.erp_live,original.erp_live);assert.equal(order.tracking_status,original.tracking_status);assert.equal(order.label_status,'cancelled');assert.equal(order.resolution_pending_resume,false);assert.equal(report.newJobs,0);assert.equal(report.externalWrites,0);
 const restored=await rollbackPlatformHoldMaintenance({db,pauseProbe:async()=>({paused:true,epoch:'test-pause'}),report});assert.equal(restored.restored,1);assert.deepEqual(order,original);
});
