import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {automaticContinuationKey} from '../src/erplain-efficiency-policy.mjs';
import {stockSignal,stockSignature} from '../src/grouped-stock-watch.mjs';
import {initializeStockResumeWatch,stockResumeWorker,verifiedStock} from '../src/stock-resume-watch.mjs';
import {confirmDeliveryReady} from '../src/bl-ready.mjs';
import {assertFullOrderStock} from '../src/stock-gate.mjs';
import {observeErplainRequest,withErplainOrigin,erplainOperation} from '../src/erplain-request-observation.mjs';
import {sharedErplainReference} from '../src/erplain-reference-cache.mjs';
import {assertRecordedBc} from '../src/existing-bc-execution.mjs';
import {buildBcPricing} from '../src/bc-pricing.mjs';

test('inconsistent source total is an observation; supplier-calculated lines retain their real quantities',()=>{
 const pricing=buildBcPricing({channel:'samples',source_payload:{},address:{country:'FR'}},[{quantity:2,source_sku:'A',source_payload:{puht:10,taxes:20,total:999}}],[{quantity:2,variant:{id:1}}],[{id:'tax',tax_rates:[{rate:20}]}]);
 assert.equal(pricing.sourceLinesTotal,24);assert.equal(pricing.items[0].quantity,2);assert.equal(pricing.items[0].price,10);assert.equal(pricing.sourceTotalObservation.blocking,false);
});
test('old fiscal uncertainty is reconciled on products, quantities and policy alone; mapping uncertainty remains protected',()=>{
 const before={id:7,status:'active',update_stock:true,line_items:[{type:'normal',quantity:2,variant:{id:1},location:{id:2}}]},o={erp_live:{bc:{id:7},sourceVatAttempt:{status:'uncertain',stockPolicy:true,before}}};
 assert.doesNotThrow(()=>assertRecordedBc(o,{...before,total:999,currency:{label:'USD'},line_items:before.line_items.map(l=>({...l,price:42,tax_codes:[]}))}));
 const changed=structuredClone(before);changed.line_items[0].quantity=3;assert.throws(()=>assertRecordedBc(o,changed),/incertaine/);
 o.erp_live.mappingAlignmentAttempt={status:'uncertain'};assert.throws(()=>assertRecordedBc(o,before),/incertaine/);
});

test('identical concurrent lookups share one load without a TTL; final stock and status guards always load separately',async()=>{
 const c={url:'https://api.erplain.app/graphql',companyId:100174,apiKey:'fixture-only'},fetcher=()=>{},query='query V3BcLookup($where:Input!){Variants(where:$where){data{id}}}';let calls=0,release;
 const load=async()=>{calls++;await new Promise(resolve=>release=resolve);return {data:[{id:1}]};};
 const a=sharedErplainReference(c,query,{where:{b:2,a:1}},fetcher,load),b=sharedErplainReference(c,query,{where:{a:1,b:2}},fetcher,load);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);release();const [x,y]=await Promise.all([a,b]);x.data[0].id=9;assert.equal(y.data[0].id,1);
 await sharedErplainReference(c,query,{},fetcher,async()=>{calls++;return {};});assert.equal(calls,2);
 for(const guard of ['V3NativeBlCycle','V3CheckFullStock','V3DeliveryReady','V3BlBeforeNumber']){let n=0;await Promise.all([1,2].map(()=>sharedErplainReference(c,'query '+guard+'{Order(id:1){id}}',{},fetcher,async()=>{n++;return {};})));assert.equal(n,2);}
});

test('automatic continuation ignores diagnostic timestamps but responds to quantities, availability, identity and holds',()=>{
 const o={id:'a',erp_live:{phase:'bc_created',bc:{id:7,status:'active',update_stock:true,line_items:[{quantity:10,available:0,on_hand:0,reserved_quantity:0,variant:{id:2},location:{id:1}}]}}};
 const first=automaticContinuationKey(o,{mappingFingerprint:'m',checkedAt:'first'});
 assert.equal(automaticContinuationKey({...o,issue:'another diagnostic',updated_at:'later'},{mappingFingerprint:'m',checkedAt:'second'}),first);
 for(const edit of [x=>x.erp_live.bc.line_items[0].quantity++,x=>x.erp_live.bc.line_items[0].on_hand++,x=>x.erp_live.bc.id++,x=>x.suspension={active:true},x=>x.source_payload={visibilityHold:true}]){const changed=structuredClone(o);edit(changed);assert.notEqual(automaticContinuationKey(changed,{mappingFingerprint:'m'}),first);}
});
test('invalid quantities are rejected even for products not tracking inventory',()=>{
 for(const quantity of [null,undefined,'',0,-1,'bad'])assert.throws(()=>assertFullOrderStock([{quantity,variant:{id:1,sku:'A',track_inventory:false}}]),/Quantité/);
 assert.doesNotThrow(()=>assertFullOrderStock([{quantity:2,variant:{id:1,track_inventory:false}}]));
});
test('native watcher accepts reservation policy true and still refuses incomplete BL searches and shortages',()=>{
 const s=snapshot('1',0);assert.throws(()=>verifiedStock(s,'1',{native:true}),/stock insuffisant/);
 assert.throws(()=>verifiedStock(snapshot('1',10),'1'),/BC à vérifier/);
 assert.doesNotThrow(()=>verifiedStock(snapshot('1',10),'1',{native:true}));
 const bad=snapshot('1',10);bad.shipping_orders.paginatorInfo.hasMorePages=true;assert.throws(()=>verifiedStock(bad,'1',{native:true}),/incomplète/);
});
test('stock signal rejects incomplete and ambiguous responses; no old success on a read failure',()=>{
 const v=variant(0),state=stockSignal(v,'2');
 assert.deepEqual(state.levels,[['1',0,0]]);
 for(const edit of [x=>x.id=9,x=>x.stock_levels.paginatorInfo.hasMorePages=true,x=>x.stock_levels.data[0].on_hand=null,x=>delete x.stock_levels]){const bad=structuredClone(v);edit(bad);assert.throws(()=>stockSignal(bad,'2'));}
 assert.equal(stockSignature(['2'],new Map([['2',{state,checked_at:new Date(),last_error:'timeout'}]])),null);
});
test('telemetry records origin and HTTP outcome without headers, bodies, URLs or variables',async()=>{
 const logs=[],logger={info:x=>logs.push(JSON.parse(x))};
 await withErplainOrigin('stock-resume',async()=>observeErplainRequest({...erplainOperation({body:JSON.stringify({query:'query V3WaitingStock($secret:ID!){Variant(id:$secret){id}}',variables:{secret:'private'}})}),outcome:'response',status:200,headers:'private',url:'private'},logger));
 assert.equal(logs[0].origin,'stock-resume');assert.equal(logs[0].operation,'V3WaitingStock');assert.doesNotMatch(JSON.stringify(logs),/private|headers|variables/);
 assert.doesNotThrow(()=>observeErplainRequest({outcome:'response'},{info:()=>{throw Error('disk');}}));
});
test('native ready transition uses BL alone and complete mutation response; forbidden transition never writes',async()=>{
 for(const initial of ['pending','ready_to_ship','in_preparation']){
  const calls=[];const api={request:async(q,v)=>{calls.push(q);assert.doesNotMatch(q,/\bOrder\(|InventoryLogs|StockRemoval/);if(q.startsWith('mutation'))return {UpdateShippingOrder:{id:'9',label:'SHO00744947',status:'ready_to_ship'}};return {ShippingOrder:{id:'9',label:'SHO00744947',status:initial}};}};
  const run=()=>confirmDeliveryReady(api,{bcId:7,blId:9,stockOnBc:true,nativeErplainCycle:true});
  if(initial==='in_preparation'){await assert.rejects(run,/interdit/);assert.equal(calls.length,1);}else{assert.equal((await run()).status,'ready_to_ship');assert.equal(calls.length,initial==='pending'?2:1);}
 }
});

function snapshot(id,stock){return {id,status:'active',update_stock:true,line_items:[{type:'normal',quantity:10,available:stock,on_hand:stock,reserved_quantity:0,variant:{id:'2',sku:'A',track_inventory:true},location:{id:'1'}}],shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}};}
function variant(stock){return {id:'2',active:true,track_inventory:true,stock_levels:{data:[{location:{id:'1'},available:stock,on_hand:stock}],paginatorInfo:{hasMorePages:false}}};}
let db;
after(async()=>{if(db)await db.close();});
async function fixture(){
 if(db)await db.close();db=new PGlite();
 await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,reference text,channel text DEFAULT 'amazon',erp_live jsonb,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,resolution_pending_resume boolean DEFAULT false,tracking_status text DEFAULT 'not_shipped',label_status text DEFAULT 'pending',suspension jsonb DEFAULT '{}',source_payload jsonb DEFAULT '{}',processing_priority_at timestamptz,address jsonb DEFAULT '{}',weight_kg numeric);
 CREATE TABLE erp_live_jobs(order_id text PRIMARY KEY,status text,error text,updated_at timestamptz DEFAULT now());CREATE TABLE carrier_jobs(order_id text,status text,stock_override jsonb);CREATE TABLE partial_deliveries(id text,order_id text,bl jsonb,stock_document jsonb,selection jsonb,updated_at timestamptz DEFAULT now());
 CREATE TABLE resolution_jobs(id text,order_id text,request_id text,action text,status text,stage text,payload jsonb,result jsonb,created_at timestamptz DEFAULT now());CREATE TABLE audit(user_email text,action text,detail jsonb);CREATE TABLE settings(key text,value jsonb);
 INSERT INTO settings VALUES('automatic_live','{"enabled":true}');`);
 for(const id of ['a','b']){await db.query('INSERT INTO orders(id,reference,erp_live) VALUES($1,$1,$2)',[id,JSON.stringify({phase:'bc_created',bcReservationPolicy:'erplain_bc_bl',bc:{id:id==='a'?'7':'8',status:'active'}})]);await db.query("INSERT INTO erp_live_jobs(order_id,status,error) VALUES($1,'review','BL bloqué — stock insuffisant : A')",[id]);}
 await initializeStockResumeWatch(db);
 return {query:db.query.bind(db),exec:db.exec.bind(db),transaction:db.transaction.bind(db)};
}
function provider(state){return {verify:async()=>{},request:async(q,v)=>{
 if(q.includes('V3WaitingStock')){state.variantReads++;return Object.fromEntries(Object.keys(v).map(key=>[key,variant(state.stock)]));}
 assert.match(q,/V3StockResume/);state.documentReads++;return {b0:snapshot(v.b0,state.stock)};
}};}
async function dueResources(){await db.query("UPDATE stock_resume_resources SET next_at=now()-interval '1 second'");}
test('two waiting orders share one variant poll; unchanged stock does not reread BCs; receipt resumes both without provider writes',async()=>{
 const conn=await fixture(),state={stock:0,variantReads:0,documentReads:0},api=provider(state),worker=stockResumeWorker(conn,'unused',{api});
 await worker.run();assert.equal(state.documentReads,2);assert.equal((await db.query('SELECT * FROM resolution_jobs')).rows.length,0);
 await worker.run();assert.equal(state.variantReads,1);assert.equal(state.documentReads,4); // first complete resource signature
 await dueResources();await worker.run();assert.equal(state.variantReads,2);assert.equal(state.documentReads,4);
 // Process restart preserves all deadlines and requirements.
 await initializeStockResumeWatch(conn);await stockResumeWorker(conn,'unused',{api}).run();assert.equal(state.variantReads,2);assert.equal(state.documentReads,4);
 state.stock=10;await dueResources();await worker.run();assert.equal(state.variantReads,3);assert.equal(state.documentReads,6);
 const jobs=(await db.query('SELECT * FROM resolution_jobs')).rows;assert.equal(jobs.length,2);assert.ok(jobs.every(x=>x.status==='waiting'&&x.payload.automaticStockResume));
 await worker.run();assert.equal((await db.query('SELECT * FROM resolution_jobs')).rows.length,2);
});
test('failed resource poll never reuses old readiness; 15-minute catchup rechecks reservations and missed requirements',async()=>{
 const conn=await fixture(),state={stock:0,variantReads:0,documentReads:0},base=provider(state);let fail=false;
 const api={...base,request:async(q,v)=>{if(fail&&q.includes('V3WaitingStock'))throw Error('timeout');return base.request(q,v);}};
 const worker=stockResumeWorker(conn,'unused',{api});await worker.run();await worker.run();
 state.stock=10;fail=true;await dueResources();await worker.run();assert.equal(state.documentReads,4);assert.equal((await db.query('SELECT * FROM resolution_jobs')).rows.length,0);
 fail=false;await db.query("UPDATE stock_resume_requirements SET checked_at=now()-interval '16 minutes'");await db.query("UPDATE stock_resume_watch SET next_at=now()-interval '1 second'");await worker.run();assert.equal(state.documentReads,6);assert.equal((await db.query('SELECT * FROM resolution_jobs')).rows.length,2);
});
test('cancellation or suspension after a resource read prevents automatic admission',async()=>{
 const conn=await fixture(),state={stock:0,variantReads:0,documentReads:0},base=provider(state);let suspend=false;
 const api={...base,request:async(q,v)=>{const r=await base.request(q,v);if(suspend&&q.includes('V3StockResume'))await db.query("UPDATE orders SET suspension='{\"active\":true}' WHERE id='a'");return r;}};
 const worker=stockResumeWorker(conn,'unused',{api});await worker.run();await worker.run();state.stock=10;suspend=true;await dueResources();await worker.run();
 assert.deepEqual((await db.query('SELECT order_id FROM resolution_jobs')).rows.map(x=>x.order_id),['b']);
});
test('rollback switch uses previous batched order watcher while still recognizing native reservation policy',async()=>{
 const conn=await fixture(),state={stock:10,variantReads:0,documentReads:0};
 const api={verify:async()=>{},request:async(q,v)=>{assert.match(q,/V3StockResume/);state.documentReads++;return Object.fromEntries(Object.entries(v).map(([key,id])=>[key,snapshot(id,10)]));}};
 await stockResumeWorker(conn,'unused',{api,grouped:()=>false}).run();assert.equal(state.variantReads,0);assert.equal((await db.query('SELECT * FROM resolution_jobs')).rows.length,2);
});
test('a receipt cannot bypass a provider cooldown; retry is automatic after the scheduled delay',async()=>{
 const conn=await fixture(),state={stock:0,variantReads:0,documentReads:0},base=provider(state);let fail=false,calls=0;
 const api={...base,request:async(q,v)=>{if(q.includes('V3StockResume')){calls++;if(fail)throw Object.assign(Error('Erplain HTTP 429'),{httpStatus:429,retryAfter:10});}return base.request(q,v);}};
 const worker=stockResumeWorker(conn,'unused',{api});await worker.run();await worker.run();
 state.stock=10;fail=true;await dueResources();await worker.run();const afterFailure=calls;
 const w=(await db.query("SELECT extract(epoch from next_at-checked_at) seconds,failures FROM stock_resume_watch WHERE order_id='a'")).rows[0];assert.equal(Number(w.seconds),10);assert.equal(w.failures,1);
 state.stock=20;await dueResources();await worker.run();assert.equal(calls,afterFailure);
 fail=false;await db.query("UPDATE stock_resume_watch SET next_at=now()-interval '1 second'");await worker.run();assert.equal((await db.query('SELECT * FROM resolution_jobs')).rows.length,2);
});
test('new worker releases only interrupted read leases and leaves operational jobs/documents untouched',async()=>{
 const conn=await fixture(),before=(await db.query('SELECT * FROM orders ORDER BY id')).rows;
 await db.query("INSERT INTO stock_resume_watch(order_id,next_at,outcome) VALUES('a',now()+interval '5 minutes','checking'),('b',now()+interval '5 minutes','waiting')");
 await initializeStockResumeWatch(conn,{resumeReadLeases:true});
 const watches=(await db.query('SELECT order_id,outcome,next_at<=now() due FROM stock_resume_watch ORDER BY order_id')).rows;
 assert.equal(watches[0].due,true);assert.equal(watches[1].due,false);assert.equal(watches[0].outcome,'waiting');
 assert.deepEqual((await db.query('SELECT * FROM orders ORDER BY id')).rows,before);assert.equal((await db.query('SELECT * FROM resolution_jobs')).rows.length,0);
});
