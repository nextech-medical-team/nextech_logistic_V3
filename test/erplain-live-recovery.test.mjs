import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {pendingScope,recoveryScope,scopeSnapshot} from '../src/erplain-pending-scope.mjs';
import {documentIssues} from '../src/erplain-targeted-orders.mjs';
import {manualReviewService,manualReviewHash,assertManualReview} from '../src/erplain-manual-validation.mjs';
import {refreshManualOrder} from '../src/manual-erplain-orders.mjs';
import {completeShippingOrders} from '../src/erplain-document-read.mjs';

function document(status='active',blStatus='delivered'){
 const line={id:'line',type:'normal',quantity:2,shipped_quantity:2,price:10,tax_amount:4,available:10,on_hand:10,reserved_quantity:0,location:{id:'location'},variant:{id:'variant',sku:'SKU',active:true,track_inventory:true,weight_amount:100,weight_unit:'g',product:{active:true}}};
 return {id:'bc',label:'BC-1',status,total:24,currency:{label:'EUR'},customer:{id:'customer',label:'Client'},shipping_address:{label:'Client',address_1:'1 rue Test',postal_code:'75001',city:'Paris',country:'FR'},line_items:[line],shipping_orders:{data:[{id:'bl',label:'BL-1',status:blStatus,line_items:[{parent_id:'line',quantity:2,variant:line.variant}]}],paginatorInfo:{hasMorePages:false}}};
}

test('every BC and BL status can be admitted independently of preparation',()=>{
 for(const bcStatus of ['active','cancelled','unpublished','completed'])for(const blStatus of ['pending','cancelled','unpublished','make_the_shipment','in_preparation','ready_to_ship','shipped','delivered','completed']){
  const d=document(bcStatus,blStatus);
  assert.deepEqual(documentIssues(d).admissionIssues,[],bcStatus+'/'+blStatus);
  assert.doesNotThrow(()=>assertManualReview(d));
  assert.deepEqual(scopeSnapshot(d,recoveryScope(d)).shipping_orders,d.shipping_orders);
 }
});

test('mixed shipments retain all BL and prepare only pending quantities',()=>{
 const d=document();d.line_items[0].quantity=5;
 d.shipping_orders.data.push({id:'pending-bl',label:'BL-2',status:'pending',line_items:[{parent_id:'line',quantity:3,variant:d.line_items[0].variant}]});
 const scope=recoveryScope(d);
 assert.equal(scope.scoped,true);assert.equal(scope.lines[0].quantity,3);
 assert.deepEqual(scope.pending.map(b=>b.id),['pending-bl']);
 assert.deepEqual(scopeSnapshot(d,scope).shipping_orders.data.map(b=>b.id),['bl','pending-bl']);
 assert.throws(()=>pendingScope(document()),/Aucun BL en attente/);
});

test('incomplete BL pagination and invalid commercial data remain blocked',()=>{
 const d=document();d.shipping_orders.paginatorInfo.hasMorePages=true;
 assert.throws(()=>recoveryScope(d),/incomplète/);
 d.shipping_orders.paginatorInfo.hasMorePages=false;d.line_items[0].price=-1;
 assert.ok(documentIssues(d).admissionIssues.some(x=>x.includes('prix invalide')));
});

test('BL pagination retains every status and rejects repeated identities',async()=>{
 const d=document();d.shipping_orders.paginatorInfo.hasMorePages=true;
 const calls=[],api={request:async(q,v)=>{calls.push(v);return {Order:{id:d.id,shipping_orders:{data:[{id:'bl-2',status:'cancelled'}],paginatorInfo:{hasMorePages:false}}}};}};
 await completeShippingOrders(api,d);
 assert.deepEqual(d.shipping_orders.data.map(b=>b.status),['delivered','cancelled']);
 assert.deepEqual(calls,[{id:'bc',page:2}]);
 const repeated=document();repeated.shipping_orders.paginatorInfo.hasMorePages=true;
 await assert.rejects(()=>completeShippingOrders({request:async()=>({Order:{id:'bc',shipping_orders:{data:[{id:'bl'}],paginatorInfo:{hasMorePages:false}}}})},repeated),/Pagination BL incohérente/);
});

test('approval stores completed history without creating preparation work',async()=>{
 const engine=new PGlite();const wrap=e=>({query:(q,p)=>e.query(q,p)}),db={...wrap(engine),transaction:fn=>engine.transaction(tx=>fn(wrap(tx)))};
 try{
  await engine.exec(`CREATE TABLE orders(id text PRIMARY KEY,channel text,reference text,source_reference text,recipient text,address jsonb,source_date timestamptz,erp_live jsonb,source_payload jsonb,label_status text,erp_status text,resolution_pending_resume boolean,issue text);
   CREATE TABLE lines(id text,order_id text,source_line text,source_sku text,quantity numeric,target_sku text,target_quantity numeric,source_payload jsonb);
   CREATE TABLE erplain_manual_review(bc_id text PRIMARY KEY,document jsonb,review_hash text,status text,order_id text,validated_by text,validated_at timestamptz,updated_at timestamptz);
   CREATE TABLE erplain_order_identity(account text,bc_id text,order_id text,PRIMARY KEY(account,bc_id));
   CREATE TABLE erplain_refresh_cache(account text,section text,entity_id text,detail jsonb,reference text,seen_at timestamptz,missing boolean);
   CREATE TABLE audit(user_email text,action text,detail jsonb);`);
  for(const status of ['active','cancelled']){
   const d=document(status);d.id='bc-'+status;d.label='BC-'+status;
   await db.query("INSERT INTO erplain_manual_review(bc_id,document,review_hash,status) VALUES($1,$2,$3,'pending')",[d.id,JSON.stringify(d),manualReviewHash(d)]);
   const queries=[],api={verify:async()=>{},request:async q=>{queries.push(q);return {Order:d};}};
   const r=await manualReviewService(db,api).approve({confirmed:true,bcId:d.id,reviewHash:manualReviewHash(d)},{email:'test@example.test'});
   assert.equal(r.preparationStarted,false);
   const o=(await db.query('SELECT * FROM orders WHERE id=$1',[r.orderId])).rows[0];
   assert.deepEqual(o.erp_live.bc.shipping_orders,d.shipping_orders);
   assert.equal(o.label_status,'blocked');assert.equal(o.erp_status,'live_review');
   assert.equal(Number((await db.query('SELECT quantity FROM lines WHERE order_id=$1',[r.orderId])).rows[0].quantity),2);
   await assert.rejects(()=>refreshManualOrder(db,api,o),/Aucun BL en attente|activer le BC/);
   assert.ok(queries.every(q=>q.startsWith('query ')));
  }
  for(const tender of [true,false]){
   const d=document();d.id='scope-'+tender;d.label='REF-'+tender;
   d.account_representative={label:tender?"Appels d'offres":'Amazon'};
   await db.query("INSERT INTO orders(id,channel,reference,source_reference,erp_live,source_payload) VALUES($1,'amazon',$2,$3,'{}','{}')",['shadow-'+tender,'OTHER-'+tender,d.label]);
   await db.query("INSERT INTO erplain_manual_review(bc_id,document,review_hash,status) VALUES($1,$2,$3,'pending')",[d.id,JSON.stringify(d),manualReviewHash(d)]);
   const api={verify:async()=>{},request:async q=>{assert.ok(q.startsWith('query '));return {Order:d};}};
   const approve=()=>manualReviewService(db,api).approve({confirmed:true,bcId:d.id,reviewHash:manualReviewHash(d)},{email:'test@example.test'});
   if(tender){
    const result=await approve();assert.equal(result.preparationStarted,false);
    assert.equal((await db.query('SELECT reference FROM orders WHERE id=$1',[result.orderId])).rows[0].reference,d.label);
   }else await assert.rejects(approve,/Référence déjà présente/);
   assert.equal((await db.query('SELECT reference FROM orders WHERE id=$1',['shadow-'+tender])).rows[0].reference,'OTHER-'+tender);
  }
 }finally{await engine.close();}
});
