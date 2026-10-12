import test from'node:test';import assert from'node:assert/strict';
import{reconcileCancelledCycleDiagnostic as reconcile}from'../src/cancelled-cycle-diagnostic-reconcile.mjs';
import{oldCycleDiagnostic,currentCycleDiagnostic}from'../src/cancelled-cycle-diagnostic-plan.mjs';
const at=Date.parse('2026-10-12T01:00:00Z');
function fixture(){
 const initial={order:{id:'o',channel:'amazon',reference:'r',issue:null,erp_live:{phase:'creating_stock',bc:{id:2},bl:{id:3},previousCancelledCycle:{bc:{id:1}},stockLastFailure:{message:oldCycleDiagnostic}},tracking_status:'not_shipped',label_status:'production_pending'},erp:{status:'review',error:oldCycleDiagnostic},reviews:[{id:'j',status:'review',action:'resume-erp',error:oldCycleDiagnostic}],carrier:{status:'ready',environment:'production',error:null,tracking:['t']},docs:[{document_index:0,pdf:Buffer.from('%PDF-immutable')}],copies:[],audit:[]};
 let state=structuredClone(initial),failAudit=false;const writes=[];
 function queryFor(get){return async(q,a)=>{const s=get();
  if(q.startsWith('SELECT * FROM orders'))return{rows:structuredClone([s.order])};if(q.startsWith('SELECT * FROM erp_live_jobs'))return{rows:structuredClone([s.erp])};if(q.startsWith('SELECT * FROM resolution_jobs'))return{rows:structuredClone(s.reviews)};if(q.startsWith('SELECT * FROM carrier_jobs'))return{rows:structuredClone([s.carrier])};if(q.startsWith('SELECT document_index,pdf'))return{rows:structuredClone(s.docs)};if(q.startsWith('SELECT id,document_key'))return{rows:structuredClone(s.copies)};if(q.startsWith('SELECT 1 FROM correction_jobs'))return{rows:[]};
  writes.push(q);
  if(q.startsWith('UPDATE erp_live_jobs')){s.erp.error=a[2];return{rows:[{order_id:'o'}]};}
  if(q.startsWith('UPDATE resolution_jobs')){s.reviews[0].error=a[2];return{rows:[{id:'j'}]};}
  if(q.startsWith('UPDATE orders')){s.order.issue=a[1];s.order.erp_live=JSON.parse(a[2]);return{rows:[]};}
  if(q.startsWith('INSERT INTO audit')){if(failAudit)throw Error('audit rollback');s.audit.push(a[0]);return{rows:[]};}
  throw Error('Unexpected SQL '+q);
 };}
 const db={query:queryFor(()=>state),transaction:async fn=>{const working=structuredClone(state);const result=await fn({query:queryFor(()=>working)});state=working;return result;}};
 let time=at,mutation=null;
 const bc={id:2,status:'active',update_stock:false,external_reference:'r',shipping_orders:{data:[{id:3,status:'pending',update_stock:false,external_reference:'r'}],paginatorInfo:{hasMorePages:false}}};
 const options={now:()=>time,assertIdle:async()=>{},readDocuments:async()=>{mutation?.();return bc;},provePrevious:async()=>({oldBcId:'1',currentBcId:'2',oldBcCancelled:true,oldBcManagedStock:false,noShippingOrders:true,noStockRemovals:true,evidence:[{complete:true}]})};
 const api={request:async q=>{assert.match(q,/^query/);return{StockRemovals:{data:[],paginatorInfo:{hasMorePages:false}}};}};
 return{db,api,options,writes,initial,get state(){return state;},race(fn){mutation=()=>fn(state);},slow(){mutation=()=>{time=at+300001;};},auditFail(){failAudit=true;}};
}
test('replace exact obsolete errors; preserve job states, documents, tracking and BC/BL IDs',async()=>{const f=fixture();const result=await reconcile(f.db,f.api,'o',f.options);assert.equal(result.updated,true);assert.equal(f.state.erp.error,currentCycleDiagnostic);assert.equal(f.state.reviews[0].error,currentCycleDiagnostic);assert.equal(f.state.erp.status,'review');assert.equal(f.state.reviews[0].status,'review');assert.deepEqual(f.state.docs,structuredClone(f.initial.docs));assert.deepEqual(f.state.carrier,f.initial.carrier);for(const k of ['bc','bl','previousCancelledCycle'])assert.deepEqual(f.state.order.erp_live[k],f.initial.order.erp_live[k]);assert.equal(f.state.audit.length,1);assert.equal(result.businessCompleted,false);assert.equal(f.writes.length,4);});
test('dry run performs no diagnostic writes',async()=>{const f=fixture();assert.equal((await reconcile(f.db,f.api,'o',{...f.options,dryRun:true})).eligible,true);assert.deepEqual(f.writes,[]);});
for(const [name,mutate]of Object.entries({pdf:s=>s.docs[0].pdf=Buffer.from('%PDF-changed'),review:s=>s.reviews[0].error='new failure',order:s=>s.order.erp_live.bl.id=99,printedCopy:s=>s.copies.push({id:'copy',pdf:Buffer.from('%PDF-copy')})}))test('abort when '+name+' changes during supplier read',async()=>{const f=fixture();f.race(mutate);assert.equal((await reconcile(f.db,f.api,'o',f.options)).changedDuringRead,true);assert.deepEqual(f.writes,[]);});
test('slow supplier evidence is not stamped fresh after reading',async()=>{const f=fixture();f.slow();assert.equal((await reconcile(f.db,f.api,'o',f.options)).reason,'proof_expired');assert.deepEqual(f.writes,[]);});
test('audit failure rolls back all diagnostic updates',async()=>{const f=fixture();f.auditFail();await assert.rejects(reconcile(f.db,f.api,'o',f.options),/audit rollback/);assert.deepEqual(f.state,structuredClone(f.initial));});
test('repeat after success is a no-op',async()=>{const f=fixture();await reconcile(f.db,f.api,'o',f.options);f.writes.length=0;assert.equal((await reconcile(f.db,f.api,'o',f.options)).notApplicable,true);assert.deepEqual(f.writes,[]);});
test('supplier mutation is rejected even from an injected reader',async()=>{const f=fixture();await assert.rejects(reconcile(f.db,f.api,'o',{...f.options,provePrevious:async api=>api.request('mutation Incorrect{write}')}),/mutation prohibited/);assert.deepEqual(f.writes,[]);});
test('supplier pagination is capped at sixteen reads per candidate and never patches incomplete proof',async()=>{const f=fixture();let reads=0;f.api.request=async()=>{reads++;return{};};await assert.rejects(reconcile(f.db,f.api,'o',{...f.options,provePrevious:async api=>{for(let i=0;i<100;i++)await api.request('query Bounded{read}');}}),/read limit exceeded/);assert.equal(reads,16);assert.deepEqual(f.writes,[]);});
