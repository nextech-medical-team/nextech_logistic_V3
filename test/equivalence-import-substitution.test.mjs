import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {substitution} from '../src/stock-substitution.mjs';
import {preservedImportAmounts,verifyImportBcAmounts} from '../src/import-bc-commercial.mjs';
import {initializeEquivalences} from '../src/equivalence-catalog.mjs';
import {attachSkuSubstitutions} from '../src/sku-substitution-view.mjs';
import {currentMappingLine} from '../src/current-mapping-line.mjs';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

for(const scenario of ['batch','stock-review','bc-amounts'])test('moteur réel : '+scenario,async()=>{
 const stockReview=scenario==='stock-review',preserveBcAmounts=scenario==='bc-amounts';
 const pg=new PGlite();await pg.waitReady;
 try{
 await pg.exec(`
 CREATE TABLE orders(id text primary key,reference text,channel text,address jsonb,erp_live jsonb,source_payload jsonb,carrier text,transport_choice text,parcel_count int,partial_mode boolean,archived boolean,tracking_status text,weight_kg numeric,resolution_pending_resume boolean,label_status text,issue text);
 CREATE TABLE lines(id text primary key,order_id text,source_line text,source_sku text,quantity numeric,target_sku text,target_quantity numeric,source_payload jsonb);
 CREATE TABLE mappings(channel text,source_sku text,target_sku text,source_qty numeric,target_qty numeric,notes text,updated_at timestamptz);
 CREATE TABLE resolution_jobs(id text primary key,order_id text,request_id text,action text,payload jsonb,status text,stage text,error text,result jsonb,created_at timestamptz default now(),updated_at timestamptz default now());
 CREATE TABLE erp_live_jobs(order_id text primary key,status text,error text,updated_at timestamptz);
 CREATE TABLE carrier_jobs(order_id text,carrier text,status text,result jsonb,tracking jsonb,reference text);
 CREATE TABLE carrier_documents(order_id text,document_index int,pdf bytea);
 CREATE TABLE temu_label_jobs(reference text,status text,packages jsonb,attempt_id text,result jsonb);
 CREATE TABLE temu_label_documents(reference text,package text,pdf bytea);
 CREATE TABLE extra_parcels(id text,order_id text,status text,pdf bytea,carrier text,tracking text,created_at timestamptz);
 CREATE TABLE partial_deliveries(id text,order_id text,status text,selection jsonb,bl jsonb,error text,carrier text,tracking jsonb);
 CREATE TABLE partial_documents(delivery_id text,document_index int,pdf bytea);
 CREATE TABLE jobs(order_id text,kind text,status text,error text);
 CREATE TABLE products(sku text primary key,weight_kg numeric,origin text,updated_at timestamptz);
 CREATE TABLE audit(id bigserial,user_email text,action text,detail jsonb,created_at timestamptz default now());
 `);
 const wrap=e=>({query:(s,p=[])=>e.query(s,p),exec:s=>e.exec(s)}),db={...wrap(pg),transaction:f=>pg.transaction(tx=>f(wrap(tx)))};
 await initializeEquivalences(db);
 const variant=(sku,id)=>({id:String(id),sku,active:true,track_inventory:true,weight_amount:.01,weight_unit:'kg',tax_codes:[],product:{id:String(id),label:sku,active:true},stock_levels:{data:[{location:{id:'1'},available:100,on_hand:100}],paginatorInfo:{hasMorePages:false}}});
 const variants={A:variant('A',1),B:variant('B',2),C:variant('C',3),D:variant('D',4)};
 const line=(id,sku,qty,price=1)=>({id:String(id),type:'normal',variant:variants[sku],location:{id:'1'},quantity:qty,price,tax_amount:0,tax_codes:[],discount:0,discount_rule_amount:0,ecotax:0});
 let bc={id:'11',label:'BC-TEST',status:'active',tax_type:'exclusive',currency:{label:'EUR'},update_stock:false,total:30,line_items:[line(1,'A',20),line(2,'C',10)],shipping_orders:{data:[],paginatorInfo:{hasMorePages:false}}},writes=0;
 const api={verify:async()=>{},request:async(q,v)=>{
  if(q.includes('V3SubstitutionBC'))return {Order:structuredClone(bc)};
  if(q.includes('V3SubstitutionProduct'))return {Variants:{data:[variants[v.where.value]],paginatorInfo:{hasMorePages:false}}};
  if(q.includes('mutation V3SubstituteOrder')){writes++;bc={...bc,line_items:v.input.line_items.map((i,n)=>{if(i.id)return {...bc.line_items.find(l=>l.id===i.id),quantity:i.quantity};const found=Object.values(variants).find(x=>x.id===i.variant.id);return line(100+writes+n,found.sku,i.quantity,i.price);})};return {UpdateOrder:structuredClone(bc)};}
  throw Error('Appel inattendu '+q);
 }};
 await db.query("INSERT INTO orders VALUES('o','#EXEMPLE','shopify','{}',$1,'{}','gofo',null,1,false,false,'not_shipped',.3,false,'pending',null)",[JSON.stringify({bc:{id:'11',status:'active'},pricing:{total:30,tax:0,currency:'EUR'}})]);
 await db.query("INSERT INTO erp_live_jobs VALUES('o','review','Stock insuffisant',now())");
 for(const l of bc.line_items)await db.query("INSERT INTO lines VALUES($1,'o',$1,$2,$3,$2,$3,'{}')",[l.id,l.variant.sku,l.quantity]);
 async function replace(sku,replacementSku,quantity,deferResume,replacementQuantity=quantity){
  const o=(await db.query("SELECT * FROM orders WHERE id='o'")).rows[0],b={id:'o',requestId:randomUUID(),sku,replacementSku,replaceQuantity:quantity,replacementQuantity,scope:'order'};
  const preview=await substitution(db,api,o,b,{preserveBcAmounts});
  Object.assign(b,{confirmEquivalent:true,previewFingerprint:preview.previewFingerprint});
  await db.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,payload,status) VALUES($1,'o',$2,'replace-equivalent',$3,'running')",[b.requestId,b.requestId,JSON.stringify(b)]);
  return substitution(db,api,o,b,{apply:true,deferResume,preserveBcAmounts});
 }
 if(preserveBcAmounts){
  await db.query("UPDATE orders SET erp_live=jsonb_set(erp_live,'{pricing,total}','35') WHERE id='o'");
  const o=(await db.query("SELECT * FROM orders WHERE id='o'")).rows[0];
  await assert.doesNotReject(substitution(db,api,o,{id:'o',sku:'A',replacementSku:'B',replaceQuantity:20,replacementQuantity:20,scope:'order'}));
  assert.equal(writes,0);
 }
 const first=await replace('A','B',20,!stockReview);assert.equal(first.importDeferred,!stockReview);assert.equal(writes,1);
 assert.equal((await db.query("SELECT status FROM erp_live_jobs WHERE order_id='o'")).rows[0].status,stockReview?'pending':'review');
 assert.equal((await db.query("SELECT resolution_pending_resume FROM orders WHERE id='o'")).rows[0].resolution_pending_resume,!stockReview);
 assert.equal((await db.query('SELECT status FROM resolution_jobs')).rows[0].status,stockReview?'waiting':'complete');
 if(stockReview){
  // Reproduce waitingResolutionWorker detecting a stock failure after commit.
  await db.query("UPDATE resolution_jobs SET status='review',error='Stock insuffisant',stage='Erplain à compléter'");
  await db.query("UPDATE erp_live_jobs SET status='review',error='Stock insuffisant'");
  const previewNext=async()=>substitution(db,api,(await db.query("SELECT * FROM orders WHERE id='o'")).rows[0],{id:'o',requestId:randomUUID(),sku:'C',replacementSku:'D',replaceQuantity:10,replacementQuantity:20,scope:'order'});
  const saved=structuredClone(bc);
  bc.line_items.find(l=>l.variant.sku==='B').quantity=19;
  await assert.rejects(previewNext(),/rapproché/);bc=saved;
  await db.query("UPDATE lines SET target_quantity=19 WHERE target_sku='B'");
  await assert.rejects(previewNext(),/Synchronisation locale/);
  await db.query("UPDATE lines SET target_quantity=20 WHERE target_sku='B'");
  const job=(await db.query('SELECT id,payload FROM resolution_jobs')).rows[0];
  const uncertain=structuredClone(job.payload);uncertain.substitutionAttempt.phase='mutation_started';
  await db.query('UPDATE resolution_jobs SET payload=$1 WHERE id=$2',[JSON.stringify(uncertain),job.id]);
  await assert.rejects(previewNext(),/remplacement interrompu/);
  await db.query('UPDATE resolution_jobs SET payload=$1 WHERE id=$2',[JSON.stringify(job.payload),job.id]);
  await previewNext();assert.equal(writes,1);
  assert.equal((await db.query('SELECT status,error FROM resolution_jobs')).rows[0].error,'Stock insuffisant');
 }
 const last=await replace('C','D',10,false,20);assert.equal(last.importDeferred,false);assert.equal(writes,2);
 assert.equal(bc.total,30);assert.equal(bc.line_items.reduce((n,l)=>n+Number(l.price)*Number(l.quantity),0),30);
 assert.equal((await db.query("SELECT status FROM erp_live_jobs WHERE order_id='o'")).rows[0].status,'pending');
 assert.equal((await db.query("SELECT resolution_pending_resume FROM orders WHERE id='o'")).rows[0].resolution_pending_resume,false);
 const actual=(await db.query('SELECT target_sku,target_quantity FROM lines ORDER BY target_sku')).rows;assert.deepEqual(actual.map(l=>[l.target_sku,Number(l.target_quantity)]),[['B',20],['D',20]]);
 assert.equal((await db.query('SELECT * FROM product_equivalences WHERE active=true')).rows.length,1);
 assert.equal((await db.query('SELECT * FROM carrier_jobs')).rows.length,0);assert.equal(bc.shipping_orders.data.length,0);
 const state=(await db.query("SELECT erp_live FROM orders WHERE id='o'")).rows[0].erp_live;
 if(preserveBcAmounts){
  const proof=preservedImportAmounts({erp_live:state});
  assert.equal(proof.total,30);assert.equal(proof.requestId,state.equivalentAttemptId);
  assert.equal(verifyImportBcAmounts(bc,proof).total,30);
 }
 assert.deepEqual(state.documentSource.lines.map(l=>[l.sku,l.quantity]).sort(),[['B',20],['D',20]]);
 const orderRows=[{id:'o',channel:'shopify'}];await attachSkuSubstitutions(db,orderRows);
 const ui=vm.createContext({});vm.runInContext(await readFile(new URL('../public/diagnostics.js',import.meta.url),'utf8'),ui);
 assert.equal(ui.skuLineText(orderRows[0],{sku:'B',quantity:20}),'A (20) → B (20)');
 assert.equal(ui.skuLineText(orderRows[0],{sku:'D',quantity:20}),'C (10) → D (20)');
 const logisticLines=(await db.query("SELECT * FROM lines WHERE order_id='o'")).rows;
 for(const l of logisticLines)assert.deepEqual(currentMappingLine({...l,mapped_sku:'WRONG',source_qty:1,target_qty:1000},'shopify'),{sku:l.target_sku,quantity:Number(l.target_quantity)});
 }finally{await pg.close();}
});
