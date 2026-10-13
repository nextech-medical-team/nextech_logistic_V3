import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {recordedBcItems,recordedBcPricing,readRecordedBc,verifyRecordedOrSourceTotals,withRecordedOrSourceGuard} from '../src/existing-bc-execution.mjs';
import {retiredCommercialControl,postBcRecoveryEligible,retirePostBcCommercialControls} from '../src/post-bc-control-recovery.mjs';
import {shipmentFingerprint} from '../src/label-stock-gate.mjs';
import {currentResolutionState} from '../src/historical-preparation-completion.mjs';

const bc={id:'1925605',label:'C00014132',status:'active',line_items:[{quantity:1,variant:{id:'44',sku:'33 421 13B'},location:{id:'100934'}}]};
const order={id:'o',reference:'PO-079-02712783012470183',channel:'temu',archived:false,erp_live:{bc:{id:bc.id},phase:'bc_created',pricing:{status:'blocked',total:999,tax_type:'exclusive'}},source_payload:{temuAmounts:{invalid:true}},error:'BC · Base fiscale des prix Erplain différente ou absente'};
for(const channel of ['temu','amazon','shopify','tender','erplain'])test(`${channel}: existing BC is read without price, tax, total, currency or V3 quantity comparisons`,async()=>{
 const o={...order,channel},calls=[],api={request:async(q)=>{calls.push(q);assert.match(q,/^query /);return {Order:bc};}};
 const result=await readRecordedBc(api,o);assert.equal(result.items[0].quantity,1);assert.equal(result.pricing.total,null);assert.equal(result.pricing.tax,null);assert.equal(result.pricing.status,'observed');
 assert.equal((await verifyRecordedOrSourceTotals(api,o,bc,()=>assert.fail('commercial source read'))).comparisonPerformed,false);
 assert.equal(await withRecordedOrSourceGuard(api,o,()=>assert.fail('source guard'),async()=>42),42);assert.equal(calls.length,1);
});
test('missing commercial fields and HT/TTC differences remain observations',()=>{
 for(const payload of [{},{total:-3,tax_type:'inclusive',currency:{label:'EUR'},line_items:[{tax_amount:100}]},{total:'invalid',tax_type:'other'}]){
  assert.doesNotThrow(()=>recordedBcPricing(order,{...bc,...payload}));
 }
});
test('wrong document/cancellation and unusable execution data stay blocked',()=>{
 assert.throws(()=>recordedBcPricing(order,{...bc,id:'2'}),/Identité/);
 assert.throws(()=>recordedBcPricing(order,{...bc,status:'cancelled'}),/état/);
 assert.throws(()=>recordedBcItems({...bc,line_items:[{...bc.line_items[0],quantity:null}]}),/non exploitable/);
});
test('changes to source quantities do not invalidate the transport fingerprint',async()=>{
 const db={query:()=>assert.fail('V3 lines must not be reread')};
 assert.equal(await shipmentFingerprint(db,order),await shipmentFingerprint(db,{...order,lines:[{quantity:999}]}));
 assert.notEqual(await shipmentFingerprint(db,order),await shipmentFingerprint(db,{...order,address:{city:'changed'}}));
});
test('retire only commercial controls; preserve stock, uncertain writes, transport and suspensions',()=>{
 assert.equal(retiredCommercialControl(order.error),true);
 for(const error of ['Écart BC/BL : références ou quantités à contrôler','Stock Erplain : mouvement existant incompatible','TEMU · Étiquette refusée','BC · Publication ou numéro non confirmé','Reprise Erplain · BC · Base fiscale des prix Erplain différente ou absente'])assert.equal(retiredCommercialControl(error),false,error);
 for(const variant of [{archived:true},{suspension:{active:true}},{resolution_pending_resume:true},{partial_mode:true},{erp_live:{...order.erp_live,phase:'creating_stock'}},{tracking_status:'cancelled'}])assert.equal(postBcRecoveryEligible({...order,...variant}),false);
});
test('PO-079 recovery changes only local commercial checkpoint; keeps BC, stock, documents and TEMU refusal',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,reference text,channel text,archived boolean DEFAULT false,partial_mode boolean DEFAULT false,source_payload jsonb DEFAULT '{}',suspension jsonb DEFAULT '{}',erp_live jsonb,resolution_pending_resume boolean DEFAULT false,tracking_status text,label_status text,issue text);
   CREATE TABLE erp_live_jobs(order_id text,status text,error text,updated_at timestamptz DEFAULT now());
   CREATE TABLE resolution_jobs(order_id text,status text,action text,error text,result jsonb,updated_at timestamptz);CREATE TABLE correction_jobs(order_id text,status text);
   CREATE TABLE audit(user_email text,action text,detail jsonb);CREATE TABLE temu_label_jobs(reference text,error text);CREATE TABLE carrier_documents(order_id text,pdf bytea);`);
  await db.query('INSERT INTO orders(id,reference,channel,erp_live,source_payload) VALUES($1,$2,$3,$4,$5)',[order.id,order.reference,order.channel,JSON.stringify(order.erp_live),JSON.stringify(order.source_payload)]);
  await db.query("INSERT INTO erp_live_jobs(order_id,status,error) VALUES($1,'review',$2)",[order.id,order.error]);
  await db.query("INSERT INTO resolution_jobs(order_id,status,action,error,result) VALUES($1,'review','resume-erp',$2,'{}')",[order.id,order.error]);
  await db.query("INSERT INTO resolution_jobs(order_id,status,action,error,result) VALUES($1,'review','address','Adresse à vérifier','{}')",[order.id]);
  await db.query('INSERT INTO temu_label_jobs VALUES($1,$2)',[order.reference,'TEMU · Étiquette refusée']);
  await db.query('INSERT INTO carrier_documents VALUES($1,$2)',[order.id,new Uint8Array([1,2,3])]);
  const queries=[],api={request:async(q)=>{queries.push(q);assert.match(q,/^query /);return {Order:bc};}};
  const wrapper={query:(...args)=>db.query(...args),transaction:async(fn)=>db.transaction(fn)};
  const result=await retirePostBcCommercialControls(wrapper,api,{orderId:order.id});assert.equal(result[0].updated,true);
  const job=(await db.query('SELECT * FROM erp_live_jobs')).rows[0];assert.equal(job.status,'pending');assert.equal(job.error,null);
  assert.equal((await db.query('SELECT error FROM temu_label_jobs')).rows[0].error,'TEMU · Étiquette refusée');
  assert.equal((await db.query('SELECT octet_length(pdf) bytes FROM carrier_documents')).rows[0].bytes,3);
  const after=(await db.query('SELECT * FROM orders')).rows[0];assert.equal(after.erp_live.bc.id,bc.id);assert.equal(after.erp_live.pricing.status,'observed');assert.equal(after.erp_live.stockDocument,undefined);
  const actions=(await db.query('SELECT * FROM resolution_jobs')).rows;assert.equal(actions.find(a=>a.action==='resume-erp').status,'review');assert.deepEqual(currentResolutionState(actions).reviews.map(a=>a.action),['address']);
  assert.deepEqual(await retirePostBcCommercialControls(wrapper,api,{orderId:order.id}),[]);assert.equal(queries.length,1);
 }finally{await db.close();}
});
