import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
import {orderWeightProof,currentOrderWeightReason,reconcileGenericOrderWeights} from '../src/order-weight-recovery.mjs';
import {businessWeight} from '../src/weight-business-policy.mjs';
import {selectedProductWeights} from '../src/selected-product-weights.mjs';
import {prepareLabel} from '../src/workflow.mjs';
const old=new Date(Date.now()-3600000).toISOString(),fresh=new Date(Date.now()-1000).toISOString();
const binding=(sku='A',id='12',amount=5,unit='g')=>({sku,live_variant_id:id,verified_at:fresh,product:{id,sku,active:true,product:{active:true},weight_amount:amount,weight_unit:unit}});
test('order generic proof requires all lines, quantity, selected variant, freshness and real weight',()=>{
 const ls=[{sku:'A',quantity:2,source_payload:{erplainSourceVariantId:'12'}},{sku:'B',quantity:3}],bs=[binding(),binding('B','13',0.1)];
 assert.equal(orderWeightProof(ls,bs,old),0.0103);
 for(const [lines,bindings,date]of [[ls,bs.slice(0,1),old],[[{...ls[0],quantity:0}],bs,old],[[{...ls[0],source_payload:{erplainSourceVariantId:'99'}}],bs,old],[ls,bs,'bad'],[ls,bs,new Date().toISOString()],[ls,[{...bs[0],verified_at:'2000-01-01'},bs[1]],old]])assert.equal(orderWeightProof(lines,bindings,date),null);
 assert.equal(currentOrderWeightReason([{sku:'M',quantity:1}],[],[{sku:'M',message:'M : SKU Erplain introuvable',checked_at:fresh}],old),'M : SKU Erplain introuvable');
 assert.equal(currentOrderWeightReason([{sku:'M',quantity:1},{sku:'A',quantity:1}],[],[{sku:'M',message:'M : SKU Erplain introuvable',checked_at:fresh}],old),'Poids produit Erplain manquant');
});
test('actual SQL generic reconciliation preserves business states, other errors, newer and busy rows; repeat safe',async()=>{
 const db=new PGlite();try{await db.exec(`CREATE TABLE orders(id text primary key,channel text default 'amazon',archived boolean default false,issue text,updated_at timestamptz,label_status text default 'blocked');CREATE TABLE lines(order_id text,target_sku text,source_sku text,target_quantity numeric,quantity numeric,source_payload jsonb);CREATE TABLE mappings(channel text,source_sku text,target_sku text,source_qty numeric,target_qty numeric);CREATE TABLE erplain_product_bindings(sku text,live_variant_id text,product jsonb,verified_at timestamptz);CREATE TABLE catalog_results(sku text,message text,checked_at timestamptz);CREATE TABLE erp_live_jobs(order_id text,status text,error text,updated_at timestamptz);CREATE TABLE carrier_jobs(order_id text,status text);CREATE TABLE resolution_jobs(id text,order_id text,status text,error text,stage text,updated_at timestamptz,created_at timestamptz);`);
 const b=binding();await db.query('INSERT INTO erplain_product_bindings VALUES($1,$2,$3,$4)',[b.sku,b.live_variant_id,JSON.stringify(b.product),fresh]);
 for(const [id,at,status,physical]of [['old',old,'review','12'],['new',new Date().toISOString(),'review','12'],['busy',old,'processing','12'],['different',old,'review','99']]){
  await db.query('INSERT INTO orders(id,issue,updated_at) VALUES($1,$2,$3)',[id,'Poids produit Erplain manquant',at]);await db.query('INSERT INTO lines VALUES($1,$2,$2,1,1,$3)',[id,'A',JSON.stringify({erplainSourceVariantId:physical})]);await db.query('INSERT INTO erp_live_jobs VALUES($1,$2,$3,$4)',[id,status,'Poids produit Erplain manquant',at]);await db.query('INSERT INTO resolution_jobs VALUES($1,$1,$2,$3,null,$4,$4)',[id,'review','Poids produit Erplain manquant',at]);
 }
 await reconcileGenericOrderWeights(db);
 assert.equal((await db.query("SELECT issue FROM orders WHERE id='old'")).rows[0].issue,null);
 assert.equal((await db.query("SELECT error FROM erp_live_jobs WHERE order_id='old'")).rows[0].error,null);
 assert.equal((await db.query("SELECT error FROM resolution_jobs WHERE id='old'")).rows[0].error,null);
 for(const id of ['new','busy','different'])assert.equal((await db.query('SELECT issue FROM orders WHERE id=$1',[id])).rows[0].issue,'Poids produit Erplain manquant');
 assert.ok((await db.query('SELECT label_status FROM orders')).rows.every(o=>o.label_status==='blocked'));assert.ok((await db.query('SELECT status FROM resolution_jobs')).rows.every(o=>o.status==='review'));
 const before=(await db.query('SELECT * FROM orders ORDER BY id')).rows;await reconcileGenericOrderWeights(db);assert.deepEqual((await db.query('SELECT * FROM orders ORDER BY id')).rows,before);
 }finally{await db.close();}
});
test('catalogue, parcel and weight failures have separate filter categories',()=>{
 const c=vm.createContext({});vm.runInContext(fs.readFileSync(new URL('../public/compact-problems.js',import.meta.url),'utf8'),c);
 assert.equal(c.compactProblem('Poids ou nombre de colis absent').type,'parcel-preparation');assert.equal(c.compactProblem('En attente de synchronisation Erplain : A').type,'catalog-sync');assert.equal(c.compactProblem('A : Poids non renseigné dans Erplain').type,'weight');assert.equal(c.compactProblem('Stock insuffisant').type,'stock');
});
test('historical and future conversion matrix keeps positive weights and default 5g across quantities',()=>{
 let checked=0;
 for(const amount of [null,undefined,'',' ',0.1,1,5,100])for(const unit of [null,'','g','kg',' KG ','oz','inconnue'])for(const quantity of [1,2,22,200]){
  const v={id:12,sku:'A',active:true,product:{active:true},weight_amount:amount,weight_unit:unit},expected=businessWeight(amount,unit).weightKg*quantity;
  const plan=selectedProductWeights([{id:'l',target_sku:'A',target_quantity:quantity}],{A:v},[{variant:{id:12},quantity}]);assert.equal(plan.missing.length,0);assert.equal(plan.weightKg,Math.ceil(expected*1000)/1000);checked++;
 }
 assert.equal(checked,224);
});
test('real preparation never loses a positive sub-gram weight before route choice',async()=>{
 const writes=[];const db={query:async(sql,args)=>{if(sql.startsWith('SELECT l.'))return {rows:[{id:'l',target_sku:'A',target_quantity:1,weight_kg:0.0001}]};if(sql.startsWith('SELECT value'))return {rows:[]};writes.push({sql,args});return {rows:[]};}};
 await prepareLabel(db,{id:'fake',channel:'amazon',reference:'TEST',address:{name:'test',street:'test',postal:'75001',city:'Paris',country:'FR'}});
 const saved=writes.find(w=>w.sql.startsWith('UPDATE orders SET label_status='));assert.equal(saved.args[1],0.001);
});

test('mapped alias and previously cached zero reconcile immediately through actual helper and SQL',async()=>{
 const {refreshWeightUnitDiagnostics}=await import('../src/weight-unit-diagnostics.mjs');const db=new PGlite();
 try{await db.exec(`CREATE TABLE orders(id text primary key,channel text,archived boolean default false,issue text,erp_live jsonb default '{}',updated_at timestamptz default now()-interval '1 hour');CREATE TABLE lines(order_id text,target_sku text,source_sku text,source_payload jsonb);CREATE TABLE mappings(channel text,source_sku text,target_sku text);CREATE TABLE erplain_product_bindings(sku text primary key,live_variant_id text,product jsonb,verified_at timestamptz default now());CREATE TABLE product_weight_overrides(sku text primary key,source_variant_id text,live_variant_id text,weight_kg numeric,verified_at timestamptz default now());CREATE TABLE products(sku text primary key,weight_kg numeric,origin text,updated_at timestamptz default now());CREATE TABLE catalog_results(sku text primary key,message text,checked_at timestamptz default now());CREATE TABLE erp_live_jobs(order_id text,status text,error text,updated_at timestamptz default now()-interval '1 hour');CREATE TABLE carrier_jobs(order_id text,status text,error text);CREATE TABLE resolution_jobs(id text,order_id text,status text,action text,stage text,payload jsonb,error text,created_at timestamptz,updated_at timestamptz);CREATE TABLE audit(user_email text,action text,detail text);`);
 await db.query("INSERT INTO orders(id,channel) VALUES('o','amazon')");await db.query("INSERT INTO mappings VALUES('amazon','A.','A')");await db.query('INSERT INTO lines VALUES($1,null,$2,$3)',['o','A.',JSON.stringify({erplainSourceVariantId:'12',erplainCorrectedWeightKg:0})]);
 await db.query("INSERT INTO erp_live_jobs VALUES('o','review',$1,now()-interval '1 hour')",['A : Poids non renseigné dans Erplain']);
 await refreshWeightUnitDiagnostics(db,{id:'o'},'A',binding().product);
 const l=(await db.query('SELECT * FROM lines')).rows[0],j=(await db.query('SELECT * FROM erp_live_jobs')).rows[0];
 assert.equal(Number(l.source_payload.erplainCorrectedWeightKg),0.005);assert.equal(l.target_sku,null);assert.equal(l.source_sku,'A.');assert.equal(j.error,null);assert.equal(j.status,'review');
 const second=await refreshWeightUnitDiagnostics(db,{id:'o'},'A',binding().product);assert.equal(second.diagnosticOnly,true);
 }finally{await db.close();}
});
