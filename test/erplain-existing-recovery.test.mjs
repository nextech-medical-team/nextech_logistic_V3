import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {targetedOrderService} from '../src/erplain-targeted-orders.mjs';
import {manualReviewHash} from '../src/erplain-manual-validation.mjs';

test('recover a second external BL on an existing marketplace order without reimport or shipment writes',async()=>{
 const engine=new PGlite(),wrap=e=>({query:(q,p)=>e.query(q,p)}),db={...wrap(engine),transaction:fn=>engine.transaction(tx=>fn(wrap(tx)))};
 try{
  await engine.exec(`CREATE TABLE orders(id text PRIMARY KEY,reference text,source_reference text,source_payload jsonb,erp_live jsonb,archived boolean,partial_mode boolean,label_status text,tracking_status text);
  CREATE TABLE erplain_order_identity(account text,bc_id text,order_id text,PRIMARY KEY(account,bc_id),UNIQUE(account,order_id));
  CREATE TABLE erplain_manual_review(bc_id text,status text);
  CREATE TABLE erplain_refresh_cache(account text,section text,entity_id text,reference text,detail jsonb,missing boolean,seen_at timestamptz,UNIQUE(account,section,entity_id));
  CREATE TABLE erp_live_jobs(order_id text,status text);
  CREATE TABLE carrier_jobs(order_id text,status text,result jsonb);
  CREATE TABLE partial_deliveries(order_id text,status text);
  CREATE TABLE resolution_jobs(order_id text,status text);
  CREATE TABLE carrier_documents(order_id text,pdf bytea);
  CREATE TABLE audit(user_email text,action text,detail jsonb);
  INSERT INTO orders VALUES('existing','REF',NULL,'{"origin":"amazon"}','{"bl":{"id":"first","label":"BL-1"},"stockDocument":{"id":"stock"},"phase":"complete"}',false,false,'ready','delivered');
  INSERT INTO carrier_jobs VALUES('existing','ready','{"tracking":"TRACK"}');
  INSERT INTO carrier_documents VALUES('existing',decode('25504446','hex'));`);
  const variant={id:'v',sku:'SKU',active:true,track_inventory:true,weight_amount:100,weight_unit:'g'};
  let document={id:'bc',label:'BC',external_reference:'REF',status:'active',total:10,currency:{label:'EUR'},customer:{id:'customer'},line_items:[{id:'line',quantity:100,price:0.1,tax_amount:0,variant,location:{id:'loc'},shipped_quantity:60,available:0,on_hand:0,reserved_quantity:0}],shipping_orders:{data:[{id:'first',label:'BL-1',status:'delivered',line_items:[{parent_id:'line',quantity:60,variant}]},{id:'second',label:'BL-2',status:'in_preparation',line_items:[{parent_id:'line',quantity:40,variant}]}],paginatorInfo:{hasMorePages:false}}};
  const calls=[],api={verify:async()=>{},request:async(q)=>{calls.push(q);assert.ok(q.startsWith('query '),'no provider mutation');return q.includes('V3TargetedLookup')?{Orders:{data:[{id:'bc',label:'BC',external_reference:'REF'}],paginatorInfo:{hasMorePages:false}}}:{Order:structuredClone(document)};}};
  const service=targetedOrderService(db,api),user={email:'test@example.invalid'};
  const preview=await service.lookup({reference:'BC'});
  assert.equal(preview.reconcileCandidate.orderId,'existing');assert.deepEqual(preview.admissionIssues,[]);
  assert.ok(preview.preparationIssues.length,'stock and address warnings do not block document recovery');
  assert.equal((await db.query('SELECT erp_live FROM orders')).rows[0].erp_live.bc,undefined,'preview does not bind');
  const request={bcId:'bc',orderId:'existing',confirmed:true,reviewHash:preview.reviewHash};
  const before=(await db.query('SELECT * FROM orders')).rows[0],labels=(await db.query('SELECT * FROM carrier_documents')).rows,jobs=(await db.query('SELECT * FROM carrier_jobs')).rows;
  for(let i=0;i<2;i++){
   const result=await service.reconcile(request,user);assert.equal(result.preparationStarted,false);assert.equal(result.shippingOrders.length,2);
  }
  const after=(await db.query('SELECT * FROM orders')).rows[0];
  assert.equal((await db.query('SELECT count(*)::int n FROM orders')).rows[0].n,1);
  assert.deepEqual({...after,erp_live:before.erp_live},before);
  assert.equal(after.erp_live.bl.id,'first');assert.equal(after.erp_live.bl.status,'delivered');assert.deepEqual(after.erp_live.stockDocument,before.erp_live.stockDocument);
  assert.deepEqual(after.erp_live.documentSource.shippingOrders.map(b=>b.id),['first','second']);
  assert.deepEqual((await db.query('SELECT * FROM carrier_documents')).rows,labels);assert.deepEqual((await db.query('SELECT * FROM carrier_jobs')).rows,jobs);
  await db.query("UPDATE orders SET archived=true,reference='LOCAL-REF',source_reference='REF' WHERE id='existing'");
  assert.equal((await service.lookup({reference:'BC'})).reconcileCandidate.orderId,'existing');
  await service.reconcile(request,user);assert.equal((await db.query('SELECT archived FROM orders')).rows[0].archived,true);
  await db.query("UPDATE orders SET archived=false,reference='REF',source_reference=NULL WHERE id='existing'");
  const reread=await service.lookup({reference:'BC'});assert.equal(reread.reconcileCandidate.orderId,'existing');
  await assert.rejects(()=>service.reconcile({...request,confirmed:false},user),/Confirmer/);
  document.shipping_orders.data[1].status='ready_to_ship';await assert.rejects(()=>service.reconcile(request,user),/ont changé/);
  request.reviewHash=manualReviewHash(document);
  await db.query("INSERT INTO erp_live_jobs VALUES('existing','pending')");await assert.rejects(()=>service.reconcile(request,user),/en attente/);await db.query('DELETE FROM erp_live_jobs');
  await db.query("INSERT INTO orders VALUES('duplicate','REF',NULL,'{}','{}',false,false,NULL,NULL)");
  assert.match((await service.lookup({reference:'BC'})).admissionIssues[0],/Plusieurs commandes/);
  await assert.rejects(()=>service.reconcile(request,user),/Plusieurs commandes/);await db.query("DELETE FROM orders WHERE id='duplicate'");
  await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{bc,id}','\"other\"') WHERE id='existing'");
  await assert.rejects(()=>service.reconcile(request,user),/autre BC/);
  await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{bc,id}','\"bc\"') WHERE id='existing'");
  document.shipping_orders.data.shift();request.reviewHash=manualReviewHash(document);await assert.rejects(()=>service.reconcile(request,user),/BL déjà enregistré/);
  document.shipping_orders.paginatorInfo.hasMorePages=true;
  await assert.rejects(()=>service.lookup({reference:'BC'}),/Pagination BL incohérente/);
  assert.deepEqual((await db.query('SELECT * FROM carrier_documents')).rows,labels);
 }finally{await engine.close();}
});
