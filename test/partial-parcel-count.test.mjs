import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {initializePartialParcelCount,increasePartialParcels} from '../src/partial-parcel-count.mjs';
import {currentProblemClassifier} from '../src/problem-typology-reader.mjs';

async function fixture(){
 const db=new PGlite();await db.waitReady;
 await db.exec(`CREATE TABLE orders(id text PRIMARY KEY,channel text,erp_live jsonb,tracking_status text,address jsonb);CREATE TABLE partial_deliveries(id text PRIMARY KEY,order_id text,status text,environment text,carrier text,tracking jsonb,parcel_count int,weight_kg numeric,bl jsonb,selection jsonb,stock_document jsonb,updated_at timestamptz);CREATE TABLE partial_documents(delivery_id text,document_index int,pdf bytea,PRIMARY KEY(delivery_id,document_index));CREATE TABLE resolution_jobs(order_id text,status text);CREATE TABLE audit(user_email text,action text,detail jsonb);`);
 await initializePartialParcelCount(db);
 await db.query("INSERT INTO orders VALUES('o','shopify',$1,'not_shipped','{}')",[{bc:{id:1}}]);
 await db.query("INSERT INTO partial_deliveries VALUES('d','o','ready','production','gls',$1,1,27.9,$2,$3,$4,now())",[['OLD'],{id:2,label:'SHO1'},[{sku:'PARTIAL',variantId:'3',quantity:150}],{notRequired:true,bcId:1}]);
 await db.query("INSERT INTO partial_documents VALUES('d',0,$1)",[Buffer.from('%PDF-old')]);
 const live={id:2,status:'ready_to_ship',update_stock:true,line_items:[{variant:{id:3},quantity:150}],shipping_address:{label:'Recipient',address_1:'Street',city:'City',postal_code:'75001',country:'FR'},orders:{data:[{id:1,update_stock:true}]}};
 const api={verify:async()=>{},request:async()=>({ShippingOrder:live})};
 const calls=[];const client={gls:async o=>{calls.push(o);return {tracking:['NEW'],documents:[Buffer.from('%PDF-new').toString('base64')]};}};
 const b={id:'d',requestId:randomUUID(),expectedTotal:1,total:2};
 const run=(body=b)=>increasePartialParcels(db,api,client,{maxParcelKg:30},body,{email:'operator'});
 return {db,api,live,client,calls,b,run};
}
test('adds only the partial BL label, preserves its original PDF and replays without purchase',async()=>{
 const f=await fixture();try{
  assert.deepEqual(await f.run(),{total:2});assert.equal(f.calls.length,1);
  assert.deepEqual(f.calls[0].lines,[{target_sku:'PARTIAL',target_quantity:150}]);
  assert.equal(f.calls[0].label_bl,'SHO1');assert.equal(f.calls[0].parcel_index,2);
  const docs=(await f.db.query('SELECT pdf FROM partial_documents ORDER BY document_index')).rows;
  assert.equal(Buffer.from(docs[0].pdf).toString(),'%PDF-old');assert.equal(docs.length,2);
  assert.deepEqual(await f.run(),{total:2,replayed:true});assert.equal(f.calls.length,1);
  await assert.rejects(f.run({...f.b,requestId:randomUUID()}),/nombre de colis a changé/);
 }finally{await f.db.close();}
});
test('uncertain creation blocks all further purchases and preserves existing labels',async()=>{
 const f=await fixture();try{
  f.client.gls=async()=>{f.calls.push(1);throw Error('timeout');};
  await assert.rejects(f.run(),/timeout/);
  await assert.rejects(f.run(),/rapprocher/);
  await assert.rejects(f.run({...f.b,requestId:randomUUID()}),/rapprocher/);
  assert.equal(f.calls.length,1);assert.equal((await f.db.query('SELECT count(*)::int n FROM partial_documents')).rows[0].n,1);
 }finally{await f.db.close();}
});
for(const mode of ['changed BL','shipped','reduction','wrong BC','stock unconfirmed'])test('rejects '+mode+' before purchase',async()=>{
 const f=await fixture();try{
  if(mode==='changed BL')f.live.line_items[0].quantity=200;
  if(mode==='shipped')f.live.status='shipped';
  if(mode==='reduction')f.b.total=0;
  if(mode==='wrong BC')f.live.orders.data[0].id=99;
  if(mode==='stock unconfirmed')f.live.orders.data[0].update_stock=false;
  await assert.rejects(f.run());assert.equal(f.calls.length,0);
 }finally{await f.db.close();}
});
test('stock shortage is displayed before older timeout diagnostics',()=>{
 const problems=currentProblemClassifier()({id:'o',resolution_error:'API Erplain timeout',issue:'BL bloqué — stock insuffisant : 981109 : 1 nécessaires, 0 utilisables, manque 1',erp_live_job:{status:'review',error:'BL bloqué — stock insuffisant : 981109 : 1 nécessaires, 0 utilisables, manque 1'}});
 assert.equal(problems[0].type,'stock');assert.ok(problems.some(p=>p.type==='api-timeout'));
});
