import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {preparePublicationResume,commitPublicationResume} from '../src/publication-resume.mjs';
import {validateResolution} from '../src/problem-resolution.mjs';

function fixture(status='pending',stock=true){
 const o={id:'o',erp_live:{phase:'publishing_bl',bc:{id:7},bl:{id:9,label:'SHO00744687',status:'unpublished',update_stock:stock},transientRecovery:{attempts:3,lastError:'Erplain HTTP 503'}}};
 const bc={id:7,status:'active',update_stock:stock,shipping_orders:{data:[{id:9,label:'SHO00744687',status,update_stock:stock}],paginatorInfo:{hasMorePages:false}}};
 const writes=[];
 const db={query:async(q,p)=>{if(q.startsWith('SELECT * FROM orders'))return {rows:[structuredClone(o)]};if(!q.startsWith('SELECT'))writes.push({q,p});return {rows:[]};}};
 const api={request:async q=>{assert.match(q,/^query /);return q.includes('V3MissingDraftRead')?{ShippingOrder:{id:9},Order:bc}:{Order:bc};}};
 return {o,bc,db,api,writes};
}

for(const status of ['unpublished','pending','in_preparation','make_the_shipment','ready_to_ship'])test('explicit recovery after three failures reconciles '+status+' without provider mutation',async()=>{
 const f=fixture(status),before=structuredClone(f.o);
 const next=await preparePublicationResume(f.db,f.api,f.o);
 assert.equal(next.phase,'bl_created');assert.equal(next.bl.id,9);assert.equal(next.bl.status,status);
 assert.deepEqual(f.o,before);assert.equal(f.writes.length,0);
 await commitPublicationResume(f.db,f.o,next,{resolutionId:'r'});
 assert.equal(f.writes.length,2);assert.match(f.writes[1].q,/audit/);
});

test('published separate-stock BL resumes the existing guarded stock reconciliation',async()=>{
 const f=fixture('pending',false);
 assert.equal((await preparePublicationResume(f.db,f.api,f.o)).phase,'creating_stock');
});

test('absent draft uses the existing no-stock-effect recovery and audit',async()=>{
 const f=fixture('unpublished',false);f.bc.shipping_orders.data=[];
 f.api.request=async q=>{
  assert.match(q,/^query /);
  if(q.includes('V3MissingDraftStock'))return {StockRemovals:{data:[],paginatorInfo:{hasMorePages:false}}};
  if(q.includes('V3MissingDraftLabel'))return {ShippingOrders:{data:[],paginatorInfo:{hasMorePages:false}}};
  return {Order:f.bc,ShippingOrder:null};
 };
 const next=await preparePublicationResume(f.db,f.api,f.o);
 assert.equal(next.phase,'bc_created');assert.equal(next.bl,undefined);
 assert.equal(next.missingDraftRecoveries[0].retiredDraft.id,9);
 await commitPublicationResume(f.db,f.o,next,{resolutionId:'r'});
 assert.match(f.writes[1].q,/erplain.missing_draft_retired/);
});

for(const [name,change] of [
 ['different BC',f=>f.bc.id=8],['inactive BC',f=>f.bc.status='cancelled'],
 ['incomplete list',f=>f.bc.shipping_orders.paginatorInfo.hasMorePages=true],
 ['missing BL',f=>f.bc.shipping_orders.data=[]],
 ['multiple BLs',f=>f.bc.shipping_orders.data.push({...f.bc.shipping_orders.data[0],id:10})],
 ['different BL',f=>f.bc.shipping_orders.data[0].id=10],
 ['terminal BL',f=>f.bc.shipping_orders.data[0].status='shipped'],
 ['unknown stock policy',f=>delete f.bc.update_stock]
])test(name+' refuses recovery without writes',async()=>{
 const f=fixture();change(f);await assert.rejects(()=>preparePublicationResume(f.db,f.api,f.o));assert.equal(f.writes.length,0);
});

test('suspension, shipment, document edits and concurrent work prevent stale commit',async()=>{
 for(const change of [o=>o.suspension={active:true},o=>o.tracking_status='shipped',o=>o.erp_live.phase='changed']){
  const f=fixture(),next=await preparePublicationResume(f.db,f.api,f.o);change(f.o);
  await assert.rejects(()=>commitPublicationResume(f.db,{...f.o,erp_live:{...f.o.erp_live,phase:'publishing_bl'}},next));
  assert.equal(f.writes.length,0);
 }
 const f=fixture(),next=await preparePublicationResume(f.db,f.api,f.o),query=f.db.query;
 f.db.query=(q,p)=>q.includes('carrier_documents')?Promise.resolve({rows:[{}]}):query(q,p);
 await assert.rejects(()=>commitPublicationResume(f.db,f.o,next),/document transport/);assert.equal(f.writes.length,0);
});

test('publication and exhausted-retry messages expose a validated ERP recovery action',()=>{
 const context=vm.createContext({});vm.runInContext(readFileSync(new URL('../public/compact-problems.js',import.meta.url),'utf8'),context);
 for(const error of ['BL Erplain · Publication à vérifier : contrôler le BL','Incident temporaire Erplain persistant après 3 reprises : contrôle nécessaire']){
  const problem=context.compactProblem(error);assert.equal(problem.type,'erplain-recovery');assert.equal(problem.detail,error);
  assert.doesNotThrow(()=>validateResolution({id:'o',requestId:'12345678-1234-1234-1234-123456789abc',action:'resume-erp',type:problem.type}));
 }
});
