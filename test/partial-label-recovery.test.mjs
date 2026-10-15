import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';
import {partialLabelWeight,retryPartialLabel,partialPhonePreflight} from '../src/partial-label-recovery.mjs';
const delivery=()=>({id:'d',order_id:'o',status:'review',stage:'creating_label',environment:'production',bl:{id:'bl',status:'ready_to_ship'},selection:[{sku:'MISSING',quantity:10}],error:partialPhonePreflight,tracking:[],carrier_result:null});
test('missing SKU weight after an existing BL reuses saved delivery/order data without inventing a product weight',()=>{
 const d=delivery(),before=JSON.stringify(d);assert.deepEqual(partialLabelWeight(d,{weight_kg:4.7},[]),{weight:4.7,source:'saved_order_estimate'});d.weight_kg=2.5;assert.deepEqual(partialLabelWeight(d,{weight_kg:4.7},[]),{weight:2.5,source:'saved_delivery'});delete d.weight_kg;assert.equal(JSON.stringify(d),before);
 assert.throws(()=>partialLabelWeight({...d,bl:null},{weight_kg:4.7},[]),/Poids absent/);assert.throws(()=>partialLabelWeight(d,{weight_kg:null},[]),/Poids absent/);
 assert.deepEqual(partialLabelWeight(d,{weight_kg:4.7},[{sku:'MISSING',weight_kg:.1}]),{weight:1,source:'selected_products'});
});
async function fixture(d=delivery(),o={id:'o',archived:false,erp_live:{bc:{id:'bc',status:'active'}},tracking_status:'not_shipped',suspension:{}}){
 const e=new PGlite();await e.exec(`CREATE TABLE orders(id text PRIMARY KEY,archived boolean,erp_live jsonb,tracking_status text,suspension jsonb);CREATE TABLE partial_deliveries(id text PRIMARY KEY,order_id text,status text,stage text,environment text,bl jsonb,selection jsonb,error text,tracking jsonb,carrier_result jsonb);CREATE TABLE partial_documents(delivery_id text,pdf bytea);`);
 await e.query('INSERT INTO orders VALUES($1,$2,$3,$4,$5)',[o.id,o.archived,JSON.stringify(o.erp_live),o.tracking_status,JSON.stringify(o.suspension)]);
 await e.query('INSERT INTO partial_deliveries VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[d.id,d.order_id,d.status,d.stage,d.environment,JSON.stringify(d.bl),JSON.stringify(d.selection),d.error,JSON.stringify(d.tracking),d.carrier_result===null?null:JSON.stringify(d.carrier_result)]);
 const wrap=p=>({query:(s,a)=>p.query(s,a)});return {e,db:{transaction:f=>e.transaction(p=>f(wrap(p)))}};
}
test('a manual retry of the exact local phone refusal is label-only and idempotent; BL and original selection remain intact',async()=>{
 const d=delivery(),{e,db}=await fixture(d);try{const result=await retryPartialLabel(db,'d');assert.equal(result.labelOnly,true);assert.equal(result.originalError,partialPhonePreflight);assert.equal(result.blId,'bl');const second=await retryPartialLabel(db,'d');assert.equal(second.existing,true);const current=(await e.query("SELECT * FROM partial_deliveries WHERE id='d'")).rows[0];assert.equal(current.status,'bl_ready');assert.deepEqual(current.bl,d.bl);assert.deepEqual(current.selection,d.selection);assert.deepEqual(current.tracking,[]);assert.equal(current.carrier_result,null);}finally{await e.close();}
});
test('a true provider error, tracked result, existing PDF, TEST scope or cancelled BL never becomes a new shipment',async()=>{
 for(const edit of [d=>d.error='GLS HTTP 400',d=>d.tracking=['existing'],d=>d.environment='test',d=>d.bl.status='cancelled']){const d=delivery();edit(d);const {e,db}=await fixture(d);try{await assert.rejects(()=>retryPartialLabel(db,'d'),/Création incertaine/);assert.equal((await e.query("SELECT status FROM partial_deliveries WHERE id='d'")).rows[0].status,'review');}finally{await e.close();}}
 const {e,db}=await fixture();try{await e.query('INSERT INTO partial_documents VALUES($1,$2)',['d',Buffer.from('%PDF-1.4 existing')]);await assert.rejects(()=>retryPartialLabel(db,'d'),/Création incertaine/);assert.equal((await e.query('SELECT count(*)::int n FROM partial_documents')).rows[0].n,1);}finally{await e.close();}
});
test('suspension or cancellation prevents creation while a persisted provider result queues PDF recovery only',async()=>{
 const {e,db}=await fixture(delivery(),{id:'o',archived:false,erp_live:{bc:{id:'bc',status:'active'}},tracking_status:'not_shipped',suspension:{active:true}});try{await assert.rejects(()=>retryPartialLabel(db,'d'),/suspendue/);}finally{await e.close();}
 const d=delivery();d.carrier_result={reference:'R',tracking:['T']};d.error='PDF unavailable';const f=await fixture(d);try{const r=await retryPartialLabel(f.db,'d');assert.equal(r.recoveryOnly,true);const saved=(await f.e.query("SELECT * FROM partial_deliveries WHERE id='d'")).rows[0];assert.equal(saved.status,'awaiting_pdf');assert.deepEqual(saved.carrier_result,d.carrier_result);}finally{await f.e.close();}
});
