import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {initializeReceiptRecovery,receiptRecoveryService} from '../src/receipt-recovery.mjs';
import {queueResolutionRequest} from '../src/resolution-request.mjs';

async function fixture(channel='amazon',temu=undefined){
 const engine=new PGlite();await engine.waitReady;const wrap=e=>({exec:s=>e.exec(s),query:(s,p=[])=>e.query(s,p)}),db={...wrap(engine),transaction:fn=>engine.transaction(tx=>fn(wrap(tx)))};
 await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,reference text,channel text,archived boolean DEFAULT false,erp_live jsonb DEFAULT '{}',suspension jsonb DEFAULT '{}',source_payload jsonb DEFAULT '{}',received_at timestamptz DEFAULT now(),processing_priority_at timestamptz,tracking_status text DEFAULT 'not_shipped',label_status text DEFAULT 'pending',partial_mode boolean DEFAULT false,resolution_pending_resume boolean DEFAULT false,address jsonb DEFAULT '{}',carrier text,weight_kg numeric,parcel_count int);
 CREATE TABLE lines(order_id text,source_sku text,target_sku text); CREATE TABLE mappings(channel text,source_sku text,target_sku text);
 CREATE TABLE partial_deliveries(id text,order_id text,status text); CREATE TABLE partial_documents(delivery_id text,document_index int);
 CREATE TABLE resolution_jobs(id text PRIMARY KEY,order_id text,request_id text UNIQUE,action text,payload jsonb,status text DEFAULT 'queued',error text,stage text);
 CREATE UNIQUE INDEX resolution_busy ON resolution_jobs(order_id) WHERE status IN ('queued','running','waiting');
 CREATE TABLE erp_live_jobs(order_id text,status text); CREATE TABLE correction_jobs(order_id text,status text);
 CREATE TABLE carrier_jobs(order_id text,status text,environment text,tracking jsonb,error text); CREATE TABLE carrier_documents(order_id text,document_index int,pdf bytea DEFAULT '\x25504446');
 CREATE TABLE temu_label_jobs(reference text,status text,error text,packages jsonb DEFAULT '[]'); CREATE TABLE temu_label_documents(reference text,package text,pdf bytea DEFAULT '\x25504446'); CREATE TABLE extra_parcels(order_id text,environment text,status text,pdf bytea);
 CREATE TABLE equivalence_import_rows(order_id text,batch_id text);CREATE TABLE equivalence_imports(id text,status text);
 CREATE TABLE audit(user_email text,action text,detail jsonb);`);
 await initializeReceiptRecovery(db);await initializeReceiptRecovery(db);
 const id=randomUUID(),line={type:'normal',quantity:1,reserved_quantity:0,available:1,on_hand:1,location:{id:'100934'},variant:{id:'44',sku:'33 421 13B',track_inventory:true}},receipt={id:'213950',label:'PRP00000244',status:'delivered',update_stock:true,line_items:[line]};
 let actual={id:'1925605',label:'C00014132',status:'active',update_stock:false,line_items:[line],shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}},labelCalls=0;
 await db.query('INSERT INTO orders(id,reference,channel,erp_live) VALUES($1,$2,$3,$4)',[id,'SYNTHETIC',channel,JSON.stringify({bc:{id:'1925605',label:'C00014132'},phase:'bc_created',pricing:{status:'blocked',tax_type:'exclusive',total:999}})]);
 const calls=[],api={verify:async()=>{},request:async(q)=>{calls.push(q);assert.match(q,/^query /);if(q.includes('ReceiptByLabel'))return {PurchaseReceipts:{data:[receipt],paginatorInfo:{hasMorePages:false}}};if(q.includes('ReceiptOrderStock'))return {Orders:{data:[actual],paginatorInfo:{hasMorePages:false}}};if(q.includes('DocumentRead'))return {Order:actual};throw Error('Unexpected '+q);}};
 const service=receiptRecoveryService(db,'unused',{api,temu,queueLabel:async()=>{labelCalls++;await db.query("INSERT INTO carrier_jobs VALUES($1,'pending','production','[]',null)",[id]);return {id,status:'pending'};}});
 const user={role:'admin',email:'synthetic@example.test'},permitted=(u,roles)=>{if(!roles.includes(u.role))throw Error('Forbidden');};
 async function route(path,body,role='admin'){
  let result;await service.routes({p:path,url:new URL('http://localhost'+path),req:{method:'POST'},res:{},user:{...user,role},body:async()=>body,json:(_r,status,value)=>{result={status,...value};},permitted});return result;
 }
 async function start(expected='eligible'){const r=await route('/api/receipts/recovery/preview',{number:receipt.label,requestId:randomUUID()});await service.run();const state=await service.status(r.id);assert.equal(state.state,'ready');assert.equal(state.plan.rows[0].status,expected);return r.id;}
 return {db,engine,id,receipt,user,service,route,start,calls,actual:()=>actual,change:v=>{actual=v;},labelCalls:()=>labelCalls};
}
test('durable receipt preview, native resume, labels, finished result and duplicate execution',async()=>{
 const f=await fixture();try{
  const run=await f.start();assert.equal((await f.db.query('SELECT * FROM resolution_jobs')).rows.length,0);
  await f.service.submit({id:run,ids:[f.id]},f.user);assert.equal((await f.service.submit({id:run,ids:[f.id]},f.user)).existing,true);
  await f.service.run();await f.service.run();const jobs=(await f.db.query('SELECT * FROM resolution_jobs')).rows;assert.equal(jobs.length,1);assert.equal(jobs[0].action,'resume-erp');assert.equal(jobs[0].payload.type,'stock');assert.equal(f.labelCalls(),0);
  const bl={id:'bl',label:'SHO-SYNTHETIC',status:'ready_to_ship',update_stock:false};f.change({...f.actual(),shipping_orders:{data:[bl],paginatorInfo:{hasMorePages:false}}});
  await f.db.query("UPDATE resolution_jobs SET status='complete'");await f.db.query("UPDATE orders SET erp_live=erp_live||$2::jsonb WHERE id=$1",[f.id,JSON.stringify({bl,phase:'bl_ready'})]);
  await f.service.run();assert.equal(f.labelCalls(),1);await f.service.run();assert.equal(f.labelCalls(),1);
  await f.db.query("UPDATE carrier_jobs SET status='ready'");await f.db.query('INSERT INTO carrier_documents(order_id,document_index) VALUES($1,0)',[f.id]);await f.service.run();await f.service.run();
  const r=await f.service.status(run);assert.equal(r.state,'finished');assert.equal(r.plan.rows[0].item.state,'complete');assert.equal(r.plan.rows[0].labels.length,1);assert.match(r.plan.rows[0].labels[0].url,/carriers\/documents/);assert.equal(r.plan.rows[0].currentBl.label,bl.label);
 }finally{await f.engine.close();}
});
test('a new reserved BC enters native receipt recovery without any ERP mutation or extra reservation',async()=>{
 const f=await fixture();try{
  await f.db.query("UPDATE orders SET erp_live=erp_live||'{\"bcReservationPolicy\":\"erplain_bc_bl\"}'::jsonb WHERE id=$1",[f.id]);
  f.change({...f.actual(),update_stock:true,line_items:f.actual().line_items.map(l=>({...l,reserved_quantity:1,shipped_quantity:0,available:0}))});
  const run=await f.start();await f.service.submit({id:run,ids:[f.id]},f.user);await f.service.run();
  const jobs=(await f.db.query('SELECT * FROM resolution_jobs')).rows;assert.equal(jobs.length,1);assert.equal(jobs[0].action,'resume-erp');assert.equal(f.actual().line_items[0].reserved_quantity,1);assert.equal(f.actual().line_items[0].on_hand,1);assert.equal(f.labelCalls(),0);assert.ok(f.calls.every(q=>q.startsWith('query ')));
 }finally{await f.engine.close();}
});
test('receipt execution refuses a reservation lost after preview',async()=>{
 const f=await fixture();try{
  await f.db.query("UPDATE orders SET erp_live=erp_live||'{\"bcReservationPolicy\":\"erplain_bc_bl\"}'::jsonb WHERE id=$1",[f.id]);
  f.change({...f.actual(),update_stock:true,line_items:f.actual().line_items.map(l=>({...l,reserved_quantity:1,shipped_quantity:0,available:0}))});
  const run=await f.start();await f.service.submit({id:run,ids:[f.id]},f.user);
  f.change({...f.actual(),line_items:f.actual().line_items.map(l=>({...l,reserved_quantity:0}))});await f.service.run();
  assert.equal((await f.db.query('SELECT * FROM resolution_jobs')).rows.length,0);assert.match((await f.service.status(run)).plan.rows[0].item.error,/Réservation/);assert.equal(f.labelCalls(),0);
 }finally{await f.engine.close();}
});
test('TEMU never buys or falls back to a direct carrier, returns supplier refusal',async()=>{
 const f=await fixture('temu');try{
  const run=await f.start();await f.service.submit({id:run,ids:[f.id]},f.user);await f.service.run();
  const bl={id:'bl',label:'SHO-TEMU',status:'ready_to_ship',update_stock:false};f.change({...f.actual(),shipping_orders:{data:[bl],paginatorInfo:{hasMorePages:false}}});
  await f.db.query("UPDATE resolution_jobs SET status='complete'");await f.db.query("UPDATE orders SET erp_live=erp_live||$2::jsonb WHERE id=$1",[f.id,JSON.stringify({bl})]);await f.db.query("INSERT INTO temu_label_jobs VALUES('SYNTHETIC','shipment_error','Non-English characters')");
  await f.service.run();await f.service.run();const r=await f.service.status(run);assert.equal(r.state,'finished');assert.equal(r.plan.rows[0].item.state,'label_action_required');assert.match(r.plan.rows[0].labelError,/Non-English/);assert.equal(f.labelCalls(),0);
  await f.db.query("INSERT INTO temu_label_documents(reference,package) VALUES('SYNTHETIC','PK1')");assert.match((await f.service.status(run)).plan.rows[0].labels[0].url,/temu\/pdf/);
 }finally{await f.engine.close();}
});
test('preview changed quantity or suspension cannot enqueue any resume',async()=>{
 const f=await fixture();try{const run=await f.start();await f.service.submit({id:run,ids:[f.id]},f.user);f.change({...f.actual(),line_items:f.actual().line_items.map(l=>({...l,quantity:2}))});await f.service.run();assert.equal((await f.db.query('SELECT * FROM resolution_jobs')).rows.length,0);const r=await f.service.status(run);assert.equal(r.plan.rows[0].item.state,'blocked');assert.match(r.plan.rows[0].item.error,/modifiée/);}finally{await f.engine.close();}
});
test('stock is read again before resume and zero available blocks the operation',async()=>{
 const f=await fixture();try{const run=await f.start();await f.service.submit({id:run,ids:[f.id]},f.user);f.change({...f.actual(),line_items:f.actual().line_items.map(l=>({...l,available:0,on_hand:0}))});await f.service.run();assert.equal((await f.db.query('SELECT * FROM resolution_jobs')).rows.length,0);assert.match((await f.service.status(run)).plan.rows[0].item.error,/Stock insuffisant/);}finally{await f.engine.close();}
});
test('restart between native enqueue and persisted receipt linkage recovers the same request',async()=>{
 const f=await fixture();try{const run=await f.start();await f.service.submit({id:run,ids:[f.id]},f.user);const item=(await f.db.query('SELECT * FROM receipt_recovery_items')).rows[0];const job=await queueResolutionRequest(f.db,{id:f.id,requestId:item.request_id,action:'resume-erp',type:'stock'},f.user);
  const restarted=receiptRecoveryService(f.db,'unused',{api:{request:()=>assert.fail('No provider replay'),verify:()=>{}}});await restarted.run();assert.equal((await f.db.query('SELECT * FROM resolution_jobs')).rows.length,1);assert.equal((await f.db.query('SELECT * FROM receipt_recovery_items')).rows[0].resolution_id,job.id);
 }finally{await f.engine.close();}
});
test('preview and execution permissions, ID binding, freshness and one execution at a time',async()=>{
 const f=await fixture();try{
  await assert.rejects(()=>f.route('/api/receipts/recovery/preview',{number:'PRP1',requestId:randomUUID()},'viewer'),/Forbidden/);
  const requestId=randomUUID(),first=await f.route('/api/receipts/recovery/preview',{number:f.receipt.label,requestId});assert.equal((await f.route('/api/receipts/recovery/preview',{number:f.receipt.label,requestId})).id,first.id);await assert.rejects(()=>f.route('/api/receipts/recovery/preview',{number:'OTHER',requestId}),/autre réception/);
  await f.service.run();await assert.rejects(()=>f.route('/api/receipts/recovery/execute',{id:first.id,ids:[f.id]},'operator'),/Forbidden/);
  await assert.rejects(()=>f.service.submit({id:first.id,ids:[randomUUID()]},f.user),/non admissible/);
  await f.db.query("UPDATE receipt_recovery_runs SET updated_at=now()-interval '31 minutes'");await assert.rejects(()=>f.service.submit({id:first.id,ids:[f.id]},f.user),/récente/);
  await f.db.query('UPDATE receipt_recovery_runs SET updated_at=now()');await f.service.submit({id:first.id,ids:[f.id]},f.user);
  const second=randomUUID();await f.db.query("INSERT INTO receipt_recovery_runs(id,request_id,number,state,created_by,plan) SELECT $1,$2,number,'ready',created_by,plan FROM receipt_recovery_runs WHERE id=$3",[second,randomUUID(),first.id]);await assert.rejects(()=>f.service.submit({id:second,ids:[f.id]},f.user),/autre réception/);
 }finally{await f.engine.close();}
});
test('failed native preparation remains blocked and never submits a label',async()=>{
 const f=await fixture();try{const run=await f.start();await f.service.submit({id:run,ids:[f.id]},f.user);await f.service.run();await f.db.query("UPDATE resolution_jobs SET status='review',error='Stock changed'");await f.service.run();assert.equal(f.labelCalls(),0);assert.equal((await f.service.status(run)).plan.rows[0].item.error,'Stock changed');}finally{await f.engine.close();}
});
test('label continuation never finalizes an in_preparation BL or rereads BC after creation',async()=>{
 const f=await fixture();try{const run=await f.start();await f.service.submit({id:run,ids:[f.id]},f.user);await f.service.run();const bl={id:'bl',status:'in_preparation'};f.change({...f.actual(),shipping_orders:{data:[bl],paginatorInfo:{hasMorePages:false}}});await f.db.query("UPDATE resolution_jobs SET status='complete'");await f.db.query("UPDATE orders SET erp_live=erp_live||$2::jsonb WHERE id=$1",[f.id,JSON.stringify({bl})]);await f.service.run();assert.equal((await f.service.status(run)).plan.rows[0].item.state,'label_pending');assert.equal(f.labelCalls(),1);assert.equal((await f.db.query('SELECT erp_live FROM orders')).rows[0].erp_live.bl.status,'in_preparation');assert.ok(f.calls.every(q=>q.startsWith('query ')));}finally{await f.engine.close();}
});
for(const channel of ['amazon','temu'])test(`${channel}: existing ready BL obtains label without another ERP resume`,async()=>{
 const f=await fixture(channel);try{
  const bl={id:'existing',label:'SHO-EXISTING',status:'ready_to_ship',update_stock:false};f.change({...f.actual(),shipping_orders:{data:[bl],paginatorInfo:{hasMorePages:false}}});await f.db.query("UPDATE orders SET erp_live=erp_live||$2::jsonb WHERE id=$1",[f.id,JSON.stringify({bl,phase:'bl_ready'})]);
  const run=await f.start('documents');assert.equal((await f.service.status(run)).plan.rows[0].canLabel,true);await f.service.submit({id:run,ids:[f.id]},f.user);await f.service.run();assert.equal((await f.db.query('SELECT * FROM resolution_jobs')).rows.length,0);
  if(channel==='temu'){assert.equal(f.labelCalls(),0);assert.equal((await f.service.status(run)).plan.rows[0].item.state,'label_action_required');}
  else{assert.equal(f.labelCalls(),1);await f.service.run();assert.equal(f.labelCalls(),1);await f.db.query("UPDATE carrier_jobs SET status='ready'");await f.db.query('INSERT INTO carrier_documents(order_id,document_index) VALUES($1,0)',[f.id]);await f.service.run();assert.equal((await f.service.status(run)).plan.rows[0].item.state,'complete');}
 }finally{await f.engine.close();}
});
test('another receipt can be analyzed while a native preparation is waiting',async()=>{
 const f=await fixture();try{const first=await f.start();await f.service.submit({id:first,ids:[f.id]},f.user);await f.service.run();
  const duplicate=await f.route('/api/receipts/recovery/preview',{number:f.receipt.label,requestId:randomUUID()});assert.equal(duplicate.id,first);assert.equal(duplicate.existing,true);const second=await f.route('/api/receipts/recovery/preview',{number:'PRP00000245',requestId:randomUUID()});await f.service.run();assert.equal((await f.service.status(second.id)).state,'ready');assert.equal((await f.service.status(first)).state,'applying');assert.equal((await f.db.query('SELECT * FROM resolution_jobs')).rows.length,1);
 }finally{await f.engine.close();}
});

test('created BL label action ignores inactive BC, invalid stock and preview fingerprints without rereading ERP',async()=>{
 const f=await fixture();try{
  const bl={id:'existing',label:'SHO-EXISTING',status:'in_preparation'};
  f.change({...f.actual(),status:'completed',line_items:f.actual().line_items.map(l=>({...l,on_hand:null,available:null})),shipping_orders:{data:[bl],paginatorInfo:{hasMorePages:false}}});
  await f.db.query("UPDATE orders SET erp_live=erp_live||$2::jsonb WHERE id=$1",[f.id,JSON.stringify({bl})]);
  const run=await f.start('documents'),before=f.calls.length;await f.db.query("UPDATE receipt_recovery_runs SET plan=jsonb_set(plan,'{coverage,complete}','false'::jsonb),updated_at=now()-interval '2 days' WHERE id=$1",[run]);await f.service.submit({id:run,ids:[f.id]},f.user);await f.service.run();
  assert.equal(f.calls.length,before);assert.equal(f.labelCalls(),1);assert.equal((await f.db.query('SELECT * FROM resolution_jobs')).rows.length,0);
  assert.equal((await f.db.query('SELECT erp_live FROM orders')).rows[0].erp_live.bl.status,'in_preparation');
 }finally{await f.engine.close();}
});

test('receipt TEMU label purchase uses the native quote and requires explicit tariff confirmation',async()=>{
 const calls=[],f=await fixture('temu',{prepare:async ref=>{calls.push('quote');return {id:'QUOTE',amount:2.67,currency:'EUR'};},buy:async(ref,id,amount)=>{assert.equal(id,'QUOTE');assert.equal(amount,2.67);calls.push('buy');return {status:'pending'};}});
 try{
  const bl={id:'existing',label:'SHO-EXISTING',status:'ready_to_ship'};f.change({...f.actual(),shipping_orders:{data:[bl],paginatorInfo:{hasMorePages:false}}});await f.db.query("UPDATE orders SET erp_live=erp_live||$2::jsonb WHERE id=$1",[f.id,JSON.stringify({bl})]);const run=await f.start('documents');
  await assert.rejects(()=>f.route('/api/receipts/recovery/temu/quote',{id:run,orderId:f.id},'operator'),/Forbidden/);
  const q=await f.route('/api/receipts/recovery/temu/quote',{id:run,orderId:f.id});assert.equal(q.amount,2.67);
  await assert.rejects(()=>f.route('/api/receipts/recovery/temu/buy',{id:run,orderId:f.id,planId:q.planId,amount:q.amount}),/Confirmation/);assert.deepEqual(calls,['quote']);
  await f.route('/api/receipts/recovery/temu/buy',{id:run,orderId:f.id,planId:q.planId,amount:q.amount,confirmPurchase:true});assert.deepEqual(calls,['quote','buy']);assert.equal(f.labelCalls(),0);
 }finally{await f.engine.close();}
});

test('receipt action continues an old native stock hold without a separate finalisation',async()=>{
 const f=await fixture();try{
  await f.db.query('UPDATE orders SET resolution_pending_resume=true WHERE id=$1',[f.id]);
  const run=await f.start();await f.service.submit({id:run,ids:[f.id]},f.user);await f.service.run();
  const jobs=(await f.db.query('SELECT * FROM resolution_jobs')).rows;assert.equal(jobs.length,1);assert.equal(jobs[0].action,'resume-erp');assert.equal(f.labelCalls(),0);
 }finally{await f.engine.close();}
});

test('receipt preview refreshes related BC individually before showing its BL status',async()=>{
 const f=await fixture();try{
  const bl={id:'existing',label:'SHO-EXISTING',status:'ready_to_ship',update_stock:false};
  f.change({...f.actual(),shipping_orders:{data:[bl],paginatorInfo:{hasMorePages:false}}});
  await f.db.query("UPDATE orders SET resolution_pending_resume=true,erp_live=erp_live||$2::jsonb WHERE id=$1",[f.id,JSON.stringify({bl:{...bl,status:'make_the_shipment'},stockDocument:{id:'stock',status:'completed'}})]);
  await f.db.query("INSERT INTO carrier_jobs VALUES($1,'ready','production','[]',null)",[f.id]);await f.db.query('INSERT INTO carrier_documents(order_id,document_index) VALUES($1,0)',[f.id]);
  const run=await f.start('documents');const state=await f.service.status(run);
  assert.ok(f.calls.some(q=>q.includes('DocumentRead')));assert.equal(state.plan.rows[0].currentBl.status,'ready_to_ship');assert.match(state.plan.rows[0].reason,/aucune nouvelle génération/);assert.equal(state.plan.rows[0].labels.length,1);
  assert.equal((await f.db.query('SELECT * FROM resolution_jobs')).rows.length,0);assert.equal(f.labelCalls(),0);
 }finally{await f.engine.close();}
});

test('receipt outcome requires every parcel PDF, preserves in_preparation and resumes incomplete analysis only',async()=>{
 const f=await fixture();try{
  const bl={id:'existing',label:'SHO-EXISTING',status:'in_preparation'};
  f.change({...f.actual(),shipping_orders:{data:[bl],paginatorInfo:{hasMorePages:false}}});
  await f.db.query("UPDATE orders SET parcel_count=2,erp_live=erp_live||$2::jsonb WHERE id=$1",[f.id,JSON.stringify({bl})]);
  await f.db.query("INSERT INTO carrier_jobs VALUES($1,'ready','production','[]',null)",[f.id]);await f.db.query('INSERT INTO carrier_documents(order_id,document_index) VALUES($1,0)',[f.id]);
  const run=await f.start('blocked');let s=await f.service.status(run);assert.equal(s.outcome.existing.length,0);assert.equal(s.outcome.unfinished.length,1);
  await f.db.query('INSERT INTO carrier_documents(order_id,document_index) VALUES($1,1)',[f.id]);s=await f.service.status(run);assert.equal(s.outcome.existing.length,1);assert.equal(s.plan.rows[0].currentBl.status,'in_preparation');
  await assert.rejects(f.route('/api/receipts/recovery/resume',{id:run}),/ne peut pas/);
  await f.db.query("UPDATE receipt_recovery_runs SET plan=jsonb_set(plan,'{coverage,complete}','false') WHERE id=$1",[run]);
  await assert.rejects(f.route('/api/receipts/recovery/resume',{id:run},'operator'),/Forbidden/);
  await f.route('/api/receipts/recovery/resume',{id:run});assert.equal((await f.service.status(run)).state,'queued');await f.service.run();assert.equal((await f.service.status(run)).plan.coverage.complete,true);
  await f.db.query("UPDATE orders SET label_status='cancelled' WHERE id=$1",[f.id]);s=await f.service.status(run);assert.equal(s.outcome.existing.length,0);assert.equal(s.outcome.excluded.length,1);
 }finally{await f.engine.close();}
});
