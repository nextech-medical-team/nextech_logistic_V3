import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {protectedRefreshReason,protectedRefreshProof,reconcileProtectedRefresh,protectedRefreshDiagnosticReconciler} from '../src/protected-refresh-diagnostic.mjs';
import {shipmentFingerprint} from '../src/label-stock-gate.mjs';

function fixture(){
 const now=Date.now(),old=new Date(now-60000).toISOString(),done=new Date(now-30000).toISOString();
 const address={label:'Recipient',address_1:'Street',postal_code:'75001',city:'Paris',country:'FR'};
 const line={type:'normal',variant:{id:11,sku:'SKU'},location:{id:22},quantity:150};
 const bl={id:2,label:'BL2',status:'ready_to_ship',external_reference:'REF',update_stock:false,shipping_address:address,line_items:[line]};
 const bc={id:1,label:'BC1',status:'active',external_reference:'REF',update_stock:false,shipping_address:address,line_items:[line],shipping_orders:{data:[bl],paginatorInfo:{hasMorePages:false}}};
 const stock={id:3,label:'V3FS-o',status:'completed',update_stock:true,notes:'LIVE : sortie de stock liée au BL BL2',line_items:[line]};
 const review={id:'r',order_id:'o',status:'review',action:'refresh',stage:'Correction enregistrée · suite bloquée',error:protectedRefreshReason,payload:{id:'o'},result:{checks:[{id:'o',protected:true}],message:'Original message preserved'},created_at:old,updated_at:old};
 const order={id:'o',reference:'REF',channel:'amazon',archived:false,duplicate_of:null,partial_mode:false,suspension:{},source_payload:{},issue:null,resolution_pending_resume:false,label_status:'production_ready',tracking_status:'not_shipped',erp_status:'live_created',simulation:true,erp_live:{phase:'bl_ready',bc,bl:{...bl,readyConfirmedAt:done},stockDocument:stock,verifiedAt:done,stockCheckedAt:done,labelPreparationFingerprint:'a'.repeat(64)},address:{name:'Recipient',street:'Street',postal:'75001',city:'Paris',country:'FR'},weight_kg:1};
 order.erp_live.bc=structuredClone(bc);order.erp_live.stockDocument=structuredClone(stock);
 return {now,order,review,erp:{status:'complete',error:null,updated_at:done},bc,stock,lines:[{id:'l',source_sku:'SKU',target_sku:'SKU',mapped_sku:'SKU',quantity:'150',target_quantity:'150',source_qty:'1',target_qty:'1',source_payload:{}}],currentFingerprint:'a'.repeat(64),labels:[{document_index:0,bytes:10,signature:'%PDF-',fingerprint:'abc',tracking:'TRACK'}],checkedAt:new Date(now).toISOString()};
}
test('final preparation makes the earlier exact protected refresh obsolete, even with a legacy simulation flag',()=>{
 const f=fixture(),p=protectedRefreshProof(f);assert.equal(p.bcId,1);assert.equal(p.providerMutations,0);assert.equal(p.businessCompleted,false);
});
test('already-completed documents also justify retiring a subsequent protected refresh after a new supplier read',()=>{
 const f=fixture();f.review.created_at=f.review.updated_at=new Date(Date.parse(f.erp.updated_at)+1000).toISOString();
 assert.equal(protectedRefreshProof(f).providerMutations,0);
});
const negative=[
 ['cancelled order',f=>f.order.label_status='cancelled'],['cancelled tracking',f=>f.order.tracking_status='cancelled'],['archive',f=>f.order.archived=true],['duplicate',f=>f.order.duplicate_of='other'],['partial',f=>f.order.partial_mode=true],['suspended',f=>f.order.suspension={active:true}],['erplain cancellation',f=>f.order.suspension={erplainCancellation:true}],['real stock blocker',f=>f.order.issue='Stock insuffisant'],['pending continuation',f=>f.order.resolution_pending_resume=true],['marketplace hold',f=>f.order.source_payload.marketplacePendingCorrection={}],['visibility hold',f=>f.order.source_payload.visibilityHold=true],['uncertain mapping',f=>f.order.erp_live.mappingAlignmentAttempt={status:'uncertain'}],['stock hold',f=>f.order.erp_live.documentSource={stockHolds:[{message:'Missing stock'}]}],['erp failed',f=>f.erp.error='Stock insuffisant'],['erp active',f=>f.erp.status='processing'],['newer review',f=>f.review.updated_at=f.checkedAt],['wrong review action',f=>f.review.action='replace-equivalent'],['mixed error',f=>f.review.error+=' ; Stock insuffisant'],['explicit no resume',f=>f.review.payload.resumeAfter=false],['checks for another order',f=>f.review.result.checks[0].id='other'],['mixed checks',f=>f.review.result.checks.push({id:'other',protected:true})],['check error',f=>f.review.result.checks[0].error='Failed'],['old provider proof',f=>f.checkedAt=new Date(f.now-300001).toISOString()],['future provider proof',f=>f.checkedAt=new Date(f.now+1).toISOString()],['modified preparation',f=>f.currentFingerprint='b'.repeat(64)],['missing PDF',f=>f.labels=[]],['invalid PDF',f=>f.labels[0].signature='HTML'],['empty PDF',f=>f.labels[0].bytes=0],['wrong BC',f=>f.bc.id=9],['cancelled BC',f=>f.bc.status='cancelled'],['wrong BC reference',f=>f.bc.external_reference='OTHER'],['incomplete BL pages',f=>f.bc.shipping_orders.paginatorInfo.hasMorePages=true],['additional active BL',f=>f.bc.shipping_orders.data.push({...f.bc.shipping_orders.data[0],id:8})],['cancelled BL',f=>f.bc.shipping_orders.data[0].status='cancelled'],['wrong BL reference',f=>f.bc.shipping_orders.data[0].external_reference='OTHER'],['different BC BL address',f=>f.bc.shipping_orders.data[0].shipping_address={...f.bc.shipping_address,city:'Other'}],['stock not completed',f=>f.stock.status='draft'],['stock wrong identity',f=>f.stock.id=9],['stock not debited',f=>f.stock.update_stock=false],['stock different BL',f=>f.stock.notes='Other BL']
];
for(const [name,mutate]of negative)test('keeps diagnostic: '+name,()=>{const f=fixture();mutate(f);assert.equal(protectedRefreshProof(f),null);});
test('delivered is permitted only as an existing document status; no delivery is certified',()=>{const f=fixture();f.bc.shipping_orders.data[0].status='delivered';f.order.tracking_status='delivered';assert.equal(protectedRefreshProof(f).businessCompleted,false);});

async function database(){
 const db=new PGlite();await db.exec(`CREATE TABLE orders(id text primary key,reference text,channel text,archived boolean,duplicate_of text,partial_mode boolean,suspension jsonb,source_payload jsonb,issue text,resolution_pending_resume boolean,label_status text,tracking_status text,erp_status text,simulation boolean,erp_live jsonb,address jsonb,weight_kg numeric);
 CREATE TABLE lines(id text,order_id text,source_line text,source_sku text,target_sku text,quantity numeric,target_quantity numeric,source_payload jsonb);
 CREATE TABLE mappings(channel text,source_sku text,target_sku text,source_qty numeric,target_qty numeric);
 CREATE TABLE resolution_jobs(id text primary key,order_id text,status text,action text,stage text,error text,payload jsonb,result jsonb,created_at timestamptz,updated_at timestamptz);
 CREATE TABLE erp_live_jobs(order_id text,status text,error text,updated_at timestamptz);
 CREATE TABLE carrier_jobs(order_id text,status text,error text,environment text,tracking jsonb);
 CREATE TABLE carrier_documents(order_id text,document_index integer,pdf bytea);
 CREATE TABLE temu_label_jobs(reference text,status text,error text,packages jsonb,result jsonb);
 CREATE TABLE temu_label_documents(reference text,package text,pdf bytea);
 CREATE TABLE partial_deliveries(order_id text,status text);CREATE TABLE extra_parcels(order_id text,status text);CREATE TABLE correction_jobs(order_id text,status text);
 CREATE TABLE audit(user_email text,action text,detail text);`);
 const f=fixture(),cols=Object.keys(f.order);
 await db.query('INSERT INTO orders('+cols.join(',')+') VALUES('+cols.map((_,i)=>'$'+(i+1)).join(',')+')',cols.map(k=>typeof f.order[k]==='object'&&f.order[k]!==null?JSON.stringify(f.order[k]):f.order[k]));
 const rc=Object.keys(f.review);await db.query('INSERT INTO resolution_jobs('+rc.join(',')+') VALUES('+rc.map((_,i)=>'$'+(i+1)).join(',')+')',rc.map(k=>typeof f.review[k]==='object'?JSON.stringify(f.review[k]):f.review[k]));
 await db.exec("INSERT INTO lines VALUES('l','o','1','SKU','SKU',150,150,'{}');INSERT INTO mappings VALUES('amazon','SKU','SKU',1,1)");
 await db.query('INSERT INTO erp_live_jobs VALUES($1,$2,$3,$4)',['o','complete',null,f.erp.updated_at]);
 await db.query("INSERT INTO carrier_jobs VALUES('o','ready',null,'production','[\"TRACK\"]')");
 await db.query('INSERT INTO carrier_documents VALUES($1,0,$2)',['o',Buffer.from('%PDF-test')]);
 const fp=await shipmentFingerprint(db,(await db.query("SELECT * FROM orders WHERE id='o'")).rows[0]);
 await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{labelPreparationFingerprint}',to_jsonb($1::text))",[fp]);
 const adapter={query:(...args)=>db.query(...args),transaction:fn=>db.transaction(tx=>fn({query:(...a)=>tx.query(...a)}))};
 let reads=0;const api={verify:async()=>{},request:async(q)=>{assert.match(q,/^query /);assert.ok(!/mutation/i.test(q));reads++;if(q.includes('V3DocumentRead'))return {Order:f.bc};if(q.includes('V3ProtectedRefreshStock'))return {StockRemoval:f.stock};throw Error('Unknown query');}};
 const snapshot=async()=>{const out={};for(const table of ['orders','lines','mappings','erp_live_jobs','carrier_jobs','carrier_documents','resolution_jobs','audit'])out[table]=(await db.query('SELECT * FROM '+table)).rows;return out;};
 return {db,adapter,api,f,snapshot,reads:()=>reads};
}
test('real SQL: dry run has zero writes; completion is audited, preserves business rows and PDF; repeat is a no-op',async()=>{
 const x=await database();try{
  const before=await x.snapshot();const dry=await reconcileProtectedRefresh(x.adapter,x.api,'r',{dryRun:true});assert.equal(dry.eligible,true);assert.deepEqual(await x.snapshot(),before);
  const done=await reconcileProtectedRefresh(x.adapter,x.api,'r');assert.equal(done.updated,true);const after=await x.snapshot();
  for(const table of ['orders','lines','mappings','erp_live_jobs','carrier_jobs','carrier_documents'])assert.deepEqual(after[table],before[table],table);
  const j=after.resolution_jobs[0];assert.equal(j.status,'complete');assert.equal(j.error,null);assert.deepEqual(j.payload,before.resolution_jobs[0].payload);assert.equal(j.result.message,'Original message preserved');assert.equal(j.result.protectedRefreshReconciliation.previousError,protectedRefreshReason);assert.equal(after.audit.length,1);
  const n=x.reads();assert.equal((await reconcileProtectedRefresh(x.adapter,x.api,'r')).notApplicable,true);assert.equal(x.reads(),n);assert.deepEqual(await x.snapshot(),after);
 }finally{await x.db.close();}
});
test('real SQL: active jobs, independent error and failed supplier read leave all rows unchanged',async()=>{
 const x=await database();try{
  await x.db.query("INSERT INTO correction_jobs VALUES('o','checking')");const before=await x.snapshot();await assert.rejects(reconcileProtectedRefresh(x.adapter,x.api,'r'),/Traitement/);assert.equal(x.reads(),0);assert.deepEqual(await x.snapshot(),before);await x.db.query('DELETE FROM correction_jobs');
  await x.db.query("INSERT INTO resolution_jobs VALUES('other','o','review','weight','Review','Poids absent','{}','{}',now()-interval '2 minutes',now()-interval '2 minutes')");assert.equal((await reconcileProtectedRefresh(x.adapter,x.api,'r')).independentReview,true);assert.equal(x.reads(),0);await x.db.query("DELETE FROM resolution_jobs WHERE id='other'");
  const original=await x.snapshot();await assert.rejects(reconcileProtectedRefresh(x.adapter,{verify:async()=>{},request:async()=>{throw Error('Provider offline');}},'r'),/offline/);assert.deepEqual(await x.snapshot(),original);
 }finally{await x.db.close();}
});
test('real SQL: incomplete stock document refuses completion',async()=>{
 const x=await database();try{const before=await x.snapshot();x.f.stock.status='draft';assert.equal((await reconcileProtectedRefresh(x.adapter,x.api,'r')).proofNotConfirmed,true);assert.deepEqual(await x.snapshot(),before);}finally{await x.db.close();}
});
test('real SQL: an older error of the same action is historical; latest protected refresh can be reconciled without altering that history',async()=>{
 const x=await database();try{
  await x.db.query("INSERT INTO resolution_jobs VALUES('old','o','review','refresh','Old review','Old stock error','{}','{}',now()-interval '2 minutes',now()-interval '2 minutes')");
  const old=(await x.db.query("SELECT * FROM resolution_jobs WHERE id='old'")).rows[0];
  assert.equal((await reconcileProtectedRefresh(x.adapter,x.api,'r')).updated,true);
  assert.deepEqual((await x.db.query("SELECT * FROM resolution_jobs WHERE id='old'")).rows[0],old);
 }finally{await x.db.close();}
});
test('real SQL: concurrent order change, changed PDF and latest new review invalidate the proposed completion',async()=>{
 const x=await database();try{
  const original=x.api.request;
  x.api.request=async(...a)=>{const r=await original(...a);if(a[0].includes('V3ProtectedRefreshStock'))await x.db.query("UPDATE orders SET suspension='{"+'"active":true'+"}'");return r;};
  assert.equal((await reconcileProtectedRefresh(x.adapter,x.api,'r')).changedDuringRead,true);assert.equal((await x.db.query('SELECT status FROM resolution_jobs')).rows[0].status,'review');await x.db.query("UPDATE orders SET suspension='{}'");
  x.api.request=async(...a)=>{const r=await original(...a);if(a[0].includes('V3ProtectedRefreshStock'))await x.db.query('UPDATE carrier_documents SET pdf=$1',[Buffer.from('%PDF-changed')]);return r;};
  assert.equal((await reconcileProtectedRefresh(x.adapter,x.api,'r')).changedDuringRead,true);assert.equal((await x.db.query('SELECT status FROM resolution_jobs')).rows[0].status,'review');
  x.api.request=async(...a)=>{const r=await original(...a);if(a[0].includes('V3ProtectedRefreshStock'))await x.db.query("INSERT INTO resolution_jobs(id,order_id,status,action,error,created_at,updated_at) VALUES('new','o','review','weight','Poids absent',now(),now())");return r;};
  assert.equal((await reconcileProtectedRefresh(x.adapter,x.api,'r')).changedDuringRead,true);assert.equal((await x.db.query("SELECT status FROM resolution_jobs WHERE id='r'")).rows[0].status,'review');assert.equal((await x.db.query('SELECT * FROM audit')).rows.length,0);
 }finally{await x.db.close();}
});
test('real SQL: audit failure rolls back diagnostic completion',async()=>{
 const x=await database();try{const before=await x.snapshot();const failing={query:x.adapter.query,transaction:fn=>x.db.transaction(tx=>fn({query:(sql,args)=>{if(sql.startsWith('INSERT INTO audit'))throw Error('Audit unavailable');return tx.query(sql,args);}}))};await assert.rejects(reconcileProtectedRefresh(failing,x.api,'r'),/Audit unavailable/);assert.deepEqual(await x.snapshot(),before);}finally{await x.db.close();}
});
test('sweep is bounded, fairly resumes remaining candidates, retries failures after 15 minutes, and respects disable',async()=>{
 let now=1000000,enabled=true;const calls=[],rows=Array.from({length:8},(_,i)=>({id:String(i)}));
 const db={query:async()=>({rows})},service=protectedRefreshDiagnosticReconciler(db,{}, {now:()=>now,enabled:()=>enabled,reconcile:async(_db,_api,id)=>{calls.push(id);if(id==='1')throw Error('Deferred');}});
 await service.run();assert.deepEqual(calls,['0','1','2','3','4']);await service.run();assert.equal(calls.length,5);now+=60001;await service.run();assert.deepEqual(calls.slice(5),['5','6','7']);enabled=false;now+=900001;await service.run();assert.equal(calls.length,8);enabled=true;await service.run();assert.deepEqual(calls.slice(8),['0','1','2','3','4']);
});

 test('registered BC governs: later source/mapping and line quantity differences do not create a retrospective veto',()=>{const f=fixture();f.lines[0].target_qty='2';f.bc.line_items[0].quantity=151;f.stock.line_items[0].quantity=149;assert.ok(protectedRefreshProof(f));});
