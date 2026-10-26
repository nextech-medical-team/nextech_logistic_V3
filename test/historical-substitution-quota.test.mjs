import test from 'node:test';
import assert from 'node:assert/strict';
import {recordedSubstitutionPlan,findRecordedSubstitution} from '../src/substitution-recovery.mjs';
import {PGlite} from '@electric-sql/pglite';
import {resolutionIncident} from '../src/resolution-incident.mjs';

function fixture(){
 const bc={id:'1',status:'active',update_stock:true,total:12,tax_type:'exclusive',currency:{label:'EUR'},shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}},line_items:[{id:'10',type:'normal',quantity:1,price:10,tax_amount:2,tax_codes:[{id:'tax'}],variant:{id:'2',sku:'OLD',track_inventory:true},location:{id:'3'}}]};
 const request={scope:'order',sku:'OLD',replacementSku:'NEW',replaceQuantity:1,replacementQuantity:1,confirmEquivalent:true,previewFingerprint:'proof'};
 const failed={status:'review',error:'Remplacement historique à rapprocher : Erplain HTTP 429',payload:request};
 const preview={status:'complete',payload:request,result:{previewFingerprint:'proof',bcId:'1',commercialBefore:structuredClone(bc),historicalStockProof:{stockOnBc:true,bcId:'1'},items:[],expected:[{sku:'NEW',quantity:1}]}};
 const stock={evidence:[{variant:'2',bc:'1',complete:true,order:[{id:'log',document_id:'1',order_type:'Order',variant:{id:'2'},location:{id:'3'},on_hand_diff:-1,available_diff:-1}]}]};
 return {bc,request,failed,preview,stock};
}
test('429 permits a fresh preview only after unchanged BC and stock have been proved',()=>{
 const f=fixture();assert.equal(recordedSubstitutionPlan(f.bc,f.request,f.failed,f.preview,{},f.stock),null);
 for(const change of [f=>f.bc.line_items[0].price=11,f=>f.bc.line_items[0].quantity=2,f=>f.bc.shipping_orders.data.push({id:'bl'}),f=>f.stock.evidence=[]]){
  const f=fixture();change(f);assert.throws(()=>recordedSubstitutionPlan(f.bc,f.request,f.failed,f.preview,{},f.stock));
 }
});
test('uncertain failures and missing previews remain blocked',()=>{
 for(const error of ['timeout','Erplain HTTP 429 · réponse partielle à rapprocher']){
  const f=fixture();f.failed.error='Remplacement historique à rapprocher : '+error;
  assert.throws(()=>recordedSubstitutionPlan(f.bc,f.request,f.failed,f.preview,{},f.stock));
 }
});
test('replacement already applied is reconciled without another mutation',()=>{
 const f=fixture();f.failed.id='failed';
 f.preview.result.items=[{variant:{id:'4'},location:{id:'3'},quantity:1,price:10,tax_codes:[{id:'tax'}]}];
 f.bc.line_items[0]={...f.bc.line_items[0],id:'20',variant:{id:'4',sku:'NEW',track_inventory:true}};
 const movement=structuredClone(f.stock.evidence[0].order[0]);movement.variant.id='4';
 f.stock.evidence[0].order=[];f.stock.evidence.push({variant:'4',bc:'1',complete:true,order:[movement]});
 const plan=recordedSubstitutionPlan(f.bc,f.request,f.failed,f.preview,{},f.stock);
 assert.equal(plan.reconcileOnly,true);assert.equal(plan.recoveredFrom,'failed');
});
test('persisted incident wrapper retains historical recovery and rejects a different replacement',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec('CREATE TABLE resolution_jobs(id text,order_id text,request_id text,action text,status text,error text,payload jsonb,result jsonb,created_at timestamptz)');
 const f=fixture();f.bc.created_at='2026-10-20T00:00:00Z';
 const incident=resolutionIncident(Error(f.failed.error),{action:'replace-equivalent',replacementSuspended:true,payload:f.request});
 await db.query("INSERT INTO resolution_jobs VALUES('preview','o','preview','equivalent-preview','complete',null,$1,$2,'2026-10-20'),('failed','o','failed','replace-equivalent','review',$3,$1,$4,'2026-10-21')",[JSON.stringify(f.request),JSON.stringify(f.preview.result),incident.error,JSON.stringify(incident)]);
 let reads=0;const api={request:async q=>{assert.match(q,/^query V3HistoricalStockLogs/);reads++;return {InventoryLogs:{data:f.stock.evidence[0].order,paginatorInfo:{hasMorePages:false}}};}};
 assert.equal(await findRecordedSubstitution(db,{id:'o'},f.request,f.bc,api),null);assert.equal(reads,1);
 await assert.rejects(findRecordedSubstitution(db,{id:'o'},{...f.request,replacementSku:'OTHER'},f.bc,api),/Rapprocher d’abord/);
 await db.query("UPDATE resolution_jobs SET result='{}'::jsonb WHERE id='preview'");
 await assert.rejects(findRecordedSubstitution(db,{id:'o'},f.request,f.bc,api),/Aperçu/);
});
