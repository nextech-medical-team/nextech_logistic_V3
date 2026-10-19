import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedResumeBc} from '../src/resume-bc-read.mjs';
import {readInheritedBlLedger} from '../src/historical-stock-proof.mjs';
import {currentProblemClassifier} from '../src/problem-typology-reader.mjs';

test('absent BC, incomplete response, wrong identity and empty lines remain distinct and blocked',()=>{
 const saved={id:'1',label:'C0016034'};
 assert.throws(()=>checkedResumeBc({Order:null},saved),/C0016034 introuvable/);
 assert.throws(()=>checkedResumeBc({},saved),/Identité/);
 assert.throws(()=>checkedResumeBc({Order:{id:'2',line_items:[{}]}},saved),/Identité/);
 assert.throws(()=>checkedResumeBc({Order:{id:'1'}},saved),/Lignes BC non reçues/);
 assert.throws(()=>checkedResumeBc({Order:{id:'1',line_items:[]}},saved),/sans lignes/);
 const bc={id:'1',line_items:[{type:'normal'}]};assert.equal(checkedResumeBc({Order:bc},saved),bc);
});
const bl=()=>({id:'2',status:'ready_to_ship',update_stock:true,line_items:[{type:'normal',quantity:2,variant:{id:'10'},location:{id:'20'}}]});
test('legacy BL missing date is freshly read before its ledger, without provider writes',async()=>{
 const saved=bl(),calls=[];
 const result=await readInheritedBlLedger({request:async(q,v)=>{
  assert.match(q,/^query /);calls.push(q);
  if(q.includes('V3InheritedBlDate')){assert.equal(v.id,'2');return {ShippingOrder:{...bl(),created_at:'2026-10-17 12:00:00'}};}
  assert.equal(v.where.AND[1].value,'2026-10-17 00:00:00');return {InventoryLogs:{data:[],paginatorInfo:{hasMorePages:false}}};
 }},saved);
 assert.equal(calls.length,2);assert.equal(result[0].complete,true);assert.deepEqual(saved,bl());
});
for(const mode of ['missing','identity','status','policy','quantity','location','date'])test('fresh BL mismatch stays blocked: '+mode,async()=>{
 let calls=0;const fresh={...bl(),created_at:'2026-10-17 12:00:00'};
 if(mode==='identity')fresh.id='3';if(mode==='status')fresh.status='cancelled';if(mode==='policy')fresh.update_stock=false;if(mode==='quantity')fresh.line_items[0].quantity=3;if(mode==='location')fresh.line_items[0].location.id='21';if(mode==='date')delete fresh.created_at;
 await assert.rejects(()=>readInheritedBlLedger({request:async q=>{calls++;assert.match(q,/V3InheritedBlDate/);return {ShippingOrder:mode==='missing'?null:fresh};}},bl()),/historique/);assert.equal(calls,1);
});
test('duplicate customer notices form one problem and preserve both details',()=>{
 const current='Client Erplain introuvable après recherche : création précédente incertaine, aucune nouvelle création automatique';
 const previous='Client Erplain · Création à vérifier : rapprocher le client de cette commande avant reprise';
 const problems=currentProblemClassifier()({id:'o',channel:'temu',resolution_error:current,issue:previous,erp_live_job:{error:previous},sku_lines:[]});
 const customers=problems.filter(x=>x.type==='customer');assert.equal(customers.length,1);assert.ok(customers[0].detail.includes(current));assert.ok(customers[0].detail.includes(previous));
});

test('document refresh excludes only its own running refresh and retains concurrent operation guards',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');
 const {assertDocumentIdle}=await import('../src/erplain-document-read.mjs');
 const db=new PGlite();try{
  await db.exec(`CREATE TABLE erp_live_jobs(order_id text,status text);CREATE TABLE partial_deliveries(order_id text,status text,temu_label jsonb);CREATE TABLE resolution_jobs(id text,order_id text,action text,status text);CREATE TABLE carrier_jobs(order_id text,status text);INSERT INTO resolution_jobs VALUES('self','o','refresh','running');`);
  await assert.rejects(()=>assertDocumentIdle(db,'o'),/en cours/);
  await assertDocumentIdle(db,'o',{resolutionId:'self'});
  for(const action of ['resume','replace-equivalent',null]){
   await db.query("UPDATE resolution_jobs SET action=$1 WHERE id='self'",[action]);
   await assert.rejects(()=>assertDocumentIdle(db,'o',{resolutionId:'self'}),/en cours/);
  }
  await db.exec("UPDATE resolution_jobs SET action='refresh';INSERT INTO resolution_jobs VALUES('other','o','refresh','queued')");
  await assert.rejects(()=>assertDocumentIdle(db,'o',{resolutionId:'self'}),/en cours/);
  await db.exec("DELETE FROM resolution_jobs WHERE id='other';INSERT INTO erp_live_jobs VALUES('o','processing')");
  await assert.rejects(()=>assertDocumentIdle(db,'o',{resolutionId:'self'}),/en cours/);
 }finally{await db.close();}
});
