import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {substitution} from '../src/stock-substitution.mjs';
import {initializeEquivalences} from '../src/equivalence-catalog.mjs';

test('moteur réel : deux remplacements, aucune reprise avant le dernier, puis préparation remise en file',async()=>{
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
 CREATE TABLE audit(user_email text,action text,detail jsonb);
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
  const preview=await substitution(db,api,o,b);
  Object.assign(b,{confirmEquivalent:true,previewFingerprint:preview.previewFingerprint});
  await db.query("INSERT INTO resolution_jobs(id,order_id,request_id,action,payload,status) VALUES($1,'o',$2,'replace-equivalent',$3,'running')",[b.requestId,b.requestId,JSON.stringify(b)]);
  return substitution(db,api,o,b,{apply:true,deferResume});
 }
 const first=await replace('A','B',20,true);assert.equal(first.importDeferred,true);assert.equal(writes,1);
 assert.equal((await db.query("SELECT status FROM erp_live_jobs WHERE order_id='o'")).rows[0].status,'review');
 assert.equal((await db.query("SELECT resolution_pending_resume FROM orders WHERE id='o'")).rows[0].resolution_pending_resume,true);
 assert.equal((await db.query('SELECT status FROM resolution_jobs')).rows[0].status,'complete');
 const last=await replace('C','D',10,false,20);assert.equal(last.importDeferred,false);assert.equal(writes,2);
 assert.equal((await db.query("SELECT status FROM erp_live_jobs WHERE order_id='o'")).rows[0].status,'pending');
 assert.equal((await db.query("SELECT resolution_pending_resume FROM orders WHERE id='o'")).rows[0].resolution_pending_resume,false);
 const actual=(await db.query('SELECT target_sku,target_quantity FROM lines ORDER BY target_sku')).rows;assert.deepEqual(actual.map(l=>[l.target_sku,Number(l.target_quantity)]),[['B',20],['D',20]]);
 assert.equal((await db.query('SELECT * FROM product_equivalences WHERE active=true')).rows.length,1);
 assert.equal((await db.query('SELECT * FROM carrier_jobs')).rows.length,0);assert.equal(bc.shipping_orders.data.length,0);
 }finally{await pg.close();}
});
