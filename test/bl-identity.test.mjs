import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {observeBlIdentity,applyBlIdentityObservation,visibleOrderBls} from '../src/bl-identity.mjs';
import {erplainStatusSync} from '../src/erplain-status.mjs';
import {prepareBlIdentityRepair,commitBlIdentityRepair} from '../src/bl-identity-repair.mjs';

const connection=data=>({data,paginatorInfo:{hasMorePages:false}});
function fixture(){
 const o={id:'o1',reference:'ref',suspension:{},tracking_status:'unknown',label_status:'simulated',archived:false,partial_mode:false,erp_live:{phase:'publishing_bl',bc:{id:7,label:'C7'},bl:{id:9,label:'SHO00744466',status:'unpublished',update_stock:false}}};
 const bc={id:7,label:'C7',status:'active',created_at:'2026-10-12 20:00:00',update_stock:false,line_items:[{id:5,type:'normal',quantity:100,reserved_quantity:0,shipped_quantity:0,variant:{id:3,track_inventory:true},location:{id:4}}],shipping_orders:connection([])};
 const f={o,bc,actual:null,last:null,logs:[],jobs:[],docs:[],calls:[],writes:[]};
 f.db={query:async(q,p)=>{if(q.startsWith('SELECT')&&q.includes('FROM orders'))return {rows:[f.o]};if(q.startsWith('SELECT * FROM carrier_jobs'))return {rows:f.jobs};if(q.startsWith('SELECT document_index'))return {rows:f.docs};if(q.startsWith('UPDATE')||q.startsWith('INSERT'))f.writes.push({q,p});return {rows:[]};}};
 f.api={request:async(q,v)=>{assert.match(q,/^query /);f.calls.push({q,v});if(q.includes('V3DocumentRead'))return {Order:structuredClone(f.bc)};if(q.includes('V3IdentityRepairRead'))return {Order:{id:7,created_at:bc.created_at},ShippingOrder:f.actual};if(q.includes('V3IdentityRepairLast'))return {ShippingOrder:f.last};if(q.includes('V3HistoricalExtraStock'))return {StockRemovals:connection([])};if(q.includes('V3MissingBlLedger'))return {InventoryLogs:connection(f.logs)};throw Error('Unexpected query '+q);}};
 f.run=options=>prepareBlIdentityRepair(f.db,f.api,f.o,{now:0,...options});return f;
}

test('missing ID is observed without adopting another document with the same number',()=>{
 const f=fixture(),before=structuredClone(f.o.erp_live),next=applyBlIdentityObservation(before,f.bc,null,{now:0});
 assert.equal(next.blIdentity.status,'missing');assert.deepEqual(next.bl,before.bl);assert.deepEqual(visibleOrderBls({erp_live:next}),[]);assert.deepEqual(before,f.o.erp_live);
});
test('cancelled detached pointer displays only the current related BL',()=>{
 const f=fixture();f.o.erp_live.bl.status='pending';const current={id:11,label:'SHO00743542',status:'in_preparation'};f.bc.shipping_orders.data=[current];
 const next=applyBlIdentityObservation(f.o.erp_live,f.bc,{id:9,label:'SHO00744466',status:'cancelled'});
 assert.equal(next.blIdentity.status,'detached');assert.deepEqual(visibleOrderBls({erp_live:next}),[current]);assert.equal(next.bl.id,9);
});
test('published response updates a changed number by immutable ID',()=>{
 const f=fixture(),bl={id:9,label:'SHO00744467',status:'pending'};f.bc.shipping_orders.data=[bl];
 const next=applyBlIdentityObservation(f.o.erp_live,f.bc,bl);assert.equal(next.bl.label,bl.label);assert.deepEqual(visibleOrderBls({erp_live:next}),[bl]);
});
test('draft numbers never appear as confirmed including partial deliveries',()=>{
 const f=fixture();assert.deepEqual(visibleOrderBls(f.o),[]);assert.deepEqual(visibleOrderBls({partial_mode:true},[f.o.erp_live.bl,{id:10,status:'pending'}]),[{id:10,status:'pending'}]);
 const next=applyBlIdentityObservation(f.o.erp_live,f.bc,{...f.o.erp_live.bl});assert.equal(next.blIdentity.status,'draft');assert.deepEqual(visibleOrderBls({erp_live:next}),[]);
});
test('old identity proof cannot hide a new document or a published former draft',()=>{
 const f=fixture(),s=applyBlIdentityObservation(f.o.erp_live,f.bc,null);s.bl={id:10,label:'new',status:'pending'};assert.equal(visibleOrderBls({erp_live:s})[0].id,10);
 const d=applyBlIdentityObservation(f.o.erp_live,f.bc,{...f.o.erp_live.bl});d.bl.status='pending';assert.equal(visibleOrderBls({erp_live:d})[0].id,9);
});
for(const [name,change,bl] of [
 ['incomplete pagination',f=>f.bc.shipping_orders.paginatorInfo.hasMorePages=true,null],
 ['missing GraphQL field',()=>{},undefined],
 ['wrong response ID',()=>{},{id:99}],
 ['contradictory reads',f=>f.bc.shipping_orders.data=[{id:9,status:'pending'}],null],
 ['missing BC',f=>f.bc=null,null]
])test(name+' cannot establish absence',()=>{const f=fixture();change(f);assert.throws(()=>observeBlIdentity(f.o.erp_live,f.bc,bl));});

test('status refresh preserves worker updates using compare-and-swap',async()=>{
 const f=fixture();let updates=0;const db={query:async(q,p)=>{if(q.startsWith('SELECT'))return {rows:[f.o]};updates++;assert.match(q,/AND erp_live=\$3::jsonb/);assert.deepEqual(JSON.parse(p[2]),f.o.erp_live);return {rows:[]};}};
 const api={verify:async()=>{},request:async()=>({b0:f.bc,s0:null})};
 const r=await erplainStatusSync(db,'',{apiFactory:()=>api}).refresh();assert.equal(updates,1);assert.equal(r.changedDuringRead,1);assert.equal(r.done,0);
});
test('provider read failure never stores an absence or clears local references',async()=>{
 const f=fixture();const api={verify:async()=>{},request:async()=>{throw Error('429');}};
 await assert.rejects(erplainStatusSync(f.db,'',{apiFactory:()=>api}).refresh(),/429/);assert.equal(f.writes.length,0);assert.equal(f.o.erp_live.bl.id,9);
});

test('repair of absent draft archives pointer with no provider writes or automatic resume',async()=>{
 const f=fixture(),next=await f.run();assert.equal(next.bl,undefined);assert.equal(next.phase,'bc_created');assert.equal(next.blIdentityRepairs[0].previousBl.id,9);assert.equal(f.writes.length,0);
 await commitBlIdentityRepair(f.db,f.o,next);assert.equal(f.writes.length,2);assert.equal(f.writes[0].p[2],true);assert.match(f.writes[0].q,/resolution_pending_resume=CASE/);assert.ok(f.writes.every(w=>!w.q.includes('erp_live_jobs')&&!w.q.includes('carrier_jobs')));
});
test('repair retires stale transient retry state while retaining the first failure',async()=>{
 const f=fixture();f.o.erp_live.transientRecovery={originalError:'first provider failure',lastError:'Erplain HTTP 429',reconciliationError:'BL différent',readRateLimited:true};
 const next=await f.run();assert.equal(next.transientRecovery.originalError,'first provider failure');assert.equal(next.transientRecovery.lastError,null);assert.equal(next.transientRecovery.reconciliationError,null);assert.equal(next.blIdentityRepairs[0].previousTransientRecovery.lastError,'Erplain HTTP 429');
});
test('existing production PDF and tracking are hashed and preserved during local repair',async()=>{
 const f=fixture();f.jobs=[{status:'ready',environment:'production',tracking:['YT123']}];f.docs=[{document_index:0,pdf:Buffer.from('existing PDF')}];
 const next=await f.run();assert.equal(next.blIdentityRepairs[0].carrier.jobs[0].tracking[0],'YT123');assert.match(next.blIdentityRepairs[0].carrier.documents[0].sha256,/^[0-9a-f]{64}$/);
 await commitBlIdentityRepair(f.db,f.o,next);assert.equal(f.docs[0].pdf.toString(),'existing PDF');assert.ok(f.writes.every(w=>!w.q.includes('carrier_documents')));
});
test('missing stock-enabled draft requires historical stock proof and a zero-net old BL ledger',async()=>{
 const f=fixture();f.o.erp_live.bl.update_stock=true;f.bc.update_stock=true;let proofCalls=0;
 const next=await f.run({stockReader:async(api,bc,options)=>{proofCalls++;assert.equal(options.beforeBlPublication,true);assert.equal(bc.id,7);return {proof:{bcId:'7',stockOnBc:true}};}});
 assert.equal(proofCalls,1);assert.equal(next.blIdentityRepairs[0].stockProof.stockOnBc,true);
});
test('orphan stock movement forbids retirement even when document ID is absent',async()=>{
 const f=fixture();f.logs=[{id:1,document_id:9,order_type:'ShippingOrder',on_hand_diff:-100,available_diff:0,variant:{id:3},location:{id:4}}];
 await assert.rejects(f.run(),/effet stock/);assert.equal(f.writes.length,0);
});
test('active carrier, prior stock uncertainty, suspension and changed provider documents refuse repair',async()=>{
 for(const change of [f=>f.jobs=[{status:'creating'}],f=>f.o.erp_live.stockCreationAttemptedAt='now',f=>f.o.suspension.active=true,f=>f.last={id:9,label:'new',status:'pending'}]){
  const f=fixture();change(f);await assert.rejects(f.run());assert.equal(f.writes.length,0);
 }
});
test('new PDF or order changes arriving before commit refuse the repair',async()=>{
 for(const change of [f=>f.docs=[{document_index:0,pdf:Buffer.from('new')}],f=>f.o={...f.o,tracking_status:'shipped'}]){
  const f=fixture(),original=structuredClone(f.o),next=await f.run();change(f);await assert.rejects(commitBlIdentityRepair(f.db,original,next));assert.equal(f.writes.length,0);
 }
});
test('detached cancelled references are archived and replaced only by the BC relation',async()=>{
 for(const cancelled of [false,true]){
  const f=fixture();f.o.erp_live.bl.status='pending';f.actual={id:9,label:'SHO00744466',status:'cancelled',orders:connection([])};f.last={id:9,label:'SHO00744466',status:'cancelled'};
  f.bc.status=cancelled?'cancelled':'active';f.bc.shipping_orders.data=[{id:11,label:'current',status:cancelled?'cancelled':'in_preparation'}];
  const next=await f.run();assert.equal(next.bl.id,11);assert.equal(next.bl.status,cancelled?'cancelled':'in_preparation');assert.equal(next.blIdentityRepairs[0].previousBl.id,9);assert.equal(next.phase,'publishing_bl');
 }
});
test('BL column separates obsolete and draft references; historical text is escaped',async()=>{
 const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8'),start=app.indexOf('function erplainBlIdentityHtml('),end=app.indexOf('function erplainDisplayLines(',start);
 const context={esc:s=>String(s??'').replaceAll('<','&lt;'),erpStatusText:s=>s};vm.createContext(context);vm.runInContext(app.slice(start,end),context);
 const f=fixture();let html=context.erplainBlIdentityHtml(f.o);assert.match(html,/numéro non confirmé/);assert.doesNotMatch(html,/SHO00744466/);
 const s=applyBlIdentityObservation(f.o.erp_live,f.bc,null);s.bl.label='<old>';s.blIdentity.previousBl.label='<old>';html=context.erplainBlIdentityHtml({erp_live:s,erplain_tracking_bls:[]});assert.match(html,/Ancienne référence/);assert.match(html,/&lt;old>/);assert.doesNotMatch(html,/<old>/);
});
